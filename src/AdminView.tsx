import { useCallback, useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import { invokeIngest } from "./lib/api";
import type { OrgSheet } from "./lib/types";

type Props = {
  orgId: string;
  onIngested: () => void;
  onProfileChanged: () => void;
};

function AdminView({ orgId, onIngested, onProfileChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [sheets, setSheets] = useState<OrgSheet[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase
      .from("org_sheets")
      .select("*")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false });
    if (e) {
      console.error(e);
    } else {
      setSheets((data as OrgSheet[] | null) ?? []);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) {
      return;
    }
    void (async () => {
      setErr(null);
      setMessage(null);
      setBusy(true);
      const id = crypto.randomUUID();
      const ext = f.name.includes(".")
        ? f.name.slice(f.name.lastIndexOf("."))
        : ".xlsx";
      const path = `${orgId}/${id}${ext}`;
      const { error: upErr } = await supabase.storage
        .from("org-sheets")
        .upload(path, f, { upsert: true, contentType: f.type || undefined });
      if (upErr) {
        setErr(upErr.message);
        setBusy(false);
        e.target.value = "";
        return;
      }
      const { data: ins, error: insErr } = await supabase
        .from("org_sheets")
        .insert({
          org_id: orgId,
          storage_path: path,
          original_filename: f.name,
          parse_status: "pending",
          is_active: false,
        })
        .select("id")
        .single();
      if (insErr || !ins) {
        setErr(insErr?.message ?? "Insert failed");
        setBusy(false);
        e.target.value = "";
        return;
      }
      const sheetId = (ins as { id: string }).id;
      try {
        await invokeIngest(sheetId);
        setMessage("Ingested successfully.");
        await load();
        onIngested();
        onProfileChanged();
      } catch (ing: unknown) {
        setErr(ing instanceof Error ? ing.message : String(ing));
        await load();
      } finally {
        setBusy(false);
        e.target.value = "";
      }
    })();
  };

  return (
    <div className="admin-body">
      <div className="admin-card">
        <h2>Organization workbook</h2>
        <p>
          Upload an Excel file (.xlsx). It will be parsed on the server and
          used as the only source of truth for this org&apos;s Cotton AI
          answers.
        </p>
        <div className="field">
          <label htmlFor="xlsx">File</label>
          <input
            id="xlsx"
            name="xlsx"
            type="file"
            accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            onChange={onFile}
            disabled={busy}
          />
        </div>
        {err && <p className="error-text">{err}</p>}
        {message && <p className="admin-status status-ready">{message}</p>}
        {busy && <p className="admin-status status-pending">Processing…</p>}
        <h3
          style={{
            fontSize: 14,
            color: "var(--text-dim)",
            marginTop: 24,
            marginBottom: 8,
          }}
        >
          Ingests
        </h3>
        {sheets.length === 0 && (
          <p className="admin-status">No uploads yet.</p>
        )}
        <ul
          style={{
            listStyle: "none",
            fontSize: 12,
            fontFamily: "var(--mono)",
            color: "var(--text-dim)",
          }}
        >
          {sheets.map((s) => (
            <li key={s.id} style={{ marginBottom: 6 }}>
              {s.original_filename} — {s.parse_status}
              {s.is_active && " (active)"}
              {s.parse_status === "error" && s.error_message
                ? ` — ${s.error_message}`
                : ""}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default AdminView;
