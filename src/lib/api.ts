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
