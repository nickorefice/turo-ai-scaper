#!/usr/bin/env node
import { chromium } from "patchright";

const LOCATION = {
  label: "Austin, TX",
  latitude: 30.267153,
  longitude: -97.7430608,
  placeId: "ChIJLwPMoJm1RIYRetVp1EtGm10",
  region: "TX",
  country: "US",
};
const DAYS = 3;
const MAKE = "Volkswagen";
const MODELS = ["Tiguan", "Tiguan Limited"];
const ALLOWED_CITY_SLUGS = ["austin-tx"];

function ymd(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function mdy(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${yyyy}`;
}

function buildSearchUrl({ start_date_mdy, end_date_mdy }) {
  // Mirrors the URL Turo's frontend constructs after resolving the location.
  // The `models` key is repeated once per model name.
  const params = new URLSearchParams();
  params.set("country", LOCATION.country);
  params.set("defaultZoomLevel", "11");
  params.set("endDate", end_date_mdy);
  params.set("endTime", "10:00");
  params.set("flexibleType", "NOT_FLEXIBLE");
  params.set("isMapSearch", "false");
  params.set("itemsPerPage", "200");
  params.set("latitude", String(LOCATION.latitude));
  params.set("location", LOCATION.label);
  params.set("locationType", "CITY");
  params.set("longitude", String(LOCATION.longitude));
  params.set("makes", MAKE);
  for (const m of MODELS) params.append("models", m);
  params.set("pickupType", "ALL");
  params.set("placeId", LOCATION.placeId);
  params.set("region", LOCATION.region);
  params.set("searchDurationType", "DAILY");
  params.set("sortType", "RELEVANCE");
  params.set("startDate", start_date_mdy);
  params.set("startTime", "10:00");
  return `https://turo.com/us/en/search?${params.toString()}`;
}

async function scrapeVisibleCards(page) {
  return page.evaluate(() => {
    const out = [];
    for (const link of document.querySelectorAll('[data-testid="vehicle-card-link-box"]')) {
      const href = link.getAttribute("href") || "";
      const idMatch = href.match(/\/(\d+)(?:\?|$)/);
      const id = idMatch ? idMatch[1] : null;
      if (!id) continue;

      const img = link.querySelector("img");
      const alt = (img?.getAttribute("alt") || "").trim();
      const altMatch = alt.match(/^(.+?)\s+(\d{4})$/);
      let make = "Unknown", model = "Unknown", year = 0;
      if (altMatch) {
        const nameParts = altMatch[1].split(/\s+/);
        make = nameParts[0];
        model = nameParts.slice(1).join(" ");
        year = parseInt(altMatch[2], 10);
      }

      // Price container has 1 span (no discount) or 2 spans (orig + discounted "$NNN total").
      const priceWrap = link.querySelector('[data-testid="vehicle-discount-and-price"]');
      const spans = priceWrap ? [...priceWrap.querySelectorAll("span")] : [];
      const dollars = spans
        .map((s) => {
          const m = (s.textContent || "").match(/\$([\d,]+(?:\.\d+)?)/);
          return m ? parseFloat(m[1].replace(/,/g, "")) : null;
        })
        .filter((n) => n !== null);

      let total_original = 0;
      let total_charged = 0;
      if (dollars.length >= 2) {
        total_original = dollars[0];
        total_charged = dollars[dollars.length - 1];
      } else if (dollars.length === 1) {
        total_original = dollars[0];
        total_charged = dollars[0];
      }

      const fullHref = href.startsWith("http") ? href : `https://turo.com${href}`;
      // URL pattern: /us/en/{type}-rental/united-states/{city-slug}/{make}/{model}/{id}
      const cityMatch = href.match(/\/united-states\/([^/]+)\//);
      const city_slug = cityMatch ? cityMatch[1] : null;
      out.push({ id, make, model, year, total_original, total_charged, city_slug, listing_url: fullHref });
    }
    return out;
  });
}

async function scrollAndCollect(page, { maxRounds = 60, idleRounds = 5, pause = 900 } = {}) {
  const collected = new Map();
  let idle = 0;
  let prevSize = 0;

  // initial scrape before scrolling
  for (const c of await scrapeVisibleCards(page)) collected.set(c.id, c);

  for (let i = 0; i < maxRounds; i++) {
    await page.evaluate(() => {
      const scroller =
        document.querySelector('[data-testid="virtuoso-scroller"]') ||
        document.querySelector('[data-testid="searchResultsListViewWrapper"]') ||
        document.scrollingElement;
      if (scroller && scroller.scrollBy) scroller.scrollBy(0, 1500);
      window.scrollBy(0, 1500);
    });
    await page.waitForTimeout(pause);
    for (const c of await scrapeVisibleCards(page)) collected.set(c.id, c);

    if (collected.size === prevSize) {
      idle++;
      if (idle >= idleRounds) break;
    } else {
      idle = 0;
      prevSize = collected.size;
    }
  }
  return [...collected.values()];
}

async function scrapeHost(page, listingUrl) {
  await page.goto(listingUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);

  // Title pattern: "Volkswagen Tiguan 2024 rental in Austin, TX by Mikhail (Austin's Best Host) | Turo"
  const title = await page.title();
  const m = title.match(/\s+by\s+(.+?)\s*\|\s*Turo$/i);
  if (m) return m[1].trim();

  // Fallback: scan body for "Hosted by <name>"
  return page.evaluate(() => {
    const body = document.body.innerText || "";
    const m = body.match(/Hosted by[\s\S]{0,80}?([A-Z][A-Za-z'’.\- ]{1,40}?)(?:\d|\n|All-Star)/);
    return m ? m[1].trim() : null;
  });
}

function nextWeekendWindow(today = new Date()) {
  const d = new Date(today);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun ... 5=Fri ... 6=Sat
  // next Friday >= today (today if today is Friday)
  const daysUntilFri = (5 - dow + 7) % 7;
  const friday = new Date(d);
  friday.setDate(d.getDate() + daysUntilFri);
  const monday = new Date(friday);
  monday.setDate(friday.getDate() + 3);
  return { start: friday, end: monday, days: 3 };
}

async function main() {
  const today = new Date();
  let start, end, days;
  const mode = process.env.MODE || "next-weekend";
  if (mode === "next-weekend") {
    ({ start, end, days } = nextWeekendWindow(today));
  } else {
    start = today;
    end = new Date(today);
    end.setDate(end.getDate() + DAYS);
    days = DAYS;
  }

  const start_date = ymd(start);
  const end_date = ymd(end);
  const start_date_mdy = mdy(start);
  const end_date_mdy = mdy(end);

  const url = buildSearchUrl({ start_date_mdy, end_date_mdy });
  console.error(`[mode=${mode}] ${LOCATION.label} ${start_date} -> ${end_date} (${days}d) ${MAKE} / ${MODELS.join(", ")}`);
  console.error(`URL: ${url}`);

  const headless = process.env.HEADLESS === "1";
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    const found = await page
      .waitForSelector('[data-testid="vehicle-card-link-box"]', { timeout: 30000 })
      .catch(() => null);
    console.error(`Initial card wait: ${found ? "ok" : "timeout"}`);
    await page.waitForTimeout(2000);

    const all = await scrollAndCollect(page);
    console.error(`Collected ${all.length} unique cards from filtered search`);

    if (all.length === 0) {
      const dbg = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        bodyTextStart: document.body.innerText.replace(/\s+/g, " ").slice(0, 400),
      }));
      console.error("Debug:", JSON.stringify(dbg, null, 2));
    }

    // Server-side filter does the work, but keep a defensive client-side check
    // in case Turo ever returns adjacent suggestions.
    const tiguansAll = all.filter((l) => {
      const make = l.make.toLowerCase();
      const model = l.model.toLowerCase();
      return make.includes(MAKE.toLowerCase()) && MODELS.some((m) => model.includes(m.toLowerCase().split(" ")[0]));
    });
    const tiguans = tiguansAll.filter((l) => ALLOWED_CITY_SLUGS.includes(l.city_slug));
    const dropped = tiguansAll.length - tiguans.length;
    console.error(`Confirmed ${tiguansAll.length} Tiguan(s); kept ${tiguans.length} in [${ALLOWED_CITY_SLUGS.join(", ")}], dropped ${dropped} from other cities`);

    // Fetch host name from each Tiguan's detail page (sequential to avoid bot heat)
    for (const t of tiguans) {
      try {
        t.host_name = await scrapeHost(page, t.listing_url);
      } catch (err) {
        t.host_name = null;
      }
    }

    const output = {
      generated_at: new Date().toISOString(),
      mode,
      query: {
        location: LOCATION.label,
        start_date,
        end_date,
        days,
        make: MAKE,
        models: MODELS,
        search_url: url,
      },
      total_listings_returned: all.length,
      tiguans_before_city_filter: tiguansAll.length,
      tiguan_count: tiguans.length,
      allowed_city_slugs: ALLOWED_CITY_SLUGS,
      tiguans: tiguans.map((t) => ({
        listing_id: t.id,
        year: t.year,
        make: t.make,
        model: t.model,
        city_slug: t.city_slug,
        host_name: t.host_name || null,
        total_charged_usd: t.total_charged,
        total_original_usd: t.total_original,
        avg_daily_usd: Number((t.total_charged / days).toFixed(2)),
        listing_url: t.listing_url,
      })),
    };
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Fatal:", err?.stack || err);
  process.exit(1);
});
