import { useCallback, useEffect, useState, useMemo } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import type { Org, OrgMember, Chat, OrgSheet } from "./lib/types";
import { DashboardView } from "./DashboardView";
import { MailboxView } from "./MailboxView";
import { SignalsView } from "./SignalsView";
import { PlatformAdminPortal } from "./PlatformAdminPortal";
import { ChatPanel } from "./ChatPanel";
import { PageLoader } from "./PageLoader";

type View = "dashboard" | "chat" | "offers" | "signals" | "admin_portal";

type Props = {
  user: User;
  org: Org | null;
  member: OrgMember | null;
  isPlatformAdmin: boolean;
  allOrgs: Org[];
  onProfileChanged: () => void;
};

type ChatGroup = {
  label: string;
  chats: Chat[];
};

function groupChatsByDate(chats: Chat[]): ChatGroup[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const lastWeek = new Date(today.getTime() - 7 * 86400000);

  const groups: ChatGroup[] = [
    { label: "Today", chats: [] },
    { label: "Yesterday", chats: [] },
    { label: "Last 7 Days", chats: [] },
    { label: "Older", chats: [] },
  ];

  for (const chat of chats) {
    const chatDate = new Date(chat.updated_at || chat.created_at);
    if (chatDate >= today) {
      groups[0].chats.push(chat);
    } else if (chatDate >= yesterday) {
      groups[1].chats.push(chat);
    } else if (chatDate >= lastWeek) {
      groups[2].chats.push(chat);
    } else {
      groups[3].chats.push(chat);
    }
  }

  return groups.filter((g) => g.chats.length > 0);
}

const dots = ["dot-green", "dot-amber", "dot-blue"] as const;

function MainView({
  user,
  org,
  member: _member,
  isPlatformAdmin,
  allOrgs,
  onProfileChanged,
}: Props) {
  const [view, setView] = useState<View>("dashboard");
  const [navLoading, setNavLoading] = useState(false);
  const [contextOrgId, setContextOrgId] = useState<string | null>(() => {
    if (org?.id) {
      return org.id;
    }
    return allOrgs[0]?.id ?? null;
  });

  const navigateTo = useCallback((next: View) => {
    setView((current) => {
      if (current === next) return current;
      setNavLoading(true);
      window.setTimeout(() => setNavLoading(false), 420);
      return next;
    });
  }, []);

  const [chats, setChats] = useState<Chat[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [activeSheet, setActiveSheet] = useState<OrgSheet | null>(null);
  const [hasDocuments, setHasDocuments] = useState(false);
  const [hasOffers, setHasOffers] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    new Set(["Today", "Yesterday"])
  );

  const refreshOrgs = useCallback(async () => {
    onProfileChanged();
  }, [onProfileChanged]);

  const loadChats = useCallback(async () => {
    if (!contextOrgId) return;
    let q = supabase
      .from("chats")
      .select("*")
      .eq("org_id", contextOrgId)
      .order("updated_at", { ascending: false });
    if (!isPlatformAdmin) {
      q = q.eq("user_id", user.id);
    }
    const { data } = await q;
    setChats((data as Chat[] | null) ?? []);
  }, [contextOrgId, user.id, isPlatformAdmin]);

  const loadSheet = useCallback(async () => {
    if (!contextOrgId) return;
    const { data } = await supabase
      .from("org_sheets")
      .select("*")
      .eq("org_id", contextOrgId)
      .order("is_active", { ascending: false })
      .order("created_at", { ascending: false });
    const list = (data as OrgSheet[] | null) ?? [];
    const act =
      list.find((s) => s.is_active && s.parse_status === "ready") ?? null;
    setActiveSheet(
      act ?? (list.find((s) => s.parse_status === "ready") ?? null)
    );

    const { count } = await supabase
      .from("org_documents")
      .select("id", { count: "exact", head: true })
      .eq("org_id", contextOrgId)
      .eq("is_active", true);
    setHasDocuments((count ?? 0) > 0);

    // Global offer pool — enables chat even when this org has no sheet/docs.
    const { count: offerCount } = await supabase
      .from("cotton_offers")
      .select("id", { count: "exact", head: true });
    setHasOffers((offerCount ?? 0) > 0);
  }, [contextOrgId]);

  useEffect(() => {
    if (!isPlatformAdmin && org?.id) {
      setContextOrgId(org.id);
    }
  }, [isPlatformAdmin, org?.id]);

  useEffect(() => {
    if (isPlatformAdmin && allOrgs.length) {
      setContextOrgId((prev) => {
        if (prev && allOrgs.some((o) => o.id === prev)) {
          return prev;
        }
        return allOrgs[0]!.id;
      });
    }
  }, [isPlatformAdmin, allOrgs]);

  useEffect(() => {
    if (contextOrgId) {
      void loadChats();
      void loadSheet();
    }
  }, [contextOrgId, loadChats, loadSheet]);

  const chatGroups = useMemo(() => groupChatsByDate(chats), [chats]);

  const canChat = useMemo(() => {
    const sheetReady = !!activeSheet && activeSheet.parse_status === "ready";
    return sheetReady || hasDocuments;
  }, [activeSheet, hasDocuments]);

  const toggleGroup = (label: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  };

  const showAdminNav = isPlatformAdmin;
  const activeOrg = useMemo(
    () => allOrgs.find((o) => o.id === contextOrgId) ?? org ?? null,
    [allOrgs, contextOrgId, org]
  );
  const orgDisplayName = activeOrg?.name ?? "User";
  const initials =
    orgDisplayName
      .split(/\s+/)
      .map((n) => n[0])
      .filter(Boolean)
      .join("")
      .slice(0, 2)
      .toUpperCase() || "U";

  const currentChat = useMemo(
    () => chats.find((c) => c.id === currentChatId) ?? null,
    [chats, currentChatId]
  );

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <span className="sidebar-logo-dot" />
            Cotton AI
          </div>
        </div>
        <div className="sidebar-nav">
          <button
            type="button"
            className={`sidebar-link${view === "dashboard" ? " active" : ""}`}
            onClick={() => navigateTo("dashboard")}
          >
            Dashboard
          </button>
          <div className={`sidebar-link-row${view === "chat" ? " active" : ""}`}>
            <button
              type="button"
              className={`sidebar-link sidebar-link-main${view === "chat" ? " active" : ""}`}
              onClick={() => navigateTo("chat")}
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <span>AI Chat</span>
              <span
                style={{
                  fontSize: 9.5,
                  fontWeight: 700,
                  letterSpacing: 0.4,
                  textTransform: "uppercase",
                  color: "#fff",
                  background: "#e23b3b",
                  border: "1px solid rgba(255,255,255,0.18)",
                  borderRadius: 5,
                  padding: "1px 6px",
                  whiteSpace: "nowrap",
                }}
              >
                Do not use
              </span>
            </button>
            {view === "chat" && (
              <button
                type="button"
                className="new-chat-btn"
                title="New AI Chat"
                onClick={(e) => {
                  e.stopPropagation();
                  setCurrentChatId(null);
                }}
                disabled={!canChat}
              >
                <span className="new-chat-plus">+</span>
                <span className="new-chat-label">New chat</span>
              </button>
            )}
          </div>

          {view === "chat" && (
            <div className="sidebar-chats">
              {chatGroups.length === 0 && (
                <p className="sidebar-empty">No conversations yet</p>
              )}
              {chatGroups.map((group) => (
                <div key={group.label} className="chat-group">
                  <button
                    type="button"
                    className="chat-group-header"
                    onClick={() => toggleGroup(group.label)}
                  >
                    <span className="chat-group-arrow">
                      {expandedGroups.has(group.label) ? "▾" : "▸"}
                    </span>
                    <span className="chat-group-label">{group.label}</span>
                    <span className="chat-group-count">{group.chats.length}</span>
                  </button>
                  {expandedGroups.has(group.label) && (
                    <div className="chat-group-items">
                      {group.chats.map((c, i) => (
                        <div
                          key={c.id}
                          className={`chat-list-item${
                            c.id === currentChatId ? " active" : ""
                          }`}
                          role="button"
                          tabIndex={0}
                          onClick={() => setCurrentChatId(c.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              setCurrentChatId(c.id);
                            }
                          }}
                        >
                          <span
                            className={`sidebar-item-dot ${
                              dots[i % dots.length]
                            }`}
                          />
                          <span className="chat-item-title">{c.title}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            className={`sidebar-link${view === "offers" ? " active" : ""}`}
            onClick={() => navigateTo("offers")}
          >
            Cotton Mailbox
          </button>

          <button
            type="button"
            className={`sidebar-link${view === "signals" ? " active" : ""}`}
            onClick={() => navigateTo("signals")}
          >
            <span>Cotton AI Signals</span>
            <span className="sidebar-badge-soon">
              <span className="sidebar-badge-dot" />
              Coming soon
            </span>
          </button>
          {showAdminNav && (
            <button
              type="button"
              className={`sidebar-link${
                view === "admin_portal" ? " active" : ""
              }`}
              onClick={() => navigateTo("admin_portal")}
            >
              Admin
            </button>
          )}
        </div>

        {isPlatformAdmin && allOrgs.length > 1 && view === "chat" && (
          <div className="sidebar-org-select">
            <div className="sidebar-section-title">Organization</div>
            <select
              value={contextOrgId ?? ""}
              onChange={(e) => {
                setContextOrgId(e.target.value || null);
                setCurrentChatId(null);
              }}
            >
              {allOrgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <div className="sidebar-avatar">{initials}</div>
            <div className="sidebar-user-info">
              <span className="sidebar-user-name">{orgDisplayName}</span>
              {isPlatformAdmin && (
                <span className="sidebar-user-badge">Admin</span>
              )}
            </div>
            <button
              type="button"
              className="sidebar-signout"
              onClick={() => void supabase.auth.signOut()}
              title="Sign out"
            >
              ↗
            </button>
          </div>
        </div>
      </aside>

      <PageLoader visible={navLoading} />

      {view === "dashboard" && (
        <main className="app-main" style={{ overflow: "auto" }}>
          <div className="chat-header">
            <div className="chat-title">Dashboard</div>
            <div className="chat-status">
              <span className="chat-status-dot" />
              Market snapshot
            </div>
          </div>
          <DashboardView />
        </main>
      )}

      {view === "chat" && (
        <ChatPanel
          user={user}
          orgId={contextOrgId ?? ""}
          orgName={orgDisplayName}
          isPlatformAdmin={isPlatformAdmin}
          currentChatId={currentChatId}
          currentChat={currentChat}
          activeSheet={activeSheet}
          hasDocuments={hasDocuments}
          hasOffers={hasOffers}
          onChatCreated={(id) => {
            setCurrentChatId(id);
            void loadChats();
          }}
          onMessagesUpdated={() => void loadChats()}
        />
      )}

      {view === "offers" && (
        <main className="app-main" style={{ display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
          <MailboxView isPlatformAdmin={isPlatformAdmin} userName={orgDisplayName} />
        </main>
      )}

      {view === "signals" && (
        <main className="app-main" style={{ overflow: "auto" }}>
          <div className="chat-header">
            <div className="chat-title">Cotton AI Signals</div>
            <div className="chat-status" style={{ color: "var(--amber)" }}>
              <span
                className="chat-status-dot"
                style={{ background: "var(--amber)" }}
              />
              Coming Soon
            </div>
          </div>
          <SignalsView />
        </main>
      )}

      {view === "admin_portal" && isPlatformAdmin && (
        <main className="app-main" style={{ overflow: "auto" }}>
          <div className="chat-header">
            <div className="chat-title">Admin</div>
            <div className="chat-status" aria-hidden>
              <span className="chat-status-dot" />
              Platform
            </div>
          </div>
          <PlatformAdminPortal
            user={user}
            allOrgs={allOrgs}
            onOrgsChange={() => {
              void refreshOrgs();
            }}
          />
        </main>
      )}
    </div>
  );
}

export default MainView;
