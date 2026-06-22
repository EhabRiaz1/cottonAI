# Supabase Edge Function Secrets Setup

## Required Secrets

The following secrets must be configured in your Supabase project for the AI chat functionality to work:

### 1. ANTHROPIC_API_KEY (Required)

This is your Claude API key from Anthropic.

**To set up:**

1. Go to [Anthropic Console](https://console.anthropic.com/)
2. Create an API key
3. In Supabase Dashboard:
   - Navigate to **Edge Functions** → **Secrets**
   - Click **Add new secret**
   - Name: `ANTHROPIC_API_KEY`
   - Value: Your API key (starts with `sk-ant-...`)

### 2. ANTHROPIC_MODEL (Optional)

Specifies which Claude model to use. Defaults to `claude-sonnet-4-5-20250929`.

**Options:**
- `claude-sonnet-4-5-20250929` (default, recommended)
- `claude-3-5-sonnet-20241022`
- `claude-3-opus-20240229`

**To set:**
- Name: `ANTHROPIC_MODEL`
- Value: Model name string

## Mailbox / Cotton-Offer Ingestion Secrets

These power the `cottonai@ysgroup.pk` mailbox sync + extraction (see
`GMAIL_COTTON_INTEGRATION_PLAN.md`). None of these ever ship in the frontend or the
Tauri binary — they live only as Edge Function secrets, read server-side via
`Deno.env.get`.

### Always required

| Secret | Purpose |
|--------|---------|
| `MAILBOX_EMAIL` | The mailbox to read, e.g. `cottonai@ysgroup.pk`. |
| `MAILBOX_SYNC_SECRET` | Shared bearer token the app/cron sends to trigger a sync, so only authorized callers can kick the privileged sync function. Generate a random 32+ char string. |

### Transport: Gmail API over HTTPS (recommended — runs in Edge Functions, syncs even when the app is closed)

| Secret | Purpose |
|--------|---------|
| `GMAIL_CLIENT_ID` | OAuth client ID (Google Cloud → APIs & Services → Credentials, Desktop/Web client). |
| `GMAIL_CLIENT_SECRET` | OAuth client secret for the same client. |
| `GMAIL_REFRESH_TOKEN` | One-time refresh token for **just this mailbox** (`gmail.readonly` scope). Generated once via the OAuth consent flow; NOT domain-wide delegation. |

### Transport: IMAP App Password (fallback — requires a Rust/Tauri or always-on worker, since Edge can't open IMAP TCP)

| Secret | Purpose |
|--------|---------|
| `MAILBOX_IMAP_HOST` | `imap.gmail.com` |
| `MAILBOX_IMAP_PORT` | `993` |
| `MAILBOX_APP_PASSWORD` | Google Workspace App Password (16 chars). Stored in the OS keychain on the desktop side, not in config. |

> Transport choice is pending owner confirmation. The recommendation is the Gmail API
> path: zero new infrastructure, server-side scheduling, and correct blast radius
> (single mailbox, not domain-wide). I will fill in the exact setup walkthrough once
> the transport is locked.

### Storage buckets (created by migration `20260622093500_mailbox_storage_buckets.sql`)

- `email-attachments` (private) — raw PDFs/Excel pulled from emails.
- `reference-docs` (private) — owner-supplied cotton grounding docs (D13).

## Verification

After setting the secrets:

1. Redeploy your Edge Functions:
   ```bash
   supabase functions deploy chat
   supabase functions deploy cotton_market
   supabase functions deploy ingest_sheet
   ```

2. Test the chat function by sending a message in the app

## Troubleshooting

If you see "ANTHROPIC_API_KEY not configured" error:
- Verify the secret name is exactly `ANTHROPIC_API_KEY`
- Redeploy the `chat` function after adding the secret
- Check the Edge Function logs in Supabase Dashboard
