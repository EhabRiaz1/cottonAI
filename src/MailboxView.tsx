import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as XLSX from "xlsx";
import { supabase } from "./lib/supabase";
import {
  getMailboxStatus,
  type MailboxArtifact,
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
type ChatMsg = { role: "user" | "assistant"; content: string; sources?: SourceCard[]; artifacts?: MailboxArtifact[] };

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

// WhatsApp shares carry TEXT only (transcript / single answer). Files use the
// OS share sheet via openArtifact. wa.me text is capped to stay under the URL budget.
function transcriptText(msgs: ChatMsg[], cap = 1500): string {
  let out = msgs.map((m) => `${m.role === "user" ? "You" : "Cotton AI"}: ${m.content}`).join("\n\n");
  if (out.length > cap) out = out.slice(0, cap) + "\n\n…(transcript truncated — ask for the full export)";
  return out;
}
const shareWhatsAppText = (text: string) => window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");

// Mailbox timeline presets. `kind` disambiguates the three behaviours that used to be
// overloaded onto `days: number | null`: bounded hour-windows, the custom date-range
// reveal, and the whole-mailbox catch-all.
type ScopeOption = { label: string; kind: "hours" | "custom" | "all"; days?: number };
const SCOPE_OPTIONS: ScopeOption[] = [
  { label: "Last 24 hours", kind: "hours", days: 1 },
  { label: "Last 48 hours", kind: "hours", days: 2 },
  { label: "Last 72 hours", kind: "hours", days: 3 },
  { label: "Custom date range…", kind: "custom" },
  { label: "Entire mailbox", kind: "all" },
];
// offer_date is a calendar-day DATE, so windows are day-granular. An N-day window means
// the last N calendar days INCLUSIVE of today → offset (N-1): 24h→today, 48h→2 days, 72h→3.
const daysToDateFrom = (days: number) =>
  new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
const todayISODate = () => new Date().toISOString().slice(0, 10);

// Pending-LC list: the agent pulls contracts from the Elithum portal. We ask the
// Date-of-Sale window as a claude.ai-style multiple choice (D = custom range).
const LC_RANGE_OPTIONS: { label: string; years: number | null }[] = [
  { label: "Last 1 year", years: 1 },
  { label: "Last 2 years", years: 2 },
  { label: "Last 5 years", years: 5 },
  { label: "Custom date range…", years: null },
];
// Detects a "Pending LC's list" style request so we route to Elithum, not the mailbox.
const PENDING_LC_RE = /(pending\s*l\.?\/?c)|(\blc'?s?\b[^.]*\blist\b)|(letter\s+of\s+credit)/i;
const PENDING_LC_PROMPT = "Make me a Pending LC's list";
// Detects a "Pending Shipments list" request. Anchored on "pending" so ordinary
// mailbox talk ("shipment list from the COFCO email") is NOT hijacked to Elithum.
// Checked BEFORE PENDING_LC_RE so a dual-mention prompt still resolves deterministically.
const PENDING_SHIP_RE = /(pending\s*shipments?)|(\bshipments?\s+(list|summary)\b[^.]*\bpending\b)|(\bpending\b[^.]*\bshipments?\s+(list|summary)\b)/i;
const PENDING_SHIP_PROMPT = "Make me a Pending Shipments list";
// Detects a "Pending IPs list" request (one row per IP). Anchored on "pending".
const PENDING_IPS_RE = /(pending\s*ip'?s?\b)|(\bip'?s?\s+(list|summary)\b[^.]*\bpending\b)|(\bpending\b[^.]*\bip'?s?\s+(list|summary)\b)/i;
const PENDING_IPS_PROMPT = "Make me a Pending IPs list";
// Detects a "Pending Docs list" request (one row per shipment, with doc columns).
const PENDING_DOCS_RE = /(pending\s*docs?)|(\bdocs?\s+(list|summary)\b[^.]*\bpending\b)|(\bpending\b[^.]*\bdocs?\s+(list|summary)\b)/i;
const PENDING_DOCS_PROMPT = "Make me a Pending Docs list";
// Detects a "Pending Payments list" request (one row per shipment + Payment Date).
const PENDING_PAYMENTS_RE = /(pending\s*payments?)|(\bpayments?\s+(list|summary)\b[^.]*\bpending\b)|(\bpending\b[^.]*\bpayments?\s+(list|summary)\b)/i;
const PENDING_PAYMENTS_PROMPT = "Make me a Pending Payments list";

export function MailboxView({ isPlatformAdmin, userName, orgId }: { isPlatformAdmin: boolean; userName?: string; orgId?: string | null }) {
  const [mode, setMode] = useState<"inbox" | "offers">("inbox");
  const [emails, setEmails] = useState<Email[]>([]);
  const [attCounts, setAttCounts] = useState<Record<string, number>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attLoading, setAttLoading] = useState(false);
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

  // Timeline scope — asked as a multiple-choice question before the first answer.
  const [timeline, setTimeline] = useState<{ label: string; dateFrom: string | null; dateTo: string | null } | null>(null);
  const [pendingMessages, setPendingMessages] = useState<ChatMsg[] | null>(null);
  // Custom-range reveal for the mailbox timeline gate (separate toggle so picking
  // "Custom date range…" defers the run while the user fills in the dates).
  const [scopeCustom, setScopeCustom] = useState(false);
  const [scopeFrom, setScopeFrom] = useState("");
  const [scopeTo, setScopeTo] = useState(todayISODate); // prefill To = today (common "from X until now")

  // Pending Elithum-report clarification — its own state machine, separate from the
  // mailbox timeline gate (an Elithum request must NOT trigger "how far back in your
  // mailbox"). `report` selects which sheet (LC vs Shipments); the date-range UX is shared.
  const [pendingLcAsk, setPendingLcAsk] = useState<{ msgs: ChatMsg[]; report: "lc" | "shipments" | "ips" | "docs" | "payments" } | null>(null);
  const [lcCustom, setLcCustom] = useState(false);
  const [lcFrom, setLcFrom] = useState("");
  const [lcTo, setLcTo] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Saved conversation history.
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const currentChatIdRef = useRef<string | null>(null);
  const [history, setHistory] = useState<{ id: string; title: string | null; updated_at: string }[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Live inspector pane — which documents the agent is viewing / used.
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorLabel, setInspectorLabel] = useState<string | null>(null);
  const [inspectorCards, setInspectorCards] = useState<SourceCard[]>([]);

  // Artifact side-panel (claude.ai style) — generated spreadsheet preview, collapsible.
  const [artifact, setArtifact] = useState<{ a: MailboxArtifact; aoa: string[][] } | null>(null);
  const [artifactCollapsed, setArtifactCollapsed] = useState(false);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [artifactErr, setArtifactErr] = useState<string | null>(null);

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
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) setConn(await getMailboxStatus(session.access_token));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void loadEmails(); void loadStatus(); }, [loadEmails, loadStatus]);

  const selectEmail = useCallback(async (id: string) => {
    // Keep the conversation — opening an email only changes context, never wipes chat.
    // Clear stale attachments immediately + show a loader so the previous email's
    // content never lingers under the new selection.
    setSelectedId(id); setPreviewUrl(null); setAttachments([]); setAttLoading(true);
    const { data } = await supabase
      .from("email_attachments")
      .select("id, filename, mime_type, kind, size_bytes, storage_path")
      .eq("email_id", id).order("kind").order("filename");
    setAttachments((data as Attachment[] | null) ?? []);
    setAttLoading(false);
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

  // Download (or OS-share-sheet) a generated file. Signed URL is re-minted on
  // demand from the stored path (so reloaded chats keep working).
  const openArtifact = useCallback(async (a: MailboxArtifact, share: boolean) => {
    const { data } = await supabase.storage.from("exports").createSignedUrl(a.storagePath, 600);
    if (!data?.signedUrl) return;
    if (!share) { window.open(data.signedUrl, "_blank"); return; }
    try {
      const resp = await fetch(data.signedUrl);
      const blob = await resp.blob();
      const file = new File([blob], a.name, { type: blob.type });
      // deno-lint-ignore no-explicit-any
      const nav = navigator as any;
      if (nav.canShare && nav.canShare({ files: [file] })) { await nav.share({ files: [file], title: a.name }); return; }
    } catch { /* fall through to download */ }
    window.open(data.signedUrl, "_blank");
  }, []);

  // Open the generated spreadsheet in the side panel (download + parse for preview).
  const openArtifactPane = useCallback(async (a: MailboxArtifact) => {
    setArtifactErr(null); setArtifactLoading(true); setArtifactCollapsed(false); setArtifact({ a, aoa: [] });
    try {
      const { data } = await supabase.storage.from("exports").createSignedUrl(a.storagePath, 600);
      if (!data?.signedUrl) throw new Error("could not open file");
      const resp = await fetch(data.signedUrl);
      const buf = new Uint8Array(await resp.arrayBuffer());
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = (XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][])
        .map((r) => r.map((c) => String(c ?? "")));
      setArtifact({ a, aoa });
    } catch (e) {
      setArtifactErr(e instanceof Error ? e.message : String(e));
    } finally { setArtifactLoading(false); }
  }, []);

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

  const loadHistory = useCallback(async () => {
    const { data } = await supabase
      .from("mailbox_chats").select("id, title, updated_at")
      .order("updated_at", { ascending: false }).limit(60);
    setHistory((data as { id: string; title: string | null; updated_at: string }[] | null) ?? []);
  }, []);

  const persistChat = useCallback(async (allMsgs: ChatMsg[]) => {
    const { data: { user } } = await supabase.auth.getUser();
    const uid = user?.id; if (!uid) return;
    const title = (allMsgs.find((m) => m.role === "user")?.content ?? "Mailbox chat").slice(0, 70);
    if (currentChatIdRef.current) {
      await supabase.from("mailbox_chats")
        .update({ title, messages: allMsgs }).eq("id", currentChatIdRef.current);
    } else {
      const { data } = await supabase.from("mailbox_chats")
        .insert({ user_id: uid, title, messages: allMsgs, email_id: selectedId, org_id: orgId ?? null }).select("id").single();
      if (data?.id) { currentChatIdRef.current = data.id; setCurrentChatId(data.id); }
    }
    void loadHistory();
  }, [selectedId, orgId, loadHistory]);

  const newChat = useCallback(() => {
    setMessages([]); setPreview(""); setChatErr(null);
    setTimeline(null); setPendingMessages(null);
    setScopeCustom(false); setScopeFrom(""); setScopeTo(todayISODate());
    setPendingLcAsk(null); setLcCustom(false);
    setInspectorOpen(false); setInspectorCards([]); setInspectorLabel(null);
    currentChatIdRef.current = null; setCurrentChatId(null); setHistoryOpen(false);
  }, []);

  const loadChat = useCallback(async (id: string) => {
    const { data } = await supabase.from("mailbox_chats").select("messages, email_id").eq("id", id).single();
    if (data) {
      setMessages((data.messages as ChatMsg[]) ?? []);
      currentChatIdRef.current = id; setCurrentChatId(id);
      setPreview(""); setPendingMessages(null); setPendingLcAsk(null); setInspectorOpen(false);
    }
    setHistoryOpen(false);
  }, []);

  const runAgent = useCallback(async (
    msgs: ChatMsg[],
    tl: { label: string; dateFrom: string | null; dateTo: string | null },
    pendingLc?: { dateFrom: string | null; dateTo: string | null; label: string; report: "lc" | "shipments" | "ips" | "docs" | "payments" },
  ) => {
    setSending(true); setPreview(""); setChatErr(null);
    setInspectorOpen(true); setInspectorLabel(null); setInspectorCards([]);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token; if (!token) throw new Error("Not signed in");
      const scope = selectedId && !wholeMailbox ? "email" : "global";
      let acc = "";
      let finalSources: SourceCard[] = [];
      const artifacts: MailboxArtifact[] = [];
      await streamMailboxChat(token, { messages: msgs, emailId: selectedId, scope, dateFrom: tl.dateFrom, dateTo: tl.dateTo, timelineLabel: tl.label, pendingLc: pendingLc ?? null }, (ev: MailboxEvent) => {
        if (ev.t === "tok") { acc += ev.v; setPreview(acc); }
        else if (ev.t === "act") {
          if (ev.label) setInspectorLabel(ev.label);
          if (ev.cards?.length) setInspectorCards((prev) => dedupeCards([...prev, ...(ev.cards as SourceCard[])]));
        } else if (ev.t === "src") {
          finalSources = (ev.cards as SourceCard[]) ?? [];
          setInspectorCards(dedupeCards(finalSources));
        } else if (ev.t === "artifact") {
          artifacts.push(ev.file);
        } else if (ev.t === "err") {
          setChatErr(ev.m);
        }
      });
      const finalMsgs = [...msgs, { role: "assistant" as const, content: acc.trim(), sources: finalSources, artifacts: artifacts.length ? artifacts : undefined }];
      setMessages(finalMsgs);
      setPreview(""); setInspectorLabel(null);
      void persistChat(finalMsgs);
      if (artifacts.length) void openArtifactPane(artifacts[artifacts.length - 1]); // claude.ai-style: open the file panel
    } catch (e) {
      setChatErr(e instanceof Error ? e.message : String(e));
    } finally { setSending(false); }
  }, [selectedId, wholeMailbox, persistChat, openArtifactPane]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || sending || pendingMessages || pendingLcAsk) return;
    setInput("");
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    // Pending Elithum report → ask the Date-of-Sale range, bypass the mailbox timeline gate.
    // Check the more specific reports BEFORE LC so a dual-mention prompt resolves deterministically.
    if (PENDING_SHIP_RE.test(text)) { setPendingLcAsk({ msgs: next, report: "shipments" }); setLcCustom(false); return; }
    if (PENDING_IPS_RE.test(text)) { setPendingLcAsk({ msgs: next, report: "ips" }); setLcCustom(false); return; }
    if (PENDING_DOCS_RE.test(text)) { setPendingLcAsk({ msgs: next, report: "docs" }); setLcCustom(false); return; }
    if (PENDING_PAYMENTS_RE.test(text)) { setPendingLcAsk({ msgs: next, report: "payments" }); setLcCustom(false); return; }
    if (PENDING_LC_RE.test(text)) { setPendingLcAsk({ msgs: next, report: "lc" }); setLcCustom(false); return; }
    // Otherwise: first prompt of a thread → ask the mailbox timeline.
    if (!timeline) setPendingMessages(next);
    else void runAgent(next, timeline);
  }, [input, sending, messages, timeline, pendingMessages, pendingLcAsk, runAgent]);

  const chooseScope = useCallback((opt: ScopeOption) => {
    // "Custom" reveals the date pickers and DEFERS the run (keep pendingMessages so the
    // gate bubble stays and Generate has messages to send). Mirrors chooseLcRange's
    // early-return for the custom path.
    if (opt.kind === "custom") { setScopeCustom(true); return; }
    const dateFrom = opt.kind === "hours" && opt.days != null ? daysToDateFrom(opt.days) : null;
    const tl = { label: opt.label, dateFrom, dateTo: null };
    setTimeline(tl);
    const pend = pendingMessages; setPendingMessages(null);
    if (pend) void runAgent(pend, tl);
  }, [pendingMessages, runAgent]);

  const chooseScopeCustom = useCallback(() => {
    if (!scopeFrom || !scopeTo || scopeFrom > scopeTo) return; // guard: both set, from <= to
    const tl = { label: `${scopeFrom} → ${scopeTo}`, dateFrom: scopeFrom, dateTo: scopeTo };
    setTimeline(tl); setScopeCustom(false);
    const pend = pendingMessages; setPendingMessages(null);
    if (pend) void runAgent(pend, tl);
  }, [scopeFrom, scopeTo, pendingMessages, runAgent]);

  const todayISO = () => new Date().toISOString().slice(0, 10);
  const runPendingLc = useCallback((pend: ChatMsg[], report: "lc" | "shipments" | "ips" | "docs" | "payments", dateFrom: string | null, dateTo: string, label: string) => {
    setPendingLcAsk(null); setLcCustom(false);
    // Bypasses the mailbox timeline entirely (it queries Elithum Date-of-Sale).
    void runAgent(pend, { label: "", dateFrom: null, dateTo: null }, { dateFrom, dateTo, label, report });
  }, [runAgent]);

  const chooseLcRange = useCallback((years: number | null) => {
    const ask = pendingLcAsk; if (!ask) return;
    if (years == null) { setLcCustom(true); return; } // reveal custom date inputs (the "type your own" path)
    const d = new Date(); d.setFullYear(d.getFullYear() - years);
    runPendingLc(ask.msgs, ask.report, d.toISOString().slice(0, 10), todayISO(), `Last ${years} year${years > 1 ? "s" : ""}`);
  }, [pendingLcAsk, runPendingLc]);

  const chooseLcCustom = useCallback(() => {
    const ask = pendingLcAsk; if (!ask || !lcFrom || !lcTo) return;
    runPendingLc(ask.msgs, ask.report, lcFrom, lcTo, `${lcFrom} → ${lcTo}`);
  }, [pendingLcAsk, lcFrom, lcTo, runPendingLc]);

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
    <div style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}>
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
              {attLoading && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 2px", opacity: 0.78, fontSize: 13 }}>
                  <span className="mini-spinner" /> Loading attachments…
                </div>
              )}
              {!attLoading && attachments.length === 0 && <p style={{ opacity: 0.5, fontSize: 13 }}>No PDF/Excel attachments.</p>}
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
            {messages.length > 0 && (
              <button onClick={() => shareWhatsAppText(transcriptText(messages))} title="Share transcript on WhatsApp" style={hdrBtn}>Share</button>
            )}
            <button onClick={newChat} title="New chat" style={hdrBtn}>+ New</button>
            <div style={{ position: "relative" }}>
              <button onClick={() => { setHistoryOpen((o) => !o); if (!historyOpen) void loadHistory(); }} title="Chat history" style={hdrBtn}>History</button>
              {historyOpen && (
                <div style={{ position: "absolute", right: 0, top: "130%", width: 270, maxHeight: 360, overflowY: "auto", background: "#16161a", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 12, boxShadow: "0 18px 44px rgba(0,0,0,0.5)", zIndex: 60, padding: 6 }}>
                  {history.length === 0 && <p style={{ opacity: 0.5, fontSize: 12, padding: 10 }}>No saved chats yet.</p>}
                  {history.map((h) => (
                    <button key={h.id} onClick={() => void loadChat(h.id)} style={{
                      display: "block", width: "100%", textAlign: "left", padding: "8px 10px", borderRadius: 8, border: "none", cursor: "pointer",
                      background: h.id === currentChatId ? "rgba(200,169,110,0.14)" : "transparent", color: "inherit",
                    }}>
                      <span style={{ display: "block", fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.title || "Untitled"}</span>
                      <span style={{ display: "block", fontSize: 10.5, opacity: 0.5 }}>{new Date(h.updated_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
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
                <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", marginTop: 16 }}>
                  <button className="scope-option" style={{ width: "auto", display: "inline-block" }}
                    onClick={() => { setInput(PENDING_LC_PROMPT + " for "); inputRef.current?.focus(); }}>
                    📋 Pending LC's list
                  </button>
                  <button className="scope-option" style={{ width: "auto", display: "inline-block" }}
                    onClick={() => { setInput(PENDING_SHIP_PROMPT + " for "); inputRef.current?.focus(); }}>
                    📦 Pending Shipments list
                  </button>
                  <button className="scope-option" style={{ width: "auto", display: "inline-block" }}
                    onClick={() => { setInput(PENDING_IPS_PROMPT + " for "); inputRef.current?.focus(); }}>
                    📑 Pending IP's list
                  </button>
                  <button className="scope-option" style={{ width: "auto", display: "inline-block" }}
                    onClick={() => { setInput(PENDING_DOCS_PROMPT + " for "); inputRef.current?.focus(); }}>
                    🗂 Pending Docs list
                  </button>
                  <button className="scope-option" style={{ width: "auto", display: "inline-block" }}
                    onClick={() => { setInput(PENDING_PAYMENTS_PROMPT + " for "); inputRef.current?.focus(); }}>
                    💵 Pending Payments list
                  </button>
                </div>
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
                {m.role === "assistant" && m.artifacts && m.artifacts.length > 0 && (
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                    {m.artifacts.map((a, k) => (
                      <div key={k} onClick={() => void openArtifactPane(a)} role="button" tabIndex={0}
                        onKeyDown={(e) => { if (e.key === "Enter") void openArtifactPane(a); }}
                        style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 11px", borderRadius: 10, cursor: "pointer", background: "rgba(200,169,110,0.10)", border: "1px solid rgba(200,169,110,0.30)", maxWidth: 380 }}>
                        <span style={{ fontSize: 16 }}>📊</span>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                        <button style={artBtn} onClick={(e) => { e.stopPropagation(); void openArtifact(a, false); }}>Download</button>
                        <button style={artBtn} onClick={(e) => { e.stopPropagation(); void openArtifact(a, true); }}>Share</button>
                      </div>
                    ))}
                  </div>
                )}
                {m.role === "assistant" && m.content && (
                  <button onClick={() => shareWhatsAppText(m.content)} title="Share this answer on WhatsApp"
                    style={{ marginTop: 8, alignSelf: "flex-start", fontSize: 11, background: "none", border: "none", color: "rgba(200,169,110,0.85)", cursor: "pointer", padding: 0 }}>
                    ↗ Share answer
                  </button>
                )}
              </div>
            ))}
            {pendingMessages && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", marginBottom: 16, width: "100%" }}>
                <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 4 }}>Cotton AI</div>
                <div style={aiBubble}>
                  <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 4 }}>How far back should I look?</div>
                  <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 10 }}>Windows are by calendar day.</div>
                  {!scopeCustom ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {SCOPE_OPTIONS.map((o) => (
                        <button key={o.label} className="scope-option" onClick={() => chooseScope(o)}>
                          {o.label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <label style={{ fontSize: 12, opacity: 0.8 }}>From
                        <input type="date" value={scopeFrom} max={scopeTo || undefined} onChange={(e) => setScopeFrom(e.target.value)} style={{ ...inp, marginTop: 4 }} />
                      </label>
                      <label style={{ fontSize: 12, opacity: 0.8 }}>To
                        <input type="date" value={scopeTo} min={scopeFrom || undefined} onChange={(e) => setScopeTo(e.target.value)} style={{ ...inp, marginTop: 4 }} />
                      </label>
                      {scopeFrom && scopeTo && scopeFrom > scopeTo && (
                        <span style={{ fontSize: 11, color: RED }}>End date must be on or after the start date.</span>
                      )}
                      <div style={{ display: "flex", gap: 8 }}>
                        <button className="btn btn-primary" disabled={!scopeFrom || !scopeTo || scopeFrom > scopeTo} onClick={chooseScopeCustom}>Search</button>
                        <button className="scope-option" style={{ width: "auto" }} onClick={() => setScopeCustom(false)}>← Back</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            {pendingLcAsk && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", marginBottom: 16, width: "100%" }}>
                <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 4 }}>Cotton AI</div>
                <div style={aiBubble}>
                  <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 4 }}>{pendingLcAsk.report === "shipments" ? "Pending Shipments list" : pendingLcAsk.report === "ips" ? "Pending IP's list" : pendingLcAsk.report === "docs" ? "Pending Docs list" : pendingLcAsk.report === "payments" ? "Pending Payments list" : "Pending LC's list"} — what date range?</div>
                  <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 10 }}>By Date of Sale in Elithum.</div>
                  {!lcCustom ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {LC_RANGE_OPTIONS.map((o) => (
                        <button key={o.label} className="scope-option" onClick={() => chooseLcRange(o.years)}>
                          {o.label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <label style={{ fontSize: 12, opacity: 0.8 }}>From
                        <input type="date" value={lcFrom} onChange={(e) => setLcFrom(e.target.value)} style={{ ...inp, marginTop: 4 }} />
                      </label>
                      <label style={{ fontSize: 12, opacity: 0.8 }}>To
                        <input type="date" value={lcTo} onChange={(e) => setLcTo(e.target.value)} style={{ ...inp, marginTop: 4 }} />
                      </label>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button className="btn btn-primary" disabled={!lcFrom || !lcTo} onClick={chooseLcCustom}>Generate</button>
                        <button className="scope-option" style={{ width: "auto" }} onClick={() => setLcCustom(false)}>← Back</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
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
          <div style={{ padding: 12, borderTop: "1px solid rgba(255,255,255,0.07)", display: "flex", flexDirection: "column", gap: 8 }}>
            {timeline && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 20, background: "rgba(200,169,110,0.12)", border: "1px solid rgba(200,169,110,0.28)" }}>
                  🕑 {timeline.label}
                </span>
                <button onClick={() => { setTimeline(null); setScopeCustom(false); }} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", textDecoration: "underline", opacity: 0.65, fontSize: 11 }}>change</button>
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder={pendingMessages ? "Pick a timeline above…" : pendingLcAsk ? "Pick a date range above…" : "Message the mailbox…"} rows={2}
                style={{ ...inp, resize: "none", flex: 1 }} disabled={sending || !!pendingMessages || !!pendingLcAsk} />
              <button onClick={() => send()} disabled={sending || !!pendingMessages || !!pendingLcAsk || !input.trim()} className="btn btn-primary"
                style={{ alignSelf: "stretch" }}>Send</button>
            </div>
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

      {/* Artifact side panel (generated spreadsheet) — claude.ai style, collapsible */}
      {artifact && !artifactCollapsed && (
        <div style={artifactDrawer}>
          <div style={artifactHeader}>
            <span style={{ fontSize: 16 }}>📊</span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{artifact.a.name}</span>
            <button style={artBtn} onClick={() => void openArtifact(artifact.a, false)}>Download</button>
            <button style={artBtn} onClick={() => void openArtifact(artifact.a, true)}>Share</button>
            <button style={artIconBtn} title="Collapse" onClick={() => setArtifactCollapsed(true)}>—</button>
            <button style={artIconBtn} title="Close" onClick={() => setArtifact(null)}>✕</button>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
            {artifactLoading && <p style={{ opacity: 0.6, fontSize: 13 }}>Loading sheet…</p>}
            {artifactErr && <p style={{ color: RED, fontSize: 13 }}>{artifactErr}</p>}
            {!artifactLoading && artifact.aoa.length > 0 && (() => {
              // Pending-LC sheets carry a "Delay (No. of Days)" column — tint overdue rows red.
              const header = artifact.aoa[0] ?? [];
              const delayIdx = header.findIndex((h) => /delay/i.test(h));
              return (
                <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
                  <tbody>
                    {artifact.aoa.slice(0, 500).map((row, ri) => {
                      const overdue = ri > 0 && delayIdx >= 0 && Number(row[delayIdx]) > 0;
                      return (
                        <tr key={ri} style={overdue ? { background: "rgba(231,76,60,0.16)" } : undefined}>
                          {row.map((cell, ci) => (
                            ri === 0
                              ? <th key={ci} style={artTh}>{cell}</th>
                              : <td key={ci} style={ci === delayIdx && overdue ? { ...artTd, color: RED, fontWeight: 600 } : artTd}>{cell}</td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              );
            })()}
            {artifact.aoa.length > 500 && <p style={{ opacity: 0.5, fontSize: 11, marginTop: 8 }}>Showing first 500 rows — download for the full sheet.</p>}
          </div>
        </div>
      )}
      {artifact && artifactCollapsed && (
        <button style={artifactTab} onClick={() => setArtifactCollapsed(false)} title="Expand spreadsheet">📊 ◂</button>
      )}

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
  void isPlatformAdmin; // sync + status are available to everyone (shared mailbox)
  const ok = conn?.connected;
  const color = ok ? (conn?.mailboxMismatch ? AMBER : GREEN) : conn ? RED : GREY;
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
      <span title={conn?.error ?? ""} style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
        {ok ? `Connected · ${conn?.mailbox}` : conn ? "Not connected" : "Checking…"}
      </span>
      <span style={{ fontSize: 12, opacity: 0.6 }}>{emailCount} emails</span>
      <div style={{ flex: 1 }} />
      {syncMsg && <span style={{ fontSize: 12, opacity: 0.8 }}>{syncMsg}</span>}
      <button className="btn btn-ghost" onClick={onSync} disabled={syncing}>{syncing ? "Syncing…" : "Sync now"}</button>
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

const hdrBtn: React.CSSProperties = {
  fontSize: 11.5, padding: "4px 10px", borderRadius: 7, cursor: "pointer",
  background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)", color: "inherit",
};
const artBtn: React.CSSProperties = {
  fontSize: 11, padding: "4px 9px", borderRadius: 6, cursor: "pointer",
  background: "rgba(255,255,255,0.08)", border: "1px solid rgba(200,169,110,0.3)", color: "inherit",
};
const artIconBtn: React.CSSProperties = {
  width: 26, height: 26, borderRadius: 6, cursor: "pointer", fontSize: 14, lineHeight: 1,
  background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)", color: "inherit",
};
const artifactDrawer: React.CSSProperties = {
  position: "absolute", top: 0, right: 0, bottom: 0, width: "min(620px, 64%)", zIndex: 40,
  display: "flex", flexDirection: "column", background: "#14161b",
  borderLeft: "1px solid rgba(200,169,110,0.35)", boxShadow: "-18px 0 50px rgba(0,0,0,0.45)",
};
const artifactHeader: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, padding: "11px 14px",
  borderBottom: "1px solid rgba(255,255,255,0.1)",
};
const artifactTab: React.CSSProperties = {
  position: "absolute", top: 80, right: 0, zIndex: 40, cursor: "pointer", fontSize: 12,
  padding: "9px 11px", borderRadius: "10px 0 0 10px", color: "inherit",
  background: "rgba(200,169,110,0.16)", border: "1px solid rgba(200,169,110,0.35)", borderRight: "none",
};
const artTh: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.12)", padding: "6px 9px", textAlign: "left",
  whiteSpace: "nowrap", background: "rgba(200,169,110,0.14)", color: "#dbbd84", fontWeight: 600, position: "sticky", top: 0,
};
const artTd: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.1)", padding: "6px 9px", textAlign: "left", whiteSpace: "nowrap",
};

const inp: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 8,
  background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", color: "inherit", fontSize: 13,
};
const btnSm: React.CSSProperties = {
  fontSize: 11, padding: "4px 9px", borderRadius: 6, cursor: "pointer",
  background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)", color: "inherit",
};
