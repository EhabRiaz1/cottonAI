import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { supabase } from "./lib/supabase";
import {
  getMailboxStatus,
  type MailboxEvent,
  type MailboxStatus,
  streamMailboxChat,
  triggerExtraction,
  triggerMailboxSync,
} from "./lib/api";
import { OffersView } from "./OffersView";

// "Talk to your cotton mailbox" — 3-pane: inbox / email detail+attachments / agent.

type Email = {
  id: string;
  from_name: string | null;
  from_address: string | null;
  broker_guess: string | null;
  subject: string | null;
  date_sent: string | null;
  snippet: string | null;
  has_attachments: boolean;
};
type Attachment = {
  id: string; filename: string | null; mime_type: string | null;
  kind: string; size_bytes: number | null; storage_path: string | null;
};
type SourceCard = {
  type: "attachment" | "email";
  attachmentId?: string; filename?: string; kind?: string; storagePath?: string | null;
  emailId?: string; subject?: string | null; broker?: string | null;
};
type ChatMsg = { role: "user" | "assistant"; content: string; sources?: SourceCard[] };

function dedupeCards(cards: SourceCard[]): SourceCard[] {
  const seen = new Set<string>();
  const out: SourceCard[] = [];
  for (const c of cards) {
    const k = c.attachmentId || c.emailId || JSON.stringify(c);
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  }
  return out;
}

const GREEN = "#2ecc71", AMBER = "#f5a623", RED = "#e74c3c", GREY = "#8a8f98";
const ageDays = (d: string | null) => d ? Math.floor((Date.now() - Date.parse(d)) / 86_400_000) : null;
const freshColor = (a: number | null) => a == null ? GREY : a <= 14 ? GREEN : a <= 30 ? AMBER : RED;
const fmtSize = (b: number | null) => b == null ? "" : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`;
const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
function timeOfDay() { const h = new Date().getHours(); return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening"; }

export function MailboxView({ isPlatformAdmin, userName }: { isPlatformAdmin: boolean; userName?: string }) {
  const [mode, setMode] = useState<"inbox" | "offers">("inbox");
  const [emails, setEmails] = useState<Email[]>([]);
  const [attCounts, setAttCounts] = useState<Record<string, number>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // chat
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState("");
  const [wholeMailbox, setWholeMailbox] = useState(false);
  const [chatErr, setChatErr] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Live inspector pane — which documents the agent is viewing / used.
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorLabel, setInspectorLabel] = useState<string | null>(null);
  const [inspectorCards, setInspectorCards] = useState<SourceCard[]>([]);

  // status
  const [conn, setConn] = useState<MailboxStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const loadEmails = useCallback(async () => {
    const { data } = await supabase
      .from("email_messages")
      .select("id, from_name, from_address, broker_guess, subject, date_sent, snippet, has_attachments")
      .order("date_sent", { ascending: false, nullsFirst: false }).limit(300);
    setEmails((data as Email[] | null) ?? []);
    const { data: atts } = await supabase
      .from("email_attachments").select("email_id, kind").in("kind", ["pdf", "excel"]);
    const counts: Record<string, number> = {};
    for (const a of (atts as { email_id: string }[] | null) ?? []) counts[a.email_id] = (counts[a.email_id] ?? 0) + 1;
    setAttCounts(counts);
  }, []);

  const loadStatus = useCallback(async () => {
    if (!isPlatformAdmin) return;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) setConn(await getMailboxStatus(session.access_token));
    } catch { /* ignore */ }
  }, [isPlatformAdmin]);

  useEffect(() => { void loadEmails(); void loadStatus(); }, [loadEmails, loadStatus]);

  const selectEmail = useCallback(async (id: string) => {
    // Keep the conversation — opening an email only changes context, never wipes chat.
    setSelectedId(id); setPreviewUrl(null);
    const { data } = await supabase
      .from("email_attachments")
      .select("id, filename, mime_type, kind, size_bytes, storage_path")
      .eq("email_id", id).order("kind").order("filename");
    setAttachments((data as Attachment[] | null) ?? []);
  }, []);

  const clearSelection = useCallback(() => {
    // Return to whole-mailbox scope without discarding the conversation.
    setSelectedId(null); setAttachments([]); setPreviewUrl(null);
  }, []);

  const openAttachment = useCallback(async (a: Attachment, asPreview: boolean) => {
    if (!a.storage_path) return;
    const { data } = await supabase.storage.from("email-attachments").createSignedUrl(a.storage_path, 300);
    if (!data?.signedUrl) return;
    if (asPreview && a.kind === "pdf") { setPreviewName(a.filename); setPreviewUrl(data.signedUrl); }
    else window.open(data.signedUrl, "_blank");
  }, []);

  const openSource = useCallback(async (s: SourceCard) => {
    if (s.type === "attachment" && s.storagePath) {
      const { data } = await supabase.storage.from("email-attachments").createSignedUrl(s.storagePath, 300);
      if (!data?.signedUrl) return;
      if (s.kind === "pdf") { setPreviewName(s.filename ?? "Document"); setPreviewUrl(data.signedUrl); }
      else window.open(data.signedUrl, "_blank");
    } else if (s.emailId) {
      void selectEmail(s.emailId);
    }
  }, [selectEmail]);

  // Close the preview modal on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPreviewUrl(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const runSync = useCallback(async () => {
    setSyncing(true); setSyncMsg("Syncing mailbox…");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token; if (!token) throw new Error("Not signed in");
      const s = await triggerMailboxSync(token, { trigger: "manual" });
      setSyncMsg(`Fetched ${s.emailsNew} email(s). Extracting…`);
      const x = await triggerExtraction(token);
      setSyncMsg(`Done — ${x.offersWritten} offers, ${x.recapsWritten} recaps updated.`);
      await loadEmails(); await loadStatus();
    } catch (e) {
      setSyncMsg(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setSyncing(false); }
  }, [loadEmails, loadStatus]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput(""); setChatErr(null);
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next); setSending(true); setPreview("");
    setInspectorOpen(true); setInspectorLabel(null); setInspectorCards([]);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token; if (!token) throw new Error("Not signed in");
      const scope = selectedId && !wholeMailbox ? "email" : "global";
      let acc = "";
      let finalSources: SourceCard[] = [];
      await streamMailboxChat(token, { messages: next, emailId: selectedId, scope }, (ev: MailboxEvent) => {
        if (ev.t === "tok") { acc += ev.v; setPreview(acc); }
        else if (ev.t === "act") {
          if (ev.label) setInspectorLabel(ev.label);
          if (ev.cards?.length) setInspectorCards((prev) => dedupeCards([...prev, ...(ev.cards as SourceCard[])]));
        } else if (ev.t === "src") {
          finalSources = (ev.cards as SourceCard[]) ?? [];
          setInspectorCards(dedupeCards(finalSources));
        } else if (ev.t === "err") {
          setChatErr(ev.m);
        }
      });
      setMessages([...next, { role: "assistant", content: acc.trim(), sources: finalSources }]);
      setPreview(""); setInspectorLabel(null);
    } catch (e) {
      setChatErr(e instanceof Error ? e.message : String(e));
    } finally { setSending(false); }
  }, [input, sending, messages, selectedId, wholeMailbox]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, preview]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return emails;
    return emails.filter((e) => [e.broker_guess, e.from_name, e.from_address, e.subject]
      .join(" ").toLowerCase().includes(q));
  }, [emails, search]);

  const selected = emails.find((e) => e.id === selectedId) ?? null;
  const scopeLabel = selectedId && !wholeMailbox ? `this email` : `whole mailbox`;
  const showInspector = inspectorOpen && (sending || inspectorCards.length > 0);

  if (mode === "offers") {
    return (
      <div>
        <ModeBar mode={mode} setMode={setMode} conn={conn} isPlatformAdmin={isPlatformAdmin}
          syncing={syncing} syncMsg={syncMsg} onSync={runSync} emailCount={emails.length} />
        <OffersView isPlatformAdmin={isPlatformAdmin} />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ModeBar mode={mode} setMode={setMode} conn={conn} isPlatformAdmin={isPlatformAdmin}
        syncing={syncing} syncMsg={syncMsg} onSync={runSync} emailCount={emails.length} />
      <div style={{
        display: "grid",
        // detail collapses to 0 when no email; the inspector animates in on the far
        // right while the agent works / after it cites documents.
        gridTemplateColumns: selectedId
          ? `280px minmax(0,1fr) minmax(340px,1.05fr) ${showInspector ? "270px" : "0px"}`
          : `280px 0px minmax(0,1fr) ${showInspector ? "270px" : "0px"}`,
        gap: 16, padding: 16, flex: 1, minHeight: 0,
        transition: "grid-template-columns 0.5s cubic-bezier(0.22,1,0.36,1)",
      }}>

        {/* INBOX */}
        <div style={card}>
          <div style={{ padding: 10, borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
            <input placeholder="Search broker / subject…" value={search} onChange={(e) => setSearch(e.target.value)}
              style={inp} />
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {filtered.length === 0 && <p style={{ opacity: 0.5, padding: 14, fontSize: 13 }}>No emails yet.</p>}
            {filtered.map((e) => {
              const a = ageDays(e.date_sent);
              return (
                <button key={e.id} onClick={() => selectedId === e.id ? clearSelection() : void selectEmail(e.id)}
                  style={{
                    display: "block", width: "100%", textAlign: "left", padding: "10px 12px",
                    background: e.id === selectedId ? "rgba(255,255,255,0.07)" : "transparent",
                    border: "none", borderBottom: "1px solid rgba(255,255,255,0.05)", color: "inherit", cursor: "pointer",
                  }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {e.broker_guess || e.from_name || e.from_address || "—"}
                    </span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, opacity: 0.7, whiteSpace: "nowrap" }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: freshColor(a) }} />
                      {fmtDate(e.date_sent)}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {e.subject || "(no subject)"}
                  </div>
                  {attCounts[e.id] ? <div style={{ fontSize: 11, opacity: 0.55, marginTop: 3 }}>📎 {attCounts[e.id]} attachment(s)</div> : null}
                </button>
              );
            })}
          </div>
        </div>

        {/* DETAIL — animates in when an email is selected, collapsed otherwise */}
        <div style={{
          ...card,
          opacity: selectedId ? 1 : 0,
          transform: selectedId ? "none" : "translateX(-16px) scale(0.97)",
          transition: "opacity 0.4s ease, transform 0.5s cubic-bezier(0.22,1,0.36,1)",
          pointerEvents: selectedId ? "auto" : "none",
        }}>
          {!selected ? (
            <span />
          ) : (
            <div style={{ overflowY: "auto", padding: 16 }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{selected.subject || "(no subject)"}</div>
                  <div style={{ fontSize: 12.5, opacity: 0.7 }}>
                    {selected.from_name} &lt;{selected.from_address}&gt; · {fmtDate(selected.date_sent)}
                  </div>
                </div>
                <button title="Close email" aria-label="Close email" onClick={clearSelection}
                  style={{
                    flexShrink: 0, width: 28, height: 28, borderRadius: 8, cursor: "pointer", fontSize: 15, lineHeight: 1,
                    background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)", color: "inherit",
                  }}>✕</button>
              </div>
              <div style={{ marginTop: 14, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.55 }}>Attachments</div>
              {attachments.length === 0 && <p style={{ opacity: 0.5, fontSize: 13 }}>No PDF/Excel attachments.</p>}
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                {attachments.map((a) => (
                  <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                    <span style={{ fontSize: 16 }}>{a.kind === "pdf" ? "📄" : "📊"}</span>
                    <span style={{ flex: 1, fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.filename}</span>
                    <span style={{ fontSize: 11, opacity: 0.5 }}>{fmtSize(a.size_bytes)}</span>
                    {a.kind === "pdf" && <button style={btnSm} onClick={() => void openAttachment(a, true)}>Preview</button>}
                    <button style={btnSm} onClick={() => void openAttachment(a, false)}>Download</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* CHAT */}
        <div style={chatCard}>
          <div style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Ask the mailbox</span>
            <span style={{ fontSize: 11, opacity: 0.6 }}>· {scopeLabel}</span>
            <div style={{ flex: 1 }} />
            {selectedId && (
              <label style={{ fontSize: 11, display: "inline-flex", gap: 5, alignItems: "center", opacity: 0.85 }}>
                <input type="checkbox" checked={wholeMailbox} onChange={(e) => setWholeMailbox(e.target.checked)} />
                whole mailbox
              </label>
            )}
          </div>
          <div style={{
            flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column",
            ...(messages.length === 0 && !preview
              ? { justifyContent: "center", alignItems: "center", textAlign: "center" }
              : {}),
          }}>
            {messages.length === 0 && !preview && (
              <div className="chat-hero" style={{ padding: "0 10px" }}>
                <h1 className="chat-welcome-hello">
                  Good {timeOfDay()}, <em>{userName?.trim() || "there"}</em>
                </h1>
                <p className="chat-welcome-sub">
                  {selectedId
                    ? "Ask about this email and its attachments — e.g. “summarize the offers in the PDF”."
                    : "Ask across your whole cotton mailbox — e.g. “cheapest US GC under 30 days old”."}
                </p>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 16, width: "100%" }}>
                <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 4 }}>{m.role === "user" ? "You" : "Cotton AI"}</div>
                {m.role === "assistant"
                  ? <div className="md" style={aiBubble}><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div>
                  : <div style={userBubble}>{m.content}</div>}
                {m.role === "assistant" && m.sources && m.sources.length > 0 && (
                  <div style={{ marginTop: 10, width: "100%" }}>
                    <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.5, marginBottom: 6 }}>
                      Documents referenced
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {m.sources.map((s, k) => (
                        <button key={k} onClick={() => void openSource(s)} title={s.subject ?? ""}
                          style={{
                            display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 230,
                            padding: "5px 9px", borderRadius: 8, cursor: "pointer", fontSize: 11.5,
                            background: "rgba(200,169,110,0.10)", border: "1px solid rgba(200,169,110,0.30)", color: "inherit",
                          }}>
                          <span>{s.type === "attachment" ? (s.kind === "pdf" ? "📄" : "📊") : "✉️"}</span>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {s.type === "attachment" ? s.filename : (s.subject || s.broker || "email")}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {preview && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", marginBottom: 16, width: "100%" }}>
                <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 4 }}>Cotton AI</div>
                <div className="md" style={aiBubble}><ReactMarkdown remarkPlugins={[remarkGfm]}>{preview}</ReactMarkdown></div>
              </div>
            )}
            {sending && !preview && (
              <div className="thinking-badge" style={{ alignSelf: "flex-start" }}>
                <span className="dot" /> Thinking…
              </div>
            )}
            {chatErr && <p style={{ color: RED, fontSize: 12 }}>{chatErr}</p>}
            <div ref={endRef} />
          </div>
          <div style={{ padding: 12, borderTop: "1px solid rgba(255,255,255,0.07)", display: "flex", gap: 8 }}>
            <textarea value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              placeholder="Message the mailbox…" rows={2}
              style={{ ...inp, resize: "none", flex: 1 }} disabled={sending} />
            <button onClick={() => void send()} disabled={sending || !input.trim()} className="btn btn-primary"
              style={{ alignSelf: "stretch" }}>Send</button>
          </div>
        </div>

        {/* INSPECTOR — live "documents the agent is viewing", then the ones it used */}
        <div style={card}>
          <div style={{ padding: "11px 13px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", gap: 8 }}>
            {sending
              ? <span className="thinking-badge" style={{ fontSize: 12.5 }}><span className="dot" /> {inspectorLabel || "Working…"}</span>
              : <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.6 }}>Documents referenced</span>}
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
            {inspectorCards.length === 0 && (
              <p style={{ opacity: 0.5, fontSize: 12 }}>{sending ? "Looking…" : "No documents yet."}</p>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {inspectorCards.map((s, k) => (
                <button key={k} onClick={() => void openSource(s)} title={s.subject ?? ""}
                  style={{
                    display: "flex", alignItems: "flex-start", gap: 9, textAlign: "left",
                    padding: "9px 10px", borderRadius: 10, cursor: "pointer",
                    background: "rgba(200,169,110,0.08)", border: "1px solid rgba(200,169,110,0.22)", color: "inherit",
                  }}>
                  <span style={{ fontSize: 15 }}>{s.type === "attachment" ? (s.kind === "pdf" ? "📄" : "📊") : "✉️"}</span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.type === "attachment" ? s.filename : (s.subject || "email")}
                    </span>
                    {s.subject && s.type === "attachment" && (
                      <span style={{ display: "block", fontSize: 11, opacity: 0.55, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.subject}</span>
                    )}
                    {s.broker && <span style={{ display: "block", fontSize: 10.5, opacity: 0.45 }}>{s.broker}</span>}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {previewUrl && (
        <div onClick={() => setPreviewUrl(null)} style={modalBackdrop}>
          <div onClick={(e) => e.stopPropagation()} style={modalCard}>
            <div style={modalHeader}>
              <span style={{ fontSize: 13, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {previewName ?? "Preview"}
              </span>
              <button style={btnSm} onClick={() => window.open(previewUrl, "_blank")}>Open ↗</button>
              <button style={btnSm} onClick={() => setPreviewUrl(null)}>Close ✕</button>
            </div>
            <iframe title="preview" src={previewUrl} style={{ flex: 1, width: "100%", border: "none", background: "#fff" }} />
          </div>
        </div>
      )}
    </div>
  );
}

function ModeBar({ mode, setMode, conn, isPlatformAdmin, syncing, syncMsg, onSync, emailCount }: {
  mode: "inbox" | "offers"; setMode: (m: "inbox" | "offers") => void; conn: MailboxStatus | null;
  isPlatformAdmin: boolean; syncing: boolean; syncMsg: string | null; onSync: () => void; emailCount: number;
}) {
  const ok = conn?.connected;
  const color = !isPlatformAdmin ? GREY : ok ? (conn?.mailboxMismatch ? AMBER : GREEN) : conn ? RED : GREY;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 14px", borderBottom: "1px solid rgba(255,255,255,0.08)", flexWrap: "wrap" }}>
      <div style={{ display: "inline-flex", gap: 4, background: "rgba(255,255,255,0.05)", borderRadius: 8, padding: 3 }}>
        {(["inbox", "offers"] as const).map((m) => (
          <button key={m} onClick={() => setMode(m)} style={{
            padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12.5,
            background: mode === m ? "rgba(255,255,255,0.12)" : "transparent", color: "inherit",
            fontWeight: mode === m ? 600 : 400,
          }}>{m === "inbox" ? "Inbox" : "Offers table"}</button>
        ))}
      </div>
      {isPlatformAdmin && (
        <span title={conn?.error ?? ""} style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
          {ok ? `Connected · ${conn?.mailbox}` : conn ? "Not connected" : "Checking…"}
        </span>
      )}
      <span style={{ fontSize: 12, opacity: 0.6 }}>{emailCount} emails</span>
      <div style={{ flex: 1 }} />
      {syncMsg && <span style={{ fontSize: 12, opacity: 0.8 }}>{syncMsg}</span>}
      {isPlatformAdmin && (
        <button className="btn btn-ghost" onClick={onSync} disabled={syncing}>{syncing ? "Syncing…" : "Sync now"}</button>
      )}
    </div>
  );
}

// Each pane is its own floating card for a modern, luxurious feel.
const card: React.CSSProperties = {
  display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0,
  background: "rgba(255,255,255,0.035)", border: "1px solid rgba(255,255,255,0.09)",
  borderRadius: 16, overflow: "hidden", boxShadow: "0 12px 34px rgba(0,0,0,0.28)",
};

// Chat card carries the app's gold hue — tinted border + soft gold glow.
const chatCard: React.CSSProperties = {
  ...card,
  border: "1px solid rgba(200,169,110,0.38)",
  boxShadow: "0 12px 34px rgba(0,0,0,0.30), inset 0 0 0 1px rgba(200,169,110,0.10), 0 0 46px rgba(200,169,110,0.14)",
  background: "linear-gradient(180deg, rgba(200,169,110,0.06), rgba(255,255,255,0.025))",
};

// A4 preview modal (210:297 aspect, sized to the viewport height).
const modalBackdrop: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 1000, background: "rgba(8,10,14,0.66)",
  backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
};
const modalCard: React.CSSProperties = {
  display: "flex", flexDirection: "column", height: "92vh", aspectRatio: "210 / 297",
  maxWidth: "96vw", background: "#1b1e24", border: "1px solid rgba(255,255,255,0.14)",
  borderRadius: 14, overflow: "hidden", boxShadow: "0 30px 80px rgba(0,0,0,0.5)",
};
const modalHeader: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, padding: "10px 12px",
  borderBottom: "1px solid rgba(255,255,255,0.1)",
};

// Distinct message bubbles. AI fills the width (so tables span the pane); user
// is a smaller right-aligned gold bubble.
const aiBubble: React.CSSProperties = {
  width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)",
  borderRadius: "4px 14px 14px 14px", padding: "12px 15px", textAlign: "left",
};
const userBubble: React.CSSProperties = {
  maxWidth: "86%", background: "rgba(200,169,110,0.16)", border: "1px solid rgba(200,169,110,0.30)",
  borderRadius: "14px 14px 4px 14px", padding: "9px 14px", fontSize: 15, lineHeight: 1.55,
  whiteSpace: "pre-wrap", textAlign: "left",
};

const inp: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 8,
  background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", color: "inherit", fontSize: 13,
};
const btnSm: React.CSSProperties = {
  fontSize: 11, padding: "4px 9px", borderRadius: 6, cursor: "pointer",
  background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)", color: "inherit",
};
