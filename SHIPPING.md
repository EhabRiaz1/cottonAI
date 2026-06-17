# Shipping Cotton AI (macOS + Supabase)

## Supabase configuration

1. **Anthropic (Edge Function `chat`)**  
   The chat function uses the Anthropic **Messages** API (streaming). Set a server-side key only (never in the Tauri or Vite client):

   ```bash
   cd /path/to/cottonAIApp
   npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-api03-...
   npx supabase secrets set ANTHROPIC_MODEL=claude-sonnet-4-5-20250929
   ```

   `ANTHROPIC_MODEL` is optional; the function defaults to a current Sonnet model id. Redeploy the function when you change model id if you need a known-good default in code; secret-only changes do not require redeploy.

2. **Market data (Edge Function `cotton_market`)**  
   Fetches **Google News RSS** (cotton query) and **Yahoo Finance** chart data for `CT=F` (ICE Cotton #2) from the Edge Function only—no client API keys. If you later add a paid provider (e.g. Polygon, Alpha Vantage), add its key as a Supabase secret and read it only inside `cotton_market` (or a split function).

3. **App client env**  
   Copy `.env.example` to `.env` and set:

   - `VITE_SUPABASE_URL` — Project URL (`https://<ref>.supabase.co`)
   - `VITE_SUPABASE_ANON_KEY` — anon / publishable key from **Settings → API**

   These are embedded in the web build; keep the repo private or use separate keys per environment.

4. **Edge Functions**  
   Deploy after linking the project with `supabase link`:

   ```bash
   npx supabase functions deploy ingest_sheet
   npx supabase functions deploy chat
   npx supabase functions deploy cotton_market
   ```

5. **Platform admin (first user)**  
   New signups are **not** auto-added to an organization. A platform admin row must exist before anyone can use org features from the “Cotton admin” UI. See [`PLATFORM_ADMIN.md`](./PLATFORM_ADMIN.md) for the one-time `INSERT INTO platform_admins` step (use your `auth.users.id`).

6. **Role model (short)**  
   - **Org members**: see **Dashboard**, **AI Chat** (org-scoped), and **Cotton AI Signals** (placeholder).  
   - **Platform admins** (in `platform_admins`): same three nav items plus **Cotton admin** (orgs, notes, workbook upload/ingest per org, add existing users via RPC, org chat listing). In **AI Chat**, an **org context** selector uses the selected org for threads and the chat Edge.  
   - Users with **no** org and **not** a platform admin see an **awaiting assignment** state until a platform admin adds them to `org_members`.

7. **Tauri CSP**  
   If your Supabase project ref changes, update `connect-src` in `src-tauri/tauri.conf.json` to your project host and Realtime `wss://` so the app can call Edge Functions and Supabase from the native shell.

## macOS app build

Prerequisites: stable Rust toolchain, Xcode command line tools, Node 20+.

```bash
npm install
npm run build
npx tauri build
```

Artifacts (typical paths):

- `src-tauri/target/release/bundle/dmg/*.dmg`
- `src-tauri/target/release/macos/*.app`

## Code signing and notarization (distribution)

1. Enroll in the Apple Developer Program and create signing certificates (Developer ID Application).
2. In `src-tauri/tauri.conf.json` (or `tauri.*.conf`), configure signing identity and hardened runtime per [Tauri signing](https://v2.tauri.app/distribute/sign-macos/).
3. Notarize with `xcrun notarytool` or `tauri signer`; staple the ticket to the `.app` / `.dmg`.

Use a clean machine or CI to verify Gatekeeper acceptance after notarization.

## Smoke test

1. **Bootstrap** — Insert the first `platform_admins` row; sign in as that user and create an org, add a member (existing user) by email, optional notes.
2. **Member** — Sign in as a user assigned to that org. Open **Dashboard** (news + futures load via `cotton_market`); use **AI Chat** with an uploaded workbook after platform admin **ingest** from the admin portal.
3. **Ingest** — From **Cotton admin**, select org → upload `.xlsx` → confirm ingest success; then ask a sheet-grounded question in chat.

**Disclaimer** — Chat and market cards are for **informational** use only, not financial advice. Delayed or aggregated data is subject to provider ToS.
