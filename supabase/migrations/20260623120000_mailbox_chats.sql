-- Saved conversations for the Cotton Mailbox agent (per-user history).
CREATE TABLE IF NOT EXISTS public.mailbox_chats (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title      TEXT,
  messages   JSONB NOT NULL DEFAULT '[]'::jsonb,
  email_id   UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mailbox_chats_user ON public.mailbox_chats (user_id, updated_at DESC);

ALTER TABLE public.mailbox_chats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mailbox_chats_owner ON public.mailbox_chats;
CREATE POLICY mailbox_chats_owner ON public.mailbox_chats
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP TRIGGER IF EXISTS trg_mailbox_chats_touch ON public.mailbox_chats;
CREATE TRIGGER trg_mailbox_chats_touch BEFORE UPDATE ON public.mailbox_chats
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
