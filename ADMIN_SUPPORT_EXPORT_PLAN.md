# Plan: Admin Oversight, Support Pipeline, File Export & WhatsApp Sharing

Status: DRAFT for review (autoplan)
Branch: main
Author: Ehab + Claude Code
Date: 2026-06-23

---

## 1. Goal (in the owner's words)

Four additions to the cottonAI app, all hanging off the **Cotton Mailbox** feature:

1. **Admin oversight** — a master/admin view of **all** Cotton Mailbox chats users are
   having, including **which account** is chatting and the **full transcript** (read-only).
2. **Support pipeline** — customers get a **Support** tab to send (a) a **general enquiry**
   (free text) or (b) a **chat enquiry** (pick one of their chats + a paragraph on what went
   wrong). These land in the **admin portal** as a support inbox (DB-backed; no external alerts).
3. **AI file generation (on request)** — in the mailbox chat, the user can prompt the AI to
   turn a table / any info into an **Excel or PDF** file and **download** it. Quick **WhatsApp**
   share link for the file.
4. **Chat export via WhatsApp** — share a chat **transcript** via WhatsApp (prefilled text).

## 2. Confirmed decisions (intake Q&A, 2026-06-23)

| # | Decision | Choice |
|---|----------|--------|
| A1 | Admin chat visibility | **Full transcripts + account**, read-only |
| A2 | Support delivery | **Admin portal inbox (DB)** only — no email/WhatsApp alerts |
| A3 | File export trigger | **On request only** — user asks the AI; it returns a download |
| A4 | WhatsApp sharing | **Transcript as prefilled text**; generated files uploaded → shareable link embedded in the WhatsApp text |

Implied/!default decisions (call out in review):
- WhatsApp uses `https://wa.me/?text=<encoded>` (no fixed number) → opens WhatsApp, user
  picks the contact. (Owner picked "text + file link", not "fixed number".)
- File links for WhatsApp must be openable by a recipient with no app login → time-limited
  **signed URLs** from a private `exports` bucket (default 7-day expiry).

## 3. What already exists (leverage map)

| Sub-problem | Existing asset | Reuse? |
|-------------|----------------|--------|
| Admin portal shell | `src/PlatformAdminPortal.tsx` (members, prompts, docs, api keys) | Yes — add tabs |
| Mailbox chats storage | `mailbox_chats` (id, user_id, title, messages jsonb, email_id) | Yes — add admin read |
| Accounts | `organizations` (name), `org_members`, `auth.users` | Yes — join for "who" |
| Platform admin gate | `is_platform_admin(uid)`, `platform_admins` | Yes |
| Mailbox chat fn | `supabase/functions/mailbox_chat` (NDJSON event stream) | Yes — add file tool |
| Excel parsing/writing | SheetJS `xlsx` (already a dep, used in functions + frontend) | Yes — write xlsx |
| Storage + signed URLs | `email-attachments`/`reference-docs` buckets, `createSignedUrl` | Yes — add `exports` |
| Sidebar nav | `src/MainView.tsx` | Yes — add Support |

## 4. NOT in scope (deferred)

- Email / WhatsApp **notifications** to admins on new support (A2 = inbox only).
- WhatsApp **Business API** / sending messages *from* the app (we only deep-link `wa.me`).
- Real-time admin "live view" of an in-progress chat (admin sees saved transcripts only).
- Per-answer auto "Export" buttons (A3 = on-request only).
- Editing/normalizing the generated PDF layout beyond a clean default.

## 5. Architecture

### 5.1 Data model (new / changed)

```
mailbox_chats                      -- EXISTS; add admin-read RLS policy
  (id, user_id, title, messages jsonb, email_id, created_at, updated_at)

support_requests                   -- NEW
  id uuid pk
  user_id uuid -> auth.users
  org_id uuid (nullable) -> organizations   -- the chatting account
  kind text  -- 'general' | 'chat'
  message text                               -- the enquiry / "what went wrong"
  related_chat_id uuid (nullable) -> mailbox_chats(id)  -- for kind='chat'
  status text  -- 'open' | 'in_progress' | 'resolved'  (default 'open')
  admin_notes text (nullable)
  created_at, updated_at
```

RLS:
- `mailbox_chats`: keep owner full access; ADD platform-admin **SELECT** (read-only, all rows).
- `support_requests`: user can INSERT + SELECT own; platform-admin SELECT + UPDATE (status/notes) all.

Storage:
- New private bucket **`exports`** for generated Excel/PDF. Authenticated users write/read
  their own path `${user_id}/...`; signed URLs (7-day) shared via WhatsApp.

### 5.2 Admin oversight (PlatformAdminPortal)

- New **"Mailbox Chats"** tab: list every `mailbox_chats` row joined to the account
  (org name via the user's `org_members`/`organizations`, plus auth email). Columns:
  account, title, message count, last activity. Click → read-only transcript drawer
  (renders the stored `messages` with the same markdown styling, including source chips).
- Filter by account + free-text search on title.
- Admin reads via the **service-role** path (a thin `admin_list_mailbox_chats` edge function)
  OR via RLS admin-SELECT with a client join. Decision in eng review (R-A).

### 5.3 Support pipeline

- **Customer side** — new sidebar item **"Support"** (`SupportView.tsx`):
  - *General enquiry*: subject + message → insert `support_requests(kind='general')`.
  - *Chat enquiry*: dropdown of the user's saved mailbox chats + a "what went wrong"
    paragraph → insert `support_requests(kind='chat', related_chat_id)`.
  - List of the user's own past requests with status.
- **Admin side** — new **"Support"** tab in PlatformAdminPortal: table of all requests
  (account, kind, excerpt, status, date). Row → detail: full message, and for `kind='chat'`
  the **linked transcript** inline. Admin can set status + add `admin_notes`.

### 5.4 AI file generation (on request)

- Add a client tool **`make_file`** to `mailbox_chat`:
  `make_file({ format: 'xlsx'|'pdf', title, columns[], rows[][], note? })`.
  The agent calls it when the user asks ("make an excel of that", "export as PDF").
- The function:
  - **xlsx**: build with SheetJS (`XLSX.utils.aoa_to_sheet` → `XLSX.write`), upload to
    `exports/${user_id}/${uuid}.xlsx`.
  - **pdf**: build a clean tabular PDF (lib: `pdf-lib` in Deno, or fall back to a simple
    HTML→PDF). Upload similarly. (PDF generation is the main build risk — see R-C.)
  - Returns a structured **artifact** the stream emits as a new event `{t:'artifact',
    file:{name, format, signedUrl}}`.
- **Frontend**: render an **artifact card** under the answer — file name + **Download** +
  **Share via WhatsApp** (wa.me text containing the signed link).

> Alternative considered (eng review): generate the file **in the browser** (SheetJS for
> xlsx, jsPDF for pdf) from the structured `make_file` data, and only upload to `exports`
> when the user clicks "Share via WhatsApp" (to mint a link). Simpler/cheaper; avoids Deno
> PDF pain. Leaning this way — confirm in review (R-C).

### 5.5 WhatsApp sharing

- **Transcript**: "Share via WhatsApp" on a chat → format the visible messages into plain
  text (You/Cotton AI turns, trimmed) → open `https://wa.me/?text=<urlencoded>`.
  WhatsApp text has length limits (~a few thousand chars) → cap + note "transcript
  truncated" if long (R-D).
- **File**: the artifact card's WhatsApp button shares the signed `exports` link as text.

### 5.6 UI surfaces

- Sidebar (`MainView`): add **Support**. (Admin already has the portal.)
- Mailbox chat: artifact cards (download + WhatsApp), and a "Share chat" (WhatsApp) action
  in the chat header next to New/History.
- PlatformAdminPortal: **Mailbox Chats** tab + **Support** tab.

## 6. Key technical risks

- **R-A (MED) Admin read of all chats.** Cross-user read must bypass owner-RLS safely.
  Prefer a dedicated service-role edge function (`admin_*`) gated by `is_platform_admin`,
  rather than broad RLS, to avoid widening client access. Transcripts can be large (jsonb) —
  paginate the list; load transcript on demand.
- **R-B (LOW) Privacy/consent.** Admins reading full user transcripts is a deliberate choice
  (A1). Note it in any user-facing terms; keep it read-only + audited (who viewed is out of
  scope but flag it).
- **R-C (MED) PDF generation.** Deno-side PDF is the riskiest piece. Mitigation: do file
  generation client-side (SheetJS + jsPDF) from the agent's structured `make_file` output;
  upload only for WhatsApp links. Removes a server dependency.
- **R-D (LOW) WhatsApp text limits.** `wa.me?text=` truncates very long transcripts.
  Cap length; for long chats, share a link to the (file) export instead.
- **R-E (LOW) Signed-link exposure.** Anyone with the WhatsApp link can open the file for
  its lifetime. Acceptable for sharing; use a bounded expiry (7 days) and a random path.

## 7. Phased implementation

- **P0 Schema** — `support_requests` table + RLS; `mailbox_chats` admin-read; `exports` bucket.
- **P1 Admin oversight** — `admin_list_mailbox_chats` (+ get one) fn; "Mailbox Chats" tab.
- **P2 Support** — customer `SupportView` (general + chat enquiry); admin "Support" tab.
- **P3 File export** — `make_file` tool + artifact event; artifact card (download).
- **P4 WhatsApp** — transcript share + file-link share; signed-URL minting.

## 8. Open questions to confirm in review

- Admin reads via service-role edge fn (recommended) vs admin-SELECT RLS? (R-A)
- File generation client-side (recommended) vs server-side? (R-C)
- Support: do customers see admin status updates on their requests (two-way), or fire-and-
  forget? (Assumed: they see status, no replies.)
- Should "Share chat via WhatsApp" share the whole transcript or just the last answer?
  (Owner mentioned "if a user likes the last message" — maybe offer both.)

## 9. Test plan (expand in eng review)

- Admin sees chats from a *different* account; non-admin cannot hit `admin_*`.
- Support insert (both kinds) appears in admin inbox; chat enquiry links the right transcript.
- `make_file` xlsx opens in Excel; pdf renders; download works; signed link opens logged-out.
- WhatsApp deep-link opens with correct prefilled text within length cap.
- RLS: user cannot read another user's `support_requests` or `mailbox_chats`.

---

## 10. Autoplan review (subagent-only — Codex not installed)

Reviewed by four independent Claude voices (CEO, Design, Eng, DX), each reading the plan +
real code cold. Cross-voice consensus is high-confidence.

### Cross-phase themes (flagged by 2+ voices)
- **File generation server-vs-client is the central unresolved fork** (Eng: server; DX+CEO:
  client). Both are real; surfaced as a taste decision.
- **`mailbox_chats` has no `org_id`** → "which account is chatting" has no clean data path
  (Eng #1, Design #4). A user maps to 0..many orgs via `org_members`.
- **Artifact must persist as a storage PATH and re-mint the signed URL on reload**, not bake a
  7-day URL (Eng #4, Design #2, DX #2) — else History shows dead links.
- **Stream protocol is unversioned**; the NDJSON parser silently drops unknown `t` (DX #2).
- **exports bucket RLS must be path-scoped / service-role-write** (Eng #5, DX #6); cloning the
  admin-only bucket template would block user writes AND let any user read others' exports.
- **All new surfaces lack loading/empty/error/success states** (Design #2/#5/#6).

### Mandatory engineering revisions (auto-decided — P1/P3/P5)
1. **Admin reads via a service-role edge fn** (`admin_list_mailbox_chats` + `admin_get_mailbox_chat`),
   copying the `admin_create_user` 401/403 gate verbatim. **Delete the admin-SELECT-RLS
   alternative** (resolves §8a firmly). List query EXCLUDES `messages` jsonb (return
   `jsonb_array_length(messages)` as count); transcript loads on demand. Pagination contract:
   `{limit default 50/max 200, cursor on (updated_at,id) desc, nextCursor}`.
2. **Add `org_id` to `mailbox_chats`**, stamped at insert in `persistChat` (resolve the user's
   primary org once, like `admin_create_user`); fall back to `auth.email` when no org. Backfill
   existing rows.
3. **Artifact event:** add `{t:'artifact', file:{name,format,storagePath}}` to the stream + a
   `ChatMsg.artifacts[]` field; store the **path**, re-mint a signed URL on open (reuse
   `openAttachment`'s 300s pattern). Add a `default` branch that logs unknown `t`. Gate the new
   event behind a request capability flag so an old frontend never receives an unrenderable event.
4. **`make_file` real schema:** `format enum['xlsx'(,'pdf')]`, `columns[]`, row-major `rows[][]`
   (rectangular, length === columns), caps (≤5k rows/≤50 cols), `additionalProperties:false`;
   reject ragged rows with a structured `{error}` the agent can self-correct from; system-prompt
   tells it to call ONLY on explicit export/download requests. Prefer DB-parsed offer rows over
   LLM-retyped tables where possible (trust: a wrong "official" sheet is worse than wrong chat text).
5. **exports bucket:** service-role write (in the fn), SELECT scoped to
   `(storage.foldername(name))[1] = auth.uid()::text` (+ admin); WhatsApp recipients use signed
   URLs (no SELECT needed). Random UUID filenames.
6. **support_requests RLS:** user `INSERT`+`SELECT` own only (no UPDATE); admin `SELECT`+`UPDATE`.
   INSERT `WITH CHECK user_id = auth.uid()`. Admin views the linked transcript via the service-role fn.
7. **Idempotent `is_platform_admin()` migration** (it's referenced everywhere but not in tracked
   migrations; `touch_updated_at` already is). Prevents a broken `db reset`/CI.
8. **WhatsApp:** `encodeURIComponent` the WHOLE text; build the URL then measure (~2k char budget);
   truncate body with a "transcript truncated — open the file link" affordance + a preview/confirm
   sheet showing exactly what's sent; surface link expiry; pass explicit expiry to `createSignedUrl`
   (repo default is 300s, not 7 days).
9. **UI states matrix:** one row per new view × {loading, empty, error, success, partial}, reusing
   `mini-spinner`, `admin-toast`, `RED`, empty-state patterns. Includes a dangling-`related_chat_id`
   "chat no longer available" placeholder and a file-generation state machine (generating/ready/failed+retry).
10. **Admin "Mailbox Chats" UI:** master-detail (list + transcript pane) mirroring the mailbox, not a
    third drawer pattern; **account shown first** (the oversight purpose); transcript renders source
    chips via the same component as `MailboxView`.

### Open decisions → owner gate (taste + user challenges)
- **UC1 (user challenge): admin reads ALL transcripts vs consent-scoped.** CEO+Design argue blanket
  read-all is surveillance solving a support problem, with real trust risk in cotton trading (chats
  carry price/counterparty intel). Models recommend: aggregate metrics/flagging + raw reads only for
  chats attached to a support ticket or user-shared. Your A1 (full read) is the default unless changed.
- **UC2 (user challenge): WhatsApp file sharing.** CEO+Design+DX flag `wa.me` file-LINK as a degraded
  experience + leak vector (it shares a logged-out signed URL, not a file). Recommend the Tauri **OS
  share sheet** for files (shares the real file to WhatsApp/anything) and keep `wa.me` for short TEXT
  (last answer / capped transcript) only.
- **Taste: file generation** — server-side (data integrity, file sourced from DB; Eng) vs client-side
  (SheetJS/jsPDF proven in browser, avoids unproven Deno `XLSX.write`; DX/CEO).
- **Taste: PDF** — descope to **xlsx-only** for the pilot (CEO+Eng+DX) vs keep xlsx+pdf.
- **Taste: support notification** — honest fire-and-forget with status badges (your A2) vs one admin
  ping on new ticket (CEO #7).
- **Sequencing:** CEO recommends shipping **Support + xlsx-export first** (days), deferring oversight
  reshape + WhatsApp, since none of the 4 deepens core mailbox value.

## 11. Final gate decisions (owner-confirmed, 2026-06-23)

Plan APPROVED. All §10 mandatory engineering revisions stand. Gate resolutions:

- **UC1 → Read-all + view-audit log.** Keep full admin transcript read (owner's A1), but ADD:
  (a) an `admin_chat_views` audit log (admin user, chat id, viewed_at) written by the
  `admin_get_mailbox_chat` fn; (b) user-facing transcript-visibility wording before launch.
  Full visibility WITH accountability.
- **UC2 → OS share sheet for files + wa.me text.** Excel files share via the **Tauri OS share
  sheet** (shares the real file). `wa.me?text=` is for SHORT TEXT only: "share last answer" and a
  length-capped transcript. **Drop** the upload-file-to-signed-link-over-WhatsApp path (kills the
  leak-link). Build note: if a native share-sheet plugin isn't readily available on the Tauri/macOS
  target, fall back to download + "reveal in Finder"; do not regress to the wa.me file-link.
- **File gen → Server-side, xlsx-only.** Generate in the `make_file` edge tool via SheetJS
  `XLSX.write`, sourcing rows from DB-parsed offer data where possible; upload to `exports`; emit the
  artifact path. **Descope PDF.** P3 starts with a 30-min spike to confirm `XLSX.write` works in the
  Deno/esm build; if it fails, fall back to client-side SheetJS (data still sourced server-side).
- **Sequencing → Build all four now.** Implement P0–P4 in one pass (owner's call), order P0 → P1
  (admin) → P2 (support) → P3 (xlsx export) → P4 (WhatsApp/share).

### Revised phase notes
- **P0** add: `org_id` on `mailbox_chats` (+ backfill); idempotent `is_platform_admin()`; `exports`
  bucket with path-scoped SELECT + service-role write; `support_requests` with split user/admin RLS;
  `admin_chat_views` audit table.
- **P1** add: `admin_list_mailbox_chats` (count only, paginated) + `admin_get_mailbox_chat` (writes
  audit row); master-detail UI, account-first; reuse the source-chip component.
- **P3** add: real `make_file` schema (enum/rectangular/caps/structured errors) + "call only on
  explicit export" prompt; artifact event versioned behind a capability flag; `ChatMsg.artifacts[]`
  stored as path, signed URL re-minted on open; file-gen state machine (generating/ready/failed).
- **P4** add: OS share sheet for files; capped+encoded wa.me text for transcript/last-answer; per-
  message "share" as a hover action on the assistant bubble; gold styling (no WhatsApp-green fill).

Status: **DONE** — plan reviewed (subagent-only; Codex unavailable), owner gate passed, ready to build.

