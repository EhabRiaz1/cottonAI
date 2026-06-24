// Golden tests for the Pending-LC derivation. Run: `deno test supabase/functions/_shared/lc_derive.test.ts`
// Fixtures are REAL shipmentMonth strings captured from the Elithum `entries` collection.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeDelay, computeLcDueDate, deriveRow, parseFirstShipment, pktTodayISO, rowToCells,
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

Deno.test("pktTodayISO — formats a fixed instant in Asia/Karachi", () => {
  // 2026-06-23T20:30:00Z is 2026-06-24 01:30 PKT (UTC+5) → next calendar day
  assertEquals(pktTodayISO(new Date("2026-06-23T20:30:00Z")), "2026-06-24");
});
