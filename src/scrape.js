#!/usr/bin/env node
// Multi-group Turo competitor scraper with persistent host-name cache.
//
// Reads config/my-listings.json (groups[] schema). For each group, runs a Turo
// search for that make + models in Austin across 8 date windows (4 weekdays
// Mon–Thu + 4 weekend Fri–Mon blocks, anchored to the next Monday strictly
// after today). For each result, looks up the host name from data/host-cache.json
// first; only visits the listing's detail page when the cache is cold or stale
// (>30 days old). Writes one JSON file per (group, window) into data/.
//
// Env vars:
//   GROUP_ID    — restrict to a single group (e.g. "tiguans", "taos"). Default: all groups.
//   WINDOW      — "all" (default), a single window id (e.g. "w1-weekdays"), or
//                 a comma-separated list (e.g. "w1-weekdays,w1-weekend").
//   OUT_DIR     — output directory (default: data/ at repo root).
//   NO_WRITE=1  — skip file writes (still prints JSON summary to stdout).
//   HEADLESS=1  — run Chromium headless (default: visible window for bot-detection avoidance).
//
// Output filename: AUS-{group_id}-YYYY-MM-DD-{window_label}.json
// Window labels: wk{1..4}-weekdays-4day, wk{1..4}-weekend-3day.
//
// Multi-group runs share one browser/context for politeness and bot-detection
// coherence. Inter-group delay: 3-8s randomized.

import { chromium } from "patchright";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
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
const ALLOWED_CITY_SLUGS = ["austin-tx"];

const GROUP_ID_RE = /^[a-z0-9-]+$/;
const HOST_CACHE_PATH = join(REPO_ROOT, "data", "host-cache.json");
const HOST_CACHE_REFRESH_DAYS = 30;

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

// Generate 8 windows from today: 4 weekday (Mon–Thu, 4 nights) + 4 weekend
// (Fri–Mon, 3 nights) blocks, anchored to the next Monday STRICTLY AFTER today.
// If today is Mon, mon1 = today+7 (skip current partial week).
// Returns array of specs in canonical render order (w1-weekdays, w1-weekend,
// w2-weekdays, w2-weekend, ...).
function generateWindowSpecs(today) {
  const dow = today.getDay(); // 0=Sun..6=Sat
  const daysToNextMon = ((1 - dow + 7) % 7) || 7;
  const mon1 = addDays(today, daysToNextMon);
  const specs = [];
  for (let w = 1; w <= 4; w++) {
    const weekOffset = (w - 1) * 7;
    // Weekdays: pickup Mon, return Fri. 4 nights.
    specs.push({
      id: `w${w}-weekdays`,
      label: `wk${w}-weekdays-4day`,
      days: 4,
      start: addDays(mon1, weekOffset),
    });
    // Weekend: pickup Fri, return Mon. 3 nights.
    specs.push({
      id: `w${w}-weekend`,
      label: `wk${w}-weekend-3day`,
      days: 3,
      start: addDays(mon1, weekOffset + 4),
    });
  }
  return specs;
}

// ---------------------------------------------------------------------------
// Persistent host-name cache (data/host-cache.json).
// ---------------------------------------------------------------------------

function loadHostCache() {
  if (!existsSync(HOST_CACHE_PATH)) {
    console.error(`Host cache cold (no file at ${HOST_CACHE_PATH})`);
    return { version: 1, updated_at: null, hosts: {} };
  }
  try {
    const raw = readFileSync(HOST_CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const count = Object.keys(parsed.hosts || {}).length;
    console.error(`Host cache loaded: ${count} entries (updated ${parsed.updated_at})`);
    return { version: 1, updated_at: parsed.updated_at || null, hosts: parsed.hosts || {} };
  } catch (err) {
    console.error(`Host cache unreadable (${err.message}) — starting fresh`);
    return { version: 1, updated_at: null, hosts: {} };
  }
}

function saveHostCache(cache) {
  cache.updated_at = new Date().toISOString();
  const tmp = HOST_CACHE_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, HOST_CACHE_PATH);
}

function isCacheEntryFresh(entry, runDate) {
  if (!entry || !entry.last_verified) return false;
  const lastMs = new Date(entry.last_verified + "T00:00:00Z").getTime();
  const nowMs = new Date(runDate + "T00:00:00Z").getTime();
  const ageDays = (nowMs - lastMs) / (1000 * 60 * 60 * 24);
  return ageDays < HOST_CACHE_REFRESH_DAYS;
}

// Returns the host name for a listing, using cache when fresh; otherwise
// drills into the detail page and updates the cache. Returns null on failure
// (and does NOT cache null, so subsequent runs retry).
async function getHost(page, listingId, listingUrl, cache, runDate) {
  const existing = cache.hosts[listingId];
  if (existing && isCacheEntryFresh(existing, runDate)) {
    return existing.host_name;
  }
  let hostName = null;
  try {
    hostName = await scrapeHost(page, listingUrl);
  } catch (err) {
    console.error(`    host lookup failed for ${listingId}: ${err.message}`);
  }
  if (hostName) {
    cache.hosts[listingId] = {
      host_name: hostName,
      last_verified: runDate,
      first_seen: existing?.first_seen || runDate,
    };
  }
  return hostName;
}

// ---------------------------------------------------------------------------
// Config + URL building
// ---------------------------------------------------------------------------

function loadConfig() {
  const path = join(REPO_ROOT, "config", "my-listings.json");
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed.groups) || parsed.groups.length === 0) {
    throw new Error(`config/my-listings.json: 'groups' must be a non-empty array`);
  }

  const groups = parsed.groups.map((g, i) => {
    if (!g.group_id || !GROUP_ID_RE.test(g.group_id)) {
      throw new Error(`config/my-listings.json: groups[${i}].group_id must match ${GROUP_ID_RE} (got: ${JSON.stringify(g.group_id)})`);
    }
    if (!g.make || typeof g.make !== "string") {
      throw new Error(`config/my-listings.json: groups[${i}] (${g.group_id}) missing 'make'`);
    }
    if (!Array.isArray(g.models) || g.models.length === 0) {
      throw new Error(`config/my-listings.json: groups[${i}] (${g.group_id}) 'models' must be a non-empty array`);
    }
    const listingIdMap = new Map();
    for (const item of g.listings || []) {
      if (item.listing_id) {
        listingIdMap.set(String(item.listing_id), item.label || String(item.listing_id));
      }
    }
    return {
      group_id: g.group_id,
      label: g.label || g.group_id,
      make: g.make,
      models: g.models,
      listings: g.listings || [],
      listingIdMap,
    };
  });

  // Unique group_ids
  const seen = new Set();
  for (const g of groups) {
    if (seen.has(g.group_id)) throw new Error(`config/my-listings.json: duplicate group_id ${g.group_id}`);
    seen.add(g.group_id);
  }

  console.error(`Loaded ${groups.length} group(s) from config: ${groups.map((g) => g.group_id).join(", ")}`);
  return { owner_label: parsed.owner_label || null, groups };
}

function buildSearchUrl({ start_date_mdy, end_date_mdy, make, models }) {
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
  params.set("makes", make);
  for (const m of models) params.append("models", m);
  params.set("pickupType", "ALL");
  params.set("placeId", LOCATION.placeId);
  params.set("region", LOCATION.region);
  params.set("searchDurationType", "DAILY");
  params.set("sortType", "RELEVANCE");
  params.set("startDate", start_date_mdy);
  params.set("startTime", "10:00");
  return `https://turo.com/us/en/search?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Card + host scraping
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Window + group execution
// ---------------------------------------------------------------------------

async function runWindow({ searchPage, hostPage, spec, group, ownerLabel, cache, runDate }) {
  const start = spec.start;
  const end = addDays(start, spec.days);
  const start_date = ymd(start);
  const end_date = ymd(end);
  const start_date_mdy = mdy(start);
  const end_date_mdy = mdy(end);

  const url = buildSearchUrl({ start_date_mdy, end_date_mdy, make: group.make, models: group.models });
  console.error(`[${group.group_id} ${spec.id}] ${LOCATION.label} ${start_date} -> ${end_date} (${spec.days}d) ${group.make} / ${group.models.join(", ")}`);
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

  // Exact make+model match (lowercase). Tiguan ≠ Tiguan Limited ≠ X2 ≠ 2 Series.
  const groupMakeLower = group.make.toLowerCase();
  const groupModelsLower = group.models.map((m) => m.toLowerCase());
  const matched = all.filter((l) => {
    const make = (l.make || "").toLowerCase();
    const model = (l.model || "").toLowerCase();
    return make === groupMakeLower && groupModelsLower.includes(model);
  });
  const inCity = matched.filter((l) => ALLOWED_CITY_SLUGS.includes(l.city_slug));
  const dropped = matched.length - inCity.length;
  console.error(`  confirmed ${matched.length} ${group.label}; kept ${inCity.length} in [${ALLOWED_CITY_SLUGS.join(", ")}], dropped ${dropped}`);

  // Host name resolution via cache (cache hits skip the detail page visit entirely).
  let cacheHits = 0;
  let cacheMisses = 0;
  for (const t of inCity) {
    const wasCached = cache.hosts[t.id] && isCacheEntryFresh(cache.hosts[t.id], runDate);
    t.host_name = await getHost(hostPage, t.id, t.listing_url, cache, runDate);
    if (wasCached) cacheHits++; else cacheMisses++;
  }
  console.error(`  host cache: ${cacheHits} hits, ${cacheMisses} misses (detail-page visits)`);

  return {
    generated_at: new Date().toISOString(),
    group_id: group.group_id,
    group_label: group.label,
    window_id: spec.id,
    window_label: spec.label,
    query: {
      location: LOCATION.label,
      start_date,
      end_date,
      days: spec.days,
      make: group.make,
      models: group.models,
      search_url: url,
    },
    total_listings_returned: all.length,
    listings_before_city_filter: matched.length,
    listing_count: inCity.length,
    allowed_city_slugs: ALLOWED_CITY_SLUGS,
    owner_label: ownerLabel,
    listings: inCity.map((t) => {
      const isMine = group.listingIdMap.has(t.id);
      return {
        listing_id: t.id,
        year: t.year,
        make: t.make,
        model: t.model,
        city_slug: t.city_slug,
        host_name: t.host_name || null,
        is_mine: isMine,
        mine_label: isMine ? group.listingIdMap.get(t.id) : null,
        total_charged_usd: t.total_charged,
        total_original_usd: t.total_original,
        avg_daily_usd: Number((t.total_charged / spec.days).toFixed(2)),
        listing_url: t.listing_url,
      };
    }),
  };
}

async function runGroup({ searchPage, hostPage, group, windows, ownerLabel, outDir, runDate, writeFiles, cache }) {
  const groupResults = [];
  for (const spec of windows) {
    const result = await runWindow({ searchPage, hostPage, spec, group, ownerLabel, cache, runDate });
    groupResults.push(result);

    if (writeFiles) {
      const outPath = join(outDir, `AUS-${group.group_id}-${runDate}-${spec.label}.json`);
      writeFileSync(outPath, JSON.stringify(result, null, 2));
      console.error(`  wrote ${outPath}`);
    }
  }
  return groupResults;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const runDate = ymd(today);

  const allSpecs = generateWindowSpecs(today);
  const specsById = Object.fromEntries(allSpecs.map((s) => [s.id, s]));

  const requested = (process.env.WINDOW || "all").toLowerCase();
  let windows;
  if (requested === "all") {
    windows = allSpecs;
  } else {
    const ids = requested.split(",").map((s) => s.trim()).filter(Boolean);
    windows = [];
    for (const id of ids) {
      if (!specsById[id]) {
        console.error(`Unknown WINDOW=${id}; valid ids: ${allSpecs.map((s) => s.id).join(", ")}, or "all"`);
        process.exit(2);
      }
      windows.push(specsById[id]);
    }
  }
  console.error(`Running ${windows.length} window(s): ${windows.map((w) => w.id).join(", ")}`);

  const outDir = process.env.OUT_DIR || join(REPO_ROOT, "data");
  const writeFiles = process.env.NO_WRITE !== "1";
  if (writeFiles) mkdirSync(outDir, { recursive: true });

  const { owner_label: ownerLabel, groups: allGroups } = loadConfig();

  const groupFilter = process.env.GROUP_ID || null;
  const groups = groupFilter ? allGroups.filter((g) => g.group_id === groupFilter) : allGroups;
  if (groupFilter && groups.length === 0) {
    console.error(`GROUP_ID=${groupFilter} not found in config. Available: ${allGroups.map((g) => g.group_id).join(", ")}`);
    process.exit(2);
  }
  console.error(`Running ${groups.length} group(s): ${groups.map((g) => g.group_id).join(", ")}`);

  const cache = loadHostCache();
  const cacheSizeAtStart = Object.keys(cache.hosts).length;

  const headless = process.env.HEADLESS === "1";
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const searchPage = await ctx.newPage();
  const hostPage = await ctx.newPage();

  const perGroupResults = []; // { group_id, status, windows?, error? }
  try {
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      console.error(`\n=== group ${i + 1}/${groups.length}: ${group.group_id} (${group.label}) ===`);

      try {
        const windowResults = await runGroup({
          searchPage, hostPage, group, windows, ownerLabel, outDir, runDate, writeFiles, cache,
        });
        perGroupResults.push({
          group_id: group.group_id,
          status: "ok",
          windows: windowResults.map((r) => ({
            window_id: r.window_id,
            listing_count: r.listing_count,
            start_date: r.query.start_date,
            end_date: r.query.end_date,
          })),
        });
      } catch (err) {
        console.error(`!! group ${group.group_id} failed: ${err.message}`);
        perGroupResults.push({ group_id: group.group_id, status: "failed", error: err.message });
      }

      // Persist cache after each group so a later hang doesn't lose discoveries.
      if (writeFiles) {
        try {
          saveHostCache(cache);
        } catch (err) {
          console.error(`  WARN: failed to persist host cache: ${err.message}`);
        }
      }

      // Inter-group politeness delay (3-8s randomized). Skip after the last group.
      if (i < groups.length - 1) {
        const delayMs = 3000 + Math.floor(Math.random() * 5000);
        console.error(`  sleeping ${delayMs}ms before next group...`);
        await sleep(delayMs);
      }
    }
  } finally {
    await browser.close();
  }

  // Final cache save (idempotent if last incremental save succeeded).
  if (writeFiles) {
    try {
      saveHostCache(cache);
    } catch (err) {
      console.error(`WARN: failed final host cache save: ${err.message}`);
    }
  }

  const cacheSizeAtEnd = Object.keys(cache.hosts).length;
  const newHosts = cacheSizeAtEnd - cacheSizeAtStart;

  // Summary on stdout
  const summary = {
    run_date: runDate,
    host_cache: { entries_at_start: cacheSizeAtStart, entries_at_end: cacheSizeAtEnd, new_this_run: newHosts },
    groups: perGroupResults,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");

  const okCount = perGroupResults.filter((r) => r.status === "ok").length;
  console.error(`\nDone. ${okCount}/${perGroupResults.length} groups succeeded. Host cache: ${cacheSizeAtEnd} entries (+${newHosts} new).`);
  // Always exit 0 — the wrapper validates per-file post-hoc. A group-level
  // failure here doesn't necessarily mean no usable data was written; the
  // wrapper's listing_count check is the source of truth for "emailable".
}

main().catch((err) => {
  console.error("Fatal:", err?.stack || err);
  process.exit(1);
});
