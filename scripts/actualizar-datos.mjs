/**
 * Actualizador diario de las series de datos de la calculadora.
 *
 *   - Tasa activa BNA (cartera general, TNA vencida a 30 días): web del BNA.
 *   - Tasa BTF (descuento de documentos): PDF de tasas activas de Banca Empresas.
 *       Macías  = tasa efectiva del tramo 181–365 días.
 *       Cordero = TNA vencida del tramo 121–180 días.
 *   - RIPTE: API de series de tiempo de datos.gob.ar.
 *   - Pisos SRT: no se leen automáticamente; se abre un issue antes de su vencimiento.
 *
 * Cada fuente se procesa por separado: si una falla, las demás se guardan igual.
 * Los errores se informan en el resumen del workflow y en un issue del repositorio.
 *
 * Uso: node scripts/actualizar-datos.mjs            (requiere red; en GitHub Actions)
 *      FECHA_HOY=2026-09-28 node scripts/...        (fecha fija para pruebas)
 */
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FUENTES = {
  bna: 'https://www.bna.com.ar/home/informacionalusuariofinanciero',
  btf: 'https://www.btf.com.ar/institucional/normativa-y-tasas/',
  ripte: 'https://apis.datos.gob.ar/series/api/series/?ids=158.1_REPTE_0_0_5&format=csv&start_date=2015-01-01&limit=1000',
};

/* ------------------------------------------------------------------ */
/* Utilidades puras (con tests en test/actualizador.test.js)           */
/* ------------------------------------------------------------------ */

const ENTIDADES = { nbsp: ' ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', amp: '&', ordm: 'º', deg: '°' };

/** HTML → texto plano con espacios normalizados. */
export function textoPlano(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCharCode(Number(e.slice(1))) : ENTIDADES[e] ?? m))
    .replace(/\s+/g, ' ')
    .trim();
}

/** "26,40" | "26.40" → 0.264 */
export function porcentaje(s) {
  const v = Number(String(s).replace(/\./g, (m, i, t) => (t.includes(',') ? '' : '.')).replace(',', '.'));
  return Math.round(v * 1e4) / 1e6;
}

const fechaISO = (d, m, y) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export const teaDesdeTna = (tna) => (1 + tna * 30 / 365) ** (365 / 30) - 1;

/**
 * Busca en la web del BNA la tasa activa de cartera general. Formato publicado:
 *   "Tasa Activa Cartera General Diversas vigente desde el 29/9/2026
 *    Tasa Efectiva Mensual Vencida = T.E.M. (30 días) = 2,219%
 *    Tasa Nominal Anual Vencida con capitalización cada 30 días = T.N.A. (30 días) = 27,00%
 *    Tasa Efectiva Anual Vencida = T.E.A. = 30,61%"
 * Exige que TEM, TNA y TEA sean consistentes entre sí.
 * @returns {{desde:string, tna:number, tea:number}}
 */
export function parsearBNA(html) {
  const texto = textoPlano(html);
  const i = texto.search(/tasa activa cartera general/i);
  if (i < 0) throw new Error('BNA: no se encontró "Tasa Activa Cartera General".');
  const bloque = texto.slice(i, i + 700);
  const f = bloque.match(/vigente\s+desde\s+el\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  const valor = (sigla) => {
    const m = bloque.match(new RegExp(`${sigla}\\s*(?:\\([^)]*\\))?\\s*=\\s*(\\d{1,3}(?:[.,]\\d{1,4})?)\\s*%`));
    return m ? porcentaje(m[1]) : null;
  };
  const tna = valor('T\\.N\\.A\\.');
  const tea = valor('T\\.E\\.A\\.');
  const tem = valor('T\\.E\\.M\\.');
  if (!f || tna == null || tea == null) {
    throw new Error(`BNA: faltan datos en el bloque (fecha ${f ? 'ok' : 'no'}, T.N.A. ${tna ?? 'no'}, T.E.A. ${tea ?? 'no'}).`);
  }
  if (Math.abs(teaDesdeTna(tna) - tea) > 0.005) throw new Error(`BNA: T.N.A. ${tna} y T.E.A. ${tea} inconsistentes.`);
  if (tem != null && Math.abs(tna * 30 / 365 - tem) > 0.0005) throw new Error(`BNA: T.N.A. ${tna} y T.E.M. ${tem} inconsistentes.`);
  return { desde: fechaISO(f[1], f[2], f[3]), tna, tea };
}

/** Link al PDF de tasas activas de Banca Empresas en la página del BTF. */
export function buscarPdfBTF(html, base = FUENTES.btf) {
  const hrefs = [...html.matchAll(/href=["']([^"']*tasas-activas-comercial[^"']*\.pdf)["']/gi)].map((x) => x[1]);
  if (!hrefs.length) throw new Error('BTF: no se encontró el link al PDF de tasas activas comerciales.');
  return new URL(hrefs[0], base).href;
}

/**
 * Texto del PDF del BTF (pdftotext -layout) → tasas.
 *
 * El BTF ya no publica una sección llamada "descuento de documentos": el producto equivalente
 * es "Negociación de valores – Cheques físicos" (T.N.A.A., T.N.A.V., T.E.A.V., plazos 1–180).
 * Se usa esa sección, o la de "Descuento de documentos" si vuelve a aparecer.
 *   Macías  = T.E.A.V. de la sección (constante en todos los plazos; 46,80% al 21/09/2026).
 *   Cordero = T.N.A.V. del plazo 121–180 (42,32% al 21/09/2026).
 * Ambos valores coinciden con la calculadora del Colegio de Abogados de Ushuaia.
 * @returns {{desde:string, macias:number, cordero:number, seccion:string}}
 */
export function parsearBTF(texto) {
  const f = texto.match(/vigente\s+a\s+partir\s+del?\s*[\s\S]{0,400}?(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (!f) throw new Error('BTF: no se encontró la fecha "Vigente a partir del".');

  const lineas = texto.split('\n');
  const titulos = [/descuento\s+de\s+documentos/i, /cheques\s+f[íi]sicos/i];
  let inicio = -1;
  let seccion = '';
  for (const t of titulos) {
    inicio = lineas.findIndex((l) => t.test(l));
    if (inicio >= 0) { seccion = lineas[inicio].trim(); break; }
  }
  if (inicio < 0) throw new Error('BTF: no se encontró la sección "Descuento de documentos" ni "Cheques físicos".');

  const fila = /(?:^|\s)(\d{1,3})\s+(\d{1,3})\s+-\s+(\d{1,3},\d{1,4})\s*%\s+(\d{1,3},\d{1,4})\s*%\s+(\d{1,3},\d{1,4})\s*%/;
  const esTitulo = (l) => /^\s*[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .,/()-]{4,}\s*$/.test(l) && !/\d/.test(l);
  const filas = [];
  for (let k = inicio + 1; k < lineas.length; k++) {
    if (esTitulo(lineas[k])) break;
    const m = lineas[k].match(fila);
    if (m) filas.push({ desde: Number(m[1]), hasta: Number(m[2]), tnaa: porcentaje(m[3]), tnav: porcentaje(m[4]), tea: porcentaje(m[5]) });
  }
  if (filas.length < 3) throw new Error(`BTF: la sección "${seccion}" tiene ${filas.length} filas de tasas.`);
  const teas = new Set(filas.map((x) => x.tea));
  if (teas.size !== 1) throw new Error(`BTF: la T.E.A.V. no es única en "${seccion}" (${[...teas].join(', ')}).`);
  const macias = filas[0].tea;
  const f180 = filas.find((x) => x.desde === 121 && x.hasta === 180);
  if (!f180) throw new Error(`BTF: no hay fila 121–180 en "${seccion}".`);
  const cordero = f180.tnav;
  const teaImplicita = (1 + cordero * 180 / 365) ** (365 / 180) - 1;
  if (Math.abs(teaImplicita - macias) > 0.005) throw new Error(`BTF: la T.N.A.V. 121–180 (${cordero}) no reproduce la T.E.A.V. (${macias}).`);
  return { desde: fechaISO(f[1], f[2], f[3]), macias, cordero, seccion };
}

/** CSV de la API de series → { 'YYYY-MM': valor } */
export function parsearRipteCSV(csv) {
  const valores = {};
  for (const linea of csv.trim().split(/\r?\n/).slice(1)) {
    const [f, v] = linea.split(',');
    const n = Number(v);
    if (/^\d{4}-\d{2}-01$/.test(f) && n > 0) valores[f.slice(0, 7)] = n;
  }
  if (Object.keys(valores).length < 12) throw new Error('RIPTE: el CSV tiene menos de 12 meses.');
  return valores;
}

/**
 * Agrega una vigencia si cambió el valor. Ignora fechas anteriores a la última; si la fecha
 * coincide con la última y el valor difiere, la corrige.
 * @returns {{lista:object[], cambio:string|null}}
 */
export function aplicarVigencia(lista, desde, campo, valor) {
  const ultima = lista.at(-1);
  if (ultima && desde < ultima.desde) return { lista, cambio: null };
  if (ultima && Math.abs(ultima[campo] - valor) < 1e-9) return { lista, cambio: null };
  const nueva = { desde, [campo]: valor };
  if (ultima && ultima.desde === desde) return { lista: [...lista.slice(0, -1), { ...ultima, ...nueva }], cambio: `corregida ${desde}` };
  return { lista: [...lista, nueva], cambio: `nueva vigencia ${desde}` };
}

/** Rango razonable para una tasa anual. */
export function validarTasa(nombre, x) {
  if (!(x > 0.01 && x < 5)) throw new Error(`${nombre}: tasa fuera de rango (${x}).`);
}

/* ------------------------------------------------------------------ */
/* Ejecución                                                           */
/* ------------------------------------------------------------------ */

const DATA = new URL('../data/', import.meta.url);
const leer = (f) => JSON.parse(readFileSync(new URL(f, DATA), 'utf8'));
const guardar = (f, obj) => writeFileSync(new URL(f, DATA), `${JSON.stringify(obj, null, 1)}\n`);
const hoyART = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const sumarDiasISO = (f, n) => new Date(Date.parse(`${f}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

async function traer(url, tipo = 'text') {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'calculadora-art/actualizador (+https://github.com/JeremiasMas/calculadora-art)' },
    signal: AbortSignal.timeout(45_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
  return tipo === 'buffer' ? Buffer.from(await r.arrayBuffer()) : r.text();
}

async function actualizarBNA(hoy, log) {
  const html = await traer(FUENTES.bna);
  let dato;
  try {
    dato = parsearBNA(html);
  } catch (e) {
    e.muestra = textoPlano(html).match(/.{0,300}cartera general.{0,700}/i)?.[0] ?? textoPlano(html).slice(0, 1500);
    throw e;
  }
  validarTasa('BNA', dato.tna);
  if (dato.desde > sumarDiasISO(hoy, 7)) throw new Error(`BNA: fecha de vigencia demasiado lejana (${dato.desde}).`);
  const serie = leer('tasa_activa_bna.json');
  const { lista, cambio } = aplicarVigencia(serie.vigencias ?? [], dato.desde, 'tna', dato.tna);
  serie.vigencias = lista.map((v) => ({ fuente: 'bna.com.ar', ...v }));
  serie.actualizado = dato.desde > hoy ? dato.desde : hoy;
  guardar('tasa_activa_bna.json', serie);
  log(`BNA: TNA ${(dato.tna * 100).toFixed(2)}% (TEA ${(dato.tea * 100).toFixed(2)}%) vigente desde ${dato.desde}${cambio ? ` — ${cambio}` : ' — sin cambios'}.`);
}

async function actualizarBTF(hoy, log) {
  const html = await traer(FUENTES.btf);
  const url = buscarPdfBTF(html);
  const dir = mkdtempSync(join(tmpdir(), 'btf-'));
  const pdf = join(dir, 'tasas.pdf');
  writeFileSync(pdf, await traer(url, 'buffer'));
  const texto = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' });
  let dato;
  try {
    dato = parsearBTF(texto);
  } catch (e) {
    const compacto = texto.split('\n').map((l) => l.trim().replace(/\s{2,}/g, ' | ')).filter(Boolean).join('\n');
    e.muestra = `${url}\n\n${compacto}`;
    throw e;
  }
  validarTasa('BTF Macías', dato.macias);
  validarTasa('BTF Cordero', dato.cordero);
  if (dato.desde > sumarDiasISO(hoy, 7)) throw new Error(`BTF: fecha de vigencia demasiado lejana (${dato.desde}).`);
  const serie = leer('tasa_btf.json');
  const m = aplicarVigencia(serie.macias, dato.desde, 'tasa', dato.macias);
  const c = aplicarVigencia(serie.cordero, dato.desde, 'tasa', dato.cordero);
  serie.macias = m.lista;
  serie.cordero = c.lista;
  serie.actualizado = dato.desde > hoy ? dato.desde : hoy;
  guardar('tasa_btf.json', serie);
  log(`BTF (${url.split('/').pop()}, sección "${dato.seccion}"): Macías ${(dato.macias * 100).toFixed(2)}%, Cordero ${(dato.cordero * 100).toFixed(2)}%, vigente desde ${dato.desde}${m.cambio || c.cambio ? ` — ${[m.cambio && `Macías ${m.cambio}`, c.cambio && `Cordero ${c.cambio}`].filter(Boolean).join('; ')}` : ' — sin cambios'}.`);
}

async function actualizarRIPTE(hoy, log) {
  const nuevos = parsearRipteCSV(await traer(FUENTES.ripte));
  const serie = leer('ripte.json');
  const agregados = [];
  const corregidos = [];
  for (const [mes, v] of Object.entries(nuevos)) {
    const previo = serie.valores[mes];
    if (previo === undefined) agregados.push(mes);
    else if (Math.abs(previo - v) > 0.005) corregidos.push(mes);
  }
  const union = { ...serie.valores, ...nuevos };
  const meses = Object.keys(union).sort();
  for (let i = 1; i < meses.length; i++) {
    const salto = union[meses[i]] / union[meses[i - 1]] - 1;
    if (salto < -0.2 || salto > 0.4) throw new Error(`RIPTE: variación mensual anómala en ${meses[i]} (${(salto * 100).toFixed(1)}%).`);
  }
  serie.valores = Object.fromEntries(meses.map((k) => [k, union[k]]));
  serie.actualizado = hoy;
  guardar('ripte.json', serie);
  log(`RIPTE: último mes ${meses.at(-1)}${agregados.length ? `; nuevos: ${agregados.join(', ')}` : '; sin meses nuevos'}${corregidos.length ? `; revisados: ${corregidos.join(', ')}` : ''}.`);
}

function revisarPisos(hoy, log) {
  const vig = leer('pisos.json').vigencias.at(-1);
  const dias = Math.round((new Date(vig.hasta) - new Date(hoy)) / 864e5);
  log(`Pisos SRT: vigencia cargada hasta ${vig.hasta} (${dias} días).`);
  return dias <= 30 ? `Los pisos SRT cargados vencen el ${vig.hasta}. Hay que agregar la resolución del próximo semestre en data/pisos.json.` : null;
}

async function issue(titulo, cuerpo) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return;
  const api = `https://api.github.com/repos/${repo}/issues`;
  const h = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
  const abiertos = await (await fetch(`${api}?state=open&per_page=100`, { headers: h })).json();
  const previo = Array.isArray(abiertos) ? abiertos.find((i) => i.title === titulo) : null;
  if (previo) {
    await fetch(`${api}/${previo.number}/comments`, { method: 'POST', headers: h, body: JSON.stringify({ body: cuerpo }) });
  } else {
    await fetch(api, { method: 'POST', headers: h, body: JSON.stringify({ title: titulo, body: cuerpo }) });
  }
}

async function main() {
  const hoy = process.env.FECHA_HOY ?? hoyART();
  const lineas = [];
  const errores = [];
  const log = (s) => { lineas.push(`- ${s}`); console.log(s); };

  for (const [nombre, fn] of [['BNA', actualizarBNA], ['BTF', actualizarBTF], ['RIPTE', actualizarRIPTE]]) {
    try {
      await fn(hoy, log);
    } catch (e) {
      log(`**Error ${nombre}**: ${e.message}`);
      errores.push({ nombre, mensaje: e.message, muestra: e.muestra });
    }
  }
  const avisoPisos = revisarPisos(hoy, log);

  const resumen = `## Actualización de datos ${hoy}\n\n${lineas.join('\n')}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, resumen);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `errores=${errores.length}\n`);

  if (errores.length) {
    const cuerpo = [
      `Fecha: ${hoy}`,
      ...errores.map((e) => `### ${e.nombre}\n\n${e.mensaje}${e.muestra ? `\n\n<details><summary>Texto leído</summary>\n\n\`\`\`\n${e.muestra.slice(0, 30000)}\n\`\`\`\n</details>` : ''}`),
      'Mientras no se resuelva, la calculadora usa la última tasa cargada y marca como estimados los períodos posteriores.',
    ].join('\n\n');
    await issue('Actualizador de datos: error al leer una fuente', cuerpo);
  }
  if (avisoPisos) await issue('Actualizar pisos SRT', avisoPisos);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
