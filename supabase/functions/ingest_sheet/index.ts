import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.0";
import * as XLSX from "npm:xlsx@0.18.5";

type WorkbookParse = {
  sheets: {
    name: string;
    rowCount: number;
    columnHeaders: string[];
    rows: Record<string, unknown>[];
  }[];
};

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MAX_SUMMARY_CH = 100_000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let orgSheetId: string;
  try {
    const b = (await req.json()) as { orgSheetId?: string };
    if (!b.orgSheetId) {
      return new Response(
        JSON.stringify({ error: "orgSheetId required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }
    orgSheetId = b.orgSheetId;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const { data: row, error: rErr } = await supabase
    .from("org_sheets")
    .select("id, org_id, storage_path, original_filename, parse_status")
    .eq("id", orgSheetId)
    .single();

  if (rErr || !row) {
    return new Response(JSON.stringify({ error: "org_sheets not found" }), {
      status: 404,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const { data: isPA } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!isPA) {
    const { data: member } = await supabase
      .from("org_members")
      .select("role, org_id")
      .eq("user_id", user.id)
      .eq("org_id", row.org_id)
      .single();
    if (!member || member.role !== "admin") {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  }

  const { data: file, error: dlErr } = await supabase.storage
    .from("org-sheets")
    .download(row.storage_path);

  if (dlErr || !file) {
    await supabase
      .from("org_sheets")
      .update({
        parse_status: "error",
        error_message: dlErr?.message ?? "Download failed",
        is_active: false,
      })
      .eq("id", orgSheetId);
    return new Response(
      JSON.stringify({ error: "Failed to load file from storage" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  const buf = new Uint8Array(await file.arrayBuffer());

  let parsed: WorkbookParse;
  let summary: string;
  try {
    const book = XLSX.read(buf, { type: "array", cellDates: true });
    const sheets: WorkbookParse["sheets"] = [];
    for (const name of book.SheetNames) {
      const sheet = book.Sheets[name];
      if (!sheet) continue;
      const asJson = XLSX.utils.sheet_to_json<Record<string, unknown>>(
        sheet,
        { defval: null, raw: false, blankrows: false },
      );
      const headers = asJson.length
        ? Object.keys(asJson[0] ?? {})
        : [];
      sheets.push({
        name,
        rowCount: asJson.length,
        columnHeaders: headers,
        rows: asJson,
      });
    }
    parsed = { sheets };
    summary = buildMarkdown(sheets, MAX_SUMMARY_CH);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await supabase
      .from("org_sheets")
      .update({
        parse_status: "error",
        error_message: errMsg,
        is_active: false,
      })
      .eq("id", orgSheetId);
    return new Response(JSON.stringify({ error: "Parse error", detail: errMsg }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  await supabase
    .from("org_sheets")
    .update({ is_active: false })
    .eq("org_id", row.org_id);

  const { error: upErr } = await supabase
    .from("org_sheets")
    .update({
      parse_status: "ready",
      parsed: parsed as unknown as Record<string, unknown>,
      summary_text: summary,
      is_active: true,
      error_message: null,
    })
    .eq("id", orgSheetId);

  if (upErr) {
    return new Response(
      JSON.stringify({ error: "Failed to save sheet", detail: upErr.message }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  return new Response(JSON.stringify({ ok: true, orgSheetId }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});

function buildMarkdown(
  sheets: WorkbookParse["sheets"],
  maxChars: number,
): string {
  let out = "";
  for (const s of sheets) {
    if (!s.rows.length) {
      out += `## ${s.name}\n_(no rows)_\n\n`;
      continue;
    }
    out += `## ${s.name}\n`;
    out += _tableForSheet(s) + "\n\n";
  }
  if (out.length <= maxChars) {
    return out;
  }
  return (
    out.slice(0, maxChars) +
    `\n\n[Summary truncated. Total length ${out.length} characters.]`
  );
}

function _tableForSheet(s: WorkbookParse["sheets"][0]): string {
  const headers = s.columnHeaders.length
    ? s.columnHeaders
    : Object.keys(s.rows[0] ?? {});
  const head = `| ${headers.map((h) => escapeCell(String(h))).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const lines: string[] = [head, sep];
  for (const r of s.rows) {
    const line = `| ${
      headers
        .map((h) => {
          const v = r[h];
          if (v == null) return "";
          return escapeCell(String(v));
        })
        .join(" | ")
    } |`;
    lines.push(line);
  }
  return lines.join("\n");
}

function escapeCell(t: string): string {
  return t.replaceAll("|", "\\|").replaceAll("\n", " ");
}
