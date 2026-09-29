import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  calcularIncapacidad,
  calcularIBM,
  calcularPrestacion,
  calcularMora,
  calcularHonorarios,
  liquidar,
  redondear,
  diasEntre,
  ErrorCalculo,
} from '../engine.js';

const leer = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const RIPTE = leer('../data/ripte.json');
const PISOS = leer('../data/pisos.json');

const cerca = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≠ ${b}`);

/** Serie RIPTE constante para aislar la aritmética. */
function ripteConstante(desde = '2017-01', meses = 120, valor = 100) {
  const s = {};
  let [y, m] = desde.split('-').map(Number);
  for (let i = 0; i < meses; i++) {
    s[`${y}-${String(m).padStart(2, '0')}`] = valor;
    if (++m > 12) { m = 1; y++; }
  }
  return s;
}

/** Doce remuneraciones del año previo a una PMI en mayo de 2019. */
const SUELDOS_2018_2019 = [
  ['2018-05', 48000], ['2018-06', 48000], ['2018-07', 50000], ['2018-08', 50000],
  ['2018-09', 50000], ['2018-10', 53000], ['2018-11', 53000], ['2018-12', 53000],
  ['2019-01', 56000], ['2019-02', 56000], ['2019-03', 58000], ['2019-04', 58000],
].map(([mes, monto]) => ({ mes, monto }));

/* ------------------------------------------------------------------ */

describe('Caso de referencia (regresión contra la sentencia)', () => {
  const baremo = {
    lesiones: [{ descripcion: 'Limitación funcional', porcentaje: 5, miembroSuperiorHabil: true }],
    factores: { actividad: 0.10, recalificacion: 0, edad: 0.005 },
  };

  test('incapacidad: 5,25 de subtotal y 5,80% final', () => {
    const r = calcularIncapacidad(baremo);
    cerca(r.subtotal, 5.25);
    assert.equal(r.porcentaje, 5.80);
  });

  test('el método de la perito (suma directa del factor edad) no se reproduce', () => {
    const r = calcularIncapacidad(baremo);
    const metodoPerito = 5.25 + 5.25 * 0.10 + 0.50;
    assert.notEqual(r.porcentaje, redondear(metodoPerito, 2));
  });

  test('piso a la PMI (22/05/2019, Nota SRT 2727/2019): $118.879,53', () => {
    const r = calcularPrestacion({
      ibm: 1, // fórmula ínfima: obliga a que gane el piso
      mesRefPMI: '2019-05',
      incapacidad: 5.80,
      fechaNacimiento: '1965-03-10',
      fechaPMI: '2019-05-22',
      fechaLiquidacion: '2019-05-22',
      ripte: RIPTE,
      pisos: PISOS,
    });
    assert.equal(r.normaPiso, 'Nota SRT 2727/2019');
    assert.ok(r.aplicaPiso);
    assert.equal(redondear(r.piso, 2), 118879.53);
  });

  test('honorarios: 17% + 40% (actora) y 7% + 40% (demandada)', () => {
    const r = calcularHonorarios({
      base: 10_000_000,
      letrados: [
        { nombre: 'Actora', parte: 'actora', porcentaje: 0.17, recargoApoderado: 0.40 },
        { nombre: 'Demandada', parte: 'demandada', porcentaje: 0.07, recargoApoderado: 0.40 },
      ],
      peritos: [{ nombre: 'Perito', monto: 1_021_220 }],
    });
    cerca(r.letrados[0].monto, 2_380_000);
    cerca(r.letrados[1].monto, 980_000);
  });
});

/* ------------------------------------------------------------------ */

describe('Módulo A — Baremo', () => {
  test('capacidad restante con dos lesiones: 10 y 5 → 14,5', () => {
    const r = calcularIncapacidad({ lesiones: [{ porcentaje: 5 }, { porcentaje: 10 }] });
    assert.equal(r.porcentaje, 14.5);
  });

  test('preexistencia del 20% reduce una lesión del 10% a 8%', () => {
    const r = calcularIncapacidad({ lesiones: [{ porcentaje: 10 }], preexistencia: 20 });
    assert.equal(r.porcentaje, 8);
  });

  test('factor fuera de rango se rechaza', () => {
    assert.throws(() => calcularIncapacidad({ lesiones: [{ porcentaje: 5 }], factores: { edad: 0.5 } }), ErrorCalculo);
  });
});

describe('Módulo B — IBM', () => {
  test('con RIPTE constante, el IBM es el promedio simple', () => {
    const r = calcularIBM({ remuneraciones: SUELDOS_2018_2019, fechaPMI: '2019-05-22', ripte: ripteConstante() });
    const promedio = SUELDOS_2018_2019.reduce((s, x) => s + x.monto, 0) / 12;
    cerca(r.ibm, promedio);
    assert.equal(r.divisor, 12);
  });

  test('menos de 12 meses: divide por los meses trabajados y advierte', () => {
    const r = calcularIBM({
      remuneraciones: SUELDOS_2018_2019.slice(6),
      fechaPMI: '2019-05-22',
      ripte: ripteConstante(),
    });
    assert.equal(r.divisor, 6);
    assert.ok(r.advertencias.some((a) => a.includes('6 meses')));
  });

  test('remuneraciones fuera del año previo se excluyen', () => {
    const r = calcularIBM({
      remuneraciones: [...SUELDOS_2018_2019, { mes: '2019-05', monto: 999999 }],
      fechaPMI: '2019-05-22',
      ripte: ripteConstante(),
    });
    assert.equal(r.detalle.length, 12);
    assert.ok(r.advertencias.some((a) => a.includes('2019-05')));
  });

  test('el SAC suma al numerador pero no al divisor', () => {
    const r = calcularIBM({
      remuneraciones: [...SUELDOS_2018_2019, { mes: '2018-12', monto: 26500, sac: true }],
      fechaPMI: '2019-05-22',
      ripte: ripteConstante(),
    });
    assert.equal(r.divisor, 12);
    const r2 = calcularIBM({
      remuneraciones: [...SUELDOS_2018_2019, { mes: '2018-12', monto: 26500, sac: true }],
      fechaPMI: '2019-05-22',
      ripte: ripteConstante(),
      excluirSAC: true,
    });
    cerca(r.ibm - r2.ibm, 26500 / 12);
  });
});

describe('Módulos C + D — Prestación y actualización', () => {
  const base = {
    incapacidad: 5.80,
    fechaNacimiento: '1965-03-10',
    fechaPMI: '2019-05-22',
    fechaLiquidacion: '2026-09-28',
    ripte: RIPTE,
    pisos: PISOS,
  };

  test('pasos 1 + 2 equivalen a actualizar cada sueldo hasta la liquidación', () => {
    const ibm = calcularIBM({ remuneraciones: SUELDOS_2018_2019, fechaPMI: base.fechaPMI, ripte: RIPTE });
    const p = calcularPrestacion({ ...base, ibm: ibm.ibm, mesRefPMI: ibm.mesRefPMI });
    const rLiq = RIPTE.valores[p.ripte.mesLiquidacion];
    const directo = SUELDOS_2018_2019.reduce((s, x) => s + x.monto * rLiq / RIPTE.valores[x.mes], 0) / 12;
    cerca(ibm.ibm * p.ripte.coeficiente, directo);
  });

  test('linealidad: aplicar RIPTE y 6% al IBM o al capital da lo mismo', () => {
    const ibm = calcularIBM({ remuneraciones: SUELDOS_2018_2019, fechaPMI: base.fechaPMI, ripte: RIPTE });
    const p = calcularPrestacion({ ...base, ibm: ibm.ibm, mesRefPMI: ibm.mesRefPMI });
    assert.equal(p.aplicaPiso, false);
    const dias = p.interesPuro.dias;
    const ibmActualizado = ibm.ibm * p.ripte.coeficiente * (1 + 0.06 * dias / 365);
    const viaIBM = 1.2 * 53 * ibmActualizado * 0.058 * (65 / p.edad);
    cerca(p.total, viaIBM);
  });

  test('usa el último RIPTE disponible y lo informa', () => {
    const ibm = calcularIBM({ remuneraciones: SUELDOS_2018_2019, fechaPMI: base.fechaPMI, ripte: RIPTE });
    const p = calcularPrestacion({ ...base, ibm: ibm.ibm, mesRefPMI: ibm.mesRefPMI });
    assert.equal(p.ripte.mesLiquidacion, '2026-07');
  });

  test('in itinere: sin adicional del 20%', () => {
    const p = calcularPrestacion({ ...base, ibm: 60000, mesRefPMI: '2019-05', inItinere: true });
    assert.equal(p.adicional20, 0);
    cerca(p.capitalPMI, p.base);
  });

  test('sin fecha de nacimiento: error (la planilla calculaba 120 años)', () => {
    assert.throws(() => calcularPrestacion({ ...base, ibm: 60000, mesRefPMI: '2019-05', fechaNacimiento: undefined }), ErrorCalculo);
    assert.throws(() => calcularPrestacion({ ...base, ibm: 60000, mesRefPMI: '2019-05', fechaNacimiento: '1900-01-01' }), ErrorCalculo);
  });

  test('incapacidad mayor al 100% o nula: error', () => {
    assert.throws(() => calcularPrestacion({ ...base, ibm: 60000, mesRefPMI: '2019-05', incapacidad: 120 }), ErrorCalculo);
    assert.throws(() => calcularPrestacion({ ...base, ibm: 60000, mesRefPMI: '2019-05', incapacidad: 0 }), ErrorCalculo);
  });

  test('PMI anterior a la Ley 27.348: fuera de alcance', () => {
    assert.throws(() => calcularPrestacion({
      ...base, ibm: 60000, mesRefPMI: '2016-10', fechaPMI: '2016-10-10',
    }), /27\.348/);
  });

  test('PMI sin piso cargado: advierte, no compara y marca incompleto', () => {
    const p = calcularPrestacion({
      ...base, ibm: 1_000_000, mesRefPMI: '2025-06', pisos: { vigencias: [] },
      fechaPMI: '2025-06-10', fechaLiquidacion: '2026-09-28',
    });
    assert.equal(p.piso, null);
    assert.equal(p.incompleto, true);
    assert.ok(p.advertencias.some((a) => a.includes('piso')));
  });
});

describe('Módulo D3 — Mora con capitalización semestral', () => {
  test('tasa constante: coincide con la fórmula cerrada', () => {
    const r = calcularMora({
      capital: 1_000_000,
      fechaMora: '2026-01-15',
      fechaPago: '2027-01-15',
      tasas: [{ desde: '2026-01-01', hasta: '2027-12-31', tna: 0.40 }],
      diasInclusivos: false,
    });
    const d1 = diasEntre('2026-01-15', '2026-07-15');
    const d2 = diasEntre('2026-07-15', '2027-01-15');
    cerca(r.total, 1_000_000 * (1 + 0.40 * d1 / 365) * (1 + 0.40 * d2 / 365));
    assert.equal(r.periodos.length, 2);
    assert.equal(r.periodos[0].capitaliza, true);
  });

  test('tasa que cambia a mitad de semestre', () => {
    const r = calcularMora({
      capital: 100,
      fechaMora: '2026-01-01',
      fechaPago: '2026-07-01',
      tasas: [
        { desde: '2026-01-01', hasta: '2026-03-31', tna: 0.365 },
        { desde: '2026-04-01', hasta: '2026-12-31', tna: 0.730 },
      ],
      diasInclusivos: false,
    });
    const esperado = 100 * (0.365 * 90 / 365 + 0.730 * 91 / 365);
    cerca(r.interes, esperado);
  });

  test('hueco en la serie de tasas: error', () => {
    assert.throws(() => calcularMora({
      capital: 100,
      fechaMora: '2026-01-01',
      fechaPago: '2026-07-01',
      tasas: [{ desde: '2026-01-01', hasta: '2026-03-31', tna: 0.3 }],
    }), ErrorCalculo);
  });
});

describe('Módulo E — Art. 730 CCyCN', () => {
  test('si excede el 25%, prorratea entre letrados de la actora y perito', () => {
    const r = calcularHonorarios({
      base: 10_000_000,
      letrados: [
        { nombre: 'Actora', parte: 'actora', porcentaje: 0.17, recargoApoderado: 0.40 },
        { nombre: 'Demandada', parte: 'demandada', porcentaje: 0.07, recargoApoderado: 0.40 },
      ],
      peritos: [{ nombre: 'Perito', monto: 1_021_220 }],
    });
    cerca(r.art730.sumaComputable, 3_401_220);
    assert.equal(r.art730.excede, true);
    const aCargo = r.letrados[0].aCargoDelCondenado + r.peritos[0].aCargoDelCondenado;
    cerca(aCargo, 2_500_000);
    cerca(r.letrados[1].aCargoDelCondenado, 980_000); // letrado del condenado: no computa
  });

  test('si no excede, no hay prorrateo', () => {
    const r = calcularHonorarios({
      base: 100_000_000,
      letrados: [{ nombre: 'Actora', parte: 'actora', porcentaje: 0.17, recargoApoderado: 0.40 }],
      peritos: [{ nombre: 'Perito', monto: 1_021_220 }],
    });
    assert.equal(r.art730.factorProrrateo, 1);
  });
});

describe('Orquestador', () => {
  test('liquidar encadena los módulos sin errores', () => {
    const r = liquidar({
      incapacidad: {
        lesiones: [{ porcentaje: 5, miembroSuperiorHabil: true }],
        factores: { actividad: 0.10, edad: 0.005 },
      },
      remuneraciones: SUELDOS_2018_2019,
      fechaNacimiento: '1965-03-10',
      fechaPMI: '2019-05-22',
      fechaLiquidacion: '2026-09-28',
    }, { ripte: RIPTE, pisos: PISOS });
    assert.equal(r.incapacidad.porcentaje, 5.80);
    assert.ok(r.prestacion.total > 0);
    assert.equal(r.mora, null);
  });
});

/* ------------------------------------------------------------------ */
/* v0.2 — Franjas > 50%, pago único art. 11.4 y Macías                */
/* ------------------------------------------------------------------ */

import {
  calcularInteresesHonorarios,
  franjaIncapacidad,
} from '../engine.js';

describe('Franjas de incapacidad y pago único (art. 11.4)', () => {
  // PMI 15/04/2020 → Res. SRT 24/2020: 14.2 = 2.958.970; 11.4.a = 1.315.098; 11.4.b = 1.643.873; art. 3 = 560.365
  const comun = {
    mesRefPMI: '2020-04',
    fechaNacimiento: '1970-01-01', // 50 años a la PMI
    fechaPMI: '2020-04-15',
    fechaLiquidacion: '2020-04-15', // sin actualización: aísla la franja
    ripte: RIPTE,
    pisos: PISOS,
  };

  test('límites de franja: 50 es IPP ≤ 50; 66 es IPT', () => {
    assert.equal(franjaIncapacidad(50), 'IPP_HASTA_50');
    assert.equal(franjaIncapacidad(50.01), 'IPP_50_66');
    assert.equal(franjaIncapacidad(65.99), 'IPP_50_66');
    assert.equal(franjaIncapacidad(66), 'IPT');
  });

  test('IPP 60%: fórmula × % + compensación 11.4.a; el 20% incluye la compensación', () => {
    const p = calcularPrestacion({ ...comun, ibm: 100_000, incapacidad: 60 });
    const formula = 53 * 100_000 * 0.60 * (65 / 50);
    cerca(p.formula, formula);
    assert.equal(p.aplicaPiso, false);
    assert.equal(p.compensacion11_4, 1_315_098);
    cerca(p.adicional20, 0.2 * (formula + 1_315_098));
    cerca(p.capitalPMI, 1.2 * (formula + 1_315_098));
  });

  test('IPT 70%: fórmula sin %, piso completo, compensación 11.4.b', () => {
    const p = calcularPrestacion({ ...comun, ibm: 100_000, incapacidad: 70 });
    cerca(p.formula, 53 * 100_000 * (65 / 50));
    assert.equal(p.compensacion11_4, 1_643_873);
    const bajo = calcularPrestacion({ ...comun, ibm: 1_000, incapacidad: 70 });
    assert.ok(bajo.aplicaPiso);
    cerca(bajo.piso, 2_958_970); // piso completo, no × %
  });

  test('IPT: el adicional nunca es menor al mínimo del art. 3', () => {
    const p = calcularPrestacion({ ...comun, ibm: 1_000, incapacidad: 70 });
    // 20% de (2.958.970 + 1.643.873) = 920.568,6 > 560.365 → no aplica el mínimo
    assert.equal(p.aplicaMinimoArt3, false);
  });

  test('IPT con incapacidad previa pagada: no soportado', () => {
    assert.throws(() => calcularPrestacion({ ...comun, ibm: 100_000, incapacidad: 70, incapacidadPagada: 10 }), ErrorCalculo);
  });

  test('IPP 60% con 55% ya pagado: no repite la compensación', () => {
    const p = calcularPrestacion({ ...comun, ibm: 100_000, incapacidad: 60, incapacidadPagada: 55 });
    assert.equal(p.compensacion11_4, 0);
    assert.ok(p.advertencias.some((a) => a.includes('11.4.a')));
  });

  test('pisos SRT 03/2026: 97.502.420 × 5% = 4.875.121', () => {
    const p = calcularPrestacion({
      ...comun, ibm: 1, mesRefPMI: '2026-04', fechaNacimiento: '1980-01-01',
      fechaPMI: '2026-04-10', fechaLiquidacion: '2026-04-10', incapacidad: 5,
    });
    assert.ok(p.aplicaPiso);
    cerca(p.piso, 4_875_121);
  });
});

describe('Criterio Macías (honorarios de monto fijo)', () => {
  const honorarios = calcularHonorarios({
    base: 100_000_000,
    letrados: [{ nombre: 'Actora', parte: 'actora', porcentaje: 0.17, recargoApoderado: 0.40 }],
    peritos: [{ nombre: 'Perito', monto: 1_021_220 }],
  });

  test('perito: interés simple desde la regulación, sin capitalizar', () => {
    const r = calcularInteresesHonorarios(honorarios, {
      desde: '2026-06-16',
      hasta: '2027-06-16',
      tasas: [{ desde: '2026-01-01', hasta: '2027-12-31', tna: 0.40 }],
    });
    const dias = diasEntre('2026-06-16', '2027-06-16') + 1; // inclusivo
    cerca(r.peritos[0].interes, 1_021_220 * 0.40 * dias / 365);
    assert.equal(r.letrados.length, 0);
  });

  test('sin tasas del BTF: error', () => {
    assert.throws(() => calcularInteresesHonorarios(honorarios, { desde: '2026-06-16', hasta: '2027-06-16' }), ErrorCalculo);
  });
});

describe('Comparación con liquidaciones de las partes', () => {
  test('diferencia y variación contra cada parte', () => {
    const r = liquidar({
      incapacidad: 5.8,
      remuneraciones: SUELDOS_2018_2019,
      fechaNacimiento: '1965-03-10',
      fechaPMI: '2019-05-22',
      fechaLiquidacion: '2026-09-28',
      liquidacionesPartes: { actora: 20_000_000, demandada: 9_000_000 },
    }, { ripte: RIPTE, pisos: PISOS });
    cerca(r.comparacion.actora.diferencia, r.prestacion.total - 20_000_000);
    cerca(r.comparacion.demandada.variacion, r.prestacion.total / 9_000_000 - 1);
  });
});

/* ------------------------------------------------------------------ */
/* v0.3 — Series de datos: pisos 2024–2027, tasa activa BNA, tasa BTF   */
/* ------------------------------------------------------------------ */

import { tramosTasaActivaBNA, tramosTasaBTF } from '../engine.js';

const BNA = leer('../data/tasa_activa_bna.json');
const BTF = leer('../data/tasa_btf.json');

describe('Serie de pisos SRT', () => {
  test('continua, sin huecos ni superposiciones, hasta el 28/02/2027', () => {
    const v = PISOS.vigencias;
    for (let i = 1; i < v.length; i++) {
      assert.equal(diasEntre(v[i - 1].hasta, v[i].desde), 1, `${v[i - 1].hasta} → ${v[i].desde}`);
    }
    assert.equal(v[v.length - 1].hasta, '2027-02-28');
  });

  test('Res. SRT 39/2026: PMI 15/09/2026 al 5% → piso 5.717.705,50', () => {
    const p = calcularPrestacion({
      ibm: 1, mesRefPMI: '2026-07', incapacidad: 5, fechaNacimiento: '1980-01-01',
      fechaPMI: '2026-09-15', fechaLiquidacion: '2026-09-15', ripte: RIPTE, pisos: PISOS,
    });
    assert.equal(p.normaPiso, 'Res. SRT 39/2026');
    cerca(p.piso, 5_717_705.5);
  });

  test('Res. SRT 9/2025: compensación 11.4.a vigente para PMI de junio de 2025', () => {
    const p = calcularPrestacion({
      ibm: 1_000_000, mesRefPMI: '2025-06', incapacidad: 55, fechaNacimiento: '1980-01-01',
      fechaPMI: '2025-06-10', fechaLiquidacion: '2025-06-10', ripte: RIPTE, pisos: PISOS,
    });
    assert.equal(p.compensacion11_4, 31_911_034);
  });
});

describe('Tasa activa BNA (serie mensual)', () => {
  test('un mes completo devenga exactamente el % publicado', () => {
    const { tramos } = tramosTasaActivaBNA(BNA);
    const r = calcularMora({ capital: 100, fechaMora: '2024-01-01', fechaPago: '2024-01-31', tasas: tramos });
    cerca(r.interes, 10.78);
  });

  test('después del último mes proyecta con la TNA vigente y lo advierte', () => {
    const { tramos, advertencias } = tramosTasaActivaBNA(BNA, '2027-12-31');
    assert.equal(tramos[tramos.length - 1].tna, BNA.vigencias.at(-1).tna);
    assert.ok(advertencias[0].includes('estimación'));
  });

  test('liquidar usa la serie si el caso no trae tasas', () => {
    const r = liquidar({
      incapacidad: 5.8,
      remuneraciones: SUELDOS_2018_2019,
      fechaNacimiento: '1965-03-10',
      fechaPMI: '2019-05-22',
      fechaLiquidacion: '2026-09-28',
      mora: { fechaMora: '2025-01-01', fechaPago: '2025-06-30' },
    }, { ripte: RIPTE, pisos: PISOS, tasaActivaBNA: BNA });
    const pct = ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06']
      .reduce((s, m) => s + BNA.mensual[m] / 100, 0);
    cerca(r.mora.interes, r.prestacion.total * pct);
  });
});

describe('Tasa BTF (Macías)', () => {
  test('Macías por defecto (46,80%); Cordero a pedido (42,32%)', () => {
    const m = tramosTasaBTF(BTF, { desde: '2026-10-01', hasta: '2027-01-01' });
    assert.equal(m.tramos.at(-1).tna, BTF.macias.at(-1).tasa);
    const c = tramosTasaBTF(BTF, { desde: '2026-10-01', hasta: '2027-01-01', variante: 'cordero' });
    assert.equal(c.tramos.at(-1).tna, BTF.cordero.at(-1).tasa);
  });

  test('antes de la primera vigencia: falla salvo que se pida completar', () => {
    const honorarios = calcularHonorarios({ base: 1e8, peritos: [{ nombre: 'Perito', monto: 1_021_220 }] });
    // Las series empiezan el 01/01/2017
    const hasta = BTF.cordero[1] ? diasAntes(BTF.cordero[1].desde) : '2017-06-26';
    const sin = tramosTasaBTF(BTF, { desde: '2016-06-16', hasta, variante: 'cordero' });
    assert.throws(() => calcularInteresesHonorarios(honorarios, { desde: '2016-06-16', hasta, tasas: sin.tramos }), ErrorCalculo);
    const con = tramosTasaBTF(BTF, { desde: '2016-06-16', hasta, variante: 'cordero', completarConVigente: true });
    const r = calcularInteresesHonorarios(honorarios, { desde: '2016-06-16', hasta, tasas: con.tramos });
    cerca(r.peritos[0].interes, 1_021_220 * BTF.cordero[0].tasa * (diasEntre('2016-06-16', hasta) + 1) / 365);
    assert.ok(con.advertencias.some((a) => a.includes('estimación')));
  });
});

/* ------------------------------------------------------------------ */
/* v0.4 — Regresión contra la calculadora del Colegio de Abogados      */
/*        de Ushuaia (sistemadeliquidaciones.cpau.com.ar, 28/09/2026)  */
/* ------------------------------------------------------------------ */

import { teaDesdeTna } from '../engine.js';

describe('Calculadora del Colegio de Abogados de Ushuaia', () => {
  const honorarios = calcularHonorarios({ base: 1e9, peritos: [{ nombre: 'Prueba', monto: 10_000_000 }] });

  test('Macías: $10 M del 21/09 al 29/09/2026 → $115.397,26', () => {
    const { tramos } = tramosTasaBTF(BTF, { desde: '2026-09-21', hasta: '2026-09-29' });
    const r = calcularInteresesHonorarios(honorarios, { desde: '2026-09-21', hasta: '2026-09-29', tasas: tramos });
    assert.equal(redondear(r.peritos[0].interes, 2), 115_397.26);
  });

  test('Cordero (sin capitalización): $10 M del 21/09 al 29/09/2026 → $104.350,68', () => {
    const { tramos } = tramosTasaBTF(BTF, { desde: '2026-09-21', hasta: '2026-09-29', variante: 'cordero' });
    const r = calcularInteresesHonorarios(honorarios, { desde: '2026-09-21', hasta: '2026-09-29', tasas: tramos });
    assert.equal(redondear(r.peritos[0].interes, 2), 104_350.68);
  });

  test('conteo de días inclusivo: del 01/01 al 01/07/2025 son 182 días', () => {
    const r = calcularMora({
      capital: 365, fechaMora: '2025-01-01', fechaPago: '2025-07-01', mesesCapitalizacion: 0,
      tasas: [{ desde: '2025-01-01', hasta: '2025-12-31', tna: 1 }],
    });
    cerca(r.interes, 182);
  });

  test('criterio TEA: convierte la TNA a TEA y la aplica simple', () => {
    const tna = tramosTasaActivaBNA(BNA).tramos.find((t) => t.desde === '2025-01-01').tna;
    const tea = tramosTasaActivaBNA(BNA, undefined, { criterio: 'tea' }).tramos.find((t) => t.desde === '2025-01-01').tna;
    cerca(tea, teaDesdeTna(tna));
    assert.ok(tea > tna);
  });
});

describe('Serie Macías completa (Colegio, 01/01/2017 → 28/09/2026)', () => {
  test('$1 M durante todo el período → $6.995.110,96 de interés', () => {
    const { tramos } = tramosTasaBTF(BTF, { desde: '2017-01-01', hasta: '2026-09-28' });
    const r = calcularMora({ capital: 1_000_000, fechaMora: '2017-01-01', fechaPago: '2026-09-28', tasas: tramos, mesesCapitalizacion: 0 });
    assert.ok(Math.abs(r.interes - 6_995_110.96) < 0.05, String(r.interes)); // el Colegio redondea por tramo
  });

  test('el perito del caso de referencia no necesita estimación hasta la última actualización', () => {
    const t = tramosTasaBTF(BTF, { desde: '2026-06-16', hasta: BTF.actualizado });
    assert.equal(t.advertencias.length, 0);
    const f = tramosTasaBTF(BTF, { desde: '2026-06-16', hasta: '2027-06-16' });
    assert.ok(f.advertencias.some((x) => x.includes('estimación')));
  });
});

describe('Mora: bordes de la capitalización', () => {
  test('no capitaliza el mismo día del pago y cada tramo termina el día anterior al siguiente', () => {
    const r = calcularMora({
      capital: 1_000_000, fechaMora: '2026-10-20', fechaPago: '2027-10-20',
      tasas: [{ desde: '2026-01-01', hasta: '2027-12-31', tna: 0.365 }],
    });
    assert.equal(r.periodos.length, 2);
    assert.equal(r.periodos[0].hasta, '2027-04-19');
    assert.equal(r.periodos[1].desde, '2027-04-20');
    assert.equal(r.periodos[1].hasta, '2027-10-20');
    const d1 = diasEntre('2026-10-20', '2027-04-20');
    const d2 = diasEntre('2027-04-20', '2027-10-20') + 1;
    cerca(r.total, 1_000_000 * (1 + 0.365 * d1 / 365) * (1 + 0.365 * d2 / 365));
  });
});

describe('v0.6 — Detalle de tasas y vigencias diarias', () => {
  test('mora: el detalle por tramo suma el interés total', () => {
    const { tramos } = tramosTasaActivaBNA(BNA, '2025-12-31');
    const r = calcularMora({ capital: 1_000_000, fechaMora: '2025-03-15', fechaPago: '2025-12-31', tasas: tramos });
    const suma = r.detalleTasas.reduce((s, x) => s + x.interes, 0);
    cerca(suma, r.interes);
    assert.equal(r.detalleTasas[0].desde, '2025-03-15');
    assert.equal(r.detalleTasas.at(-1).hasta, '2025-12-31');
    assert.equal(r.detalleTasas.reduce((s, x) => s + x.dias, 0), diasEntre('2025-03-15', '2025-12-31') + 1);
  });

  test('BNA: desde la primera vigencia reemplaza a la serie mensual', () => {
    const { tramos } = tramosTasaActivaBNA(BNA, '2026-10-15');
    const primera = BNA.vigencias[0];
    const antes = tramos.find((x) => x.hasta === diasAnterior(primera.desde));
    assert.ok(antes, 'el mes se corta el día anterior a la vigencia');
    const desde = tramos.find((x) => x.desde === primera.desde);
    assert.equal(desde.tna, primera.tna);
  });

  test('BNA: pasada la última actualización, advierte estimación', () => {
    const { advertencias } = tramosTasaActivaBNA(BNA, '2027-12-31');
    assert.ok(advertencias.some((x) => x.includes('estimación')));
    const hoy = tramosTasaActivaBNA(BNA, BNA.actualizado);
    assert.equal(hoy.advertencias.length, 0);
  });
});

function diasAnterior(f) {
  const d = new Date(f + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

describe('Tramos partidos en la fecha de actualización', () => {
  test('BTF: el tramo real y el estimado quedan separados', () => {
    const { tramos } = tramosTasaBTF(BTF, { desde: '2026-06-16', hasta: '2027-10-20' });
    assert.ok(tramos.some((x) => x.hasta === BTF.actualizado));
    assert.ok(tramos.some((x) => x.desde === diasDespues(BTF.actualizado)));
    const honorarios = calcularHonorarios({ base: 1e9, peritos: [{ nombre: 'Perito', monto: 1_000_000 }] });
    const r = calcularInteresesHonorarios(honorarios, { desde: '2026-06-16', hasta: '2027-10-20', tasas: tramos });
    assert.equal(r.peritos[0].detalleTasas.at(-2).hasta, BTF.actualizado);
  });
});

function diasDespues(f) {
  const d = new Date(f + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe('Serie Cordero completa (Colegio, 01/01/2017 → 29/09/2026)', () => {
  test('$1 M durante todo el período → $6.335.493,97 de interés', () => {
    const { tramos } = tramosTasaBTF(BTF, { desde: '2017-01-01', hasta: '2026-09-29', variante: 'cordero' });
    const r = calcularMora({ capital: 1_000_000, fechaMora: '2017-01-01', fechaPago: '2026-09-29', tasas: tramos, mesesCapitalizacion: 0 });
    assert.ok(Math.abs(r.interes - 6_335_493.97) < 0.05, String(r.interes));
  });
});

function diasAntes(f) {
  const d = new Date(f + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
