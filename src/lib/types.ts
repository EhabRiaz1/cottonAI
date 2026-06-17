import type { User } from "@supabase/supabase-js";

export type MemberRole = "admin" | "member";
export type AccountType = "organization" | "individual";
export type SubscriptionTier = "pilot" | "pro" | "enterprise";

export type Org = {
  id: string;
  name: string;
  email: string | null;
  notes: string | null;
  account_type: AccountType;
  subscription_tier: SubscriptionTier;
  logo_url: string | null;
  settings: Record<string, unknown>;
  custom_system_prompt: string | null;
  password_must_change: boolean;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
};

export type OrgDocument = {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  storage_path: string;
  original_filename: string;
  file_type: string | null;
  file_size_bytes: number | null;
  parsed_content: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type SystemPrompt = {
  id: string;
  org_id: string | null;
  name: string;
  prompt_text: string;
  is_default: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type ApiKey = {
  id: string;
  org_id: string;
  key_prefix: string;
  name: string | null;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  is_active: boolean;
};

export type OrgMember = {
  org_id: string;
  user_id: string;
  role: MemberRole;
};

export type ParseStatus = "pending" | "ready" | "error";

export type OrgSheet = {
  id: string;
  org_id: string;
  storage_path: string;
  original_filename: string;
  parse_status: ParseStatus;
  error_message: string | null;
  parsed: unknown;
  summary_text: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type Chat = {
  id: string;
  org_id: string;
  user_id: string;
  org_sheet_id: string | null;
  title: string;
  created_at: string;
  updated_at: string;
};

export type MessageRow = {
  id: number;
  chat_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata: unknown;
  created_at: string;
};

export type SessionContext = {
  user: User;
  org: Org;
  member: OrgMember;
};

export type SignalType = "fix" | "hedge" | "wait" | "alert";

export type SignalData = {
  type: SignalType;
  confidence: number;
  title: string;
  fields: { label: string; value: string; highlight?: boolean }[];
  recommendation?: string;
  timestamp?: string;
};
