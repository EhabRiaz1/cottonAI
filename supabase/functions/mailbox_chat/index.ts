import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.0";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { cors } from "../_shared/cors.ts";
import { DEFAULT_CHAT_MODEL } from "../_shared/anthropic.ts";
import { OFFER_TOOLS, runOfferTool } from "../_shared/offer_tools.ts";

// mailbox_chat — "talk to your cotton mailbox". Stateless: the frontend holds the
// conversation and posts the message array. The agent can search the structured
// offer pool, read a recap, READ THE ACTUAL ATTACHMENTS on demand, and use web
// search for public context. Streams NDJSON events: live tool activity (which
// docs it is viewing), answer words, and the final sources.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_ROUNDS = 6;
const MAX_FOCUS_ATTACH = 6;
const MAX_FOCUS_BYTES = 18_000_000;

const MAILBOX_TOOLS = [
  ...OFFER_TOOLS,
  {
    name: "read_attachment",
    description:
      "Read the full contents of a specific email attachment (PDF or Excel offer " +
      "sheet / recap) by its attachment id, when you need detail beyond the " +
      "structured offer fields. Returns the document's readable text.",
    input_schema: {
      type: "object",
      properties: { attachment_id: { type: "string" } },
      required: ["attachment_id"],
      additionalProperties: false,
    },
  },
];
const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search" };

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return j({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return j({ error: "ANTHROPIC_API_KEY not configured" }, 500);
  const model = Deno.env.get("ANTHROPIC_MODEL") ?? DEFAULT_CHAT_MODEL;
  const webSearchOn = (Deno.env.get("MAILBOX_WEB_SEARCH") ?? "on") !== "off";
  const tools = webSearchOn ? [...MAILBOX_TOOLS, WEB_SEARCH_TOOL] : MAILBOX_TOOLS;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return j({ error: "Missing Authorization" }, 401);
  const supabase = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const admin = createClient(supabaseUrl, serviceKey);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return j({ error: "Unauthorized" }, 401);

  type Msg = { role: "user" | "assistant"; content: string };
  let body: { messages?: Msg[]; emailId?: string | null; scope?: "email" | "global" } = {};
  try { body = await req.json(); } catch { return j({ error: "Invalid JSON" }, 400); }
  const clientMessages = (body.messages ?? []).filter((m) => m.role === "user" || m.role === "assistant");
  if (!clientMessages.length) return j({ error: "messages required" }, 400);
  const scope = body.scope === "email" && body.emailId ? "email" : "global";

  const srcAtt = new Set<string>();
  const srcEmail = new Set<string>();
  const noteOffers = (out: unknown) => {
    const offers = (out as { offers?: { source_attachment_id?: string; source_email_id?: string }[] })?.offers ?? [];
    for (const o of offers.slice(0, 8)) {
      if (o.source_attachment_id) srcAtt.add(o.source_attachment_id);
      if (o.source_email_id) srcEmail.add(o.source_email_id);
    }
    const recaps = (out as { recaps?: { source_attachment_id?: string; source_email_id?: string }[] })?.recaps ?? [];
    for (const r of recaps) {
      if (r.source_attachment_id) srcAtt.add(r.source_attachment_id);
      if (r.source_email_id) srcEmail.add(r.source_email_id);
    }
  };

  // --- Reference docs (D13) grounding -------------------------------------
  const { data: refDocs } = await supabase
    .from("reference_documents").select("name, description, parsed_content").eq("is_active", true);
  let refContext = "";
  for (const r of refDocs ?? []) {
    if (r.parsed_content) refContext += `\n\n### ${r.name}${r.description ? ` — ${r.description}` : ""}\n${r.parsed_content}`;
  }
  refContext = refContext.slice(0, 30_000);

  // --- Per-email focus: load the email + inject its attachments natively ---
  // deno-lint-ignore no-explicit-any
  const messages: any[] = [];
  let focusNote = "";
  if (scope === "email") {
    const { data: em } = await supabase
      .from("email_messages")
      .select("id, from_address, from_name, broker_guess, subject, date_sent, body_text")
      .eq("id", body.emailId).maybeSingle();
    if (em) {
      focusNote = `\n\n## Email in focus\nFrom: ${em.from_name ?? ""} <${em.from_address ?? ""}> (broker: ${em.broker_guess ?? "?"})\nSubject: "${em.subject ?? ""}"\nDate: ${em.date_sent ?? ""}\n\nBody:\n${(em.body_text ?? "").slice(0, 8000)}`;
      srcEmail.add(em.id);

      const { data: atts } = await supabase
        .from("email_attachments")
        .select("id, filename, mime_type, kind, storage_path, size_bytes")
        .eq("email_id", body.emailId).in("kind", ["pdf", "excel"]).limit(MAX_FOCUS_ATTACH);

      const blocks: unknown[] = [];
      let total = 0;
      for (const a of atts ?? []) {
        if (!a.storage_path) continue;
        if (total + (a.size_bytes ?? 0) > MAX_FOCUS_BYTES) break;
        const { data: file } = await admin.storage.from("email-attachments").download(a.storage_path);
        if (!file) continue;
        const bytes = new Uint8Array(await file.arrayBuffer());
        total += bytes.length;
        srcAtt.add(a.id);
        if (a.kind === "pdf") {
          blocks.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: bytesToBase64(bytes) },
            title: a.filename,
          });
        } else {
          blocks.push({ type: "text", text: `Spreadsheet "${a.filename}":\n${excelToText(bytes).slice(0, 40_000)}` });
        }
      }
      if (blocks.length) {
        blocks.push({ type: "text", text: "(Above are the attachments for the email in focus. Use them to answer.)" });
        messages.push({ role: "user", content: blocks });
        messages.push({ role: "assistant", content: "I've reviewed the attached documents for this email." });
      }
    }
  }

  for (const m of clientMessages) messages.push({ role: m.role, content: m.content });

  const systemText = `${BASE_PROMPT}${refContext ? `\n\n## Cotton Reference (authoritative field meanings):${refContext}` : ""}${focusNote}${GUIDANCE(scope)}`;
  const nowMs = Date.now();

  // NDJSON event stream: {t:"act"} live tool activity (which docs it's viewing),
  // {t:"tok"} answer words, {t:"src"} final sources, {t:"err"} error.
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(con) {
      const emit = (obj: unknown) => con.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      try {
        if (scope === "email" && (srcAtt.size || srcEmail.size)) {
          const cards = await resolveSources(supabase, [...srcAtt], [...srcEmail]);
          if (cards.length) emit({ t: "act", label: "Reviewing this email", cards });
        }

        let finalText = "";
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const res = await fetch(ANTHROPIC_URL, {
            method: "POST",
            headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
            body: JSON.stringify({ model, max_tokens: 8192, system: systemText, tools, messages }),
          });
          if (!res.ok) { emit({ t: "err", m: `Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}` }); break; }
          const data = await res.json();
          const content = data.content ?? [];

          for (const b of content) {
            if (b.type === "server_tool_use" && b.name === "web_search") emit({ t: "act", label: "Searching the web" });
          }

          if (data.stop_reason === "pause_turn") { messages.push({ role: "assistant", content }); continue; }

          if (data.stop_reason === "tool_use") {
            messages.push({ role: "assistant", content });
            const results: unknown[] = [];
            for (const b of content) {
              if (b.type !== "tool_use") continue;
              let out: unknown;
              if (b.name === "read_attachment") {
                if (b.input?.attachment_id) srcAtt.add(b.input.attachment_id);
                const cards = await resolveSources(supabase, b.input?.attachment_id ? [b.input.attachment_id] : [], []);
                emit({ t: "act", label: cards[0]?.filename ? `Reading ${cards[0].filename}` : "Reading attachment", cards });
                out = await readAttachment(supabase, admin, apiKey, model, b.input?.attachment_id);
              } else {
                out = await runOfferTool(supabase, b.name, b.input ?? {}, nowMs);
                noteOffers(out);
                const ids = idsFromOut(out);
                const cards = await resolveSources(supabase, ids.att, ids.em);
                emit({ t: "act", label: b.name === "get_recap" ? "Opening recap" : "Searching offers", cards });
              }
              results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out).slice(0, 60_000) });
            }
            if (!results.length) continue;
            messages.push({ role: "user", content: results });
            continue;
          }

          finalText = content.filter((b: { type: string }) => b.type === "text").map((b: { text?: string }) => b.text ?? "").join("");
          break;
        }
        if (!finalText) finalText = "I couldn't complete that — try rephrasing.";

        for (const tk of finalText.split(/(\s+)/)) {
          if (tk) emit({ t: "tok", v: tk });
          await new Promise((r) => setTimeout(r, 9));
        }
        const cards = await resolveSources(supabase, [...srcAtt], [...srcEmail]);
        emit({ t: "src", cards });
        con.close();
      } catch (e) {
        emit({ t: "err", m: e instanceof Error ? e.message : String(e) });
        con.close();
      }
    },
  });
  return new Response(stream, { headers: { ...cors, "Content-Type": "application/x-ndjson" } });
});

function idsFromOut(out: unknown): { att: string[]; em: string[] } {
  const att = new Set<string>(), em = new Set<string>();
  const offers = (out as { offers?: { source_attachment_id?: string; source_email_id?: string }[] })?.offers ?? [];
  for (const o of offers.slice(0, 6)) { if (o.source_attachment_id) att.add(o.source_attachment_id); if (o.source_email_id) em.add(o.source_email_id); }
  const recaps = (out as { recaps?: { source_attachment_id?: string; source_email_id?: string }[] })?.recaps ?? [];
  for (const r of recaps) { if (r.source_attachment_id) att.add(r.source_attachment_id); if (r.source_email_id) em.add(r.source_email_id); }
  return { att: [...att], em: [...em] };
}

async function resolveSources(db: SupabaseClient, attIds: string[], emailIds: string[]) {
  // deno-lint-ignore no-explicit-any
  const cards: any[] = [];
  const seen = new Set<string>();
  if (attIds.length) {
    const { data: atts } = await db.from("email_attachments")
      .select("id, filename, kind, storage_path, email_id").in("id", attIds);
    const emIds = [...new Set((atts ?? []).map((a) => a.email_id))];
    const { data: ems } = emIds.length
      ? await db.from("email_messages").select("id, subject, broker_guess").in("id", emIds)
      : { data: [] };
    const byId = Object.fromEntries((ems ?? []).map((e) => [e.id, e]));
    for (const a of atts ?? []) {
      const e = byId[a.email_id];
      cards.push({ type: "attachment", attachmentId: a.id, filename: a.filename, kind: a.kind,
        storagePath: a.storage_path, emailId: a.email_id, subject: e?.subject ?? null, broker: e?.broker_guess ?? null });
      seen.add(a.email_id);
    }
  }
  const rem = emailIds.filter((id) => !seen.has(id));
  if (rem.length) {
    const { data: ems } = await db.from("email_messages").select("id, subject, broker_guess").in("id", rem);
    for (const e of ems ?? []) cards.push({ type: "email", emailId: e.id, subject: e.subject ?? null, broker: e.broker_guess ?? null });
  }
  return cards.slice(0, 10);
}

// Read one attachment's content. Excel -> text locally; PDF -> a focused model
// call that returns the readable text (true on-demand reading).
async function readAttachment(
  rls: SupabaseClient, admin: SupabaseClient, apiKey: string, model: string, attachmentId?: string,
): Promise<unknown> {
  if (!attachmentId) return { error: "attachment_id required" };
  const { data: a } = await rls
    .from("email_attachments").select("id, filename, kind, storage_path").eq("id", attachmentId).maybeSingle();
  if (!a || !a.storage_path) return { error: "attachment not found" };
  const { data: file } = await admin.storage.from("email-attachments").download(a.storage_path);
  if (!file) return { error: "could not download attachment" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (a.kind === "excel") return { filename: a.filename, content: excelToText(bytes).slice(0, 50_000) };
  if (a.kind === "pdf") {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
      body: JSON.stringify({
        model: Deno.env.get("ANTHROPIC_EXTRACT_MODEL") ?? "claude-sonnet-4-6",
        max_tokens: 6000,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: bytesToBase64(bytes) }, title: a.filename },
            { type: "text", text: "Transcribe the readable content of this cotton document (tables included) as plain text." },
          ],
        }],
      }),
    });
    if (!res.ok) return { error: `read failed: ${(await res.text()).slice(0, 200)}` };
    const d = await res.json();
    const text = (d.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text?: string }) => b.text ?? "").join("");
    return { filename: a.filename, content: text.slice(0, 50_000) };
  }
  return { error: "unsupported attachment kind" };
}

function excelToText(bytes: Uint8Array): string {
  const book = XLSX.read(bytes, { type: "array", cellDates: true });
  let out = "";
  for (const name of book.SheetNames) {
    const s = book.Sheets[name];
    if (s) out += `## ${name}\n${XLSX.utils.sheet_to_csv(s)}\n\n`;
  }
  return out.trim();
}
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

const BASE_PROMPT =
  `You are Cotton AI, an expert assistant embedded in a cotton-trading mailbox. You help a ` +
  `textile mill read and reason about broker offer emails and their attachments (offer sheets ` +
  `and quality recaps). Be specific and practical; you may use general cotton-trade knowledge ` +
  `and web search for public context (e.g. ICE futures months, origin characteristics).`;

function GUIDANCE(scope: "email" | "global"): string {
  return `

## Response format (follow strictly)
- Lead with ONE direct sentence answering the question, then the supporting detail.
- Organize with short markdown headings (###) and **bold** the key numbers (prices, mic, staple).
- Present two or more offers as a Markdown TABLE — columns: Broker | Origin | Grade | Mic | Staple | Price | Date / Age.
- When you state a fact drawn from an email, quote that email's subject in double quotes, e.g. From "FW: COFCO : Daily Offer PAK - 19-Jun-26".
- PRICING: For an on-call offer, show the basis on the futures CONTRACT CODE (F=Jan, G=Feb, H=Mar, J=Apr, K=May, M=Jun, N=Jul, Q=Aug, U=Sep, V=Oct, X=Nov, Z=Dec) plus the year's last digit — e.g. December 2026 = Z6, so display "on-call +1700 on Z6". Do NOT show or invent a cents/lb figure for on-call offers. Only show a cents/lb price for genuine outright offers (e.g. 85.5c/lb). Always show the price next to its date/age.
- End with a one-line freshness/verify caveat. Be concise: no filler, no restating the question, no raw dumps.

## How to work
- Use \`search_offers\` to find/compare offers across the whole mailbox; \`get_recap\` for a lot's
  deep quality distribution; \`read_attachment\` to open a specific PDF/Excel when you need detail
  beyond the structured fields; \`web_search\` for current public market context.
- ${scope === "email"
    ? "You are focused on ONE email whose attachments are provided above — answer primarily from them, but you may search the wider pool if asked."
    : "You are in whole-mailbox mode — search across all offers and brokers."}
- ALWAYS show each offer's price next to its date and note relative age; flag offers >30 days as
  possibly stale. Distinguish on-call (basis on a futures month) from outright (fixed c/lb).
- If a value is unclear or flagged needs_review, say so. This is informational — remind the user to
  confirm with their trading team before acting.
- CHEAPEST / PRICE COMPARISONS: Most offers are NOT directly price-comparable — only a minority are
  outright (fixed c/lb); many are on-call (a basis on a futures month) and many carry no price at all.
  Never rank an on-call basis against an outright cents price as if equal. When asked for the cheapest,
  search broadly, say how many priced offers you compared, and give the cheapest OUTRIGHT and the
  cheapest ON-CALL separately. For offers with no price, identify the cotton by origin + grade + the
  source email/recap it came from rather than omitting them.`;
}
