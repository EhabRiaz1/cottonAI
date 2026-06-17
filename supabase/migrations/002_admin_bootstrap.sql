-- Admin Bootstrap Script
-- Run this in Supabase SQL Editor to set up admin access
-- 
-- IMPORTANT: First, sign up in the app with your email, then run this script

-- ============================================
-- STEP 1: Find your user UUID
-- ============================================
-- Run this query first to find your user ID:
-- 
-- SELECT id, email, created_at FROM auth.users ORDER BY created_at DESC LIMIT 10;

-- ============================================
-- STEP 2: Make yourself a platform admin
-- ============================================
-- Replace 'YOUR_USER_UUID_HERE' with your actual UUID from Step 1

INSERT INTO public.platform_admins (user_id)
VALUES ('YOUR_USER_UUID_HERE')
ON CONFLICT (user_id) DO NOTHING;

-- ============================================
-- STEP 3: Create a test organization
-- ============================================

INSERT INTO public.organizations (id, name, notes, account_type, subscription_tier)
VALUES (
  gen_random_uuid(),
  'Cotton AI Demo',
  'Demo organization for testing and development',
  'organization',
  'pilot'
)
RETURNING id, name;

-- ============================================
-- STEP 4: Add yourself as org admin
-- ============================================
-- Replace 'ORG_UUID_FROM_STEP_3' with the id returned from Step 3
-- Replace 'YOUR_USER_UUID_HERE' with your UUID from Step 1

INSERT INTO public.org_members (org_id, user_id, role)
VALUES (
  'ORG_UUID_FROM_STEP_3',
  'YOUR_USER_UUID_HERE',
  'admin'
)
ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'admin';

-- ============================================
-- QUICK SETUP (All-in-one)
-- ============================================
-- If you want to run everything at once with a specific email:
-- Replace 'your-email@example.com' with your email

/*
DO $$
DECLARE
  v_user_id UUID;
  v_org_id UUID;
BEGIN
  -- Get user ID by email
  SELECT id INTO v_user_id 
  FROM auth.users 
  WHERE email = 'your-email@example.com';
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not found. Please sign up first.';
  END IF;
  
  -- Make platform admin
  INSERT INTO public.platform_admins (user_id)
  VALUES (v_user_id)
  ON CONFLICT (user_id) DO NOTHING;
  
  -- Create organization
  INSERT INTO public.organizations (name, notes, account_type, subscription_tier)
  VALUES ('Cotton AI Demo', 'Demo organization', 'organization', 'pilot')
  RETURNING id INTO v_org_id;
  
  -- Add as org admin
  INSERT INTO public.org_members (org_id, user_id, role)
  VALUES (v_org_id, v_user_id, 'admin')
  ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'admin';
  
  RAISE NOTICE 'Setup complete! User: %, Org: %', v_user_id, v_org_id;
END $$;
*/

-- ============================================
-- VERIFY SETUP
-- ============================================
-- Run these queries to verify everything is set up:

-- Check platform admins:
-- SELECT pa.*, u.email FROM public.platform_admins pa 
-- JOIN auth.users u ON u.id = pa.user_id;

-- Check organizations:
-- SELECT * FROM public.organizations;

-- Check org members:
-- SELECT om.*, u.email, o.name as org_name 
-- FROM public.org_members om
-- JOIN auth.users u ON u.id = om.user_id
-- JOIN public.organizations o ON o.id = om.org_id;
