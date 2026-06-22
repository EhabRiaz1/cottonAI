-- Private Storage buckets for the mailbox feature.
-- email-attachments: raw PDFs/Excel pulled from emails (source-of-truth for re-extraction).
-- reference-docs:    owner-supplied cotton grounding docs (D13).
INSERT INTO storage.buckets (id, name, public)
VALUES ('email-attachments','email-attachments', false)
ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public)
VALUES ('reference-docs','reference-docs', false)
ON CONFLICT (id) DO NOTHING;

-- Reads: any authenticated user (global pool). Writes: platform admins from the
-- client; the service role (sync/extraction Edge Functions) bypasses RLS entirely.
DO $sp$
DECLARE b TEXT;
BEGIN
  FOREACH b IN ARRAY ARRAY['email-attachments','reference-docs'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects;', 'sel_'||replace(b,'-','_'));
    EXECUTE format($p$
      CREATE POLICY %1$I ON storage.objects
        FOR SELECT TO authenticated
        USING (bucket_id = %2$L AND auth.uid() IS NOT NULL);
    $p$, 'sel_'||replace(b,'-','_'), b);

    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects;', 'ins_'||replace(b,'-','_'));
    EXECUTE format($p$
      CREATE POLICY %1$I ON storage.objects
        FOR INSERT TO authenticated
        WITH CHECK (bucket_id = %2$L AND public.is_platform_admin(auth.uid()));
    $p$, 'ins_'||replace(b,'-','_'), b);

    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects;', 'upd_'||replace(b,'-','_'));
    EXECUTE format($p$
      CREATE POLICY %1$I ON storage.objects
        FOR UPDATE TO authenticated
        USING (bucket_id = %2$L AND public.is_platform_admin(auth.uid()))
        WITH CHECK (bucket_id = %2$L AND public.is_platform_admin(auth.uid()));
    $p$, 'upd_'||replace(b,'-','_'), b);

    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects;', 'del_'||replace(b,'-','_'));
    EXECUTE format($p$
      CREATE POLICY %1$I ON storage.objects
        FOR DELETE TO authenticated
        USING (bucket_id = %2$L AND public.is_platform_admin(auth.uid()));
    $p$, 'del_'||replace(b,'-','_'), b);
  END LOOP;
END$sp$;
