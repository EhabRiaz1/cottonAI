-- Migration: Mailbox-connected cotton offer intelligence — P0 foundations
-- See GMAIL_COTTON_INTEGRATION_PLAN.md (§5 data model, §10 schema hardening).
--
-- Global shared pool (D4): all new tables are readable by ANY authenticated user.
-- Writes are restricted to the service role (sync/extraction Edge Functions, which
-- bypass RLS) and platform admins. `org_id` is nullable on every table as cheap
-- future-isolation insurance (§10.3).
--
-- Idempotency is enforced in the database via generated fingerprint columns so the
-- extractor cannot accidentally create duplicate rows on re-sync / D10 re-decode.

-- ---------------------------------------------------------------------------
-- 0. Extensions (Supabase installs these into the `extensions` schema)
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;   -- digest() for fingerprints
CREATE EXTENSION IF NOT EXISTS pg_trgm  WITH SCHEMA extensions;   -- fuzzy grade/free-text search

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cotton_price_type') THEN
    CREATE TYPE public.cotton_price_type AS ENUM ('on_call', 'outright', 'none');
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 2. mailbox_state — incremental-sync bookkeeping (one row per mailbox).
--    Holds NO credentials; the App Password / OAuth token live in Edge secrets.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mailbox_state (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  mailbox_email   TEXT NOT NULL UNIQUE,          -- e.g. cottonai@ysgroup.pk
  last_seen_uid   TEXT,                          -- IMAP: highest UID fetched
  uidvalidity     TEXT,                          -- IMAP: mismatch -> full re-scan
  last_history_id TEXT,                          -- Gmail API: incremental cursor
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 3. reference_documents — owner-supplied cotton grounding docs (D13).
--    Injected (with prompt caching) into BOTH extraction and chat prompts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reference_documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  kind              TEXT NOT NULL DEFAULT 'glossary'
                      CHECK (kind IN ('glossary', 'decoder', 'notes', 'other')),
  storage_path      TEXT,                        -- bucket: reference-docs
  original_filename TEXT,
  file_type         TEXT,
  file_size_bytes   BIGINT,
  parsed_content    TEXT,                        -- text used as grounding context
  decode_version    INT NOT NULL DEFAULT 1,      -- bumps when grounding set changes
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reference_documents_active
  ON public.reference_documents (is_active) WHERE is_active = true;

-- ---------------------------------------------------------------------------
-- 4. email_messages — one row per ingested email.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  mailbox_email   TEXT,                          -- which mailbox this came from
  imap_uid        TEXT,                          -- per-mailbox unique (IMAP path)
  gmail_message_id TEXT,                         -- Gmail API id (HTTPS path)
  rfc_message_id  TEXT UNIQUE,                   -- de-dup across re-syncs
  from_address    TEXT,
  from_name       TEXT,
  subject         TEXT,
  date_sent       TIMESTAMPTZ,
  date_ingested   TIMESTAMPTZ NOT NULL DEFAULT now(),
  snippet         TEXT,
  broker_guess    TEXT,
  has_attachments BOOLEAN NOT NULL DEFAULT false,
  body_text       TEXT,
  sync_status     TEXT NOT NULL DEFAULT 'fetched'
                    CHECK (sync_status IN ('fetched', 'extracted', 'error')),
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_messages_date_sent ON public.email_messages (date_sent DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_sync_status ON public.email_messages (sync_status);
CREATE INDEX IF NOT EXISTS idx_email_messages_from ON public.email_messages (from_address);

-- ---------------------------------------------------------------------------
-- 5. email_attachments — files pulled from emails (PDF/Excel/other).
--    content_hash makes re-sync idempotent even if rfc_message_id changes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_attachments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  email_id          UUID NOT NULL REFERENCES public.email_messages(id) ON DELETE CASCADE,
  filename          TEXT,
  mime_type         TEXT,
  kind              TEXT NOT NULL DEFAULT 'other'
                      CHECK (kind IN ('pdf', 'excel', 'other')),
  storage_path      TEXT,                        -- bucket: email-attachments
  size_bytes        BIGINT,
  content_hash      TEXT,                        -- sha256 of file bytes
  extraction_status TEXT NOT NULL DEFAULT 'pending'
                      CHECK (extraction_status IN ('pending', 'done', 'error', 'unsupported')),
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_attachments_email ON public.email_attachments (email_id);
CREATE INDEX IF NOT EXISTS idx_email_attachments_status ON public.email_attachments (extraction_status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_attachments_email_hash
  ON public.email_attachments (email_id, content_hash) WHERE content_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. cotton_offers — one row per offer line. MOST FIELDS NULLABLE (D9).
--    offer_fingerprint (generated) gives ON CONFLICT idempotency for
--    re-extraction and D10 re-decode without duplicate rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cotton_offers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  source_email_id       UUID NOT NULL REFERENCES public.email_messages(id) ON DELETE CASCADE,
  source_attachment_id  UUID REFERENCES public.email_attachments(id) ON DELETE CASCADE, -- null = body-text offer
  line_index            INT NOT NULL DEFAULT 0, -- stable position within the source doc

  broker                TEXT,
  origin_country        TEXT,
  region                TEXT,
  certifications        TEXT[],
  grade_raw             TEXT,
  color                 INT,
  leaf                  INT,
  staple_32nds          INT,
  staple_fraction       TEXT,
  mic                   NUMERIC,
  gpt                   NUMERIC,
  length                NUMERIC,
  uniformity            NUMERIC,
  quantity_bales        INT,
  price_type            public.cotton_price_type NOT NULL DEFAULT 'none',
  price_basis_points    NUMERIC,    -- on-call basis, e.g. 1700
  price_outright_cents  NUMERIC,    -- outright c/lb, e.g. 85.50
  futures_month         TEXT,       -- e.g. Dec'26
  crop_year             TEXT,       -- e.g. 2025/26
  shipment_period       TEXT,
  recap_code            TEXT,       -- join key to cotton_recaps
  raw_line_text         TEXT,       -- verbatim source line, for audit + re-decode
  offer_date            DATE,

  confidence            NUMERIC,    -- 0..1 extractor confidence
  needs_review          BOOLEAN NOT NULL DEFAULT false,
  decode_version        INT NOT NULL DEFAULT 1,  -- which reference-doc set produced this
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Deterministic idempotency key. Attachment offers key on attachment+line+text;
  -- body-text offers fall back to the email id. See §10.3.
  offer_fingerprint     TEXT GENERATED ALWAYS AS (
    encode(extensions.digest(
      coalesce(source_attachment_id::text, source_email_id::text)
        || '|' || line_index::text
        || '|' || coalesce(raw_line_text, ''),
      'sha256'), 'hex')
  ) STORED
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cotton_offers_fingerprint
  ON public.cotton_offers (offer_fingerprint);

-- Search/filter indexes (§10.3)
CREATE INDEX IF NOT EXISTS idx_cotton_offers_certs       ON public.cotton_offers USING gin (certifications);
CREATE INDEX IF NOT EXISTS idx_cotton_offers_offer_date  ON public.cotton_offers (offer_date DESC);
CREATE INDEX IF NOT EXISTS idx_cotton_offers_origin      ON public.cotton_offers (origin_country);
CREATE INDEX IF NOT EXISTS idx_cotton_offers_crop_year   ON public.cotton_offers (crop_year);
CREATE INDEX IF NOT EXISTS idx_cotton_offers_broker      ON public.cotton_offers (broker);
CREATE INDEX IF NOT EXISTS idx_cotton_offers_mic         ON public.cotton_offers (mic);
CREATE INDEX IF NOT EXISTS idx_cotton_offers_staple      ON public.cotton_offers (staple_32nds);
CREATE INDEX IF NOT EXISTS idx_cotton_offers_gpt         ON public.cotton_offers (gpt);
CREATE INDEX IF NOT EXISTS idx_cotton_offers_price_out   ON public.cotton_offers (price_outright_cents);
CREATE INDEX IF NOT EXISTS idx_cotton_offers_price_basis ON public.cotton_offers (price_basis_points);
CREATE INDEX IF NOT EXISTS idx_cotton_offers_qty         ON public.cotton_offers (quantity_bales);
CREATE INDEX IF NOT EXISTS idx_cotton_offers_recap       ON public.cotton_offers (recap_code);
CREATE INDEX IF NOT EXISTS idx_cotton_offers_needs_review ON public.cotton_offers (needs_review) WHERE needs_review = true;
-- Grades are written inconsistently across brokers -> trigram fuzzy match
CREATE INDEX IF NOT EXISTS idx_cotton_offers_grade_trgm
  ON public.cotton_offers USING gin (grade_raw extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_cotton_offers_rawline_trgm
  ON public.cotton_offers USING gin (raw_line_text extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 7. cotton_recaps — deep quality-distribution PDFs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cotton_recaps (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  recap_code            TEXT,
  broker                TEXT,
  source_email_id       UUID REFERENCES public.email_messages(id) ON DELETE CASCADE,
  source_attachment_id  UUID REFERENCES public.email_attachments(id) ON DELETE CASCADE,
  crop_year             TEXT,
  total_bales           INT,
  avg_mic               NUMERIC,
  avg_staple            NUMERIC,
  avg_gpt               NUMERIC,
  avg_length            NUMERIC,
  avg_uniformity        NUMERIC,
  distributions         JSONB,      -- color/leaf/staple/mic/gpt/length/unif matrices
  raw_text              TEXT,
  confidence            NUMERIC,
  needs_review          BOOLEAN NOT NULL DEFAULT false,
  decode_version        INT NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  recap_fingerprint     TEXT GENERATED ALWAYS AS (
    encode(extensions.digest(
      coalesce(source_attachment_id::text, source_email_id::text)
        || '|' || coalesce(recap_code, ''),
      'sha256'), 'hex')
  ) STORED
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cotton_recaps_fingerprint
  ON public.cotton_recaps (recap_fingerprint);
CREATE INDEX IF NOT EXISTS idx_cotton_recaps_code   ON public.cotton_recaps (recap_code);
CREATE INDEX IF NOT EXISTS idx_cotton_recaps_broker ON public.cotton_recaps (broker);

-- ---------------------------------------------------------------------------
-- 8. sync_runs — one row per sync invocation (status panel + audit).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sync_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  mailbox_email    TEXT,
  trigger          TEXT NOT NULL DEFAULT 'manual'
                     CHECK (trigger IN ('manual', 'scheduled', 'backfill')),
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  emails_seen      INT NOT NULL DEFAULT 0,
  emails_new       INT NOT NULL DEFAULT 0,
  attachments_new  INT NOT NULL DEFAULT 0,
  offers_extracted INT NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running', 'success', 'error')),
  error_message    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON public.sync_runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- 9. updated_at touch trigger (reuse for state + reference docs)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS trg_mailbox_state_touch ON public.mailbox_state;
CREATE TRIGGER trg_mailbox_state_touch BEFORE UPDATE ON public.mailbox_state
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_reference_documents_touch ON public.reference_documents;
CREATE TRIGGER trg_reference_documents_touch BEFORE UPDATE ON public.reference_documents
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 10. RLS — global read pool (D4); writes only service role (RLS bypass) + admins.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'mailbox_state','reference_documents','email_messages','email_attachments',
    'cotton_offers','cotton_recaps','sync_runs'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);

    -- Any authenticated user may read (global shared pool).
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;', t || '_select_authenticated', t);
    EXECUTE format($p$
      CREATE POLICY %1$I ON public.%2$I
        FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);
    $p$, t || '_select_authenticated', t);

    -- Platform admins may write from the client; the service role bypasses RLS.
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;', t || '_admin_all', t);
    EXECUTE format($p$
      CREATE POLICY %1$I ON public.%2$I
        FOR ALL TO authenticated
        USING (public.is_platform_admin(auth.uid()))
        WITH CHECK (public.is_platform_admin(auth.uid()));
    $p$, t || '_admin_all', t);
  END LOOP;
END$$;
