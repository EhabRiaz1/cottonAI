import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";
import { getMailboxStatus, triggerExtraction, triggerMailboxSync, type MailboxStatus } from "./lib/api";

// Cotton offers table (D11) over the global pool. Reads are RLS-scoped to any
// authenticated user. Freshness signal per D5: relative age + green/amber/red dot,
// recent-first default with an "include older" toggle, very old offers faded.

export type CottonOffer = {
  id: string;
  broker: string | null;
  origin_country: string | null;
  region: string | null;
  certifications: string[] | null;
  grade_raw: string | null;
  staple_fraction: string | null;
  staple_32nds: number | null;
  mic: number | null;
  gpt: number | null;
  length: number | null;
  uniformity: number | null;
  quantity_bales: number | null;
  price_type: "on_call" | "outright" | "none";
  price_basis_points: number | null;
  price_outright_cents: number | null;
  futures_month: string | null;
  crop_year: string | null;
  shipment_period: string | null;
  recap_code: string | null;
  offer_date: string | null;
  confidence: number | null;
  needs_review: boolean;
};

type SyncRun = {
  status: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  emails_new: number;
  offers_extracted: number;
  error_message: string | null;
};

type SortKey = "offer_date" | "mic" | "staple_32nds" | "price" | "origin_country" | "broker";

const GREEN = "#2ecc71";
const AMBER = "#f5a623";
const RED = "#e74c3c";
const GREY = "#8a8f98";

function ageDays(date: string | null): number | null {
  if (!date) return null;
  return Math.floor((Date.now() - Date.parse(date)) / 86_400_000);
}
function freshnessColor(age: number | null): string {
  if (age == null) return GREY;
  if (age <= 14) return GREEN;
  if (age <= 30) return AMBER;
  return RED;
}
function ageLabel(age: number | null): string {
  if (age == null) return "no date";
  if (age <= 0) return "today";
  if (age === 1) return "1 day old";
  return `${age} days old`;
}
function priceText(o: CottonOffer): string {
  if (o.price_type === "on_call" && o.price_basis_points != null) {
    return `+${o.price_basis_points}${o.futures_month ? ` on ${o.futures_month}` : ""}`;
  }
  if (o.price_type === "outright" && o.price_outright_cents != null) {
    return `${o.price_outright_cents}¢/lb`;
  }
  return "—";
}
function priceSortVal(o: CottonOffer): number {
  if (o.price_type === "outright" && o.price_outright_cents != null) return o.price_outright_cents;
  if (o.price_type === "on_call" && o.price_basis_points != null) return o.price_basis_points / 1000;
  return Number.POSITIVE_INFINITY;
}

export function OffersView({ isPlatformAdmin }: { isPlatformAdmin: boolean }) {
  const [offers, setOffers] = useState<CottonOffer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [origin, setOrigin] = useState("");
  const [priceType, setPriceType] = useState<"" | "on_call" | "outright">("");
  const [includeOlder, setIncludeOlder] = useState(false);
  const [onlyReview, setOnlyReview] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("offer_date");
  const [sortAsc, setSortAsc] = useState(false);

  const [lastRun, setLastRun] = useState<SyncRun | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [reviewCount, setReviewCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [conn, setConn] = useState<MailboxStatus | null>(null);
  const [checkingConn, setCheckingConn] = useState(false);

  const checkConnection = useCallback(async () => {
    if (!isPlatformAdmin) return;
    setCheckingConn(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) return;
      setConn(await getMailboxStatus(token));
    } catch (e) {
      setConn({ connected: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setCheckingConn(false);
    }
  }, [isPlatformAdmin]);

  const loadStatus = useCallback(async () => {
    const { data: runs } = await supabase
      .from("sync_runs")
      .select("status, trigger, started_at, finished_at, emails_new, offers_extracted, error_message")
      .order("started_at", { ascending: false })
      .limit(1);
    setLastRun((runs as SyncRun[] | null)?.[0] ?? null);
    const { data: state } = await supabase
      .from("mailbox_state").select("last_synced_at").limit(1);
    setLastSyncedAt((state as { last_synced_at: string | null }[] | null)?.[0]?.last_synced_at ?? null);
    const { count } = await supabase
      .from("cotton_offers").select("id", { count: "exact", head: true }).eq("needs_review", true);
    setReviewCount(count ?? 0);
  }, []);

  const loadOffers = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: e } = await supabase
      .from("cotton_offers")
      .select(
        "id,broker,origin_country,region,certifications,grade_raw,staple_fraction,staple_32nds,mic,gpt,length,uniformity,quantity_bales,price_type,price_basis_points,price_outright_cents,futures_month,crop_year,shipment_period,recap_code,offer_date,confidence,needs_review",
      )
      .order("offer_date", { ascending: false, nullsFirst: false })
      .limit(1000);
    if (e) setError(e.message);
    setOffers((data as CottonOffer[] | null) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadOffers();
    void loadStatus();
    void checkConnection();
  }, [loadOffers, loadStatus, checkConnection]);

  const runSync = useCallback(async () => {
    setSyncing(true);
    setSyncMsg("Connecting to mailbox…");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error("Not signed in");
      const s = await triggerMailboxSync(token, { trigger: "manual" });
      setSyncMsg(`Fetched ${s.emailsNew} new email(s), ${s.attachmentsNew} attachment(s). Extracting…`);
      const x = await triggerExtraction(token);
      setSyncMsg(`Done. ${x.offersWritten} offer(s), ${x.recapsWritten} recap(s) updated.`);
      await loadOffers();
      await loadStatus();
      await checkConnection();
    } catch (err) {
      setSyncMsg(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncing(false);
    }
  }, [loadOffers, loadStatus]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = offers.filter((o) => {
      if (onlyReview && !o.needs_review) return false;
      if (priceType && o.price_type !== priceType) return false;
      if (origin && !(o.origin_country ?? "").toLowerCase().includes(origin.toLowerCase())) return false;
      if (!includeOlder) {
        const a = ageDays(o.offer_date);
        if (a != null && a > 90) return false;
      }
      if (q) {
        const hay = [
          o.broker, o.origin_country, o.region, o.grade_raw, o.crop_year,
          o.shipment_period, (o.certifications ?? []).join(" "),
        ].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const dir = sortAsc ? 1 : -1;
    list = [...list].sort((a, b) => {
      let av: number | string = "";
      let bv: number | string = "";
      if (sortKey === "price") { av = priceSortVal(a); bv = priceSortVal(b); }
      else if (sortKey === "offer_date") { av = a.offer_date ?? ""; bv = b.offer_date ?? ""; }
      else if (sortKey === "origin_country") { av = a.origin_country ?? ""; bv = b.origin_country ?? ""; }
      else if (sortKey === "broker") { av = a.broker ?? ""; bv = b.broker ?? ""; }
      else { av = a[sortKey] ?? Number.NEGATIVE_INFINITY; bv = b[sortKey] ?? Number.NEGATIVE_INFINITY; }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return list;
  }, [offers, search, origin, priceType, includeOlder, onlyReview, sortKey, sortAsc]);

  const setSort = (k: SortKey) => {
    if (k === sortKey) setSortAsc((v) => !v);
    else { setSortKey(k); setSortAsc(k === "origin_country" || k === "broker"); }
  };

  const health = lastRun?.status === "error" ? RED : lastRun?.status === "running" ? AMBER : GREEN;
  const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", fontSize: 12, opacity: 0.7, cursor: "pointer", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "8px 10px", fontSize: 13, borderTop: "1px solid rgba(255,255,255,0.06)", whiteSpace: "nowrap" };

  return (
    <div style={{ padding: 20, maxWidth: 1400, margin: "0 auto" }}>
      {/* Mailbox status bar (replaces the hardcoded "Live Market Data" badge) */}
      <div style={{
        display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
        padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.08)", marginBottom: 16,
      }}>
        {(() => {
          // Admin: explicit verified connection badge. Others: sync health.
          if (isPlatformAdmin && (conn || checkingConn)) {
            const ok = conn?.connected;
            const mismatch = conn?.mailboxMismatch;
            const color = checkingConn ? GREY : ok ? (mismatch ? AMBER : GREEN) : RED;
            const label = checkingConn
              ? "Checking connection…"
              : ok
                ? (mismatch
                    ? `Connected to ${conn?.mailbox} (expected ${conn?.expectedMailbox})`
                    : `Connected · ${conn?.mailbox}`)
                : "Not connected";
            return (
              <span title={conn?.error ?? ""} style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: color }} />
                {label}
                {conn && !ok && (
                  <button type="button" className="btn btn-ghost" style={{ fontSize: 11, padding: "2px 8px" }}
                    onClick={() => void checkConnection()}>Recheck</button>
                )}
              </span>
            );
          }
          return (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: health }} />
              Mailbox sync
            </span>
          );
        })()}
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          {lastSyncedAt ? `Last synced ${ageLabel(ageDays(lastSyncedAt))}` : "Not synced yet"}
          {lastRun?.status === "error" && lastRun.error_message ? ` · error: ${lastRun.error_message.slice(0, 80)}` : ""}
        </span>
        <span style={{ fontSize: 12, opacity: 0.7 }}>{offers.length} offers</span>
        {reviewCount > 0 && (
          <span style={{ fontSize: 12, color: AMBER }}>{reviewCount} need review</span>
        )}
        <div style={{ flex: 1 }} />
        {syncMsg && <span style={{ fontSize: 12, opacity: 0.8 }}>{syncMsg}</span>}
        {isPlatformAdmin && (
          <button type="button" className="btn btn-ghost" onClick={() => void runSync()} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        )}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
        <input placeholder="Search origin, broker, grade, cert…" value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: "1 1 240px", padding: "8px 10px", borderRadius: 8, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", color: "inherit" }} />
        <input placeholder="Origin" value={origin} onChange={(e) => setOrigin(e.target.value)}
          style={{ width: 130, padding: "8px 10px", borderRadius: 8, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", color: "inherit" }} />
        <select value={priceType} onChange={(e) => setPriceType(e.target.value as "" | "on_call" | "outright")}
          style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", color: "inherit" }}>
          <option value="">All prices</option>
          <option value="on_call">On-call</option>
          <option value="outright">Outright</option>
        </select>
        <label style={{ fontSize: 12, display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={includeOlder} onChange={(e) => setIncludeOlder(e.target.checked)} />
          Include older (90d+)
        </label>
        <label style={{ fontSize: 12, display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} />
          Needs review
        </label>
      </div>

      {loading && <p style={{ opacity: 0.6 }}>Loading offers…</p>}
      {error && <p style={{ color: RED }}>{error}</p>}
      {!loading && !error && filtered.length === 0 && (
        <p style={{ opacity: 0.6 }}>
          No offers yet. {isPlatformAdmin ? "Connect the mailbox and run Sync." : "Ask an admin to sync the mailbox."}
        </p>
      )}

      {filtered.length > 0 && (
        <div style={{ overflowX: "auto", borderRadius: 10, border: "1px solid rgba(255,255,255,0.08)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "rgba(255,255,255,0.03)" }}>
                <th style={th} onClick={() => setSort("offer_date")}>Date / Age</th>
                <th style={th} onClick={() => setSort("origin_country")}>Origin</th>
                <th style={th} onClick={() => setSort("broker")}>Broker</th>
                <th style={th}>Grade</th>
                <th style={th} onClick={() => setSort("mic")}>Mic</th>
                <th style={th} onClick={() => setSort("staple_32nds")}>Staple</th>
                <th style={th}>GPT</th>
                <th style={th}>Qty</th>
                <th style={th} onClick={() => setSort("price")}>Price</th>
                <th style={th}>Certs</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => {
                const age = ageDays(o.offer_date);
                const faded = age != null && age > 90;
                return (
                  <tr key={o.id} style={{ opacity: faded ? 0.5 : 1 }}>
                    <td style={td}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: freshnessColor(age) }} />
                        <span>
                          {o.offer_date ?? "—"}
                          <span style={{ display: "block", fontSize: 11, opacity: 0.55 }}>{ageLabel(age)}</span>
                        </span>
                      </span>
                    </td>
                    <td style={td}>
                      {o.origin_country ?? "—"}
                      {o.region ? <span style={{ opacity: 0.55 }}> · {o.region}</span> : null}
                    </td>
                    <td style={td}>{o.broker ?? "—"}</td>
                    <td style={td}>
                      {o.grade_raw ?? "—"}
                      {o.needs_review && (
                        <span title="Low confidence — verify" style={{ marginLeft: 6, fontSize: 10, color: AMBER, border: `1px solid ${AMBER}`, borderRadius: 4, padding: "0 4px" }}>review</span>
                      )}
                    </td>
                    <td style={td}>{o.mic ?? "—"}</td>
                    <td style={td}>{o.staple_fraction ?? (o.staple_32nds ? `${o.staple_32nds}/32` : "—")}</td>
                    <td style={td}>{o.gpt ?? "—"}</td>
                    <td style={td}>{o.quantity_bales ?? "—"}</td>
                    <td style={td}>
                      <span style={{
                        display: "inline-block", padding: "1px 7px", borderRadius: 5, fontSize: 12,
                        background: o.price_type === "on_call" ? "rgba(91,155,255,0.15)" : o.price_type === "outright" ? "rgba(46,204,113,0.15)" : "transparent",
                        color: o.price_type === "on_call" ? "#9cc0ff" : o.price_type === "outright" ? "#7fe0a8" : "inherit",
                      }}>
                        {priceText(o)}
                      </span>
                      {o.price_type !== "none" && (
                        <span style={{ display: "block", fontSize: 10, opacity: 0.5 }}>
                          {o.price_type === "on_call" ? "on-call" : "outright"}
                        </span>
                      )}
                    </td>
                    <td style={td}>{(o.certifications ?? []).join(", ") || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
