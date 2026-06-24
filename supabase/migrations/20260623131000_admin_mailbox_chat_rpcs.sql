-- Admin oversight via self-gating SECURITY DEFINER RPCs (check is_platform_admin
-- inside; do NOT widen RLS). List excludes the heavy messages jsonb.

CREATE OR REPLACE FUNCTION public.admin_list_mailbox_chats(p_limit int DEFAULT 50, p_offset int DEFAULT 0)
RETURNS TABLE (id uuid, title text, org_name text, user_email text, msg_count int, updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  RETURN QUERY
    SELECT mc.id, mc.title, o.name AS org_name, u.email::text AS user_email,
           COALESCE(jsonb_array_length(mc.messages), 0) AS msg_count, mc.updated_at
    FROM public.mailbox_chats mc
    LEFT JOIN public.organizations o ON o.id = mc.org_id
    LEFT JOIN auth.users u ON u.id = mc.user_id
    ORDER BY mc.updated_at DESC
    LIMIT LEAST(GREATEST(p_limit, 1), 200) OFFSET GREATEST(p_offset, 0);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.admin_get_mailbox_chat(p_chat_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_msgs jsonb; v_title text; v_org text; v_email text; v_updated timestamptz; v_found boolean;
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  SELECT mc.messages, mc.title, o.name, u.email::text, mc.updated_at, true
    INTO v_msgs, v_title, v_org, v_email, v_updated, v_found
    FROM public.mailbox_chats mc
    LEFT JOIN public.organizations o ON o.id = mc.org_id
    LEFT JOIN auth.users u ON u.id = mc.user_id
    WHERE mc.id = p_chat_id;
  IF NOT COALESCE(v_found, false) THEN
    RETURN jsonb_build_object('error', 'not found');
  END IF;
  INSERT INTO public.admin_chat_views (admin_user_id, chat_id) VALUES (auth.uid(), p_chat_id);
  RETURN jsonb_build_object('id', p_chat_id, 'title', v_title, 'org_name', v_org,
    'user_email', v_email, 'updated_at', v_updated, 'messages', COALESCE(v_msgs, '[]'::jsonb));
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_list_mailbox_chats(int, int) FROM public, anon;
REVOKE ALL ON FUNCTION public.admin_get_mailbox_chat(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_mailbox_chats(int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_mailbox_chat(uuid) TO authenticated;
