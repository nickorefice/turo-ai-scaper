#!/usr/bin/env node
import { chromium } from "patchright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const LOCATION = {
  label: "Austin, TX",
  latitude: 30.267153,
  longitude: -97.7430608,
  placeId: "ChIJLwPMoJm1RIYRetVp1EtGm10",
  region: "TX",
  country: "US",
};
const MAKE = "Volkswagen";
const MODELS = ["Tiguan", "Tiguan Limited"];
const ALLOWED_CITY_SLUGS = ["austin-tx"];

const WINDOW_SPECS = {
  a: { id: "a", days: 3, offset_days: 1, label: "window-a-3day" }, // pickup today+1, return today+4
  b: { id: "b", days: 4, offset_days: 4, label: "window-b-4day" }, // pickup today+4, return today+8
};

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

function addDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function loadMyListings() {
  const path = join(REPO_ROOT, "config", "my-listings.json");
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    const map = new Map();
    for (const item of parsed.listings || []) {
      if (item.listing_id) map.set(String(item.listing_id), item.label || String(item.listing_id));
    }
    console.error(`Loaded ${map.size} owner listing(s) from config/my-listings.json`);
    return { owner_label: parsed.owner_label || null, map };
  } catch (err) {
    console.error(`WARN: could not load config/my-listings.json: ${err.message}`);
    return { owner_label: null, map: new Map() };
  }
}

function buildSearchUrl({ start_date_mdy, end_date_mdy }) {
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

  const title = await page.title();
  const m = title.match(/\s+by\s+(.+?)\s*\|\s*Turo$/i);
  if (m) return m[1].trim();

  return page.evaluate(() => {
    const body = document.body.innerText || "";
    const m = body.match(/Hosted by[\s\S]{0,80}?([A-Z][A-Za-z'’.\- ]{1,40}?)(?:\d|\n|All-Star)/);
    return m ? m[1].trim() : null;
  });
}

async function runWindow({ searchPage, hostPage, spec, today, myListings }) {
  const start = addDays(today, spec.offset_days);
  const end = addDays(start, spec.days);
  const start_date = ymd(start);
  const end_date = ymd(end);
  const start_date_mdy = mdy(start);
  const end_date_mdy = mdy(end);

  const url = buildSearchUrl({ start_date_mdy, end_date_mdy });
  console.error(`[window=${spec.id}] ${LOCATION.label} ${start_date} -> ${end_date} (${spec.days}d) ${MAKE} / ${MODELS.join(", ")}`);
  console.error(`  URL: ${url}`);

  const maxAttempts = 3;
  let all = [];
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await searchPage.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await searchPage.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
      const found = await searchPage
        .waitForSelector('[data-testid="vehicle-card-link-box"]', { timeout: 30000 })
        .catch(() => null);
      console.error(`  attempt ${attempt}/${maxAttempts}: initial card wait ${found ? "ok" : "timeout"}`);
      await searchPage.waitForTimeout(2000);

      all = await scrollAndCollect(searchPage);
      console.error(`  attempt ${attempt}: collected ${all.length} unique cards`);
      if (all.length > 0) break;
      lastErr = new Error("0 cards collected");
    } catch (err) {
      lastErr = err;
      console.error(`  attempt ${attempt} failed: ${err.message}`);
    }
    if (attempt < maxAttempts) await searchPage.waitForTimeout(3000);
  }

  if (all.length === 0) {
    const dbg = await searchPage.evaluate(() => ({
      url: location.href,
      title: document.title,
      bodyTextStart: document.body.innerText.replace(/\s+/g, " ").slice(0, 400),
    }));
    console.error(`  giving up after ${maxAttempts} attempts. Debug:`, JSON.stringify(dbg));
  }

  const tiguansAll = all.filter((l) => {
    const make = l.make.toLowerCase();
    const model = l.model.toLowerCase();
    return make.includes(MAKE.toLowerCase()) && MODELS.some((m) => model.includes(m.toLowerCase().split(" ")[0]));
  });
  const tiguans = tiguansAll.filter((l) => ALLOWED_CITY_SLUGS.includes(l.city_slug));
  const dropped = tiguansAll.length - tiguans.length;
  console.error(`  confirmed ${tiguansAll.length} Tiguan(s); kept ${tiguans.length} in [${ALLOWED_CITY_SLUGS.join(", ")}], dropped ${dropped}`);

  for (const t of tiguans) {
    try {
      t.host_name = await scrapeHost(hostPage, t.listing_url);
    } catch (err) {
      t.host_name = null;
    }
  }

  return {
    generated_at: new Date().toISOString(),
    window_id: spec.id,
    window_label: spec.label,
    query: {
      location: LOCATION.label,
      start_date,
      end_date,
      days: spec.days,
      make: MAKE,
      models: MODELS,
      search_url: url,
    },
    total_listings_returned: all.length,
    tiguans_before_city_filter: tiguansAll.length,
    tiguan_count: tiguans.length,
    allowed_city_slugs: ALLOWED_CITY_SLUGS,
    owner_label: myListings.owner_label,
    tiguans: tiguans.map((t) => {
      const isMine = myListings.map.has(t.id);
      return {
        listing_id: t.id,
        year: t.year,
        make: t.make,
        model: t.model,
        city_slug: t.city_slug,
        host_name: t.host_name || null,
        is_mine: isMine,
        mine_label: isMine ? myListings.map.get(t.id) : null,
        total_charged_usd: t.total_charged,
        total_original_usd: t.total_original,
        avg_daily_usd: Number((t.total_charged / spec.days).toFixed(2)),
        listing_url: t.listing_url,
      };
    }),
  };
}

async function main() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const runDate = ymd(today);

  const requested = (process.env.WINDOW || "all").toLowerCase();
  const windows = requested === "all" ? ["a", "b"] : [requested];
  for (const w of windows) {
    if (!WINDOW_SPECS[w]) {
      console.error(`Unknown WINDOW=${w}; must be one of: a, b, all`);
      process.exit(2);
    }
  }

  const outDir = process.env.OUT_DIR || join(REPO_ROOT, "data");
  const writeFiles = process.env.NO_WRITE !== "1";
  if (writeFiles) mkdirSync(outDir, { recursive: true });

  const myListings = loadMyListings();

  const headless = process.env.HEADLESS === "1";
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const searchPage = await ctx.newPage();
  const hostPage = await ctx.newPage();

  const results = [];
  try {
    for (const w of windows) {
      const spec = WINDOW_SPECS[w];
      const result = await runWindow({ searchPage, hostPage, spec, today, myListings });
      results.push(result);

      if (writeFiles) {
        const outPath = join(outDir, `AUS-Tiguans-${runDate}-${spec.label}.json`);
        writeFileSync(outPath, JSON.stringify(result, null, 2));
        console.error(`  wrote ${outPath}`);
      }
    }
  } finally {
    await browser.close();
  }

  // Single-window invocations: also emit JSON on stdout for ad-hoc piping
  if (windows.length === 1) {
    process.stdout.write(JSON.stringify(results[0], null, 2) + "\n");
  } else {
    // Summary line for multi-window runs (file paths only; data is in the files)
    process.stdout.write(
      JSON.stringify(
        {
          run_date: runDate,
          windows: results.map((r) => ({
            window_id: r.window_id,
            tiguan_count: r.tiguan_count,
            start_date: r.query.start_date,
            end_date: r.query.end_date,
          })),
        },
        null,
        2
      ) + "\n"
    );
  }
}

main().catch((err) => {
  console.error("Fatal:", err?.stack || err);
  process.exit(1);
});
