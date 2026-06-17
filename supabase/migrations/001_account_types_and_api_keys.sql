-- Migration: Add account_type to organizations and create api_keys table
-- Run this in Supabase SQL Editor

-- 1. Add account_type column to organizations table
ALTER TABLE public.organizations 
ADD COLUMN IF NOT EXISTS account_type TEXT DEFAULT 'organization' 
CHECK (account_type IN ('organization', 'individual'));

COMMENT ON COLUMN public.organizations.account_type IS 'Type of account: organization (company/team) or individual (personal)';

-- 2. Create api_keys table for future extensibility
CREATE TABLE IF NOT EXISTS public.api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL, -- First 8 chars for identification (e.g., "cai_abc1")
  name TEXT,
  scopes TEXT[] DEFAULT ARRAY['read']::TEXT[], -- Permissions: read, write, admin
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES auth.users(id)
);

-- Indexes for api_keys
CREATE INDEX IF NOT EXISTS idx_api_keys_org_id ON public.api_keys(org_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON public.api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON public.api_keys(is_active) WHERE is_active = true;

-- Enable RLS on api_keys
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

-- RLS policies for api_keys
CREATE POLICY "Platform admins can manage all api_keys" ON public.api_keys
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.platform_admins pa 
      WHERE pa.user_id = auth.uid()
    )
  );

CREATE POLICY "Org admins can manage their org api_keys" ON public.api_keys
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om 
      WHERE om.org_id = api_keys.org_id 
      AND om.user_id = auth.uid() 
      AND om.role = 'admin'
    )
  );

CREATE POLICY "Org members can view their org api_keys" ON public.api_keys
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om 
      WHERE om.org_id = api_keys.org_id 
      AND om.user_id = auth.uid()
    )
  );

-- 3. Add subscription_tier to organizations for future pricing tiers
ALTER TABLE public.organizations 
ADD COLUMN IF NOT EXISTS subscription_tier TEXT DEFAULT 'pilot' 
CHECK (subscription_tier IN ('pilot', 'pro', 'enterprise'));

COMMENT ON COLUMN public.organizations.subscription_tier IS 'Subscription tier: pilot (free trial), pro, enterprise';

-- 4. Add logo_url and settings JSONB to organizations
ALTER TABLE public.organizations 
ADD COLUMN IF NOT EXISTS logo_url TEXT,
ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'::JSONB;

COMMENT ON COLUMN public.organizations.settings IS 'Organization-specific settings and preferences';
