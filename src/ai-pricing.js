// AI pricing advisor for the daily email.
//
// Turns one car group's discovered windows into:
//   - a brief, fluff-free top-of-email summary, and
//   - a suggested daily price per window.
//
// Strategy is RULE-FIRST: code computes a deterministic baseline
// (lowest competitor avg_daily − $1) for each window. OpenAI may refine each
// price with a stated reason, but every AI number is validated + clamped so a
// bad value can never ship. If the API key is missing or the call fails, we
// fall back to the deterministic baseline for every window and omit the summary
// — the email is never blocked by the AI.
//
// Key: OPENAI_API_KEY (read by the caller from ~/.config/turo-scraper/.env).

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = "gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 30000;

// Clamp band around the baseline (see clampSuggestion).
const PRICE_FLOOR = 15; // never suggest below this
const MAX_UNDERCUT = 9; // never suggest more than $9 under the lowest competitor

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Competitor stats for one window's listings (mirrors send-email's computeStats,
// kept local so this module is self-contained).
function competitorStats(listings) {
  const dailies = (listings || [])
    .filter((t) => !t.is_mine)
    .map((t) => t.avg_daily_usd)
    .filter((n) => typeof n === "number" && Number.isFinite(n));
  if (dailies.length === 0) return { n: 0, min: null, max: null, median: null, dailies: [] };
  const sorted = [...dailies].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return {
    n: dailies.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: round2(median),
    dailies: sorted,
  };
}

// Deterministic baseline: $1 under the lowest comparable competitor.
// null when there are no competitors to anchor to.
export function computeBaseline(windowData) {
  const stats = competitorStats(windowData?.listings);
  if (stats.n === 0 || stats.min == null) return null;
  return round2(stats.min - 1);
}

// Keep an AI-proposed price honest: finite, never above the lowest competitor,
// never wildly below it, never under the floor. Falls back to baseline on junk.
function clampSuggestion(proposed, stats, baseline) {
  if (baseline == null || stats.min == null) return null; // no anchor → no suggestion
  if (typeof proposed !== "number" || !Number.isFinite(proposed)) return baseline;
  const hi = round2(stats.min); // never price above the cheapest comp
  const lo = Math.max(PRICE_FLOOR, round2(stats.min - MAX_UNDERCUT));
  return round2(Math.min(hi, Math.max(lo, proposed)));
}

function buildPayload({ group, windows }) {
  return {
    car: group.label,
    location: "Austin, TX",
    pricing_rule:
      "Recommend a daily price that will actually BOOK — generally about $1 below the lowest comparable competitor for the window. Be more conservative (closer to the lowest comp) when there are few competitors. Weekends can support slightly more than weekdays.",
    windows: windows.map(({ id, data }) => {
      const stats = competitorStats(data.listings);
      const mine = (data.listings || [])
        .filter((t) => t.is_mine)
        .map((t) => ({ label: `${t.year} ${t.model}`, daily: t.avg_daily_usd }));
      // Signal strength is decided in code so the model never mislabels it.
      const signal = stats.n === 0 ? "none" : stats.n <= 2 ? "weak" : stats.n <= 4 ? "moderate" : "strong";
      return {
        window_id: id,
        label: data.window_label,
        start_date: data.query?.start_date,
        end_date: data.query?.end_date,
        days: data.query?.days,
        my_current_prices: mine,
        i_am_listed: mine.length > 0,
        my_listed_count: mine.length,
        my_total_cars: group.listings.length,
        competitors_n: stats.n,
        signal,
        median: stats.median,
        min: stats.min,
        max: stats.max,
        competitor_dailies: stats.dailies,
        baseline: computeBaseline(data),
      };
    }),
  };
}

const SYSTEM_PROMPT = `You are a Turo pricing assistant for a small fleet of cars in Austin, TX. Your job: for each rental window, recommend a daily price that will ACTUALLY BOOK.

Rules:
- The lowest comparable price for a window is its "min" field — NOT the median. Anchor every recommendation to "min". When you reference a competitor price in prose, use "min".
- Each window includes a precomputed "baseline" (= min − 1). Default suggested_price to that baseline. You may deviate by a dollar or two with a reason, but suggested_price must NEVER exceed the window's "min". Going above "min" is forbidden.
- Default to about $1 below the lowest comparable competitor's daily price for that window.
- Each window includes a precomputed "signal" field ("strong" | "moderate" | "weak" | "none"). USE IT VERBATIM — never re-judge or contradict it. Only call data "thin"/"weak" when signal is "weak". When signal is "weak", stay close to the lowest comp and don't undercut aggressively.
- Weekends (3-night) can support a touch more than weekdays; account for it lightly.
- If the owner is already priced well below market, still recommend the booking-optimal price (it may be higher than what they charge today) and note the headroom in the summary.
- Never recommend a price above the lowest competitor for that window.
- Windows with no competitors (N=0): omit them from your output.

The summary must be specific and actionable — write for two owners (Nick & Kenny) skimming on a phone who need to act, not be reassured:
- 2-4 short sentences MAX. No greetings, no recap of the data, no generic phrases like "adjust for competitiveness" or "headroom available".
- Name the actual windows and cite real dollar numbers (current price -> suggested price).
- Any price you recommend in the summary MUST equal the suggested_price you output for that same window — never cite the median or a competitor's price as the recommendation.
- Lead with the biggest single opportunity (largest gap between current and suggested).
- Listing status is precomputed: only say a window is "unlisted" / "add it" when its "i_am_listed" is false. If "my_listed_count" is below "my_total_cars" but >0, you may note "only one of your cars is listed" — but never claim a window is unlisted when i_am_listed is true.
- Do NOT mention competitor counts, "N", "signal", "thin/weak data", or data quality in the summary. The signal only informs YOUR price choices, never the prose.

Output STRICT JSON only, no prose outside JSON, in this exact shape:
{
  "summary": "e.g. 'Wk1 weekdays is the big miss: you're at $66.5 vs a lone $119.75 comp — list at ~$118. Most weekdays you're $15-50 under the single comparable car; match to ~$1 under it. Thin data (N=1) on Wk1-3, so don't over-raise. You're unlisted Wk1 weekend and Wk2 weekdays — add them.'",
  "windows": [
    { "window_id": "w1-weekdays", "suggested_price": 118.75, "reason": "one short clause" }
  ]
}`;

async function callOpenAI(apiKey, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(payload) },
        ],
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text);
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI response had no message content");
    return JSON.parse(content);
  } finally {
    clearTimeout(timer);
  }
}

// Returns { summary: string|null, suggestionsByWindowId: Map<window_id, { price, reason }> }.
// price is a number, or null for windows with no competitor anchor.
export async function getPricingAdvice({ group, windows, apiKey }) {
  // Deterministic baseline for every window — this is also the fallback.
  const statsById = new Map();
  const suggestionsByWindowId = new Map();
  for (const { id, data } of windows) {
    const stats = competitorStats(data.listings);
    statsById.set(id, stats);
    const baseline = computeBaseline(data);
    suggestionsByWindowId.set(id, { price: baseline, reason: null });
  }

  if (!apiKey) {
    console.error("OPENAI_API_KEY missing — using deterministic baseline prices, no AI summary.");
    return { summary: null, suggestionsByWindowId };
  }

  try {
    const payload = buildPayload({ group, windows });
    const ai = await callOpenAI(apiKey, payload);

    for (const w of ai?.windows || []) {
      const id = w?.window_id;
      if (!id || !suggestionsByWindowId.has(id)) continue;
      const stats = statsById.get(id);
      const baseline = suggestionsByWindowId.get(id).price;
      const clamped = clampSuggestion(w.suggested_price, stats, baseline);
      suggestionsByWindowId.set(id, {
        price: clamped,
        reason: typeof w.reason === "string" ? w.reason : null,
      });
    }

    const summary = typeof ai?.summary === "string" && ai.summary.trim() ? ai.summary.trim() : null;
    return { summary, suggestionsByWindowId };
  } catch (err) {
    console.error(`AI pricing failed (${err.message}) — falling back to deterministic baseline.`);
    return { summary: null, suggestionsByWindowId };
  }
}
