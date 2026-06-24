import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.0";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { cors, json } from "../_shared/cors.ts";
import { DEFAULT_EXTRACT_MODEL, extractStructured } from "../_shared/anthropic.ts";
import {
  EXTRACTION_INSTRUCTIONS,
  EXTRACTION_SCHEMA,
  type ExtractionResult,
} from "../_shared/extraction_schema.ts";

// extract_offers — turn fetched attachments + email bodies into structured
// cotton_offers / cotton_recaps via Claude structured outputs, grounded in the
// owner's reference documents (D13). Idempotent: offer_fingerprint ON CONFLICT.
// Processes a capped batch per invocation so it stays within Edge time limits;
// call repeatedly (scheduler) until `remaining` is 0.

const DEFAULT_MAX_ATTACHMENTS = 3;
const DEFAULT_MAX_BODIES = 6;
const MAX_REF_CHARS = 40_000;
const MAX_EXCEL_CHARS = 60_000;
const MAX_BODY_CHARS = 40_000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const syncSecret = Deno.env.get("MAILBOX_SYNC_SECRET") ?? "";
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  const model = Deno.env.get("ANTHROPIC_EXTRACT_MODEL") ?? DEFAULT_EXTRACT_MODEL;
  // medium effort is plenty for structured extraction and much cheaper/faster than high.
  const extractEffort = (Deno.env.get("ANTHROPIC_EXTRACT_EFFORT") ?? "medium") as "low" | "medium" | "high";

  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not configured" }, 500);

  // Authorize: shared sync secret (scheduler) or any authenticated user (shared pool).
  const presentedSecret = req.headers.get("x-sync-secret");
  let authorized = !!syncSecret && presentedSecret === syncSecret;
  if (!authorized) {
    const authHeader = req.headers.get("Authorization");
    if (authHeader) {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user } } = await userClient.auth.getUser();
      if (user) authorized = true;
    }
  }
  if (!authorized) return json({ error: "Unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceKey);

  let body: { maxAttachments?: number; maxBodies?: number } = {};
  try { body = await req.json(); } catch { /* empty ok */ }
  const maxAttachments = Math.min(body.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS, 10);
  const maxBodies = Math.min(body.maxBodies ?? DEFAULT_MAX_BODIES, 20);

  // --- Grounding: active reference documents (cached on the Anthropic side) ---
  const { data: refDocs } = await db
    .from("reference_documents")
    .select("name, description, parsed_content, decode_version")
    .eq("is_active", true);
  let refText = "";
  let decodeVersion = 1;
  for (const r of refDocs ?? []) {
    decodeVersion = Math.max(decodeVersion, r.decode_version ?? 1);
    if (r.parsed_content) {
      refText += `\n\n# ${r.name}${r.description ? ` — ${r.description}` : ""}\n${r.parsed_content}`;
    }
  }
  refText = refText.slice(0, MAX_REF_CHARS).trim();

  const systemBlocks = [
    { type: "text" as const, text: EXTRACTION_INSTRUCTIONS, cache_control: { type: "ephemeral" as const } },
    {
      type: "text" as const,
      text: refText
        ? `REFERENCE DOCUMENTS (authoritative grounding for field meanings, grade decoding, certifications):\n${refText}`
        : "REFERENCE DOCUMENTS: (none provided yet — extract raw values verbatim and flag interpretation-dependent fields with needs_review=true).",
      cache_control: { type: "ephemeral" as const },
    },
  ];

  let offersWritten = 0;
  let recapsWritten = 0;
  const errors: Array<{ kind: string; id: string; error: string }> = [];

  const refDecodeVersion = decodeVersion;

  const persist = async (
    result: ExtractionResult,
    sourceEmailId: string,
    sourceAttachmentId: string | null,
    fallbackOfferDate: string | null,
    fallbackBroker: string | null,
  ) => {
    if (result.offers?.length) {
      const rows = result.offers.map((o) => ({
        source_email_id: sourceEmailId,
        source_attachment_id: sourceAttachmentId,
        line_index: o.line_index ?? 0,
        broker: o.broker ?? fallbackBroker,
        origin_country: o.origin_country,
        region: o.region,
        certifications: o.certifications,
        grade_raw: o.grade_raw,
        color: o.color,
        leaf: o.leaf,
        staple_32nds: o.staple_32nds,
        staple_fraction: o.staple_fraction,
        mic: o.mic,
        gpt: o.gpt,
        length: o.length,
        uniformity: o.uniformity,
        quantity_bales: o.quantity_bales,
        price_type: o.price_type ?? "none",
        price_basis_points: o.price_basis_points,
        price_outright_cents: o.price_outright_cents,
        futures_month: o.futures_month,
        crop_year: o.crop_year,
        shipment_period: o.shipment_period,
        recap_code: o.recap_code,
        raw_line_text: o.raw_line_text,
        offer_date: o.offer_date ?? fallbackOfferDate,
        confidence: o.confidence,
        needs_review: o.needs_review ?? false,
        decode_version: refDecodeVersion,
      }));
      const { error, count } = await db
        .from("cotton_offers")
        .upsert(rows, { onConflict: "offer_fingerprint", count: "exact" });
      if (error) throw new Error(`offers upsert: ${error.message}`);
      offersWritten += count ?? rows.length;
    }
    if (result.recap && (result.doc_kind === "recap" || result.doc_kind === "mixed")) {
      const r = result.recap;
      const { error } = await db.from("cotton_recaps").upsert({
        source_email_id: sourceEmailId,
        source_attachment_id: sourceAttachmentId,
        recap_code: r.recap_code,
        broker: r.broker ?? fallbackBroker,
        crop_year: r.crop_year,
        total_bales: r.total_bales,
        avg_mic: r.avg_mic,
        avg_staple: r.avg_staple,
        avg_gpt: r.avg_gpt,
        avg_length: r.avg_length,
        avg_uniformity: r.avg_uniformity,
        distributions: parseDistributions(r.distributions),
        confidence: r.confidence,
        needs_review: r.needs_review ?? false,
        decode_version: refDecodeVersion,
      }, { onConflict: "recap_fingerprint" });
      if (error) throw new Error(`recap upsert: ${error.message}`);
      recapsWritten += 1;
    }
  };

  // --- 1. Pending attachments (pdf / excel) ---
  const { data: attachments } = await db
    .from("email_attachments")
    .select("id, email_id, filename, mime_type, kind, storage_path")
    .eq("extraction_status", "pending")
    .in("kind", ["pdf", "excel"])
    .limit(maxAttachments);

  for (const att of attachments ?? []) {
    try {
      const { data: file, error: dlErr } = await db.storage
        .from("email-attachments").download(att.storage_path);
      if (dlErr || !file) throw new Error(dlErr?.message ?? "download failed");
      const bytes = new Uint8Array(await file.arrayBuffer());

      const { data: emailRow } = await db
        .from("email_messages").select("date_sent, broker_guess, from_name")
        .eq("id", att.email_id).maybeSingle();
      const fallbackDate = emailRow?.date_sent ? emailRow.date_sent.slice(0, 10) : null;
      const fallbackBroker = emailRow?.broker_guess ?? emailRow?.from_name ?? null;

      const userContent = buildUserContent(att.kind, att.filename, bytes);
      const { data } = await extractStructured({
        apiKey, model, system: systemBlocks, userContent, schema: EXTRACTION_SCHEMA, effort: extractEffort,
      });
      await persist(data as ExtractionResult, att.email_id, att.id, fallbackDate, fallbackBroker);

      await db.from("email_attachments")
        .update({ extraction_status: "done", error_message: null }).eq("id", att.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ kind: "attachment", id: att.id, error: msg });
      await db.from("email_attachments")
        .update({ extraction_status: "error", error_message: msg.slice(0, 2000) }).eq("id", att.id);
    }
  }

  // --- 2. Email bodies (offers that arrive as plain text) ---
  const { data: emails } = await db
    .from("email_messages")
    .select("id, body_text, date_sent, broker_guess, from_name")
    .eq("sync_status", "fetched")
    .not("body_text", "is", null)
    .limit(maxBodies);

  for (const em of emails ?? []) {
    try {
      const text = (em.body_text ?? "").slice(0, MAX_BODY_CHARS).trim();
      if (text.length < 20) {
        await db.from("email_messages").update({ sync_status: "extracted" }).eq("id", em.id);
        continue;
      }
      const fallbackDate = em.date_sent ? em.date_sent.slice(0, 10) : null;
      const fallbackBroker = em.broker_guess ?? em.from_name ?? null;
      const userContent = [{
        type: "text",
        text: `EMAIL BODY (extract any cotton offers stated directly in the text):\n\n${text}`,
      }];
      const { data } = await extractStructured({
        apiKey, model, system: systemBlocks, userContent, schema: EXTRACTION_SCHEMA, effort: extractEffort,
      });
      await persist(data as ExtractionResult, em.id, null, fallbackDate, fallbackBroker);
      await db.from("email_messages")
        .update({ sync_status: "extracted", error_message: null }).eq("id", em.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ kind: "body", id: em.id, error: msg });
      await db.from("email_messages")
        .update({ sync_status: "error", error_message: msg.slice(0, 2000) }).eq("id", em.id);
    }
  }

  // How much work is left, so the scheduler knows whether to call again.
  const { count: pendingAtt } = await db.from("email_attachments")
    .select("id", { count: "exact", head: true })
    .eq("extraction_status", "pending").in("kind", ["pdf", "excel"]);
  const { count: pendingBody } = await db.from("email_messages")
    .select("id", { count: "exact", head: true })
    .eq("sync_status", "fetched").not("body_text", "is", null);

  return json({
    ok: true,
    offersWritten,
    recapsWritten,
    attachmentsProcessed: (attachments ?? []).length,
    bodiesProcessed: (emails ?? []).length,
    errors,
    remaining: (pendingAtt ?? 0) + (pendingBody ?? 0),
  });
});

function buildUserContent(
  kind: string,
  filename: string,
  bytes: Uint8Array,
): Array<Record<string, unknown>> {
  if (kind === "pdf") {
    // PDF as a base64 document block (placed before the instruction text).
    const b64 = bytesToBase64(bytes);
    return [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
      { type: "text", text: `Extract every cotton offer from this PDF ("${filename}").` },
    ];
  }
  // Excel -> CSV/markdown text (reusing the xlsx pattern from ingest_sheet).
  const text = excelToText(bytes).slice(0, MAX_EXCEL_CHARS);
  return [{
    type: "text",
    text: `Extract every cotton offer from this spreadsheet ("${filename}"). Sheet contents follow:\n\n${text}`,
  }];
}

// distributions arrives as a JSON string (structured outputs forbid open objects).
function parseDistributions(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return { raw: s }; }
}

function excelToText(bytes: Uint8Array): string {
  const book = XLSX.read(bytes, { type: "array", cellDates: true });
  let out = "";
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    if (!sheet) continue;
    out += `## ${name}\n` + XLSX.utils.sheet_to_csv(sheet) + "\n\n";
  }
  return out.trim();
}

// Base64 without newlines (Anthropic requires a single continuous string).
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
