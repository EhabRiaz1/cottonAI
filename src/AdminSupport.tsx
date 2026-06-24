import { useCallback, useEffect, useState } from "react";
import { supabase } from "./lib/supabase";

// Admin support inbox. Lists all support_requests; for a 'chat' request the linked
// transcript loads via the admin RPC. Admin can set status + notes.

type Req = {
  id: string; user_id: string; org_id: string | null; kind: "general" | "chat";
  message: string; related_chat_id: string | null; status: "open" | "in_progress" | "resolved";
  admin_notes: string | null; created_at: string;
  organizations?: { name: string | null } | null;
};
type Msg = { role: "user" | "assistant"; content: string };

const STATUSES = ["open", "in_progress", "resolved"] as const;
const statusColor = (s: string) => s === "open" ? "#f5a623" : s === "in_progress" ? "#5b9bff" : "#2ecc71";
const fmt = (d: string) => new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function AdminSupport() {
  const [reqs, setReqs] = useState<Req[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Req | null>(null);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [transcript, setTranscript] = useState<Msg[] | null>(null);
  const [transcriptErr, setTranscriptErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("support_requests")
      .select("id, user_id, org_id, kind, message, related_chat_id, status, admin_notes, created_at, organizations(name)")
      .order("created_at", { ascending: false });
    setReqs((data as Req[] | null) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const select = useCallback(async (r: Req) => {
    setSelected(r); setNotes(r.admin_notes ?? ""); setTranscript(null); setTranscriptErr(null);
    if (r.kind === "chat" && r.related_chat_id) {
      const { data, error } = await supabase.rpc("admin_get_mailbox_chat", { p_chat_id: r.related_chat_id });
      if (error) setTranscriptErr(error.message);
      else if ((data as { error?: string })?.error) setTranscriptErr("Chat no longer available.");
      else setTranscript((data as { messages: Msg[] }).messages ?? []);
    }
  }, []);

  const save = useCallback(async (status: Req["status"]) => {
    if (!selected) return;
    setSaving(true);
    await supabase.from("support_requests").update({ status, admin_notes: notes }).eq("id", selected.id);
    setSaving(false);
    setSelected({ ...selected, status, admin_notes: notes });
    void load();
  }, [selected, notes, load]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 16, minHeight: 480 }}>
      <div style={{ border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ overflowY: "auto", maxHeight: 600 }}>
          {loading && <p style={{ opacity: 0.6, padding: 14, fontSize: 13 }}>Loading…</p>}
          {!loading && reqs.length === 0 && <p style={{ opacity: 0.5, padding: 14, fontSize: 13 }}>No support requests yet.</p>}
          {reqs.map((r) => (
            <button key={r.id} onClick={() => void select(r)} style={{
              display: "block", width: "100%", textAlign: "left", padding: "10px 12px", border: "none", cursor: "pointer",
              borderBottom: "1px solid rgba(255,255,255,0.05)", color: "inherit",
              background: r.id === selected?.id ? "rgba(200,169,110,0.12)" : "transparent",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{r.organizations?.name || "Account"}</span>
                <span style={{ fontSize: 10, color: statusColor(r.status), border: `1px solid ${statusColor(r.status)}`, borderRadius: 4, padding: "0 5px", textTransform: "uppercase", whiteSpace: "nowrap" }}>{r.status.replace("_", " ")}</span>
              </div>
              <div style={{ fontSize: 11, opacity: 0.6 }}>{r.kind === "chat" ? "Flagged chat" : "General"} · {fmt(r.created_at)}</div>
              <div style={{ fontSize: 12, opacity: 0.8, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.message}</div>
            </button>
          ))}
        </div>
      </div>

      <div style={{ border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: 16, overflowY: "auto", maxHeight: 632 }}>
        {!selected ? (
          <p style={{ opacity: 0.5, fontSize: 13 }}>Select a request.</p>
        ) : (
          <>
            <div style={{ fontSize: 12, opacity: 0.6 }}>{selected.kind === "chat" ? "Flagged chat" : "General enquiry"} · {fmt(selected.created_at)}</div>
            <div style={{ fontSize: 14, marginTop: 8, whiteSpace: "pre-wrap" }}>{selected.message}</div>

            {selected.kind === "chat" && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.55, marginBottom: 6 }}>Linked transcript</div>
                {transcriptErr && <p style={{ color: "#e74c3c", fontSize: 12 }}>{transcriptErr}</p>}
                {!transcript && !transcriptErr && <p style={{ opacity: 0.5, fontSize: 12 }}>Loading…</p>}
                {transcript && (
                  <div style={{ border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: 12, maxHeight: 280, overflowY: "auto" }}>
                    {transcript.map((m, i) => (
                      <div key={i} style={{ marginBottom: 8 }}>
                        <span style={{ fontSize: 10.5, opacity: 0.5 }}>{m.role === "user" ? "User" : "Cotton AI"}</span>
                        <div style={{ fontSize: 12.5, whiteSpace: "pre-wrap", opacity: 0.9 }}>{m.content.slice(0, 1200)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.55, marginBottom: 6 }}>Admin notes</div>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
                style={{ width: "100%", padding: "8px 10px", borderRadius: 8, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", color: "inherit", resize: "vertical" }} />
              <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
                <span style={{ fontSize: 12, opacity: 0.6 }}>Set status:</span>
                {STATUSES.map((s) => (
                  <button key={s} disabled={saving} onClick={() => void save(s)} style={{
                    fontSize: 12, padding: "5px 11px", borderRadius: 7, cursor: "pointer", color: "inherit",
                    background: selected.status === s ? "rgba(200,169,110,0.18)" : "rgba(255,255,255,0.05)",
                    border: `1px solid ${selected.status === s ? "rgba(200,169,110,0.4)" : "rgba(255,255,255,0.14)"}`,
                  }}>{s.replace("_", " ")}</button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
