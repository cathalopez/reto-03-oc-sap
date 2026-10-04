// Interfaz propia del proveedor LLM (patrón puerto/adaptador).
// El ciclo del agente habla SOLO con esta interfaz; cambiar de proveedor
// (Anthropic, OpenAI, etc.) significa escribir otra implementación, sin tocar el ciclo.

/** Esquema JSON de una herramienta tal como lo entiende el modelo. */
export type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

/** Bloques de contenido de un mensaje (formato neutral, inspirado en Anthropic). */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

export type Mensaje = {
  role: "user" | "assistant";
  content: ContentBlock[];
};

export type RespuestaLLM = {
  content: ContentBlock[];
  /** "tool_use" si el modelo quiere ejecutar herramientas; "fin" si ya respondió. */
  stop: "tool_use" | "fin";
  usage: { input: number; output: number };
};

export interface LlmAdapter {
  readonly provider: string;
  readonly model: string;
  enviar(
    system: string,
    mensajes: Mensaje[],
    tools: ToolSpec[],
  ): Promise<RespuestaLLM>;
}
