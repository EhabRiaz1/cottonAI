// Pending-LC derivation — PURE and dependency-free so it can be unit-tested with
// `deno test`. NEVER read the clock in here: `today` (PKT date, YYYY-MM-DD) is
// always injected, so every function is deterministic. The one impure helper
// (pktTodayISO) is isolated at the bottom and is the only thing that touches Date.now.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY = 86_400_000;
const isBlank = (s?: string) => !s || !String(s).trim();

export type RawContract = {
  Contract?: string; Buyer?: string; Seller?: string; Growth?: string;
  fixedPrice?: string; price?: string; shipmentMonth?: string; DoS?: string;
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

// --- Pending Shipments ----------------------------------------------------
// The shipment columns live two levels deep in Elithum: contract.ips[].shipments[].
// This stays PURE: the edge function flattens the Firestore doc into (contract,
// shipment) pairs and hands us plain objects. Cols 1-10 reuse deriveRow verbatim so
// LC Due Date / Delay / Transmitted LC / LC Number are byte-identical to the LC sheet.

export type RawShipment = {
  inv?: string; etd?: string; eta?: string; bl_number?: string;
  shipping_line?: string; bales?: string; qs?: string; shipment_status?: string;
  oDocs?: string; cDocs?: string; discrepancy_sent?: string; discrepancy_received?: string;
  payment_date?: string;   // extracted from shipments[].payments[] (date only, never amounts)
};

export type ShipmentRow = DerivedRow & {
  invoice: string; etd: string; eta: string; blNumber: string;
  shippingLine: string; bales: string; shippedQtyMt: string;
  shipmentStatus: string;            // for sort/colour only — NOT an output column
};

// Owner-specified 17 columns, exact order. NOTE: drops the LC sheet's
// "LC Draft Received" column; everything else 1-10 mirrors the LC list.
export const PENDING_SHIPMENTS_COLUMNS = [
  "Contract#", "Buyer", "Seller", "Growth", "Fixed Price", "Shipment Month",
  "LC Due Date", "Transmitted LC Received", "LC Number", "Delay (No. of Days)",
  "Invoice #", "ETD", "ETA", "BL Number", "Shipping Line", "No. of Bales", "Shipped QTY (MT)",
];

// One (contract, shipment) pair → one row. `sh` undefined → blank shipment cells
// (kept for callers that want a row even when a contract has no shipment).
export function deriveShipmentRow(
  contract: RawContract, sh: RawShipment | undefined, todayISO: string,
): ShipmentRow {
  const base = deriveRow(contract, todayISO);
  return {
    ...base,
    invoice: (sh?.inv ?? "").trim(),
    etd: (sh?.etd ?? "").trim(),
    eta: (sh?.eta ?? "").trim(),
    blNumber: (sh?.bl_number ?? "").trim(),
    shippingLine: (sh?.shipping_line ?? "").trim(),   // data has stray tabs/spaces
    bales: (sh?.bales ?? "").trim(),
    shippedQtyMt: (sh?.qs ?? "").trim(),
    shipmentStatus: (sh?.shipment_status ?? "").trim(),
  };
}

export function shipmentRowToCells(r: ShipmentRow): string[] {
  return [
    r.contract, r.buyer, r.seller, r.growth, r.fixedPrice, r.shipmentMonth,
    r.lcDueDate, r.transmittedLc, r.lcNumber, r.delayDays > 0 ? String(r.delayDays) : "",
    r.invoice, r.etd, r.eta, r.blNumber, r.shippingLine, r.bales, r.shippedQtyMt,
  ];
}

// --- Pending IPs ----------------------------------------------------------
// IP-level report: one row per contract.ips[] entry (in practice 0 or 1 IP per
// contract). No date derivation — just contract fields + IP fields, trimmed.
// `.trim()` also strips the stray NBSP (U+00A0) seen on some IP_number values.

export type RawIP = {
  IP_number?: string; IP_start?: string; IP_end?: string; IP_quantity?: string; IP_sent?: string;
};

export type IPRow = {
  contract: string; buyer: string; seller: string; growth: string; price: string;
  shipmentMonth: string; transmittedLc: string; lcNumber: string;
  ipNumber: string; ipStart: string; ipEnd: string; ipQuantity: string; ipSent: string;
};

export const PENDING_IPS_COLUMNS = [
  "Contract#", "Buyer", "Seller", "Growth", "Price", "Shipment Month",
  "Transmitted LC Received", "LC Number",
  "IP Number", "IP Start", "IP End", "IP Quantity", "IP Sent to Supplier",
];

export function deriveIPRow(c: RawContract, ip: RawIP | undefined): IPRow {
  return {
    contract: (c.Contract ?? "").trim(),
    buyer: (c.Buyer ?? "").trim(),
    seller: (c.Seller ?? "").trim(),
    growth: (c.Growth ?? "").trim(),
    // "Price": fixed price if present, else the on-call price (e.g. "700 On Dec-26"),
    // so on-call contracts aren't blank. (Switch to fixedPrice-only if owner prefers.)
    price: ((c.fixedPrice ?? "").trim() || (c.price ?? "").trim()),
    shipmentMonth: (c.shipmentMonth ?? "").trim(),
    transmittedLc: (c.Trans_LC ?? "").trim(),
    lcNumber: (c.LC_Num ?? "").trim(),
    ipNumber: (ip?.IP_number ?? "").trim(),
    ipStart: (ip?.IP_start ?? "").trim(),
    ipEnd: (ip?.IP_end ?? "").trim(),
    ipQuantity: (ip?.IP_quantity ?? "").trim(),
    ipSent: (ip?.IP_sent ?? "").trim(),
  };
}

export function ipRowToCells(r: IPRow): string[] {
  return [
    r.contract, r.buyer, r.seller, r.growth, r.price, r.shipmentMonth,
    r.transmittedLc, r.lcNumber,
    r.ipNumber, r.ipStart, r.ipEnd, r.ipQuantity, r.ipSent,
  ];
}

// --- Pending Docs ---------------------------------------------------------
// Shipment-level report (one row per shipment), like Pending Shipments but with
// the document columns instead of LC Due Date / Delay. No date derivation.

export type DocsRow = {
  contract: string; buyer: string; seller: string; growth: string; fixedPrice: string;
  shipmentMonth: string; transmittedLc: string; lcNumber: string;
  invoice: string; etd: string; eta: string; blNumber: string; shippingLine: string;
  bales: string; shippedQtyMt: string;
  originalDocs: string; copyDocs: string; discSent: string; discReceived: string;
};

export const PENDING_DOCS_COLUMNS = [
  "Contract#", "Buyer", "Seller", "Growth", "Fixed Price", "Shipment Month",
  "Transmitted LC Received", "LC Number",
  "Invoice #", "ETD", "ETA", "BL Number", "Shipping Line", "No. of Bales", "Shipped QTY (MT)",
  "Original Docs", "Copy Docs", "Disc Sent", "Disc Received",
];

export function deriveDocsRow(c: RawContract, sh: RawShipment | undefined): DocsRow {
  return {
    contract: (c.Contract ?? "").trim(),
    buyer: (c.Buyer ?? "").trim(),
    seller: (c.Seller ?? "").trim(),
    growth: (c.Growth ?? "").trim(),
    fixedPrice: (c.fixedPrice ?? "").trim(),
    shipmentMonth: (c.shipmentMonth ?? "").trim(),
    transmittedLc: (c.Trans_LC ?? "").trim(),
    lcNumber: (c.LC_Num ?? "").trim(),
    invoice: (sh?.inv ?? "").trim(),
    etd: (sh?.etd ?? "").trim(),
    eta: (sh?.eta ?? "").trim(),
    blNumber: (sh?.bl_number ?? "").trim(),
    shippingLine: (sh?.shipping_line ?? "").trim(),
    bales: (sh?.bales ?? "").trim(),
    shippedQtyMt: (sh?.qs ?? "").trim(),
    originalDocs: (sh?.oDocs ?? "").trim(),
    copyDocs: (sh?.cDocs ?? "").trim(),
    discSent: (sh?.discrepancy_sent ?? "").trim(),
    discReceived: (sh?.discrepancy_received ?? "").trim(),
  };
}

export function docsRowToCells(r: DocsRow): string[] {
  return [
    r.contract, r.buyer, r.seller, r.growth, r.fixedPrice, r.shipmentMonth,
    r.transmittedLc, r.lcNumber,
    r.invoice, r.etd, r.eta, r.blNumber, r.shippingLine, r.bales, r.shippedQtyMt,
    r.originalDocs, r.copyDocs, r.discSent, r.discReceived,
  ];
}

// --- Pending Payments -----------------------------------------------------
// Identical to Pending Docs plus a "Payment Date" column (from the shipment's
// single payment; every shipment has 0 or 1 payment in the data).

export type PaymentsRow = DocsRow & { paymentDate: string };

export const PENDING_PAYMENTS_COLUMNS = [...PENDING_DOCS_COLUMNS, "Payment Date"];

export function derivePaymentsRow(c: RawContract, sh: RawShipment | undefined): PaymentsRow {
  return { ...deriveDocsRow(c, sh), paymentDate: (sh?.payment_date ?? "").trim() };
}

export function paymentsRowToCells(r: PaymentsRow): string[] {
  return [...docsRowToCells(r), r.paymentDate];
}

// IMPURE (reads the clock). Kept out of every function above. Asia/Karachi has no
// DST, but we still use Intl rather than a fixed offset so a future tz change is correct.
export function pktTodayISO(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}
