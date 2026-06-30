// Golden tests for the Pending-LC derivation. Run: `deno test supabase/functions/_shared/lc_derive.test.ts`
// Fixtures are REAL shipmentMonth strings captured from the Elithum `entries` collection.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeDelay, computeLcDueDate, deriveDocsRow, deriveIPRow, derivePaymentsRow, deriveRow,
  deriveShipmentRow, docsRowToCells, ipRowToCells, parseFirstShipment, paymentsRowToCells,
  PENDING_DOCS_COLUMNS, PENDING_IPS_COLUMNS, PENDING_PAYMENTS_COLUMNS, PENDING_SHIPMENTS_COLUMNS,
  pktTodayISO, rowToCells, shipmentRowToCells,
} from "./lc_derive.ts";

Deno.test("parseFirstShipment — real formats → first month + year", () => {
  const cases: [string, { year: number; monthIdx: number } | null][] = [
    ["Jun/Jul-26 SO", { year: 2026, monthIdx: 5 }],
    ["Jul/Aug-26 EQ", { year: 2026, monthIdx: 6 }],
    ["Dec-26", { year: 2026, monthIdx: 11 }],
    ["OCT-NOV-DEC-26", { year: 2026, monthIdx: 9 }],
    ["Oct - Dec-27 EQ", { year: 2027, monthIdx: 9 }],
    ["JUN/JUL.26 SO", { year: 2026, monthIdx: 5 }],
    ["Jul-25", { year: 2025, monthIdx: 6 }],
    ["Apr'24", { year: 2024, monthIdx: 3 }],
    ["AUG 25", { year: 2025, monthIdx: 7 }],
    ["SEP/OCT/NOV-26-EQ", { year: 2026, monthIdx: 8 }],
    ["1000T Nov/Dec-24 SO & 1000T Dec-24/Jan-25 SO", { year: 2024, monthIdx: 10 }],
    ["1.500 Metric Tons October/November/December 2025", { year: 2025, monthIdx: 9 }],
    ["700 MT Apr-25 & 600 MTS May-25", { year: 2025, monthIdx: 3 }],
    ["2000T Dec-25", { year: 2025, monthIdx: 11 }], // "2000" must NOT be read as a year
    ["", null],
    ["Prompt Shipment", null], // no month token
    ["just text", null],
  ];
  for (const [input, want] of cases) assertEquals(parseFirstShipment(input), want, input);
});

Deno.test("computeLcDueDate — 15 days before first shipment month", () => {
  assertEquals(computeLcDueDate("Jun/Jul-26 SO", undefined).date, "2026-05-17"); // user's worked example
  assertEquals(computeLcDueDate("Dec-26", undefined).date, "2026-11-16");
  assertEquals(computeLcDueDate("OCT-NOV-DEC-26", undefined).date, "2026-09-16");
  // cross-year: 15 days before Jan-27 lands in Dec-26
  assertEquals(computeLcDueDate("Jan-27", undefined).date, "2026-12-17");
});

Deno.test("computeLcDueDate — Prompt uses date of sale + 10 days", () => {
  assertEquals(computeLcDueDate("Prompt Shipment", "2025-12-04"), { date: "2025-12-14", status: "ok" });
  // Prompt with no DoS → cannot compute
  assertEquals(computeLcDueDate("Prompt", undefined), { date: "", status: "none" });
});

Deno.test("computeLcDueDate — unparseable/multi-period flagging", () => {
  assertEquals(computeLcDueDate("", undefined).status, "none");
  assertEquals(computeLcDueDate("just text", undefined).status, "none");
  // multi-period still computes the first month but is flagged for review
  assertEquals(computeLcDueDate("1000T Nov/Dec-24 SO & 1000T Dec-24/Jan-25 SO", undefined).status, "review");
});

Deno.test("computeDelay — only overdue when draft blank and past due", () => {
  const today = "2026-06-24";
  assertEquals(computeDelay("2026-06-09", true, today), 15);   // 15 days overdue, no draft
  assertEquals(computeDelay("2026-06-09", false, today), 0);   // draft received → no delay
  assertEquals(computeDelay("2026-07-01", true, today), 0);    // due in future → no delay
  assertEquals(computeDelay("", true, today), 0);              // no due date → no delay
});

Deno.test("deriveRow — pending row, overdue, no LC at all", () => {
  const today = "2026-06-24";
  const r = deriveRow(
    { Contract: "S51701.C01", Buyer: "Fazal Cloth", Seller: "Cargill", Growth: "Brazil BCI",
      fixedPrice: "87.88", shipmentMonth: "Jun/Jul-26 SO", DoS: "2026-01-10",
      LC_draft: "", Trans_LC: "", LC_Num: "" },
    today,
  );
  assertEquals(r.pending, true);
  assertEquals(r.lcDueDate, "2026-05-17");
  assertEquals(r.delayDays, 38);                 // 2026-05-17 → 2026-06-24
  assertEquals(r.lcDraftReceived, "No LC Draft");
  assertEquals(rowToCells(r).length, 11);
});

Deno.test("deriveRow — blank draft but real Transmitted/LC# are shown (never falsely blanked)", () => {
  // Real Elithum shape: LC_draft blank (→ pending) yet Trans_LC / LC_Num exist.
  const r = deriveRow(
    { Contract: "24/S/07839/A", Buyer: "Sapphire Fibres Ltd", Seller: "OLAM", Growth: "USA M/E",
      fixedPrice: "90", shipmentMonth: "Prompt Shipment", DoS: "2024-08-30",
      LC_draft: "", Trans_LC: "2024-09-13", LC_Num: "24INSU002808975" },
    "2026-06-24",
  );
  assertEquals(r.pending, true);
  assertEquals(r.lcDraftReceived, "No LC Draft");
  assertEquals(r.transmittedLc, "2024-09-13");      // shown, NOT blanked
  assertEquals(r.lcNumber, "24INSU002808975");      // shown, NOT blanked
});

Deno.test("deriveRow — draft received → not pending, delay 0", () => {
  const r = deriveRow(
    { Contract: "2608", Buyer: "Sapphire Fibres Ltd", Seller: "UNITED", Growth: "Egypyian Giza",
      fixedPrice: "111", shipmentMonth: "Prompt Shipment", DoS: "2025-12-04",
      LC_draft: "2025-12-10", Trans_LC: "2025-12-12", LC_Num: "1398LCS252744" },
    "2026-06-24",
  );
  assertEquals(r.pending, false);
  assertEquals(r.lcDueDate, "2025-12-14");
  assertEquals(r.delayDays, 0);
  assertEquals(r.lcNumber, "1398LCS252744");
});

// --- Pending Shipments ----------------------------------------------------
// Real shapes captured live from Elithum ips[].shipments[] on 2026-06-29.

Deno.test("deriveShipmentRow — full shipment (real Contract 26/S/00962/A)", () => {
  const today = "2026-06-29";
  const contract = {
    Contract: "26/S/00962/A", Buyer: "Sapphire Fibres Ltd", Seller: "OLAM", Growth: "USA M/E",
    fixedPrice: "90", shipmentMonth: "Apr-26", DoS: "2026-01-10",
    LC_draft: "2026-01-15", Trans_LC: "2026-01-20", LC_Num: "LC123",
  };
  const sh = {
    inv: "05373/04/2026", etd: "2026-04-02", eta: "2026-06-06", bl_number: "265761856",
    shipping_line: "MAERSK", bales: "1320", qs: "289.3800", shipment_status: "confirmed",
  };
  const r = deriveShipmentRow(contract, sh, today);
  assertEquals(r.invoice, "05373/04/2026");
  assertEquals(r.etd, "2026-04-02");
  assertEquals(r.blNumber, "265761856");
  assertEquals(r.bales, "1320");
  assertEquals(r.shippedQtyMt, "289.3800");
  assertEquals(r.shipmentStatus, "confirmed");
  const cells = shipmentRowToCells(r);
  assertEquals(cells.length, 17);
  assertEquals(cells.length, PENDING_SHIPMENTS_COLUMNS.length);
  assertEquals(cells[10], "05373/04/2026"); // Invoice # is col 11 (index 10)
  assertEquals(cells[16], "289.3800");      // Shipped QTY (MT) is col 17
});

Deno.test("deriveShipmentRow — stray whitespace in shipping_line is trimmed", () => {
  const r = deriveShipmentRow({ Contract: "X" }, { shipping_line: "\t COSCO " }, "2026-06-29");
  assertEquals(r.shippingLine, "COSCO");
});

Deno.test("deriveShipmentRow — undefined shipment → blank shipment cells, cols 1-10 intact", () => {
  const today = "2026-06-29";
  const contract = {
    Contract: "S51701.C01", Buyer: "Fazal Cloth", Seller: "Cargill", Growth: "Brazil BCI",
    fixedPrice: "87.88", shipmentMonth: "Jun/Jul-26 SO", DoS: "2026-01-10",
    LC_draft: "", Trans_LC: "", LC_Num: "",
  };
  const r = deriveShipmentRow(contract, undefined, today);
  const cells = shipmentRowToCells(r);
  // cols 11-17 blank
  assertEquals(cells.slice(10), ["", "", "", "", "", "", ""]);
  // cols 1-10 byte-identical to the LC derivation for the same contract
  const lc = rowToCells(deriveRow(contract, today)); // [..., LC Draft Received(8), Trans(9), LC#(10), Delay(11)]
  assertEquals(cells.slice(0, 7), lc.slice(0, 7));    // Contract..LC Due Date
  assertEquals(cells[7], lc[8]);                      // Transmitted LC
  assertEquals(cells[8], lc[9]);                      // LC Number
  assertEquals(cells[9], lc[10]);                     // Delay
  assertEquals(cells[6], "2026-05-17");               // LC Due Date derived
  assertEquals(cells[9], "43");                       // Delay = 2026-05-17 → 2026-06-29
});

// --- Pending IPs ----------------------------------------------------------
// Real shapes captured from Elithum ips[] on 2026-06-29.

Deno.test("deriveIPRow — real IP (Contract 2645), fixedPrice used for Price", () => {
  const r = deriveIPRow(
    { Contract: "2645", Buyer: "Nishat Chunian", Seller: "UNITED", Growth: "Egypyian Giza",
      fixedPrice: "107", price: "", shipmentMonth: "Prompt Shipment", Trans_LC: "2026-06-09", LC_Num: "1398LCS261114" },
    { IP_number: "IP-KHI-FC3CFD/2026", IP_start: "2026-06-22", IP_end: "2026-08-22", IP_quantity: "136.50", IP_sent: "2026-06-22" },
  );
  const cells = ipRowToCells(r);
  assertEquals(cells.length, 13);
  assertEquals(cells.length, PENDING_IPS_COLUMNS.length);
  assertEquals(cells, [
    "2645", "Nishat Chunian", "UNITED", "Egypyian Giza", "107", "Prompt Shipment",
    "2026-06-09", "1398LCS261114",
    "IP-KHI-FC3CFD/2026", "2026-06-22", "2026-08-22", "136.50", "2026-06-22",
  ]);
});

Deno.test("deriveIPRow — Price falls back to on-call price; NBSP in IP_number trimmed", () => {
  const r = deriveIPRow(
    { Contract: "S07777", fixedPrice: "", price: "725-ON-DEC-26" },
    { IP_number: " IP-KHI-C308E2/2026", IP_quantity: "2200" },
  );
  assertEquals(r.price, "725-ON-DEC-26");          // fixedPrice blank → on-call price
  assertEquals(r.ipNumber, "IP-KHI-C308E2/2026");  // leading NBSP stripped
});

Deno.test("deriveIPRow — undefined IP → blank IP cells, contract cells intact", () => {
  const r = deriveIPRow({ Contract: "X", Buyer: "B", fixedPrice: "90" }, undefined);
  assertEquals(ipRowToCells(r).slice(8), ["", "", "", "", ""]);
  assertEquals(r.price, "90");
});

// --- Pending Docs ---------------------------------------------------------

Deno.test("deriveDocsRow — real shipment with docs (Contract 26/S/00962/A)", () => {
  const r = deriveDocsRow(
    { Contract: "26/S/00962/A", Buyer: "Sapphire Fibres Ltd", Seller: "OLAM", Growth: "USA M/E",
      fixedPrice: "90", shipmentMonth: "Apr-26", Trans_LC: "2026-01-20", LC_Num: "LC123" },
    { inv: "05373/04/2026", etd: "2026-04-02", eta: "2026-06-06", bl_number: "265761856",
      shipping_line: "MAERSK", bales: "1320", qs: "289.3800",
      oDocs: "2026-04-05", cDocs: "2026-04-09", discrepancy_sent: "2026-04-20", discrepancy_received: "2026-04-29" },
  );
  const cells = docsRowToCells(r);
  assertEquals(cells.length, 19);
  assertEquals(cells.length, PENDING_DOCS_COLUMNS.length);
  assertEquals(cells.slice(0, 8), [
    "26/S/00962/A", "Sapphire Fibres Ltd", "OLAM", "USA M/E", "90", "Apr-26", "2026-01-20", "LC123",
  ]);
  // Original Docs, Copy Docs, Disc Sent, Disc Received
  assertEquals(cells.slice(15), ["2026-04-05", "2026-04-09", "2026-04-20", "2026-04-29"]);
});

Deno.test("deriveDocsRow — shipment without discrepancies → those cells blank", () => {
  const r = deriveDocsRow(
    { Contract: "X" },
    { inv: "705731", bl_number: "610000861", qs: "59.20", cDocs: "2026-01-30" },
  );
  assertEquals(r.originalDocs, ""); // no oDocs in this shipment → blank
  assertEquals(r.copyDocs, "2026-01-30");
  assertEquals(r.discSent, "");
  assertEquals(r.discReceived, "");
});

// --- Pending Payments -----------------------------------------------------

Deno.test("derivePaymentsRow — Docs columns + Payment Date (20 cols)", () => {
  const c = { Contract: "224110", Buyer: "Nishat Chunian", Seller: "ECOM", Growth: "Brazil BCI",
    fixedPrice: "85.75", shipmentMonth: "Aug/Sep-26 EQ", Trans_LC: "2026-01-08", LC_Num: "26INSU0201-00034" };
  const sh = { inv: "705731", etd: "2026-01-22", eta: "2026-03-12", bl_number: "610000861",
    shipping_line: "EVERGREEN", bales: "261", qs: "59.20", oDocs: "2026-01-26", cDocs: "2026-01-30",
    discrepancy_sent: "2026-02-12", discrepancy_received: "2026-02-23", payment_date: "2026-06-10" };
  const cells = paymentsRowToCells(derivePaymentsRow(c, sh));
  assertEquals(cells.length, 20);
  assertEquals(cells.length, PENDING_PAYMENTS_COLUMNS.length);
  assertEquals(PENDING_PAYMENTS_COLUMNS[19], "Payment Date");
  // first 19 cells identical to the Docs row
  assertEquals(cells.slice(0, 19), docsRowToCells(deriveDocsRow(c, sh)));
  assertEquals(cells[19], "2026-06-10");
});

Deno.test("derivePaymentsRow — no payment → Payment Date blank", () => {
  const r = derivePaymentsRow({ Contract: "X" }, { inv: "1", payment_date: "" });
  assertEquals(paymentsRowToCells(r)[19], "");
});

Deno.test("pktTodayISO — formats a fixed instant in Asia/Karachi", () => {
  // 2026-06-23T20:30:00Z is 2026-06-24 01:30 PKT (UTC+5) → next calendar day
  assertEquals(pktTodayISO(new Date("2026-06-23T20:30:00Z")), "2026-06-24");
});
