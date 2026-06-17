import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.0";

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type NewsItem = { title: string; link: string; published: string; source: string };
type QuoteRow = { 
  label: string; 
  last: string; 
  changePercent: string; 
  asOf: string;
  weekChange?: string;
  high52w?: string;
  low52w?: string;
};
type HistoryPoint = { date: string; close: number };

async function fetchWithRetry(
  url: string, 
  options: RequestInit = {}, 
  retries = 3, 
  delay = 1000
): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      if (response.status >= 500 && i < retries - 1) {
        await new Promise(r => setTimeout(r, delay * (i + 1)));
        continue;
      }
      return response;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delay * (i + 1)));
    }
  }
  throw new Error("Max retries reached");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: cors });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const { data: mem } = await supabase
    .from("org_members")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  const { data: pa } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!mem && !pa) {
    return new Response(
      JSON.stringify({ error: "No organization" }),
      { status: 403, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  let news: NewsItem[] = [];
  let quotes: QuoteRow[] = [];
  let history: HistoryPoint[] = [];
  let marketStatus: "open" | "closed" | "pre" | "post" = "closed";

  const fetchNews = async () => {
    try {
      const rss = await fetchWithRetry(
        "https://news.google.com/rss/search?q=cotton+commodity+prices&hl=en-US&gl=US&ceid=US:en",
        {},
        2,
        500
      );
      const xml = await rss.text();
      const items = xml.split("<item>");
      for (let i = 1; i < Math.min(9, items.length); i++) {
        const item = items[i] ?? "";
        const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
          item.match(/<title>([^<]*)<\/title>/))?.[1]?.replace(/&amp;/g, "&") ?? "";
        const link =
          (item.match(/<link>([^<]*)<\/link>/) || [])[1] ?? "";
        const pubDate = (item.match(/<pubDate>([^<]*)<\/pubDate>/) || [])[1] ?? "";
        if (title) {
          news.push({
            title: title.trim(),
            link: link.trim(),
            published: pubDate,
            source: "Google News",
          });
        }
      }
    } catch {
      news = [];
    }
  };

  const fetchQuotes = async () => {
    try {
      const y = await fetchWithRetry(
        "https://query1.finance.yahoo.com/v8/finance/chart/CT%3DF?range=3mo&interval=1d",
        { headers: { "User-Agent": "CottonAI/1.0" } },
        3,
        1000
      );
      const j = (await y.json()) as {
        chart?: { result?: {
          meta?: { 
            regularMarketPrice?: number; 
            previousClose?: number; 
            symbol?: string; 
            regularMarketTime?: number;
            fiftyTwoWeekHigh?: number;
            fiftyTwoWeekLow?: number;
            marketState?: string;
          };
          timestamp?: number[];
          indicators?: { quote?: { open?: (number | null)[]; close?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[] }[] };
        }[] };
      };
      const r = j.chart?.result?.[0];
      if (r) {
        const meta = r.meta;
        const last = meta?.regularMarketPrice;
        const prev = meta?.previousClose;
        const high52 = meta?.fiftyTwoWeekHigh;
        const low52 = meta?.fiftyTwoWeekLow;
        const state = meta?.marketState?.toLowerCase() || "closed";
        
        if (state.includes("pre")) marketStatus = "pre";
        else if (state.includes("post")) marketStatus = "post";
        else if (state.includes("regular") || state.includes("open")) marketStatus = "open";
        else marketStatus = "closed";
        
        const t = meta?.regularMarketTime
          ? new Date(meta.regularMarketTime * 1000).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              timeZoneName: "short"
            })
          : new Date().toLocaleString();
        
        let chg = "—";
        if (last != null && prev != null && prev !== 0) {
          const p = ((last - prev) / prev) * 100;
          chg = `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
        }

        const timestamps = r.timestamp || [];
        const closes = r.indicators?.quote?.[0]?.close || [];
        let weekChange = "—";
        if (timestamps.length >= 5 && closes.length >= 5) {
          const weekAgoClose = closes[closes.length - 6];
          const currentClose = closes[closes.length - 1];
          if (weekAgoClose && currentClose && weekAgoClose !== 0) {
            const wp = ((currentClose - weekAgoClose) / weekAgoClose) * 100;
            weekChange = `${wp >= 0 ? "+" : ""}${wp.toFixed(2)}%`;
          }
        }

        for (let i = 0; i < timestamps.length; i++) {
          const ts = timestamps[i];
          const cl = closes[i];
          if (ts && cl != null) {
            history.push({
              date: new Date(ts * 1000).toISOString().split("T")[0],
              close: cl,
            });
          }
        }

        quotes.push({
          label: "ICE Cotton #2 (CT=F)",
          last: last != null ? last.toFixed(2) : "—",
          changePercent: chg,
          weekChange,
          high52w: high52 != null ? high52.toFixed(2) : undefined,
          low52w: low52 != null ? low52.toFixed(2) : undefined,
          asOf: t,
        });
      }
    } catch {
      quotes = [
        {
          label: "ICE Cotton #2 (CT)",
          last: "—",
          changePercent: "—",
          asOf: "Quote unavailable",
        },
      ];
    }
  };

  await Promise.all([fetchNews(), fetchQuotes()]);

  if (news.length === 0) {
    news = [
      {
        title: "Cotton market news (RSS fetch failed; try again later)",
        link: "https://www.ams.usda.gov/market-news",
        published: new Date().toISOString(),
        source: "USDA",
      },
    ];
  }

  return new Response(JSON.stringify({ 
    news, 
    quotes, 
    historical: history,
    marketStatus,
    fetchedAt: new Date().toISOString()
  }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
