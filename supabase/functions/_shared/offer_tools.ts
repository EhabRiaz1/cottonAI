// Offer search tools for the chat tool-use loop. The same query shape backs the
// UI offers table (D11). Reads run on the caller's RLS-scoped client (global pool:
// any authenticated user can read), never the service role.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.0";

export const OFFER_TOOLS = [
  {
    name: "search_offers",
    description:
      "Search the global pool of cotton offers extracted from broker emails. " +
      "All filters are optional and combine with AND. Returns matching offers with " +
      "their offer_date and age_days so you can show each price next to its date and " +
      "comment on freshness. Use this for any question about available cotton.",
    input_schema: {
      type: "object",
      properties: {
        origin_country: { type: "string", description: "e.g. Brazil, USA, Benin" },
        region: { type: "string", description: "e.g. West Africa, M/E" },
        certifications: {
          type: "array", items: { type: "string" },
          description: "Match offers carrying ANY of these (BCI, CmiA, regenagri, HIP...)",
        },
        grade: { type: "string", description: "Fuzzy match on the raw grade string" },
        mic_min: { type: "number" }, mic_max: { type: "number" },
        staple_min_32nds: { type: "integer" }, staple_max_32nds: { type: "integer" },
        gpt_min: { type: "number" }, gpt_max: { type: "number" },
        length_min: { type: "number" }, length_max: { type: "number" },
        uniformity_min: { type: "number" },
        quantity_min_bales: { type: "integer" },
        price_outright_max_cents: { type: "number", description: "Max outright c/lb" },
        price_basis_max_points: { type: "number", description: "Max on-call basis points" },
        price_type: { type: "string", enum: ["on_call", "outright", "none"] },
        crop_year: { type: "string", description: "e.g. 2025/26" },
        shipment: { type: "string", description: "Fuzzy match on shipment period" },
        broker: { type: "string", description: "Fuzzy match on broker" },
        date_from: { type: "string", description: "ISO date; offers on/after this date" },
        date_to: { type: "string", description: "ISO date; offers on/before this date" },
        free_text: { type: "string", description: "Fuzzy match anywhere in the raw offer line" },
        include_older: {
          type: "boolean",
          description: "Default false = recent-first. Set true to include all ages.",
        },
        limit: { type: "integer", description: "Max rows (default 50, max 200)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_recap",
    description:
      "Get the deep quality-distribution recap for a lot by its recap_code " +
      "(color/leaf/staple/mic/gpt/length/uniformity matrices and averages).",
    input_schema: {
      type: "object",
      properties: {
        recap_code: { type: "string" },
        broker: { type: "string", description: "Optional, to disambiguate" },
      },
      required: ["recap_code"],
      additionalProperties: false,
    },
  },
] as const;

const OFFER_COLS =
  "id,broker,origin_country,region,certifications,grade_raw,color,leaf,staple_32nds," +
  "staple_fraction,mic,gpt,length,uniformity,quantity_bales,price_type,price_basis_points," +
  "price_outright_cents,futures_month,crop_year,shipment_period,recap_code,offer_date," +
  "confidence,needs_review,source_email_id,source_attachment_id";

// deno-lint-ignore no-explicit-any
type Filters = Record<string, any>;

export async function runSearchOffers(db: SupabaseClient, f: Filters, nowMs: number) {
  const limit = Math.min(Number(f.limit) || 50, 200);
  let q = db.from("cotton_offers").select(OFFER_COLS);

  if (f.origin_country) q = q.ilike("origin_country", `%${f.origin_country}%`);
  if (f.region) q = q.ilike("region", `%${f.region}%`);
  if (Array.isArray(f.certifications) && f.certifications.length) {
    q = q.overlaps("certifications", f.certifications);
  }
  if (f.grade) q = q.ilike("grade_raw", `%${f.grade}%`);
  if (f.mic_min != null) q = q.gte("mic", f.mic_min);
  if (f.mic_max != null) q = q.lte("mic", f.mic_max);
  if (f.staple_min_32nds != null) q = q.gte("staple_32nds", f.staple_min_32nds);
  if (f.staple_max_32nds != null) q = q.lte("staple_32nds", f.staple_max_32nds);
  if (f.gpt_min != null) q = q.gte("gpt", f.gpt_min);
  if (f.gpt_max != null) q = q.lte("gpt", f.gpt_max);
  if (f.length_min != null) q = q.gte("length", f.length_min);
  if (f.length_max != null) q = q.lte("length", f.length_max);
  if (f.uniformity_min != null) q = q.gte("uniformity", f.uniformity_min);
  if (f.quantity_min_bales != null) q = q.gte("quantity_bales", f.quantity_min_bales);
  if (f.price_outright_max_cents != null) q = q.lte("price_outright_cents", f.price_outright_max_cents);
  if (f.price_basis_max_points != null) q = q.lte("price_basis_points", f.price_basis_max_points);
  if (f.price_type) q = q.eq("price_type", f.price_type);
  if (f.crop_year) q = q.ilike("crop_year", `%${f.crop_year}%`);
  if (f.shipment) q = q.ilike("shipment_period", `%${f.shipment}%`);
  if (f.broker) q = q.ilike("broker", `%${f.broker}%`);
  if (f.date_from) q = q.gte("offer_date", f.date_from);
  if (f.date_to) q = q.lte("offer_date", f.date_to);
  if (f.free_text) q = q.ilike("raw_line_text", `%${f.free_text}%`);

  q = q.order("offer_date", { ascending: false, nullsFirst: false }).limit(limit);

  const { data, error } = await q;
  if (error) return { error: error.message };

  const rows = (data ?? []).map((r) => {
    let age_days: number | null = null;
    if (r.offer_date) {
      age_days = Math.floor((nowMs - Date.parse(r.offer_date)) / 86_400_000);
    }
    return { ...r, age_days };
  });
  return { count: rows.length, offers: rows };
}

export async function runGetRecap(db: SupabaseClient, f: Filters) {
  let q = db.from("cotton_recaps")
    .select("recap_code,broker,crop_year,total_bales,avg_mic,avg_staple,avg_gpt,avg_length,avg_uniformity,distributions,confidence,needs_review,source_email_id,source_attachment_id")
    .eq("recap_code", f.recap_code);
  if (f.broker) q = q.ilike("broker", `%${f.broker}%`);
  const { data, error } = await q.limit(5);
  if (error) return { error: error.message };
  return { recaps: data ?? [] };
}

export async function runOfferTool(
  db: SupabaseClient,
  name: string,
  input: Filters,
  nowMs: number,
): Promise<unknown> {
  if (name === "search_offers") return await runSearchOffers(db, input, nowMs);
  if (name === "get_recap") return await runGetRecap(db, input);
  return { error: `unknown tool ${name}` };
}
