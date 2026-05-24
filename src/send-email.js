#!/usr/bin/env node
// Per-group daily email pipeline. Reads today's two window JSON files for ONE
// group (driven by GROUP_ID env var) and sends a deterministic stats +
// competitor summary via Resend.
//
// Credentials are read from ~/.config/turo-scraper/.env (KEY=value lines):
//   RESEND_API_KEY=re_...
//   EMAIL_TO=nickjoref@gmail.com,kennywilson212@gmail.com  (comma-separated for multiple)
//   EMAIL_FROM=turo-daily@clearedapp.app
//
// Usage:
//   GROUP_ID=tiguans node src/send-email.js                 # today's date in America/Chicago
//   GROUP_ID=tiguans node src/send-email.js 2026-05-23      # explicit date override
//
// Exits non-zero on any failure so the launchd wrapper sees it.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const ENV_PATH = join(homedir(), ".config", "turo-scraper", ".env");

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
    .map((l) => seen.get(l.listing_id) || l.label)
    .join(", ");
}

function buildMineLines(window, stats, windowLabel, group, myIds) {
  if (!window) return [`(no data for this window)`];
  const lines = [];
  for (const listing of group.listings) {
    const mine = window.listings.find((t) => t.listing_id === listing.listing_id);
    if (!mine) {
      lines.push(`${listing.label}: not listed in ${windowLabel} — booked, paused, or removed.`);
      continue;
    }
    const competitors = window.listings.filter((t) => !myIds.has(t.listing_id));
    const cheaper = competitors.filter((c) => c.avg_daily_usd < mine.avg_daily_usd).length;
    const rank = cheaper + 1;
    const total = competitors.length + 1;
    const vsMedian = stats.median != null ? mine.avg_daily_usd - stats.median : null;
    const vsMedianStr =
      vsMedian == null
        ? ""
        : vsMedian > 0
          ? ` (+$${vsMedian.toFixed(2)} vs median)`
          : vsMedian < 0
            ? ` (-$${Math.abs(vsMedian).toFixed(2)} vs median)`
            : ` (at median)`;
    lines.push(`${listing.label}: $${mine.avg_daily_usd}/day, rank ${rank}/${total}${vsMedianStr}`);
  }
  return lines;
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

function buildTextBody({ windowA, windowB, statsA, statsB, group }) {
  const myIds = new Set(group.listings.map((l) => l.listing_id));
  const carHeader = getCarHeader(group, [windowA, windowB]);

  const windowSection = (window, stats, headerLabel, windowKey) => {
    if (!window) return [`${headerLabel}: NO DATA`];
    const dateRange = `${window.query.start_date} → ${window.query.end_date}, ${window.query.days} days`;
    const lines = [
      `${headerLabel} (${dateRange}):`,
      `  Competitors n=${stats.n}, median $${stats.median}/day, range $${stats.min}–$${stats.max}`,
      ...buildMineLines(window, stats, windowKey, group, myIds).map((l) => `  ${l}`),
      ``,
      `  Competitors:`,
    ];
    for (const c of competitorRows(window, myIds)) {
      lines.push(`    ${c.label} => Avg Daily: $${c.avgDaily}, total_charged_usd: $${c.totalCharged}`);
      lines.push(`      ${c.url}`);
    }
    return lines;
  };

  return [
    carHeader,
    ``,
    ...windowSection(windowA, statsA, "Window A — 3-day immediate", "Window A"),
    ``,
    ...windowSection(windowB, statsB, "Window B — 4-day next week", "Window B"),
    ``,
    `Raw links:`,
    windowA ? `  Window A search: ${windowA.query.search_url}` : `  Window A search: (no data)`,
    windowB ? `  Window B search: ${windowB.query.search_url}` : `  Window B search: (no data)`,
  ].join("\n");
}

function buildHtmlBody({ windowA, windowB, statsA, statsB, group }) {
  const myIds = new Set(group.listings.map((l) => l.listing_id));
  const carHeader = getCarHeader(group, [windowA, windowB]);

  const windowSection = (window, stats, headerLabel, windowKey) => {
    if (!window) {
      return `<h2 style="font-size:15px;margin:16px 0 6px">${escapeHtml(headerLabel)}</h2><p>NO DATA</p>`;
    }
    const dateRange = `${window.query.start_date} → ${window.query.end_date}, ${window.query.days} days`;
    const mineLines = buildMineLines(window, stats, windowKey, group, myIds)
      .map((l) => `<div>${escapeHtml(l)}</div>`)
      .join("");
    const compRows = competitorRows(window, myIds)
      .map(
        (c) =>
          `<li>${escapeHtml(c.label)} =&gt; Avg Daily: $${c.avgDaily}, total_charged_usd: $${c.totalCharged} → <a href="${escapeHtml(c.url)}">Link</a></li>`,
      )
      .join("");
    return `
      <h2 style="font-size:15px;margin:16px 0 6px">${escapeHtml(headerLabel)} <span style="color:#666;font-weight:normal">(${escapeHtml(dateRange)})</span></h2>
      <div>Competitors n=${stats.n}, median $${stats.median}/day, range $${stats.min}–$${stats.max}</div>
      <div style="margin-top:4px">${mineLines}</div>
      <div style="margin-top:10px"><strong>Competitors:</strong></div>
      <ul style="margin:4px 0 0 0;padding-left:20px">${compRows}</ul>
    `;
  };

  const rawLinks = [
    windowA
      ? `<li>Window A search: <a href="${escapeHtml(windowA.query.search_url)}">link</a></li>`
      : `<li>Window A search: (no data)</li>`,
    windowB
      ? `<li>Window B search: <a href="${escapeHtml(windowB.query.search_url)}">link</a></li>`
      : `<li>Window B search: (no data)</li>`,
  ].join("");

  return `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;color:#111">
  <h1 style="font-size:18px;margin:0 0 4px">${escapeHtml(carHeader)}</h1>
  ${windowSection(windowA, statsA, "Window A — 3-day immediate", "Window A")}
  ${windowSection(windowB, statsB, "Window B — 4-day next week", "Window B")}
  <h3 style="font-size:14px;margin:18px 0 4px">Raw links</h3>
  <ul style="margin:0;padding-left:20px">${rawLinks}</ul>
</body></html>`;
}

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
  const EMAIL_TO_RAW = process.env.EMAIL_TO || env.EMAIL_TO || "nickjoref@gmail.com";
  const EMAIL_TO = EMAIL_TO_RAW.split(",").map((s) => s.trim()).filter(Boolean);
  const EMAIL_FROM = process.env.EMAIL_FROM || env.EMAIL_FROM || "onboarding@resend.dev";

  if (!RESEND_API_KEY) throw new Error(`RESEND_API_KEY missing (set in env or ${ENV_PATH})`);

  const groupId = process.env.GROUP_ID;
  if (!groupId) throw new Error(`GROUP_ID env var is required (e.g. GROUP_ID=tiguans node src/send-email.js)`);

  const group = loadGroup(groupId);

  const runDate = process.argv[2] || chicagoToday();
  const dataDir = join(REPO_ROOT, "data");
  const fileA = join(dataDir, `AUS-${groupId}-${runDate}-window-a-3day.json`);
  const fileB = join(dataDir, `AUS-${groupId}-${runDate}-window-b-4day.json`);

  console.error(`Building email for group=${groupId} date=${runDate}`);
  console.error(`  window A: ${fileA}`);
  console.error(`  window B: ${fileB}`);

  const missing = [];
  let windowA = null;
  let windowB = null;
  if (existsSync(fileA)) windowA = JSON.parse(readFileSync(fileA, "utf8"));
  else missing.push(fileA);
  if (existsSync(fileB)) windowB = JSON.parse(readFileSync(fileB, "utf8"));
  else missing.push(fileB);

  if (missing.length > 0) {
    console.error(`Missing data files: ${missing.join(", ")}`);
    const alertBody =
      `Today's Turo scrape data files for group "${group.label}" were not found:\n\n` +
      missing.map((m) => `  ${m}`).join("\n") +
      `\n\nThe local scraper may have failed for this group. Check logs/run-${runDate}.log on the Mac.\n` +
      `Run \`launchctl print gui/$(id -u)/com.nickorefice.turo-tiguans\` for launchd status.`;
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

  const statsA = computeStats(windowA.listings);
  const statsB = computeStats(windowB.listings);
  console.error(`  window A: ${statsA.n} competitors, median $${statsA.median}/day`);
  console.error(`  window B: ${statsB.n} competitors, median $${statsB.median}/day`);

  const subject = `Turo Austin daily — ${runDate} — ${group.label}`;
  const text = buildTextBody({ windowA, windowB, statsA, statsB, group });
  const html = buildHtmlBody({ windowA, windowB, statsA, statsB, group });

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
