import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  textoPlano,
  porcentaje,
  parsearBNA,
  buscarPdfBTF,
  parsearBTF,
  parsearRipteCSV,
  aplicarVigencia,
  validarTasa,
  teaDesdeTna,
} from '../scripts/actualizar-datos.mjs';

describe('Utilidades', () => {
  test('texto plano sin etiquetas ni entidades', () => {
    assert.equal(textoPlano('<p>Tasa&nbsp;Activa <b>Cartera</b> General</p><script>x()</script>'), 'Tasa Activa Cartera General');
  });

  test('porcentajes con coma o punto', () => {
    assert.equal(porcentaje('26,40'), 0.264);
    assert.equal(porcentaje('26.40'), 0.264);
    assert.equal(porcentaje('1.234,5'), 12.345);
  });
});

describe('BNA', () => {
  // Formato real leído por el workflow el 28/09/2026.
  const html = `<div>Tasas + - Tasa Activa Cartera General Diversas vigente desde el 29/9/2026
    <p>Tasa Efectiva Mensual Vencida = T.E.M. (30 días) = 2,219%</p>
    <p>Tasa Nominal Anual Vencida con capitalización cada 30 días = T.N.A. (30 días) = 27,00%</p>
    <p>Tasa Efectiva Anual Vencida = T.E.A. = 30,61%</p> Consulta de Tasas Vigentes DEPÓSITOS A PLAZO FIJO
    De 30 a 59 15,50 % 16,65 %</div>`;

  test('lee TNA, TEA y fecha de vigencia por sus etiquetas', () => {
    assert.deepEqual(parsearBNA(html), { desde: '2026-09-29', tna: 0.27, tea: 0.3061 });
  });

  test('rechaza TNA y TEA inconsistentes', () => {
    assert.throws(() => parsearBNA(html.replace('30,61%', '45,00%')), /inconsistentes/);
  });

  test('rechaza TEM inconsistente', () => {
    assert.throws(() => parsearBNA(html.replace('2,219%', '3,000%')), /T\.E\.M\./);
  });

  test('la TEA del BNA coincide con la conversión de la TNA a 30 días', () => {
    assert.ok(Math.abs(teaDesdeTna(0.264) - 0.2983) < 0.005);
  });

  test('falla si no hay bloque de cartera general', () => {
    assert.throws(() => parsearBNA('<p>Plazo fijo 20%</p>'), /Cartera General/);
  });
});

describe('BTF', () => {
  const pagina = `<a href="/wp-content/uploads/2026/09/c3939-tasas-activas-consumo-20260918.pdf">Consumo</a>
    <a href="https://www.btf.com.ar/wp-content/uploads/2026/09/c3939-tasas-activas-comercial-20260918.pdf">Empresas</a>`;
  // Extracto real del PDF del 21/09/2026 (pdftotext -layout).
  const pdf = `
                          TASAS DE INTERÉS PARA OPERACIONES ACTIVAS BANCA EMPRESAS
   Vigente a partir del
                                                                          LÍNEAS DE CRÉDITO COMERCIAL
       21/09/2026
NEGOCIACIÓN DE VALORES                                                                                  T.N.A.A.   T.N.A.V.   T.E.A.V.
                                                                CHEQUES FÍSICOS
                                                                     1        30                    -                37,78%     39,01%     46,80%
                                                                    31        60                    -                37,19%     39,64%     46,80%
HASTA 180 DÍAS (6)                                                  61        90                    -                36,61%     40,29%     46,80% FIJA ADELANTADA
                                                                    91       120                    -                36,04%     40,95%     46,80%
                                                                    121      180                    -                34,93%     42,32%     46,80%
                                                                CHEQUES ELECTRÓNICOS
                                                                     1        30                    -                36,12%     37,24%     44,30%
                                                                    121      180                    -                33,51%     40,25%     44,30%
                                                               OPERACIONES DE FACTORING
                                                                    121      180                    -                34,93%     42,32%     46,80%
                                                                    181      365                    -                31,88%     46,80%     46,80%
`;

  test('encuentra el PDF de Banca Empresas', () => {
    assert.equal(buscarPdfBTF(pagina), 'https://www.btf.com.ar/wp-content/uploads/2026/09/c3939-tasas-activas-comercial-20260918.pdf');
  });

  test('lee Macías (T.E.A.V.) y Cordero (T.N.A.V. 121–180) de cheques físicos', () => {
    assert.deepEqual(parsearBTF(pdf), { desde: '2026-09-21', macias: 0.468, cordero: 0.4232, seccion: 'CHEQUES FÍSICOS' });
  });

  test('prefiere la sección "Descuento de documentos" si existe', () => {
    const con = pdf.replace('NEGOCIACIÓN DE VALORES', `DESCUENTO DE DOCUMENTOS
      1   30   -   30,00%   31,00%   36,00%
     31   60   -   29,50%   31,20%   36,00%
    121  180   -   28,00%   33,02%   36,00%
NEGOCIACIÓN DE VALORES`);
    const r = parsearBTF(con);
    assert.equal(r.seccion, 'DESCUENTO DE DOCUMENTOS');
    assert.equal(r.macias, 0.36);
  });

  test('falla si la T.E.A.V. no es única en la sección', () => {
    assert.throws(() => parsearBTF(pdf.replace('39,64%     46,80%', '39,64%     47,50%')), /no es única/);
  });

  test('falla si la T.N.A.V. 121–180 no reproduce la T.E.A.V.', () => {
    assert.throws(() => parsearBTF(pdf.replace('42,32%     46,80%', '38,00%     46,80%')), /no reproduce/);
  });

  test('falla si no hay sección reconocible', () => {
    assert.throws(() => parsearBTF('Vigente a partir del 21/09/2026\nPRÉSTAMOS 1 30 - 10,00% 11,00% 12,00%'), /sección/);
  });
});

describe('RIPTE y vigencias', () => {
  test('CSV de la API de series', () => {
    const csv = ['indice_tiempo,ripte', ...Array.from({ length: 13 }, (_, i) => `2025-${String((i % 12) + 1).padStart(2, '0')}-01,${1000 + i}`)].join('\n');
    const v = parsearRipteCSV(csv);
    assert.equal(Object.keys(v).length, 12);
  });

  test('agrega vigencia solo si cambia el valor', () => {
    const base = [{ desde: '2026-09-21', tasa: 0.468 }];
    assert.equal(aplicarVigencia(base, '2026-10-05', 'tasa', 0.468).cambio, null);
    const r = aplicarVigencia(base, '2026-10-05', 'tasa', 0.45);
    assert.equal(r.lista.length, 2);
    assert.equal(aplicarVigencia(base, '2026-09-01', 'tasa', 0.4).cambio, null); // fecha anterior: se ignora
    assert.equal(aplicarVigencia(base, '2026-09-21', 'tasa', 0.47).lista.length, 1); // misma fecha: corrige
  });

  test('rango de tasas', () => {
    assert.throws(() => validarTasa('X', 0));
    assert.throws(() => validarTasa('X', 9));
    validarTasa('X', 0.3);
  });
});
