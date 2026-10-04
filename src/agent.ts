// Ciclo del agente: prompt → modelo → herramientas → respuesta.
// Reglas implementadas: tope de iteraciones (CA1), herramientas como única
// fuente de verdad (CA2), confirmación humana por corte de turno (CA3),
// toda llamada queda en el historial (CA4) y los errores no matan la sesión (CA5).

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmAdapter, Mensaje, ToolSpec, ContentBlock } from "./llm/adapter.ts";
import { tools, type Ctx, type Tool } from "./tools/oc.ts";

export type ToolCallVisible = {
  nombre: string;
  argumentos: Record<string, unknown>;
  resultado: string;
};

export type ResultadoTurno = {
  reply: string;
  toolCalls: ToolCallVisible[];
  needsConfirmation: boolean;
  historial: Mensaje[];
  usage: { input: number; output: number };
};

/** Compone el system prompt: comportamiento (prompt.md) + conocimiento (knowledge). */
export function cargarSystemPrompt(directory: string): string {
  const comportamiento = readFileSync(
    join(directory, "agent", "prompt.md"),
    "utf8",
  );
  const conocimiento = readFileSync(
    join(directory, "src", "knowledge", "ordenes-compra.md"),
    "utf8",
  );
  return `${comportamiento}\n\n# Conocimiento del proceso\n\n${conocimiento}`;
}

/** Convierte las herramientas (args zod) al esquema JSON que entiende el modelo. */
function construirToolSpecs(): ToolSpec[] {
  return Object.entries(tools).map(([nombre, tool]) => {
    const schema = zodToJsonSchema(z.object(tool.args)) as Record<string, unknown>;
    delete schema["$schema"];
    return { name: nombre, description: tool.description, input_schema: schema };
  });
}

/** Ejecuta una herramienta validando sus argumentos con zod. Nunca lanza. */
async function ejecutarTool(
  nombre: string,
  input: Record<string, unknown>,
  ctx: Ctx,
): Promise<string> {
  const tool: Tool | undefined = tools[nombre];
  if (!tool) return JSON.stringify({ ok: false, error: `Herramienta desconocida: ${nombre}` });
  const parsed = z.object(tool.args).safeParse(input);
  if (!parsed.success) {
    return JSON.stringify({
      ok: false,
      error: `Argumentos inválidos para ${nombre}: ${parsed.error.message}`,
    });
  }
  return tool.execute(parsed.data as Record<string, unknown>, ctx);
}

export async function correrTurno(
  adapter: LlmAdapter,
  system: string,
  historial: Mensaje[],
  mensajeUsuario: string,
  ctx: Ctx,
  limites: { maxIteraciones: number; maxTokensSesion: number },
): Promise<ResultadoTurno> {
  const toolSpecs = construirToolSpecs();
  const mensajes: Mensaje[] = [
    ...historial,
    { role: "user", content: [{ type: "text", text: mensajeUsuario }] },
  ];

  const toolCalls: ToolCallVisible[] = [];
  let needsConfirmation = false;
  let totalIn = 0;
  let totalOut = 0;

  for (let i = 0; i < limites.maxIteraciones; i++) {
    const resp = await adapter.enviar(system, mensajes, toolSpecs);
    totalIn += resp.usage.input;
    totalOut += resp.usage.output;
    mensajes.push({ role: "assistant", content: resp.content });

    // Tope de tokens por sesión (control de costo).
    if (totalIn + totalOut > limites.maxTokensSesion) {
      return {
        reply:
          "Alcancé el tope de tokens de la sesión. Reinicia la conversación para continuar.",
        toolCalls,
        needsConfirmation,
        historial: mensajes,
        usage: { input: totalIn, output: totalOut },
      };
    }

    const usosDeTool = resp.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );

    // Sin llamadas a herramienta → el modelo ya respondió: fin del turno.
    if (usosDeTool.length === 0) {
      const texto = resp.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return {
        reply: texto,
        toolCalls,
        needsConfirmation,
        historial: mensajes,
        usage: { input: totalIn, output: totalOut },
      };
    }

    // Ejecuta cada herramienta y arma los tool_result para la siguiente vuelta.
    const resultados: ContentBlock[] = [];
    for (const uso of usosDeTool) {
      const resultado = await ejecutarTool(uso.name, uso.input, ctx);
      if (/requiere confirmaci[oó]n/i.test(resultado)) needsConfirmation = true;
      toolCalls.push({ nombre: uso.name, argumentos: uso.input, resultado });
      resultados.push({
        type: "tool_result",
        tool_use_id: uso.id,
        content: resultado,
      });
    }
    mensajes.push({ role: "user", content: resultados });
  }

  // Se agotó el tope de iteraciones (CA1).
  return {
    reply:
      "Alcancé el tope de iteraciones del turno. Esto es lo que logré avanzar; dime si continúo.",
    toolCalls,
    needsConfirmation,
    historial: mensajes,
    usage: { input: totalIn, output: totalOut },
  };
}
