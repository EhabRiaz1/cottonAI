# Pending Shipments Summary — Elithum-sourced Excel in the Cotton Mailbox

**Status:** ✅ BUILT (2026-06-29) — see §18. Reviewed via autoplan; premise resolved by owner (§3).
**Branch:** main
**Author:** Ehab + Claude
**Date:** 2026-06-29
**Predecessor:** `PENDING_LC_ELITHUM_PLAN.md` (shipped — `lc_derive.ts`, `query_elithum`, frontend `pendingLcAsk` flow). This is the **second** of five planned Elithum reports: Pending LC (done) → **Pending Shipments (this)** → Pending IPs → Pending Docs → Pending Payments.

## 1. What we're building

A second on-demand Elithum report in the Cotton Mailbox: **"Pending Shipments list."** Same machinery as Pending LC — typed/quick-prompt intent, claude.ai-style date-range clarification, read-only Firestore read, deterministic derivation, `.xlsx` in the artifact panel — but a **different, wider 17-column table** and a **different row grain** (one row per shipment, not per contract).

The big structural difference from Pending LC: the shipment columns live one and two levels **deeper** in the Elithum document — inside the nested `ips[].shipments[]` arrays that the LC report deliberately skipped.

## 2. Confirmed facts (live discovery, 2026-06-29)

Read live from Firestore via the read-only test login (`test@test.com`), public web API key, project `elithium-4a2dd`, collection `entries`.

### 2a. The Elithum document is a 3-level hierarchy

```
Contract  (entries doc)         ← Contract, Buyer, Seller, Growth, fixedPrice, shipmentMonth, DoS, LC_draft, Trans_LC, LC_Num …
  └─ ips[]   (array)            ← IP_id, IP_number, IP_start, IP_end, IP_sent, IP_seller, IP_quantity, shipments[]
       └─ shipments[] (array)   ← shipment_id, shipment_status, bl_number, shipping_line, etd, eta, qs, inv, bales,
                                   net_shipped_weight, inv_amt, cDocs, oDocs, phyto, certificate, …, payments[]
            └─ payments[]       ← payment_id, payment_status, payment_date, payment_amount, payment_swift, commission_status
```

This single hierarchy explains all five reports: **Pending Shipments** = `shipments[]` level; **Pending IPs** = `ips[]` level; **Pending Docs** = `cDocs/oDocs/phyto/certificate` etc. on `shipments[]`; **Pending Payments** = `payments[]` level.

Scale (last 400 contracts by Date-of-Sale): **400 contracts → 377 IPs → 539 shipments** (480 `confirmed`, 53 `scheduled`, 6 blank-status). 23 IPs have zero shipments. So one-row-per-shipment is ~1.3 rows per contract.

### 2b. Confirmed field keys for the 17 output columns

| # | Output column | Level | Firestore key | Sample / note |
|---|---|---|---|---|
| 1 | Contract # | contract | `Contract` | "2645", "S15039.B00" |
| 2 | Buyer | contract | `Buyer` | "Sapphire Fibres Ltd" |
| 3 | Seller | contract | `Seller` | "UNITED", "OLAM" |
| 4 | Growth | contract | `Growth` | "Egypyian Giza" (sic) |
| 5 | Fixed Price | contract | `fixedPrice` | "111" (blank when on-call) |
| 6 | Shipment Month | contract | `shipmentMonth` | free text |
| 7 | LC Due Date | **derived** | — | `computeLcDueDate` (reuse, unchanged) |
| 8 | Transmitted LC Received | contract | `Trans_LC` | ISO date "2025-12-12" |
| 9 | LC Number | contract | `LC_Num` | "1398LCS252744" |
| 10 | Delay (No. of Days) | **derived** | — | `computeDelay` (reuse, unchanged) |
| 11 | Invoice # | shipment | `inv` | "05373/04/2026", "705731" |
| 12 | ETD | shipment | `etd` | ISO "2026-04-02" |
| 13 | ETA | shipment | `eta` | ISO "2026-06-06" |
| 14 | BL Number | shipment | `bl_number` | "265761856" |
| 15 | Shipping Line | shipment | `shipping_line` | "MAERSK" (⚠ stray tabs/leading spaces in data → **trim**) |
| 16 | No. of Bales | shipment | `bales` | "1320" (string int) |
| 17 | Shipped QTY (MT) | shipment | `qs` | "289.3800" (string, already MT) |

Exact column order (owner-specified, verbatim): **Contract #, Buyer, Seller, Growth, Fixed Price, Shipment Month, LC Due Date, Transmitted LC Received, LC Number, Delay (No. of Days), Invoice #, ETD, ETA, BL Number, Shipping Line, No. of Bales, Shipped QTY (MT).**

Note: this report **drops** the LC list's "LC Draft Received" column (col 8 there) — owner's column list omits it.

## 3. Owner-confirmed semantics (2026-06-29)

- **Pending population = `LC_draft` blank** — *identical to the Pending LC list* ("Same as Pending LC"). NOT a shipment-status filter. The owner twice declined a `shipment_status`-based rule. Scoped by the same Date-of-Sale range clarification.
- **Row grain = one row per shipment** (`ips[].shipments[]`). A pending contract with N shipments → N rows, repeating the contract-level cells (cols 1–10). **A pending contract/IP with zero shipments still appears as one row** with shipment cells (11–17) blank — nothing is hidden.
- **Blanks are fine** — "if something is blank you can leave it as blank in the column." No row is dropped for sparse shipment data; missing shipment fields render empty.
- **Shared columns (1–10) reuse Pending-LC logic verbatim** — Contract/Buyer/Seller/Growth/fixedPrice/shipmentMonth straight through; LC Due Date via `computeLcDueDate`; Transmitted LC via `Trans_LC`; LC Number via `LC_Num`; Delay via `computeDelay` (LC-based: overdue only when `LC_draft` blank and LC Due Date < today PKT). Owner: "derive mechanism should be the same."

> **✅ PREMISE RESOLVED (owner, 2026-06-29).** At the gate the owner clarified that "same as Pending LC" meant the same *mechanism* (the date-range/frequency clarification flow + the shared-column derivation), NOT a `LC_draft` population filter. The sheet is a **straight copy of the shipment data from the Elithum portal, scoped by the chosen Date-of-Sale range** — one row per real shipment (`ips[].shipments[]`), all shipments included, no status sub-filter, blanks left blank. Contracts with no shipment simply produce no row (nothing to copy). This is what was built (§18). A `shipment_status != 'confirmed'` "open shipments only" variant remains a one-line filter if wanted later.

## 4. Derivation (deterministic — extend `lc_derive.ts`, NOT the LLM)

Cols 7 & 10 reuse the existing pure functions unchanged. Add a **new pure helper** for the shipment row so it stays unit-testable with `deno test`:

```ts
// new in supabase/functions/_shared/lc_derive.ts
export type RawShipment = {
  inv?: string; etd?: string; eta?: string; bl_number?: string;
  shipping_line?: string; bales?: string; qs?: string;
};
export type ShipmentRow = DerivedRow & {   // DerivedRow already carries cols 1–10 fields
  invoice: string; etd: string; eta: string; blNumber: string;
  shippingLine: string; bales: string; shippedQtyMt: string;
};

export const PENDING_SHIPMENTS_COLUMNS = [
  "Contract#", "Buyer", "Seller", "Growth", "Fixed Price", "Shipment Month",
  "LC Due Date", "Transmitted LC Received", "LC Number", "Delay (No. of Days)",
  "Invoice #", "ETD", "ETA", "BL Number", "Shipping Line", "No. of Bales", "Shipped QTY (MT)",
];

// one shipment + its parent contract → one output row. `sh` may be undefined
// (contract/IP with no shipment → blank shipment cells).
export function deriveShipmentRow(contract: RawContract, sh: RawShipment | undefined, todayISO: string): ShipmentRow { … }

export function shipmentRowToCells(r: ShipmentRow): string[] {
  return [
    r.contract, r.buyer, r.seller, r.growth, r.fixedPrice, r.shipmentMonth,
    r.lcDueDate, r.transmittedLc, r.lcNumber, r.delayDays > 0 ? String(r.delayDays) : "",
    r.invoice, r.etd, r.eta, r.blNumber, r.shippingLine, r.bales, r.shippedQtyMt,
  ];
}
```

- `shipping_line` → `.trim()` (data has leading tabs/spaces).
- `etd`/`eta`/`inv`/`bales`/`qs` passed through as strings (already clean ISO / numeric strings); blank when absent. No date math on ETD/ETA in v1 (display only).
- Cols 1–10 come from `deriveRow(contract, today)` so LC Due Date / Delay are byte-identical to the LC report.

## 5. Architecture (mirrors Pending LC; deltas marked **NEW**)

```
Cotton Mailbox (React)              Supabase Edge (Deno)                    Firebase/Firestore
quick-prompt "Pending Shipments" ─▶ mailbox_chat agent loop
   ◀── {t:'ask', date range} ──────  (reuse pendingLc date-range MCQ)
user picks range ──────────────────▶ tool: query_elithum_shipments  **NEW dispatch branch**
                                       │ emit {t:'act','Querying Elithum…'}
                                       │ signIn (reuse elithumIdToken)
                                       │ runQuery entries + **ips select** **NEW mask**
                                       │ filter LC_draft blank (pending)  (reuse rule)
                                       │ flatten contract→ips[]→shipments[] **NEW**
                                       │ deriveShipmentRow (TS) **NEW**
                                       │ runMakeFile → exports bucket (reuse)
   ◀── {t:'artifact'} + {t:'tok'} ───┘
```

### 5a. Backend (`supabase/functions/mailbox_chat/index.ts`)
- **Field mask:** add `ips` to the Firestore `select`. Firestore can project the `ips` array but not sub-fields of array elements, so we receive full `ips[]` (incl. `shipments[].payments[]`). Payload: ~2.7 MB for 400 contracts unscoped; the Date-of-Sale range keeps it small. Use a **separate mask constant** (`FS_FIELDS_SHIPMENTS = [...FS_FIELDS, "ips"]`) so the LC path stays lean.
- **New tool** `query_elithum_shipments` in `MAILBOX_TOOLS` (or extend `query_elithum` with a `report:"lc"|"shipments"` enum — see §12 D-1). Prescriptive description: only for "Pending Shipments list" requests.
- **New dispatch branch** next to `query_elithum`: sign in (reuse `elithumIdToken`), `runQuery` with the shipments mask, filter `LC_draft` blank + buyer/seller in JS, **flatten** each pending contract into shipment rows (`contract × ips[] × shipments[]`; zero-shipment contract → one blank-shipment row), `deriveShipmentRow`, build the 17-col table, `runMakeFile`, return summary `{pending_total, rows, overdue, as_of_pkt, source}`.
- **`fsUnwrap` for nested arrays/maps:** the current `fsUnwrap` only handles scalars. Add map/array unwrap (already prototyped in discovery) to read `ips[].shipments[]`. Keep it in the edge fn (impure Firestore shape) — the pure `lc_derive.ts` only sees plain `RawContract`/`RawShipment`.
- **Schema guard:** non-empty result but no `Contract` anywhere, OR `ips` present but no recognizable shipment keys across the whole result → throw "schema drift" (existing taxonomy → "Elithum's data format changed").

### 5b. Frontend (`src/MailboxView.tsx`, `src/lib/api.ts`)
- **Reuse the entire `pendingLcAsk` date-range flow.** Generalize it to a `pendingElithumAsk` carrying a `report` discriminator (`"lc" | "shipments"`), OR add a parallel `pendingShipAsk` (see §12 D-2). Same A/B/C/D date-range MCQ, same bypass of the mailbox timeline gate.
- **Intent detection:** add `PENDING_SHIP_RE = /(pending\s*shipments?)|(shipments?\s+(list|summary))/i` and a `PENDING_SHIP_PROMPT = "Make me a Pending Shipments list"`. Route matched text to the shipments ask (check it **before** `PENDING_LC_RE`, since "shipment" must not be swallowed by the LC regex — verify no overlap).
- **Quick-prompt button:** add "📦 Pending Shipments list" next to the existing "📋 Pending LC's list" in the empty-state hero; pre-fills "Make me a Pending Shipments list for " (not auto-send), same as LC.
- **Wire `pendingLc` payload:** `streamMailboxChat` already forwards a `pendingLc` object with date range; extend it to carry `report` so the edge fn calls the right tool. Artifact panel / card / download / share: **reused unchanged** (17 cols < 50-col cap; panel shows ~5 priority cols frozen, full 17 in the xlsx).

## 6. Read-only + transparency (unchanged from LC)
Read-only by code (`:runQuery`/GET only, never `:commit`/PATCH). Explicit `{t:'act','Querying Elithum…'}`, Elithum source chip, "as of <PKT>" stamp embedded in the xlsx. Same credentials/secrets posture (`ELITHUM_EMAIL`/`ELITHUM_PASSWORD` server-side only).

## 7. Security (unchanged from LC)
Elithum creds in Supabase secrets, server-side only. Short-lived idToken cached in-memory. xlsx in private `exports` bucket, `${userId}/`-scoped signed URLs (600s). Note: platform admins can read `exports` (existing posture) — these sheets carry commercial contract + shipment data. Don't expose `web_search` on this path.

## 8. Edge cases & failure modes
- Contract/IP with no shipment → one row, shipment cols blank (owner-confirmed).
- Multiple shipments per contract → multiple rows, contract cells repeated.
- `shipping_line` leading tabs/spaces → trim.
- LC Due Date / Delay unparseable → "Needs review" / blank, sorted to top (reuse LC behavior).
- Elithum down/timeout/401/empty → structured `{error}` taxonomy (reuse), no partial sheet.
- Large result (many shipments) → existing 5000-row / 50-col caps; date + buyer/seller scoping keeps it small. **Note:** flattening multiplies rows — a wide date range on a big buyer could approach the cap; `log()` if truncated.
- `ips`/`shipments` absent on a doc → treated as zero-shipment contract (not an error).
- ETD/ETA in a non-ISO format (rare) → passed through verbatim (display-only in v1).

## 9. What already exists (reuse — do NOT rebuild)
`lc_derive.ts` (cols 7,10 + the pure-module pattern), `elithumIdToken` + `queryElithumContracts` (extend mask), `runMakeFile` + `exports` upload, artifact NDJSON event + card + right-side table panel, `.scope-option` button + pending-bubble + date-range MCQ, signed-URL download/share, agent tool-use loop + dispatch, `{t:'ask'}` bypass of the mailbox timeline gate.

## 10. NOT in scope (this effort)
- Pending IPs / Pending Docs / Pending Payments (the other 3 reports — same hierarchy, separate efforts; this plan maps the data model for all of them in §2a).
- ETD/ETA-based delay or "shipment overdue" derivation (display-only here; a shipment watchdog is a future fast-follow alongside the LC watchdog G2).
- Writing back to Elithum (read-only only).
- A `shipment_status`-based "open shipments" view (flagged as the §3 gate alternative; not built unless owner picks it).
- PDF export (xlsx only).

## 11. Test plan
- **Unit (`deno test`, extend `lc_derive.test.ts`):** `deriveShipmentRow` with (a) full shipment, (b) undefined shipment → blank cells 11–17, (c) `shipping_line` trim, (d) cols 1–10 byte-identical to `deriveRow` for the same contract; `shipmentRowToCells` order == §2b.
- **Integration:** flatten logic — 1 contract × 2 IPs × {1 shipment, 0 shipments} → correct row count and repeated contract cells; mask includes `ips`; `query_elithum_shipments` returns `{error}` on auth/timeout/schema-drift; xlsx column order == §2b (17 cols).
- **E2E:** "Make me a Pending Shipments list for OLAM" → date-range buttons → "Querying Elithum…" → artifact opens; a pending contract with no shipment shows one blank-shipment row; buyer filter works.
- **Security:** no write path; creds absent from client bundle; signed URL `${userId}/`-scoped.
- **Live fixture:** pin 2–3 real contracts from this discovery (e.g. `2645` scheduled w/ shipment, `26/S/05114/B` IP w/ empty shipments) as golden fixtures so a Firestore rename fails loudly.

## 12. Open decisions (for the gate)
- **§3 KEY PREMISE — pending = `LC_draft` blank vs `shipment_status != confirmed`.** Owner chose `LC_draft` blank (twice). Confirm at gate; the alternative is a one-line filter.
- **D-1 — one tool with a `report` enum vs a second `query_elithum_shipments` tool.** Recommend: **extend `query_elithum` with `report:"lc"|"shipments"`** (DRY — shared sign-in/query/error path; one dispatch branch switches the mask + builder). Avoids duplicating ~80 lines.
- **D-2 — generalize `pendingLcAsk` vs add parallel `pendingShipAsk` state.** Recommend: **generalize to `pendingElithumAsk` + `report` field** (the date-range UX is identical; a second near-duplicate state machine is the DRY smell P4 warns about).
- **D-3 — overdue visual treatment.** Reuse LC's red/amber overdue tint + sort (Delay is the shared signal). Recommend: yes, but group has-shipment rows first (see §16 R12). NOTE: current LC code (`index.ts:558`) sorts by `delayDays` desc only — "Needs review" rows actually sink to the *bottom* today; "review-to-top" would be new behavior (Eng F3).

---

## 13. Independent voices (autoplan)

Codex unavailable on this machine (`[codex-unavailable]`) → **subagent-only** review. Three independent Claude subagents (CEO, Eng, Design), each with no prior-phase context. Full findings captured in the autoplan run; summarized below.

**CEO (strategy):** CRITICAL — pending=`LC_draft` blank is semantically wrong for a *shipment* report (excludes ~89% of shipments, which are `confirmed` → LC received → not blank-draft → filtered out); default should be the shipment-status/ETA view. HIGH — this is the rule-of-three moment to extract a report-descriptor engine, not clone report #1 a second time. HIGH — roadmap is all on-demand "pull"; the highest-value "push" (watchdog) stays deferred with no rationale.

**Eng (correctness):** CRITICAL F1 — zero-shipment row-grain is self-contradictory across §3/§5a/§8/§11 and untestable as written. HIGH F7 — `runMakeFile` hard-*rejects* >5000 rows (`index.ts:417`), it never truncates; "log() if truncated" describes nonexistent behavior. MED/HIGH F10 — `PENDING_SHIP_RE` second branch hijacks ordinary mailbox queries ("shipment list from the COFCO email"). MED F11 — `pendingLcNote` system prompt (`index.ts:206-208`) is LC-hardcoded; a shipments request would be narrated as LCs; also resolve `report` from the frontend `pendingLc` payload, not the model arg. MED F4/F5 — `fsUnwrap` returns a *string*; reading `ips[].shipments[]` needs a new recursive `fsDeep` with full scalar coverage. Confirms D-1 (enum) and D-2 (generalize state) are both correct. Security: read-only invariant preserved; data-minimization risk — `payments[]` now enters edge memory, assert it's never serialized.

**Design (UX):** CRITICAL F0/F1 — same premise objection; a sheet titled "Pending Shipments" populated by an LC predicate is a mislabeled, mostly-empty artifact; flip the predicate or rename. HIGH — blank cell has 3 meanings (no shipment / missing field / bug); needs a `shipment_status` icon column + "no shipment yet" sentinel + summary banner counting contracts vs shipment rows vs awaiting-first-shipment. HIGH — one-row-per-shipment has no grouping spec (repeated contract cells = noise). HIGH — schema-drift guard false-positives on a valid zero-shipment result. MED — panel's 5 priority cols must be shipment-forward (Contract# · Buyer · Shipment Status · ETD · BL Number), not the LC five.

## 14. Consensus (subagent-only; "Codex" = N/A)

```
DIMENSION                              Claude-subagent   Consensus
─────────────────────────────────────  ───────────────   ─────────
1. Pending rule (LC_draft blank) sound?   NO (CEO+Design)   FLAG — CRITICAL (cross-phase)
2. Right problem / engine vs clone?       Engine (CEO)      FLAG — taste/scope
3. Row-grain / flatten correct?           NO (Eng F1)       FIX — resolve + test
4. 5000-row cap handled?                  NO (Eng F7)       FIX
5. Intent regex safe?                     NO (Eng F10)      FIX
6. Read-only / security preserved?        YES               CONFIRMED
7. DRY (D-1 enum, D-2 generalize)?        YES               CONFIRMED
8. UX completeness (blanks/grouping)?     NO (Design)       FIX
```

## 15. Cross-phase theme (high-confidence)

**The `LC_draft`-blank pending rule** was independently flagged **CRITICAL by both CEO and Design**, reached separately with no shared context. Two-of-two independent critical convergence on the one premise the owner set → this is the load-bearing decision and goes to the gate as a **User Challenge** (never auto-decided), not a footnote.

## 16. Folded mechanical revisions (auto-decided, clearly-right — adopted into the plan)

- **R1 (Eng F1, grain):** zero-shipment rule = **blank row only when the whole CONTRACT has zero shipments** (an empty IP inside a contract that did ship produces nothing). Integration test asserts explicit row counts (contract w/ IP1={1 ship}, IP2={0 ship} → **1 row**). [P5]
- **R2 (Eng F2, counts):** `pending_total`/`overdue`/`needs_review` count **distinct contracts** (pre-flatten); add a separate `rows` count; narration says "N pending contracts across M shipment rows." [P1]
- **R3 (Eng F4/F5, unwrap):** add a NEW recursive `fsDeep(v):unknown` (handles `arrayValue`/`mapValue` + ALL scalar types `string|integer|double|timestamp|boolean|null` at every depth); keep `fsUnwrap` for flat fields. Unit-test it on a real Firestore-shaped `arrayValue/mapValue` blob. [P5]
- **R4 (Eng F7, cap):** the shipments builder **pre-truncates** to ≤5000 rows and sets `truncated:true` + counts in the summary so the model says "showing first N — narrow the range"; never rely on `runMakeFile`'s hard-error path. [P1]
- **R5 (Eng F10, regex):** tighten to require a pending/make-me anchor — `/(pending\s*shipments?)|(\bshipments?\s+(list|summary)\b.*\bpending\b)/i` — so "shipment list from the COFCO email" is NOT hijacked to Elithum. [P1]
- **R6 (Eng F11, narration):** parameterize the system-prompt note per report (LC vs shipments wording incl. the "do NOT call web_search" line — `web_search` is global and can only be steered by prompt, not removed); resolve `report` from `pendingLc.report` (frontend source of truth) with the model arg as fallback. [P1]
- **R7 (Eng F9, doc):** fix the §5b rationale — `PENDING_LC_RE` does NOT actually match "Pending Shipments list"; ship-first ordering is still kept (defensive for dual-mention), but the stated reason was wrong. [P5]
- **R8 (Eng/Design, schema guard):** drift guard requires a **positive** signal (shipment objects present whose keys don't match the known set); a zero-shipment result is VALID and must never throw "format changed." [P1]
- **R9 (Eng, security):** assert the builder/tool_result can never serialize `payments[]` (amounts/swift/commission) into the sheet or model context; confirm admin-read posture of `exports` is acceptable for shipment-level data. [P1]
- **R10 (Eng, tests):** add an **LC regression test** (LC sheet byte-identical after the shared-mask/enum/state refactor); golden fixtures pin the **raw Firestore JSON shape**, not just contract numbers. [P1]
- **R11 (Design, blank states):** add a `shipment_status` **icon column** (🔵 Shipped / 🟢 Scheduled / ⚪ Not shipped yet) as the first shipment cell; zero-shipment rows show ⚪ + em-dash sentinels; summary banner counts "K pending contracts · J have shipments (M rows) · K−J awaiting first shipment." [P1]
- **R12 (Design, grouping):** panel blanks repeated contract cells on continuation rows + thin rule between contracts; xlsx keeps every cell populated (so Excel sort/filter works) but uses alternating contract-band fill; group has-shipment rows above no-shipment rows. [P1]
- **R13 (Design, empty state):** new "pending-but-zero-shipments" chat message ("Sapphire has 12 pending contracts — none have shipped yet"), distinct from no-match. [P1]
- **R14 (Design, panel cols):** panel = **Contract# · Buyer · Shipment Status · ETD · BL Number** (shipment-forward), first col frozen; all 17 in the xlsx. [P5]
- **R15 (Eng F8, perf):** acknowledge the shipments mask is materially heavier than LC; use a lower default date range for shipments and note the 20s timeout risk on wide unscoped queries. [P3]

> R11–R14 partly depend on the §3 premise resolution: if pending flips to the shipment-status view, blank rows mostly vanish and these become lighter. They're adopted either way (defensive), but their weight scales with that decision.

## 17. Decision Audit Trail

| # | Phase | Decision | Class | Principle | Rationale |
|---|-------|----------|-------|-----------|-----------|
| C1 | CEO/Design | Pending rule: `LC_draft` blank vs `shipment_status != confirmed` vs rename | **USER CHALLENGE** | — | Both models CRITICAL; owner set it twice; never auto-decided → gate |
| C2 | CEO | Extract report-engine now vs clone report #1 | **Taste** | P3/P5 | Rule-of-three; real upfront-cost tradeoff → gate |
| C3 | CEO | Build watchdog (push) before more reports | Taste/roadmap | P6 | Beyond this feature; surfaced as roadmap note |
| C4 | Design | Two→five look-alike buttons; build menu now | Taste | P3 | Two buttons fine now; defer menu to report #3 (auto: defer) |
| 1 | Eng | R1 contract-level zero-shipment grain + asserted counts | Mechanical | P5 | Spec was self-contradictory |
| 2 | Eng | R2 count distinct contracts, not rows | Mechanical | P1 | Prevents misleading "N overdue" |
| 3 | Eng | R3 recursive `fsDeep` + scalar coverage + test | Mechanical | P5 | String-return unwrap can't read nested arrays |
| 4 | Eng | R4 pre-truncate at 5000, never hard-fail | Mechanical | P1 | make_file rejects, doesn't truncate |
| 5 | Eng | R5 tighten ship regex (anchor on pending) | Mechanical | P1 | Broad branch hijacks mailbox queries |
| 6 | Eng | R6 per-report system-prompt note + payload-sourced `report` | Mechanical | P1 | Else shipments narrated as LCs |
| 7 | Eng | R7 fix wrong regex rationale | Mechanical | P5 | LC regex doesn't swallow "shipments" |
| 8 | Eng/Des | R8 schema guard needs positive drift signal | Mechanical | P1 | Zero-shipment is valid, not drift |
| 9 | Eng | R9 never serialize `payments[]`; confirm admin posture | Mechanical | P1 | Data minimization |
| 10 | Eng | R10 LC regression test + raw-shape fixtures | Mechanical | P1 | Refactor touches shared LC path |
| 11 | Design | R11 status icon + blank sentinels + banner counts | Mechanical | P1 | Blank = 3 meanings; established N/A-reason rule |
| 12 | Design | R12 multi-row grouping (panel blank-repeats / xlsx bands) | Mechanical | P1 | Repeated cells = noise |
| 13 | Design | R13 zero-shipments empty state | Mechanical | P1 | Most common sparse result reads as broken |
| 14 | Design | R14 shipment-forward panel 5 cols | Mechanical | P5 | Panel must say "shipments" |
| 15 | — | D-1 one tool + `report` enum | Mechanical | P4 | Both models confirm DRY |
| 16 | — | D-2 generalize `pendingLcAsk`→`pendingElithumAsk` | Mechanical | P4 | Avoid duplicate state machine |

## 18. Build (2026-06-29)

Implemented as a focused clone with the DRY fixes (one tool + app-driven `report`, generalized ask-state). Files changed:

- **`supabase/functions/_shared/lc_derive.ts`** — added `RawShipment`, `ShipmentRow`, `PENDING_SHIPMENTS_COLUMNS` (17, exact owner order), `deriveShipmentRow` (cols 1-10 reuse `deriveRow`; cols 11-17 from the shipment, `shipping_line` trimmed), `shipmentRowToCells`.
- **`supabase/functions/mailbox_chat/index.ts`** — new recursive `fsDeep` unwrap (arrays+maps+all scalars); `FS_FIELDS_SHIPMENTS` (`+ips`); `SHIPMENT_KEYS` whitelist that **excludes `payments[]`** (R9 data-minimization); `queryElithumWithShipments` (positive-signal schema guards, R8); `runQueryElithumShipments` (flatten one-row-per-shipment, distinct-contract counts R2, pre-truncate at 5000 R4); dispatch routes on app-driven `pendingReport` (R6); per-report system prompt note (R6); `query_elithum` tool description generalized. **LC path untouched** (FS_FIELDS / `queryElithumContracts` / `runQueryElithum` unchanged → regression-safe).
- **`src/MailboxView.tsx`** — `PENDING_SHIP_RE` (anchored on "pending", R5) checked before `PENDING_LC_RE`; generalized `pendingLcAsk` to `{ msgs, report }`; threaded `report` through `send`/`runPendingLc`/`chooseLcRange`/`chooseLcCustom`/`runAgent`; ask-bubble title switches on report; added "📦 Pending Shipments list" quick-prompt (pre-fill, not auto-send).
- **`src/lib/api.ts`** — `streamMailboxChat` body `pendingLc.report` field.
- **`supabase/functions/_shared/lc_derive.test.ts`** — 3 new golden tests (full shipment, whitespace trim, undefined-shipment cols-1-10-identical-to-LC) using real captured shapes.

**Verification:** frontend `tsc -b && vite build` clean; LC-due/Delay/trim arithmetic checked independently; full flatten + 17-col mapping validated against 400 live contracts (539 rows / 352 contracts / 46 zero-shipment skipped / 102 multi-shipment repeated; full + sparse rows render correctly). `deno test` not run locally (deno not installed) — runs in deploy/CI.

**Deployed** 2026-06-29 (`supabase functions deploy mailbox_chat`) — the LC-only version was live until then, which is why both quick-prompt buttons produced the LC sheet (old function ignored the `report` flag).

**Not yet done:** run `deno test` in CI; Design polish R11–R14 (status-icon colouring, panel column reorder, multi-row banding, zero-shipment empty-state copy) deferred as fast-follow — core report is functional without them.
