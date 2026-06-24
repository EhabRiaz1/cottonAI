import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.0";
import { cors, json } from "../_shared/cors.ts";
import {
  b64urlToBytes,
  classifyAttachment,
  getAccessToken,
  getAttachmentBytes,
  getMessage,
  getProfile,
  type GmailCreds,
  listHistory,
  listMessages,
  parseMessage,
  sha256Hex,
} from "../_shared/gmail.ts";

// mailbox_sync — pull new mail from the fixed Gmail mailbox over HTTPS and land
// raw email + attachment rows. Extraction is a SEPARATE function (extract_offers)
// so each stays within Edge wall-clock limits. See GMAIL_COTTON_INTEGRATION_PLAN.md.
//
// Auth: either the shared MAILBOX_SYNC_SECRET (header `x-sync-secret`, used by the
// scheduler) OR a platform-admin user JWT (the admin "Sync now" button). All DB
// writes use the service role (bypasses RLS); credentials never leave the server.

const DEFAULT_BACKFILL_DAYS = 90; // §10 validate-first: cap first run, lazy-backfill older
const DEFAULT_MAX_MESSAGES = 6;  // per invocation; scheduler/client loops on hasMore.
                                  // Kept small so a page of attachment-heavy emails
                                  // finishes well under the 150s Edge wall-clock limit.

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const syncSecret = Deno.env.get("MAILBOX_SYNC_SECRET") ?? "";
  const mailboxEmail = Deno.env.get("MAILBOX_EMAIL") ?? "";

  const creds: GmailCreds = {
    clientId: Deno.env.get("GMAIL_CLIENT_ID") ?? "",
    clientSecret: Deno.env.get("GMAIL_CLIENT_SECRET") ?? "",
    refreshToken: Deno.env.get("GMAIL_REFRESH_TOKEN") ?? "",
  };

  if (!mailboxEmail) return json({ error: "MAILBOX_EMAIL not configured" }, 500);
  if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
    return json({ error: "Gmail OAuth secrets not configured (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN)" }, 500);
  }

  // --- Authorize the trigger -----------------------------------------------
  const presentedSecret = req.headers.get("x-sync-secret");
  let authorized = false;
  if (syncSecret && presentedSecret && presentedSecret === syncSecret) {
    authorized = true;
  } else {
    // Any authenticated user can sync — the mailbox is a shared global pool, so a
    // sync just refreshes data everyone sees. (Scheduler uses x-sync-secret above.)
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

  let body: {
    mode?: "sync" | "status";
    trigger?: "manual" | "scheduled" | "backfill";
    backfillDays?: number;
    maxMessages?: number;
    pageToken?: string;
  } = {};
  try {
    body = await req.json();
  } catch { /* empty body is fine */ }

  // One-shot diagnostic: inspect the real attachment structure of recent emails
  // and probe one attachment fetch. Does NOT write anything.
  if (body.mode === "debug") {
    try {
      const token = await getAccessToken(creds);
      const { ids } = await listMessages(token, { query: "newer_than:90d", maxResults: 5 });
      const report: unknown[] = [];
      for (const id of ids.slice(0, 3)) {
        const msg = await getMessage(token, id);
        const parsed = parseMessage(msg);
        const atts = parsed.attachments.map((a) => ({
          filename: a.filename, mime: a.mimeType, size: a.size,
          hasInline: !!a.inlineData, hasAttachmentId: !!a.attachmentId,
          attachmentIdLen: a.attachmentId?.length ?? 0,
        }));
        let probe: unknown = null;
        const fetchable = parsed.attachments.find((a) => !a.inlineData && a.attachmentId);
        if (fetchable) {
          const r = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/attachments/${fetchable.attachmentId}`,
            { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25_000) },
          );
          const ct = r.headers.get("content-type");
          const text = await r.text();
          probe = { filename: fetchable.filename, status: r.status, contentType: ct, bodyHead: text.slice(0, 200) };
        }
        report.push({ subject: parsed.subject, attachments: atts, probe });
      }
      return json({ ok: true, report });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Lightweight connection check: verify the OAuth token works and read the
  // mailbox profile. Does NOT sync. Powers the "Connected" badge in the UI.
  if (body.mode === "status") {
    try {
      const token = await getAccessToken(creds);
      const profile = await getProfile(token);
      const { data: st } = await db
        .from("mailbox_state").select("last_synced_at").eq("mailbox_email", mailboxEmail).maybeSingle();
      return json({
        connected: true,
        mailbox: profile.emailAddress,
        expectedMailbox: mailboxEmail,
        mailboxMismatch: profile.emailAddress?.toLowerCase() !== mailboxEmail.toLowerCase(),
        lastSyncedAt: st?.last_synced_at ?? null,
      });
    } catch (e) {
      return json({ connected: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const trigger = body.trigger ?? "manual";
  const maxMessages = Math.min(body.maxMessages ?? DEFAULT_MAX_MESSAGES, 100);

  // --- Open a sync_runs row ------------------------------------------------
  const { data: runRow } = await db
    .from("sync_runs")
    .insert({ mailbox_email: mailboxEmail, trigger, status: "running" })
    .select("id").single();
  const runId = runRow?.id as string | undefined;

  const fail = async (message: string, status = 500) => {
    if (runId) {
      await db.from("sync_runs").update({
        status: "error", error_message: message.slice(0, 2000), finished_at: new Date().toISOString(),
      }).eq("id", runId);
    }
    return json({ error: message, runId }, status);
  };

  try {
    const token = await getAccessToken(creds);
    const profile = await getProfile(token); // historyId captured at start of run

    // Load (or create) mailbox bookkeeping.
    const { data: stateRow } = await db
      .from("mailbox_state").select("*").eq("mailbox_email", mailboxEmail).maybeSingle();
    let state = stateRow;
    if (!state) {
      const { data: created } = await db
        .from("mailbox_state").insert({ mailbox_email: mailboxEmail }).select("*").single();
      state = created;
    }

    // --- Decide which message ids to consider ------------------------------
    let candidateIds: string[] = [];
    let nextPageToken: string | null = null;
    let backfillMode = false;

    const doBackfill = async () => {
      backfillMode = true;
      const days = body.backfillDays ?? DEFAULT_BACKFILL_DAYS;
      const { ids, nextPageToken: npt } = await listMessages(token, {
        query: `newer_than:${days}d`,
        pageToken: body.pageToken,
        maxResults: maxMessages,
      });
      candidateIds = ids;
      nextPageToken = npt;
    };

    if (trigger === "backfill" || !state?.last_history_id) {
      await doBackfill();
    } else {
      const hist = await listHistory(token, state.last_history_id);
      if (hist.expired) {
        await doBackfill(); // cursor too old -> safe full re-scan (idempotent dedup)
      } else {
        candidateIds = hist.ids.slice(0, maxMessages);
      }
    }

    // Filter out messages we already have (idempotent re-sync).
    let newIds = candidateIds;
    if (candidateIds.length) {
      const { data: existing } = await db
        .from("email_messages").select("gmail_message_id")
        .in("gmail_message_id", candidateIds);
      const have = new Set((existing ?? []).map((r) => r.gmail_message_id));
      newIds = candidateIds.filter((id) => !have.has(id));
    }

    // --- Fetch + store each new message ------------------------------------
    let emailsNew = 0;
    let attachmentsNew = 0;
    for (const id of newIds) {
      const msg = await getMessage(token, id);
      const parsed = parseMessage(msg);

      const { data: inserted, error: insErr } = await db
        .from("email_messages")
        .upsert({
          mailbox_email: mailboxEmail,
          gmail_message_id: parsed.gmailMessageId,
          rfc_message_id: parsed.rfcMessageId,
          from_address: parsed.fromAddress,
          from_name: parsed.fromName,
          broker_guess: parsed.fromName ?? parsed.fromAddress,
          subject: parsed.subject,
          date_sent: parsed.dateSent,
          snippet: parsed.snippet,
          has_attachments: parsed.attachments.length > 0,
          body_text: parsed.bodyText,
          sync_status: "fetched",
        }, { onConflict: "rfc_message_id", ignoreDuplicates: true })
        .select("id").maybeSingle();

      if (insErr || !inserted) continue; // conflict (already stored) -> skip
      emailsNew++;
      const emailId = inserted.id as string;

      let attIdx = 0;
      for (const att of parsed.attachments) {
        attIdx++;
        // Only PDFs and spreadsheets carry offers. Skip signature images / logos /
        // other noise entirely — don't even download them (saves time + storage).
        const kind = classifyAttachment(att.filename, att.mimeType);
        if (kind === "other") continue;
        try {
          // Inline data (small files) is already in the payload; only fetch when
          // the bytes were offloaded to an attachmentId.
          let bytes: Uint8Array;
          if (att.inlineData) {
            bytes = b64urlToBytes(att.inlineData);
          } else if (att.attachmentId) {
            bytes = await getAttachmentBytes(token, id, att.attachmentId);
          } else {
            continue; // nothing to fetch
          }
          const hash = await sha256Hex(bytes);
          const safeName = att.filename.replace(/[^\w.\-]+/g, "_").slice(0, 120);
          const storagePath = `${emailId}/${attIdx}_${safeName}`;
          await db.storage.from("email-attachments").upload(storagePath, bytes, {
            contentType: att.mimeType, upsert: true,
          });
          const { error: attErr } = await db
            .from("email_attachments")
            .upsert({
              email_id: emailId,
              filename: att.filename,
              mime_type: att.mimeType,
              kind,
              storage_path: storagePath,
              size_bytes: bytes.length,
              content_hash: hash,
              extraction_status: kind === "other" ? "unsupported" : "pending",
            }, { onConflict: "email_id,content_hash", ignoreDuplicates: true });
          if (attErr) throw new Error(`attachment upsert: ${attErr.message}`);
          attachmentsNew++;
        } catch (e) {
          // Record the attachment row with an error rather than failing the whole sync.
          await db.from("email_attachments").insert({
            email_id: emailId,
            filename: att.filename,
            mime_type: att.mimeType,
            kind: classifyAttachment(att.filename, att.mimeType),
            extraction_status: "error",
            error_message: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    // --- Advance the incremental cursor ------------------------------------
    // In backfill mode, only advance once we've consumed the whole window
    // (no more pages) so we never skip older mail. Incremental always advances.
    const backfillComplete = backfillMode && !nextPageToken;
    if (!backfillMode || backfillComplete) {
      await db.from("mailbox_state").update({
        last_history_id: profile.historyId,
        last_synced_at: new Date().toISOString(),
      }).eq("mailbox_email", mailboxEmail);
    } else {
      await db.from("mailbox_state").update({
        last_synced_at: new Date().toISOString(),
      }).eq("mailbox_email", mailboxEmail);
    }

    if (runId) {
      await db.from("sync_runs").update({
        emails_seen: candidateIds.length,
        emails_new: emailsNew,
        attachments_new: attachmentsNew,
        status: "success",
        finished_at: new Date().toISOString(),
      }).eq("id", runId);
    }

    const hasMore = backfillMode && !!nextPageToken;
    return json({
      ok: true,
      runId,
      mode: backfillMode ? "backfill" : "incremental",
      emailsSeen: candidateIds.length,
      emailsNew,
      attachmentsNew,
      hasMore,
      nextPageToken: hasMore ? nextPageToken : null,
    });
  } catch (e) {
    return await fail(e instanceof Error ? e.message : String(e));
  }
});
