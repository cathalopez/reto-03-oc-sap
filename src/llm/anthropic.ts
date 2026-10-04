// Implementación del adaptador para Anthropic (API de Mensajes).
// Usa fetch directo (sin SDK) para mantener las dependencias al mínimo.
// La clave se lee de process.env y NUNCA se escribe en logs ni respuestas.

import type { LlmAdapter, Mensaje, RespuestaLLM, ToolSpec } from "./adapter.ts";

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

export function createAnthropicAdapter(
  apiKey: string,
  model: string,
): LlmAdapter {
  return {
    provider: "anthropic",
    model,
    async enviar(
      system: string,
      mensajes: Mensaje[],
      tools: ToolSpec[],
    ): Promise<RespuestaLLM> {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system,
          messages: mensajes,
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
          })),
        }),
      });

      if (!resp.ok) {
        const detalle = await resp.text();
        throw new Error(`Anthropic ${resp.status}: ${detalle.slice(0, 300)}`);
      }

      const data = (await resp.json()) as {
        content: AnthropicBlock[];
        stop_reason: string;
        usage: { input_tokens: number; output_tokens: number };
      };

      return {
        content: data.content,
        stop: data.stop_reason === "tool_use" ? "tool_use" : "fin",
        usage: {
          input: data.usage.input_tokens,
          output: data.usage.output_tokens,
        },
      };
    },
  };
}
