/**
 * Ejemplo de uso del motor con un caso ficticio (no corresponde a ningún expediente).
 * Uso: node ejemplo.js
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

const hoy = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

const caso = {
  incapacidad: 12,
  fechaNacimiento: '1984-07-02',
  fechaPMI: '2025-03-10',
  fechaLiquidacion: hoy,
  remuneraciones: [
    ['2024-03', 950000], ['2024-04', 980000], ['2024-05', 1010000], ['2024-06', 1040000],
    ['2024-07', 1070000], ['2024-08', 1100000], ['2024-09', 1130000], ['2024-10', 1160000],
    ['2024-11', 1190000], ['2024-12', 1220000], ['2025-01', 1250000], ['2025-02', 1280000],
  ].map(([mes, monto]) => ({ mes, monto })),
};

const r = liquidar(caso, datos);
const p = r.prestacion;
const $ = (x) => x.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2 });
const n = (x, d = 4) => x.toLocaleString('es-AR', { maximumFractionDigits: d });

console.log(`
CASO FICTICIO — incapacidad ${n(r.incapacidad.porcentaje, 2)}% · PMI ${caso.fechaPMI} · liquidación ${hoy}

B. IBM (ref. RIPTE ${r.ibm.mesRefPMI}) ............ ${$(r.ibm.ibm)}

C. PRESTACIÓN A LA PMI (${p.tramo})
   Edad ${p.edad} años (coef. ${n(p.coefEdad)})
   Fórmula ................................ ${$(p.formula)}
   Piso (${p.normaPiso}) ........... ${p.piso == null ? 'sin dato' : $(p.piso)}
   Base (${p.aplicaPiso ? 'piso' : 'fórmula'}) ......................... ${$(p.base)}
   Adicional 20% art. 3 Ley 26.773 ........ ${$(p.adicional20)}
   Capital a la PMI ....................... ${$(p.capitalPMI)}

D. ACTUALIZACIÓN
   RIPTE ${p.ripte.mesPMI} → ${p.ripte.mesLiquidacion} ............... × ${n(p.ripte.coeficiente)}
   Capital actualizado .................... ${$(p.capitalActualizado)}
   Interés puro 6% (${p.interesPuro.dias} días) ........... ${$(p.interesPuro.monto)}
   TOTAL A LA LIQUIDACIÓN ................. ${$(p.total)}
${r.advertencias.length ? '\nADVERTENCIAS\n' + r.advertencias.map((a) => '   - ' + a).join('\n') : ''}`);
