# Plan: Mailbox-Connected Cotton Offer Intelligence

Status: DRAFT for review (autoplan)
Branch: main
Author: Ehab + Claude Code
Date: 2026-06-22

---

## 1. Goal (in the owner's words)

Connect the app to one mailbox (`cottonai@ysgroup.pk`) that receives cotton offers
from brokers. The AI reads every email body, PDF, and Excel attachment, understands
the cotton offers inside them, and lets the user chat: "find me this kind of cotton"
returns the matching offers. Read and search only. No sending or drafting.

`nishat@gmail.com` is unrelated: it is a dummy Supabase-auth login for signing into
the app, not a mailbox to read.

## 2. Confirmed decisions (from intake Q&A)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Mailbox connection | App Password + IMAP. Mailbox is Google Workspace (`imap.gmail.com`). |
| D2 | Searchability | Structured extraction into a searchable database, not raw-text dump. |
| D3 | AI permissions | Read + search + answer only. No drafting, no sending. |
| D4 | Data scope | Global shared pool (offers visible to any logged-in user). |
| D5 | Offer freshness | Keep all offers, no auto-staleness. Date-filter only when the user's question mentions a date. AI always shows each offer's date next to its price. |
| D6 | History scope | Ingest entire mailbox history on first connect; query-driven date filtering after. |
| D7 | Manual upload | Keep existing manual upload alongside Gmail auto-ingest. |
| D8 | Search dimensions | Everything in the PDFs is indexable (specs, origin, certification, commercials, recap deep specs). |
| D9 | Extraction method | AI-powered extraction (Claude reads each PDF/Excel/body), flexible nullable schema. Driven by the fact that every broker's PDF is laid out differently and some have no price at all. |
| D10 | Grade decoding | Store RAW grade strings + best-effort decode. Final decode rules to be defined with the owner later; re-decode happens in-place without re-reading email. |

## 3. What already exists (leverage map)

| Sub-problem | Existing asset | Reuse? |
|-------------|----------------|--------|
| Auth + users | Supabase auth, `org_members`, `platform_admins` | Yes |
| Chat UI + streaming | `src/ChatPanel.tsx`, `src/lib/api.ts` | Yes, extend |
| LLM chat backend | `supabase/functions/chat/index.ts` (Anthropic streaming) | Yes, upgrade to tool-use |
| Excel parsing | `xlsx` in `ingest_sheet` + `chat` | Yes, reuse for Excel attachments |
| Doc storage | Supabase Storage bucket `org-sheets`, `org_documents` table | Yes, add attachments bucket |
| Manual upload | `org_documents` / `org_sheets` flow | Keep as-is |
| Desktop runtime | Tauri (Rust `src-tauri`) | Candidate for IMAP sync (see risk R1) |

Live DB today: `organizations`, `org_members`, `platform_admins`, `org_sheets`,
`org_documents`, `system_prompts`, `chats`, `messages`, `api_keys`. One org, 14 chats.

## 4. NOT in scope (deferred)

- Sending, replying, or drafting email (D3). Removes a whole risk surface.
- Multi-mailbox / per-user "connect your own Gmail" (OAuth). One fixed mailbox for now.
- Final grade-decode rules (D10) — captured raw now, finalized with owner before launch.
- Live futures pricing to compute landed CNF cost — only if a later question needs it.
- Per-org data isolation for offers — global pool for now (D4).
- Real-time Gmail push. Scheduled + manual sync only.

## 5. Architecture

### 5.1 Data model (new tables, global pool)

```
email_messages
  id (uuid pk)
  imap_uid (text)            -- per-mailbox unique, for incremental sync
  rfc_message_id (text uniq) -- de-dup across re-syncs
  from_address, from_name
  subject
  date_sent (timestamptz)
  date_ingested (timestamptz)
  snippet (text)
  broker_guess (text)        -- inferred sender/broker
  has_attachments (bool)
  body_text (text)           -- plain-text body, for body-text offers
  sync_status (text)         -- fetched | extracted | error
  error_message (text)

email_attachments
  id (uuid pk)
  email_id (fk -> email_messages)
  filename
  mime_type
  kind (text)                -- pdf | excel | other
  storage_path (text)        -- Supabase Storage
  size_bytes (int)
  extraction_status (text)   -- pending | done | error | unsupported
  error_message (text)

cotton_offers              -- one row per offer line, MOST FIELDS NULLABLE
  id (uuid pk)
  source_email_id (fk)
  source_attachment_id (fk, nullable)  -- null when offer came from body text
  broker (text)
  origin_country (text)
  region (text)              -- e.g. "West Africa", "M/E"
  certifications (text[])    -- BCI, regenagri, CmiA, HIP...
  grade_raw (text)           -- e.g. "GC 31-3-39/40" verbatim
  color (int)                -- decoded, nullable
  leaf (int)                 -- decoded, nullable
  staple_32nds (int)         -- decoded, nullable
  staple_fraction (text)     -- e.g. "1-5/32"
  mic (numeric)
  gpt (numeric)
  length (numeric)
  uniformity (numeric)
  quantity_bales (int)
  price_basis_points (numeric)   -- on-call basis, e.g. 1700
  price_outright_cents (numeric) -- outright c/lb, e.g. 85.50
  futures_month (text)           -- e.g. "Dec'26"
  crop_year (text)               -- e.g. "2025/26"
  shipment_period (text)
  recap_code (text)              -- join key to cotton_recaps
  raw_line_text (text)           -- verbatim source line, for audit + re-decode
  offer_date (date)              -- from sheet header or email date
  created_at

cotton_recaps              -- detailed quality breakdown PDFs
  id (uuid pk)
  recap_code (text)          -- e.g. "MCRP11"
  source_email_id (fk)
  source_attachment_id (fk)
  crop_year (text)
  total_bales (int)
  avg_mic, avg_staple, avg_gpt, avg_length, avg_uniformity (numeric)
  distributions (jsonb)      -- color/leaf/staple/mic/gpt/length/unif matrices
  raw_text (text)
  created_at

sync_runs
  id, started_at, finished_at, emails_seen, emails_new, attachments_new,
  offers_extracted, status, error_message
```

RLS: all new tables readable by any authenticated user (global pool); writes only by
service role (sync + extraction functions) and platform admins.

### 5.2 Ingestion pipeline

```
[Google Workspace mailbox cottonai@ysgroup.pk]
        | IMAP (App Password, imap.gmail.com:993 TLS)
        v
[Sync worker]  --incremental by imap_uid-->  email_messages + email_attachments
        |                                     (attachments -> Storage)
        v
[Extraction]  per attachment/body -> Claude extract -> cotton_offers / cotton_recaps
        |
        v
[Search/Chat] tool-calling over cotton_offers + cotton_recaps
```

1. Sync worker: connects via IMAP, tracks last `imap_uid`, fetches new messages,
   stores bodies + attachments. De-dups on `rfc_message_id`. Writes a `sync_runs` row.
2. Extraction: for each new PDF / Excel / body-text, call Claude with an extraction
   prompt → JSON array of offers (+ recap object if the doc is a recap). Validate JSON,
   insert rows, set `extraction_status`. Store `raw_line_text` for every offer.
   - PDF: Claude reads PDF natively (document block) with a text-extraction fallback.
   - Excel: reuse `xlsx` → CSV/text → Claude.
   - Body text: Claude on the plain-text body.
   - Idempotent: never re-extract an attachment already `done`.
3. Decode: post-extraction normalize grade_raw → color/leaf/staple (rules TBD, D10).

### 5.3 Search + chat (upgrade existing chat function)

Replace the "dump everything into the system prompt" approach with **tool-calling**:

- `search_offers(filters)` — origin, region, certifications, mic range, staple range,
  grade, gpt range, price ceilings, quantity min, crop year, shipment, date range,
  free-text. Returns matching `cotton_offers` rows (with `offer_date`).
- `get_recap(recap_code)` — returns the deep distribution for a lot.

Claude turns "find Brazil BCI, 1-5/32, mic 4.2-4.8, under 1000 points" into a
`search_offers` call, gets rows, and writes the answer with dates shown (D5). This
scales to hundreds of offers and is the only approach that makes the goal reliable.

### 5.4 UI

- Chat (exists): extend to surface offer results cleanly (tables, dates).
- Settings/Admin: a "Mailbox" panel — connection status, "Sync now" button, last
  sync time, counts, errors. (No password shown in UI; stored as a secret.)
- Stretch: a browsable, filterable Offers table view. Chat-first; table is a fast-follow.

### 5.5 Sync timing

Scheduled (e.g. hourly) + manual "Sync now". Default recommendation; not yet confirmed
with owner — flagged as a taste decision.

## 6. Key technical risks

- **R1 (HIGH) IMAP from Supabase Edge Functions.** Deno Deploy edge runtime may not
  allow the raw TCP sockets IMAP needs. Options, in order of preference:
  (a) Run the sync in the **Tauri desktop app** (Rust has solid IMAP crates) and push
  parsed data to Supabase — no TCP limit, but sync only runs when the app is open.
  (b) Dedicated tiny worker (Cloud Run / a small VPS / scheduled container) doing IMAP.
  (c) **Gmail API over HTTPS** via a Workspace **service account with domain-wide
  delegation** — no per-user OAuth screen, works inside edge functions, but is a
  different auth path than the App Password the owner picked. Decide during eng review.
- **R2 (MED) Extraction cost + accuracy.** Whole-mailbox first sync × PDF tokens can be
  significant. Mitigate: extract once and store; batch; cap first-run; show progress.
  Accuracy: keep `raw_line_text` so wrong extractions are auditable and re-runnable.
- **R3 (MED) Multi-broker layout drift.** New layouts will appear. LLM extraction
  absorbs this better than regex, but needs an eval set of real PDFs and a "low
  confidence / needs review" flag so silent mis-files don't reach search.
- **R4 (MED) Grade decode ambiguity (D10).** Decode rules unsettled. Raw-first storage
  makes this safe to finalize later.
- **R5 (LOW) Secret handling.** App Password lives in Supabase secrets, never in the
  frontend or git. Sync function runs server-side / desktop-side only.

## 7. Phased implementation

- **P0 Foundations** — migrations for the 5 tables + RLS + Storage bucket; secrets
  wiring; `sync_runs` plumbing.
- **P1 Sync** — IMAP fetch (resolve R1 first), incremental, attachments to Storage.
- **P2 Extraction** — Claude extraction for PDF + Excel + body; idempotent; raw stored.
- **P3 Search** — `search_offers` + `get_recap` tools; upgrade chat function to tool-use.
- **P4 UI** — mailbox/sync panel; chat result formatting; (stretch) offers table.
- **P5 Decode + evals** — finalize grade decode with owner; eval set of real PDFs;
  low-confidence review flag.

## 8. Open questions to confirm before/after build

- Grade decode rules: meaning of `G5` and the trailing `28`/`29`; confirm
  Color-Leaf-Staple order and staple-in-32nds (D10).
- Volume: emails/day, to size first-run extraction cost.
- Sync cadence preference (hourly? on app open? both?).
- Do you want the browsable Offers table in v1, or chat-only first?

## 9. Test plan (to be expanded in eng review)

- Extraction evals on PAK.pdf and Recap MCRP11.pdf (known-good expected JSON).
- Idempotency: re-sync same email → no duplicate offers.
- Search correctness: spec/origin/cert/price/date filters return expected rows.
- Body-text and Excel offer paths.
- Missing-price and detail-only PDFs produce valid nullable rows, not errors.

---

## 10. Autoplan review findings + revisions

Reviewed by three independent Claude voices (CEO, Eng, Design). Codex unavailable
(not installed) → tagged subagent-only. Cross-phase themes (raised by 2+ voices) are
high-confidence.

### Revised risk ranking
- **R-NEW (CRITICAL) Extraction accuracy at trade-grade fidelity.** A confidently-wrong
  mic/staple/price that the trader bids on destroys trust permanently. This, not
  transport, is the gating risk. Mitigations are now mandatory (see below).
- **R1 (RESOLVED, was HIGH) IMAP transport.** Decision: IMAP runs in **Tauri/Rust**,
  not Edge Functions (Deno edge runtime cannot open IMAP TCP sockets and has a ~150s
  wall-clock cap). Rust does IMAP + MIME parse; a thin Edge Function holds the service
  role and does the privileged DB/Storage writes. "Sync only when app open" is fine for
  a desktop tool, BUT see freshness handling so stale data is never mistaken for live.

### Mandatory engineering changes (auto-decided, completeness + correctness)
1. **Transport split:** Rust IMAP/parse → Edge Function privileged writes. Service-role
   key NEVER ships in the desktop binary. App Password stored in OS keychain (Tauri
   secure storage), not config/plaintext.
2. **Extraction reliability:** Claude **structured outputs** (`output_config.format`
   json_schema) so output is schema-valid by construction; **prompt caching** on the
   fixed extraction prompt/schema; **Message Batches API** for the first-run backfill
   (cost + async). Pin chat model to `claude-opus-4-8` (tool-use) / extraction may use a
   cheaper tier for simple body/Excel.
3. **Schema hardening (before any extraction code):**
   - `offer_fingerprint` UNIQUE (`sha256(source_attachment_id || raw_line_text ||
     line_index)`) + `INSERT ... ON CONFLICT DO UPDATE` → enables re-extraction and
     D10 re-decode without duplicates. Body-text offers key on `source_email_id + line`.
   - `confidence numeric`, `needs_review boolean`, `decode_version int` on cotton_offers.
   - `price_type` enum (`on_call` | `outright` | `none`) + keep `futures_month`.
   - `recap_code` uniqueness model decided: `(broker, recap_code)` join unless globally
     unique; constrain accordingly.
   - Nullable `org_id` on all new tables (cheap future-isolation insurance).
   - `mailbox_state` row holding `last_seen_uid` + `uidvalidity`; mismatch → full
     re-scan (idempotent via `rfc_message_id` + `content_hash` on attachments).
   - Indexes: GIN on `certifications`; B-trees on `offer_date`, `origin_country`,
     `crop_year`, `broker`, and the numeric range fields; `pg_trgm`/`tsvector` for
     grade + free-text (grades are written inconsistently across brokers).
4. **Chat is a rewrite, not an extension:** the current hand-rolled SSE parser only
   reads `delta.text` and silently drops `tool_use`/`input_json_delta`. Implement a real
   tool-use loop (`search_offers`, `get_recap`); remove the "no data → 400" gate (it
   would reject every offer-only chat); offer reads use the user-JWT client (honor
   global-pool RLS), not the service role. Add an "offers exist" condition to `canChat`.
5. **Offer-as-component rendering:** offers returned as structured JSON rendered into
   cards (chat) / rows (table), not markdown. On-call vs outright visually distinct.

### Resolved disagreement
- D1 transport auth: CEO floated Gmail API + Workspace service-account domain-wide
  delegation; Eng showed that is over-engineered and wrong blast radius for one fixed
  mailbox (DWD grants org-wide mailbox impersonation). **Kept: App Password + Rust IMAP.**
  Reserve Gmail API/OAuth for a future "connect your own mailbox" feature.

### Open premise + two challenges → owner decides (see gate)
- **Premise:** is v1 "find/filter offers" enough, or must it normalize prices so you can
  actually compare and decide (CEO F1: a pure filter is a toy, comparison is the job)?
- **Challenge to D5 (freshness):** both CEO + Design say a printed date won't stop you
  acting on a dead price; recommend an active visual staleness signal (relative age +
  color badge + AI editorializing) on top of keep-all (no hiding/deleting).
- **Challenge to chat-only v1:** both say comparison is spreadsheet-shaped; recommend
  promoting the offers table into v1 (it reuses the same `search_offers` query).

### Validate-first
- Pull real fixtures (PAK.pdf, Recap MCRP11.pdf, plus a few other brokers) into an eval
  set before committing to per-offer LLM extraction; confirm whether broker templates
  are stable (CEO F4). Cap first-run to recent ~60-90 days, backfill older history
  lazily, so first sync isn't an unbounded cost/time surprise (still "all history",
  just not all at once — refines D6).

## 11. Decision audit trail

| # | Phase | Decision | Class | Principle | Rationale |
|---|-------|----------|-------|-----------|-----------|
| 1 | Eng | IMAP in Rust/Tauri, writes via Edge Fn | Mechanical | Explicit/correct | Edge can't do IMAP TCP; keeps service role off the binary |
| 2 | Eng | Structured outputs + caching + batches | Mechanical | Completeness | Guarantees valid JSON; cuts first-run cost |
| 3 | Eng | Schema hardening (fingerprint, indexes, confidence, price_type, org_id, mailbox_state) | Mechanical | Completeness/DRY | Prevents dup rows, slow search, silent mis-files; cheap now, expensive later |
| 4 | Eng | Chat = tool-use rewrite | Mechanical | Explicit | Current parser drops tool_use; dump won't scale |
| 5 | Design | Offer-as-component (cards/rows) | Mechanical | Explicit | Markdown can't guarantee scannable, comparable, trustworthy offers |
| 6 | CEO | Cap first-run to ~60-90d, lazy backfill | Taste | Pragmatic | Bounds cost; keeps full history available |
| 7 | All | Keep App Password (reject Gmail API DWD) | Mechanical | Pragmatic | Right blast radius for one fixed mailbox |

## 12. Final gate decisions (owner-confirmed)

Plan APPROVED with the following resolutions.

- **Premise confirmed (refined):** v1 = read the mailbox, understand every PDF / Excel /
  body offer, and converse about them. Understanding is **grounded in owner-supplied
  cotton reference documents** (a glossary / "how to read these offers" guide + usage
  notes the owner will provide). Comparison happens via the sortable table; price
  normalization is enabled by the reference docs and table sorting rather than a
  hardcoded futures calculator.
- **D5 → REVISED:** keep all offers (nothing hidden/deleted), but add a visual age
  signal: relative age ("12 days old"), green/amber/red freshness dot, very old offers
  visually faded, recent-first default with an "include older" toggle, and the AI
  editorializes freshness in its summary line.
- **D10 → REVISED:** no hardcoded grade decoder. The AI interprets grade/color/leaf/
  staple and other fields using the owner's reference documents as grounding context.
  Still store `grade_raw` verbatim; `decode_version` now tracks which reference-doc set
  produced an interpretation, so re-interpretation is auditable when docs are updated.
- **D11 (new):** Chat + sortable/filterable offers table both in v1 (same `search_offers`
  query rendered as cards in chat and rows in the table).
- **D13 (new): Reference / knowledge documents.** A small set of owner-provided cotton
  reference PDFs (field meanings, how to read offers, working notes). Stored separately,
  injected with **prompt caching** into BOTH the extraction prompt (so the extractor
  interprets fields correctly) and the chat system prompt (so the assistant can explain
  fields and context). This is the source of truth for "what every field means,"
  replacing hardcoded domain rules. Owner will deliver these before P5; build the
  ingestion path for them in P0/P2.

### Revised phase notes
- **P0** add: `reference_documents` table + ingestion path; nullable `org_id`.
- **P2** add: extraction prompt consults reference docs (cached); emit per-offer
  `confidence` + `needs_review`.
- **P4** add: freshness visual signal; offers table view; offer-as-component renderer;
  the full state set (no-sync-yet, sync-in-progress, zero-results, extraction-error,
  IMAP-auth-failed, low-confidence badge). Replace the hardcoded "Live Market Data"
  header badge with real sync health.

### Still owner-to-provide (non-blocking for P0-P1)
- Cotton reference documents (D13) and decoder guidance (D10).
- Real broker fixtures beyond Olam, for the extraction eval set.
- Mailbox App Password (generated at build time; I'll walk through Google Workspace
  2-Step Verification → App passwords, stored in the OS keychain).
- Rough mailbox volume (sizes the first-run backfill).
