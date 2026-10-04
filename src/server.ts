// Servidor HTTP (Bun): expone el chat del agente y sirve el front.
// Un comando lo levanta: bun run src/server.ts
// La clave del modelo se lee de variable de entorno; nunca se expone en la API.

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createAnthropicAdapter } from "./llm/anthropic.ts";
import type { LlmAdapter, Mensaje } from "./llm/adapter.ts";
import { correrTurno, cargarSystemPrompt, type ToolCallVisible } from "./agent.ts";
import type { Ctx } from "./tools/oc.ts";

const directory = process.cwd();
const PORT = Number(process.env.PORT ?? 3000);
const provider = process.env.LLM_PROVIDER ?? "anthropic";
const model = process.env.LLM_MODEL ?? "claude-3-5-haiku-latest";
const limites = {
  maxIteraciones: Number(process.env.MAX_ITERACIONES ?? 25),
  maxTokensSesion: Number(process.env.MAX_TOKENS_SESION ?? 120000),
};

/** Crea el adaptador del proveedor configurado. */
function crearAdapter(): LlmAdapter {
  if (provider === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY ?? "";
    return createAnthropicAdapter(key, model);
  }
  throw new Error(`Proveedor no soportado: ${provider}`);
}

const system = cargarSystemPrompt(directory);
const sesiones = new Map<string, Mensaje[]>();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Salud: no expone la clave, solo proveedor y modelo.
    if (url.pathname === "/api/health") {
      return json({ ok: true, provider, model });
    }

    // Chat: { sessionId, message } → { reply, toolCalls, needsConfirmation }
    if (url.pathname === "/api/chat" && req.method === "POST") {
      try {
        const body = (await req.json()) as { sessionId?: string; message?: string };
        const sessionId = body.sessionId ?? "default";
        const message = (body.message ?? "").trim();
        if (!message) return json({ error: "Mensaje vacío" }, 400);

        const historial = sesiones.get(sessionId) ?? [];
        const ctx: Ctx = { directory, sessionId };
        const adapter = crearAdapter();
        const r = await correrTurno(adapter, system, historial, message, ctx, limites);
        sesiones.set(sessionId, r.historial);

        const toolCalls: ToolCallVisible[] = r.toolCalls;
        return json({
          reply: r.reply,
          toolCalls,
          needsConfirmation: r.needsConfirmation,
        });
      } catch (e) {
        return json({ error: `Error en el servidor: ${(e as Error).message}` }, 500);
      }
    }

    // Historial de una sesión.
    if (url.pathname.startsWith("/api/sessions/")) {
      const id = url.pathname.split("/").pop() ?? "";
      return json({ sessionId: id, historial: sesiones.get(id) ?? [] });
    }

    // Front estático.
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = readFileSync(join(directory, "web", "index.html"), "utf8");
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    return new Response("No encontrado", { status: 404 });
  },
});

console.log(`Agente OC listo en http://localhost:${PORT}  (proveedor: ${provider}, modelo: ${model})`);
