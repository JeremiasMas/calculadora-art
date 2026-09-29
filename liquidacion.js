/**
 * Liquidación en limpio para pegar en un escrito judicial.
 * Arma el mismo documento en HTML (para Word, con tablas) y en texto plano (con tabulaciones).
 * Incluye solo las tasas efectivamente aplicadas en cada período.
 */
import { buscarVigenciaPiso } from './engine.js';

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const mes = (k) => { const [y, m] = k.split('-'); return `${MESES[Number(m) - 1]}-${y}`; };
const fecha = (s) => { const [y, m, d] = s.split('-'); return `${d}/${m}/${y}`; };
const $ = (x) => `$ ${x.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const n = (x, d = 2) => x.toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (x, d = 2) => `${n(x * 100, d)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const sumarDia = (f) => { const d = new Date(`${f}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

const ENCUADRE = {
  IPP_HASTA_50: 'incapacidad permanente parcial definitiva (art. 14 ap. 2 inc. a, Ley 24.557)',
  IPP_50_66: 'incapacidad permanente parcial definitiva (art. 14 ap. 2 inc. b, Ley 24.557)',
  IPT: 'incapacidad permanente total definitiva (art. 15 ap. 2, Ley 24.557)',
};

/* Bloques neutros: cada uno se renderiza a HTML y a texto. */
const P = (texto) => ({ tipo: 'p', texto });
const H = (texto) => ({ tipo: 'h', texto });
const T = (cabecera, filas, alinear) => ({ tipo: 't', cabecera, filas, alinear });
const L = (etiqueta, valor, fuerte = false) => ({ tipo: 'l', etiqueta, valor, fuerte });

/**
 * @param {object} r      Resultado de liquidar().
 * @param {object} caso   Caso usado en el cálculo.
 * @param {object} datos  { ripte, pisos, tasaActivaBNA, tasaBTF }
 * @param {{autos?:string}} [meta]
 * @returns {{html:string, texto:string, estimada:boolean}}
 */
export function armarLiquidacion(r, caso, datos, meta = {}) {
  const p = r.prestacion;
  const i = r.incapacidad;
  const ib = r.ibm;
  const b = [];
  let estimada = false;
  let romano = 0;
  const seccion = (t) => { romano += 1; b.push(H(`${['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][romano - 1]}. ${t}`)); };

  b.push({ tipo: 'titulo', texto: 'LIQUIDACIÓN' });
  if (meta.autos?.trim()) b.push(P(`Autos: ${meta.autos.trim()}`));
  b.push(P(`Fecha de liquidación: ${fecha(caso.fechaLiquidacion)}.`));

  // I. Incapacidad
  seccion('INCAPACIDAD');
  b.push(P(`Incapacidad: ${n(i.porcentaje)}% de la total obrera, ${ENCUADRE[p.tramo]}.`));
  if (i.subtotal != null) {
    const f = caso.incapacidad.factores ?? {};
    b.push(P(`Baremo Dto. 659/96: subtotal físico ${n(i.subtotal, 2)}%; factores de ponderación sobre el subtotal: tipo de actividad ${n((f.actividad ?? 0) * 100, 1)}%, recalificación ${n((f.recalificacion ?? 0) * 100, 1)}%, edad ${n((f.edad ?? 0) * 100, 1)}%.`));
  }
  if (p.incapacidadLiquidable !== i.porcentaje) {
    b.push(P(`Se liquida la diferencia de ${n(p.incapacidadLiquidable)} puntos sobre la incapacidad ya indemnizada.`));
  }

  // II. IBM
  seccion('INGRESO BASE MENSUAL (art. 12 ap. 1, Ley 24.557, texto Ley 27.348)');
  b.push(P(`Primera manifestación invalidante: ${fecha(caso.fechaPMI)}. Remuneraciones del año anterior actualizadas por RIPTE a ${mes(ib.mesRefPMI)} (${n(ib.ripteRefPMI)}).`));
  b.push(T(
    ['Mes', 'Remuneración', 'RIPTE', 'Coeficiente', 'Actualizada'],
    [
      ...ib.detalle.map((d) => [mes(d.mes) + (d.sac ? ' (SAC)' : ''), $(d.monto), n(d.ripteMes), n(d.coeficiente, 4), $(d.actualizado)]),
      ['Total', '', '', '', $(ib.suma)],
    ],
    ['l', 'r', 'r', 'r', 'r'],
  ));
  b.push(L(`Ingreso base mensual (${$(ib.suma)} / ${ib.divisor})`, $(ib.ibm), true));

  // III. Prestación
  seccion('PRESTACIÓN DINERARIA A LA FECHA DE LA PMI');
  b.push(P(`Edad a la PMI: ${p.edad} años (coeficiente 65/${p.edad} = ${n(p.coefEdad, 4)}).`));
  const formula = p.tramo === 'IPT'
    ? `53 × ${$(ib.ibm)} × 65/${p.edad}`
    : `53 × ${$(ib.ibm)} × ${n(p.incapacidadLiquidable)}% × 65/${p.edad}`;
  b.push(L(`Fórmula: ${formula}`, $(p.formula)));
  const vig = buscarVigenciaPiso(datos.pisos, caso.fechaPMI);
  if (p.piso != null && vig) {
    const base = p.tramo === 'IPT' ? vig.art15_2 : vig.art14_2a;
    const txt = p.tramo === 'IPT' ? `${$(base)}` : `${$(base)} × ${n(p.incapacidadLiquidable)}%`;
    b.push(L(`Piso mínimo (${vig.norma}): ${txt}`, $(p.piso)));
  }
  b.push(L(`Se toma el mayor (${p.aplicaPiso ? 'piso' : 'fórmula'})`, $(p.base)));
  if (p.compensacion11_4 > 0) {
    b.push(L(`Compensación adicional de pago único (art. 11 ap. 4 inc. ${p.tramo === 'IPT' ? 'b' : 'a'}, Ley 24.557)`, $(p.compensacion11_4)));
  }
  if (!caso.inItinere) {
    b.push(L(`Indemnización adicional art. 3, Ley 26.773 (20%${p.aplicaMinimoArt3 ? ', mínimo legal' : ''})`, $(p.adicional20)));
  }
  b.push(L('Capital a la fecha de la PMI', $(p.capitalPMI), true));

  // IV. Actualización
  seccion('ACTUALIZACIÓN E INTERÉS PURO HASTA LA LIQUIDACIÓN (art. 12 ap. 2, Ley 24.557; STJ TDF, "Zamboni" y "Quipildor")');
  const rPMI = datos.ripte.valores[p.ripte.mesPMI];
  const rLiq = datos.ripte.valores[p.ripte.mesLiquidacion];
  b.push(L(`Variación RIPTE ${mes(p.ripte.mesPMI)} (${n(rPMI)}) a ${mes(p.ripte.mesLiquidacion)} (${n(rLiq)})`, `× ${n(p.ripte.coeficiente, 4)}`));
  b.push(L('Capital actualizado', $(p.capitalActualizado)));
  b.push(L(`Interés puro ${pct(p.interesPuro.tasa, 0)} anual del ${fecha(caso.fechaPMI)} al ${fecha(caso.fechaLiquidacion)} (${n(p.interesPuro.dias, 0)} días)`, $(p.interesPuro.monto)));
  b.push(L(`TOTAL AL ${fecha(caso.fechaLiquidacion)}`, $(p.total), true));

  // V. Mora
  if (r.mora && r.mora.detalleTasas.length) {
    const tea = caso.mora.criterioTasa === 'tea';
    const act = datos.tasaActivaBNA.actualizado;
    seccion('INTERESES MORATORIOS (art. 12 ap. 3, Ley 24.557; art. 770, CCyC)');
    b.push(P(`Tasa: promedio de la tasa activa cartera general nominal anual vencida a treinta días del Banco de la Nación Argentina${tea ? ', aplicada como tasa efectiva anual' : ''}, con capitalización semestral. Interés simple dentro de cada semestre, base 365 días.`));
    const cierres = new Map(r.mora.periodos.filter((x) => x.capitaliza).map((x) => [x.hasta, x]));
    const filas = [];
    for (const d of r.mora.detalleTasas) {
      const est = act && d.hasta > act;
      estimada ||= est;
      filas.push([fecha(d.desde), fecha(d.hasta), String(d.dias), `${pct(d.tasa)}${est ? ' *' : ''}`, $(d.capital), $(d.interes)]);
      const c = cierres.get(d.hasta);
      if (c) filas.push([`Capitalización al ${fecha(sumarDia(d.hasta))}`, '', '', '', '', $(c.interes)]);
    }
    filas.push(['Total intereses', '', '', '', '', $(r.mora.interes)]);
    b.push(T(['Desde', 'Hasta', 'Días', tea ? 'TEA' : 'TNA', 'Capital', 'Interés'], filas, ['l', 'l', 'r', 'r', 'r', 'r']));
    b.push(L(`TOTAL AL ${fecha(caso.mora.fechaPago)}`, $(r.mora.total), true));
  }

  // VI. Honorarios
  if (r.honorarios) {
    const h = r.honorarios;
    seccion('HONORARIOS');
    b.push(P(`Base regulatoria: ${$(h.base)}.`));
    for (const l of h.letrados) {
      const rec = l.recargoApoderado ? ` + ${n(l.recargoApoderado * 100, 0)}% por apoderado` : '';
      b.push(L(`${l.nombre}: ${n(l.porcentaje * 100, 1)}%${rec} (${n(l.alicuota * 100, 1)}%)`, $(l.monto)));
    }
    for (const x of h.peritos) b.push(L(`${x.nombre}: monto regulado`, $(x.monto)));
    if (h.art730.excede) {
      b.push(P(`Art. 730 CCyCN: los honorarios computables (${$(h.art730.sumaComputable)}) exceden el 25% de la base (${$(h.art730.tope)}); se prorratean en ${n(h.art730.factorProrrateo * 100, 2)}%.`));
      for (const x of [...h.letrados, ...h.peritos].filter((y) => y.computa730)) {
        b.push(L(`${x.nombre}, a cargo de la condenada en costas`, $(x.aCargoDelCondenado)));
      }
    }
    for (const x of r.interesesHonorarios?.peritos ?? []) {
      const act = datos.tasaBTF.actualizado;
      b.push(P(`Intereses sobre los honorarios periciales (criterio STJ TDF "Macías"): tasa del Banco de Tierra del Fuego para descuento de documentos en pesos de 181 a 365 días, interés simple, desde el ${fecha(x.desde)} hasta el ${fecha(x.hasta)}.`));
      const filas = x.detalleTasas.map((d) => {
        const est = act && d.hasta > act;
        estimada ||= est;
        return [fecha(d.desde), fecha(d.hasta), String(d.dias), `${pct(d.tasa)}${est ? ' *' : ''}`, $(d.interes)];
      });
      filas.push(['Total intereses', '', '', '', $(x.interes)]);
      b.push(T(['Desde', 'Hasta', 'Días', 'Tasa anual', 'Interés'], filas, ['l', 'l', 'r', 'r', 'r']));
    }
  }

  if (estimada) {
    b.push(P('* Tasa estimada: última publicada a la fecha del cálculo. Corresponde reliquidar con las tasas efectivamente publicadas.'));
  }

  return { html: aHTML(b), texto: aTexto(b), estimada };
}

/* ------------------------------------------------------------------ */

function aHTML(bloques) {
  const base = 'font-family:\'Times New Roman\',Times,serif;font-size:12pt;line-height:1.4;color:#000;';
  const celda = 'border:1px solid #000;padding:2pt 5pt;font-size:10.5pt;';
  const out = [`<div style="${base}">`];
  for (const x of bloques) {
    if (x.tipo === 'titulo') out.push(`<p style="text-align:center;font-weight:bold;font-size:13pt;margin:0 0 10pt;">${esc(x.texto)}</p>`);
    if (x.tipo === 'h') out.push(`<p style="font-weight:bold;margin:14pt 0 4pt;">${esc(x.texto)}</p>`);
    if (x.tipo === 'p') out.push(`<p style="margin:0 0 6pt;text-align:justify;">${esc(x.texto)}</p>`);
    if (x.tipo === 'l') {
      const w = x.fuerte ? 'font-weight:bold;' : '';
      out.push(`<table style="width:100%;border-collapse:collapse;margin:0;"><tr><td style="padding:1pt 0;${w}">${esc(x.etiqueta)}</td><td style="padding:1pt 0;text-align:right;white-space:nowrap;${w}">${esc(x.valor)}</td></tr></table>`);
    }
    if (x.tipo === 't') {
      const al = (k) => (x.alinear[k] === 'r' ? 'text-align:right;' : 'text-align:left;');
      out.push(`<table style="border-collapse:collapse;margin:4pt 0 8pt;">`);
      out.push(`<tr>${x.cabecera.map((c, k) => `<th style="${celda}${al(k)}font-weight:bold;">${esc(c)}</th>`).join('')}</tr>`);
      for (const f of x.filas) {
        const total = /^(Total|Capitalización)/.test(f[0]);
        out.push(`<tr>${f.map((c, k) => `<td style="${celda}${al(k)}${total ? 'font-weight:bold;' : ''}">${esc(c)}</td>`).join('')}</tr>`);
      }
      out.push('</table>');
    }
  }
  out.push('</div>');
  return out.join('\n');
}

function aTexto(bloques) {
  const out = [];
  for (const x of bloques) {
    if (x.tipo === 'titulo') out.push(x.texto, '');
    if (x.tipo === 'h') out.push('', x.texto);
    if (x.tipo === 'p') out.push(x.texto);
    if (x.tipo === 'l') out.push(`${x.etiqueta}: ${x.valor}`);
    if (x.tipo === 't') {
      out.push(x.cabecera.join('\t'));
      for (const f of x.filas) out.push(f.join('\t'));
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
