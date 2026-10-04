# SOLUCIÓN — Reto 03: Agente conversacional de Órdenes de Compra SAP

> Candidata: Kelly López · Equipo Perxia 2.0 · Periferia IT Group
> Stack: TypeScript + Bun · Modelo: Anthropic Claude Haiku 4.5

---

## 1. Problema en una frase

La analista administrativa digita a mano cada orden de compra en SAP a partir de
un correo con tres piezas (solicitud, cotización y aprobación); es repetitivo,
propenso a error y sin control sistemático de quién puede aprobar qué.
**A quién le duele:** a la analista (tiempo), a contabilidad (errores que se
corrigen en cierre) y a la dirección (no sabe qué porcentaje de OC son retroactivas).

---

## 2. Arquitectura

```
┌──────────────┐   HTTP    ┌───────────────────────────────────────────┐
│ Front de chat│ ────────▶ │ Backend (Bun)                              │
│ web/index.html         │  src/server.ts                             │
│ - historial  │ ◀──────── │  - ciclo del agente (src/agent.ts)         │
│ - tool calls │           │  - adaptador LLM (src/llm/)                │
│ - confirmar  │           │  - herramientas tipadas (src/tools/oc.ts)  │
└──────────────┘           │  - adaptador SAP (src/sap/)                │
                           └─────────┬───────────────────────┬──────────┘
                                     │                       │
                            fixtures/ (solo lectura)      out/ (escritura)
```

Separación deliberada (lo que evalúa Periferia):
- **Comportamiento** → `agent/prompt.md` (system prompt, fuera del código).
- **Conocimiento** del proceso → `src/knowledge/ordenes-compra.md`.
- **Ejecución** → `src/tools/oc.ts` (única fuente de valores que el agente afirma).

El servidor compone el system prompt uniendo comportamiento + conocimiento en
tiempo de arranque (`cargarSystemPrompt`). Un cambio de regla de negocio se hace
en Markdown, sin tocar el servidor.

---

## 3. Ciclo del agente

Implementado en `src/agent.ts` (`correrTurno`). Por cada mensaje del usuario:

1. Se envían al modelo el system prompt, el historial y los esquemas de las
   herramientas (convertidos de zod a JSON Schema con `zod-to-json-schema`).
2. Si el modelo responde con `tool_use`, el backend **valida los argumentos con
   zod**, ejecuta la herramienta y devuelve el resultado como `tool_result`.
   Vuelve al paso 1.
3. Si el modelo responde solo texto, termina el turno.

- **Tope de iteraciones (CA1):** `MAX_ITERACIONES` (25 por defecto). Al alcanzarlo,
  el agente responde con lo que logró y lo pendiente.
- **Tope de tokens por sesión (control de costo):** `MAX_TOKENS_SESION`. Un
  usuario no puede gastar la clave sin límite.
- **Confirmación humana (CA3):** cuando una herramienta devuelve "requiere
  confirmación", el flag `needsConfirmation` se enciende; el prompt obliga al
  agente a cerrar el turno con una pregunta y a **no** llamar `oc_crear` sin que
  el usuario confirme en el siguiente mensaje. El front resalta ese estado.
- **Trazabilidad (CA4):** toda llamada queda en el historial visible del chat y
  en `out/log.jsonl`.
- **Robustez (CA5):** las herramientas nunca lanzan; devuelven `{ ok, data }` o
  `{ ok:false, error }`. Un error del modelo se reporta en lenguaje claro y la
  sesión sobrevive.

---

## 4. Elección del modelo

- **Proveedor:** Anthropic. **Modelo:** Claude **Haiku 4.5**
  (`claude-haiku-4-5-20251001`).
- **Por qué:** es el modelo más económico y rápido de la familia, con soporte
  nativo de *tool calling*, que es justo lo que este agente necesita. La lógica
  de negocio vive en las herramientas (deterministas), no en el modelo, así que
  no se requiere un modelo grande: el modelo solo orquesta y redacta.
- **Costo estimado por caso:** cada caso consume aproximadamente 2.000–5.000
  tokens de entrada (prompt + conocimiento + resultados de herramientas) y unos
  cientos de salida. Con las tarifas de Haiku 4.5 esto equivale a **fracciones de
  centavo de dólar por caso** (orden de magnitud: USD 0,002–0,01). Las tarifas
  exactas se confirman en la consola de Anthropic.
- **Portabilidad:** gracias al adaptador LLM (`src/llm/adapter.ts`), cambiar a
  OpenAI u otro proveedor es escribir una implementación nueva, sin tocar el ciclo.

---

## 5. Matriz de controles (RC1–RC10)

Todas se implementan en `validarPaquete` (`src/tools/oc.ts`), que devuelve
`{ apta, bloqueos[], confirmaciones[], derivados, retroactiva }`.

| Regla | Tipo | Cómo se implementó |
|---|---|---|
| RC1 | Bloqueo | Busca el proveedor por NIT (solo dígitos); si no hay NIT, por nombre normalizado. Exige `activo = true`. |
| RC2 | Bloqueo | La aprobación debe existir, contener "aprobado" y su remitente debe estar en los aprobadores del centro de costo. |
| RC3 | Bloqueo | `valor_total` ≤ `tope` del aprobador identificado. |
| RC4 | Bloqueo | `subarea` debe estar en `centro.subareas`. |
| RC5 | Confirmación | `|cotización − solicitud| / solicitud` > 2 % o sin cotización. |
| RC6 | Confirmación + derivado | Si falta `indicador_iva`, se deriva del proveedor y se confirma. |
| RC7 | Derivado | Si faltan `condiciones_pago`, se derivan del proveedor (solo informa). |
| RC8 | Confirmación | Factura con fecha anterior a la solicitud → `retroactiva = true`. |
| RC9 | Confirmación | Fecha de aprobación anterior a la fecha de solicitud. |
| RC10 | Bloqueo | `cantidad × valor_unitario` = `valor_total` (± 1). |

**La más difícil fue RC1 (y la normalización asociada).** Los NIT llegan escritos
de tres formas distintas (en la solicitud `901222333`, en la cotización
`901.222.333-1` con puntos y dígito de verificación, y en algunos casos sin NIT,
solo nombre). Resolverlo exigió normalizar a "solo dígitos" para el NIT y una
normalización de texto (sin tildes, sin puntos, minúsculas) para el nombre, de
modo que `sol-006` —que no trae NIT— igual encuentre a "TecnoSuministros S.A.S.".

---

## 6. Diseño del adaptador SAP real (documentación)

La interfaz `SapAdapter` (`src/sap/adapter.ts`) hoy la cumple un mock de archivos.
Para producción:

- **Opción de integración:** usaría la **API OData `API_PURCHASEORDER_PROCESS_SRV`**
  de SAP S/4HANA. Frente a RFC/BAPI `BAPI_PO_CREATE1`, OData es REST, más fácil de
  autenticar y versionar, y no requiere conectividad RFC ni librerías propietarias.
  Si la viabilidad no se confirma, el **Plan B** (ver abajo) mantiene el ahorro.
- **Mapeo:** `OrdenCompra` → cabecera OData (`PurchaseOrder`: `CompanyCode` 1000,
  `PurchasingOrganization`, `Supplier` = código SAP, `PaymentTerms`) +
  `to_PurchaseOrderItem` por cada posición (`Material`/texto breve 40 chars,
  `OrderQuantity`, `NetPriceAmount`, `CostCenter`, `TaxCode`).
- **Autenticación y credenciales:** OAuth 2.0 (client credentials) contra el
  tenant SAP; las credenciales viven en un gestor de secretos (Azure Key Vault o
  similar), **nunca** en el agente, el prompt ni los logs.
- **Idempotencia:** antes de crear se consulta `buscarOrdenPorReferencia` por
  `solicitud_id` (un campo de referencia/`YourReference` en SAP). Si existe, se
  devuelve esa OC. Si SAP responde con error parcial, no se reintenta a ciegas:
  se consulta el estado real antes de decidir.
- **Plan B (si la conexión no es viable):** el agente genera la OC lista para
  pegar en SAP GUI y/o un archivo de carga masiva (CSV/LSMW), de modo que la
  analista deja de digitar campo por campo aunque no haya integración directa.

---

## 7. Lectura del proceso: OC retroactivas

El hallazgo clave del proceso actual es que muchas OC se crean **después** de que
llega la factura, saltándose la cotización (como `sol-005`). El agente ya lo
**mide**: marca `retroactiva = true` y lo registra en `out/control.csv`, de modo
que la dirección puede por fin responder "¿qué porcentaje de nuestras OC son
retroactivas?".

Lo que le diría a la dirección: una OC retroactiva no es solo un tema de orden;
es una **pérdida de control de gasto**, porque el compromiso se registra cuando
ya no se puede negociar ni frenar. Propondría: (1) mantener la marca y un tablero
mensual de % de OC retroactivas por área, (2) fijar un umbral tolerado (p. ej.
< 10 %) y (3) un cambio de proceso: que la solicitud y la aprobación sean
requisito para **radicar** la factura, no al revés. El agente no decide la
política —eso es de la dirección—, pero le entrega el dato para decidir.

---

## 8. Decisiones y trade-offs

1. **La lógica de negocio vive en las herramientas, no en el modelo.**
   Alternativa descartada: dejar que el modelo "lea" los fixtures e infiera las
   reglas. La descarté porque abre la puerta a alucinaciones (el modelo
   "cuadrando" un monto). Trade-off: más código determinista, pero cero
   invención de valores.
2. **Adaptador LLM propio en vez de usar el SDK del proveedor directo.**
   Alternativa descartada: llamar al SDK de Anthropic dentro del ciclo. La
   descarté porque acopla el ciclo a un proveedor. Trade-off: un poco más de
   código (una interfaz), a cambio de poder cambiar de proveedor sin tocar el ciclo.
3. **Evidencia P0 en texto + sha256 en vez de PDF.**
   Alternativa descartada: generar PDF desde el inicio. La descarté porque añade
   una dependencia binaria que puede fallar en el despliegue. Trade-off: menos
   "vistoso", pero determinista y robusto. El PDF queda como mejora P1.
4. **Bun en vez de Node + ts-node.**
   Alternativa descartada: Node con transpilador. Bun ejecuta TypeScript directo
   y trae instalador, cumpliendo el arranque en < 2 minutos con menos piezas.

---

## 9. Supuestos

- Los maestros de los fixtures son completos (en producción se consultarían en SAP en tiempo real).
- El correo de aprobación es evidencia suficiente (auditoría podría exigir firma digital).
- Montos en COP sin decimales; las comparaciones usan tolerancia de ± 1 unidad monetaria.
- La identidad del aprobador se valida por correo electrónico (no por firma).
- Un caso = una posición de OC (los fixtures traen un ítem por solicitud).

---

## 10. Cobertura (historias de usuario)

| HU | Descripción | Estado | Qué falta para producción |
|---|---|---|---|
| HU-1 | Leer el paquete | ✅ Hecho | Lectura de `.xlsx`/`.pdf` binarios reales (hoy vienen normalizados). |
| HU-2 | Validar (RC1–RC10) | ✅ Hecho | Consultar maestros en SAP en vivo en vez de archivos. |
| HU-3 | Construir payload + trazabilidad | ✅ Hecho | Mapeo completo a la estructura OData real. |
| HU-4 | Evidencia de aprobación | ✅ Hecho (txt + sha256) | PDF (P1) con `pdf-lib`. |
| HU-5 | Crear OC + idempotencia + control | ✅ Hecho | Conexión real a SAP (hoy mock de archivos). |
| HU-6 | Manejo de errores | ✅ Hecho | — |

---

## 11. Uso de IA

- **Asistente usado:** Claude (Anthropic), como par de programación, siguiendo la
  **estructura del método BMAD** (arquitectura → historias técnicas → desarrollo
  iterativo con pruebas sobre los fixtures). No usé el *toolchain* de BMAD sino su
  disciplina documental, para mantener el control del código que debo defender.
- **Para qué lo usé:** redactar el documento de arquitectura, escribir las
  herramientas y el ciclo del agente, y generar `demo.ts` para verificación
  determinista.
- **Qué acepté:** la separación comportamiento/conocimiento/ejecución, el patrón
  adaptador para LLM y SAP, y la idea de que las herramientas sean la única fuente
  de verdad.
- **Qué descarté de lo que me propuso:** (1) usar el SDK del proveedor dentro del
  ciclo —preferí la interfaz propia—; (2) generar PDF como P0 —lo bajé a P1 por
  robustez—; (3) una dependencia extra para introspección de esquemas más allá de
  `zod-to-json-schema`.
- Entiendo y puedo explicar cada línea entregada.

---

## 12. Riesgos para producción y mitigación

| Riesgo | Mitigación |
|---|---|
| El modelo "arregla" un monto para que cuadre. | Los montos salen de las herramientas; el modelo no puede alterar el payload validado con zod. |
| La conexión a SAP no es viable a corto plazo. | Plan B: OC lista para pegar o carga masiva (sección 6). |
| Fuga de la clave del modelo. | Solo en variable de entorno del backend; nunca en front, repo, logs ni respuestas. `/api/health` no la expone. |
| Falsos negativos de proveedor por nombre mal escrito. | Normalización (dígitos para NIT, texto sin tildes para nombre); en producción, dedupe por NIT antes que por nombre. |
| Gasto descontrolado de la clave. | Topes de iteraciones y de tokens por sesión configurables. |
| Evidencia insuficiente para auditoría. | Hoy txt + sha256; en producción, firma digital y almacenamiento inmutable. |
