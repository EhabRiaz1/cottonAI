import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.0";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MAX_SYSTEM_CHARS = 80_000;
const MAX_DOCS_CHARS = 40_000;
const ANTHROPIC_VERSION = "2023-06-01";

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
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }
  const model = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-5-20250929";

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing Authorization" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const supabaseAdmin = createClient(supabaseUrl, serviceKey);
  
  const {
    data: { user },
  } = await supabase.auth.getUser();
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
  const platformAdmin = !!isPA;

  type Body = { chatId: string; orgId: string };
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  if (!body.chatId || !body.orgId) {
    return new Response(
      JSON.stringify({ error: "chatId and orgId required" }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  const { data: mem } = await supabase
    .from("org_members")
    .select("org_id")
    .eq("user_id", user.id)
    .eq("org_id", body.orgId)
    .maybeSingle();
  if (!mem && !platformAdmin) {
    return new Response(JSON.stringify({ error: "Not in org" }), {
      status: 403,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const { data: chat, error: cErr } = await supabase
    .from("chats")
    .select("id, org_id, user_id, org_sheet_id, title")
    .eq("id", body.chatId)
    .single();

  if (cErr || !chat) {
    return new Response(JSON.stringify({ error: "Chat not found" }), {
      status: 404,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  if (chat.org_id !== body.orgId) {
    return new Response(JSON.stringify({ error: "Org mismatch" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  if (!platformAdmin && chat.user_id !== user.id) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const { data: org } = await supabaseAdmin
    .from("organizations")
    .select("custom_system_prompt")
    .eq("id", body.orgId)
    .single();

  const { data: defaultPromptRow } = await supabaseAdmin
    .from("system_prompts")
    .select("prompt_text")
    .eq("is_default", true)
    .is("org_id", null)
    .maybeSingle();

  const basePrompt = org?.custom_system_prompt || defaultPromptRow?.prompt_text || getDefaultPrompt();

  const { data: orgDocs } = await supabaseAdmin
    .from("org_documents")
    .select("id, name, parsed_content, original_filename, storage_path, file_type")
    .eq("org_id", body.orgId)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  let docsContext = "";
  if (orgDocs && orgDocs.length > 0) {
    let charCount = 0;
    const docSections: string[] = [];
    for (const doc of orgDocs) {
      if (charCount >= MAX_DOCS_CHARS) break;

      let content = doc.parsed_content;

      if (!content && doc.storage_path) {
        try {
          const { data: fileData } = await supabaseAdmin.storage
            .from("org-sheets")
            .download(doc.storage_path);
          if (fileData) {
            const fname = (doc.original_filename || doc.storage_path).toLowerCase();
            const isExcel = fname.endsWith(".xlsx") || fname.endsWith(".xls") || fname.endsWith(".xlsb");

            if (isExcel) {
              const buf = await fileData.arrayBuffer();
              const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
              const parts: string[] = [];
              for (const sn of wb.SheetNames) {
                const ws = wb.Sheets[sn];
                if (!ws) continue;
                const csv = XLSX.utils.sheet_to_csv(ws);
                if (!csv.trim()) continue;
                const rows = csv.split("\n").filter((r: string) => r.trim());
                if (rows.length === 0) continue;
                parts.push(`## Sheet: ${sn}\n`);
                const hdrs = rows[0].split(",");
                parts.push("| " + hdrs.join(" | ") + " |");
                parts.push("| " + hdrs.map(() => "---").join(" | ") + " |");
                for (let ri = 1; ri < rows.length; ri++) {
                  parts.push("| " + rows[ri].split(",").join(" | ") + " |");
                }
                parts.push("");
              }
              if (parts.length > 0) content = parts.join("\n");
            } else {
              const text = await fileData.text();
              if (text && text.length > 0) content = text;
            }

            if (content) {
              await supabaseAdmin
                .from("org_documents")
                .update({ parsed_content: content.slice(0, 200000) })
                .eq("id", doc.id);
            }
          }
        } catch {
          // skip this doc if download/parse fails
        }
      }

      if (content) {
        const section = `### Document: ${doc.name || doc.original_filename}\n${content}`;
        if (charCount + section.length <= MAX_DOCS_CHARS) {
          docSections.push(section);
          charCount += section.length;
        }
      }
    }
    if (docSections.length > 0) {
      docsContext = "\n\n## Organization Documents:\n" + docSections.join("\n\n");
    }
  }

  let sheetId = chat.org_sheet_id as string | null;
  if (!sheetId) {
    const { data: active } = await supabase
      .from("org_sheets")
      .select("id")
      .eq("org_id", body.orgId)
      .eq("parse_status", "ready")
      .eq("is_active", true)
      .maybeSingle();
    sheetId = active?.id ?? null;
  }

  let sheetContext = "";
  if (sheetId) {
    const { data: sheet } = await supabase
      .from("org_sheets")
      .select("id, summary_text, parse_status, original_filename")
      .eq("id", sheetId)
      .eq("org_id", body.orgId)
      .single();
    
    if (sheet && sheet.parse_status === "ready" && sheet.summary_text) {
      const s = sheet.summary_text.length > MAX_SYSTEM_CHARS
        ? sheet.summary_text.slice(0, MAX_SYSTEM_CHARS) + "\n\n[Truncated for model context.]"
        : sheet.summary_text;
      sheetContext = `\n\n## Workbook Data (${sheet.original_filename || "workbook"}):\n${s}`;
    }
  }

  if (!sheetContext && !docsContext) {
    const hasDocsButUnparsed = orgDocs && orgDocs.length > 0;
    return new Response(
      JSON.stringify({
        error: hasDocsButUnparsed
          ? "Documents were found but could not be read. Please ensure text-based files (TXT, CSV) are uploaded, or re-upload the documents."
          : "No data available. Please ask your admin to upload documents or a spreadsheet for your organization.",
      }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  const { data: msgRows, error: mErr } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("chat_id", body.chatId)
    .order("created_at", { ascending: true })
    .limit(60);

  if (mErr) {
    return new Response(JSON.stringify({ error: mErr.message }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  if (!msgRows || msgRows.length === 0) {
    return new Response(
      JSON.stringify({ error: "No messages in chat" }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  const systemText = `${basePrompt}${docsContext}${sheetContext}`;

  const claudeMessages: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of msgRows) {
    if (m.role === "user" || m.role === "assistant") {
      claudeMessages.push({ role: m.role, content: m.content });
    }
  }

  const oaRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system: systemText,
      stream: true,
      messages: claudeMessages,
    }),
  });

  if (!oaRes.ok) {
    const t = await oaRes.text();
    return new Response(
      JSON.stringify({ error: "Anthropic error", detail: t }),
      { status: 502, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }
  if (!oaRes.body) {
    return new Response(JSON.stringify({ error: "No stream" }), {
      status: 502,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const reader = oaRes.body.getReader();
  const dec = new TextDecoder();
  let lineBuf = "";
  let assistantText = "";

  const out = new ReadableStream<Uint8Array>({
    async start(con) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          lineBuf += dec.decode(value, { stream: true });
          const lines = lineBuf.split("\n");
          lineBuf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) {
              continue;
            }
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") {
              continue;
            }
            let j: {
              type?: string;
              delta?: { type?: string; text?: string };
            };
            try {
              j = JSON.parse(payload) as {
                type?: string;
                delta?: { type?: string; text?: string };
              };
            } catch {
              continue;
            }
            if (j.type === "content_block_delta" && j.delta) {
              const d = j.delta as { type?: string; text?: string };
              const piece = typeof d.text === "string" ? d.text : "";
              if (piece) {
                assistantText += piece;
                con.enqueue(new TextEncoder().encode(piece));
              }
            }
          }
        }
        if (assistantText.length > 0) {
          await supabase.from("messages").insert({
            chat_id: body.chatId,
            role: "assistant",
            content: assistantText,
          });
          if (chat.title === "New chat" || !chat.title) {
            const firstUser = msgRows.find((x) => x.role === "user");
            if (firstUser) {
              const t = firstUser.content.slice(0, 64).trim() || "Chat";
              await supabase
                .from("chats")
                .update({ title: t })
                .eq("id", body.chatId);
            }
          }
        }
        con.close();
      } catch (e) {
        con.error(e);
      }
    },
  });

  return new Response(out, {
    headers: {
      ...cors,
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
});

function getDefaultPrompt(): string {
  return `You are Cotton AI, a specialized assistant for cotton procurement and trading. You help textile mills with:

1. **Fixation Timing**: When to fix prices on cotton contracts based on market conditions
2. **Origin Selection**: Which cotton origins (Brazilian, US, West African, etc.) offer best value for specific yarn requirements
3. **Hedging Strategies**: Options and futures strategies to protect against price volatility
4. **Market Analysis**: Interpreting USDA reports, supply/demand dynamics, and price trends

You have access to the organization's procurement data, documents, and market information. Always:
- Be specific with recommendations (exact prices, dates, quantities when possible)
- Explain your reasoning and confidence level
- Note any risks or assumptions
- Remind users this is informational only and they should verify with their trading team

Format responses clearly with headers, bullet points, and tables where appropriate.`;
}
