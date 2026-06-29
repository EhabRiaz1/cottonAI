import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.0";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { cors } from "../_shared/cors.ts";
import { DEFAULT_CHAT_MODEL } from "../_shared/anthropic.ts";
import { OFFER_TOOLS, runOfferTool } from "../_shared/offer_tools.ts";
import {
  deriveDocsRow, deriveIPRow, derivePaymentsRow, deriveRow, deriveShipmentRow, docsRowToCells,
  type DocsRow, type IPRow, ipRowToCells, paymentsRowToCells, type PaymentsRow,
  PENDING_DOCS_COLUMNS, PENDING_IPS_COLUMNS, PENDING_LC_COLUMNS, PENDING_PAYMENTS_COLUMNS,
  PENDING_SHIPMENTS_COLUMNS, pktTodayISO, type RawContract, type RawIP, type RawShipment,
  rowToCells, type ShipmentRow, shipmentRowToCells,
} from "../_shared/lc_derive.ts";

// mailbox_chat — "talk to your cotton mailbox". Stateless: the frontend holds the
// conversation and posts the message array. The agent can search the structured
// offer pool, read a recap, READ THE ACTUAL ATTACHMENTS on demand, and use web
// search for public context. Streams NDJSON events: live tool activity (which
// docs it is viewing), answer words, and the final sources.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_ROUNDS = 6;
const MAX_FOCUS_ATTACH = 12;
const MAX_FOCUS_BYTES = 26_000_000;

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
  {
    name: "get_email",
    description:
      "Find an email by sender (name or address) or subject keywords and return ALL " +
      "of its attachments plus every offer and recap extracted from them. Use this " +
      "when the user asks about a specific email, sender, or broker, so you consider " +
      "the WHOLE email and ALL its documents, not just one.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Sender name/email or subject keywords" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "make_file",
    description:
      "Generate a downloadable Excel (.xlsx) file from tabular data. Call this ONLY " +
      "when the user explicitly asks to export / download / make a sheet or excel of " +
      "information (e.g. 'make an excel of those offers'). `rows` is ROW-MAJOR: each row " +
      "MUST have exactly columns.length cells, in the same order as `columns`. Prefer " +
      "real values you already have from search_offers/get_email over re-typing.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "File / sheet title" },
        columns: { type: "array", items: { type: "string" }, description: "Header row" },
        rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "Row-major data; each row length === columns length" },
      },
      required: ["title", "columns", "rows"],
      additionalProperties: false,
    },
  },
  {
    name: "query_elithum",
    description:
      "Build a 'Pending LC's list' OR a 'Pending Shipments list' from the company's Elithum " +
      "contracts portal (READ-ONLY). Call this ONLY for those Elithum report requests — NOT for " +
      "mailbox/offer questions. It reads Elithum, derives the LC columns, and generates the Excel " +
      "automatically (do NOT also call make_file). Which report to build is decided by the app, " +
      "not by you — just call this once. Pass date_from/date_to (YYYY-MM-DD) for the Date-of-Sale " +
      "window, and buyer/seller ONLY if the user named one.",
    input_schema: {
      type: "object",
      properties: {
        date_from: { type: "string", description: "Earliest Date of Sale, YYYY-MM-DD" },
        date_to: { type: "string", description: "Latest Date of Sale, YYYY-MM-DD" },
        buyer: { type: "string", description: "Buyer name filter (optional, case-insensitive contains)" },
        seller: { type: "string", description: "Seller name filter (optional, case-insensitive contains)" },
      },
      required: [],
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
  type PendingLc = { dateFrom?: string | null; dateTo?: string | null; label?: string; report?: "lc" | "shipments" | "ips" | "docs" | "payments" };
  let body: { messages?: Msg[]; emailId?: string | null; scope?: "email" | "global"; dateFrom?: string | null; timelineLabel?: string; pendingLc?: PendingLc | null } = {};
  try { body = await req.json(); } catch { return j({ error: "Invalid JSON" }, 400); }
  const pendingLc = body.pendingLc && typeof body.pendingLc === "object" ? body.pendingLc : null;
  const dateFrom = typeof body.dateFrom === "string" && body.dateFrom ? body.dateFrom : null;
  const timelineLabel = body.timelineLabel || (dateFrom ? `since ${dateFrom}` : "entire mailbox");
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

  const timelineNote = scope === "email" ? "" : (dateFrom
    ? `\n\n## Timeline scope (user-selected: ${timelineLabel})\nONLY consider offers dated on or after ${dateFrom}. Pass date_from:"${dateFrom}" to search_offers and search the FULL range EXHAUSTIVELY with a high limit (e.g. 300). Do NOT base a broad answer on a single document or only the most recent offers.`
    : `\n\n## Timeline scope (user-selected: entire mailbox)\nSearch comprehensively across ALL brokers and dates — call search_offers with a high limit (e.g. 400) and review the whole pool. Do NOT answer a broad question from a single document or only the most recent offers.`);
  const pendingReport = pendingLc?.report === "shipments"
    ? "shipments"
    : pendingLc?.report === "ips"
    ? "ips"
    : pendingLc?.report === "docs"
    ? "docs"
    : pendingLc?.report === "payments"
    ? "payments"
    : "lc";
  const pendingLcNote = pendingLc
    ? (pendingReport === "shipments"
      ? `\n\n## PENDING SHIPMENTS REQUEST (priority)\nThe user asked for a Pending Shipments list from the Elithum portal. Call the \`query_elithum\` tool EXACTLY ONCE with date_from="${pendingLc.dateFrom ?? ""}", date_to="${pendingLc.dateTo ?? ""}", and set buyer/seller ONLY if the user named one in their message (otherwise omit them). Do NOT call make_file, search_offers, or web_search for this. After the tool returns, write 2-3 sentences: how many shipment rows across how many contracts, and how many are overdue (Delay > 0). The downloadable Excel is generated automatically — do NOT re-list every row. If the tool returns an \`error\`, tell the user plainly and never invent contract data.`
      : pendingReport === "ips"
      ? `\n\n## PENDING IPs REQUEST (priority)\nThe user asked for a Pending IPs list from the Elithum portal (one row per IP). Call the \`query_elithum\` tool EXACTLY ONCE with date_from="${pendingLc.dateFrom ?? ""}", date_to="${pendingLc.dateTo ?? ""}", and set buyer/seller ONLY if the user named one in their message (otherwise omit them). Do NOT call make_file, search_offers, or web_search for this. After the tool returns, write 2-3 sentences: how many IPs across how many contracts, and how many have not been sent to the supplier yet (not_sent). The downloadable Excel is generated automatically — do NOT re-list every row. If the tool returns an \`error\`, tell the user plainly and never invent contract data.`
      : pendingReport === "docs"
      ? `\n\n## PENDING DOCS REQUEST (priority)\nThe user asked for a Pending Docs list from the Elithum portal (one row per shipment, with document columns: Copy Docs, Disc Sent, Disc Received). Call the \`query_elithum\` tool EXACTLY ONCE with date_from="${pendingLc.dateFrom ?? ""}", date_to="${pendingLc.dateTo ?? ""}", and set buyer/seller ONLY if the user named one in their message (otherwise omit them). Do NOT call make_file, search_offers, or web_search for this. After the tool returns, write 2-3 sentences: how many shipment rows across how many contracts, and how many have copy docs recorded (with_copy_docs). The downloadable Excel is generated automatically — do NOT re-list every row. If the tool returns an \`error\`, tell the user plainly and never invent contract data.`
      : pendingReport === "payments"
      ? `\n\n## PENDING PAYMENTS REQUEST (priority)\nThe user asked for a Pending Payments list from the Elithum portal (one row per shipment; same as Pending Docs plus a Payment Date column). Call the \`query_elithum\` tool EXACTLY ONCE with date_from="${pendingLc.dateFrom ?? ""}", date_to="${pendingLc.dateTo ?? ""}", and set buyer/seller ONLY if the user named one in their message (otherwise omit them). Do NOT call make_file, search_offers, or web_search for this. After the tool returns, write 2-3 sentences: how many shipment rows across how many contracts, and how many have a payment date recorded (with_payment). The downloadable Excel is generated automatically — do NOT re-list every row. If the tool returns an \`error\`, tell the user plainly and never invent contract data.`
      : `\n\n## PENDING LC REQUEST (priority)\nThe user asked for a Pending LC's list from the Elithum portal. This report now lists ALL contracts in the date range with their LC status (not just the ones missing an LC draft). Call the \`query_elithum\` tool EXACTLY ONCE with date_from="${pendingLc.dateFrom ?? ""}", date_to="${pendingLc.dateTo ?? ""}", and set buyer/seller ONLY if the user named one in their message (otherwise omit them). Do NOT call make_file, search_offers, or web_search for this. After the tool returns, write 2-3 sentences: how many contracts total, how many still have no LC draft (no_lc_draft), and how many are overdue (Delay > 0). The downloadable Excel is generated automatically — do NOT re-list every row. If the tool returns an \`error\`, tell the user plainly and never invent contract data.`)
    : "";
  const systemText = `${BASE_PROMPT}${refContext ? `\n\n## Cotton Reference (authoritative field meanings):${refContext}` : ""}${focusNote}${timelineNote}${pendingLcNote}${GUIDANCE(scope)}`;
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
              } else if (b.name === "get_email") {
                out = await runGetEmail(supabase, b.input?.query ?? "");
                const m = (out as { matches?: { email: { id: string }; attachments: { id: string }[] }[] }).matches ?? [];
                const attIds: string[] = []; const emIds: string[] = [];
                for (const x of m) { emIds.push(x.email.id); for (const a of x.attachments) attIds.push(a.id); }
                attIds.forEach((id) => srcAtt.add(id)); emIds.forEach((id) => srcEmail.add(id));
                const cards = await resolveSources(supabase, attIds, emIds);
                emit({ t: "act", label: "Opening email", cards });
              } else if (b.name === "make_file") {
                emit({ t: "act", label: "Building Excel…" });
                const r = await runMakeFile(admin, user.id, b.input ?? {});
                out = r.toolResult;
                if (r.artifact) emit({ t: "artifact", file: r.artifact });
              } else if (b.name === "query_elithum") {
                emit({ t: "act", label: "Querying Elithum…" });
                // `report` is app-driven (frontend pendingLc payload), NOT the model's
                // choice — so a model that forgets the report can't emit the wrong sheet.
                const r = pendingReport === "shipments"
                  ? await runQueryElithumShipments(admin, user.id, b.input ?? {}, pendingLc)
                  : pendingReport === "ips"
                  ? await runQueryElithumIPs(admin, user.id, b.input ?? {}, pendingLc)
                  : pendingReport === "docs"
                  ? await runQueryElithumDocs(admin, user.id, b.input ?? {}, pendingLc)
                  : pendingReport === "payments"
                  ? await runQueryElithumPayments(admin, user.id, b.input ?? {}, pendingLc)
                  : await runQueryElithum(admin, user.id, b.input ?? {}, pendingLc);
                out = r.toolResult;
                if (r.artifact) emit({ t: "artifact", file: r.artifact });
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

// Find an email by sender/subject and return ALL its attachments + extracted
// offers/recaps, so the agent considers the whole email at once.
async function runGetEmail(db: SupabaseClient, query: string): Promise<unknown> {
  const q = `%${query.replace(/[%,()]/g, " ").trim()}%`;
  const { data: emails } = await db.from("email_messages")
    .select("id, from_name, from_address, broker_guess, subject, date_sent")
    .or(`from_name.ilike.${q},from_address.ilike.${q},subject.ilike.${q},broker_guess.ilike.${q}`)
    .order("date_sent", { ascending: false, nullsFirst: false }).limit(3);
  // deno-lint-ignore no-explicit-any
  const matches: any[] = [];
  for (const e of emails ?? []) {
    const { data: atts } = await db.from("email_attachments")
      .select("id, filename, kind").eq("email_id", e.id);
    const { data: offers } = await db.from("cotton_offers")
      .select("broker,origin_country,grade_raw,mic,staple_fraction,staple_32nds,gpt,quantity_bales,price_type,price_basis_points,price_outright_cents,futures_month,crop_year,offer_date,needs_review,source_attachment_id")
      .eq("source_email_id", e.id).limit(300);
    const { data: recaps } = await db.from("cotton_recaps")
      .select("recap_code,broker,crop_year,total_bales,avg_mic,avg_staple,avg_gpt,avg_length,avg_uniformity,source_attachment_id")
      .eq("source_email_id", e.id).limit(80);
    matches.push({
      email: { id: e.id, from: e.from_name ?? e.from_address, broker: e.broker_guess, subject: e.subject, date: e.date_sent },
      attachments: atts ?? [], offers: offers ?? [], recaps: recaps ?? [],
    });
  }
  return { matches };
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

// Generate an xlsx from agent-supplied tabular data, upload to the private
// exports bucket (service role), and return an artifact descriptor (path, not URL).
async function runMakeFile(
  admin: SupabaseClient, userId: string,
  // deno-lint-ignore no-explicit-any
  input: any,
): Promise<{ toolResult: unknown; artifact?: { name: string; format: string; storagePath: string } }> {
  const title = String(input?.title ?? "export");
  const columns = Array.isArray(input?.columns) ? input.columns.map((c: unknown) => String(c ?? "")) : [];
  const rows = Array.isArray(input?.rows) ? input.rows : [];
  if (!columns.length) return { toolResult: { error: "columns is required (the header row)" } };
  if (columns.length > 50) return { toolResult: { error: "too many columns (max 50)" } };
  if (rows.length > 5000) return { toolResult: { error: "too many rows (max 5000) — filter the data first" } };
  for (let i = 0; i < rows.length; i++) {
    if (!Array.isArray(rows[i]) || rows[i].length !== columns.length) {
      return { toolResult: { error: `row ${i + 1} has ${Array.isArray(rows[i]) ? rows[i].length : 0} cells but expected ${columns.length}; every row must match the columns exactly` } };
    }
  }
  try {
    // deno-lint-ignore no-explicit-any
    const aoa = [columns, ...rows.map((r: any[]) => r.map((c) => (c == null ? "" : String(c))))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, (title.slice(0, 31) || "Sheet1"));
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
    const safe = title.replace(/[^\w.\-]+/g, "_").slice(0, 60) || "export";
    const name = `${safe}.xlsx`;
    const path = `${userId}/${crypto.randomUUID()}_${name}`;
    const { error } = await admin.storage.from("exports").upload(path, buf, {
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", upsert: true,
    });
    if (error) return { toolResult: { error: `upload failed: ${error.message}` } };
    return { toolResult: { ok: true, filename: name, rows: rows.length }, artifact: { name, format: "xlsx", storagePath: path } };
  } catch (e) {
    return { toolResult: { error: `xlsx generation failed: ${e instanceof Error ? e.message : String(e)}` } };
  }
}

// --- Elithum (read-only Firestore) ---------------------------------------
// Elithum is a Firebase app; its contracts live in the `entries` Firestore
// collection (project elithium-4a2dd). We sign in with the company login
// (stored as Supabase secrets) and READ ONLY — only ever :runQuery / GET,
// never a write. The web API key is public (it ships in Elithum's client).
const ELITHUM_FB_API_KEY = Deno.env.get("ELITHUM_FB_API_KEY") ?? "AIzaSyCfgmxB0e_31Bz21d0_5OpGqV7BGqJSIho";
const ELITHUM_PROJECT = Deno.env.get("ELITHUM_FB_PROJECT") ?? "elithium-4a2dd";
const FS_DOCS = `https://firestore.googleapis.com/v1/projects/${ELITHUM_PROJECT}/databases/(default)/documents`;
const FS_FIELDS = ["Contract", "Buyer", "Seller", "Growth", "fixedPrice", "shipmentMonth", "DoS", "LC_draft", "Trans_LC", "LC_Num"];

let _elithumTok: { token: string; exp: number } | null = null;
async function elithumIdToken(): Promise<string> {
  if (_elithumTok && Date.now() < _elithumTok.exp - 60_000) return _elithumTok.token;
  const email = Deno.env.get("ELITHUM_EMAIL");
  const password = Deno.env.get("ELITHUM_PASSWORD");
  if (!email || !password) throw new Error("auth: Elithum credentials not configured");
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${ELITHUM_FB_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) throw new Error(`auth: Elithum sign-in ${res.status}`);
  const d = await res.json();
  _elithumTok = { token: d.idToken, exp: Date.now() + (Number(d.expiresIn ?? 3600) * 1000) };
  return d.idToken;
}

// deno-lint-ignore no-explicit-any
function fsUnwrap(v: any): string {
  if (v == null) return "";
  if ("stringValue" in v) return v.stringValue ?? "";
  if ("integerValue" in v) return String(v.integerValue);
  if ("doubleValue" in v) return String(v.doubleValue);
  if ("timestampValue" in v) return v.timestampValue ?? "";
  return "";
}

// Read the `entries` collection (DoS-range scoped), projecting only the fields we
// need (skips the huge nested ips[] arrays). Buyer/seller filtering happens in JS
// (Firestore has no case-insensitive "contains").
async function queryElithumContracts(dateFrom?: string, dateTo?: string): Promise<RawContract[]> {
  const token = await elithumIdToken();
  const filters: unknown[] = [];
  if (dateFrom) filters.push({ fieldFilter: { field: { fieldPath: "DoS" }, op: "GREATER_THAN_OR_EQUAL", value: { stringValue: dateFrom } } });
  if (dateTo) filters.push({ fieldFilter: { field: { fieldPath: "DoS" }, op: "LESS_THAN_OR_EQUAL", value: { stringValue: dateTo } } });
  // deno-lint-ignore no-explicit-any
  const structuredQuery: any = {
    from: [{ collectionId: "entries" }],
    select: { fields: FS_FIELDS.map((f) => ({ fieldPath: f })) },
    limit: 5000,
  };
  if (filters.length === 1) structuredQuery.where = filters[0];
  else if (filters.length > 1) structuredQuery.where = { compositeFilter: { op: "AND", filters } };

  const res = await fetch(`${FS_DOCS}:runQuery`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ structuredQuery }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`firestore ${res.status}`);
  const rows = await res.json();
  const out: RawContract[] = [];
  for (const r of rows ?? []) {
    const doc = r.document;
    if (!doc) continue;
    const f = doc.fields ?? {};
    // deno-lint-ignore no-explicit-any
    const rec: any = {};
    for (const k of FS_FIELDS) rec[k] = fsUnwrap(f[k]);
    out.push(rec);
  }
  // schema guard: a non-empty result with no Contract anywhere means the shape drifted.
  if (out.length && !out.some((r) => r.Contract)) throw new Error("schema drift");
  return out;
}

// Build the Pending-LC xlsx from Elithum. Pending = LC_draft blank. Derivation is
// deterministic (lc_derive.ts). Returns {error} (never throws) so the model narrates failures.
async function runQueryElithum(
  admin: SupabaseClient,
  userId: string,
  // deno-lint-ignore no-explicit-any
  input: any,
  pendingLc: { dateFrom?: string | null; dateTo?: string | null; label?: string } | null,
): Promise<{ toolResult: unknown; artifact?: { name: string; format: string; storagePath: string } }> {
  const dateFrom = (input?.date_from || pendingLc?.dateFrom || "") || undefined;
  const dateTo = (input?.date_to || pendingLc?.dateTo || "") || undefined;
  const buyer = String(input?.buyer ?? "").trim().toLowerCase();
  const seller = String(input?.seller ?? "").trim().toLowerCase();

  let raw: RawContract[];
  try {
    raw = await queryElithumContracts(dateFrom, dateTo);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    if (/^auth|sign-in|40[13]/.test(msg)) return { toolResult: { error: "Couldn't sign in to Elithum (check the connection). Tell the user the Elithum connection failed; do NOT invent any contract data." } };
    if (/schema drift/.test(msg)) return { toolResult: { error: "Elithum's data format changed unexpectedly; do NOT produce a sheet. Tell the user to check the Elithum integration." } };
    return { toolResult: { error: `Couldn't reach Elithum (${msg}). Tell the user; do NOT invent contract data.` } };
  }

  const today = pktTodayISO(new Date());
  // Owner 2026-06-29: show ALL contracts in range + their LC status (no longer
  // filtered to LC_draft-blank). The "LC Draft Received" column carries the status
  // (a date, or "No LC Draft" for the still-pending ones).
  let rows = raw;
  if (buyer) rows = rows.filter((r) => (r.Buyer ?? "").toLowerCase().includes(buyer));
  if (seller) rows = rows.filter((r) => (r.Seller ?? "").toLowerCase().includes(seller));

  if (!rows.length) {
    return { toolResult: { total: 0, as_of_pkt: today, source: "Elithum portal", message: "No contracts match that buyer/seller and date range." } };
  }

  const derived = rows.map((r) => deriveRow(r, today));
  derived.sort((a, b) => b.delayDays - a.delayDays); // overdue first
  const overdue = derived.filter((d) => d.delayDays > 0).length;
  const noDraft = derived.filter((d) => d.pending).length;        // still awaiting LC draft
  const needsReview = derived.filter((d) => d.lcDueStatus === "none").length;
  const who = buyer ? ` ${derived[0].buyer}` : seller ? ` ${derived[0].seller}` : "";
  const title = `LC Status${who} ${today}`.trim();

  const r = await runMakeFile(admin, userId, { title, columns: PENDING_LC_COLUMNS, rows: derived.map(rowToCells) });
  const base = (r.toolResult && typeof r.toolResult === "object") ? r.toolResult as Record<string, unknown> : {};
  if (base.error) return { toolResult: base }; // surface make_file failure verbatim
  return {
    toolResult: { ...base, total: derived.length, no_lc_draft: noDraft, overdue, needs_review: needsReview, as_of_pkt: today, source: "Elithum portal" },
    artifact: r.artifact,
  };
}

// --- Pending Shipments (read-only Firestore, nested ips[].shipments[]) -----
// Shipment data lives two levels deep, so we project the whole `ips` array (the LC
// path's scalar `select` mask can't reach array sub-fields) and walk it in JS.
const FS_FIELDS_SHIPMENTS = [...FS_FIELDS, "ips"];
// Only these shipment keys are ever read — deliberately EXCLUDES `payments[]`
// (amounts/swift/commission) so payment data never enters a sheet or the model.
const SHIPMENT_KEYS = ["inv", "etd", "eta", "bl_number", "shipping_line", "bales", "qs", "shipment_status", "cDocs", "discrepancy_sent", "discrepancy_received"];

// Recursive unwrap of a Firestore REST value (arrays + maps + every scalar type),
// unlike the scalar-only fsUnwrap. Returns plain JS.
// deno-lint-ignore no-explicit-any
function fsDeep(v: any): unknown {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue ?? "";
  if ("integerValue" in v) return String(v.integerValue);
  if ("doubleValue" in v) return String(v.doubleValue);
  if ("timestampValue" in v) return v.timestampValue ?? "";
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) {
    // deno-lint-ignore no-explicit-any
    const out: any = {};
    const fields = v.mapValue?.fields ?? {};
    for (const k of Object.keys(fields)) out[k] = fsDeep(fields[k]);
    return out;
  }
  if ("arrayValue" in v) return (v.arrayValue?.values ?? []).map(fsDeep);
  return null;
}

type ContractWithShipments = { contract: RawContract; shipments: RawShipment[] };

// Read `entries` (DoS-range scoped) WITH the nested ips[], and flatten each contract
// into its shipment objects. Buyer/seller filtering happens in JS (as in the LC path).
async function queryElithumWithShipments(dateFrom?: string, dateTo?: string): Promise<ContractWithShipments[]> {
  const token = await elithumIdToken();
  const filters: unknown[] = [];
  if (dateFrom) filters.push({ fieldFilter: { field: { fieldPath: "DoS" }, op: "GREATER_THAN_OR_EQUAL", value: { stringValue: dateFrom } } });
  if (dateTo) filters.push({ fieldFilter: { field: { fieldPath: "DoS" }, op: "LESS_THAN_OR_EQUAL", value: { stringValue: dateTo } } });
  // deno-lint-ignore no-explicit-any
  const structuredQuery: any = {
    from: [{ collectionId: "entries" }],
    select: { fields: FS_FIELDS_SHIPMENTS.map((f) => ({ fieldPath: f })) },
    limit: 5000,
  };
  if (filters.length === 1) structuredQuery.where = filters[0];
  else if (filters.length > 1) structuredQuery.where = { compositeFilter: { op: "AND", filters } };

  const res = await fetch(`${FS_DOCS}:runQuery`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ structuredQuery }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`firestore ${res.status}`);
  const rows = await res.json();
  const out: ContractWithShipments[] = [];
  let sawShipmentObj = false, sawKnownKey = false;
  for (const r of rows ?? []) {
    const doc = r.document;
    if (!doc) continue;
    const f = doc.fields ?? {};
    // deno-lint-ignore no-explicit-any
    const rec: any = {};
    for (const k of FS_FIELDS) rec[k] = fsUnwrap(f[k]);
    const ips = (fsDeep(f.ips) as { shipments?: unknown[] }[] | null) ?? [];
    const shipments: RawShipment[] = [];
    for (const ip of Array.isArray(ips) ? ips : []) {
      const shs = Array.isArray(ip?.shipments) ? ip.shipments : [];
      for (const sh of shs as Record<string, unknown>[]) {
        if (!sh || typeof sh !== "object") continue;
        sawShipmentObj = true;
        // deno-lint-ignore no-explicit-any
        const pick: any = {};
        for (const k of SHIPMENT_KEYS) {
          if (k in sh) { pick[k] = sh[k] == null ? "" : String(sh[k]); if (sh[k] !== undefined) sawKnownKey = true; }
        }
        // Payment Date from the nested payments[] — DATE ONLY (never amounts/swift,
        // preserving the data-minimization rule). Every shipment has 0 or 1 payment;
        // join defensively in case of multiples.
        const pays = Array.isArray((sh as { payments?: unknown }).payments) ? (sh as { payments: unknown[] }).payments : [];
        const payDates = pays
          .map((p) => (p && typeof p === "object" ? String((p as Record<string, unknown>).payment_date ?? "") : ""))
          .map((s) => s.trim()).filter(Boolean);
        if (payDates.length) pick.payment_date = payDates.join(", ");
        shipments.push(pick);
      }
    }
    out.push({ contract: rec, shipments });
  }
  // schema guards (positive signal only): a non-empty contract result with no Contract
  // anywhere, OR shipment objects that carry none of our known keys → drift. A result
  // with simply zero shipments is VALID and must NOT trip this.
  if (out.length && !out.some((c) => c.contract.Contract)) throw new Error("schema drift");
  if (sawShipmentObj && !sawKnownKey) throw new Error("schema drift");
  return out;
}

// Build the Pending-Shipments xlsx: one row per shipment (straight copy from Elithum),
// scoped by Date of Sale. Cols 1-10 reuse the LC derivation; cols 11-17 are the shipment.
async function runQueryElithumShipments(
  admin: SupabaseClient,
  userId: string,
  // deno-lint-ignore no-explicit-any
  input: any,
  pendingLc: { dateFrom?: string | null; dateTo?: string | null; label?: string } | null,
): Promise<{ toolResult: unknown; artifact?: { name: string; format: string; storagePath: string } }> {
  const dateFrom = (input?.date_from || pendingLc?.dateFrom || "") || undefined;
  const dateTo = (input?.date_to || pendingLc?.dateTo || "") || undefined;
  const buyer = String(input?.buyer ?? "").trim().toLowerCase();
  const seller = String(input?.seller ?? "").trim().toLowerCase();

  let raw: ContractWithShipments[];
  try {
    raw = await queryElithumWithShipments(dateFrom, dateTo);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    if (/^auth|sign-in|40[13]/.test(msg)) return { toolResult: { error: "Couldn't sign in to Elithum (check the connection). Tell the user the Elithum connection failed; do NOT invent any contract data." } };
    if (/schema drift/.test(msg)) return { toolResult: { error: "Elithum's data format changed unexpectedly; do NOT produce a sheet. Tell the user to check the Elithum integration." } };
    return { toolResult: { error: `Couldn't reach Elithum (${msg}). Tell the user; do NOT invent contract data.` } };
  }

  const today = pktTodayISO(new Date());
  let scoped = raw;
  if (buyer) scoped = scoped.filter((c) => (c.contract.Buyer ?? "").toLowerCase().includes(buyer));
  if (seller) scoped = scoped.filter((c) => (c.contract.Seller ?? "").toLowerCase().includes(seller));

  // Flatten: one row per real shipment (simple copy — contracts with no shipment
  // produce no row). Track distinct contracts for honest counts (Eng F2).
  const rows: ShipmentRow[] = [];
  const contractsWithRows = new Set<string>();
  const overdueContracts = new Set<string>();
  for (const c of scoped) {
    for (const sh of c.shipments) {
      const row = deriveShipmentRow(c.contract, sh, today);
      rows.push(row);
      contractsWithRows.add(row.contract);
      if (row.delayDays > 0) overdueContracts.add(row.contract);
    }
  }
  if (!rows.length) {
    return { toolResult: { rows: 0, as_of_pkt: today, source: "Elithum portal", message: "No shipments match that buyer/seller and date range." } };
  }
  rows.sort((a, b) => b.delayDays - a.delayDays); // overdue first (same signal as LC)
  // Pre-truncate to the make_file cap so a wide range degrades gracefully (Eng F7).
  const MAX = 5000;
  const truncated = rows.length > MAX;
  const finalRows = truncated ? rows.slice(0, MAX) : rows;

  const who = buyer ? ` ${finalRows[0].buyer}` : seller ? ` ${finalRows[0].seller}` : "";
  const title = `Pending Shipments${who} ${today}`.trim();
  const r = await runMakeFile(admin, userId, { title, columns: PENDING_SHIPMENTS_COLUMNS, rows: finalRows.map(shipmentRowToCells) });
  const base = (r.toolResult && typeof r.toolResult === "object") ? r.toolResult as Record<string, unknown> : {};
  if (base.error) return { toolResult: base };
  return {
    toolResult: {
      ...base,
      rows: finalRows.length,
      contracts: contractsWithRows.size,
      overdue_contracts: overdueContracts.size,
      truncated,
      as_of_pkt: today,
      source: "Elithum portal",
    },
    artifact: r.artifact,
  };
}

// --- Pending IPs (read-only Firestore, ips[] level) ------------------------
// One row per IP. Needs contract scalars + the on-call `price` (for the "Price"
// column fallback) + the nested ips[]. IP sub-fields are read via fsDeep.
const FS_FIELDS_IPS = [...FS_FIELDS, "price", "ips"];
const IP_KEYS = ["IP_number", "IP_start", "IP_end", "IP_quantity", "IP_sent"];

type ContractWithIPs = { contract: RawContract; ips: RawIP[] };

async function queryElithumWithIPs(dateFrom?: string, dateTo?: string): Promise<ContractWithIPs[]> {
  const token = await elithumIdToken();
  const filters: unknown[] = [];
  if (dateFrom) filters.push({ fieldFilter: { field: { fieldPath: "DoS" }, op: "GREATER_THAN_OR_EQUAL", value: { stringValue: dateFrom } } });
  if (dateTo) filters.push({ fieldFilter: { field: { fieldPath: "DoS" }, op: "LESS_THAN_OR_EQUAL", value: { stringValue: dateTo } } });
  // deno-lint-ignore no-explicit-any
  const structuredQuery: any = {
    from: [{ collectionId: "entries" }],
    select: { fields: FS_FIELDS_IPS.map((f) => ({ fieldPath: f })) },
    limit: 5000,
  };
  if (filters.length === 1) structuredQuery.where = filters[0];
  else if (filters.length > 1) structuredQuery.where = { compositeFilter: { op: "AND", filters } };

  const res = await fetch(`${FS_DOCS}:runQuery`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ structuredQuery }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`firestore ${res.status}`);
  const rows = await res.json();
  const out: ContractWithIPs[] = [];
  let sawIpObj = false, sawKnownKey = false;
  for (const r of rows ?? []) {
    const doc = r.document;
    if (!doc) continue;
    const f = doc.fields ?? {};
    // deno-lint-ignore no-explicit-any
    const rec: any = {};
    for (const k of FS_FIELDS) rec[k] = fsUnwrap(f[k]);
    rec.price = fsUnwrap(f.price);
    const ipsRaw = (fsDeep(f.ips) as Record<string, unknown>[] | null) ?? [];
    const ips: RawIP[] = [];
    for (const ip of Array.isArray(ipsRaw) ? ipsRaw : []) {
      if (!ip || typeof ip !== "object") continue;
      sawIpObj = true;
      // deno-lint-ignore no-explicit-any
      const pick: any = {};
      for (const k of IP_KEYS) {
        if (k in ip) { pick[k] = ip[k] == null ? "" : String(ip[k]); sawKnownKey = true; }
      }
      ips.push(pick);
    }
    out.push({ contract: rec, ips });
  }
  if (out.length && !out.some((c) => c.contract.Contract)) throw new Error("schema drift");
  if (sawIpObj && !sawKnownKey) throw new Error("schema drift");
  return out;
}

// Build the Pending-IPs xlsx: one row per IP (contracts with no IP produce no row).
async function runQueryElithumIPs(
  admin: SupabaseClient,
  userId: string,
  // deno-lint-ignore no-explicit-any
  input: any,
  pendingLc: { dateFrom?: string | null; dateTo?: string | null; label?: string } | null,
): Promise<{ toolResult: unknown; artifact?: { name: string; format: string; storagePath: string } }> {
  const dateFrom = (input?.date_from || pendingLc?.dateFrom || "") || undefined;
  const dateTo = (input?.date_to || pendingLc?.dateTo || "") || undefined;
  const buyer = String(input?.buyer ?? "").trim().toLowerCase();
  const seller = String(input?.seller ?? "").trim().toLowerCase();

  let raw: ContractWithIPs[];
  try {
    raw = await queryElithumWithIPs(dateFrom, dateTo);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    if (/^auth|sign-in|40[13]/.test(msg)) return { toolResult: { error: "Couldn't sign in to Elithum (check the connection). Tell the user the Elithum connection failed; do NOT invent any contract data." } };
    if (/schema drift/.test(msg)) return { toolResult: { error: "Elithum's data format changed unexpectedly; do NOT produce a sheet. Tell the user to check the Elithum integration." } };
    return { toolResult: { error: `Couldn't reach Elithum (${msg}). Tell the user; do NOT invent contract data.` } };
  }

  const today = pktTodayISO(new Date());
  let scoped = raw;
  if (buyer) scoped = scoped.filter((c) => (c.contract.Buyer ?? "").toLowerCase().includes(buyer));
  if (seller) scoped = scoped.filter((c) => (c.contract.Seller ?? "").toLowerCase().includes(seller));

  const rows: IPRow[] = [];
  const contractsWithRows = new Set<string>();
  let notSent = 0;
  for (const c of scoped) {
    for (const ip of c.ips) {
      const row = deriveIPRow(c.contract, ip);
      rows.push(row);
      contractsWithRows.add(row.contract);
      if (!row.ipSent) notSent++;
    }
  }
  if (!rows.length) {
    return { toolResult: { rows: 0, as_of_pkt: today, source: "Elithum portal", message: "No IPs match that buyer/seller and date range." } };
  }
  rows.sort((a, b) => (b.ipStart || "").localeCompare(a.ipStart || "")); // newest IP first
  const MAX = 5000;
  const truncated = rows.length > MAX;
  const finalRows = truncated ? rows.slice(0, MAX) : rows;

  const who = buyer ? ` ${finalRows[0].buyer}` : seller ? ` ${finalRows[0].seller}` : "";
  const title = `Pending IPs${who} ${today}`.trim();
  const r = await runMakeFile(admin, userId, { title, columns: PENDING_IPS_COLUMNS, rows: finalRows.map(ipRowToCells) });
  const base = (r.toolResult && typeof r.toolResult === "object") ? r.toolResult as Record<string, unknown> : {};
  if (base.error) return { toolResult: base };
  return {
    toolResult: {
      ...base,
      rows: finalRows.length,
      contracts: contractsWithRows.size,
      not_sent: notSent,
      truncated,
      as_of_pkt: today,
      source: "Elithum portal",
    },
    artifact: r.artifact,
  };
}

// Build the Pending-Docs xlsx: one row per shipment with document columns. Reuses
// the shipments query (SHIPMENT_KEYS already include cDocs/discrepancy_*).
async function runQueryElithumDocs(
  admin: SupabaseClient,
  userId: string,
  // deno-lint-ignore no-explicit-any
  input: any,
  pendingLc: { dateFrom?: string | null; dateTo?: string | null; label?: string } | null,
): Promise<{ toolResult: unknown; artifact?: { name: string; format: string; storagePath: string } }> {
  const dateFrom = (input?.date_from || pendingLc?.dateFrom || "") || undefined;
  const dateTo = (input?.date_to || pendingLc?.dateTo || "") || undefined;
  const buyer = String(input?.buyer ?? "").trim().toLowerCase();
  const seller = String(input?.seller ?? "").trim().toLowerCase();

  let raw: ContractWithShipments[];
  try {
    raw = await queryElithumWithShipments(dateFrom, dateTo);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    if (/^auth|sign-in|40[13]/.test(msg)) return { toolResult: { error: "Couldn't sign in to Elithum (check the connection). Tell the user the Elithum connection failed; do NOT invent any contract data." } };
    if (/schema drift/.test(msg)) return { toolResult: { error: "Elithum's data format changed unexpectedly; do NOT produce a sheet. Tell the user to check the Elithum integration." } };
    return { toolResult: { error: `Couldn't reach Elithum (${msg}). Tell the user; do NOT invent contract data.` } };
  }

  const today = pktTodayISO(new Date());
  let scoped = raw;
  if (buyer) scoped = scoped.filter((c) => (c.contract.Buyer ?? "").toLowerCase().includes(buyer));
  if (seller) scoped = scoped.filter((c) => (c.contract.Seller ?? "").toLowerCase().includes(seller));

  const rows: DocsRow[] = [];
  const contractsWithRows = new Set<string>();
  let withCopyDocs = 0;
  for (const c of scoped) {
    for (const sh of c.shipments) {
      const row = deriveDocsRow(c.contract, sh);
      rows.push(row);
      contractsWithRows.add(row.contract);
      if (row.copyDocs) withCopyDocs++;
    }
  }
  if (!rows.length) {
    return { toolResult: { rows: 0, as_of_pkt: today, source: "Elithum portal", message: "No shipments match that buyer/seller and date range." } };
  }
  rows.sort((a, b) => (b.etd || "").localeCompare(a.etd || "")); // most recent departure first
  const MAX = 5000;
  const truncated = rows.length > MAX;
  const finalRows = truncated ? rows.slice(0, MAX) : rows;

  const who = buyer ? ` ${finalRows[0].buyer}` : seller ? ` ${finalRows[0].seller}` : "";
  const title = `Pending Docs${who} ${today}`.trim();
  const r = await runMakeFile(admin, userId, { title, columns: PENDING_DOCS_COLUMNS, rows: finalRows.map(docsRowToCells) });
  const base = (r.toolResult && typeof r.toolResult === "object") ? r.toolResult as Record<string, unknown> : {};
  if (base.error) return { toolResult: base };
  return {
    toolResult: {
      ...base,
      rows: finalRows.length,
      contracts: contractsWithRows.size,
      with_copy_docs: withCopyDocs,
      truncated,
      as_of_pkt: today,
      source: "Elithum portal",
    },
    artifact: r.artifact,
  };
}

// Build the Pending-Payments xlsx: Pending Docs + a Payment Date column. Reuses the
// shipments query (payment_date is extracted there, date-only).
async function runQueryElithumPayments(
  admin: SupabaseClient,
  userId: string,
  // deno-lint-ignore no-explicit-any
  input: any,
  pendingLc: { dateFrom?: string | null; dateTo?: string | null; label?: string } | null,
): Promise<{ toolResult: unknown; artifact?: { name: string; format: string; storagePath: string } }> {
  const dateFrom = (input?.date_from || pendingLc?.dateFrom || "") || undefined;
  const dateTo = (input?.date_to || pendingLc?.dateTo || "") || undefined;
  const buyer = String(input?.buyer ?? "").trim().toLowerCase();
  const seller = String(input?.seller ?? "").trim().toLowerCase();

  let raw: ContractWithShipments[];
  try {
    raw = await queryElithumWithShipments(dateFrom, dateTo);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    if (/^auth|sign-in|40[13]/.test(msg)) return { toolResult: { error: "Couldn't sign in to Elithum (check the connection). Tell the user the Elithum connection failed; do NOT invent any contract data." } };
    if (/schema drift/.test(msg)) return { toolResult: { error: "Elithum's data format changed unexpectedly; do NOT produce a sheet. Tell the user to check the Elithum integration." } };
    return { toolResult: { error: `Couldn't reach Elithum (${msg}). Tell the user; do NOT invent contract data.` } };
  }

  const today = pktTodayISO(new Date());
  let scoped = raw;
  if (buyer) scoped = scoped.filter((c) => (c.contract.Buyer ?? "").toLowerCase().includes(buyer));
  if (seller) scoped = scoped.filter((c) => (c.contract.Seller ?? "").toLowerCase().includes(seller));

  const rows: PaymentsRow[] = [];
  const contractsWithRows = new Set<string>();
  let withPayment = 0;
  for (const c of scoped) {
    for (const sh of c.shipments) {
      const row = derivePaymentsRow(c.contract, sh);
      rows.push(row);
      contractsWithRows.add(row.contract);
      if (row.paymentDate) withPayment++;
    }
  }
  if (!rows.length) {
    return { toolResult: { rows: 0, as_of_pkt: today, source: "Elithum portal", message: "No shipments match that buyer/seller and date range." } };
  }
  rows.sort((a, b) => (b.etd || "").localeCompare(a.etd || ""));
  const MAX = 5000;
  const truncated = rows.length > MAX;
  const finalRows = truncated ? rows.slice(0, MAX) : rows;

  const who = buyer ? ` ${finalRows[0].buyer}` : seller ? ` ${finalRows[0].seller}` : "";
  const title = `Pending Payments${who} ${today}`.trim();
  const r = await runMakeFile(admin, userId, { title, columns: PENDING_PAYMENTS_COLUMNS, rows: finalRows.map(paymentsRowToCells) });
  const base = (r.toolResult && typeof r.toolResult === "object") ? r.toolResult as Record<string, unknown> : {};
  if (base.error) return { toolResult: base };
  return {
    toolResult: {
      ...base,
      rows: finalRows.length,
      contracts: contractsWithRows.size,
      with_payment: withPayment,
      truncated,
      as_of_pkt: today,
      source: "Elithum portal",
    },
    artifact: r.artifact,
  };
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
- When the user asks about a SPECIFIC email, sender, or broker, call \`get_email\` — it returns the
  email and ALL of its attachments and extracted offers at once. Consider EVERY attachment it
  returns, not just the first; if you need the raw text of a specific one, follow up with
  \`read_attachment\`. Never answer about an email after looking at only one of its documents.
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
