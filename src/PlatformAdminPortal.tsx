import { useCallback, useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import type { Chat, Org, OrgSheet, MessageRow, OrgDocument, SystemPrompt } from "./lib/types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as XLSX from "xlsx";
import { AdminMailboxChats } from "./AdminMailboxChats";
import { AdminSupport } from "./AdminSupport";

type Props = {
  user: User;
  allOrgs: Org[];
  onOrgsChange: () => void;
};

type Tab = "overview" | "orgs" | "create" | "prompts" | "chats" | "support";

function generatePassword(length = 12): string {
  const chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%";
  let password = "";
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

export function PlatformAdminPortal({ user: _user, allOrgs, onOrgsChange }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [generatedPassword, setGeneratedPassword] = useState("");
  const [createStep, setCreateStep] = useState<1 | 2>(1);
  const [createdOrgName, setCreatedOrgName] = useState("");
  const [createdEmail, setCreatedEmail] = useState("");
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheets, setSheets] = useState<OrgSheet[]>([]);
  const [documents, setDocuments] = useState<OrgDocument[]>([]);
  const [orgChats, setOrgChats] = useState<Chat[]>([]);
  const [viewChat, setViewChat] = useState<Chat | null>(null);
  const [viewMsgs, setViewMsgs] = useState<MessageRow[]>([]);
  const [notesEdit, setNotesEdit] = useState("");
  const [customPrompt, setCustomPrompt] = useState("");
  const [defaultPrompt, setDefaultPrompt] = useState<SystemPrompt | null>(null);
  const [editingDefaultPrompt, setEditingDefaultPrompt] = useState("");
  const [showResetModal, setShowResetModal] = useState(false);
  const [newPassword, setNewPassword] = useState("");

  const selected = allOrgs.find((o) => o.id === selectedId) ?? null;

  useEffect(() => {
    setNotesEdit(selected?.notes ?? "");
    setCustomPrompt(selected?.custom_system_prompt ?? "");
  }, [selected?.id, selected?.notes, selected?.custom_system_prompt]);

  useEffect(() => {
    void loadDefaultPrompt();
  }, []);

  const loadDefaultPrompt = async () => {
    const { data } = await supabase
      .from("system_prompts")
      .select("*")
      .eq("is_default", true)
      .is("org_id", null)
      .single();
    if (data) {
      setDefaultPrompt(data as SystemPrompt);
      setEditingDefaultPrompt((data as SystemPrompt).prompt_text);
    }
  };

  const loadSheets = useCallback(async (orgId: string) => {
    const { data } = await supabase
      .from("org_sheets")
      .select("*")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false });
    setSheets((data as OrgSheet[] | null) ?? []);
  }, []);

  const loadDocuments = useCallback(async (orgId: string) => {
    const { data } = await supabase
      .from("org_documents")
      .select("*")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false });
    setDocuments((data as OrgDocument[] | null) ?? []);
  }, []);

  const loadOrgChats = useCallback(async (orgId: string) => {
    const { data } = await supabase
      .from("chats")
      .select("*")
      .eq("org_id", orgId)
      .order("updated_at", { ascending: false });
    setOrgChats((data as Chat[] | null) ?? []);
  }, []);

  useEffect(() => {
    if (selectedId) {
      void loadSheets(selectedId);
      void loadDocuments(selectedId);
      void loadOrgChats(selectedId);
    } else {
      setSheets([]);
      setDocuments([]);
      setOrgChats([]);
    }
  }, [selectedId, loadSheets, loadDocuments, loadOrgChats]);

  const showMessage = (msg: string, isError = false) => {
    if (isError) {
      setErr(msg);
      setSuccess(null);
    } else {
      setSuccess(msg);
      setErr(null);
    }
    setTimeout(() => {
      setErr(null);
      setSuccess(null);
    }, 5000);
  };

  const createOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;
    setErr(null);
    setBusy(true);
    
    const password = generatePassword();
    
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not authenticated");

      const base = import.meta.env.VITE_SUPABASE_URL;
      const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;
      
      const res = await fetch(`${base}/functions/v1/admin_create_user`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: anon,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: email.trim(),
          password,
          orgName: name.trim(),
          notes: notes.trim() || null,
        }),
      });

      const result = await res.json() as { success?: boolean; orgId?: string; error?: string };
      
      if (!res.ok || result.error) {
        throw new Error(result.error || "Failed to create account");
      }
      
      setCreatedOrgName(name.trim());
      setCreatedEmail(email.trim());
      setGeneratedPassword(password);
      setName("");
      setEmail("");
      setNotes("");
      onOrgsChange();
      if (result.orgId) setSelectedId(result.orgId);
      setCreateStep(2);
    } catch (er: unknown) {
      showMessage(er instanceof Error ? er.message : String(er), true);
      setGeneratedPassword("");
    } finally {
      setBusy(false);
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(`${label} copied!`);
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch {
      setCopyFeedback("Failed to copy");
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  };

  const copyBothCredentials = async () => {
    const text = `Email: ${createdEmail}\nPassword: ${generatedPassword}`;
    await copyToClipboard(text, "Credentials");
  };

  const resetCreateWizard = () => {
    setCreateStep(1);
    setGeneratedPassword("");
    setCreatedOrgName("");
    setCreatedEmail("");
  };

  const resetPassword = async () => {
    if (!selected?.email) return;
    setBusy(true);
    const password = generatePassword();
    setNewPassword(password);
    
    try {
      showMessage(`New password generated: ${password}. User must change on next login.`);
      
      await supabase
        .from("organizations")
        .update({ password_must_change: true })
        .eq("id", selected.id);
        
      setShowResetModal(false);
    } catch (er: unknown) {
      showMessage(er instanceof Error ? er.message : String(er), true);
    } finally {
      setBusy(false);
    }
  };

  const saveNotes = async () => {
    if (!selectedId) return;
    setBusy(true);
    try {
      const { error: ue } = await supabase
        .from("organizations")
        .update({ notes: notesEdit.trim() || null })
        .eq("id", selectedId);
      if (ue) throw ue;
      onOrgsChange();
      showMessage("Notes saved");
    } catch (er: unknown) {
      showMessage(er instanceof Error ? er.message : String(er), true);
    } finally {
      setBusy(false);
    }
  };

  const saveCustomPrompt = async () => {
    if (!selectedId) return;
    setBusy(true);
    try {
      const { error: ue } = await supabase
        .from("organizations")
        .update({ custom_system_prompt: customPrompt.trim() || null })
        .eq("id", selectedId);
      if (ue) throw ue;
      onOrgsChange();
      showMessage("Custom prompt saved for this organization");
    } catch (er: unknown) {
      showMessage(er instanceof Error ? er.message : String(er), true);
    } finally {
      setBusy(false);
    }
  };

  const saveDefaultPrompt = async () => {
    if (!defaultPrompt) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from("system_prompts")
        .update({ prompt_text: editingDefaultPrompt, updated_at: new Date().toISOString() })
        .eq("id", defaultPrompt.id);
      if (error) throw error;
      await loadDefaultPrompt();
      showMessage("Default system prompt updated");
    } catch (er: unknown) {
      showMessage(er instanceof Error ? er.message : String(er), true);
    } finally {
      setBusy(false);
    }
  };

  const readFileAsText = (file: File): Promise<string | null> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    });
  };

  const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer | null> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer | null);
      reader.onerror = () => resolve(null);
      reader.readAsArrayBuffer(file);
    });
  };

  const parseExcelToMarkdown = async (file: File): Promise<string | null> => {
    try {
      const buffer = await readFileAsArrayBuffer(file);
      if (!buffer) return null;
      const workbook = XLSX.read(buffer, { type: "array" });
      const parts: string[] = [];
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) continue;
        const csv = XLSX.utils.sheet_to_csv(sheet);
        if (!csv.trim()) continue;
        const rows = csv.split("\n").filter(r => r.trim());
        if (rows.length === 0) continue;
        parts.push(`## Sheet: ${sheetName}\n`);
        const headers = rows[0].split(",");
        parts.push("| " + headers.join(" | ") + " |");
        parts.push("| " + headers.map(() => "---").join(" | ") + " |");
        for (let i = 1; i < rows.length; i++) {
          const cells = rows[i].split(",");
          parts.push("| " + cells.join(" | ") + " |");
        }
        parts.push("");
      }
      return parts.length > 0 ? parts.join("\n") : null;
    } catch {
      return null;
    }
  };

  const onDocumentUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f || !selectedId) return;
    void (async () => {
      setBusy(true);
      const id = crypto.randomUUID();
      const ext = f.name.includes(".") ? f.name.slice(f.name.lastIndexOf(".")) : "";
      const path = `${selectedId}/docs/${id}${ext}`;

      let parsedContent: string | null = null;
      const lowerName = f.name.toLowerCase();
      const textTypes = [
        "text/plain", "text/csv", "text/markdown", "text/html",
        "application/json", "application/xml",
      ];
      const textExts = [".txt", ".csv", ".md", ".json", ".xml", ".tsv", ".log"];
      const excelExts = [".xlsx", ".xls", ".xlsb"];
      const isTextFile = textTypes.includes(f.type) || textExts.some(te => lowerName.endsWith(te));
      const isExcelFile = excelExts.some(te => lowerName.endsWith(te)) ||
        f.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
        f.type === "application/vnd.ms-excel";
      
      if (isExcelFile) {
        parsedContent = await parseExcelToMarkdown(f);
      } else if (isTextFile) {
        parsedContent = await readFileAsText(f);
      }
      
      const { error: upErr } = await supabase.storage
        .from("org-sheets")
        .upload(path, f, { upsert: true, contentType: f.type || undefined });
      if (upErr) {
        showMessage(upErr.message, true);
        setBusy(false);
        e.target.value = "";
        return;
      }
      
      const { error: insErr } = await supabase
        .from("org_documents")
        .insert({
          org_id: selectedId,
          name: f.name.replace(/\.[^/.]+$/, ""),
          storage_path: path,
          original_filename: f.name,
          file_type: f.type || null,
          file_size_bytes: f.size,
          parsed_content: parsedContent ? parsedContent.slice(0, 200_000) : null,
          is_active: true,
        });
      if (insErr) {
        showMessage(insErr.message, true);
      } else {
        await loadDocuments(selectedId);
        showMessage(
          parsedContent
            ? `Document "${f.name}" uploaded and parsed (${(parsedContent.length / 1024).toFixed(1)} KB of text)`
            : `Document "${f.name}" uploaded (could not extract text - try .xlsx, .csv, or .txt)`
        );
      }
      setBusy(false);
      e.target.value = "";
    })();
  };

  const toggleDocumentActive = async (doc: OrgDocument) => {
    const { error } = await supabase
      .from("org_documents")
      .update({ is_active: !doc.is_active })
      .eq("id", doc.id);
    if (!error && selectedId) {
      await loadDocuments(selectedId);
    }
  };

  const deleteDocument = async (doc: OrgDocument) => {
    if (!confirm(`Delete "${doc.original_filename}"?`)) return;
    await supabase.storage.from("org-sheets").remove([doc.storage_path]);
    await supabase.from("org_documents").delete().eq("id", doc.id);
    if (selectedId) await loadDocuments(selectedId);
    showMessage("Document deleted");
  };

  const openChat = async (c: Chat) => {
    setViewChat(c);
    const { data } = await supabase
      .from("messages")
      .select("*")
      .eq("chat_id", c.id)
      .order("created_at", { ascending: true });
    setViewMsgs((data as MessageRow[] | null) ?? []);
  };

  const toggleOrgActive = async (org: Org) => {
    const { error } = await supabase
      .from("organizations")
      .update({ is_active: !org.is_active })
      .eq("id", org.id);
    if (!error) {
      onOrgsChange();
      showMessage(org.is_active ? "Organization deactivated" : "Organization activated");
    }
  };

  return (
    <div className="admin-portal">
      {(err || success) && (
        <div className={`admin-toast ${err ? "error" : "success"}`}>
          {err || success}
        </div>
      )}

      <div className="admin-header">
        <div>
          <h1>Platform <em>Admin</em></h1>
          <p>Manage organization accounts, documents, and AI prompts</p>
        </div>
      </div>

      <div className="admin-tabs">
        <button type="button" className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>
          Overview
        </button>
        <button type="button" className={tab === "orgs" ? "active" : ""} onClick={() => setTab("orgs")}>
          Organizations
        </button>
        <button type="button" className={tab === "prompts" ? "active" : ""} onClick={() => setTab("prompts")}>
          AI Prompts
        </button>
        <button type="button" className={tab === "chats" ? "active" : ""} onClick={() => setTab("chats")}>
          Mailbox Chats
        </button>
        <button type="button" className={tab === "support" ? "active" : ""} onClick={() => setTab("support")}>
          Support
        </button>
        <button type="button" className={tab === "create" ? "active" : ""} onClick={() => setTab("create")}>
          + Create Account
        </button>
      </div>

      {tab === "chats" && <AdminMailboxChats />}
      {tab === "support" && <AdminSupport />}

      {tab === "overview" && (
        <div className="admin-overview">
          <div className="admin-stats">
            <div className="admin-stat-card">
              <div className="stat-value">{allOrgs.length}</div>
              <div className="stat-label">Organizations</div>
            </div>
            <div className="admin-stat-card">
              <div className="stat-value">{allOrgs.filter(o => o.is_active !== false).length}</div>
              <div className="stat-label">Active</div>
            </div>
            <div className="admin-stat-card">
              <div className="stat-value">{documents.length}</div>
              <div className="stat-label">Documents</div>
            </div>
            <div className="admin-stat-card">
              <div className="stat-value">{orgChats.length}</div>
              <div className="stat-label">Conversations</div>
            </div>
          </div>

          <div className="admin-org-grid">
            <h3>All Organization Accounts</h3>
            {allOrgs.length === 0 ? (
              <div className="admin-empty">
                <p>No organization accounts yet</p>
                <button type="button" className="btn btn-primary" onClick={() => setTab("create")}>
                  Create First Account
                </button>
              </div>
            ) : (
              <div className="org-cards">
                {allOrgs.map((org) => (
                  <div
                    key={org.id}
                    className={`org-card ${selectedId === org.id ? "selected" : ""} ${org.is_active === false ? "inactive" : ""}`}
                    onClick={() => { setSelectedId(org.id); setTab("orgs"); }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") { setSelectedId(org.id); setTab("orgs"); } }}
                  >
                    <div className="org-card-header">
                      <div className="org-avatar">{org.name.charAt(0).toUpperCase()}</div>
                      <div className="org-info">
                        <h4>{org.name}</h4>
                        <span className="org-email">{org.email || "No email"}</span>
                      </div>
                      <span className={`org-status ${org.is_active === false ? "inactive" : "active"}`}>
                        {org.is_active === false ? "Inactive" : "Active"}
                      </span>
                    </div>
                    {org.notes && <p className="org-notes">{org.notes}</p>}
                    <div className="org-card-footer">
                      <span>Manage →</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "orgs" && (
        <div className="admin-org-detail">
          <div className="org-selector">
            <label>Select Organization Account</label>
            <div className="org-selector-grid">
              {allOrgs.map((org) => (
                <button
                  key={org.id}
                  type="button"
                  className={`org-selector-item ${selectedId === org.id ? "active" : ""} ${org.is_active === false ? "inactive" : ""}`}
                  onClick={() => { setSelectedId(org.id); setViewChat(null); }}
                >
                  <span className="org-selector-avatar">{org.name.charAt(0).toUpperCase()}</span>
                  <span className="org-selector-name">{org.name}</span>
                </button>
              ))}
            </div>
          </div>

          {selected && (
            <div className="org-detail-panels">
              <div className="org-detail-left">
                <div className="detail-section">
                  <div className="section-header-row">
                    <h3>Account Details</h3>
                    <button
                      type="button"
                      className={`status-toggle ${selected.is_active === false ? "" : "active"}`}
                      onClick={() => void toggleOrgActive(selected)}
                    >
                      {selected.is_active === false ? "Activate" : "Deactivate"}
                    </button>
                  </div>
                  <div className="detail-field">
                    <label>Organization Name</label>
                    <p>{selected.name}</p>
                  </div>
                  <div className="detail-field">
                    <label>Login Email</label>
                    <p>{selected.email || "Not set"}</p>
                  </div>
                  <div className="detail-field">
                    <label>Password</label>
                    <div className="password-row">
                      <span className="password-masked">••••••••••••</span>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowResetModal(true)}>
                        Reset Password
                      </button>
                    </div>
                    {selected.password_must_change && (
                      <p className="password-warning">User must change password on next login</p>
                    )}
                  </div>
                  <div className="detail-field">
                    <label>Internal Notes</label>
                    <textarea
                      value={notesEdit}
                      onChange={(ev) => setNotesEdit(ev.target.value)}
                      rows={3}
                      disabled={busy}
                      placeholder="Add internal notes..."
                    />
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void saveNotes()} disabled={busy}>
                      Save Notes
                    </button>
                  </div>
                </div>

                <div className="detail-section">
                  <h3>AI Documents ({documents.length})</h3>
                  <p className="section-description">
                    Upload documents to provide context for AI conversations. All active documents will be used.
                  </p>
                  <div className="upload-zone">
                    <input type="file" id="doc-upload" onChange={onDocumentUpload} disabled={busy} accept=".pdf,.doc,.docx,.txt,.xlsx,.xls,.csv" />
                    <label htmlFor="doc-upload" className="upload-label">
                      <span className="upload-icon">📄</span>
                      <span>Drop file or click to upload</span>
                      <span className="upload-hint">PDF, Word, Excel, Text</span>
                    </label>
                  </div>
                  {documents.length > 0 && (
                    <ul className="document-list">
                      {documents.map((doc) => (
                        <li key={doc.id} className={`document-item ${doc.is_active ? "active" : "inactive"}`}>
                          <div className="doc-info">
                            <span className="doc-name">{doc.original_filename}</span>
                            <span className="doc-meta">
                              {doc.file_size_bytes ? `${(doc.file_size_bytes / 1024).toFixed(1)} KB` : ""} • {new Date(doc.created_at).toLocaleDateString()}
                            </span>
                          </div>
                          <div className="doc-actions">
                            <button type="button" className="btn-icon" onClick={() => void toggleDocumentActive(doc)} title={doc.is_active ? "Disable" : "Enable"}>
                              {doc.is_active ? "✓" : "○"}
                            </button>
                            <button type="button" className="btn-icon delete" onClick={() => void deleteDocument(doc)} title="Delete">
                              ×
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="detail-section">
                  <h3>Custom AI Prompt</h3>
                  <p className="section-description">
                    Override the default system prompt for this organization. Leave empty to use default.
                  </p>
                  <textarea
                    value={customPrompt}
                    onChange={(ev) => setCustomPrompt(ev.target.value)}
                    rows={6}
                    disabled={busy}
                    placeholder="Custom instructions for AI... (leave empty for default)"
                  />
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void saveCustomPrompt()} disabled={busy}>
                    Save Custom Prompt
                  </button>
                </div>
              </div>

              <div className="org-detail-right">
                <div className="detail-section">
                  <h3>Workbooks (Legacy)</h3>
                  {sheets.length === 0 ? (
                    <p className="empty-text">No workbooks uploaded</p>
                  ) : (
                    <ul className="sheet-list">
                      {sheets.map((s) => (
                        <li key={s.id} className={`sheet-item ${s.parse_status}`}>
                          <span className="sheet-name">{s.original_filename}</span>
                          <span className={`sheet-status status-${s.parse_status}`}>
                            {s.parse_status}{s.is_active && " • Active"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="detail-section">
                  <h3>Recent Chats ({orgChats.length})</h3>
                  {orgChats.length === 0 ? (
                    <p className="empty-text">No conversations yet</p>
                  ) : (
                    <ul className="chat-list">
                      {orgChats.slice(0, 8).map((c) => (
                        <li key={c.id}>
                          <button type="button" className="chat-item" onClick={() => void openChat(c)}>
                            <span className="chat-title">{c.title}</span>
                            <span className="chat-date">{new Date(c.updated_at).toLocaleDateString()}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "prompts" && (
        <div className="admin-prompts">
          <div className="detail-section" style={{ maxWidth: 800 }}>
            <h3>Default System Prompt</h3>
            <p className="section-description">
              This prompt applies to all organizations unless they have a custom prompt set.
            </p>
            <textarea
              value={editingDefaultPrompt}
              onChange={(ev) => setEditingDefaultPrompt(ev.target.value)}
              rows={16}
              disabled={busy}
              className="prompt-textarea"
            />
            <div className="prompt-actions">
              <button type="button" className="btn btn-primary" onClick={() => void saveDefaultPrompt()} disabled={busy}>
                Save Default Prompt
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setEditingDefaultPrompt(defaultPrompt?.prompt_text ?? "")}
                disabled={busy}
              >
                Reset Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === "create" && (
        <div className="admin-create">
          <div className="create-wizard">
            <div className="wizard-steps">
              <div className={`wizard-step ${createStep >= 1 ? "active" : ""} ${createStep > 1 ? "completed" : ""}`}>
                <span className="step-number">{createStep > 1 ? "✓" : "1"}</span>
                <span className="step-label">Organization Details</span>
              </div>
              <div className="wizard-step-line" />
              <div className={`wizard-step ${createStep >= 2 ? "active" : ""}`}>
                <span className="step-number">2</span>
                <span className="step-label">Credentials</span>
              </div>
            </div>

            {createStep === 1 && (
              <form onSubmit={createOrg} className="create-form">
                <h3>Create Organization Account</h3>
                <p>Set up a new organization with login credentials</p>
                
                <div className="form-field">
                  <label htmlFor="org-name">Organization Name</label>
                  <input
                    id="org-name"
                    value={name}
                    onChange={(ev) => setName(ev.target.value)}
                    placeholder="e.g., Acme Textiles Ltd."
                    required
                    disabled={busy}
                  />
                </div>

                <div className="form-field">
                  <label htmlFor="org-email">Login Email</label>
                  <input
                    id="org-email"
                    type="email"
                    value={email}
                    onChange={(ev) => setEmail(ev.target.value)}
                    placeholder="organization@example.com"
                    required
                    disabled={busy}
                  />
                  <span className="field-hint">This will be used to sign in</span>
                </div>

                <div className="form-field">
                  <label htmlFor="org-notes">Internal Notes (optional)</label>
                  <textarea
                    id="org-notes"
                    value={notes}
                    onChange={(ev) => setNotes(ev.target.value)}
                    placeholder="Contact info, special requirements, etc."
                    rows={3}
                    disabled={busy}
                  />
                </div>

                <button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || !email.trim()}>
                  {busy ? "Creating..." : "Create Account →"}
                </button>
              </form>
            )}

            {createStep === 2 && (
              <div className="create-form credentials-step">
                <div className="success-icon">✓</div>
                <h3>Account Created!</h3>
                <p>Share these credentials with <strong>{createdOrgName}</strong></p>
                
                <div className="credentials-card">
                  <div className="credential-row">
                    <div className="credential-info">
                      <span className="credential-label">Email</span>
                      <span className="credential-value">{createdEmail}</span>
                    </div>
                    <button 
                      type="button" 
                      className="btn-copy" 
                      onClick={() => void copyToClipboard(createdEmail, "Email")}
                    >
                      Copy
                    </button>
                  </div>
                  <div className="credential-row">
                    <div className="credential-info">
                      <span className="credential-label">Password</span>
                      <span className="credential-value mono">{generatedPassword}</span>
                    </div>
                    <button 
                      type="button" 
                      className="btn-copy" 
                      onClick={() => void copyToClipboard(generatedPassword, "Password")}
                    >
                      Copy
                    </button>
                  </div>
                </div>

                <button 
                  type="button" 
                  className="btn btn-primary copy-all-btn" 
                  onClick={() => void copyBothCredentials()}
                >
                  Copy Both Credentials
                </button>

                {copyFeedback && (
                  <div className="copy-feedback">{copyFeedback}</div>
                )}

                <p className="credentials-note">
                  The organization can sign in immediately. They should change their password after first login.
                </p>

                <button 
                  type="button" 
                  className="btn btn-ghost" 
                  onClick={resetCreateWizard}
                >
                  ← Create Another Account
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {showResetModal && (
        <div className="modal-overlay" onClick={() => setShowResetModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Reset Password</h3>
            <p>Generate a new password for <strong>{selected?.name}</strong>?</p>
            <p className="modal-note">The user will be required to change it on next login.</p>
            {newPassword && (
              <div className="credentials-box">
                <div><strong>New Password:</strong> <code>{newPassword}</code></div>
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => { setShowResetModal(false); setNewPassword(""); }}>
                {newPassword ? "Close" : "Cancel"}
              </button>
              {!newPassword && (
                <button type="button" className="btn btn-primary" onClick={() => void resetPassword()} disabled={busy}>
                  Generate New Password
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {viewChat && (
        <div className="chat-modal-overlay" onClick={() => setViewChat(null)}>
          <div className="chat-modal" onClick={(e) => e.stopPropagation()}>
            <div className="chat-modal-header">
              <h3>{viewChat.title}</h3>
              <button type="button" onClick={() => setViewChat(null)}>×</button>
            </div>
            <div className="chat-modal-body">
              {viewMsgs.map((m) => (
                <div key={m.id} className={`chat-modal-msg ${m.role}`}>
                  <div className="msg-role">{m.role}</div>
                  {m.role === "assistant" ? (
                    <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div>
                  ) : (
                    <p>{m.content}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
