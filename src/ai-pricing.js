// AI pricing advisor for the daily email.
//
// Turns one car group's discovered windows into:
//   - a brief, fluff-free top-of-email summary, and
//   - a suggested BASE daily price per window (the number to type into Turo).
//
// Economics (all deterministic, computed in code):
//   - effective target = lowest competitor avg_daily − $1  (the displayed price
//     that books; competitor prices are already net of their discounts).
//   - base to enter   = effective ÷ (1 − trip-length discount). Turo applies the
//     host's discount on top of the base, so the base must be grossed up for the
//     displayed price to land where we want.
//   - host share      = looked up from the Austin dynamic-share schedule by the
//     guest's booking lead time (More earnings plan: 85% near-term → 100% at
//     28+ days). net/day = effective × share.
//   - a price floor keeps suggestions sane given the $2,500 damage responsibility.
//
// Strategy is RULE-FIRST: code computes the base price; OpenAI may nudge within a
// clamped band and writes the summary (prioritizing the high-share far windows).
// If the key is missing or the call fails, we fall back to the deterministic base
// price for every window and omit the summary — the email is never blocked.
//
// Key: OPENAI_API_KEY (read by the caller from ~/.config/turo-scraper/.env).

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = "gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 30000;

// Effective-price clamp band (before the discount gross-up).
const PRICE_FLOOR = 15; // never suggest an effective price below this
const MAX_UNDERCUT = 9; // never suggest more than $9 under the lowest competitor

function round2(n) {
  return Math.round(n * 100) / 100;
}

function daysBetween(fromYmd, toYmd) {
  const a = new Date(fromYmd + "T00:00:00Z").getTime();
  const b = new Date(toYmd + "T00:00:00Z").getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

// Highest matching tier wins (schedule keyed by min_lead_days). Defaults to 1.0
// (treat as full share) when no schedule is configured.
function lookupShare(schedule, leadDays) {
  if (!Array.isArray(schedule) || schedule.length === 0 || leadDays == null) return null;
  const sorted = [...schedule].sort((x, y) => y.min_lead_days - x.min_lead_days);
  for (const tier of sorted) if (leadDays >= tier.min_lead_days) return tier.share;
  return sorted[sorted.length - 1].share;
}

// Trip-length discount that applies to a trip of `days` nights (highest matching
// min_days wins). For 3-4 night windows this resolves to the daily (3%) tier.
function discountForDays(tripLengthTiers, days) {
  if (!Array.isArray(tripLengthTiers) || tripLengthTiers.length === 0) return 0;
  const sorted = [...tripLengthTiers].sort((x, y) => y.min_days - x.min_days);
  for (const tier of sorted) if (days >= tier.min_days) return tier.pct || 0;
  return 0;
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

// All deterministic per-window economics. base values are null when there is no
// competitor to anchor to.
function windowEconomics({ data, discounts, schedule, turoMarkup, runDate }) {
  const stats = competitorStats(data.listings);
  const days = data.query?.days || 0;
  const discountPct = discountForDays(discounts?.trip_length, days);
  const leadDays = data.query?.start_date ? daysBetween(runDate, data.query.start_date) : null;
  const share = lookupShare(schedule, leadDays);
  // Calendar base -> booking price = (1 − trip discount) × (1 − Turo's extra
  // search markup). Grossing the booking target up by both recovers the price
  // to SET in the calendar. (Empirically booking ≈ 92% of calendar.)
  const markup = typeof turoMarkup === "number" ? turoMarkup : 0;
  const grossUp = (eff) => (eff == null ? null : round2(eff / ((1 - discountPct) * (1 - markup))));

  let defaultEffective = null, defaultBase = null, maxBase = null, floorBase = null, net = null;
  if (stats.n > 0 && stats.min != null) {
    defaultEffective = round2(stats.min - 1);
    defaultBase = grossUp(defaultEffective);
    maxBase = grossUp(round2(stats.min)); // effective never above the cheapest comp
    floorBase = grossUp(Math.max(PRICE_FLOOR, round2(stats.min - MAX_UNDERCUT)));
    net = share == null ? null : round2(defaultEffective * share);
  }
  return { stats, days, discountPct, leadDays, share, defaultEffective, defaultBase, maxBase, floorBase, net };
}

// Keep an AI-proposed BASE price honest: finite, within [floorBase, maxBase].
// Falls back to the default base on junk.
function clampBase(proposed, econ) {
  if (econ.defaultBase == null) return null; // no anchor → no suggestion
  if (typeof proposed !== "number" || !Number.isFinite(proposed)) return econ.defaultBase;
  return round2(Math.min(econ.maxBase, Math.max(econ.floorBase, proposed)));
}

function buildPayload({ group, windows, econByWindow, damageResponsibility }) {
  return {
    car: group.label,
    location: "Austin, TX",
    earnings_plan: `More earnings plan: dynamic host share by booking lead time (host_share field per window; ~100% at 28+ days out). Damage responsibility $${damageResponsibility || 2500} per incident.`,
    note: "suggested_price is the BASE daily price the owner types into Turo. Competitor prices are already discounted; the base is grossed up so the displayed price lands ~$1 under the cheapest comp.",
    windows: windows.map(({ id, data }) => {
      const econ = econByWindow.get(id);
      const mine = (data.listings || [])
        .filter((t) => t.is_mine)
        .map((t) => ({ label: `${t.year} ${t.model}`, daily: t.avg_daily_usd }));
      const signal = econ.stats.n === 0 ? "none" : econ.stats.n <= 2 ? "weak" : econ.stats.n <= 4 ? "moderate" : "strong";
      return {
        window_id: id,
        label: data.window_label,
        days: data.query?.days,
        my_current_prices: mine,
        i_am_listed: mine.length > 0,
        my_listed_count: mine.length,
        my_total_cars: group.listings.length,
        signal,
        lowest_comp_effective: econ.stats.min,
        discount_pct: econ.discountPct,
        suggested_base_default: econ.defaultBase, // base price to ENTER (already grossed up)
        max_base: econ.maxBase,
        floor_base: econ.floorBase,
        lead_days: econ.leadDays,
        host_share: econ.share,
        net_per_day_at_default: econ.net,
        high_value: econ.share != null && econ.share >= 0.98,
      };
    }),
  };
}

const SYSTEM_PROMPT = `You are a Turo pricing assistant for a small fleet in Austin, TX. The owners (Nick & Kenny) are on the "More earnings" plan: their host share rises with how far ahead a guest books, reaching ~100% at 28+ days out, but they carry a damage responsibility per incident (see earnings_plan in the data).

For each window you are given precomputed economics. Do NOT recompute them — use the fields as given:
- "suggested_base_default" is the BASE daily price to enter in Turo (already grossed up for the owner's discount so the displayed price lands ~$1 under "lowest_comp_effective"). Default suggested_price to this.
- You MAY nudge suggested_price within [floor_base, max_base] with a short reason, but never outside that band.
- "host_share" is the fraction the owner keeps if booked at the current lead time; "high_value": true means a ~100%-share window (booked far ahead).
- "signal" ("strong"|"moderate"|"weak"|"none") is the competitor-data strength. When "weak", stay near suggested_base_default.

Pricing/strategy logic:
- Anchor to suggested_base_default. Output suggested_price as the BASE price.
- Omit windows with no competitors (signal "none") from your output.

Write the summary for two owners skimming on a phone who need to act:
- 2-4 short sentences MAX. No greetings, no data recap, no generic filler ("adjust for competitiveness", "headroom available").
- Cite BASE prices (the suggested_price you output) and the owner's current price. Every price you cite MUST equal a suggested_price you output — never cite the comp or median as the recommendation.
- Lead with the biggest gap between current price and suggested base.
- PRIORITIZE the high_value windows: a booking 28+ days out earns ~100%, so explicitly flag the best high_value window to lock in early.
- Listing status is precomputed: only say "unlisted"/"add it" when "i_am_listed" is false; if my_listed_count is below my_total_cars but >0 you may note "only one of your cars is listed". Never claim a window is unlisted when i_am_listed is true.
- Do NOT mention competitor counts, "N", "signal", "thin/weak data", or data quality.

Output STRICT JSON only, no prose outside JSON, in this exact shape:
{
  "summary": "e.g. 'Wk1 weekdays is the big miss: you're at $66.5, list base ~$122. Wk4 is your priority — booked 28+ days out you keep ~100%, so lock it in at base ~$76. You're unlisted Wk1 weekend; add it.'",
  "windows": [
    { "window_id": "w1-weekdays", "suggested_price": 122.42, "reason": "one short clause" }
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

// Returns { summary: string|null, suggestionsByWindowId: Map<window_id, entry> }
// where entry = { price (base $ to enter), reason, share, net, leadDays, discountPct }.
// price is null for windows with no competitor anchor.
export async function getPricingAdvice({ group, windows, apiKey, discounts, hostShareSchedule, turoMarkup, damageResponsibility, runDate }) {
  const econByWindow = new Map();
  const suggestionsByWindowId = new Map();
  for (const { id, data } of windows) {
    const econ = windowEconomics({ data, discounts, schedule: hostShareSchedule, turoMarkup, runDate });
    econByWindow.set(id, econ);
    suggestionsByWindowId.set(id, {
      price: econ.defaultBase,
      reason: null,
      share: econ.share,
      net: econ.net,
      leadDays: econ.leadDays,
      discountPct: econ.discountPct,
    });
  }

  if (!apiKey) {
    console.error("OPENAI_API_KEY missing — using deterministic base prices, no AI summary.");
    return { summary: null, suggestionsByWindowId };
  }

  try {
    const payload = buildPayload({ group, windows, econByWindow, damageResponsibility });
    const ai = await callOpenAI(apiKey, payload);

    for (const w of ai?.windows || []) {
      const id = w?.window_id;
      if (!id || !suggestionsByWindowId.has(id)) continue;
      const econ = econByWindow.get(id);
      const prev = suggestionsByWindowId.get(id);
      suggestionsByWindowId.set(id, {
        ...prev,
        price: clampBase(w.suggested_price, econ),
        reason: typeof w.reason === "string" ? w.reason : null,
      });
    }

    const summary = typeof ai?.summary === "string" && ai.summary.trim() ? ai.summary.trim() : null;
    return { summary, suggestionsByWindowId };
  } catch (err) {
    console.error(`AI pricing failed (${err.message}) — falling back to deterministic base price.`);
    return { summary: null, suggestionsByWindowId };
  }
}
