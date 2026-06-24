import { useCallback, useEffect, useState } from "react";
import { supabase } from "./lib/supabase";

// Customer support: send a general enquiry or flag a specific Cotton Mailbox chat
// ("what went wrong"). Both land in the admin Support inbox. Read-only status.

type Mode = "choose" | "general" | "chat";
type ChatOpt = { id: string; title: string | null; updated_at: string };
type Req = {
  id: string; kind: "general" | "chat"; message: string; status: string; created_at: string;
};

const statusColor = (s: string) => s === "open" ? "#f5a623" : s === "in_progress" ? "#5b9bff" : "#2ecc71";
const fmt = (d: string) => new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const GOLD = "#c8a96e";

export function SupportView({ userId, orgId }: { userId: string; orgId: string | null }) {
  const [mode, setMode] = useState<Mode>("choose");
  const [message, setMessage] = useState("");
  const [chats, setChats] = useState<ChatOpt[]>([]);
  const [chatId, setChatId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reqs, setReqs] = useState<Req[]>([]);

  const loadReqs = useCallback(async () => {
    const { data } = await supabase
      .from("support_requests").select("id, kind, message, status, created_at")
      .order("created_at", { ascending: false });
    setReqs((data as Req[] | null) ?? []);
  }, []);

  const loadChats = useCallback(async () => {
    const { data } = await supabase
      .from("mailbox_chats").select("id, title, updated_at").order("updated_at", { ascending: false }).limit(60);
    setChats((data as ChatOpt[] | null) ?? []);
  }, []);

  useEffect(() => { void loadReqs(); void loadChats(); }, [loadReqs, loadChats]);

  const submit = useCallback(async () => {
    setErr(null);
    if (!message.trim()) { setErr("Please describe your enquiry."); return; }
    if (mode === "chat" && !chatId) { setErr("Pick the chat you want us to look at."); return; }
    setSubmitting(true);
    const { error } = await supabase.from("support_requests").insert({
      user_id: userId, org_id: orgId, kind: mode === "chat" ? "chat" : "general",
      message: message.trim(), related_chat_id: mode === "chat" ? chatId : null,
    });
    setSubmitting(false);
    if (error) { setErr(error.message); return; }
    setToast("Request sent — our team will take a look.");
    setMessage(""); setChatId(""); setMode("choose");
    void loadReqs();
    window.setTimeout(() => setToast(null), 4000);
  }, [message, mode, chatId, userId, orgId, loadReqs]);

  const cardBtn: React.CSSProperties = {
    flex: 1, padding: "20px 18px", borderRadius: 14, cursor: "pointer", textAlign: "left", color: "inherit",
    background: "rgba(200,169,110,0.07)", border: "1px solid rgba(200,169,110,0.28)",
  };
  const inp: React.CSSProperties = {
    width: "100%", padding: "10px 12px", borderRadius: 10, background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.12)", color: "inherit", fontSize: 14,
  };

  return (
    <div style={{ padding: 24, maxWidth: 760, margin: "0 auto" }}>
      {toast && (
        <div style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 10, background: "rgba(46,204,113,0.14)", border: "1px solid rgba(46,204,113,0.4)", fontSize: 13 }}>{toast}</div>
      )}

      {mode === "choose" && (
        <>
          <h2 style={{ fontFamily: "var(--serif, serif)", fontSize: 22, marginBottom: 6 }}>How can we help?</h2>
          <p style={{ opacity: 0.65, fontSize: 13.5, marginBottom: 18 }}>Send us a question, or flag a specific Cotton Mailbox chat that didn't go right.</p>
          <div style={{ display: "flex", gap: 14 }}>
            <button style={cardBtn} onClick={() => { setMode("general"); setErr(null); }}>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>✉️ General enquiry</div>
              <div style={{ fontSize: 12.5, opacity: 0.7 }}>Ask a question or report an issue with the app.</div>
            </button>
            <button style={cardBtn} onClick={() => { setMode("chat"); setErr(null); }}>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>🩺 Flag a chat</div>
              <div style={{ fontSize: 12.5, opacity: 0.7 }}>Point us at a mailbox conversation and tell us what went wrong.</div>
            </button>
          </div>
        </>
      )}

      {mode !== "choose" && (
        <div>
          <button onClick={() => { setMode("choose"); setErr(null); }} style={{ background: "none", border: "none", color: GOLD, cursor: "pointer", fontSize: 12.5, marginBottom: 12 }}>← back</button>
          <h2 style={{ fontFamily: "var(--serif, serif)", fontSize: 20, marginBottom: 14 }}>
            {mode === "general" ? "General enquiry" : "Flag a chat"}
          </h2>
          {mode === "chat" && (
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, opacity: 0.6, display: "block", marginBottom: 5 }}>Which conversation?</label>
              <select value={chatId} onChange={(e) => setChatId(e.target.value)} style={inp}>
                <option value="">Select a chat…</option>
                {chats.map((c) => <option key={c.id} value={c.id}>{c.title || "(untitled)"} · {fmt(c.updated_at)}</option>)}
              </select>
              {chats.length === 0 && <p style={{ fontSize: 12, opacity: 0.5, marginTop: 5 }}>You have no saved mailbox chats yet.</p>}
            </div>
          )}
          <label style={{ fontSize: 12, opacity: 0.6, display: "block", marginBottom: 5 }}>
            {mode === "chat" ? "What went wrong?" : "Your message"}
          </label>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={6}
            placeholder={mode === "chat" ? "Describe what the AI got wrong or what you expected…" : "How can we help?"}
            style={{ ...inp, resize: "vertical" }} />
          {err && <p style={{ color: "#e74c3c", fontSize: 12.5, marginTop: 8 }}>{err}</p>}
          <button onClick={() => void submit()} disabled={submitting} className="btn btn-primary" style={{ marginTop: 12 }}>
            {submitting ? "Sending…" : "Send request"}
          </button>
        </div>
      )}

      {/* Past requests */}
      <div style={{ marginTop: 34 }}>
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.55, marginBottom: 10 }}>Your requests</div>
        {reqs.length === 0 && <p style={{ opacity: 0.5, fontSize: 13 }}>No requests yet.</p>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {reqs.map((r) => (
            <div key={r.id} style={{ padding: "10px 13px", borderRadius: 10, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <span style={{ fontSize: 12, opacity: 0.6 }}>{r.kind === "chat" ? "Flagged chat" : "General"} · {fmt(r.created_at)}</span>
                <span style={{ fontSize: 10, color: statusColor(r.status), border: `1px solid ${statusColor(r.status)}`, borderRadius: 4, padding: "0 6px", textTransform: "uppercase", whiteSpace: "nowrap" }}>{r.status.replace("_", " ")}</span>
              </div>
              <div style={{ fontSize: 13, marginTop: 4 }}>{r.message}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
