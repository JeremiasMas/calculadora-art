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
  const html = `
    <h3>Tasa Activa Cartera General Diversas vigente desde el 28/9/2026</h3>
    <table><tr><td>Tasa Nominal Anual Vencida a 30 días</td><td>26,40%</td></tr>
    <tr><td>Tasa Efectiva Anual Vencida</td><td>29,83%</td></tr></table>`;

  test('lee TNA, TEA y fecha de vigencia', () => {
    assert.deepEqual(parsearBNA(html), { desde: '2026-09-28', tna: 0.264, tea: 0.2983 });
  });

  test('rechaza TNA y TEA inconsistentes', () => {
    assert.throws(() => parsearBNA(html.replace('29,83%', '45,00%')), /inconsistentes/);
  });

  test('la TEA del BNA coincide con la conversión de la TNA a 30 días', () => {
    assert.ok(Math.abs(teaDesdeTna(0.264) - 0.2983) < 0.005);
  });

  test('falla si no hay bloque de cartera general', () => {
    assert.throws(() => parsearBNA('<p>Plazo fijo 20%</p>'), /cartera general/);
  });
});

describe('BTF', () => {
  const pagina = `<a href="/wp-content/uploads/2026/09/c3939-tasas-activas-consumo-20260918.pdf">Consumo</a>
    <a href="https://www.btf.com.ar/wp-content/uploads/2026/09/c3939-tasas-activas-comercial-20260918.pdf">Empresas</a>`;
  const pdf = `
                         LÍNEAS DE CRÉDITO COMERCIAL
                              Vigente a partir del 21/09/2026
      Plazo (en días)             T.N.A.A.    T.N.A.V.    T.E.A.V.
      Desde   Hasta
        1      30        -        37,78%      39,01%      46,80%
       31      60        -        37,19%      39,64%      46,80%
      121     180        -        34,93%      42,32%      46,80%
      181     365        -        31,88%      46,80%      46,80%
  `;

  test('encuentra el PDF de Banca Empresas', () => {
    assert.equal(buscarPdfBTF(pagina), 'https://www.btf.com.ar/wp-content/uploads/2026/09/c3939-tasas-activas-comercial-20260918.pdf');
  });

  test('lee Macías (TEA 181–365) y Cordero (TNA vencida 121–180)', () => {
    assert.deepEqual(parsearBTF(pdf), { desde: '2026-09-21', macias: 0.468, cordero: 0.4232 });
  });

  test('falla si la fila 181–365 aparece dos veces', () => {
    assert.throws(() => parsearBTF(`${pdf}\n  181  365  -  30,00%  44,00%  44,00%`), /hay 2/);
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
