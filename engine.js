/**
 * Motor de cálculo — Prestaciones dinerarias por incapacidad laboral permanente definitiva
 * (arts. 14.2.a, 14.2.b, 15.2 y 11.4 Ley 24.557; art. 3 Ley 26.773). PMI desde el 05/03/2017.
 * Fuera de alcance: muerte, gran invalidez e incapacidades provisorias.
 *
 * Metodología: STJ de Tierra del Fuego ("Zamboni", 09/04/2024; "Quipildor", 18/09/2024;
 * art. 37 Ley Prov. 110), tal como la aplica "V., M. E. c/ Provincia ART S.A."
 * (Juzg. 1ª Inst. Trabajo N° 2 DJN, 16/06/2026), en adelante "la sentencia de referencia".
 *
 * Convenciones:
 *   - Fechas: 'YYYY-MM-DD'. Meses: 'YYYY-MM'.
 *   - Incapacidad: puntos porcentuales (5.8 = 5,8%).
 *   - Tasas y factores: decimales (0.06 = 6%).
 *   - Montos en pesos, sin redondeo interno; se redondea solo al presentar.
 *
 * Sin dependencias. Funciones puras.
 */

export const VERSION = '0.6.0';

/** Vigencia de la Ley 27.348 (IBM promedio mensual actualizado por RIPTE). */
export const REGIMEN_27348 = '2017-03-05';

export class ErrorCalculo extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorCalculo';
  }
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

const MS_DIA = 86_400_000;

export function parseFecha(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new ErrorCalculo(`Fecha inválida o faltante: ${s}`);
  }
  const [y, m, d] = s.split('-').map(Number);
  const f = new Date(Date.UTC(y, m - 1, d));
  if (f.getUTCFullYear() !== y || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) {
    throw new ErrorCalculo(`Fecha inexistente: ${s}`);
  }
  return f;
}

const fmtFecha = (f) => f.toISOString().slice(0, 10);
const mesDeFecha = (s) => parseFecha(s).toISOString().slice(0, 7);

export function sumarMeses(mes, n) {
  const [y, m] = mes.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

export function mesesEntre(mesA, mesB) {
  const [ya, ma] = mesA.split('-').map(Number);
  const [yb, mb] = mesB.split('-').map(Number);
  return (yb * 12 + mb) - (ya * 12 + ma);
}

export const diasEntre = (a, b) => Math.round((parseFecha(b) - parseFecha(a)) / MS_DIA);

function sumarDias(fecha, n) {
  return fmtFecha(new Date(parseFecha(fecha).getTime() + n * MS_DIA));
}

/** Suma n meses conservando el día; si el mes destino es más corto, usa su último día. */
function sumarMesesFecha(fecha, n) {
  const f = parseFecha(fecha);
  const y = f.getUTCFullYear();
  const m = f.getUTCMonth() + n;
  const ultimo = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return fmtFecha(new Date(Date.UTC(y, m, Math.min(f.getUTCDate(), ultimo))));
}

export function edadCumplida(nacimiento, fecha) {
  const n = parseFecha(nacimiento);
  const f = parseFecha(fecha);
  let edad = f.getUTCFullYear() - n.getUTCFullYear();
  const antesDelCumple =
    f.getUTCMonth() < n.getUTCMonth() ||
    (f.getUTCMonth() === n.getUTCMonth() && f.getUTCDate() < n.getUTCDate());
  return antesDelCumple ? edad - 1 : edad;
}

export function redondear(x, decimales = 2) {
  const p = 10 ** decimales;
  return Math.round((x + Math.sign(x) * Number.EPSILON) * p) / p;
}

function exigir(condicion, mensaje) {
  if (!condicion) throw new ErrorCalculo(mensaje);
}

/** Acepta el JSON de datos ({ valores: {...} }) o el mapa mes → valor directamente. */
function serieRipte(ripte) {
  const serie = ripte?.valores ?? ripte;
  exigir(serie && typeof serie === 'object', 'Falta la serie RIPTE.');
  return serie;
}

export function valorRipte(ripte, mes) {
  const v = serieRipte(ripte)[mes];
  exigir(v > 0, `Falta el RIPTE de ${mes}.`);
  return v;
}

export function ultimoMesRipte(ripte, hastaMes) {
  const meses = Object.keys(serieRipte(ripte)).filter((k) => k <= hastaMes).sort();
  exigir(meses.length > 0, `No hay RIPTE cargado hasta ${hastaMes}.`);
  return meses[meses.length - 1];
}

/* ------------------------------------------------------------------ */
/* Módulo A — Grado de incapacidad (Baremo Dto. 659/96)                */
/* ------------------------------------------------------------------ */

/**
 * @param {object} p
 * @param {{descripcion?:string, porcentaje:number, miembroSuperiorHabil?:boolean}[]} p.lesiones
 * @param {number} [p.preexistencia=0]  Incapacidad preexistente, en puntos.
 * @param {{actividad?:number, recalificacion?:number, edad?:number}} [p.factores]
 *        Factores de ponderación como proporción del subtotal (0.10 = 10%).
 * @param {number} [p.decimales=2]
 *
 * Criterio (sentencia de referencia): los factores de ponderación son porcentajes del subtotal
 * físico, no puntos que se suman directo. 5,25 × (1 + 0,10 + 0 + 0,005) = 5,80.
 */
export function calcularIncapacidad({ lesiones, preexistencia = 0, factores = {}, decimales = 2 }) {
  exigir(Array.isArray(lesiones) && lesiones.length > 0, 'Se requiere al menos una lesión.');
  exigir(preexistencia >= 0 && preexistencia < 100, 'La preexistencia debe estar entre 0 y 100.');

  const { actividad = 0, recalificacion = 0, edad = 0 } = factores;
  for (const [nombre, v] of Object.entries({ actividad, recalificacion, edad })) {
    exigir(v >= 0 && v <= 0.2, `Factor de ${nombre} fuera de rango (0 a 0,20): ${v}`);
  }

  const detalle = lesiones.map((l, i) => {
    exigir(l.porcentaje > 0 && l.porcentaje <= 100, `Lesión ${i + 1}: porcentaje inválido.`);
    const ajusteManoHabil = l.miembroSuperiorHabil ? l.porcentaje * 0.05 : 0;
    return {
      descripcion: l.descripcion ?? '',
      porcentaje: l.porcentaje,
      ajusteManoHabil,
      valor: l.porcentaje + ajusteManoHabil,
    };
  });

  // Capacidad restante (Balthazard), de mayor a menor.
  let fisica = 0;
  for (const l of [...detalle].sort((a, b) => b.valor - a.valor)) {
    fisica += l.valor * (100 - fisica) / 100;
  }

  const capacidadRestante = (100 - preexistencia) / 100;
  const subtotal = fisica * capacidadRestante;
  const ponderacion = {
    actividad: subtotal * actividad,
    recalificacion: subtotal * recalificacion,
    edad: subtotal * edad,
  };
  const sinRedondear = Math.min(
    subtotal + ponderacion.actividad + ponderacion.recalificacion + ponderacion.edad,
    100,
  );

  const advertencias = [];

  return {
    porcentaje: redondear(sinRedondear, decimales),
    sinRedondear,
    subtotal,
    ponderacion,
    capacidadRestante: capacidadRestante * 100,
    detalle,
    advertencias,
  };
}

/* ------------------------------------------------------------------ */
/* Módulo B — Ingreso Base Mensual (art. 12.1 LRT, texto Ley 27.348)   */
/* ------------------------------------------------------------------ */

/**
 * Promedio mensual de las remuneraciones del año anterior a la PMI, actualizadas
 * mes a mes por RIPTE hasta la PMI.
 *
 * @param {object} p
 * @param {{mes:string, monto:number, sac?:boolean}[]} p.remuneraciones
 * @param {string} p.fechaPMI
 * @param {object} p.ripte
 * @param {'pmi'|'anterior'} [p.criterioMesPMI='pmi']  Mes de RIPTE usado como referencia de la PMI.
 * @param {boolean} [p.excluirSAC=false]
 * @param {number} [p.mesesDivisor]  Fuerza el divisor (por defecto: meses con sueldo, máx. 12).
 */
export function calcularIBM({
  remuneraciones,
  fechaPMI,
  ripte,
  criterioMesPMI = 'pmi',
  excluirSAC = false,
  mesesDivisor,
}) {
  exigir(['pmi', 'anterior'].includes(criterioMesPMI), `Criterio de mes de PMI inválido: ${criterioMesPMI}`);
  const mesPMI = mesDeFecha(fechaPMI);
  const desde = sumarMeses(mesPMI, -12);
  const hasta = sumarMeses(mesPMI, -1);
  const mesRefPMI = criterioMesPMI === 'anterior' ? sumarMeses(mesPMI, -1) : mesPMI;
  const ripteRefPMI = valorRipte(ripte, mesRefPMI);

  const advertencias = [];
  const detalle = [];
  for (const r of remuneraciones ?? []) {
    exigir(/^\d{4}-\d{2}$/.test(r.mes ?? ''), `Mes de remuneración inválido: ${r.mes}`);
    exigir(r.monto >= 0, `Monto inválido en ${r.mes}.`);
    if (r.mes < desde || r.mes > hasta) {
      advertencias.push(`Remuneración de ${r.mes} fuera del año previo a la PMI (${desde} a ${hasta}): excluida.`);
      continue;
    }
    if (r.sac && excluirSAC) {
      advertencias.push(`SAC de ${r.mes} excluido por configuración.`);
      continue;
    }
    const ripteMes = valorRipte(ripte, r.mes);
    const coeficiente = ripteRefPMI / ripteMes;
    detalle.push({
      mes: r.mes,
      monto: r.monto,
      sac: Boolean(r.sac),
      ripteMes,
      coeficiente,
      actualizado: r.monto * coeficiente,
    });
  }
  exigir(detalle.length > 0, 'No hay remuneraciones válidas en el año previo a la PMI.');

  const mesesConSueldo = new Set(detalle.filter((d) => !d.sac).map((d) => d.mes)).size;
  const divisor = mesesDivisor ?? mesesConSueldo;
  exigir(Number.isInteger(divisor) && divisor >= 1 && divisor <= 12, `Divisor inválido: ${divisor}`);
  if (divisor < 12) {
    advertencias.push(
      `Promedio sobre ${divisor} meses. Correcto solo si la relación laboral duró menos de un año; ` +
      'si faltan meses cargados, el IBM queda sobrestimado.',
    );
  }

  const suma = detalle.reduce((s, d) => s + d.actualizado, 0);
  return {
    ibm: suma / divisor,
    suma,
    divisor,
    mesRefPMI,
    ripteRefPMI,
    periodo: { desde, hasta },
    detalle,
    advertencias,
  };
}

/* ------------------------------------------------------------------ */
/* Módulos C + D — Prestación, piso, RIPTE e interés puro              */
/* ------------------------------------------------------------------ */

export function buscarVigenciaPiso(pisos, fecha) {
  if (!pisos?.vigencias) return null;
  const f = fmtFecha(parseFecha(fecha));
  return pisos.vigencias.find((v) => v.desde <= f && f <= v.hasta) ?? null;
}

/** Franja de incapacidad (art. 8 LRT: total desde el 66%). */
export function franjaIncapacidad(incapacidad) {
  if (incapacidad <= 50) return 'IPP_HASTA_50';
  if (incapacidad < 66) return 'IPP_50_66';
  return 'IPT';
}

/**
 * Franjas (reglas publicadas por la SRT; arts. 14.2.a, 14.2.b, 15.2 y 11.4 LRT; art. 3 Ley 26.773):
 *   - IPP ≤ 50%:         53 × IBM × % × 65/edad. Piso: monto art. 14.2 × %.
 *   - IPP > 50% y < 66%: ídem + compensación de pago único art. 11.4.a.
 *   - IPT ≥ 66%:         53 × IBM × 65/edad (sin %). Piso: monto art. 15.2 completo.
 *                        + compensación art. 11.4.b. Adicional 20% con mínimo del art. 3.
 *   Adicional 20% (IAPU): sobre (mayor entre fórmula y piso) + compensación. No in itinere.
 *
 * Actualización (sentencia de referencia, considerando V):
 *   D1. RIPTE desde la PMI hasta la liquidación (art. 12.2 LRT).
 *   D2. Interés puro 6% anual simple, PMI → liquidación.
 *
 * Supuestos (no surgen del fallo):
 *   - El piso se compara a valores de la PMI y el mayor recibe D1 y D2 (la SRT también
 *     actualiza el piso por RIPTE).
 *   - La compensación del art. 11.4 recibe D1 y D2 como el resto del capital. La planilla
 *     anterior la actualizaba por tasa activa.
 *   - El 6% se calcula sobre el capital actualizado (configurable).
 *   - Con incapacidad ya pagada (solo IPP), fórmula y piso se calculan sobre la diferencia.
 */
export function calcularPrestacion({
  ibm,
  mesRefPMI,
  incapacidad,
  incapacidadPagada = 0,
  fechaNacimiento,
  fechaPMI,
  fechaLiquidacion,
  ripte,
  pisos,
  inItinere = false,
  tasaPura = 0.06,
  baseInteresPuro = 'actualizado',
  mesRefLiquidacion,
  diasInclusivos = true,
}) {
  exigir(ibm > 0, 'El IBM debe ser mayor a cero.');
  exigir(incapacidad > 0 && incapacidad <= 100, 'La incapacidad debe ser mayor a 0 y hasta 100%.');
  exigir(incapacidadPagada >= 0 && incapacidadPagada < incapacidad,
    'La incapacidad pagada debe ser menor a la incapacidad total.');
  exigir(fechaNacimiento, 'Falta la fecha de nacimiento.');
  parseFecha(fechaPMI);
  parseFecha(fechaLiquidacion);
  exigir(fechaPMI >= REGIMEN_27348,
    `PMI anterior al ${REGIMEN_27348}: rige el art. 12 LRT previo a la Ley 27.348. Fuera de alcance.`);
  exigir(fechaLiquidacion >= fechaPMI, 'La fecha de liquidación no puede ser anterior a la PMI.');
  exigir(['actualizado', 'historico'].includes(baseInteresPuro), `Base de interés puro inválida: ${baseInteresPuro}`);

  const tramo = franjaIncapacidad(incapacidad);
  exigir(!(tramo === 'IPT' && incapacidadPagada > 0),
    'IPT con incapacidad previamente indemnizada: no soportado. Liquidar el total y descontar lo pagado por separado.');

  const advertencias = [];
  let incompleto = false;

  const edad = edadCumplida(fechaNacimiento, fechaPMI);
  exigir(edad >= 14 && edad <= 100, `Edad a la PMI implausible (${edad} años): revisar la fecha de nacimiento.`);
  const coefEdad = 65 / edad;

  const incLiquidable = incapacidad - incapacidadPagada;
  if (incapacidadPagada > 0) {
    advertencias.push(`Se liquida la diferencia de ${redondear(incLiquidable, 2)} puntos sobre lo ya pagado.`);
  }

  // C. Fórmula, piso y compensación del art. 11.4
  const vigencia = buscarVigenciaPiso(pisos, fechaPMI);
  const dato = (clave, concepto) => {
    const v = vigencia?.[clave];
    if (v == null) {
      incompleto = true;
      advertencias.push(`Falta el monto de ${concepto} vigente a la PMI (${vigencia ? vigencia.norma : 'sin vigencia cargada'}).`);
      return null;
    }
    return v;
  };

  let formula;
  let piso;
  let compensacion = 0;
  if (tramo === 'IPT') {
    formula = 53 * ibm * coefEdad;
    piso = dato('art15_2', 'piso art. 15.2');
    compensacion = dato('art11_4b', 'compensación art. 11.4.b') ?? 0;
  } else {
    formula = 53 * ibm * (incLiquidable / 100) * coefEdad;
    const montoPiso = dato('art14_2a', 'piso art. 14.2');
    piso = montoPiso == null ? null : montoPiso * (incLiquidable / 100);
    if (tramo === 'IPP_50_66') {
      if (incapacidadPagada > 50) {
        advertencias.push('La incapacidad pagada ya superaba el 50%: no se liquida de nuevo la compensación del art. 11.4.a.');
      } else {
        compensacion = dato('art11_4a', 'compensación art. 11.4.a') ?? 0;
      }
    }
  }

  const aplicaPiso = piso != null && piso > formula;
  const base = aplicaPiso ? piso : formula;

  let adicional20 = inItinere ? 0 : 0.2 * (base + compensacion);
  let aplicaMinimoArt3 = false;
  if (!inItinere && tramo === 'IPT') {
    const minimo = dato('art3_minimo', 'mínimo del adicional art. 3 Ley 26.773');
    if (minimo != null && minimo > adicional20) {
      adicional20 = minimo;
      aplicaMinimoArt3 = true;
    }
  }
  const capitalPMI = base + compensacion + adicional20;

  // D1. RIPTE PMI → liquidación
  const mesLiq = mesDeFecha(fechaLiquidacion);
  const refLiq = mesRefLiquidacion ?? ultimoMesRipte(ripte, mesLiq);
  const rezago = mesesEntre(refLiq, mesLiq);
  if (rezago > 3) {
    advertencias.push(`El último RIPTE disponible (${refLiq}) tiene ${rezago} meses de rezago respecto de la liquidación.`);
  }
  const coefRipte = valorRipte(ripte, refLiq) / valorRipte(ripte, mesRefPMI);
  const capitalActualizado = capitalPMI * coefRipte;

  // D2. Interés puro
  const dias = diasEntre(fechaPMI, fechaLiquidacion) + (diasInclusivos ? 1 : 0);
  const baseInteres = baseInteresPuro === 'historico' ? capitalPMI : capitalActualizado;
  const interesPuro = baseInteres * tasaPura * dias / 365;

  return {
    tramo,
    edad,
    coefEdad,
    incapacidadLiquidable: incLiquidable,
    formula,
    piso,
    normaPiso: vigencia?.norma ?? null,
    aplicaPiso,
    base,
    compensacion11_4: compensacion,
    adicional20,
    aplicaMinimoArt3,
    capitalPMI,
    ripte: { mesPMI: mesRefPMI, mesLiquidacion: refLiq, coeficiente: coefRipte },
    capitalActualizado,
    interesPuro: { tasa: tasaPura, dias, base: baseInteresPuro, monto: interesPuro },
    total: capitalActualizado + interesPuro,
    incompleto,
    advertencias,
  };
}

/* ------------------------------------------------------------------ */
/* Módulo D3 — Mora (art. 12.3 LRT + art. 770 CCyC)                    */
/* ------------------------------------------------------------------ */

/**
 * Tasa activa BNA con capitalización periódica desde la mora hasta el pago.
 *
 * @param {object} p
 * @param {number} p.capital
 * @param {string} p.fechaMora   Primer día de mora (vencido el plazo de pago).
 * @param {string} p.fechaPago
 * @param {{desde:string, hasta:string, tna:number}[]} p.tasas  Tramos con 'hasta' inclusive.
 * @param {number} [p.mesesCapitalizacion=6]  0 = interés simple, sin capitalización.
 * @param {number} [p.baseDias=365]
 * @param {boolean} [p.diasInclusivos=true]  Cuenta el día final, como la calculadora del
 *        Colegio de Abogados de Ushuaia (del 21/09 al 29/09 son 9 días).
 */
export function calcularMora({
  capital,
  fechaMora,
  fechaPago,
  tasas,
  mesesCapitalizacion = 6,
  baseDias = 365,
  diasInclusivos = true,
}) {
  exigir(capital >= 0, 'Capital de mora inválido.');
  parseFecha(fechaMora);
  parseFecha(fechaPago);
  const fechaFin = diasInclusivos ? sumarDias(fechaPago, 1) : fechaPago;
  if (fechaFin <= fechaMora) return { capital, interes: 0, total: capital, periodos: [], detalleTasas: [], advertencias: [] };

  exigir(Array.isArray(tasas) && tasas.length > 0, 'Faltan las tasas activas para el período de mora.');
  const tramos = tasas
    .map((t) => {
      exigir(t.tna >= 0 && t.tna <= 5, `TNA inválida (${t.tna}) en el tramo ${t.desde}.`);
      exigir(t.hasta >= t.desde, `Tramo con fechas invertidas: ${t.desde} a ${t.hasta}.`);
      return { desde: fmtFecha(parseFecha(t.desde)), hastaExcl: sumarDias(t.hasta, 1), tna: t.tna };
    })
    .sort((a, b) => (a.desde < b.desde ? -1 : 1));

  const fechasCapitalizacion = [];
  for (let k = 1; mesesCapitalizacion > 0; k++) {
    const d = sumarMesesFecha(fechaMora, k * mesesCapitalizacion);
    if (d >= fechaPago) break; // no se capitaliza el mismo día del pago
    fechasCapitalizacion.push(d);
  }

  const cortes = new Set([fechaMora, fechaFin, ...fechasCapitalizacion]);
  for (const t of tramos) {
    if (t.desde > fechaMora && t.desde < fechaFin) cortes.add(t.desde);
    if (t.hastaExcl > fechaMora && t.hastaExcl < fechaFin) cortes.add(t.hastaExcl);
  }
  const fechas = [...cortes].sort();

  let c = capital;
  let pendiente = 0;
  let inicio = fechaMora;
  const periodos = [];
  const detalleTasas = [];
  for (let i = 0; i < fechas.length - 1; i++) {
    const a = fechas[i];
    const b = fechas[i + 1];
    const tramo = tramos.find((t) => t.desde <= a && a < t.hastaExcl);
    exigir(tramo, `Falta la tasa activa para el período que comienza el ${a}.`);
    const dias = diasEntre(a, b);
    const interesTramo = c * tramo.tna * dias / baseDias;
    pendiente += interesTramo;
    detalleTasas.push({ desde: a, hasta: sumarDias(b, -1), dias, tasa: tramo.tna, capital: c, interes: interesTramo });

    const capitaliza = fechasCapitalizacion.includes(b);
    if (capitaliza || b === fechaFin) {
      periodos.push({ desde: inicio, hasta: capitaliza ? sumarDias(b, -1) : fechaPago, capitalBase: c, interes: pendiente, capitaliza });
      if (capitaliza) {
        c += pendiente;
        pendiente = 0;
      }
      inicio = b;
    }
  }

  const total = c + pendiente;
  return { capital, interes: total - capital, total, periodos, detalleTasas, advertencias: [] };
}

/* ------------------------------------------------------------------ */
/* Módulo E — Honorarios y art. 730 CCyCN                              */
/* ------------------------------------------------------------------ */

/**
 * @param {object} p
 * @param {number} p.base  Monto de la liquidación.
 * @param {{nombre:string, parte:'actora'|'demandada', porcentaje:number, recargoApoderado?:number}[]} p.letrados
 * @param {{nombre:string, monto:number}[]} [p.peritos]
 * @param {'actora'|'demandada'} [p.condenadaEnCostas='demandada']
 * @param {number} [p.tope730=0.25]
 *
 * Art. 730: la suma de honorarios de primera instancia a cargo del condenado en costas no
 * puede exceder el 25% del monto; no se computan los de los profesionales de la parte
 * condenada. Si se excede, se prorratea entre los beneficiarios computables.
 * Los intereses de honorarios fijos (criterio "Macías") se calculan con calcularInteresesHonorarios.
 */
export function calcularHonorarios({
  base,
  letrados = [],
  peritos = [],
  condenadaEnCostas = 'demandada',
  tope730 = 0.25,
}) {
  exigir(base > 0, 'La base regulatoria debe ser mayor a cero.');

  const regLetrados = letrados.map((l) => {
    exigir(l.porcentaje >= 0 && l.porcentaje <= 1, `Porcentaje inválido para ${l.nombre}.`);
    const alicuota = l.porcentaje * (1 + (l.recargoApoderado ?? 0));
    const monto = base * alicuota;
    return { ...l, alicuota, monto, computa730: l.parte !== condenadaEnCostas };
  });
  const regPeritos = peritos.map((p) => {
    exigir(p.monto >= 0, `Monto inválido para ${p.nombre}.`);
    return { ...p, computa730: true };
  });

  const computables = [...regLetrados, ...regPeritos].filter((x) => x.computa730);
  const sumaComputable = computables.reduce((s, x) => s + x.monto, 0);
  const tope = base * tope730;
  const excede = sumaComputable > tope;
  const factor = excede ? tope / sumaComputable : 1;

  const aplicar = (x) => ({ ...x, aCargoDelCondenado: x.computa730 ? x.monto * factor : x.monto });

  return {
    base,
    letrados: regLetrados.map(aplicar),
    peritos: regPeritos.map(aplicar),
    art730: { tope, sumaComputable, excede, factorProrrateo: factor },
  };
}

/**
 * Intereses sobre honorarios de monto fijo — criterio "Macías" (STJ TDF, "Macías, Daiana
 * Norali c/ Patagonia Logística S.A.", Expte. 2411/16, 19/06/2017): tasa que cobra el Banco
 * de Tierra del Fuego en descuento de documentos en pesos de 181 a 365 días. El fallo no
 * dispone capitalización: interés simple sobre la TNA.
 *
 * En la sentencia de referencia se aplica al perito "desde la fecha" de la sentencia. Para los letrados la
 * sentencia no fija intereses; se calculan solo si se pide expresamente.
 *
 * @param {object} honorarios  Resultado de calcularHonorarios.
 * @param {object} cfg
 * @param {string} cfg.desde   Fecha de regulación (cada honorario puede fijar `interesDesde`).
 * @param {string} cfg.hasta   Fecha de pago.
 * @param {{desde:string, hasta:string, tna:number}[]} cfg.tasas  TNA del BTF, tramos con 'hasta' inclusive.
 * @param {boolean} [cfg.incluirLetrados=false]
 */
export function calcularInteresesHonorarios(honorarios, { desde, hasta, tasas, incluirLetrados = false } = {}) {
  exigir(Array.isArray(tasas) && tasas.length > 0,
    'Faltan las tasas del Banco de Tierra del Fuego (descuento de documentos 181–365 días).');

  const calcular = (x) => {
    const inicio = x.interesDesde ?? desde;
    exigir(inicio && hasta, `Faltan las fechas de intereses para ${x.nombre}.`);
    const r = calcularMora({ capital: x.monto, fechaMora: inicio, fechaPago: hasta, tasas, mesesCapitalizacion: 0 });
    const factor = x.monto > 0 ? x.aCargoDelCondenado / x.monto : 1;
    return {
      nombre: x.nombre,
      desde: inicio,
      hasta,
      interes: r.interes,
      total: r.total,
      interesACargoDelCondenado: r.interes * factor,
      totalACargoDelCondenado: r.total * factor,
      detalleTasas: r.detalleTasas,
    };
  };

  return {
    criterio: 'Macías (STJ TDF, 19/06/2017): tasa BTF descuento de documentos 181–365 días, interés simple',
    peritos: honorarios.peritos.map(calcular),
    letrados: incluirLetrados ? honorarios.letrados.map(calcular) : [],
  };
}

/* ------------------------------------------------------------------ */
/* Módulo F — Series de tasas                                          */
/* ------------------------------------------------------------------ */

function ultimoDiaMes(mes) {
  const [y, m] = mes.split('-').map(Number);
  return fmtFecha(new Date(Date.UTC(y, m, 0)));
}

/** Parte el tramo que contiene `fecha` en dos: hasta `fecha` inclusive y desde el día siguiente. */
function partirEn(tramos, fecha) {
  const i = tramos.findIndex((t) => t.desde <= fecha && fecha < t.hasta);
  if (i < 0) return tramos;
  const t = tramos[i];
  return [...tramos.slice(0, i), { ...t, hasta: fecha }, { ...t, desde: sumarDias(fecha, 1) }, ...tramos.slice(i + 1)];
}

/** TNA vencida a 30 días → TEA equivalente. */
export function teaDesdeTna(tna) {
  return (1 + tna * 30 / 365) ** (365 / 30) - 1;
}

const pct = (x) => String(redondear(x * 100, 2)).replace('.', ',');

/**
 * Serie de tasa activa BNA → tramos de tasa anual.
 *   - `mensual`: historia en % de interés de cada mes; cada mes lleva su TNA equivalente
 *     (% del mes × 365 / días del mes), así que un mes completo devenga exactamente ese %.
 *   - `vigencias`: TNA publicada por el BNA con su fecha de vigencia (la carga el
 *     actualizador diario). Desde la primera vigencia reemplaza a la serie mensual.
 * Con criterio 'tea' la TNA se convierte a TEA y se aplica como tasa simple, como hace la
 * calculadora del Colegio de Abogados de Ushuaia (criterio STJ TDF, Expte. 2312/2010 SDO).
 * Pasada la fecha `actualizado` de la serie, la última tasa se extiende y se advierte.
 *
 * @param {{mensual:Object<string,number>, vigencias?:{desde:string, tna:number}[], vigente?:{tna:number}, actualizado?:string}} serie
 * @param {string} [hasta]
 * @param {{criterio?:'tna'|'tea'}} [opciones]
 */
export function tramosTasaActivaBNA(serie, hasta, { criterio = 'tna' } = {}) {
  exigir(serie?.mensual && Object.keys(serie.mensual).length > 0, 'Falta la serie de tasa activa BNA.');
  exigir(['tna', 'tea'].includes(criterio), `Criterio de tasa inválido: ${criterio}`);
  const anual = (tna) => (criterio === 'tea' ? teaDesdeTna(tna) : tna);
  const vig = [...(serie.vigencias ?? [])].sort((a, b) => (a.desde < b.desde ? -1 : 1));
  const corte = vig[0]?.desde;

  const tramos = [];
  for (const mes of Object.keys(serie.mensual).sort()) {
    const desde = `${mes}-01`;
    if (corte && desde >= corte) break;
    const finMes = ultimoDiaMes(mes);
    const dias = Number(finMes.slice(8));
    const fin = corte && finMes >= corte ? sumarDias(corte, -1) : finMes;
    tramos.push({ desde, hasta: fin, tna: anual((serie.mensual[mes] / 100) * 365 / dias) });
  }
  vig.forEach((v, i) => {
    const fin = i < vig.length - 1 ? sumarDias(vig[i + 1].desde, -1) : (hasta && hasta > v.desde ? hasta : v.desde);
    tramos.push({ desde: v.desde, hasta: fin, tna: anual(v.tna) });
  });

  const advertencias = [];
  if (criterio === 'tea') {
    advertencias.push(
      'Tasa activa BNA aplicada como TEA (criterio de la calculadora del Colegio). La sentencia de referencia habla de tasa nominal anual; con capitalización semestral, la TEA compone dos veces.',
    );
  }
  const ultimo = tramos[tramos.length - 1].hasta;
  if (!vig.length && hasta && hasta > ultimo) {
    exigir(serie.vigente?.tna > 0, 'No hay TNA vigente para proyectar la tasa activa.');
    const inicio = sumarDias(ultimo, 1);
    tramos.push({ desde: inicio, hasta, tna: anual(serie.vigente.tna) });
    advertencias.push(`Tasa activa BNA proyectada desde ${inicio} con la TNA vigente (${pct(serie.vigente.tna)}%): el resultado es una estimación.`);
  } else if (vig.length && hasta && serie.actualizado && hasta > serie.actualizado) {
    advertencias.push(
      `Tasa activa BNA: después del ${serie.actualizado} se aplica la última TNA publicada (${pct(vig.at(-1).tna)}%). El tramo posterior es una estimación.`,
    );
    return { tramos: partirEn(tramos, serie.actualizado), advertencias };
  }
  return { tramos, advertencias };
}

/**
 * Tasa del Banco de Tierra del Fuego para descuento de documentos → tramos de tasa anual,
 * calibrados contra la calculadora del Colegio de Abogados de Ushuaia (28/09/2026):
 *   - 'macias':  serie completa desde 2017 (46,80% desde el 09/02/2026).
 *                $1 M del 01/01/2017 al 28/09/2026 = $6.995.110,96 de interés.
 *   - 'cordero': 42,32% (TNA vencida, tramo 121–180 días); solo el dato vigente.
 * Cordero, además, capitaliza a la notificación de la demanda (art. 770 inc. b CCyC); esa
 * capitalización no se modela acá.
 *
 * @param {{macias:{desde:string, tasa:number}[], cordero:{desde:string, tasa:number}[]}} serie  data/tasa_btf.json
 * @param {object} opciones
 * @param {string} opciones.desde
 * @param {string} opciones.hasta
 * @param {'macias'|'cordero'} [opciones.variante='macias']
 * @param {boolean} [opciones.completarConVigente=false]  Cubre el período anterior al primer dato con esa tasa.
 */
export function tramosTasaBTF(serie, { desde, hasta, variante = 'macias', completarConVigente = false }) {
  exigir(['macias', 'cordero'].includes(variante), `Variante de tasa BTF inválida: ${variante}`);
  const vig = [...(serie?.[variante] ?? [])].sort((a, b) => (a.desde < b.desde ? -1 : 1));
  exigir(vig.length > 0, `Falta la serie de tasa BTF (${variante}).`);
  parseFecha(desde);
  parseFecha(hasta);

  const tramos = vig.map((v, i) => ({
    desde: v.desde,
    hasta: i < vig.length - 1 ? sumarDias(vig[i + 1].desde, -1) : (hasta > v.desde ? hasta : v.desde),
    tna: v.tasa,
  }));

  const advertencias = [];
  if (serie.actualizado && hasta > serie.actualizado) {
    advertencias.push(
      `Tasa BTF (${variante}): después del ${serie.actualizado} se aplica la última tasa publicada (${pct(vig.at(-1).tasa)}%). El tramo posterior es una estimación.`,
    );
  }
  if (desde < vig[0].desde && completarConVigente) {
    tramos.unshift({ desde, hasta: sumarDias(vig[0].desde, -1), tna: vig[0].tasa });
    advertencias.push(`No hay tasa BTF (${variante}) anterior al ${vig[0].desde}: se aplicó la primera conocida desde ${desde}. Es una estimación.`);
  }
  return { tramos: serie.actualizado && hasta > serie.actualizado ? partirEn(tramos, serie.actualizado) : tramos, advertencias };
}

/* ------------------------------------------------------------------ */
/* Orquestador                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {object} caso
 * @param {number|object} caso.incapacidad  Porcentaje o parámetros de calcularIncapacidad.
 * @param {object} caso.mora  { fechaMora, fechaPago, tasas? } — sin `tasas`, usa la serie BNA.
 * @param {object} caso.honorarios  Regulación; `intereses` { desde, hasta, tasas?, variante?, completarConVigente? }
 *        — sin `tasas`, usa la serie BTF (Macías).
 * @param {object} datos  { ripte, pisos, tasaActivaBNA?, tasaBTF? }
 */
export function liquidar(caso, { ripte, pisos, tasaActivaBNA, tasaBTF }) {
  const incapacidad =
    typeof caso.incapacidad === 'number'
      ? { porcentaje: caso.incapacidad, advertencias: [] }
      : calcularIncapacidad(caso.incapacidad);

  const ibm = calcularIBM({
    remuneraciones: caso.remuneraciones,
    fechaPMI: caso.fechaPMI,
    ripte,
    criterioMesPMI: caso.opciones?.criterioMesPMI,
    excluirSAC: caso.opciones?.excluirSAC,
    mesesDivisor: caso.opciones?.mesesDivisor,
  });

  const prestacion = calcularPrestacion({
    ibm: ibm.ibm,
    mesRefPMI: ibm.mesRefPMI,
    incapacidad: incapacidad.porcentaje,
    incapacidadPagada: caso.incapacidadPagada,
    fechaNacimiento: caso.fechaNacimiento,
    fechaPMI: caso.fechaPMI,
    fechaLiquidacion: caso.fechaLiquidacion,
    ripte,
    pisos,
    inItinere: caso.inItinere,
    tasaPura: caso.opciones?.tasaPura,
    baseInteresPuro: caso.opciones?.baseInteresPuro,
    diasInclusivos: caso.opciones?.diasInclusivos,
  });

  const advertenciasTasas = [];

  let mora = null;
  if (caso.mora) {
    let tasas = caso.mora.tasas;
    if (!tasas) {
      const t = tramosTasaActivaBNA(tasaActivaBNA, caso.mora.fechaPago, { criterio: caso.mora.criterioTasa });
      tasas = t.tramos;
      advertenciasTasas.push(...t.advertencias);
    }
    const { criterioTasa, ...cfgMora } = caso.mora;
    mora = calcularMora({ capital: prestacion.total, ...cfgMora, tasas });
  }

  let honorarios = null;
  let interesesHonorarios = null;
  if (caso.honorarios) {
    const { intereses, ...regulacion } = caso.honorarios;
    honorarios = calcularHonorarios({ base: prestacion.total, ...regulacion });
    if (intereses) {
      let tasas = intereses.tasas;
      if (!tasas) {
        const inicios = [intereses.desde, ...honorarios.peritos.map((p) => p.interesDesde)].filter(Boolean).sort();
        const t = tramosTasaBTF(tasaBTF, {
          desde: inicios[0],
          hasta: intereses.hasta,
          variante: intereses.variante,
          completarConVigente: intereses.completarConVigente,
        });
        tasas = t.tramos;
        advertenciasTasas.push(...t.advertencias);
      }
      interesesHonorarios = calcularInteresesHonorarios(honorarios, { ...intereses, tasas });
    }
  }

  // Comparación con las liquidaciones presentadas por las partes, a la fecha de liquidación.
  const comparacion = caso.liquidacionesPartes
    ? Object.fromEntries(
        Object.entries(caso.liquidacionesPartes)
          .filter(([, monto]) => monto > 0)
          .map(([parte, monto]) => [parte, {
            monto,
            diferencia: prestacion.total - monto,
            variacion: prestacion.total / monto - 1,
          }]),
      )
    : null;

  return {
    version: VERSION,
    incompleto: prestacion.incompleto,
    incapacidad,
    ibm,
    prestacion,
    mora,
    honorarios,
    interesesHonorarios,
    comparacion,
    advertencias: [
      ...incapacidad.advertencias,
      ...ibm.advertencias,
      ...prestacion.advertencias,
      ...(mora?.advertencias ?? []),
      ...advertenciasTasas,
    ],
  };
}
