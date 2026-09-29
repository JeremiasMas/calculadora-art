# Calculadora ART — Tierra del Fuego

Motor de cálculo de prestaciones dinerarias por incapacidad laboral permanente definitiva
(Ley 24.557, Ley 26.773) con la metodología del Superior Tribunal de Justicia de Tierra del
Fuego ("Zamboni", 09/04/2024; "Quipildor", 18/09/2024; art. 37 Ley Prov. 110), tal como la
aplica "V., M. E. c/ Provincia ART S.A." (Juzg. Trabajo N° 2 DJN, 16/06/2026).

Calculadora en línea: **https://jeremiasmas.github.io/calculadora-art/**

La página (`index.html` + `app.js`) corre entera en el navegador: carga el motor y las series
de `data/`, calcula en vivo y no envía datos a ningún servidor.

## Qué calcula

| Módulo | Contenido |
|---|---|
| A. Incapacidad | Baremo Dto. 659/96: capacidad restante, mano hábil, preexistencia y factores de ponderación sobre el subtotal. |
| B. IBM | Promedio mensual de las remuneraciones del año previo a la PMI, actualizadas por RIPTE (art. 12.1 LRT, texto Ley 27.348). |
| C. Prestación | IPP ≤ 50% (art. 14.2.a), IPP 50–66% (art. 14.2.b + compensación art. 11.4.a) e IPT ≥ 66% (art. 15.2 + art. 11.4.b). Pisos SRT y adicional del 20% del art. 3 Ley 26.773. |
| D. Actualización | RIPTE desde la PMI hasta la liquidación, más interés puro del 6% anual. |
| D3. Mora | Tasa activa BNA con capitalización semestral (art. 12.3 LRT, art. 770 CCyC). |
| E. Honorarios | Porcentajes con recargo de apoderado, tope del art. 730 CCyCN con prorrateo e intereses de honorarios fijos (criterio "Macías"). |

Alcance: PMI desde el 05/03/2017. No cubre muerte, gran invalidez ni incapacidades provisorias.

## Uso

```bash
npm test                   # 66 tests (node:test, sin dependencias)
node ejemplo.js            # caso de la sentencia de referencia, con datos sintéticos donde no informa
```

```js
import { liquidar } from './engine.js';
const r = liquidar(caso, { ripte, pisos, tasaActivaBNA, tasaBTF });
```

## Datos (`data/`)

| Archivo | Cobertura | Fuente |
|---|---|---|
| `ripte.json` | 01/2015–07/2026 | datos.gob.ar (serie 158.1_REPTE_0_0_5) |
| `pisos.json` | 26/10/2012–28/02/2027 | Resoluciones y notas SRT; desde 03/2024, Boletín Oficial |
| `tasa_activa_bna.json` | 01/2017–09/2026 + TNA vigente | Poder Judicial de Neuquén, contrastada con avisos BNA |
| `tasa_btf.json` | Macías 01/2017–hoy; Cordero solo vigente | Calculadora del Colegio Público de Abogados de Ushuaia |

### Actualización automática

Un workflow diario (`.github/workflows/actualizar-datos.yml`, 09:17 hora argentina) corre
`scripts/actualizar-datos.mjs`:

| Serie | Fuente | Control |
|---|---|---|
| Tasa activa BNA | Web del BNA (tasa activa cartera general) | La TNA y la TEA publicadas deben ser consistentes entre sí |
| Tasa BTF (Macías y Cordero) | PDF de tasas activas de Banca Empresas | Una sola fila por tramo; en 181–365 días la TNA vencida debe igualar a la TEA |
| RIPTE | API de series de datos.gob.ar | Variación mensual entre −20% y +40% |
| Pisos SRT | Carga manual | Abre un issue 30 días antes del vencimiento |

Si una fuente cambia de formato o no responde, el workflow falla (GitHub avisa por mail) y
abre un issue con el texto leído. Mientras tanto, la calculadora usa la última tasa cargada
y marca como estimados los períodos posteriores a la última actualización.

## Convenciones

- Días inclusivos (como la calculadora del Colegio): del 21/09 al 29/09 son 9 días.
- Interés simple, base 365, salvo la capitalización semestral de la mora.
- Macías: 46,80% vigente (tasa BTF descuento de documentos 181–365 días).

## Decisiones abiertas

- Mora: tasa BNA como TNA (texto de la sentencia, por defecto) o como TEA (calculadora del
  Colegio, criterio STJ Expte. 2312/2010). Con capitalización semestral, la TEA compone dos veces.
- Cordero: falta la serie histórica y la capitalización a la notificación de la demanda.

## Licencia

MIT. Ver `LICENSE`.

## Aviso

Herramienta orientativa. No es asesoramiento jurídico ni reemplaza la liquidación aprobada en
el expediente.
