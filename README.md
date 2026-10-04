# Agente de Órdenes de Compra SAP — Reto 03 (Periferia IT Group)

Agente conversacional que lee un paquete de compra (correo, solicitud, cotización
y aprobación), lo valida contra los maestros (reglas RC1–RC10), construye la orden
de compra, genera la evidencia de aprobación y la crea en un SAP simulado. Las
excepciones no se fuerzan: se clasifican y se devuelven al humano con una
recomendación.

## Requisitos

- [Bun](https://bun.sh) 1.1+ (o Node 20+).
- Una clave de API de un proveedor LLM (por defecto, Anthropic).

## Puesta en marcha (un comando)

```bash
bun install
cp .env.example .env     # luego edita .env y pon tu clave
bun run dev
```

Abre **http://localhost:3000**.

### Variables de entorno (`.env`)

| Variable | Descripción |
|---|---|
| `LLM_PROVIDER` | `anthropic` (por defecto). |
| `LLM_MODEL` | `claude-haiku-4-5-20251001` (económico). |
| `ANTHROPIC_API_KEY` | Tu clave. **Nunca** se sube al repo (está en `.gitignore`). |
| `MAX_ITERACIONES` | Tope de vueltas herramienta→modelo por turno (25). |
| `MAX_TOKENS_SESION` | Tope de tokens por sesión (control de costo). |
| `PORT` | Puerto del servidor (3000). |

## Verificación sin modelo (determinista)

```bash
bun run demo.ts
```

Procesa los 6 casos llamando directamente a las herramientas (sin gastar clave),
muestra la idempotencia de `sol-001` y las confirmaciones de `sol-004/005/006`.
Limpia `out/` al inicio para ser reproducible.

## Prueba en el chat

```
Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué
validaciones pasó y cuáles no, y no la crees hasta que yo confirme.
```

Casos disponibles: `sol-001` (normal) · `sol-002` (proveedor inexistente) ·
`sol-003` (aprobador sin autoridad) · `sol-004` (cotización ≠ solicitud) ·
`sol-005` (retroactiva) · `sol-006` (IVA no informado).

## API

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/health` | `{ ok, provider, model }` — no expone la clave. |
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls, needsConfirmation }`. |
| `GET` | `/api/sessions/:id` | Historial de la sesión. |

## Estructura

```
agent/prompt.md              comportamiento del agente (system prompt)
src/knowledge/               conocimiento del proceso
src/tools/oc.ts              herramientas + reglas RC1–RC10
src/sap/                     adaptador SAP (interfaz + mock)
src/llm/                     adaptador LLM (interfaz + Anthropic)
src/agent.ts                 ciclo del agente
src/server.ts                API HTTP + servidor del front
web/index.html               front de chat
demo.ts                      verificación sin modelo
modulo/                      bonus: agente empaquetado reutilizable
docs/ARQUITECTURA.md         documento de arquitectura (método BMAD)
SOLUCION.md                  planteamiento de la solución (12 secciones)
```

## Despliegue

El agente corre con un solo proceso Bun. Para el link público: Render / Railway /
Fly.io con `bun run dev` como comando de arranque y la clave como variable de
entorno del servicio (nunca en el repo).
