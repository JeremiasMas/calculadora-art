import { liquidar, sumarMeses } from './engine.js';
import { armarLiquidacion } from './liquidacion.js';

/* ------------------------------------------------------------------ */
/* Utilidades de formato y lectura                                     */
/* ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const form = $('#form');
const res = $('#resultados');
let DATOS = null;

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const mesCorto = (k) => { const [y, m] = k.split('-'); return `${MESES[Number(m) - 1]} ${y}`; };
const fecha = (s) => { const [y, m, d] = s.split('-'); return `${d}/${m}/${y}`; };
const pesos = (x) => (x == null ? '—' : x.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const num = (x, d = 2) => x.toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function hoyISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/**
 * Acepta "1.234.567,89", "1234567.89", "48.000" (miles, en montos) y "5,8".
 * @param {string} s
 * @param {boolean} dinero  Un solo punto seguido de 3 dígitos se lee como separador de miles.
 */
export function parseNumero(s, dinero = false) {
  let t = String(s ?? '').trim().replace(/[\s$%]/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if ((t.match(/\./g) || []).length > 1 || (dinero && /^\d{1,3}(\.\d{3})+$/.test(t))) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

const campo = (nombre) => form.elements[nombre];
const valor = (nombre) => (campo(nombre)?.value ?? '').trim();
const numero = (nombre, dinero = false) => parseNumero(valor(nombre), dinero);

/* ------------------------------------------------------------------ */
/* Datos                                                               */
/* ------------------------------------------------------------------ */

async function cargarDatos() {
  const archivos = ['ripte', 'pisos', 'tasa_activa_bna', 'tasa_btf'];
  const [ripte, pisos, tasaActivaBNA, tasaBTF] = await Promise.all(
    archivos.map((a) => fetch(`./data/${a}.json`).then((r) => {
      if (!r.ok) throw new Error(a);
      return r.json();
    })),
  );
  DATOS = { ripte, pisos, tasaActivaBNA, tasaBTF };

  const ultimoRipte = Object.keys(ripte.valores).sort().at(-1);
  const pisosHasta = pisos.vigencias.at(-1).hasta;
  const bna = tasaActivaBNA.vigencias?.at(-1);
  const macias = tasaBTF.macias.at(-1);
  const al = [tasaActivaBNA.actualizado, tasaBTF.actualizado].filter(Boolean).sort()[0];
  $('#frescura').innerHTML = [
    `RIPTE hasta <b>${mesCorto(ultimoRipte)}</b>`,
    `Pisos SRT hasta <b>${fecha(pisosHasta)}</b>`,
    bna ? `Tasa activa BNA <b>${num(bna.tna * 100)}%</b> desde ${fecha(bna.desde)}` : '',
    `Tasa BTF (Macías) <b>${num(macias.tasa * 100)}%</b> desde ${fecha(macias.desde)}`,
    al ? `Tasas verificadas al <b>${fecha(al)}</b>` : '',
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join('');
}

/* ------------------------------------------------------------------ */
/* Formulario dinámico                                                 */
/* ------------------------------------------------------------------ */

const sueldosGuardados = new Map();

function mesesPrevios(pmi) {
  const mesPMI = pmi.slice(0, 7);
  return Array.from({ length: 12 }, (_, i) => sumarMeses(mesPMI, i - 12));
}

function dibujarSueldos() {
  const cont = $('#sueldos');
  cont.querySelectorAll('input').forEach((i) => sueldosGuardados.set(i.dataset.mes, i.value));
  const pmi = valor('pmi');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pmi)) {
    cont.innerHTML = '';
    $('#btn-repetir').hidden = true;
    $('#ayuda-sueldos').textContent = 'Cargá la PMI para ver los doce meses anteriores. Usá la remuneración bruta mensual informada por ARCA.';
    return;
  }
  const meses = mesesPrevios(pmi);
  cont.innerHTML = meses.map((m) => `
    <label class="campo"><span class="t">${mesCorto(m)}</span>
      <input data-mes="${m}" inputmode="decimal" placeholder="$" value="${esc(sueldosGuardados.get(m) ?? '')}">
    </label>`).join('');
  $('#btn-repetir').hidden = false;
  $('#ayuda-sueldos').textContent = `Remuneración bruta de ${mesCorto(meses[0])} a ${mesCorto(meses[11])}. Si trabajó menos de un año, dejá vacíos los meses sin relación laboral.`;
}

function agregarLesion(l = {}) {
  const fila = document.createElement('div');
  fila.className = 'lesion';
  fila.innerHTML = `
    <label class="campo"><span class="t">Lesión</span><input class="l-desc" placeholder="Descripción" value="${esc(l.descripcion ?? '')}"></label>
    <label class="campo"><span class="t">%</span><input class="l-pct" inputmode="decimal" value="${esc(l.porcentaje ?? '')}"></label>
    <label class="check"><input type="checkbox" class="l-habil" ${l.habil ? 'checked' : ''}>Miembro sup. hábil</label>
    <button type="button" class="quitar" aria-label="Quitar lesión">✕</button>`;
  fila.querySelector('.quitar').addEventListener('click', () => {
    fila.remove();
    if (!$('#lesiones').children.length) agregarLesion();
    programar();
  });
  $('#lesiones').append(fila);
}

function aplicarModo() {
  const baremo = form.elements.modo.value === 'baremo';
  $('#modo-directo').hidden = baremo;
  $('#modo-baremo').hidden = !baremo;
}

/* ------------------------------------------------------------------ */
/* Lectura del caso                                                    */
/* ------------------------------------------------------------------ */

function leerCaso() {
  const faltan = [];
  const caso = { opciones: {} };

  if (form.elements.modo.value === 'baremo') {
    const lesiones = [...document.querySelectorAll('#lesiones .lesion')]
      .map((f) => ({
        descripcion: f.querySelector('.l-desc').value,
        porcentaje: parseNumero(f.querySelector('.l-pct').value),
        miembroSuperiorHabil: f.querySelector('.l-habil').checked,
      }))
      .filter((l) => l.porcentaje > 0);
    if (!lesiones.length) faltan.push('al menos una lesión');
    caso.incapacidad = {
      lesiones,
      preexistencia: numero('preexistencia') ?? 0,
      factores: {
        actividad: (numero('fAct') ?? 0) / 100,
        recalificacion: (numero('fRec') ?? 0) / 100,
        edad: (numero('fEdad') ?? 0) / 100,
      },
    };
  } else {
    const inc = numero('incapacidad');
    if (!(inc > 0)) faltan.push('incapacidad');
    caso.incapacidad = inc;
  }
  caso.incapacidadPagada = numero('pagada') ?? 0;
  caso.inItinere = campo('itinere').checked;

  caso.fechaNacimiento = valor('nacimiento');
  caso.fechaPMI = valor('pmi');
  caso.fechaLiquidacion = valor('liquidacion');
  if (!caso.fechaNacimiento) faltan.push('fecha de nacimiento');
  if (!caso.fechaPMI) faltan.push('PMI');
  if (!caso.fechaLiquidacion) faltan.push('fecha de liquidación');

  caso.remuneraciones = [...document.querySelectorAll('#sueldos input')]
    .map((i) => ({ mes: i.dataset.mes, monto: parseNumero(i.value, true) }))
    .filter((r) => r.monto > 0);
  if (caso.fechaPMI && !caso.remuneraciones.length) faltan.push('remuneraciones');

  const moraDesde = valor('moraDesde');
  const moraHasta = valor('moraHasta');
  if (moraDesde && moraHasta) {
    caso.mora = { fechaMora: moraDesde, fechaPago: moraHasta, criterioTasa: valor('criterio') };
  }

  if ($('#bloque-hon').open) {
    const letrados = [];
    const hAct = numero('hAct');
    const hDem = numero('hDem');
    if (hAct > 0) letrados.push({ nombre: 'Letrado de la actora', parte: 'actora', porcentaje: hAct / 100, recargoApoderado: (numero('hActRec') ?? 0) / 100 });
    if (hDem > 0) letrados.push({ nombre: 'Letrado de la demandada', parte: 'demandada', porcentaje: hDem / 100, recargoApoderado: (numero('hDemRec') ?? 0) / 100 });
    const perito = numero('perito', true);
    const peritos = perito > 0 ? [{ nombre: 'Perito', monto: perito }] : [];
    if (letrados.length || peritos.length) {
      caso.honorarios = { letrados, peritos };
      const desde = valor('peritoDesde');
      const hasta = valor('peritoHasta');
      if (peritos.length && desde && hasta) caso.honorarios.intereses = { desde, hasta };
    }
  }

  const liqAct = numero('liqAct', true);
  const liqDem = numero('liqDem', true);
  if (liqAct > 0 || liqDem > 0) caso.liquidacionesPartes = { actora: liqAct, demandada: liqDem };

  return { caso, faltan };
}

/* ------------------------------------------------------------------ */
/* Resultado                                                           */
/* ------------------------------------------------------------------ */

const FRANJAS = {
  IPP_HASTA_50: 'IPP hasta 50% (art. 14.2.a)',
  IPP_50_66: 'IPP 50–66% (art. 14.2.b)',
  IPT: 'IPT (art. 15.2)',
};

const fila = (dt, dd, fuerte = false) => `<div class="${fuerte ? 'fuerte' : ''}"><dt>${dt}</dt><dd>${dd}</dd></div>`;
let ultimoTexto = '';
let ultimo = null;
let documento = null;

function renderVacio(faltan) {
  ultimo = null;
  res.innerHTML = `<h2>Resultado</h2><p class="vacio">Faltan: ${faltan.map(esc).join(', ')}.</p>`;
  $('#barra').hidden = true;
}

function renderError(mensaje) {
  ultimo = null;
  let m = mensaje;
  if (/Falta el RIPTE de/.test(m)) m += ' Todavía no está publicado o está fuera de la serie cargada.';
  res.innerHTML = `<h2>Resultado</h2><div class="aviso err">${esc(m)}</div>`;
  $('#barra').hidden = true;
}

function render(r, caso) {
  const p = r.prestacion;
  const i = r.incapacidad;
  const partes = [];

  partes.push(`<h2>Resultado</h2>
    <div class="total">
      <div class="etq">Total a la fecha de liquidación</div>
      <div class="monto">${pesos(p.total)}</div>
      <div class="sub">al ${fecha(caso.fechaLiquidacion)} · ${FRANJAS[p.tramo]}</div>
    </div>`);
  if (r.mora) {
    partes.push(`<div class="total">
      <div class="etq">Total al pago, con mora</div>
      <div class="monto">${pesos(r.mora.total)}</div>
      <div class="sub">al ${fecha(caso.mora.fechaPago)}</div>
    </div>`);
  }
  partes.push(`<div class="kpis">
    <div class="kpi"><div class="etq">Incapacidad</div><div class="v">${num(i.porcentaje)}%</div></div>
    <div class="kpi"><div class="etq">IBM a la PMI</div><div class="v">${pesos(r.ibm.ibm)}</div></div>
    <div class="kpi"><div class="etq">Edad</div><div class="v">${p.edad} años</div></div>
  </div>`);

  if (i.subtotal != null) {
    partes.push(`<div class="paso">A · Incapacidad (Baremo)</div><dl class="filas">
      ${fila('Subtotal físico', `${num(i.subtotal, 4)}%`)}
      ${fila('Ponderación', `${num(i.ponderacion.actividad + i.ponderacion.recalificacion + i.ponderacion.edad, 4)}%`)}
      ${fila('Incapacidad', `${num(i.porcentaje)}%`, true)}
    </dl>`);
  }

  partes.push(`<div class="paso">B · Ingreso base mensual</div><dl class="filas">
    ${fila('Período', `${mesCorto(r.ibm.periodo.desde)} – ${mesCorto(r.ibm.periodo.hasta)}`)}
    ${fila('Actualización RIPTE a', mesCorto(r.ibm.mesRefPMI))}
    ${fila(`Suma actualizada / ${r.ibm.divisor}`, pesos(r.ibm.ibm), true)}
  </dl>`);

  const formulaTxt = p.tramo === 'IPT' ? '53 × IBM × 65/edad' : '53 × IBM × % × 65/edad';
  partes.push(`<div class="paso">C · Prestación a la PMI</div><dl class="filas">
    ${fila(formulaTxt, pesos(p.formula))}
    ${fila(`Piso${p.normaPiso ? ` (${esc(p.normaPiso)})` : ''}`, p.piso == null ? 'sin dato' : pesos(p.piso))}
    ${fila(`Base (${p.aplicaPiso ? 'piso' : 'fórmula'})`, pesos(p.base))}
    ${p.compensacion11_4 > 0 ? fila('Compensación art. 11.4', pesos(p.compensacion11_4)) : ''}
    ${fila(caso.inItinere ? 'Adicional 20% (no aplica in itinere)' : `Adicional 20% art. 3 Ley 26.773${p.aplicaMinimoArt3 ? ' (mínimo)' : ''}`, pesos(p.adicional20))}
    ${fila('Capital a la PMI', pesos(p.capitalPMI), true)}
  </dl>`);

  partes.push(`<div class="paso">D · Actualización a la liquidación</div><dl class="filas">
    ${fila(`RIPTE ${mesCorto(p.ripte.mesPMI)} → ${mesCorto(p.ripte.mesLiquidacion)}`, `× ${num(p.ripte.coeficiente, 4)}`)}
    ${fila('Capital actualizado', pesos(p.capitalActualizado))}
    ${fila(`Interés puro 6% (${p.interesPuro.dias} días)`, pesos(p.interesPuro.monto))}
    ${fila('Total a la liquidación', pesos(p.total), true)}
  </dl>`);

  if (r.mora) {
    const criterio = caso.mora.criterioTasa === 'tea' ? 'TEA' : 'TNA';
    partes.push(`<div class="paso">Mora · tasa activa BNA (${criterio})</div><dl class="filas">
      ${r.mora.periodos.map((x) => fila(`${fecha(x.desde)} → ${fecha(x.hasta)}${x.capitaliza ? ' · capitaliza' : ''}`, pesos(x.interes))).join('')}
      ${fila('Total al pago', pesos(r.mora.total), true)}
    </dl>`);
  }

  if (r.honorarios) {
    const h = r.honorarios;
    partes.push(`<div class="paso">E · Honorarios</div><dl class="filas">
      ${h.letrados.map((l) => fila(`${esc(l.nombre)} (${num(l.alicuota * 100, 1)}%)`, pesos(l.monto))).join('')}
      ${h.peritos.map((x) => fila(esc(x.nombre), pesos(x.monto))).join('')}
      ${fila('Tope art. 730 (25%)', h.art730.excede ? `excede · prorrateo × ${num(h.art730.factorProrrateo, 4)}` : 'no excede')}
      ${h.art730.excede ? [...h.letrados, ...h.peritos].filter((x) => x.computa730).map((x) => fila(`${esc(x.nombre)} a cargo del condenado`, pesos(x.aCargoDelCondenado))).join('') : ''}
      ${r.interesesHonorarios ? r.interesesHonorarios.peritos.map((x) => fila(`Intereses perito (Macías, ${fecha(x.desde)} → ${fecha(x.hasta)})`, pesos(x.interes))).join('') : ''}
    </dl>`);
  }

  if (r.comparacion) {
    const nombres = { actora: 'Liquidación actora', demandada: 'Liquidación demandada' };
    partes.push(`<div class="paso">Comparación</div><dl class="filas">
      ${Object.entries(r.comparacion).map(([k, c]) => fila(`${nombres[k]} (${pesos(c.monto)})`, `${c.diferencia >= 0 ? '+' : ''}${num(c.variacion * 100, 1)}%`)).join('')}
    </dl>`);
  }

  if (r.advertencias.length) {
    partes.push(`<div class="aviso warn"><b>Advertencias</b><ul>${r.advertencias.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>`);
  }

  partes.push(`<div class="acciones-res">
    <button type="button" class="primario" id="btn-liq">Liquidación para el escrito</button>
    <button type="button" id="btn-copiar">Copiar resumen</button>
  </div>`);

  res.innerHTML = partes.join('');
  $('#btn-copiar').addEventListener('click', copiar);
  $('#btn-liq').addEventListener('click', abrirLiquidacion);
  ultimo = { r, caso };

  ultimoTexto = [
    'Liquidación LRT — metodología STJ Tierra del Fuego',
    `Incapacidad: ${num(i.porcentaje)}% · ${FRANJAS[p.tramo]}`,
    `PMI: ${fecha(caso.fechaPMI)} · Edad: ${p.edad} años · IBM: ${pesos(r.ibm.ibm)}`,
    `Capital a la PMI: ${pesos(p.capitalPMI)}`,
    `RIPTE ${mesCorto(p.ripte.mesPMI)} → ${mesCorto(p.ripte.mesLiquidacion)}: × ${num(p.ripte.coeficiente, 4)}`,
    `Interés puro 6% (${p.interesPuro.dias} días): ${pesos(p.interesPuro.monto)}`,
    `Total al ${fecha(caso.fechaLiquidacion)}: ${pesos(p.total)}`,
    r.mora ? `Total al pago (${fecha(caso.mora.fechaPago)}): ${pesos(r.mora.total)}` : null,
    'Cálculo orientativo: github.com/JeremiasMas/calculadora-art',
  ].filter(Boolean).join('\n');

  $('#barra-total').textContent = pesos(p.total);
  $('#barra').hidden = false;
}

async function copiar() {
  const btn = $('#btn-copiar');
  try {
    await navigator.clipboard.writeText(ultimoTexto);
    btn.textContent = 'Copiado';
  } catch {
    btn.textContent = 'No se pudo copiar';
  }
  setTimeout(() => { btn.textContent = 'Copiar resumen'; }, 1800);
}

/* ------------------------------------------------------------------ */
/* Liquidación en limpio                                               */
/* ------------------------------------------------------------------ */

function abrirLiquidacion() {
  if (!ultimo) return;
  documento = armarLiquidacion(ultimo.r, ultimo.caso, DATOS, { autos: valor('autos') });
  $('#liq-doc').innerHTML = documento.html;
  const aviso = $('#liq-aviso');
  aviso.hidden = !documento.estimada;
  aviso.textContent = documento.estimada
    ? 'Incluye tasas estimadas (marcadas con *): el período excede la última tasa publicada. Revisalo antes de presentarlo.'
    : '';
  $('#dlg-liq').showModal();
}

async function copiarLiquidacion() {
  const btn = $('#btn-copiar-liq');
  try {
    if (window.ClipboardItem && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([documento.html], { type: 'text/html' }),
        'text/plain': new Blob([documento.texto], { type: 'text/plain' }),
      })]);
    } else {
      await navigator.clipboard.writeText(documento.texto);
    }
    btn.textContent = 'Copiado';
  } catch {
    btn.textContent = 'No se pudo copiar';
  }
  setTimeout(() => { btn.textContent = 'Copiar con formato'; }, 1800);
}

function descargarLiquidacion() {
  const doc = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>Liquidación</title></head><body>${documento.html}</body></html>`;
  const url = URL.createObjectURL(new Blob(['\ufeff', doc], { type: 'application/msword' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `liquidacion-art-${ultimo.caso.fechaLiquidacion}.doc`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#btn-copiar-liq').addEventListener('click', copiarLiquidacion);
$('#btn-descargar-liq').addEventListener('click', descargarLiquidacion);
$('#btn-cerrar').addEventListener('click', () => $('#dlg-liq').close());

/* ------------------------------------------------------------------ */
/* Cálculo                                                             */
/* ------------------------------------------------------------------ */

function calcular() {
  if (!DATOS) return;
  const { caso, faltan } = leerCaso();
  if (faltan.length) return renderVacio(faltan);
  try {
    render(liquidar(caso, DATOS), caso);
  } catch (e) {
    renderError(e.message || String(e));
  }
}

let temporizador;
function programar() {
  clearTimeout(temporizador);
  temporizador = setTimeout(calcular, 200);
}

/* ------------------------------------------------------------------ */
/* Ejemplo, limpieza y eventos                                         */
/* ------------------------------------------------------------------ */

/** Caso ficticio: no corresponde a ningún expediente. */
const EJEMPLO = {
  incapacidad: '12',
  nacimiento: '1984-07-02',
  pmi: '2025-03-10',
  sueldos: {
    '2024-03': 950000, '2024-04': 980000, '2024-05': 1010000, '2024-06': 1040000, '2024-07': 1070000, '2024-08': 1100000,
    '2024-09': 1130000, '2024-10': 1160000, '2024-11': 1190000, '2024-12': 1220000, '2025-01': 1250000, '2025-02': 1280000,
  },
};

function cargarEjemplo() {
  limpiar(false);
  form.elements.modo.value = 'directo';
  aplicarModo();
  for (const k of ['incapacidad', 'nacimiento', 'pmi']) campo(k).value = EJEMPLO[k];
  sueldosGuardados.clear();
  for (const [m, v] of Object.entries(EJEMPLO.sueldos)) sueldosGuardados.set(m, v.toLocaleString('es-AR'));
  dibujarSueldos();
  calcular();
}

function limpiar(recalcular = true) {
  form.reset();
  aplicarModo();
  $('#lesiones').innerHTML = '';
  agregarLesion();
  sueldosGuardados.clear();
  $('#sueldos').innerHTML = '';
  dibujarSueldos();
  campo('liquidacion').value = hoyISO();
  if (recalcular) calcular();
}

form.addEventListener('input', (e) => {
  if (e.target.name === 'pmi') dibujarSueldos();
  programar();
});
form.addEventListener('change', (e) => {
  if (e.target.name === 'modo') aplicarModo();
  if (e.target.name === 'pmi') dibujarSueldos();
  programar();
});
for (const d of document.querySelectorAll('details.bloque')) d.addEventListener('toggle', programar);

$('#btn-lesion').addEventListener('click', () => agregarLesion());
$('#btn-ejemplo').addEventListener('click', cargarEjemplo);
$('#btn-limpiar').addEventListener('click', () => limpiar());
$('#btn-repetir').addEventListener('click', () => {
  const inputs = [...document.querySelectorAll('#sueldos input')];
  const primero = inputs.find((i) => i.value.trim());
  if (primero) inputs.forEach((i) => { i.value = primero.value; });
  programar();
});
$('#btn-ver').addEventListener('click', () => res.scrollIntoView({ behavior: 'smooth', block: 'start' }));

if ('IntersectionObserver' in window) {
  new IntersectionObserver(([e]) => {
    $('#barra').style.visibility = e.isIntersecting ? 'hidden' : 'visible';
  }).observe(res);
}

limpiar(false);
cargarDatos()
  .then(calcular)
  .catch(() => {
    $('#frescura').textContent = 'No se pudieron cargar los datos. Abrí la página desde un servidor (por ejemplo, GitHub Pages), no como archivo local.';
  });
