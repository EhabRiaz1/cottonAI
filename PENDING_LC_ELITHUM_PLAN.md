# Pending LC's List — Elithum-sourced Excel in the Cotton Mailbox

**Status:** Draft for review (autoplan)
**Branch:** main
**Author:** Ehab + Claude
**Date:** 2026-06-24

## 1. What we're building

In the Cotton Mailbox chat, the user can ask the agent to build a **"Pending LC's list"** — an Excel sheet whose data comes from the company's **Elithum** contracts portal (not from the mailbox). The agent:

1. Recognizes the request (typed, or via a new quick-prompt button).
2. Asks clarifying questions as **claude.ai-style multiple-choice** (buyer/seller, date range), with an "Other / type your own" option.
3. Queries Elithum **read-only** over an authenticated API, transparently showing **"Querying Elithum…"**.
4. Derives the LC-specific columns (LC Due Date, Delay) deterministically.
5. Generates an `.xlsx` and pops it open in the existing **right-side artifact panel**.

This reuses the app's existing xlsx export, artifact panel, multiple-choice button scaffolding, and signed-URL download/share. The genuinely new parts are: a direct read-only Firestore read of the Elithum data (no API to build, no scraper), an agent-driven clarification event, and the LC derivation logic.

## 2. Confirmed facts (discovery, 2026-06-24)

**Cotton app (this repo)** — verified in code:
- Mailbox chat agent: `supabase/functions/mailbox_chat/index.ts`. Tool-use loop (`MAX_ROUNDS = 6`), raw Anthropic `fetch`, model `claude-opus-4-8`. Tools: `search_offers`, `get_recap`, `read_attachment`, `get_email`, `make_file`, optional `web_search`.
- `make_file` (`index.ts:49-67`, runner `374-408`): SheetJS `XLSX.write` → upload to private `exports` bucket via service role → emits `{t:"artifact",file:{name,format,storagePath}}`. Guards: ≤50 cols, ≤5000 rows, rectangular.
- NDJSON wire (`emit`, `index.ts:189`): event types `act`, `artifact`, `tok`, `src`, `err`. Frontend consumes them in `src/MailboxView.tsx:274-306` and `src/lib/api.ts:159-200`.
- Artifact UX (`MailboxView.tsx`): inline card (`528-541`) + collapsible right-side drawer with an XLSX table preview (`635-670`, `openArtifactPane` `196-211`).
- Multiple-choice precedent: `SCOPE_OPTIONS` (`66-71`) rendered as `.scope-option` buttons (`global.css:3453-3470`) in a pending bubble (`550-564`) — but it is **client-driven and hard-coded**, fires once per thread, and is NOT agent-driven. No `ask` event exists today.
- No suggested-prompt array exists; the empty-state hero (`488-499`) only shows static example text.
- Secrets via `Deno.env.get` (`index.ts:81-87`): `ANTHROPIC_API_KEY`, `SUPABASE_*`, etc.

**Elithum portal** — verified live (logged in read-only `test@test.com`, AND read directly from Firestore REST):
- Stack: **Next.js on Vercel + Firebase Auth (Identity Toolkit, web API key `AIzaSyCfgmxB0e_31Bz21d0_5OpGqV7BGqJSIho`) + Cloud Firestore** (project `elithium-4a2dd`). No REST API and none needed — we read Firestore directly (§5a).
- **Data lives in the root Firestore collection `entries`** — one document per contract, **1,854 documents total** (full history back to 2021; the grid's default view only shows the current crop year ≈150 rows, which is why old contracts aren't visible there).
- **Confirmed document field keys** (read live; every field is in the doc regardless of what the grid renders — the off-screen-column problem does not exist at the data layer):

  | Output column | Firestore key | Notes / sample |
  |---|---|---|
  | Contract# | `Contract` | "2608", "S51701.C01" (NOT `GSNo`, e.g. "26/153") |
  | Buyer | `Buyer` | "Sapphire Fibres Ltd" |
  | Seller | `Seller` | "UNITED", "OLAM", "Cargill" |
  | Growth | `Growth` | "Egypyian Giza" (sic) |
  | Fixed Price | `fixedPrice` | "111" (string; blank when on-call → `price`/on-call fields) |
  | Shipment Month | `shipmentMonth` | free text, see below |
  | Date of Sale | `DoS` | **ISO `2025-12-04`** (clean! not the display "17 Jun 2026") |
  | LC Draft Received | `LC_draft` | ISO date or **absent/empty = pending** |
  | Transmitted LC | `Trans_LC` | ISO date `2025-12-12` |
  | LC Number | `LC_Num` | "1398LCS252744" |

  Other useful keys present: `GSNo`, `status` ("active"), `LC_Exp` (LC expiry ISO), `LC_Amnt`, `LSD` (latest shipment date), `cropYear`, `Qty`, `user` (entered-by name, or "Completed" on closed contracts), `_id`, plus a large nested `ips[]` array (shipments/payments — NOT needed; exclude via a `select` projection).
- `DoS` being ISO means the Prompt rule (`DoS + 10d`) needs no messy date parsing. Only `shipmentMonth` needs a parser.
- **Real `shipmentMonth` variety is wide** (parser must degrade gracefully): clean recent ones (`Jun/Jul-26 SO`, `Prompt Shipment`, `Dec-26`, `OCT-NOV-DEC-26`, `Oct - Dec-27 EQ`) but historical ones are junky: `1000T Nov/Dec-24 SO & 1000T Dec-24/Jan-25 SO` (two periods), `2nd Half Aug-25 / Sep-25 EQ`, `1.500 Metric Tons October/November/December 2025`, `Apr'24`, `260 MT Feb/Mar-24 SO (FEB-24)`, embedded quantities/`MT`/`T`, apostrophe years, parenthetical `(FEB-24)` hints. **Anything not parsed with confidence → LC Due Date = "Needs review"**, never a silent wrong date.
- Of 300 sampled rows, 35 had blank `LC_draft`. NOTE: blank `LC_draft` can still co-exist with a present `Trans_LC`/`LC_Num` on old "Completed" contracts (e.g. `Contract 62003`/GS `21/074A`, `S13994.D00`/GS `22/121H`) — the Date-of-Sale range filter scopes these stale rows out. Pending = `LC_draft` blank (owner-confirmed, §4/§12).

## 3. Output sheet — 11 columns

| # | Column | Source / rule |
|---|--------|---------------|
| 1 | Contract# | Elithum `Contract` (NOT `GS No.`) |
| 2 | Buyer | Elithum `Buyer` |
| 3 | Seller | Elithum `Seller` |
| 4 | Growth | Elithum `Growth` |
| 5 | Fixed Price | Elithum `Fixed Price(USC/lb)` (blank/"On call" if empty) |
| 6 | Shipment Month | Elithum `Shipment Month` (verbatim) |
| 7 | LC Due Date | **Derived** (see §4) |
| 8 | LC Draft Received | Elithum `LC Draft`; blank → "No LC Draft" |
| 9 | Transmitted LC Received | Elithum `Transmitted LC` |
| 10 | LC Number | Elithum `LC Number` |
| 11 | Delay (No. of Days) | **Derived** (see §4) |

## 4. Derivation logic (deterministic, in our edge function — NOT the LLM)

LC Due Date and Delay are computed in TypeScript so they're testable and never subject to LLM arithmetic errors. The model only triggers the tool and summarizes the result.

**LC Due Date:**
- If Shipment Month matches `/prompt/i` ("Prompt" / "Prompt Shipment"): `LC Due Date = Date of Sale + 10 days`.
- Else: parse the **first** month token from Shipment Month → first day of that month → **minus 15 days**.
  - "Jun/Jul-26" → first month June 2026 → `2026-06-01 − 15d = 2026-05-17`.
  - "OCT-NOV-DEC-26" → Oct; "Oct - Dec-27 EQ" → Oct 2027; "Dec-26" → Dec 2026.
  - 2-digit year `-26` → 2026. Strip trailing `SO`/`EQ`/`So`. Handle `/ - .` and spaces, any case.
  - Cross-year math (e.g. "Jan-27" → `2027-01-01 − 15d = 2026-12-17`) handled by real date arithmetic.
- If Shipment Month is blank/unparseable and not Prompt → LC Due Date = "N/A" (row flagged).
- If Prompt but Date of Sale missing → "N/A".

**Delay (No. of Days):**
- Let `today` = current date in **Asia/Karachi (PKT)**, date-only.
- If LC Draft is **not** received (blank) AND `LC Due Date < today`: `Delay = today − LC Due Date` (whole days).
- If LC Draft received, or LC Due Date ≥ today, or LC Due Date is "N/A": `Delay = 0` (blank in sheet).

**LC Draft / Transmitted / LC Number:** if `LC Draft` is blank, the contract has no LC yet → column 8 shows "No LC Draft" and 9/10 are empty (per the rule "if blank then no LC received, therefore no draft/transmitted/LC number").

**"Pending" definition (owner-confirmed 2026-06-24):** a row is pending when **`LC_draft` is blank**. Scoped by the Date-of-Sale range, so stale old "Completed" contracts (blank draft but present `Trans_LC`/`LC_Num`) fall out of a 1–2 year window. Keep this literal rule.

## 5. Architecture

```
Cotton Mailbox (React)                Supabase Edge (Deno)                       Google / Firebase
─────────────────────                 ────────────────────                       ─────────────────
quick-prompt / typed prompt ──POST──▶ mailbox_chat agent loop
   "Pending LC's list"                  │  tool: ask_user  ──{t:'ask'}──▶  (date-range A/B/C/D buttons)
   ◀── {t:'ask', options} ─────────────┘
user picks date range ────────POST──▶  tool: query_elithum
                                         │ emit {t:'act','Querying Elithum…'}
                                         │ 1. signInWithPassword (refresh token) ─▶ identitytoolkit  → idToken
                                         │ 2. runQuery(entries, select, DoS range)─▶ firestore REST  → rows
                                         │    (READ-ONLY: only runQuery/GET, never commit/patch)
                                         │ derive LC Due Date + Delay (TS, lc_derive.ts)
                                         │ runMakeFile → exports bucket
   ◀── {t:'artifact'} + {t:'tok'} ──────┘
opens right-side artifact panel (table)
```

### 5a. Data access — direct Firestore read (NO Elithum changes, NO scraper)
Decided after the gate: skip building any API on Elithum and skip browser scraping. Read Firestore directly from the edge function — validated end to end on 2026-06-24.
- **Auth:** server-side Firebase Auth REST `accounts:signInWithPassword` with the Elithum login (stored as secrets) → `idToken` (1h) + `refreshToken`. Cache the refresh token (same pattern as the Gmail integration) and mint `idToken`s via `securetoken.googleapis.com` as needed.
- **Read:** Firestore REST `:runQuery` on collection `entries` with a **`select` field mask** (only the ~12 needed keys — skips the huge `ips[]` arrays, keeps payloads small) and a **`DoS` range filter** (ISO strings sort lexicographically, so `DoS >= from AND DoS <= to` works) to scope by the chosen date window. Buyer/seller filtering done in **JS after the read** (Firestore has no case-insensitive "contains"; volume is small once date-scoped).
- **Read-only by code:** the edge function only ever issues `:runQuery`/`GET` — never `:commit`, `PATCH`, or `createDocument`. (Firestore security rules govern the account; this account can read all `entries`. A dedicated read-only Elithum account is an optional future hardening, not required.)
- **No "owner action" left:** field keys are confirmed (§2). The only externally-owned risk is Firestore field renames → guard with response schema validation (§11b).

### 5b. Cotton side — agent tool + dispatch (new)
- New secrets (Deno.env): `ELITHUM_FB_API_KEY`, `ELITHUM_EMAIL`, `ELITHUM_PASSWORD` (or a pre-minted `ELITHUM_REFRESH_TOKEN`). Server-side only; never shipped to the client.
- New tool `query_elithum` in `MAILBOX_TOOLS` (`mailbox_chat/index.ts`). Input: `{ buyer?, seller?, date_from?, date_to? }`. Prescriptive description so Opus calls it only for Pending-LC requests, never for mailbox-offer questions.
- Dispatch branch (next to `make_file`): emit `{t:'act', label:'Querying Elithum…', cards:[{type:'elithum'}]}`, sign in + `runQuery` Firestore (with `AbortSignal` timeout), filter `LC_draft` blank (pending) + buyer/seller in JS, **derive** LC Due Date + Delay in TS, build the 11-col table, call the existing `runMakeFile` path to make the xlsx + `{t:'artifact'}`, and return the derived rows as the tool result so the model can summarize ("12 pending LCs, 4 overdue").
- New tool `ask_user` (`{question, options:[{key,label}], allow_free?}`): when called, the edge fn emits `{t:'ask', ...}` and ends the turn (the request/response model can't pause mid-stream — clarification is multi-turn, exactly like claude.ai).

### 5b-i. Clarification spec (RESOLVED at gate, 2026-06-24)
The agent asks follow-up questions **only if needed**, claude.ai-style. The primary clarification is **date range** (the contracts' Date-of-Sale window):
- **A) Last 1 year · B) Last 2 years · C) Last 5 years · D) Enter a custom date range** (option D = free text, re-enables the textarea).
- **Buyer/seller is NOT a multiple-choice question.** It is read from the prompt ("Pending LC's list **for Nishat Chunian**"). If the prompt names no entity → default to **all buyers**. If the named entity is ambiguous (e.g. "Nishat" → Chunian/Mills) → a fuzzy-match disambiguation bubble lists the actual matches.
- **Skip the question when already answered:** if the prompt already contains a date range ("…last 2 years"), the agent does NOT ask — it queries directly.

**Flow mechanics (incorporates the Eng fixes — the existing hard-coded mailbox timeline gate must NOT fire for this path):**
- New NDJSON event `{t:'ask', id, question, options:[{key,label}], allowFree}` + new `ask_user` tool. When the model calls `ask_user`, the edge fn emits the event AND emits the question as visible `tok` text (so it persists in the saved assistant turn and the model sees it on resume).
- Frontend keeps a **separate `pendingAsk` state** (distinct from the existing `pendingMessages`/`timeline`), routed through its own handler — NOT the timeline `send()` interceptor. The mailbox "How far back should I look?" timeline gate is **bypassed** for Pending-LC intents (it queries Elithum Date-of-Sale, not the mailbox).
- The clicked answer is sent back as a **structured** user message (e.g. `"[clarification] date_range=last_2_years"`), and a system-prompt rule states: "After the user answers an `ask_user` clarification, call `query_elithum` immediately — do not re-ask."

### 5c. Cotton side — frontend (new)
- Handle `{t:'ask'}` in `runAgent`/`MailboxEvent` (`api.ts:147`, `MailboxView.tsx:274-306`): render `.scope-option` buttons in a pending bubble; clicking sends that option as the next user message; "Other (type your own)" re-enables the textarea (the option-D free-text path).
- New event type added to the `MailboxEvent` union and the edge `emit` shapes.
- Quick-prompt button: add a small suggested-prompt array to the empty-state hero (`488-499`) with "📋 Pending LC's list" → fills input → sends.
- Artifact panel, card, download/share: **reused unchanged**.
- Transparency: the `act` "Querying Elithum…" shows in the inspector; add an "Elithum portal" source chip so data origin is explicit.

## 6. Read-only + transparency guarantees
- Read-only is **by code**: the edge fn only ever issues Firestore `:runQuery`/`GET` — never `:commit`/`PATCH`/`createDocument`. No write path exists. No scraping, no browser UI session. (Optional hardening: a dedicated read-only Elithum/Firebase account.)
- Transparency: explicit `{t:'act','Querying Elithum…'}` before every call, an Elithum source chip on the answer, the "as of <PKT>" stamp embedded in the sheet (§11b), and the visible clarification questions.

## 7. Security
- Elithum login (`ELITHUM_EMAIL`/`ELITHUM_PASSWORD` or a `ELITHUM_REFRESH_TOKEN`) lives in Supabase secrets (`Deno.env`), used only server-side in the edge function — never shipped to the client bundle. (The Firebase web API key is already public in Elithum's client; the password is the sensitive part.)
- `idToken`s are short-lived (1h) and minted server-side; cache only the refresh token.
- Contract data path: Firestore → edge fn → xlsx in the private `exports` bucket (owner/admin path-scoped signed URLs, 600s) — same posture as existing exports. Note: platform admins can read that bucket (existing RLS); these sheets carry commercial contract data.
- No Elithum credentials in the repo or client bundle.

## 8. Edge cases & failure modes
- Shipment Month blank/unparseable → LC Due Date "N/A", Delay blank, row flagged.
- Prompt shipment with missing Date of Sale → "N/A".
- Fixed Price blank (on-call contract) → show blank or "On call".
- First-month ambiguity in ranges/triples handled by "earliest token wins".
- Cross-year date math (Jan shipment → Dec due date).
- `today` pinned to Asia/Karachi to avoid UTC off-by-one in Delay.
- Elithum API down/timeout → structured error; agent says "couldn't reach Elithum," no partial sheet.
- Buyer/seller fuzzy match (user types "Nishat" → "Nishat Chunian"/"Nishat Mills"); case-insensitive contains; multiple matches can be surfaced as a clarification.
- Large result → existing 5000-row / 50-col caps apply; buyer/seller/date filters keep it small.

## 9. What already exists (reuse — do NOT rebuild)
xlsx generation + `exports` upload (`runMakeFile`), artifact NDJSON event + card + right-side table panel, `.scope-option` button CSS + pending-bubble pattern, signed-URL download/share, agent tool-use loop + dispatch.

## 10. NOT in scope (this effort)
- Writing back to Elithum (read-only only).
- **Daily overdue-LC alert / watchdog** — DEFERRED fast-follow (G2). Reuses `lc_derive.ts` + existing WhatsApp share; needs a scheduled job + delta detection. Highest-value next phase.
- **Firestore→Supabase sync/replica** — DEFERRED (G3). Build alongside the watchdog; live API is used for now.
- Elithum reports other than Pending LC.
- PDF export (xlsx only, consistent with the app).
- Browser scraping (explicitly rejected in favor of the read-only API).

## 11. Test plan
- **Unit (parser/derivation):** every real Shipment Month format from §2 → expected first-month + LC Due Date; Prompt → sale+10; blank → N/A; Delay (past-due no draft / draft received / future due); Asia/Karachi boundary.
- **Integration:** `query_elithum` against a mocked Elithum API (success, empty, timeout, 401); xlsx column order == §3; `ask_user` emits a well-formed `ask` event.
- **E2E:** "Make a Pending LC's list for Nishat Chunian" → clarification buttons → "Querying Elithum…" → artifact opens with correct rows; "Other" re-enables free text.
- **Security:** missing/invalid token → 401; confirm no write path; confirm token absent from client bundle.

## 11b. Review revisions (auto-folded from independent CEO/Eng/Design review, 2026-06-24)

These corrections are adopted into the plan (mechanical / clearly-right). The three judgment calls are in §12.

**Correctness (Eng):**
- **Derivation is a pure, testable module.** Extract the Shipment-Month parser + LC Due Date + Delay into `supabase/functions/_shared/lc_derive.ts` with NO Deno/Supabase imports. `today` is an injected argument (not read inside). The repo has **zero test harness today** — add `deno test` (built-in, no new dep) and encode every §2 format as a golden fixture.
- **Date math is UTC-epoch + Intl.** Compute `today` via `Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Karachi'})` → `YYYY-MM-DD`. All due-date/Delay math on integer epochs (`Date.UTC(y,mIdx,1) − 15*86400000`), never local `Date(y,m,d)` constructors. Cross-year is then automatic.
- **Explicit parsers.** Hand-write a `DD Mon YYYY` Date-of-Sale parser (don't trust `Date.parse`). Tokenize Shipment Month on `[/.\-\s]+`, strip trailing `SO`/`EQ`/`So` AND the 2-digit year token, year = `2000 + nn`. No-year or unknown-month → "N/A" (never silently default to current year).
- **Firestore can't filter "contains".** No case-insensitive substring query. Use `:runQuery` with a `DoS` range (ISO strings sort lexicographically) to scope volume, then do buyer/seller `includes` filtering **in JS after the read**. `DoS` is confirmed ISO `YYYY-MM-DD` (sortable). The `select` mask excludes the heavy nested `ips[]`.
- **`LC_draft` blank = pending (owner-confirmed).** Surface columns 8/9/10 from their real values (`LC_draft`/`Trans_LC`/`LC_Num`) so the sheet still shows a transmitted LC / number when present even though the row is "pending" by the blank-draft rule. Don't fabricate "none" for 9/10.
- **Tool failure returns, never throws.** `query_elithum` returns a structured `{error}` as the tool_result (model narrates it) with a taxonomy: Firebase sign-in 400/403 → "Elithum auth failed" (alert owner) · Firestore 5xx/timeout → "temporarily unavailable" · empty result → "no contracts matched" · missing expected keys → "Elithum schema changed" (don't emit an all-N/A sheet). Short AbortSignal (~10s).
- **Field-mapping is RESOLVED (§2).** Firestore keys confirmed against live docs: `Contract`/`Buyer`/`Seller`/`Growth`/`fixedPrice`/`shipmentMonth`/`DoS`/`LC_draft`/`Trans_LC`/`LC_Num`. Pin them in a fixture; add a response schema-contract assertion so a future rename fails loudly instead of producing blank cells.
- **Security invariants:** keep the `${userId}/` exports path (existing RLS depends on it — do NOT switch to a shared prefix). Note: platform admins can read the `exports` bucket (existing posture); these sheets carry commercial contract data. Don't expose `web_search` on the Pending-LC path.

**UX completeness (Design) — adopted:**
- **Overdue rows are visually loud** (the feature's core signal): red/amber tint + status pill in the panel AND fills in the xlsx (SheetJS), a status icon column (🔴 Overdue / 🟡 Due soon / ⚪ Pending / ⚠️ Needs review), **sorted overdue-descending to the top**.
- **Summary banner** above the table: "N pending · M overdue · K need manual review (unreadable shipment month)".
- **Provenance lives in the file, not just chat.** Embed a top metadata row in the xlsx + a panel caption: "Source: Elithum portal · Generated <YYYY-MM-DD HH:MM PKT> · Filters: <buyer/pending>". The Delay column's "today" and this stamp reference the same pinned timestamp. **"As of" timestamp is mandatory** for a live-data financial snapshot.
- **N/A rows show the reason** ("shipment month unreadable"), sorted to top — never a silent N/A with Delay 0.
- **Distinct empty states** (as chat messages, not an empty panel): matched-but-zero ("Nishat Chunian has no pending LCs — all drafts received") vs no-match ("no buyer matching 'Nishaat' — did you mean Nishat Chunian / Nishat Mills?").
- **Error state** has a **[Retry]** button; 401 is silent-to-user + alert-owner, timeout is user-retryable.
- **Progressive loading** `act` stages: "Querying Elithum…" → "Found N contracts, computing LC due dates…" → "Building sheet…".
- **Panel shows ~5 priority columns** (Contract# · Buyer · LC Due Date · LC Draft Received · Delay) with the first column frozen; all 11 live in the downloaded xlsx.
- **Quick-prompt is persistent** (a composer quick-action / `/pending-lc`, not only the once-shown empty-state hero) and **pre-fills rather than auto-sends** (lets the user append a buyer before sending, skipping a round-trip).

## 11c. Decision Audit Trail

| # | Phase | Decision | Class | Principle | Rationale |
|---|-------|----------|-------|-----------|-----------|
| 1 | Eng | Extract pure `lc_derive.ts` + `deno test` golden fixtures | Mechanical | P1/P5 | No harness exists; derivation must be testable |
| 2 | Eng | UTC-epoch + `Intl` Asia/Karachi for all date math | Mechanical | P5 | Avoids silent off-by-one in a finance sheet |
| 3 | Eng | Buyer/seller filter in JS post-read (Firestore can't "contains") | Mechanical | P5 | Firestore has no substring/ci query |
| 4 | Eng | Don't infer Transmitted/LC# from blank LC Draft | Mechanical | P1 | Prevents false "overdue" / hidden real LCs |
| 5 | Eng | Tool returns `{error}` taxonomy + schema validation, never throws | Mechanical | P1 | Graceful degrade; no all-N/A sheet on drift |
| 6 | Eng | Field mapping confirmed live (§2) + schema-validation guard | Mechanical | P1 | Data contract now pinned; guard catches renames |
| G3' | Owner | Data access = direct read-only Firestore read (no API, no scraper) | User-revised | P3 | Owner: avoid Elithum changes; validated end-to-end |
| Pend | Owner | Pending = `LC_draft` blank (literal) | Owner-confirmed | P6 | Owner's workflow; date-range scopes out stale rows |
| 7 | Design | Overdue flagging + status icons + sort-to-top | Mechanical | P1 | It's the feature's entire purpose |
| 8 | Design | Provenance + "as of PKT" embedded in xlsx | Mechanical | P1 | Live snapshot trust/correctness |
| 9 | Design | N/A reasons + distinct empty/error/loading states | Mechanical | P1 | Completeness; silent N/A is a trap |
| 10 | Design | Panel = 5 priority cols (frozen first), 11 in file | Mechanical | P5 | Narrow drawer can't show 11 cols |
| 11 | Design | Persistent quick-prompt, pre-fill not auto-send | Mechanical | P3 | Discoverability + fewer round-trips |
| 12 | Eng/Design | Bare "Pending LC's list" → query ALL pending immediately, no gate | Taste→§12-A | P3/P6 | Dissolves clarification latency + the broken gate |
| D-A | Design/CEO | Pending-only default + one-click "include settled" refinement | Taste | P1 | Matches the feature name; refine, don't gate |

## 12. Open decisions (for the gate)
**Resolved / auto-decided:**
- **D-B (derive where):** LC Due Date/Delay in our edge fn (chosen) — keeps LC rules in one testable place, Elithum stays thin.
- **D-A (pending-only vs all):** default pending-only (LC Draft blank) + one-click "include settled" refinement on the artifact — matches the feature name without throwing away rows the trader may want to sanity-check.

**Resolved at gate (2026-06-24):**
- **G1 — Clarification UX → date-range MCQ.** Agent asks follow-ups only if needed; the MCQ is the **date range** (A 1yr / B 2yr / C 5yr / D custom). Buyer is read from the prompt or defaults to all (not an MCQ). Full spec in §5b-i.
- **G2 — Watchdog → Excel now, alert as defined fast-follow.** Ship the on-demand Excel this effort. The daily overdue-LC alert (reuses the same `lc_derive.ts` engine + existing WhatsApp) is a dated next phase, captured in TODOS — NOT in this scope.
- **G3 — Data access → direct read-only Firestore read (REVISED 2026-06-24, supersedes the earlier "build an API on Elithum" decision).** Owner asked to avoid changing Elithum / avoid a scraper. Validated: sign in via Firebase Auth REST (login as secrets) → `:runQuery` the `entries` collection with a `select` mask + `DoS` range. No Elithum code, no scraper, all columns available. Schema-validation guard catches Firestore field renames. A Firestore→Supabase sync remains the foundation for the G2 watchdog fast-follow.
- **Pending definition → `LC_draft` blank (owner-confirmed).** Literal rule; date-range scoping removes stale "Completed" rows.
