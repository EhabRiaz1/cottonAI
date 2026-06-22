import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { supabase } from "./lib/supabase";
import { streamChat } from "./lib/api";
import type { Chat, OrgSheet, MessageRow } from "./lib/types";

const QUICK_CHIPS: string[] = [
  "What are my March contracts?",
  "Show me all unfixed positions",
  "What's my average fixed price this year?",
  "List all Egyptian Giza contracts",
];

function getTimeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

type ChatPanelProps = {
  user: User;
  orgId: string;
  orgName?: string;
  isPlatformAdmin: boolean;
  currentChatId: string | null;
  currentChat: Chat | null;
  activeSheet: OrgSheet | null;
  hasDocuments?: boolean;
  hasOffers?: boolean;
  onChatCreated: (chatId: string) => void;
  onMessagesUpdated: () => void;
};

export function ChatPanel({
  user,
  orgId,
  orgName,
  isPlatformAdmin: _isPlatformAdmin,
  currentChatId,
  currentChat,
  activeSheet,
  hasDocuments = false,
  hasOffers = false,
  onChatCreated,
  onMessagesUpdated,
}: ChatPanelProps) {
  const sheetReady = !!activeSheet && activeSheet.parse_status === "ready";
  // Offers are a global pool, so the assistant can answer from them even when this
  // org has no sheet/docs uploaded (plan §10.4).
  const canChat = sheetReady || hasDocuments || hasOffers;

  const streamBufferRef = useRef<string>("");
  const rafIdRef = useRef<number | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [streamPreview, setStreamPreview] = useState("");
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const displayName = orgName && orgName.trim() ? orgName : (user.email?.split("@")[0] ?? "User");
  const initials =
    displayName
      .split(/\s+/)
      .map((n) => n[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "U";

  const loadMessages = useCallback(async (chatId: string) => {
    const { data, error: e } = await supabase
      .from("messages")
      .select("*")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: true });
    if (e) {
      console.error(e);
    }
    setMessages((data as MessageRow[] | null) ?? []);
  }, []);

  useEffect(() => {
    if (currentChatId) {
      void loadMessages(currentChatId);
    } else {
      setMessages([]);
    }
  }, [currentChatId, loadMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (streamPreview) {
      messagesEndRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    }
  }, [streamPreview]);

  const send = async () => {
    const t = input.trim();
    if (!t || sending || !orgId) {
      return;
    }
    setError(null);
    setInput("");
    setSending(true);
    setStreamPreview("");

    if (!canChat) {
      setError(
        "No data available for this organization yet. Please ask your admin to upload documents or a spreadsheet."
      );
      setSending(false);
      return;
    }

    const optimisticId = Date.now();
    const optimisticUserMsg: MessageRow = {
      id: optimisticId,
      chat_id: currentChatId ?? "pending",
      role: "user",
      content: t,
      metadata: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUserMsg]);

    let chatId = currentChatId;
    if (!chatId) {
      const { data, error: ce } = await supabase
        .from("chats")
        .insert({
          org_id: orgId,
          user_id: user.id,
          org_sheet_id: sheetReady && activeSheet ? activeSheet.id : null,
          title: t.slice(0, 64),
        })
        .select("id")
        .single();
      if (ce) {
        setError(ce.message);
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
        setSending(false);
        return;
      }
      chatId = (data as { id: string }).id;
      onChatCreated(chatId);
    }

    if (!chatId) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      setSending(false);
      return;
    }

    const { error: uErr } = await supabase.from("messages").insert({
      chat_id: chatId,
      role: "user",
      content: t,
    });
    if (uErr) {
      setError(uErr.message);
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      setSending(false);
      return;
    }

    const s = (await supabase.auth.getSession()).data.session;
    if (!s?.access_token) {
      setError("Not signed in");
      setSending(false);
      return;
    }

    streamBufferRef.current = "";
    let pendingFlush = false;
    const flushToState = () => {
      pendingFlush = false;
      setStreamPreview(streamBufferRef.current);
      rafIdRef.current = null;
    };

    try {
      await streamChat(s.access_token, { chatId, orgId }, (chunk) => {
        streamBufferRef.current += chunk;
        if (!pendingFlush) {
          pendingFlush = true;
          rafIdRef.current = requestAnimationFrame(flushToState);
        }
      });
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      setStreamPreview(streamBufferRef.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStreamPreview("");
      streamBufferRef.current = "";
      setSending(false);
      if (chatId) {
        await loadMessages(chatId);
        onMessagesUpdated();
      }
    }
  };

  if (!orgId) {
    return (
      <main className="app-main chat-panel-empty">
        <div className="chat-empty-state">
          <div className="chat-empty-icon">💬</div>
          <h3>Select an Organization</h3>
          <p>Choose an organization to start chatting with Cotton AI</p>
        </div>
      </main>
    );
  }

  const isEmptyChat = !currentChatId && !sending && messages.length === 0;

  return (
    <main className={`app-main chat-panel${isEmptyChat ? " chat-panel-hero" : ""}`}>
      <div className="chat-header">
        <div className="chat-header-left">
          <div className="chat-title">
            {currentChat?.title ?? "Cotton AI"}
          </div>
          {currentChat && (
            <span className="chat-subtitle">
              Ask about your procurement data
            </span>
          )}
        </div>
        <div className="chat-header-right">
          <div className="chat-status">
            <span className="chat-status-dot" />
            Live Market Data
          </div>
          <div className="chat-user-avatar">{initials}</div>
        </div>
      </div>

      {isEmptyChat && (
        <div className="chat-hero">
          <h1 className="chat-welcome-hello">
            Good {getTimeOfDay()}, <em>{displayName}</em>
          </h1>
          <p className="chat-welcome-sub">
            {canChat
              ? "How can I help you with your cotton procurement today?"
              : "No data is available yet. Please ask your admin to upload documents or a spreadsheet for this organization."}
          </p>
        </div>
      )}

      <div className="chat-messages">
        {error && (
          <div className="chat-error">
            <span className="chat-error-icon">!</span>
            {error}
          </div>
        )}

        {messages.map((m) => (
          <div
            key={m.id}
            className={m.role === "user" ? "msg msg-user" : "msg msg-ai"}
          >
            <div className="msg-avatar">
              {m.role === "user" ? initials : "CA"}
            </div>
            <div className="msg-body">
              <div className="msg-sender">
                {m.role === "user" ? displayName : "Cotton AI"}
              </div>
              <div className="msg-content">
                {m.role === "assistant" ? (
                  <div className="markdown-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {m.content}
                    </ReactMarkdown>
                  </div>
                ) : (
                  m.content
                )}
              </div>
            </div>
          </div>
        ))}

        {sending && streamPreview && (
          <div className="msg msg-ai">
            <div className="msg-avatar">CA</div>
            <div className="msg-body">
              <div className="msg-sender">Cotton AI</div>
              <div className="msg-content">
                <div className="markdown-body streaming">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {streamPreview}
                  </ReactMarkdown>
                  <span className="stream-caret" aria-hidden="true" />
                </div>
              </div>
            </div>
          </div>
        )}

        {sending && !streamPreview && (
          <div className="msg msg-ai">
            <div className="msg-avatar thinking">CA</div>
            <div className="msg-body">
              <div className="msg-sender">Cotton AI</div>
              <div className="msg-content">
                <div className="thinking-indicator">
                  <span className="thinking-label">Thinking</span>
                  <div className="thinking-dots">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className={`chat-input-area${isEmptyChat ? " hero" : ""}`}>
        <div className="chat-input-shell">
          <div className="chat-input-box">
            <input
              className="chat-input"
              placeholder={
                canChat
                  ? "Ask Cotton AI anything about your cotton book..."
                  : "No data available - ask your admin to upload documents"
              }
              value={input}
              disabled={sending || !canChat}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button
              className="chat-send"
              type="button"
              disabled={sending || !input.trim()}
              onClick={() => void send()}
            >
              →
            </button>
          </div>

          {isEmptyChat && canChat && (
            <div className="chat-quick-chips">
              <span className="chat-chip-label">Try asking</span>
              {QUICK_CHIPS.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="chat-chip"
                  onClick={() => setInput(q)}
                >
                  {q}
                </button>
              ))}
            </div>
          )}

          {!isEmptyChat && (
            <p className="chat-disclaimer">
              Cotton AI provides data-driven recommendations. AI can make mistakes —
              if you're unsure about a recommendation, ask the AI to get it approved
              by a human data analyst and futures expert at YS Group and Ample
              Insight.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
