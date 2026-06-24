import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { supabase } from "./lib/supabase";

// Admin oversight of all Cotton Mailbox conversations (read-only, account-first).
// Reads via self-gating SECURITY DEFINER RPCs; opening a transcript writes an
// admin_chat_views audit row (UC1: full visibility WITH accountability).

type Row = {
  id: string; title: string | null; org_name: string | null;
  user_email: string | null; msg_count: number; updated_at: string;
};
type Src = { type: string; filename?: string; subject?: string | null; kind?: string; broker?: string | null };
type Msg = { role: "user" | "assistant"; content: string; sources?: Src[] };
type ChatDetail = {
  id: string; title: string | null; org_name: string | null;
  user_email: string | null; updated_at: string; messages: Msg[]; error?: string;
};

const fmt = (d: string | null) => d ? new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

export function AdminMailboxChats() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const { data, error: e } = await supabase.rpc("admin_list_mailbox_chats", { p_limit: 200, p_offset: 0 });
    if (e) setError(e.message);
    setRows((data as Row[] | null) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const open = useCallback(async (id: string) => {
    setSelectedId(id); setDetail(null); setDetailLoading(true);
    const { data, error: e } = await supabase.rpc("admin_get_mailbox_chat", { p_chat_id: id });
    if (e) setDetail({ id, title: null, org_name: null, user_email: null, updated_at: "", messages: [], error: e.message });
    else setDetail(data as ChatDetail);
    setDetailLoading(false);
  }, []);

  const filtered = rows.filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [r.org_name, r.user_email, r.title].join(" ").toLowerCase().includes(q);
  });

  return (
    <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 16, minHeight: 480 }}>
      {/* LIST */}
      <div style={{ display: "flex", flexDirection: "column", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: 10, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          <input placeholder="Search account / email / title…" value={search} onChange={(e) => setSearch(e.target.value)}
            style={{ width: "100%", padding: "8px 10px", borderRadius: 8, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", color: "inherit" }} />
        </div>
        <div style={{ overflowY: "auto", maxHeight: 560 }}>
          {loading && <p style={{ opacity: 0.6, padding: 14, fontSize: 13 }}>Loading…</p>}
          {error && <p style={{ color: "#e74c3c", padding: 14, fontSize: 13 }}>{error}</p>}
          {!loading && !error && filtered.length === 0 && <p style={{ opacity: 0.5, padding: 14, fontSize: 13 }}>No chats across any account yet.</p>}
          {filtered.map((r) => (
            <button key={r.id} onClick={() => void open(r.id)} style={{
              display: "block", width: "100%", textAlign: "left", padding: "10px 12px", border: "none", cursor: "pointer",
              borderBottom: "1px solid rgba(255,255,255,0.05)", color: "inherit",
              background: r.id === selectedId ? "rgba(200,169,110,0.12)" : "transparent",
            }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.org_name || r.user_email || "Unknown account"}
              </div>
              <div style={{ fontSize: 12, opacity: 0.75, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title || "(untitled)"}</div>
              <div style={{ fontSize: 10.5, opacity: 0.5, marginTop: 2 }}>{r.msg_count} msgs · {fmt(r.updated_at)}</div>
            </button>
          ))}
        </div>
      </div>

      {/* TRANSCRIPT */}
      <div style={{ border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {!selectedId ? (
          <p style={{ opacity: 0.5, padding: 20, fontSize: 13 }}>Select a conversation to read its full transcript.</p>
        ) : detailLoading ? (
          <p style={{ opacity: 0.6, padding: 20, fontSize: 13 }}>Loading transcript…</p>
        ) : detail?.error ? (
          <p style={{ color: "#e74c3c", padding: 20, fontSize: 13 }}>{detail.error}</p>
        ) : detail ? (
          <>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{detail.org_name || detail.user_email || "Unknown account"}</div>
              <div style={{ fontSize: 12, opacity: 0.65 }}>{detail.user_email} · {detail.title || "(untitled)"} · {fmt(detail.updated_at)}</div>
            </div>
            <div style={{ overflowY: "auto", padding: 16, maxHeight: 560 }}>
              {detail.messages.length === 0 && <p style={{ opacity: 0.5, fontSize: 13 }}>Empty conversation.</p>}
              {detail.messages.map((m, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 14 }}>
                  <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 3 }}>{m.role === "user" ? (detail.user_email ?? "User") : "Cotton AI"}</div>
                  {m.role === "assistant"
                    ? <div className="md" style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: "4px 12px 12px 12px", padding: "10px 13px" }}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                      </div>
                    : <div style={{ maxWidth: "85%", fontSize: 14, whiteSpace: "pre-wrap", background: "rgba(200,169,110,0.14)", border: "1px solid rgba(200,169,110,0.28)", borderRadius: "12px 12px 4px 12px", padding: "8px 12px" }}>{m.content}</div>}
                  {m.role === "assistant" && m.sources && m.sources.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                      {m.sources.map((s, k) => (
                        <span key={k} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 7, background: "rgba(200,169,110,0.1)", border: "1px solid rgba(200,169,110,0.25)" }}>
                          {s.type === "attachment" ? `📄 ${s.filename}` : `✉️ ${s.subject || "email"}`}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
