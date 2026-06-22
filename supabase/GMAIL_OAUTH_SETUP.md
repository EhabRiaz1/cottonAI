# Gmail mailbox connection — one-time OAuth setup

The mailbox sync reads `cottonai@ysgroup.pk` over the Gmail API using a **single-mailbox
OAuth refresh token** (scope `gmail.readonly`). This is NOT domain-wide delegation — it
grants access only to the one mailbox that clicks "Allow". You do this once.

## 1. Create an OAuth client (Google Cloud Console)

1. Go to <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Library →** enable **Gmail API**.
3. **APIs & Services → OAuth consent screen:**
   - User type: **Internal** (since the mailbox is in your Google Workspace).
   - App name / support email: anything; add `cottonai@ysgroup.pk` as a test user if asked.
   - Scope: add `https://www.googleapis.com/auth/gmail.readonly`.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID:**
   - Application type: **Desktop app**.
   - Download the client — note the **Client ID** and **Client secret**.

## 2. Mint a refresh token (signed in AS the mailbox)

Run the helper script below **and sign in with `cottonai@ysgroup.pk`** when the browser
opens. It prints a `GMAIL_REFRESH_TOKEN`.

```bash
node supabase/scripts/gmail_get_refresh_token.mjs <CLIENT_ID> <CLIENT_SECRET>
```

(The script uses the OOB/loopback flow — it starts a tiny local server, opens the consent
URL, captures the code, and exchanges it for a refresh token. Nothing is sent anywhere
except Google.)

## 3. Set the Edge Function secrets

In Supabase Dashboard → Edge Functions → Secrets (or `supabase secrets set ...`):

```
MAILBOX_EMAIL=cottonai@ysgroup.pk
MAILBOX_SYNC_SECRET=<random 32+ char string you generate>
GMAIL_CLIENT_ID=<from step 1>
GMAIL_CLIENT_SECRET=<from step 1>
GMAIL_REFRESH_TOKEN=<from step 2>
```

`ANTHROPIC_API_KEY` is already configured (used by chat + extraction).

## 4. Deploy the functions

```bash
supabase functions deploy mailbox_sync
supabase functions deploy extract_offers
supabase functions deploy chat
```

## 5. First sync (backfill, capped to recent ~90 days)

Trigger a backfill, then run extraction. Repeat until `remaining` is 0 / `hasMore` is false
(the admin "Sync now" button does this loop for you once the UI is wired):

```bash
SYNC_SECRET=<MAILBOX_SYNC_SECRET>
URL=https://kvixqlpjmqwmoiuxizuz.supabase.co/functions/v1

curl -s -X POST "$URL/mailbox_sync" -H "x-sync-secret: $SYNC_SECRET" \
  -H 'content-type: application/json' -d '{"trigger":"backfill","backfillDays":90}'

curl -s -X POST "$URL/extract_offers" -H "x-sync-secret: $SYNC_SECRET" \
  -H 'content-type: application/json' -d '{}'
```

## 6. (Optional) Schedule recurring sync with pg_cron

Once it works manually, schedule it server-side so it syncs even when the app is closed.
Store the secret in Vault and call the functions via `pg_net` (run in the SQL editor):

```sql
-- enable once
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- hourly: sync new mail, then extract
select cron.schedule('mailbox_sync_hourly', '0 * * * *', $$
  select net.http_post(
    url := 'https://kvixqlpjmqwmoiuxizuz.supabase.co/functions/v1/mailbox_sync',
    headers := jsonb_build_object('content-type','application/json','x-sync-secret', '<MAILBOX_SYNC_SECRET>'),
    body := jsonb_build_object('trigger','scheduled')
  );
$$);

select cron.schedule('extract_offers_hourly', '5 * * * *', $$
  select net.http_post(
    url := 'https://kvixqlpjmqwmoiuxizuz.supabase.co/functions/v1/extract_offers',
    headers := jsonb_build_object('content-type','application/json','x-sync-secret', '<MAILBOX_SYNC_SECRET>'),
    body := '{}'::jsonb
  );
$$);
```
