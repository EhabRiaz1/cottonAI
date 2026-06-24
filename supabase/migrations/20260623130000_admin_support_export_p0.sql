-- P0 foundations for admin oversight, support pipeline, file export.

-- Idempotent is_platform_admin (exists in live DB; defined here for fresh db reset/CI).
CREATE OR REPLACE FUNCTION public.is_platform_admin(uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  select exists (select 1 from public.platform_admins p where p.user_id = uid);
$fn$;

-- 1. mailbox_chats: stamp the chatting account, backfill existing rows.
ALTER TABLE public.mailbox_chats
  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL;
UPDATE public.mailbox_chats mc
  SET org_id = (SELECT om.org_id FROM public.org_members om WHERE om.user_id = mc.user_id ORDER BY om.created_at LIMIT 1)
  WHERE mc.org_id IS NULL;
-- Admins read all mailbox chats only via the service-role edge fn; no broad RLS added here.

-- 2. support_requests — customer enquiries (general + flag-a-chat).
CREATE TABLE IF NOT EXISTS public.support_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id          UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('general', 'chat')),
  message         TEXT NOT NULL,
  related_chat_id UUID REFERENCES public.mailbox_chats(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
  admin_notes     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_requests_user ON public.support_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_requests_status ON public.support_requests (status, created_at DESC);
ALTER TABLE public.support_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS support_requests_user_select ON public.support_requests;
CREATE POLICY support_requests_user_select ON public.support_requests
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS support_requests_user_insert ON public.support_requests;
CREATE POLICY support_requests_user_insert ON public.support_requests
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS support_requests_admin_select ON public.support_requests;
CREATE POLICY support_requests_admin_select ON public.support_requests
  FOR SELECT TO authenticated USING (public.is_platform_admin(auth.uid()));
DROP POLICY IF EXISTS support_requests_admin_update ON public.support_requests;
CREATE POLICY support_requests_admin_update ON public.support_requests
  FOR UPDATE TO authenticated USING (public.is_platform_admin(auth.uid())) WITH CHECK (public.is_platform_admin(auth.uid()));

DROP TRIGGER IF EXISTS trg_support_requests_touch ON public.support_requests;
CREATE TRIGGER trg_support_requests_touch BEFORE UPDATE ON public.support_requests
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 3. admin_chat_views — audit log of which admin viewed which transcript (UC1).
CREATE TABLE IF NOT EXISTS public.admin_chat_views (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  chat_id       UUID NOT NULL REFERENCES public.mailbox_chats(id) ON DELETE CASCADE,
  viewed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_chat_views_chat ON public.admin_chat_views (chat_id, viewed_at DESC);
ALTER TABLE public.admin_chat_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_chat_views_admin_select ON public.admin_chat_views;
CREATE POLICY admin_chat_views_admin_select ON public.admin_chat_views
  FOR SELECT TO authenticated USING (public.is_platform_admin(auth.uid()));
-- writes happen via the service role (audit fn), which bypasses RLS.

-- 4. exports bucket — generated xlsx files; service-role write, owner/admin read.
INSERT INTO storage.buckets (id, name, public) VALUES ('exports','exports', false)
  ON CONFLICT (id) DO NOTHING;
DROP POLICY IF EXISTS exports_owner_select ON storage.objects;
CREATE POLICY exports_owner_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'exports'
    AND ((storage.foldername(name))[1] = auth.uid()::text OR public.is_platform_admin(auth.uid())));
-- No client INSERT/UPDATE/DELETE: the make_file edge fn writes with the service role.
