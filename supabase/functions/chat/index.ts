import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.0";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { OFFER_TOOLS, runOfferTool } from "../_shared/offer_tools.ts";
import { DEFAULT_CHAT_MODEL } from "../_shared/anthropic.ts";

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MAX_SYSTEM_CHARS = 80_000;
const MAX_DOCS_CHARS = 40_000;
const MAX_REF_CHARS = 30_000;
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOOL_ROUNDS = 5;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
  // Pinned to Opus 4.8 for the offer tool-use loop (per plan §10.2).
  const model = Deno.env.get("ANTHROPIC_MODEL") ?? DEFAULT_CHAT_MODEL;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing Authorization" }),
      { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const supabaseAdmin = createClient(supabaseUrl, serviceKey);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const { data: isPA } = await supabase
    .from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle();
  const platformAdmin = !!isPA;

  type Body = { chatId: string; orgId: string };
  let body: Body;
  try { body = (await req.json()) as Body; } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }
  if (!body.chatId || !body.orgId) {
    return new Response(JSON.stringify({ error: "chatId and orgId required" }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const { data: mem } = await supabase
    .from("org_members").select("org_id").eq("user_id", user.id).eq("org_id", body.orgId).maybeSingle();
  if (!mem && !platformAdmin) {
    return new Response(JSON.stringify({ error: "Not in org" }),
      { status: 403, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const { data: chat, error: cErr } = await supabase
    .from("chats").select("id, org_id, user_id, org_sheet_id, title").eq("id", body.chatId).single();
  if (cErr || !chat) {
    return new Response(JSON.stringify({ error: "Chat not found" }),
      { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
  }
  if (chat.org_id !== body.orgId) {
    return new Response(JSON.stringify({ error: "Org mismatch" }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }
  if (!platformAdmin && chat.user_id !== user.id) {
    return new Response(JSON.stringify({ error: "Forbidden" }),
      { status: 403, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const { data: org } = await supabaseAdmin
    .from("organizations").select("custom_system_prompt").eq("id", body.orgId).single();
  const { data: defaultPromptRow } = await supabaseAdmin
    .from("system_prompts").select("prompt_text").eq("is_default", true).is("org_id", null).maybeSingle();
  const basePrompt = org?.custom_system_prompt || defaultPromptRow?.prompt_text || getDefaultPrompt();

  // --- Optional org sheet/doc context (kept for backward compatibility) ---
  const { data: orgDocs } = await supabaseAdmin
    .from("org_documents")
    .select("id, name, parsed_content, original_filename, storage_path, file_type")
    .eq("org_id", body.orgId).eq("is_active", true).order("created_at", { ascending: false });

  let docsContext = "";
  if (orgDocs && orgDocs.length > 0) {
    let charCount = 0;
    const docSections: string[] = [];
    for (const doc of orgDocs) {
      if (charCount >= MAX_DOCS_CHARS) break;
      let content = doc.parsed_content;
      if (!content && doc.storage_path) {
        try {
          const { data: fileData } = await supabaseAdmin.storage.from("org-sheets").download(doc.storage_path);
          if (fileData) {
            const fname = (doc.original_filename || doc.storage_path).toLowerCase();
            const isExcel = fname.endsWith(".xlsx") || fname.endsWith(".xls") || fname.endsWith(".xlsb");
            if (isExcel) {
              const buf = await fileData.arrayBuffer();
              const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
              const parts: string[] = [];
              for (const sn of wb.SheetNames) {
                const ws = wb.Sheets[sn];
                if (!ws) continue;
                const csv = XLSX.utils.sheet_to_csv(ws);
                if (csv.trim()) parts.push(`## Sheet: ${sn}\n${csv}`);
              }
              if (parts.length) content = parts.join("\n");
            } else {
              const text = await fileData.text();
              if (text) content = text;
            }
            if (content) {
              await supabaseAdmin.from("org_documents")
                .update({ parsed_content: content.slice(0, 200000) }).eq("id", doc.id);
            }
          }
        } catch { /* skip */ }
      }
      if (content) {
        const section = `### Document: ${doc.name || doc.original_filename}\n${content}`;
        if (charCount + section.length <= MAX_DOCS_CHARS) {
          docSections.push(section);
          charCount += section.length;
        }
      }
    }
    if (docSections.length) docsContext = "\n\n## Organization Documents:\n" + docSections.join("\n\n");
  }

  let sheetId = chat.org_sheet_id as string | null;
  if (!sheetId) {
    const { data: active } = await supabase
      .from("org_sheets").select("id").eq("org_id", body.orgId)
      .eq("parse_status", "ready").eq("is_active", true).maybeSingle();
    sheetId = active?.id ?? null;
  }
  let sheetContext = "";
  if (sheetId) {
    const { data: sheet } = await supabase
      .from("org_sheets").select("id, summary_text, parse_status, original_filename")
      .eq("id", sheetId).eq("org_id", body.orgId).single();
    if (sheet && sheet.parse_status === "ready" && sheet.summary_text) {
      const s = sheet.summary_text.length > MAX_SYSTEM_CHARS
        ? sheet.summary_text.slice(0, MAX_SYSTEM_CHARS) + "\n\n[Truncated for model context.]"
        : sheet.summary_text;
      sheetContext = `\n\n## Workbook Data (${sheet.original_filename || "workbook"}):\n${s}`;
    }
  }

  // --- Reference documents (D13) as grounding for cotton field meanings ---
  const { data: refDocs } = await supabase
    .from("reference_documents").select("name, description, parsed_content").eq("is_active", true);
  let refContext = "";
  if (refDocs && refDocs.length) {
    let acc = "";
    for (const r of refDocs) {
      if (r.parsed_content) acc += `\n\n### ${r.name}${r.description ? ` — ${r.description}` : ""}\n${r.parsed_content}`;
    }
    if (acc.trim()) refContext = "\n\n## Cotton Reference (authoritative field meanings, grades, certifications):" + acc.slice(0, MAX_REF_CHARS);
  }

  // No more "no data -> 400" gate: offers may be the only context, and they are
  // fetched on demand via the search_offers tool.
  const { data: msgRows, error: mErr } = await supabase
    .from("messages").select("role, content, created_at")
    .eq("chat_id", body.chatId).order("created_at", { ascending: true }).limit(60);
  if (mErr) {
    return new Response(JSON.stringify({ error: mErr.message }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
  if (!msgRows || msgRows.length === 0) {
    return new Response(JSON.stringify({ error: "No messages in chat" }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const systemText = `${basePrompt}${refContext}${docsContext}${sheetContext}${OFFER_GUIDANCE}`;

  // deno-lint-ignore no-explicit-any
  const messages: any[] = [];
  for (const m of msgRows) {
    if (m.role === "user" || m.role === "assistant") messages.push({ role: m.role, content: m.content });
  }

  const nowMs = Date.now();

  // --- Tool-use loop (non-streamed); offer reads use the user-JWT client (RLS) ---
  let finalText = "";
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 8192, system: systemText, tools: OFFER_TOOLS, messages }),
      });
      if (!res.ok) {
        const t = await res.text();
        return new Response(JSON.stringify({ error: "Anthropic error", detail: t }),
          { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
      }
      const json = await res.json();
      const content = json.content ?? [];
      if (json.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content });
        const toolResults: unknown[] = [];
        for (const block of content) {
          if (block.type === "tool_use") {
            const result = await runOfferTool(supabase, block.name, block.input ?? {}, nowMs);
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
          }
        }
        messages.push({ role: "user", content: toolResults });
        continue;
      }
      finalText = content.filter((b: { type: string }) => b.type === "text")
        .map((b: { text?: string }) => b.text ?? "").join("");
      break;
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: "Chat failed", detail: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }

  if (!finalText) finalText = "I couldn't complete that request. Please try rephrasing.";

  // Stream the final answer to the client (chunked) and persist it. The wire format
  // is plain text, matching the existing streamChat() reader in src/lib/api.ts.
  const enc = new TextEncoder();
  const out = new ReadableStream<Uint8Array>({
    async start(con) {
      try {
        for (let i = 0; i < finalText.length; i += 240) {
          con.enqueue(enc.encode(finalText.slice(i, i + 240)));
        }
        await supabase.from("messages").insert({ chat_id: body.chatId, role: "assistant", content: finalText });
        if (chat.title === "New chat" || !chat.title) {
          const firstUser = msgRows.find((x) => x.role === "user");
          if (firstUser) {
            const t = firstUser.content.slice(0, 64).trim() || "Chat";
            await supabase.from("chats").update({ title: t }).eq("id", body.chatId);
          }
        }
        con.close();
      } catch (e) { con.error(e); }
    },
  });

  return new Response(out, { headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" } });
});

const OFFER_GUIDANCE = `

## Cotton offer pool (tool access)
You can search a shared pool of cotton offers extracted from broker emails using the
\`search_offers\` tool, and fetch a lot's deep quality recap with \`get_recap\`. Use them
whenever the user asks to find, compare, or reason about available cotton.

Rules when presenting offers:
- ALWAYS show each offer's price next to its date. Note relative age ("12 days old").
- Editorialize freshness: flag offers older than ~30 days as potentially stale and very
  old ones (90+ days) as likely dead; recommend confirming current levels with the broker.
- Distinguish on-call (basis points on a futures month, e.g. "+1700 on Dec'26") from
  outright (fixed c/lb) prices clearly — never conflate them.
- If an offer is flagged needs_review or has low confidence, say so rather than presenting
  it as certain.
- Present multiple offers as a compact markdown table (origin, grade, mic, staple, price,
  date/age, broker). Keep it scannable.
- This is informational; remind the user to verify with their trading team before acting.`;

function getDefaultPrompt(): string {
  return `You are Cotton AI, a specialized assistant for cotton procurement and trading. You help textile mills with:

1. **Fixation Timing**: When to fix prices on cotton contracts based on market conditions
2. **Origin Selection**: Which cotton origins (Brazilian, US, West African, etc.) offer best value for specific yarn requirements
3. **Hedging Strategies**: Options and futures strategies to protect against price volatility
4. **Market Analysis**: Interpreting USDA reports, supply/demand dynamics, and price trends

You have access to the organization's procurement data, documents, and market information. Always:
- Be specific with recommendations (exact prices, dates, quantities when possible)
- Explain your reasoning and confidence level
- Note any risks or assumptions
- Remind users this is informational only and they should verify with their trading team

Format responses clearly with headers, bullet points, and tables where appropriate.`;
}
