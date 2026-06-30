<!-- /autoplan restore point: /Users/ehabriaz/.gstack/projects/EhabRiaz1-cottonAI/main-autoplan-restore-20260630-103151.md -->
# Cotton Mailbox — two edits

Two independent edits to the Cotton Mailbox feature.

## Edit 1 — Add "Original Docs" column to Pending Docs + Pending Payments

### What
The Elithum reports **Pending Docs** and **Pending Payments** currently include a
**Copy Docs** column (sourced from the shipment's `cDocs` field). Elithum also has an
**Original Docs** field. Add it to both reports, positioned **before** Copy Docs.

### Verified facts (live Firestore query, test@test.com)
- Firestore shipment field name: **`oDocs`** (parallel to `cDocs`).
- Type: date string (e.g. `"2025-03-10"`). Present in 48/50 sampled shipments.
- Both reports share `DocsRow`; `PaymentsRow = DocsRow & { paymentDate }`, so changing
  the Docs path automatically flows into Payments.

### Files + changes
1. `supabase/functions/mailbox_chat/index.ts`
   - `SHIPMENT_KEYS` (~line 615): add `"oDocs"` so it is projected from Firestore.
   - Pending Docs prompt note (~line 226) and Pending Payments prompt note (~line 228):
     change "document columns: Copy Docs, Disc Sent, Disc Received" →
     "Original Docs, Copy Docs, Disc Sent, Disc Received".
2. `supabase/functions/_shared/lc_derive.ts`
   - `RawShipment` type: add `oDocs?: string;`.
   - `DocsRow` type: add `originalDocs: string;`.
   - `PENDING_DOCS_COLUMNS`: insert `"Original Docs"` immediately before `"Copy Docs"`.
   - `deriveDocsRow`: add `originalDocs: (sh?.oDocs ?? "").trim(),`.
   - `docsRowToCells`: add `r.originalDocs` immediately before `r.copyDocs`.
   - `PaymentsRow` / `PENDING_PAYMENTS_COLUMNS` / `derivePaymentsRow` / `paymentsRowToCells`:
     no change needed (inherit from Docs).
3. `supabase/functions/_shared/lc_derive.test.ts`
   - Update Pending Docs + Pending Payments column-order and cell-order assertions to
     include Original Docs before Copy Docs.

### Deploy
Redeploy the `mailbox_chat` edge function (it imports `_shared/lc_derive.ts`).

### Risk
Low. Pure additive column. If a shipment lacks `oDocs`, the cell is blank (same as the
existing handling for every other optional shipment field).

---

## Edit 2 — Date-range selector for the mailbox AI chat

### What
When messaging the mailbox AI agent (NOT report generation), the "How far back should I
look?" gate currently offers `Last 7 / 30 / 90 days / Entire mailbox`. Replace those
presets with: **24 hours, 48 hours, 72 hours, Custom range, Entire mailbox**. "Custom"
reveals from/to date pickers so the user picks an explicit window.

### Decisions (confirmed with owner)
- **Replace** the 7/30/90-day presets (not add alongside).
- **Day-window granularity is acceptable.** Offers are dated by calendar day
  (`cotton_offers.offer_date` is a `DATE`), so 24h = today onward, 48h = last 2 calendar
  days, 72h = last 3. No schema change.

### Current mechanism (reused)
- `SCOPE_OPTIONS` in `MailboxView.tsx` drives the gate; `chooseScope(label, days)` sets
  `timeline = { label, dateFrom }` where `dateFrom = now - days*86400000` (date only).
- `runAgent` → `streamMailboxChat({ ..., dateFrom, timelineLabel })` → `mailbox_chat`
  builds a `timelineNote` and the model calls `search_offers` with `date_from`.
- `search_offers` (`_shared/offer_tools.ts`) **already supports `date_to`** (`q.lte("offer_date", f.date_to)`).
  The only reason custom upper-bounds don't work today is the UI/body never sends a `dateTo`.

### Files + changes
1. `src/MailboxView.tsx`
   - Replace `SCOPE_OPTIONS` with:
     `{label:"Last 24 hours", days:1}, {label:"Last 48 hours", days:2},
      {label:"Last 72 hours", days:3}, {label:"Custom range…", days:null /*custom*/},
      {label:"Entire mailbox", days:0 /*all*/}`.
     (Need to distinguish "custom" from "entire mailbox" — use a discriminated option,
     e.g. `kind: "hours" | "custom" | "all"` instead of overloading `days:null`.)
   - Extend `timeline` state to `{ label, dateFrom, dateTo }`.
   - `chooseScope`: for hours options compute `dateFrom` (and `dateTo = null`); for "all"
     set both null; for "custom" reveal date pickers (mirror existing `lcCustom` pattern:
     new `scopeCustom`/`scopeFrom`/`scopeTo` state) then run with both bounds.
   - Render: in the timeline gate, when custom is chosen show From/To `<input type="date">`
     + Generate/Back, exactly like the LC custom block (lines ~668-679).
   - Pass `dateTo: tl.dateTo` in the `streamMailboxChat` call.
2. `src/lib/api.ts`
   - Add `dateTo?: string | null;` to the `streamMailboxChat` payload type; forward it in
     the POST body.
3. `supabase/functions/mailbox_chat/index.ts`
   - Read `body.dateTo`; when present, append to the `timelineNote` an instruction to pass
     `date_to:"<dateTo>"` to `search_offers` and bound the window on both ends.
   - `timelineLabel` already carries the human label (e.g. "Last 48 hours", "2026-01-01 → 2026-02-01").

### Deploy
Redeploy `mailbox_chat`. Frontend rebuild (Vite/Tauri).

### Risk
Low–medium. Backend already supports both bounds; main work is UI state + wiring `dateTo`.
Edge case: custom range with `from > to` → guard the Generate button (disable unless both
set and from <= to).

---

## NOT in scope
- True rolling-hour precision for the mailbox timeline (owner accepted day-windows).
- Any change to the Elithum Date-of-Sale range picker for report generation (separate gate).
- Adding Original Docs to the LC / Shipments / IPs reports (only Docs + Payments requested).

## What already exists (reused, not rebuilt)
- `search_offers` date_from/date_to filtering (offer_tools.ts).
- Custom from/to date-picker UI pattern (LC range block in MailboxView).
- `DocsRow`→`PaymentsRow` inheritance (one change covers both reports).
- Firestore shipment projection + schema-drift guards (mailbox_chat).

---

# GSTACK REVIEW REPORT

Reviewed via /autoplan. Codex unavailable (binary not installed) → all phases ran with
an independent Claude subagent only (`[codex-unavailable]`); single-reviewer mode.
UI scope: yes. DX scope: yes. Premises confirmed with owner before review (3 questions).

## Consensus tables (Codex column = N/A, unavailable)

CEO — strategy
| Dimension | Claude | Codex | Consensus |
|---|---|---|---|
| Right problem? | partial (gate-exists reframe, F5) | N/A | flagged (defer) |
| Premises stated? | no (label honesty F1; validity F4) | N/A | flagged |
| Scope calibration | concern (amputated middle F2/F3) | N/A | flagged → gate |
| 6-month trajectory | concern (Entire-mailbox cost/quality F3) | N/A | flagged |

Design — UI (only Edit 2 has UI)
| Dimension | Claude | Codex | Consensus |
|---|---|---|---|
| Hierarchy/labels | pass order; FAIL label honesty (C) | N/A | flagged → gate |
| Missing states | from>to feedback (D), defaults (E) | N/A | auto-fix |
| Journey | regression dropping 7/30d (G) | N/A | flagged → gate |
| Control-flow specificity | kind discriminant + chooseScope branch (I/J) | N/A | auto-fix |

Eng — architecture/correctness
| Dimension | Claude | Codex | Consensus |
|---|---|---|---|
| Edit 1 column/cell lockstep | sound | N/A | confirmed |
| Edit 2 dateTo wiring | INCOMPLETE (A/B/C/F) | N/A | auto-fix |
| Edge cases | off-by-one (D), defer-run (C), reset (E) | N/A | auto-fix |
| Tests | concrete index updates (G/H) | N/A | auto-fix |

DX — agent instruction
| Dimension | Claude | Codex | Consensus |
|---|---|---|---|
| Agent passes both bounds | FAIL as-planned (#1 dual-bound) | N/A | auto-fix |
| Label honesty for agent prose | concern (#2/#5) | N/A | flagged → gate |
| Empty-range narration | missing (#3) | N/A | auto-fix |
| Column-list sync | covered (#4) | N/A | confirmed |

## Cross-phase themes (independent flags in 2+ phases — high confidence)
- **Label honesty** — CEO F1, Design C, DX #2/#5 all independently say "24/48/72 hours"
  labels misrepresent a calendar-day filter. → surfaced at gate (contradicts owner's
  explicit label choice).
- **Don't amputate the medium window** — CEO F2/F3 + Design G both say dropping 7/30-day
  presets regresses the 80% "this week/month" case. → surfaced at gate (contradicts
  owner's explicit "replace" choice).

## Decision Audit Trail

| # | Phase | Decision | Class | Principle | Rationale |
|---|------|----------|-------|-----------|-----------|
| 1 | Eng | Widen `runAgent` `tl` param to `{label,dateFrom,dateTo}` | Mechanical | P1/P5 | Compile error otherwise (A) |
| 2 | Eng | `runPendingLc` passes `dateTo:null` | Mechanical | P5 | Compile error otherwise (B) |
| 3 | Eng | Custom branch defers run; does NOT clear `pendingMessages` until Generate | Mechanical | P5 | `pendingMessages` ≠ `pendingLcAsk` lifecycle; dead button otherwise (C) |
| 4 | Eng/DX | Fix day-math to offset=(n−1): 24h→today, 48h→2d, 72h→3d (use days={0,1,2}) | Mechanical | P1 | Matches the windows owner accepted; current `days*86400000` is one day too wide (D) |
| 5 | Eng | Reset `scopeCustom/scopeFrom/scopeTo` in `newChat` + "change" handler | Mechanical | P5 | Stale custom toggle reopens wrong gate (E) |
| 6 | Eng | Add `dateTo?:string\|null` to edge `body` type (index.ts:127) | Mechanical | P5 | Type completeness (F) |
| 7 | Eng | Concrete test updates: add `oDocs` to Docs fixture; shift Payments indices 18→19, length 19→20, slices | Mechanical | P1 | Tests break otherwise (G/H) |
| 8 | Design/Eng | Custom Generate guard `from && to && from<=to` + inline "End must be after start" hint | Mechanical | P1 | LC pattern lacks ordering check; don't just copy (D/I) |
| 9 | Design | Prefill custom To=today, From empty | Mechanical | P3 | Halves input; common "from X until now" case (E) |
| 10 | Design | Use identical "Custom date range…" wording as LC gate | Mechanical | P5 | Two near-identical buttons shouldn't differ (B) |
| 11 | DX | Replace (not append) timelineNote body when dateTo present: force BOTH date_from AND date_to, "inside this window only" | Mechanical | P1 | Existing "search exhaustively/not just recent" wording defeats a soft upper bound (#1) |
| 12 | DX | Add empty-window narration to note: "say so plainly, state the dates, do NOT widen" | Mechanical | P1 | Agent otherwise pads/widens (#3) |
| 13 | CEO | Blank `oDocs` rendered blank (same as Copy Docs sibling) | Mechanical | P4/P5 | Consistency with existing Copy Docs column; distinct "pending" rendering is a separate enhancement (F7 noted) |
| D-A | CEO/Design/DX | **RESOLVED (owner): keep "24/48/72 hours" labels + add caption "Windows are by calendar day."** | Taste | owner | Honors explicit label ask; caption fixes the honesty concern |
| D-B | CEO/Design | **RESOLVED (owner): pure replace — 24h/48h/72h/Custom/Entire only.** No 7/30-day preset. | Taste | owner | Owner's explicit call stands; Custom covers longer windows |

## NOT in scope (added by review)
- F4: offer-validity-window filtering (filter by validity, not received date) — known
  limitation, documented; bigger change.
- F5: removing the timeline gate entirely and letting the agent infer the window from the
  question — strategic reframe, separate decision.
- F6: derived "originals lagging copies (N days)" risk indicator — TODOS candidate.
- F7: rendering blank Original Docs as a distinct "pending" state — future enhancement;
  shipping blank-as-blank now for consistency with Copy Docs.

## Revised implementation deltas (fold into Edit 2 build)
The Edit 2 "Files + changes" above stands, REVISED by audit rows 1–12. Net: the frontend
state machine (rows 1–5, 8–10) is the real work; the backend is row 6 + rows 11–12 (note
text) on top of the already-present `date_to` filter. Edit 1 stands as written + row 7 tests.
