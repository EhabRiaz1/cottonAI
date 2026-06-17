import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import AuthView from "./AuthView";
import MainView from "./MainView";
import type { MemberRole, Org, OrgMember } from "./lib/types";

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [org, setOrg] = useState<Org | null>(null);
  const [member, setMember] = useState<OrgMember | null>(null);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [allOrgs, setAllOrgs] = useState<Org[]>([]);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setLoading(false);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
    });
    return () => subscription.unsubscribe();
  }, []);

  const loadProfile = useCallback(async () => {
    if (!session?.user) {
      setOrg(null);
      setMember(null);
      setIsPlatformAdmin(false);
      setAllOrgs([]);
      return;
    }
    const uid = session.user.id;
    const { data: pa } = await supabase
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", uid)
      .maybeSingle();
    const isPA = !!pa;
    setIsPlatformAdmin(isPA);

    const { data: rows, error: omErr } = await supabase
      .from("org_members")
      .select("org_id, user_id, role, organizations ( id, name, notes, created_at )")
      .eq("user_id", uid)
      .limit(1);
    if (omErr) {
      console.error(omErr);
    }

    if (isPA) {
      const { data: orgsList } = await supabase
        .from("organizations")
        .select("id, name, notes, created_at")
        .order("name");
      setAllOrgs((orgsList as Org[] | null) ?? []);
    } else {
      setAllOrgs([]);
    }

    const r = rows?.[0] as
      | (OrgMember & { organizations: Org | Org[] | null })
      | undefined;
    if (r) {
      const o = Array.isArray(r.organizations)
        ? r.organizations[0]
        : r.organizations;
      if (o) {
        setOrg(o);
      } else {
        setOrg(null);
      }
      setMember({
        org_id: r.org_id,
        user_id: r.user_id,
        role: r.role as MemberRole,
      });
    } else {
      setOrg(null);
      setMember(null);
    }
  }, [session]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  if (loading) {
    return <div className="loading">Loading…</div>;
  }
  if (!session?.user) {
    return <AuthView />;
  }

  if (!isPlatformAdmin && (!org || !member)) {
    return (
      <div className="auth-wrap">
        <h1
          className="auth-title"
          style={{ marginBottom: 16, fontSize: 22, fontFamily: "var(--serif)" }}
        >
          Awaiting <em>assignment</em>
        </h1>
        <p
          className="auth-sub"
          style={{ maxWidth: 420, lineHeight: 1.6, marginBottom: 20 }}
        >
          Your account is not linked to an organization yet. A platform admin
          must add you. If you were just invited, try signing in again in a
          few minutes, or contact your administrator.
        </p>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void supabase.auth.signOut()}
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <MainView
      user={session.user}
      org={org}
      member={member}
      isPlatformAdmin={isPlatformAdmin}
      allOrgs={allOrgs}
      onProfileChanged={loadProfile}
    />
  );
}

export default App;
