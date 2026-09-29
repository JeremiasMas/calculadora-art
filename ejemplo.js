/**
 * Ejemplo: caso "V., M. E. c/ Provincia ART S.A." (Juzg. Trabajo N° 2 DJN, 16/06/2026).
 *
 * Datos REALES (de la sentencia): baremo, PMI, honorarios, perito.
 * Datos SINTÉTICOS (no constan en la sentencia): fecha de nacimiento, remuneraciones,
 * fecha de liquidación y fecha de mora. Tasas: series reales de data/ (con proyección
 * más allá del último dato). El resultado es ilustrativo.
 */
import { readFileSync } from 'node:fs';
import { liquidar } from './engine.js';

const leer = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const datos = {
  ripte: leer('./data/ripte.json'),
  pisos: leer('./data/pisos.json'),
  tasaActivaBNA: leer('./data/tasa_activa_bna.json'),
  tasaBTF: leer('./data/tasa_btf.json'),
};

const caso = {
  incapacidad: {
    lesiones: [{ descripcion: 'Limitación funcional', porcentaje: 5, miembroSuperiorHabil: true }],
    factores: { actividad: 0.10, recalificacion: 0, edad: 0.005 },
  },
  fechaPMI: '2019-05-22',
  // --- sintéticos ---
  fechaNacimiento: '1965-03-10',
  remuneraciones: [
    ['2018-05', 48000], ['2018-06', 48000], ['2018-07', 50000], ['2018-08', 50000],
    ['2018-09', 50000], ['2018-10', 53000], ['2018-11', 53000], ['2018-12', 53000],
    ['2019-01', 56000], ['2019-02', 56000], ['2019-03', 58000], ['2019-04', 58000],
  ].map(([mes, monto]) => ({ mes, monto })),
  fechaLiquidacion: '2026-09-28',
  mora: {
    fechaMora: '2026-10-20',
    fechaPago: '2027-10-20', // sin `tasas`: serie BNA + proyección con la TNA vigente
  },
  // --- de la sentencia ---
  honorarios: {
    letrados: [
      { nombre: 'Letrado de la actora', parte: 'actora', porcentaje: 0.17, recargoApoderado: 0.40 },
      { nombre: 'Letrada de la demandada', parte: 'demandada', porcentaje: 0.07, recargoApoderado: 0.40 },
    ],
    peritos: [{ nombre: 'Perito médica', monto: 1_021_220 }],
    // Macías: tasa BTF descuento de documentos 181–365 días, desde la sentencia.
    intereses: {
      desde: '2026-06-16',
      hasta: '2027-10-20',
    },
  },
};

const r = liquidar(caso, datos);

const $ = (x) => x.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2 });
const n = (x, d = 4) => x.toLocaleString('es-AR', { maximumFractionDigits: d });
const p = r.prestacion;

console.log(`
A. INCAPACIDAD
   Subtotal físico ........................ ${n(r.incapacidad.subtotal)}%
   Ponderación (act. ${n(r.incapacidad.ponderacion.actividad)} + edad ${n(r.incapacidad.ponderacion.edad)})
   Incapacidad ............................ ${n(r.incapacidad.porcentaje, 2)}%

B. IBM (a la PMI, ref. RIPTE ${r.ibm.mesRefPMI})
   Suma actualizada / ${r.ibm.divisor} ................... ${$(r.ibm.ibm)}

C. PRESTACIÓN A LA PMI (franja ${p.tramo})
   Edad a la PMI .......................... ${p.edad} años (coef. ${n(p.coefEdad)})
   Fórmula 53 × IBM × % × 65/edad ......... ${$(p.formula)}
   Piso (${p.normaPiso}) ............ ${p.piso == null ? 'sin dato' : $(p.piso)}
   Base (${p.aplicaPiso ? 'piso' : 'fórmula'}) ........................... ${$(p.base)}
   Compensación art. 11.4 ................. ${$(p.compensacion11_4)}
   Adicional 20% art. 3 Ley 26.773 ........ ${$(p.adicional20)}
   Capital a la PMI ....................... ${$(p.capitalPMI)}

D. ACTUALIZACIÓN A LA LIQUIDACIÓN
   RIPTE ${p.ripte.mesPMI} → ${p.ripte.mesLiquidacion} ............... × ${n(p.ripte.coeficiente)}
   Capital actualizado .................... ${$(p.capitalActualizado)}
   Interés puro 6% (${p.interesPuro.dias} días) .......... ${$(p.interesPuro.monto)}
   TOTAL A LA LIQUIDACIÓN ................. ${$(p.total)}

D3. MORA (tasa activa BNA, capitalización semestral)
${r.mora.periodos.map((x) => `   ${x.desde} → ${x.hasta}: interés ${$(x.interes)}${x.capitaliza ? ' (capitaliza)' : ''}`).join('\n')}
   Total al pago .......................... ${$(r.mora.total)}

E. HONORARIOS (base: total a la liquidación)
${r.honorarios.letrados.map((l) => `   ${l.nombre} (${n(l.alicuota * 100, 2)}%) ... ${$(l.monto)} → a cargo condenado ${$(l.aCargoDelCondenado)}`).join('\n')}
${r.honorarios.peritos.map((x) => `   ${x.nombre} ... ${$(x.monto)} → a cargo condenado ${$(x.aCargoDelCondenado)}`).join('\n')}
   Art. 730: computable ${$(r.honorarios.art730.sumaComputable)} vs. tope 25% ${$(r.honorarios.art730.tope)} → ${r.honorarios.art730.excede ? `prorrateo × ${n(r.honorarios.art730.factorProrrateo)}` : 'sin prorrateo'}
${r.interesesHonorarios.peritos.map((x) => `   Macías ${x.nombre} (${x.desde} → ${x.hasta}, tasa BTF): interés ${$(x.interes)}; a cargo condenado ${$(x.interesACargoDelCondenado)}`).join('\n')}
${r.advertencias.length ? '\nADVERTENCIAS\n' + r.advertencias.map((a) => '   - ' + a).join('\n') : ''}`);
