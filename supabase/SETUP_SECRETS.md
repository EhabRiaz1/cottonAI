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
