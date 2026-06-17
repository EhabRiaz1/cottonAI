import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.0";

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: cors });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const { data: isPA } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!isPA) {
    return new Response(JSON.stringify({ error: "Admin access required" }), {
      status: 403,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  type Body = { email: string; password: string; orgName: string; notes?: string };
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (!body.email || !body.password || !body.orgName) {
    return new Response(
      JSON.stringify({ error: "email, password, and orgName required" }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,
    user_metadata: { org_account: true },
  });

  if (authError) {
    return new Response(JSON.stringify({ error: authError.message }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (!authData.user) {
    return new Response(JSON.stringify({ error: "Failed to create user" }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const { data: orgData, error: orgError } = await supabaseAdmin
    .from("organizations")
    .insert({
      name: body.orgName,
      email: body.email,
      notes: body.notes || null,
      password_must_change: true,
      is_active: true,
    })
    .select("id")
    .single();

  if (orgError) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
    return new Response(JSON.stringify({ error: orgError.message }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const orgId = (orgData as { id: string }).id;

  const { error: memberError } = await supabaseAdmin.from("org_members").insert({
    org_id: orgId,
    user_id: authData.user.id,
    role: "admin",
  });

  if (memberError) {
    await supabaseAdmin.from("organizations").delete().eq("id", orgId);
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
    return new Response(JSON.stringify({ error: memberError.message }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({
      success: true,
      orgId,
      userId: authData.user.id,
    }),
    { headers: { ...cors, "Content-Type": "application/json" } },
  );
});
