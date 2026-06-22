// JSON Schema for AI cotton-offer extraction (output_config.format).
// Structured-outputs rules: every object has additionalProperties:false and lists
// ALL properties in `required`; optionality is expressed with nullable types
// (["string","null"]) rather than omitting the key. No min/max/length constraints.
// MOST FIELDS NULLABLE by design (D9): broker layouts differ; some have no price.

// Structured outputs cap the number of nullable (union) fields, so instead of
// `["type","null"]` everywhere we use plain types and mark fields OPTIONAL
// (absent when the broker doc doesn't state them). Only a few are required.
const offerProps = {
  line_index: { type: "integer" }, // 1-based position in the source doc (stable for idempotency)
  broker: { type: "string" },
  origin_country: { type: "string" },
  region: { type: "string" },
  certifications: { type: "array", items: { type: "string" } },
  grade_raw: { type: "string" },
  color: { type: "integer" },
  leaf: { type: "integer" },
  staple_32nds: { type: "integer" },
  staple_fraction: { type: "string" },
  mic: { type: "number" },
  gpt: { type: "number" },
  length: { type: "number" },
  uniformity: { type: "number" },
  quantity_bales: { type: "integer" },
  price_type: { type: "string", enum: ["on_call", "outright", "none"] },
  price_basis_points: { type: "number" },
  price_outright_cents: { type: "number" },
  futures_month: { type: "string" },
  crop_year: { type: "string" },
  shipment_period: { type: "string" },
  recap_code: { type: "string" },
  raw_line_text: { type: "string" },
  offer_date: { type: "string" }, // ISO date (YYYY-MM-DD) when stated
  confidence: { type: "number" }, // 0..1 extractor confidence
  needs_review: { type: "boolean" },
} as const;

const recapProps = {
  recap_code: { type: "string" },
  broker: { type: "string" },
  crop_year: { type: "string" },
  total_bales: { type: "integer" },
  avg_mic: { type: "number" },
  avg_staple: { type: "number" },
  avg_gpt: { type: "number" },
  avg_length: { type: "number" },
  avg_uniformity: { type: "number" },
  // Open objects are forbidden, so the matrices come back as a JSON STRING (parsed on store).
  distributions: { type: "string" },
  confidence: { type: "number" },
  needs_review: { type: "boolean" },
} as const;

export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    doc_kind: { type: "string", enum: ["offer_list", "recap", "mixed", "none"] },
    offers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: offerProps,
        required: ["line_index", "price_type", "raw_line_text", "needs_review"],
      },
    },
    recap: {
      type: "object",
      additionalProperties: false,
      properties: recapProps,
      required: ["needs_review"],
    },
  },
  required: ["doc_kind", "offers"],
} as const;

export interface ExtractedOffer {
  line_index: number;
  broker: string | null;
  origin_country: string | null;
  region: string | null;
  certifications: string[] | null;
  grade_raw: string | null;
  color: number | null;
  leaf: number | null;
  staple_32nds: number | null;
  staple_fraction: string | null;
  mic: number | null;
  gpt: number | null;
  length: number | null;
  uniformity: number | null;
  quantity_bales: number | null;
  price_type: "on_call" | "outright" | "none";
  price_basis_points: number | null;
  price_outright_cents: number | null;
  futures_month: string | null;
  crop_year: string | null;
  shipment_period: string | null;
  recap_code: string | null;
  raw_line_text: string | null;
  offer_date: string | null;
  confidence: number | null;
  needs_review: boolean;
}

export interface ExtractedRecap {
  recap_code: string | null;
  broker: string | null;
  crop_year: string | null;
  total_bales: number | null;
  avg_mic: number | null;
  avg_staple: number | null;
  avg_gpt: number | null;
  avg_length: number | null;
  avg_uniformity: number | null;
  distributions: string | null; // JSON string; parsed on store
  confidence: number | null;
  needs_review: boolean;
}

export interface ExtractionResult {
  doc_kind: "offer_list" | "recap" | "mixed" | "none";
  offers: ExtractedOffer[];
  recap: ExtractedRecap | null;
}

export const EXTRACTION_INSTRUCTIONS = `You are a cotton-trading offer extraction engine. You read broker offer documents
(PDF, spreadsheet, or email body) and extract every distinct cotton offer line into a
strict JSON structure. Broker layouts differ wildly and many offers omit fields — that
is expected. Follow these rules:

- Extract one entry in "offers" per distinct offer line / lot. If a document is purely a
  detailed quality recap (distribution tables for a single lot), put it in "recap" and
  set doc_kind accordingly; a document may be "mixed".
- Number offers with "line_index" by their top-to-bottom order in the document, starting
  at 1. Keep this stable so the same document always numbers the same way.
- Copy the verbatim source line into "raw_line_text" (used for audit + re-interpretation).
- NEVER invent values. If a field is not present, use null. Do not guess a price.
- "price_type": "on_call" when priced on a futures basis (e.g. "+1700 on Dec"), set
  price_basis_points and futures_month. "outright" when a fixed c/lb price is given, set
  price_outright_cents. "none" when no price is present.
- Interpret grade/color/leaf/staple, certifications, origin, mic, staple, gpt, length,
  uniformity, crop year, and shipment using the REFERENCE DOCUMENTS provided as grounding
  context. Always also keep the raw grade string verbatim in "grade_raw".
- Set per-offer "confidence" (0..1) and "needs_review"=true when the layout is ambiguous,
  a value is unclear, or grounding context is insufficient. Conservative is better than
  confidently wrong — a wrong mic/staple/price the trader bids on destroys trust.
- "offer_date": ISO YYYY-MM-DD if the document states an offer/quote date; else null
  (the system falls back to the email date).`;
