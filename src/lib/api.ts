import { supabase } from "./supabase";

const getEnv = () => {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error("VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY is not set");
  }
  return { url, anon };
};

/**
 * Stream chat from Edge Function. Caller must pass a valid user JWT via Supabase session.
 */
export async function streamChat(
  accessToken: string,
  body: { chatId: string; orgId: string },
  onToken: (chunk: string) => void,
): Promise<string> {
  const { url, anon } = getEnv();
  const res = await fetch(`${url}/functions/v1/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: anon,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText || res.statusText);
  }
  if (!res.body) {
    throw new Error("Empty body");
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let full = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    full += chunk;
    onToken(chunk);
  }
  return full;
}

/**
 * Trigger a mailbox sync (admin only). The Edge Function authorizes the caller's
 * platform-admin JWT, so no shared secret is needed from the client. Loops the
 * backfill until there's no more to fetch.
 */
export async function triggerMailboxSync(
  accessToken: string,
  opts: { trigger?: "manual" | "backfill"; backfillDays?: number } = {},
): Promise<{ emailsNew: number; attachmentsNew: number }> {
  const { url, anon } = getEnv();
  let emailsNew = 0;
  let attachmentsNew = 0;
  let pageToken: string | null = null;
  let hasMore = true;
  let guard = 0;
  while (hasMore && guard < 40) {
    guard++;
    const res = await fetch(`${url}/functions/v1/mailbox_sync`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: anon,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...opts, pageToken }),
    });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    const j = (await res.json()) as {
      emailsNew?: number; attachmentsNew?: number; hasMore?: boolean; nextPageToken?: string | null;
    };
    emailsNew += j.emailsNew ?? 0;
    attachmentsNew += j.attachmentsNew ?? 0;
    hasMore = !!j.hasMore;
    pageToken = j.nextPageToken ?? null;
  }
  return { emailsNew, attachmentsNew };
}

export type MailboxStatus = {
  connected: boolean;
  mailbox?: string;
  expectedMailbox?: string;
  mailboxMismatch?: boolean;
  lastSyncedAt?: string | null;
  error?: string;
};

/** Verify the Gmail connection (admin only) without syncing. Powers the badge. */
export async function getMailboxStatus(accessToken: string): Promise<MailboxStatus> {
  const { url, anon } = getEnv();
  const res = await fetch(`${url}/functions/v1/mailbox_sync`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: anon,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ mode: "status" }),
  });
  if (!res.ok) return { connected: false, error: (await res.text()) || res.statusText };
  return (await res.json()) as MailboxStatus;
}

/** Run the extraction pass (admin only). Loops until no pending work remains. */
export async function triggerExtraction(
  accessToken: string,
): Promise<{ offersWritten: number; recapsWritten: number }> {
  const { url, anon } = getEnv();
  let offersWritten = 0;
  let recapsWritten = 0;
  let remaining = 1;
  let guard = 0;
  while (remaining > 0 && guard < 60) {
    guard++;
    const res = await fetch(`${url}/functions/v1/extract_offers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: anon,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    const j = (await res.json()) as {
      offersWritten?: number; recapsWritten?: number; remaining?: number;
    };
    offersWritten += j.offersWritten ?? 0;
    recapsWritten += j.recapsWritten ?? 0;
    remaining = j.remaining ?? 0;
  }
  return { offersWritten, recapsWritten };
}

// deno-lint-ignore-next-line
export type MailboxEvent =
  | { t: "act"; label?: string; cards?: unknown[] }
  | { t: "tok"; v: string }
  | { t: "src"; cards: unknown[] }
  | { t: "err"; m: string };

/**
 * Stream the mailbox agent as NDJSON events: live tool activity (which documents
 * it's viewing), answer words, and final sources. Stateless: pass the full
 * message array; optionally scope to one email.
 */
export async function streamMailboxChat(
  accessToken: string,
  body: {
    messages: { role: "user" | "assistant"; content: string }[];
    emailId?: string | null;
    scope?: "email" | "global";
  },
  onEvent: (ev: MailboxEvent) => void,
): Promise<void> {
  const { url, anon } = getEnv();
  const res = await fetch(`${url}/functions/v1/mailbox_chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: anon,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  if (!res.body) throw new Error("Empty body");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const flush = (line: string) => {
    const s = line.trim();
    if (s) { try { onEvent(JSON.parse(s) as MailboxEvent); } catch { /* ignore partials */ } }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      flush(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  flush(buf);
}

export async function invokeIngest(orgSheetId: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke("ingest_sheet", {
    body: { orgSheetId },
  });
  if (error) {
    const msg = error.message;
    if (data && typeof (data as { error?: string }).error === "string") {
      throw new Error((data as { error: string }).error);
    }
    throw new Error(msg);
  }
  if (data && typeof (data as { error?: string }).error === "string") {
    const e = (data as { error: string; detail?: string }).error;
    const d = (data as { detail?: string }).detail;
    throw new Error(d || e);
  }
}
