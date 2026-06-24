// Pending-LC derivation — PURE and dependency-free so it can be unit-tested with
// `deno test`. NEVER read the clock in here: `today` (PKT date, YYYY-MM-DD) is
// always injected, so every function is deterministic. The one impure helper
// (pktTodayISO) is isolated at the bottom and is the only thing that touches Date.now.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY = 86_400_000;
const isBlank = (s?: string) => !s || !String(s).trim();

export type RawContract = {
  Contract?: string; Buyer?: string; Seller?: string; Growth?: string;
  fixedPrice?: string; shipmentMonth?: string; DoS?: string;
  LC_draft?: string; Trans_LC?: string; LC_Num?: string;
};

export type DerivedRow = {
  contract: string; buyer: string; seller: string; growth: string;
  fixedPrice: string; shipmentMonth: string;
  lcDueDate: string;                       // ISO YYYY-MM-DD, or "Needs review"
  lcDueStatus: "ok" | "review" | "none";
  lcDraftReceived: string;                 // "No LC Draft" if blank, else the date
  transmittedLc: string; lcNumber: string;
  delayDays: number;                       // 0 unless overdue + no draft
  pending: boolean;                        // LC_draft blank
};

// Parse "YYYY-MM-DD..." (ISO) to a UTC midnight epoch. Returns null if not ISO.
function epochOfISO(iso?: string): number | null {
  if (!iso) return null;
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}
const toISO = (epoch: number): string => new Date(epoch).toISOString().slice(0, 10);

export function isPrompt(shipmentMonth?: string): boolean {
  return /prompt/i.test(shipmentMonth ?? "");
}

// Find the FIRST (earliest) shipment month + its year inside a messy free-text
// shipment string. Returns {year, monthIdx} (monthIdx 0=Jan) or null if unparseable.
// Robust to: "Jun/Jul-26 SO", "OCT-NOV-DEC-26", "Oct - Dec-27 EQ", "Apr'24",
// "1000T Nov/Dec-24 SO & ...", "1.500 Metric Tons October/November/December 2025".
export function parseFirstShipment(raw?: string): { year: number; monthIdx: number } | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  let monthIdx = -1, monthPos = Infinity;
  for (let i = 0; i < MONTHS.length; i++) {
    const p = s.indexOf(MONTHS[i]);
    if (p >= 0 && p < monthPos) { monthPos = p; monthIdx = i; }
  }
  if (monthIdx < 0) return null;
  // Year tokens: 4-digit in 2020-2035 or 2-digit 20-35 → 20xx. This rejects
  // embedded quantities like "2000T"/"1000T"/"1.500" that aren't years.
  const years: { pos: number; year: number }[] = [];
  const re = /\d{2,4}/g; let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const n = m[0]; let y: number | null = null;
    if (n.length === 4) { const v = +n; if (v >= 2020 && v <= 2035) y = v; }
    else if (n.length === 2) { const v = +n; if (v >= 20 && v <= 35) y = 2000 + v; }
    if (y != null) years.push({ pos: m.index, year: y });
  }
  if (!years.length) return null;
  const after = years.filter((x) => x.pos >= monthPos);
  return { year: (after[0] ?? years[0]).year, monthIdx };
}

export function computeLcDueDate(
  shipmentMonth: string | undefined, dosISO: string | undefined,
): { date: string; status: "ok" | "review" | "none" } {
  // Prompt: LC due 10 days after the date of sale.
  if (isPrompt(shipmentMonth)) {
    const e = epochOfISO(dosISO);
    return e == null ? { date: "", status: "none" } : { date: toISO(e + 10 * DAY), status: "ok" };
  }
  const parsed = parseFirstShipment(shipmentMonth);
  if (!parsed) return { date: "", status: "none" };
  // 15 days before the first day of the first shipment month.
  const due = Date.UTC(parsed.year, parsed.monthIdx, 1) - 15 * DAY;
  // Multi-period (&) or unusually long/quantity-laden strings → flag for a human
  // glance even though we computed a value (never assert silently on junk).
  const messy = /&/.test(shipmentMonth ?? "") || (shipmentMonth ?? "").length > 38;
  return { date: toISO(due), status: messy ? "review" : "ok" };
}

// Whole days overdue: only when the LC draft is NOT received and the due date is past.
export function computeDelay(lcDueISO: string, lcDraftBlank: boolean, todayISO: string): number {
  if (!lcDueISO || !lcDraftBlank) return 0;
  const due = epochOfISO(lcDueISO), today = epochOfISO(todayISO);
  if (due == null || today == null || due >= today) return 0;
  return Math.round((today - due) / DAY);
}

export function deriveRow(raw: RawContract, todayISO: string): DerivedRow {
  const draftBlank = isBlank(raw.LC_draft);
  const { date, status } = computeLcDueDate(raw.shipmentMonth, raw.DoS);
  return {
    contract: (raw.Contract ?? "").trim(),
    buyer: (raw.Buyer ?? "").trim(),
    seller: (raw.Seller ?? "").trim(),
    growth: (raw.Growth ?? "").trim(),
    fixedPrice: (raw.fixedPrice ?? "").trim(),
    shipmentMonth: (raw.shipmentMonth ?? "").trim(),
    lcDueDate: status === "none" ? "Needs review" : date,
    lcDueStatus: status,
    // Pending = blank draft (owner's rule). But we still show the REAL Transmitted
    // LC / LC Number when Elithum has them — never assert a false "none", which would
    // mislead a trader into chasing a counterparty whose LC is already issued.
    lcDraftReceived: draftBlank ? "No LC Draft" : (raw.LC_draft ?? "").trim(),
    transmittedLc: (raw.Trans_LC ?? "").trim(),
    lcNumber: (raw.LC_Num ?? "").trim(),
    delayDays: computeDelay(status === "none" ? "" : date, draftBlank, todayISO),
    pending: draftBlank,
  };
}

export const PENDING_LC_COLUMNS = [
  "Contract#", "Buyer", "Seller", "Growth", "Fixed Price", "Shipment Month",
  "LC Due Date", "LC Draft Received", "Transmitted LC Received", "LC Number", "Delay (No. of Days)",
];

export function rowToCells(r: DerivedRow): string[] {
  return [
    r.contract, r.buyer, r.seller, r.growth, r.fixedPrice, r.shipmentMonth,
    r.lcDueDate, r.lcDraftReceived, r.transmittedLc, r.lcNumber,
    r.delayDays > 0 ? String(r.delayDays) : "",
  ];
}

// IMPURE (reads the clock). Kept out of every function above. Asia/Karachi has no
// DST, but we still use Intl rather than a fixed offset so a future tz change is correct.
export function pktTodayISO(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}
