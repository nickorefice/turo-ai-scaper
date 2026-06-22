#!/usr/bin/env node
// Per-group daily email pipeline. Reads today's window JSON files for ONE
// group (driven by GROUP_ID env var) and sends a hybrid summary+detail email
// via Resend.
//
// Layout:
//   - Header: car header (e.g. "2022 Tiguan, 2023 Tiguan")
//   - Summary table: one row per window (date range | your prices | median | n | range)
//   - Per-window detail sections: mine + top 3 cheapest + top 3 most expensive
//   - Raw search links: one per window
//
// Credentials are read from ~/.config/turo-scraper/.env (KEY=value lines):
//   RESEND_API_KEY=re_...
//   EMAIL_TO=nickjoref@gmail.com,kennywilson212@gmail.com  (comma-separated for multiple)
//   EMAIL_FROM=turo-daily@clearedapp.app
//   OPENAI_API_KEY=sk-...   (optional — enables AI summary + suggested prices;
//                            without it, the Suggested column falls back to a
//                            deterministic "lowest comp − $1" baseline)
//
// Set DRY_RUN=1 to print the built email to stdout instead of sending via Resend.
//
// Usage:
//   GROUP_ID=tiguans node src/send-email.js                 # today's date in America/Chicago
//   GROUP_ID=tiguans node src/send-email.js 2026-05-25      # explicit date override
//
// Exits non-zero on any failure so the launchd wrapper sees it.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { getPricingAdvice } from "./ai-pricing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const ENV_PATH = join(homedir(), ".config", "turo-scraper", ".env");

// Canonical order for the 8 windows (used to sort discovered files).
const CANONICAL_WINDOW_ORDER = [
  "w1-weekdays", "w1-weekend",
  "w2-weekdays", "w2-weekend",
  "w3-weekdays", "w3-weekend",
  "w4-weekdays", "w4-weekend",
];

const WINDOW_DISPLAY_LABEL = {
  "w1-weekdays": "Wk 1 weekdays",
  "w1-weekend":  "Wk 1 weekend",
  "w2-weekdays": "Wk 2 weekdays",
  "w2-weekend":  "Wk 2 weekend",
  "w3-weekdays": "Wk 3 weekdays",
  "w3-weekend":  "Wk 3 weekend",
  "w4-weekdays": "Wk 4 weekdays",
  "w4-weekend":  "Wk 4 weekend",
};

function loadEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

function chicagoToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function median(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function computeStats(listings) {
  const competitors = listings.filter((t) => !t.is_mine);
  const dailies = competitors.map((t) => t.avg_daily_usd).filter((n) => typeof n === "number");
  if (dailies.length === 0) return { n: 0, median: null, min: null, max: null };
  return {
    n: dailies.length,
    median: Number(median(dailies).toFixed(2)),
    min: Math.min(...dailies),
    max: Math.max(...dailies),
  };
}

async function sendViaResend({ apiKey, from, to, subject, text, html }) {
  const body = { from, to, subject };
  if (text) body.text = text;
  if (html) body.html = html;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const responseBody = await res.text();
  if (!res.ok) throw new Error(`Resend ${res.status}: ${responseBody.slice(0, 500)}`);
  return JSON.parse(responseBody);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shortListingLabel(label) {
  // "2022 Tiguan (1695581)" -> "2022 Tiguan"
  return label.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

// "$72.5" / "$118" — trims trailing zeros so prices read cleanly.
function fmtPrice(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2).replace(/\.?0+$/, "")}`;
}

// Suggested price for a window from the advice map (null/absent -> undefined).
function suggestedFor(advice, windowId) {
  return advice?.suggestionsByWindowId?.get(windowId)?.price ?? null;
}

function shortDay(dateStr) {
  // "2026-06-01" -> "Mon 6/1"
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getDay()];
  return `${dayName} ${m}/${d}`;
}

function formatDateRange(window) {
  return `${shortDay(window.query.start_date)} – ${shortDay(window.query.end_date)} (${window.query.days}n)`;
}

function getCarHeader(group, windows) {
  const seen = new Map(); // listing_id -> "{year} {model}"
  for (const w of windows) {
    if (!w) continue;
    for (const t of w.listings) {
      if (t.is_mine && !seen.has(t.listing_id)) {
        seen.set(t.listing_id, `${t.year} ${t.model}`);
      }
    }
  }
  return group.listings
    .map((l) => seen.get(l.listing_id) || shortListingLabel(l.label))
    .join(", ");
}

// Returns the price + rank info for one of my listings in one window,
// or null if not listed in that window.
function getMyEntry(window, listing, myIds) {
  const mine = window.listings.find((t) => t.listing_id === listing.listing_id);
  if (!mine) return null;
  const competitors = window.listings.filter((t) => !myIds.has(t.listing_id));
  const cheaper = competitors.filter((c) => c.avg_daily_usd < mine.avg_daily_usd).length;
  return {
    daily: mine.avg_daily_usd,
    rank: cheaper + 1,
    total: competitors.length + 1,
  };
}

function competitorRows(window, myIds) {
  if (!window) return [];
  return window.listings
    .filter((t) => !myIds.has(t.listing_id))
    .sort((a, b) => a.avg_daily_usd - b.avg_daily_usd)
    .map((t) => ({
      label: `${t.year} ${t.model} by ${t.host_name || "?"}`,
      avgDaily: t.avg_daily_usd,
      totalCharged: t.total_charged_usd,
      url: t.listing_url,
    }));
}

// Split competitors into "cheapest 3" + "most expensive 3" without overlap
// when there are >= 6, or just show all sorted when fewer.
function competitorEdges(rows, n = 3) {
  if (rows.length <= n * 2) return { all: rows, cheapest: null, expensive: null };
  return { all: null, cheapest: rows.slice(0, n), expensive: rows.slice(-n).reverse() };
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function discoverWindows(groupId, runDate) {
  const dataDir = join(REPO_ROOT, "data");
  const prefix = `AUS-${groupId}-${runDate}-`;
  const found = [];
  if (existsSync(dataDir)) {
    for (const name of readdirSync(dataDir)) {
      if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
      // Extract window id from filename: AUS-{group}-{date}-{label}.json
      // label looks like "wk1-weekdays-4day" -> map back to id "w1-weekdays"
      const labelWithExt = name.slice(prefix.length); // e.g. "wk1-weekdays-4day.json"
      const labelMatch = labelWithExt.match(/^wk(\d+)-(weekdays|weekend)-\d+day\.json$/);
      if (!labelMatch) continue;
      const id = `w${labelMatch[1]}-${labelMatch[2]}`;
      try {
        const data = JSON.parse(readFileSync(join(dataDir, name), "utf8"));
        found.push({ id, data });
      } catch (err) {
        console.error(`WARN: failed to parse ${name}: ${err.message}`);
      }
    }
  }
  // Sort canonically
  found.sort((a, b) => CANONICAL_WINDOW_ORDER.indexOf(a.id) - CANONICAL_WINDOW_ORDER.indexOf(b.id));
  return found;
}

// ---------------------------------------------------------------------------
// Summary table (text)
// ---------------------------------------------------------------------------

function padR(s, w) { s = String(s); return s.length >= w ? s : s + " ".repeat(w - s.length); }
function padL(s, w) { s = String(s); return s.length >= w ? s : " ".repeat(w - s.length) + s; }

function buildSummaryTableText(windows, group, myIds, advice) {
  const myCols = group.listings.map((l) => shortListingLabel(l.label));
  // Column widths
  const W_WIN = 18;
  const W_DATE = 30;
  const W_MINE = Math.max(8, ...myCols.map((c) => c.length + 2));
  const W_MED = 10;
  const W_N = 4;
  const W_RANGE = 14;
  const W_SUGGEST = 12;

  const header =
    padR("WINDOW", W_WIN) +
    padR("DATE RANGE", W_DATE) +
    myCols.map((c) => padL(c, W_MINE)).join("") +
    padL("MEDIAN", W_MED) +
    padL("N", W_N) +
    padL("RANGE", W_RANGE) +
    padL("SUGGEST", W_SUGGEST);

  const sep = "─".repeat(header.length);

  const rows = [];
  for (const id of CANONICAL_WINDOW_ORDER) {
    const win = windows.find((w) => w.id === id);
    const label = WINDOW_DISPLAY_LABEL[id];
    if (!win) {
      rows.push(
        padR(label, W_WIN) +
        padR("(no data)", W_DATE) +
        myCols.map(() => padL("—", W_MINE)).join("") +
        padL("—", W_MED) +
        padL("—", W_N) +
        padL("—", W_RANGE) +
        padL("—", W_SUGGEST),
      );
      continue;
    }
    const stats = computeStats(win.data.listings);
    const dateRange = formatDateRange(win.data);
    const mineCells = group.listings.map((l) => {
      const me = getMyEntry(win.data, l, myIds);
      return padL(me ? `$${me.daily}` : "—", W_MINE);
    });
    const medianCell = stats.median != null ? `$${stats.median.toFixed(2)}` : "—";
    const rangeCell = stats.n > 0 ? `$${stats.min}–$${stats.max}` : "—";
    const suggestCell = fmtPrice(suggestedFor(advice, id));
    rows.push(
      padR(label, W_WIN) +
      padR(dateRange, W_DATE) +
      mineCells.join("") +
      padL(medianCell, W_MED) +
      padL(stats.n, W_N) +
      padL(rangeCell, W_RANGE) +
      padL(suggestCell, W_SUGGEST),
    );
  }

  return [header, sep, ...rows].join("\n");
}

function buildSummaryTableHtml(windows, group, myIds, advice) {
  const myCols = group.listings.map((l) => shortListingLabel(l.label));
  const th = (txt, align = "left") =>
    `<th style="text-align:${align};padding:4px 8px;border-bottom:1px solid #ccc;font-weight:600">${escapeHtml(txt)}</th>`;
  const td = (txt, align = "left", style = "") =>
    `<td style="text-align:${align};padding:3px 8px;${style}">${txt}</td>`;

  const headRow =
    `<tr>${th("Window")}${th("Date range")}${myCols.map((c) => th(c, "right")).join("")}${th("Median", "right")}${th("N", "right")}${th("Range", "right")}${th("Suggested", "right")}</tr>`;

  const bodyRows = [];
  for (const id of CANONICAL_WINDOW_ORDER) {
    const win = windows.find((w) => w.id === id);
    const label = WINDOW_DISPLAY_LABEL[id];
    if (!win) {
      bodyRows.push(
        `<tr>${td(escapeHtml(label))}${td("(no data)", "left", "color:#999")}${myCols.map(() => td("—", "right", "color:#999")).join("")}${td("—", "right", "color:#999")}${td("—", "right", "color:#999")}${td("—", "right", "color:#999")}${td("—", "right", "color:#999")}</tr>`,
      );
      continue;
    }
    const stats = computeStats(win.data.listings);
    const mineCells = group.listings
      .map((l) => {
        const me = getMyEntry(win.data, l, myIds);
        return td(me ? `$${me.daily}` : "—", "right", me ? "font-weight:600" : "color:#999");
      })
      .join("");
    const medianCell = stats.median != null ? `$${stats.median.toFixed(2)}` : "—";
    const rangeCell = stats.n > 0 ? `$${stats.min}–$${stats.max}` : "—";
    const suggest = suggestedFor(advice, id);
    const suggestCell = td(
      fmtPrice(suggest),
      "right",
      suggest != null ? "font-weight:700;color:#0a7d28" : "color:#999",
    );
    bodyRows.push(
      `<tr>${td(escapeHtml(label))}${td(escapeHtml(formatDateRange(win.data)))}${mineCells}${td(medianCell, "right")}${td(stats.n, "right")}${td(rangeCell, "right")}${suggestCell}</tr>`,
    );
  }

  return `<table style="border-collapse:collapse;font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:13px;margin:0 0 20px 0">
    <thead>${headRow}</thead>
    <tbody>${bodyRows.join("")}</tbody>
  </table>`;
}

// ---------------------------------------------------------------------------
// Per-window detail sections (text + HTML)
// ---------------------------------------------------------------------------

function buildWindowSectionText(win, group, myIds) {
  const label = WINDOW_DISPLAY_LABEL[win.id];
  const stats = computeStats(win.data.listings);
  const lines = [`═══ ${label} — ${formatDateRange(win.data)} ═══`];

  // Stats
  if (stats.n > 0) {
    lines.push(`  n=${stats.n}, median $${stats.median.toFixed(2)}/day, range $${stats.min}–$${stats.max}`);
  } else {
    lines.push(`  (no competitors found for this window)`);
  }

  // Mine
  for (const l of group.listings) {
    const me = getMyEntry(win.data, l, myIds);
    if (!me) {
      lines.push(`  ${l.label}: not listed`);
      continue;
    }
    const vsMedian = stats.median != null ? me.daily - stats.median : null;
    let vsStr = "";
    if (vsMedian != null) {
      if (vsMedian > 0) vsStr = ` (+$${vsMedian.toFixed(2)} vs median)`;
      else if (vsMedian < 0) vsStr = ` (-$${Math.abs(vsMedian).toFixed(2)} vs median)`;
      else vsStr = ` (at median)`;
    }
    lines.push(`  ${l.label}: $${me.daily}/day, rank ${me.rank}/${me.total}${vsStr}`);
  }

  // Competitor edges
  const rows = competitorRows(win.data, myIds);
  const edges = competitorEdges(rows);
  if (edges.all) {
    if (edges.all.length > 0) {
      lines.push(`  Competitors:`);
      for (const c of edges.all) {
        lines.push(`    $${c.avgDaily}/day — ${c.label}`);
        lines.push(`      ${c.url}`);
      }
    }
  } else {
    lines.push(`  Cheapest 3:`);
    for (const c of edges.cheapest) {
      lines.push(`    $${c.avgDaily}/day — ${c.label}`);
      lines.push(`      ${c.url}`);
    }
    lines.push(`  Most expensive 3:`);
    for (const c of edges.expensive) {
      lines.push(`    $${c.avgDaily}/day — ${c.label}`);
      lines.push(`      ${c.url}`);
    }
  }

  return lines.join("\n");
}

function buildWindowSectionHtml(win, group, myIds) {
  const label = WINDOW_DISPLAY_LABEL[win.id];
  const stats = computeStats(win.data.listings);
  const parts = [];
  parts.push(`<h3 style="font-size:14px;margin:18px 0 4px">${escapeHtml(label)} <span style="color:#666;font-weight:normal">— ${escapeHtml(formatDateRange(win.data))}</span></h3>`);

  if (stats.n > 0) {
    parts.push(`<div style="color:#444;margin-bottom:4px">n=${stats.n}, median $${stats.median.toFixed(2)}/day, range $${stats.min}–$${stats.max}</div>`);
  } else {
    parts.push(`<div style="color:#999;margin-bottom:4px">(no competitors found for this window)</div>`);
  }

  // Mine
  const mineLines = group.listings.map((l) => {
    const me = getMyEntry(win.data, l, myIds);
    if (!me) return `<div style="color:#999">${escapeHtml(l.label)}: not listed</div>`;
    const vsMedian = stats.median != null ? me.daily - stats.median : null;
    let vsStr = "";
    if (vsMedian != null) {
      if (vsMedian > 0) vsStr = ` (+$${vsMedian.toFixed(2)} vs median)`;
      else if (vsMedian < 0) vsStr = ` (-$${Math.abs(vsMedian).toFixed(2)} vs median)`;
      else vsStr = ` (at median)`;
    }
    return `<div><strong>${escapeHtml(l.label)}:</strong> $${me.daily}/day, rank ${me.rank}/${me.total}${escapeHtml(vsStr)}</div>`;
  });
  parts.push(`<div style="margin-bottom:8px">${mineLines.join("")}</div>`);

  // Competitor edges
  const rows = competitorRows(win.data, myIds);
  const edges = competitorEdges(rows);
  const formatRow = (c) =>
    `<li>$${c.avgDaily}/day — ${escapeHtml(c.label)} <a href="${escapeHtml(c.url)}">Link</a></li>`;

  if (edges.all) {
    if (edges.all.length > 0) {
      parts.push(`<div style="margin-top:4px"><em>Competitors:</em></div>`);
      parts.push(`<ul style="margin:2px 0 0;padding-left:20px">${edges.all.map(formatRow).join("")}</ul>`);
    }
  } else {
    parts.push(`<div style="margin-top:4px"><em>Cheapest 3:</em></div>`);
    parts.push(`<ul style="margin:2px 0 0;padding-left:20px">${edges.cheapest.map(formatRow).join("")}</ul>`);
    parts.push(`<div style="margin-top:4px"><em>Most expensive 3:</em></div>`);
    parts.push(`<ul style="margin:2px 0 0;padding-left:20px">${edges.expensive.map(formatRow).join("")}</ul>`);
  }

  return parts.join("");
}

// ---------------------------------------------------------------------------
// Top-level body builders
// ---------------------------------------------------------------------------

function buildTextBody({ windows, group, advice }) {
  const myIds = new Set(group.listings.map((l) => l.listing_id));
  const carHeader = getCarHeader(group, windows.map((w) => w.data));
  const out = [carHeader, ""];

  if (advice?.summary) {
    out.push("SUMMARY");
    out.push(advice.summary);
    out.push("");
  }

  out.push(buildSummaryTableText(windows, group, myIds, advice));
  out.push("");

  for (const id of CANONICAL_WINDOW_ORDER) {
    const win = windows.find((w) => w.id === id);
    if (!win) continue;
    out.push("");
    out.push(buildWindowSectionText(win, group, myIds));
  }

  out.push("", "Raw search links:");
  for (const id of CANONICAL_WINDOW_ORDER) {
    const win = windows.find((w) => w.id === id);
    const label = WINDOW_DISPLAY_LABEL[id];
    if (!win) {
      out.push(`  ${label}: (no data)`);
    } else {
      out.push(`  ${label}: ${win.data.query.search_url}`);
    }
  }
  return out.join("\n");
}

function buildHtmlBody({ windows, group, advice }) {
  const myIds = new Set(group.listings.map((l) => l.listing_id));
  const carHeader = getCarHeader(group, windows.map((w) => w.data));

  const summaryBlock = advice?.summary
    ? `<div style="background:#f0f7f1;border-left:4px solid #0a7d28;padding:10px 14px;margin:0 0 16px;border-radius:4px">
    <div style="font-weight:700;font-size:12px;letter-spacing:.04em;color:#0a7d28;margin-bottom:4px">SUGGESTED PRICING SUMMARY</div>
    <div style="color:#222">${escapeHtml(advice.summary)}</div>
  </div>`
    : "";

  const detailSections = CANONICAL_WINDOW_ORDER
    .map((id) => windows.find((w) => w.id === id))
    .filter(Boolean)
    .map((win) => buildWindowSectionHtml(win, group, myIds))
    .join("");

  const rawLinks = CANONICAL_WINDOW_ORDER.map((id) => {
    const win = windows.find((w) => w.id === id);
    const label = WINDOW_DISPLAY_LABEL[id];
    if (!win) return `<li>${escapeHtml(label)}: (no data)</li>`;
    return `<li>${escapeHtml(label)}: <a href="${escapeHtml(win.data.query.search_url)}">link</a></li>`;
  }).join("");

  return `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;color:#111;max-width:900px">
  <h1 style="font-size:18px;margin:0 0 12px">${escapeHtml(carHeader)}</h1>
  ${summaryBlock}
  ${buildSummaryTableHtml(windows, group, myIds, advice)}
  ${detailSections}
  <h3 style="font-size:14px;margin:18px 0 4px">Raw search links</h3>
  <ul style="margin:0;padding-left:20px;font-size:13px">${rawLinks}</ul>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Config + main
// ---------------------------------------------------------------------------

function loadGroup(groupId) {
  const configFile = join(REPO_ROOT, "config", "my-listings.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const group = (config.groups || []).find((g) => g.group_id === groupId);
  if (!group) {
    const available = (config.groups || []).map((g) => g.group_id).join(", ");
    throw new Error(`group_id "${groupId}" not found in config/my-listings.json. Available: ${available}`);
  }
  return group;
}

async function main() {
  const env = loadEnvFile(ENV_PATH);
  const RESEND_API_KEY = process.env.RESEND_API_KEY || env.RESEND_API_KEY;
  // The .env file is authoritative for OPENAI_API_KEY: an ambient shell export
  // (e.g. ~/.zshrc pulling a different key from Keychain) must NOT shadow the
  // dedicated turo-scraper key. File first, then fall back to process.env.
  const OPENAI_API_KEY = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const EMAIL_TO_RAW = process.env.EMAIL_TO || env.EMAIL_TO || "nickjoref@gmail.com";
  const EMAIL_TO = EMAIL_TO_RAW.split(",").map((s) => s.trim()).filter(Boolean);
  const EMAIL_FROM = process.env.EMAIL_FROM || env.EMAIL_FROM || "onboarding@resend.dev";

  const dryRun = process.env.DRY_RUN === "1";
  if (!RESEND_API_KEY && !dryRun) throw new Error(`RESEND_API_KEY missing (set in env or ${ENV_PATH})`);

  const groupId = process.env.GROUP_ID;
  if (!groupId) throw new Error(`GROUP_ID env var is required (e.g. GROUP_ID=tiguans node src/send-email.js)`);

  const group = loadGroup(groupId);
  const runDate = process.argv[2] || chicagoToday();

  console.error(`Building email for group=${groupId} date=${runDate}`);
  const windows = discoverWindows(groupId, runDate);
  console.error(`  discovered ${windows.length}/8 windows: ${windows.map((w) => w.id).join(", ") || "(none)"}`);

  if (windows.length === 0) {
    console.error(`No window data found for group ${groupId} on ${runDate} — sending alert`);
    const alertBody =
      `No Turo scrape data files found for group "${group.label}" on ${runDate}.\n\n` +
      `Expected files like: data/AUS-${groupId}-${runDate}-wk*-{weekdays|weekend}-*.json\n\n` +
      `Check logs/run-${runDate}.log on the Mac. Run \`launchctl print gui/$(id -u)/com.nickorefice.turo-tiguans\` for launchd status.`;
    await sendViaResend({
      apiKey: RESEND_API_KEY,
      from: EMAIL_FROM,
      to: EMAIL_TO,
      subject: `[ALERT] Turo scrape missing for ${runDate} — ${group.label}`,
      text: alertBody,
    });
    console.error("Sent alert email.");
    return;
  }

  const advice = await getPricingAdvice({ group, windows, apiKey: OPENAI_API_KEY });
  console.error(`  pricing advice: summary=${advice.summary ? "yes" : "no"}, ${advice.suggestionsByWindowId.size} window suggestions`);

  const subject = `Turo Austin daily — ${runDate} — ${group.label}`;
  const text = buildTextBody({ windows, group, advice });
  const html = buildHtmlBody({ windows, group, advice });

  if (dryRun) {
    console.error(`DRY_RUN=1 — not sending. Text body below (html: ${html.length} chars):\n`);
    process.stdout.write(text + "\n");
    return;
  }

  console.error(`Sending email to ${EMAIL_TO}...`);
  const sendResult = await sendViaResend({
    apiKey: RESEND_API_KEY,
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject,
    text,
    html,
  });
  console.error(`  Resend id: ${sendResult.id}`);
}

main().catch((err) => {
  console.error("Fatal:", err?.stack || err);
  process.exit(1);
});
