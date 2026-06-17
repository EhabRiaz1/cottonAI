import { useCallback, useEffect, useState } from "react";
import { supabase } from "./lib/supabase";

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
type HistoricalPrice = { date: string; close: number };
type MarketStatus = "open" | "closed" | "pre" | "post";

function MiniChart({ data }: { data: HistoricalPrice[] }) {
  if (!data || data.length < 2) {
    return <div className="mini-chart-empty">No chart data</div>;
  }

  const vw = 400;
  const vh = 140;
  const prices = data.map(d => d.close);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const range = maxPrice - minPrice || 1;
  const padding = 6;
  const chartW = vw - padding * 2;
  const chartH = vh - padding * 2;
  
  const points = data.map((d, i) => {
    const x = padding + (i / (data.length - 1)) * chartW;
    const y = padding + chartH - ((d.close - minPrice) / range) * chartH;
    return `${x},${y}`;
  }).join(" ");

  const firstPrice = data[0].close;
  const lastPrice = data[data.length - 1].close;
  const trend = lastPrice >= firstPrice ? "up" : "down";
  const gradientId = `chart-gradient-${trend}`;

  const areaPoints = `${padding},${padding + chartH} ${points} ${vw - padding},${padding + chartH}`;

  return (
    <div className="mini-chart-container">
      <svg viewBox={`0 0 ${vw} ${vh}`} preserveAspectRatio="none" className={`mini-chart ${trend}`}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={trend === "up" ? "var(--green)" : "var(--red)"} stopOpacity="0.3" />
            <stop offset="100%" stopColor={trend === "up" ? "var(--green)" : "var(--red)"} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={areaPoints} fill={`url(#${gradientId})`} />
        <polyline
          points={points}
          fill="none"
          stroke={trend === "up" ? "var(--green)" : "var(--red)"}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <circle
          cx={vw - padding}
          cy={padding + chartH - ((lastPrice - minPrice) / range) * chartH}
          r="4"
          fill={trend === "up" ? "var(--green)" : "var(--red)"}
        />
      </svg>
      <div className="chart-range">
        <span className="chart-date">{data[0].date}</span>
        <span className="chart-date">{data[data.length - 1].date}</span>
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="futures-card skeleton">
      <div className="skeleton-line" style={{ width: "60%", height: 10, marginBottom: 12 }} />
      <div className="skeleton-line" style={{ width: "40%", height: 24, marginBottom: 8 }} />
      <div className="skeleton-line" style={{ width: "30%", height: 12 }} />
    </div>
  );
}

function SkeletonNewsCard() {
  return (
    <div className="news-card skeleton">
      <div className="skeleton-line" style={{ width: "25%", height: 10, marginBottom: 8 }} />
      <div className="skeleton-line" style={{ width: "90%", height: 14, marginBottom: 6 }} />
      <div className="skeleton-line" style={{ width: "70%", height: 14, marginBottom: 8 }} />
      <div className="skeleton-line" style={{ width: "35%", height: 10 }} />
    </div>
  );
}

function MarketStatusBadge({ status }: { status: MarketStatus }) {
  const labels: Record<MarketStatus, string> = {
    open: "Market Open",
    closed: "Market Closed",
    pre: "Pre-Market",
    post: "After Hours",
  };
  const colors: Record<MarketStatus, string> = {
    open: "var(--green)",
    closed: "var(--text-muted)",
    pre: "var(--amber)",
    post: "var(--blue)",
  };
  return (
    <span className="market-status-badge" style={{ color: colors[status] }}>
      <span className="market-status-dot" style={{ background: colors[status] }} />
      {labels[status]}
    </span>
  );
}

export function DashboardView() {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  const [historical, setHistorical] = useState<HistoricalPrice[]>([]);
  const [marketStatus, setMarketStatus] = useState<MarketStatus>("closed");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetched, setLastFetched] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setErr("Not signed in");
        return;
      }
      const base = import.meta.env.VITE_SUPABASE_URL;
      const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;
      const res = await fetch(`${base}/functions/v1/cotton_market`, {
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: anon,
        },
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || res.statusText);
      }
      const j = (await res.json()) as { 
        news: NewsItem[]; 
        quotes: QuoteRow[];
        historical?: HistoricalPrice[];
        marketStatus?: MarketStatus;
        fetchedAt?: string;
      };
      setNews(j.news ?? []);
      setQuotes(j.quotes ?? []);
      setHistorical(j.historical ?? []);
      setMarketStatus(j.marketStatus ?? "closed");
      setLastFetched(j.fetchedAt ?? new Date().toISOString());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [load]);

  const formatTimeAgo = (isoString: string) => {
    const diff = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return new Date(isoString).toLocaleDateString();
  };

  return (
    <div className="dashboard-view">
      <div className="dashboard-header">
        <div className="dashboard-header-left">
          <h1 className="dashboard-title">
            Market <em>Snapshot</em>
          </h1>
          <p className="dashboard-subtitle">
            Cotton futures and industry news at a glance
          </p>
        </div>
        <div className="dashboard-header-right">
          <MarketStatusBadge status={marketStatus} />
          {lastFetched && (
            <span className="last-updated">
              Updated {formatTimeAgo(lastFetched)}
            </span>
          )}
          <button 
            type="button" 
            className="refresh-btn" 
            onClick={() => void load()}
            disabled={loading}
            title="Refresh data"
          >
            {loading ? "…" : "↻"}
          </button>
        </div>
      </div>

      {err && (
        <div className="dashboard-error-card">
          <span className="error-icon">!</span>
          <div>
            <p className="error-title">Unable to load market data</p>
            <p className="error-message">{err}</p>
          </div>
          <button type="button" className="btn btn-ghost" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      <section className="dashboard-section">
        <div className="section-header">
          <h2>
            Cotton <em>Futures</em>
          </h2>
          <span className="section-tag">ICE Cotton #2 (CT)</span>
        </div>
        <p className="section-disclaimer">
          Delayed / indicative only — not investment advice
        </p>
        <div className="dashboard-futures-layout">
          {loading && quotes.length === 0 ? (
            <SkeletonCard />
          ) : quotes.length === 0 && !err ? (
            <p className="empty-state">No quotes available</p>
          ) : quotes[0] && (
            <div className="futures-card">
              <div className="futures-card-label">{quotes[0].label}</div>
              <div className="futures-card-price">
                {quotes[0].last}
                <span className="price-unit">¢/lb</span>
              </div>
              <div className="futures-card-changes">
                <div
                  className={
                    quotes[0].changePercent.startsWith("-")
                      ? "futures-card-chg neg"
                      : "futures-card-chg pos"
                  }
                >
                  {quotes[0].changePercent}
                  <span className="chg-label">Today</span>
                </div>
                {quotes[0].weekChange && (
                  <div
                    className={
                      quotes[0].weekChange.startsWith("-")
                        ? "futures-card-chg neg"
                        : "futures-card-chg pos"
                    }
                  >
                    {quotes[0].weekChange}
                    <span className="chg-label">Week</span>
                  </div>
                )}
              </div>
              {(quotes[0].high52w || quotes[0].low52w) && (
                <div className="futures-card-range">
                  <span>52W: {quotes[0].low52w} — {quotes[0].high52w}</span>
                </div>
              )}
              <div className="futures-card-asof">{quotes[0].asOf}</div>
            </div>
          )}
          <div className="dashboard-chart-card">
            <div className="chart-card-header">
              <h3>30 Day Price History</h3>
              {historical.length > 1 && (
                <span className={`chart-trend ${historical[historical.length - 1]?.close >= historical[0]?.close ? "up" : "down"}`}>
                  {historical[historical.length - 1]?.close >= historical[0]?.close ? "↑" : "↓"}
                  {" "}
                  {Math.abs(
                    ((historical[historical.length - 1]?.close - historical[0]?.close) / historical[0]?.close) * 100
                  ).toFixed(2)}%
                </span>
              )}
            </div>
            {loading && historical.length === 0 ? (
              <div className="chart-skeleton">
                <div className="skeleton-line" style={{ width: "100%", height: 100 }} />
              </div>
            ) : historical.length > 0 ? (
              <MiniChart data={historical} />
            ) : (
              <div className="chart-empty">
                <p>Historical data unavailable</p>
              </div>
            )}
            {historical.length > 0 && (
              <div className="chart-stats">
                <div className="chart-stat">
                  <span className="stat-label">High</span>
                  <span className="stat-value">{Math.max(...historical.map(h => h.close)).toFixed(2)}¢</span>
                </div>
                <div className="chart-stat">
                  <span className="stat-label">Low</span>
                  <span className="stat-value">{Math.min(...historical.map(h => h.close)).toFixed(2)}¢</span>
                </div>
                <div className="chart-stat">
                  <span className="stat-label">Avg</span>
                  <span className="stat-value">
                    {(historical.reduce((s, h) => s + h.close, 0) / historical.length).toFixed(2)}¢
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="dashboard-section">
        <div className="section-header">
          <h2>
            Cotton <em>News</em>
          </h2>
          <span className="section-tag">Google News RSS</span>
        </div>
        <p className="section-disclaimer">
          Aggregated from public RSS feeds. Verify any figure before making decisions.
        </p>
        <div className="news-grid">
          {loading && news.length === 0 && (
            <>
              <SkeletonNewsCard />
              <SkeletonNewsCard />
              <SkeletonNewsCard />
              <SkeletonNewsCard />
            </>
          )}
          {!loading && news.length === 0 && !err && (
            <p className="empty-state">No articles right now</p>
          )}
          {news.map((n, i) => (
            <a
              key={i + n.link}
              href={n.link}
              target="_blank"
              rel="noreferrer"
              className="news-card"
            >
              <div className="news-card-source">{n.source}</div>
              <div className="news-card-title">{n.title}</div>
              <div className="news-card-time">
                {n.published ? formatTimeAgo(n.published) : ""}
              </div>
            </a>
          ))}
        </div>
      </section>

      <p className="dashboard-disclaimer">
        Data is provided for informational purposes only and should not be considered financial advice. 
        Futures trading involves substantial risk. Past performance is not indicative of future results.
      </p>
    </div>
  );
}
