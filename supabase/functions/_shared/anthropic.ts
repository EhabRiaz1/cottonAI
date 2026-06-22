// Shared Anthropic helpers (raw HTTPS, matching the existing chat function style).
// Models per the claude-api reference: chat = claude-opus-4-8 (tool-use),
// extraction = claude-sonnet-4-6 (cheaper tier, supports structured JSON outputs).

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_CHAT_MODEL = "claude-opus-4-8";
export const DEFAULT_EXTRACT_MODEL = "claude-sonnet-4-6";

export interface ContentBlock {
  type: string;
  text?: string;
  // document / image blocks carry a `source`; tool_use carries name/input, etc.
  [k: string]: unknown;
}

// Structured extraction via FORCED TOOL USE. A single tool the model must call,
// whose input_schema is our extraction schema. Unlike output_config.format,
// tool input schemas have no cap on optional fields — needed for our wide,
// mostly-optional offer schema. (Forced tool_choice is incompatible with extended
// thinking, so thinking is omitted; field extraction doesn't need it.)
const EXTRACT_TOOL_NAME = "record_extraction";

export async function extractStructured(opts: {
  apiKey: string;
  model: string;
  system: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  userContent: ContentBlock[];
  schema: Record<string, unknown>;
  maxTokens?: number;
  effort?: "low" | "medium" | "high"; // accepted for compatibility; unused with tool-use
}): Promise<{ data: unknown; usage: unknown; stopReason: string | null }> {
  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 16000,
    system: opts.system,
    tools: [{
      name: EXTRACT_TOOL_NAME,
      description: "Record every cotton offer (and any recap) extracted from the document.",
      input_schema: opts.schema,
    }],
    tool_choice: { type: "tool", name: EXTRACT_TOOL_NAME },
    messages: [{ role: "user", content: opts.userContent }],
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 1000)}`);
  }
  const json = await res.json();
  const stopReason: string | null = json.stop_reason ?? null;
  if (stopReason === "refusal") throw new Error("Anthropic refused the extraction request");

  const toolBlock = (json.content ?? []).find(
    (b: ContentBlock) => b.type === "tool_use" && b.name === EXTRACT_TOOL_NAME,
  );
  if (!toolBlock || typeof toolBlock.input !== "object") {
    throw new Error(`No ${EXTRACT_TOOL_NAME} tool_use in response (stop=${stopReason})`);
  }
  return { data: toolBlock.input, usage: json.usage ?? null, stopReason };
}
