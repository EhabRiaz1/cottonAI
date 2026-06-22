// Minimal Gmail REST client for a SINGLE fixed mailbox, authenticated with a
// one-time OAuth refresh token (scope gmail.readonly). This is NOT domain-wide
// delegation — it grants access only to the one mailbox that consented.
//
// Runs entirely over HTTPS, so it works inside Supabase Edge Functions (unlike
// raw-TCP IMAP). See GMAIL_COTTON_INTEGRATION_PLAN.md §10 (transport decision).

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  historyId?: string;
  internalDate?: string; // ms since epoch, as string
  snippet?: string;
  payload?: GmailPart;
}

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  attachmentId: string | null; // null when the data is inline (small attachments)
  inlineData: string | null;   // base64url body.data when present (no fetch needed)
  size: number;
}

export interface ParsedMessage {
  gmailMessageId: string;
  rfcMessageId: string | null;
  fromAddress: string | null;
  fromName: string | null;
  subject: string | null;
  dateSent: string | null; // ISO
  snippet: string | null;
  bodyText: string | null;
  attachments: ParsedAttachment[];
}

// --- Auth -----------------------------------------------------------------

export async function getAccessToken(creds: GmailCreds): Promise<string> {
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail OAuth token exchange failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error("Gmail OAuth: no access_token in response");
  return data.access_token as string;
}

async function gget(token: string, path: string): Promise<Response> {
  // Hard per-request timeout so a single slow/hung fetch can't consume the
  // whole Edge wall-clock budget.
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(25_000),
  });
  return res;
}

// --- Profile + listing ----------------------------------------------------

export async function getProfile(
  token: string,
): Promise<{ emailAddress: string; historyId: string }> {
  const res = await gget(token, "/profile");
  if (!res.ok) throw new Error(`Gmail getProfile failed (${res.status}): ${await res.text()}`);
  return await res.json();
}

// Backfill listing by query (e.g. "newer_than:90d"). Returns one page.
export async function listMessages(
  token: string,
  opts: { query?: string; pageToken?: string; maxResults?: number } = {},
): Promise<{ ids: string[]; nextPageToken: string | null }> {
  const p = new URLSearchParams();
  if (opts.query) p.set("q", opts.query);
  if (opts.pageToken) p.set("pageToken", opts.pageToken);
  p.set("maxResults", String(opts.maxResults ?? 100));
  const res = await gget(token, `/messages?${p.toString()}`);
  if (!res.ok) throw new Error(`Gmail listMessages failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const ids: string[] = (data.messages ?? []).map((m: { id: string }) => m.id);
  return { ids, nextPageToken: data.nextPageToken ?? null };
}

// Incremental listing via the history API. Returns added message ids since
// startHistoryId. `expired` => the cursor is too old; caller should full-resync.
export async function listHistory(
  token: string,
  startHistoryId: string,
): Promise<{ ids: string[]; latestHistoryId: string | null; expired: boolean }> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  let latestHistoryId: string | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const p = new URLSearchParams({
      startHistoryId,
      historyTypes: "messageAdded",
    });
    if (pageToken) p.set("pageToken", pageToken);
    const res = await gget(token, `/history?${p.toString()}`);
    if (res.status === 404) return { ids: [], latestHistoryId: null, expired: true };
    if (!res.ok) throw new Error(`Gmail listHistory failed (${res.status}): ${await res.text()}`);
    const data = await res.json();
    if (data.historyId) latestHistoryId = String(data.historyId);
    for (const h of data.history ?? []) {
      for (const a of h.messagesAdded ?? []) {
        if (a.message?.id) ids.add(a.message.id);
      }
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return { ids: [...ids], latestHistoryId, expired: false };
}

export async function getMessage(token: string, id: string): Promise<GmailMessage> {
  const res = await gget(token, `/messages/${id}?format=full`);
  if (!res.ok) throw new Error(`Gmail getMessage ${id} failed (${res.status}): ${await res.text()}`);
  return await res.json();
}

export async function getAttachmentBytes(
  token: string,
  messageId: string,
  attachmentId: string,
): Promise<Uint8Array> {
  const res = await gget(token, `/messages/${messageId}/attachments/${attachmentId}`);
  if (!res.ok) {
    throw new Error(`Gmail getAttachment failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return b64urlToBytes(data.data ?? "");
}

// --- Parsing --------------------------------------------------------------

export function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function header(part: GmailPart | undefined, name: string): string | null {
  const h = part?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

function parseFrom(raw: string | null): { address: string | null; name: string | null } {
  if (!raw) return { address: null, name: null };
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, address: m[2].trim().toLowerCase() };
  if (raw.includes("@")) return { name: null, address: raw.trim().toLowerCase() };
  return { name: raw.trim() || null, address: null };
}

// Walk the MIME tree: collect the best plain-text body + all real attachments.
function walk(
  part: GmailPart | undefined,
  acc: { text: string[]; html: string[]; attachments: ParsedAttachment[] },
): void {
  if (!part) return;
  const mime = (part.mimeType ?? "").toLowerCase();
  const filename = part.filename ?? "";
  const attachmentId = part.body?.attachmentId ?? null;
  const inlineData = part.body?.data ?? null;

  // Any part with a filename is an attachment. The bytes are EITHER inline
  // (body.data, common for small files) OR fetched later via body.attachmentId.
  if (filename) {
    acc.attachments.push({
      filename,
      mimeType: mime || "application/octet-stream",
      attachmentId,
      inlineData,
      size: part.body?.size ?? 0,
    });
  } else if (mime === "text/plain" && inlineData) {
    acc.text.push(new TextDecoder().decode(b64urlToBytes(inlineData)));
  } else if (mime === "text/html" && inlineData) {
    acc.html.push(new TextDecoder().decode(b64urlToBytes(inlineData)));
  }
  for (const child of part.parts ?? []) walk(child, acc);
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>(?=)/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseMessage(msg: GmailMessage): ParsedMessage {
  const acc = { text: [] as string[], html: [] as string[], attachments: [] as ParsedAttachment[] };
  walk(msg.payload, acc);

  const from = parseFrom(header(msg.payload, "From"));
  const subject = header(msg.payload, "Subject");
  const rfcMessageId = header(msg.payload, "Message-ID") ?? header(msg.payload, "Message-Id");
  const dateHeader = header(msg.payload, "Date");

  let dateSent: string | null = null;
  if (msg.internalDate) {
    dateSent = new Date(Number(msg.internalDate)).toISOString();
  } else if (dateHeader) {
    const d = new Date(dateHeader);
    if (!isNaN(d.getTime())) dateSent = d.toISOString();
  }

  let bodyText = acc.text.join("\n\n").trim();
  if (!bodyText && acc.html.length) bodyText = htmlToText(acc.html.join("\n\n"));

  return {
    gmailMessageId: msg.id,
    rfcMessageId: rfcMessageId ? rfcMessageId.trim() : null,
    fromAddress: from.address,
    fromName: from.name,
    subject,
    dateSent,
    snippet: msg.snippet ?? null,
    bodyText: bodyText || null,
    attachments: acc.attachments,
  };
}

export function classifyAttachment(filename: string, mimeType: string): "pdf" | "excel" | "other" {
  const f = filename.toLowerCase();
  const m = mimeType.toLowerCase();
  if (m.includes("pdf") || f.endsWith(".pdf")) return "pdf";
  if (
    m.includes("spreadsheet") || m.includes("excel") || m.includes("csv") ||
    f.endsWith(".xlsx") || f.endsWith(".xls") || f.endsWith(".csv")
  ) return "excel";
  return "other";
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
