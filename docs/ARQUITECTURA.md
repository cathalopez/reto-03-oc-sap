# Documento de arquitectura — Reto 03: Agente de Órdenes de Compra SAP

> Método BMAD (versión corta): como el PRD ya viene dado, se omiten las fases
> de analista y PM. Este documento es el paso de **arquitecto**: fija las
> decisiones técnicas y las alternativas descartadas antes de escribir código.
> Alimenta directamente el `SOLUCION.md` final.

## 1. Problema en una frase

La analista administrativa digita a mano cada orden de compra en SAP a partir
de un correo con tres piezas (solicitud, cotización, aprobación); es repetitivo,
propenso a error y sin control sistemático de quién aprueba qué. El agente lee
el paquete, lo valida contra los maestros, construye la OC, genera la evidencia
y la crea en un SAP simulado — devolviendo al humano solo las excepciones.

## 2. Componentes (vista de alto nivel)

```
┌──────────────┐   HTTP    ┌───────────────────────────────────────────┐
│ Front de chat│ ────────▶ │ Backend (Bun)                              │
│ - historial  │ ◀──────── │ - ciclo del agente (prompt→modelo→tools)   │
│ - tool calls │           │ - adaptador LLM (interfaz propia)          │
│ - confirmar  │           │ - herramientas tipadas (zod)               │
└──────────────┘           │ - adaptador SAP (interfaz + mock)          │
                           └─────────┬───────────────────────┬──────────┘
                                     │                       │
                            fixtures/ (solo lectura)      out/ (escritura)
```

Separación que evalúa Periferia:
- **Comportamiento** → `agent/prompt.md` (system prompt, no embebido en código).
- **Conocimiento** del proceso → `src/knowledge/ordenes-compra.md`.
- **Ejecución** → `src/tools/oc.ts` (única fuente de valores que el agente afirma).

Un cambio de regla de negocio no debe tocar el servidor.

## 3. Decisiones y alternativas descartadas

| # | Decisión | Por qué | Alternativa descartada |
|---|---|---|---|
| D1 | **Bun** como runtime | Arranque < 2 min, ejecuta TypeScript sin transpilar, instalador incluido | Node + tsx/ts-node: más configuración, dos herramientas |
| D2 | **Las herramientas son la única fuente de verdad** (regla CA2) | El modelo no puede inventar un valor; todo sale de una tool validada | Dejar que el modelo "lea" los fixtures en el prompt: riesgo de alucinación |
| D3 | **Adaptador LLM propio** (patrón puerto/adaptador) | Cambiar de proveedor (Anthropic/OpenAI) no toca el ciclo del agente | SDK del proveedor acoplado al ciclo: difícil de cambiar y de testear |
| D4 | **zod** en los argumentos de cada herramienta | El backend valida antes de ejecutar y devuelve el error al modelo | Validación manual con if/else: verbosa y frágil |
| D5 | **SAP simulado con archivos** (`out/sap/ordenes.jsonl`) | Sin base de datos; idempotencia por `solicitud_id`; trazable | DB real: fuera de alcance del reto |
| D6 | **Evidencia P0 = .txt + sha256**; PDF como P1 | Determinista y sin dependencia binaria frágil | Solo PDF: más superficie de fallo en el link público |
| D7 | **Confirmación humana por corte de turno** (regla CA3) | El agente termina el turno con una pregunta; solo procede si el siguiente mensaje confirma | Auto-confirmar excepciones: viola la regla de oro del reto |
| D8 | **`demo.ts` sin modelo** | Prueba las herramientas de forma determinista, sin gastar clave | Probar solo vía chat: no determinista, cuesta tokens |

## 4. Reglas de control (RC1–RC10) — mapa de implementación

Se implementan todas en `oc_validar`, que devuelve
`{ apta, bloqueos[], confirmaciones[], derivados, retroactiva }`.

| Regla | Tipo | Resumen |
|---|---|---|
| RC1 | Bloqueo | Proveedor existe (por NIT; si no, por nombre normalizado) y está activo |
| RC2 | Bloqueo | Aprobación existe, dice "Aprobado" y viene de un aprobador del centro de costo |
| RC3 | Bloqueo | `valor_total` ≤ tope del aprobador |
| RC4 | Bloqueo | `subarea` pertenece al `centro_costo` |
| RC5 | Confirmación | |cotización − solicitud| / solicitud ≤ 2 %; si excede o no hay cotización, confirmar |
| RC6 | Confirmación + derivado | `indicador_iva` ausente → se deriva del proveedor y se confirma |
| RC7 | Derivado | `condiciones_pago` ausente → se deriva del proveedor (solo informa) |
| RC8 | Confirmación | Factura con fecha < fecha_solicitud → `retroactiva = true`, confirmar |
| RC9 | Confirmación | Fecha de aprobación ≥ fecha_solicitud; si no, confirmar |
| RC10 | Bloqueo | `cantidad × valor_unitario` = `valor_total` (± 1) |

## 5. Comportamiento esperado por caso (contrato de aceptación)

| Caso | Resultado | Regla que lo gobierna | Objetivo |
|---|---|---|---|
| sol-001 | OC creada sin intervención | Todo cumple | O1 |
| sol-002 | Bloqueo (proveedor inexistente) | RC1 | O2 |
| sol-003 | Bloqueo (aprobador sin autoridad en el centro) | RC2 | O2 |
| sol-004 | Confirmación (cotización 26.5M ≠ solicitud 25M, 6%) | RC5 | O3 |
| sol-005 | Confirmación + retroactiva=true (factura anterior) | RC8 | O4 |
| sol-006 | Confirmación (IVA ausente → C1) + derivado Z030 | RC6/RC7 | O3 |

## 6. Historias técnicas (ligadas a las HU del PRD)

| HT | Historia técnica | HU del PRD | Herramienta |
|---|---|---|---|
| HT-1 | Cargar maestros y normalizar el paquete de un caso | HU-1 | `oc_leer_paquete` |
| HT-2 | Implementar RC1–RC10 con bloqueos/confirmaciones/derivados | HU-2 | `oc_validar` |
| HT-3 | Construir el payload de la OC validado con zod + trazabilidad | HU-3 | `oc_construir_payload` |
| HT-4 | Generar evidencia de aprobación (txt + sha256) | HU-4 | `oc_generar_evidencia` |
| HT-5 | Crear la OC en el SAP mock con idempotencia y log de control | HU-5 | `oc_crear` |
| HT-6 | demo.ts determinista: 6 casos + idempotencia + confirmación | HU-6 | (todas) |
| HT-7 | Adaptador LLM + ciclo del agente con tope y confirmación | §6.3 | — |
| HT-8 | Front de chat (tool calls visibles + confirmación resaltada) | §6.1 | — |

## 7. Supuestos

- Los maestros de los fixtures son completos (en producción se consultan en SAP).
- El correo de aprobación es evidencia suficiente (auditoría podría exigir firma digital).
- Montos en COP sin decimales; comparaciones con tolerancia de ±1 unidad monetaria.
