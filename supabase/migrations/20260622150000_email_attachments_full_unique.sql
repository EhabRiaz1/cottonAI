-- Partial unique indexes cannot be used as an ON CONFLICT target via PostgREST,
-- which made the attachment upsert silently fail. content_hash is always set on
-- real ingests, so a full unique index is safe and resolves the upsert.
DROP INDEX IF EXISTS public.uq_email_attachments_email_hash;
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_attachments_email_hash
  ON public.email_attachments (email_id, content_hash);
