#!/usr/bin/env node
// Local daily-email pipeline: reads today's two window JSON files,
// asks Claude (Haiku 4.5) for suggested prices on the user's listings,
// and sends the summary via Resend.
//
// Credentials are read from ~/.config/turo-scraper/.env (KEY=value lines):
//   ANTHROPIC_API_KEY=sk-ant-...
//   RESEND_API_KEY=re_...
//   EMAIL_TO=nickjoref@gmail.com           (optional, default shown)
//   EMAIL_FROM=onboarding@resend.dev       (optional, default shown)
//   MIN_DAILY_PRICE_USD=40                 (optional, default shown)
//
// Usage:
//   node src/send-email.js                 # uses today's date in America/Chicago
//   node src/send-email.js 2026-05-23      # explicit date override
//
// Exits non-zero on any failure so the launchd wrapper sees it.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const ENV_PATH = join(homedir(), ".config", "turo-scraper", ".env");
const ANTHROPIC_MODEL = "claude-haiku-4-5";
const ANTHROPIC_VERSION = "2023-06-01";

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
  // en-CA gives YYYY-MM-DD format directly
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

function computeStats(tiguans) {
  const competitors = tiguans.filter((t) => !t.is_mine);
  const dailies = competitors.map((t) => t.avg_daily_usd).filter((n) => typeof n === "number");
  if (dailies.length === 0) return { n: 0, median: null, min: null, max: null };
  return {
    n: dailies.length,
    median: Number(median(dailies).toFixed(2)),
    min: Math.min(...dailies),
    max: Math.max(...dailies),
  };
}

async function callClaude({ apiKey, payload }) {
  const url = "https://api.anthropic.com/v1/messages";
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    if (res.ok) {
      const data = await res.json();
      const textBlock = data.content?.find((b) => b.type === "text");
      if (!textBlock) throw new Error("Anthropic response had no text block");
      return { text: textBlock.text, usage: data.usage };
    }
    const body = await res.text();
    const retryable = res.status === 429 || res.status === 500 || res.status === 529;
    if (!retryable || attempt === 2) {
      throw new Error(`Anthropic ${res.status}: ${body.slice(0, 500)}`);
    }
    console.error(`  Anthropic ${res.status} on attempt ${attempt}, retrying in 30s...`);
    await new Promise((r) => setTimeout(r, 30000));
  }
}

async function sendViaResend({ apiKey, from, to, subject, text }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, text }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Resend ${res.status}: ${body.slice(0, 500)}`);
  return JSON.parse(body);
}

function buildPrompt({ runDate, windowA, windowB, statsA, statsB, myListings }) {
  const formatTiguan = (t) =>
    `  ${t.listing_id}  ${t.year} ${t.model}  host="${t.host_name || "?"}"  ` +
    `total=$${t.total_charged_usd}  daily=$${t.avg_daily_usd}` +
    (t.is_mine ? "  [MINE]" : "");

  const formatWindow = (label, w, stats) => {
    if (!w) return `${label}: NO DATA TODAY`;
    return [
      `${label}: ${w.query.start_date} -> ${w.query.end_date} (${w.query.days} days)`,
      `  Competitors (n=${stats.n}): median $${stats.median}/day, min $${stats.min}, max $${stats.max}`,
      `  Listings:`,
      ...w.tiguans.map(formatTiguan),
    ].join("\n");
  };

  const myIds = myListings.listings.map((l) => l.listing_id);
  const myInWindowA = (windowA?.tiguans || []).filter((t) => myIds.includes(t.listing_id));
  const myInWindowB = (windowB?.tiguans || []).filter((t) => myIds.includes(t.listing_id));

  return `Date: ${runDate} (America/Chicago)

WINDOW A (3-day rental, immediate):
${formatWindow("Window A", windowA, statsA)}

WINDOW B (4-day rental, next week):
${formatWindow("Window B", windowB, statsB)}

MY LISTINGS (per config/my-listings.json):
${myListings.listings.map((l) => `  ${l.listing_id}: ${l.label}`).join("\n")}

Tiguans currently listed in Window A: ${myInWindowA.map((t) => t.listing_id).join(", ") || "NONE"}
Tiguans currently listed in Window B: ${myInWindowB.map((t) => t.listing_id).join(", ") || "NONE"}

Write a brief daily pricing email I can read in 10 seconds. Format:

Subject line idea (one line, ≤80 chars).

Then plain-text body with:
1. One-line summary of competitor pricing for each window (median + spread).
2. For each of my listings × each window:
   - If listed: current daily price, where I rank vs competitors, and a suggested daily price + 1-line rationale.
   - If not listed in that window: "Tiguan <id> (<label>): not listed in window <X> — booked, paused, or removed."
3. End with one sentence of "what to do today" if anything is actionable, else "No action needed."

Keep it scannable. No greeting, no signoff. Output the subject on its own first line prefixed with "SUBJECT: ", then a blank line, then the body.`;
}

const SYSTEM_PROMPT = `You are a Turo pricing advisor for a Volkswagen Tiguan host in Austin, TX.

Your job: read scraped competitor data plus the host's own listing prices and recommend a daily rental price for each of the host's listings, with a short rationale.

Rules:
- Never suggest a price below the floor (will be told via min_daily). Hard stop.
- Bias toward bookings: if the host's price is the highest in the window and there's no obvious quality edge (newer year, all-star host), suggest a drop toward the competitor median.
- Bias toward margin: if the host is below median and the median is well above the floor, suggest staying put or nudging up $2-5.
- Quality signals: car year (newer = premium), "All-Star Host" badge in host_name, host name with "Best" or similar reputation cues.
- Never suggest a price above 120% of the highest competitor in the window.
- Be concrete. Use specific dollar amounts and rank positions ("3rd of 7 listings"). No hedging.
- Output must be plain text. No markdown formatting (no **, no ##, no bullets with -). Use indentation and blank lines for structure.`;

async function main() {
  const env = loadEnvFile(ENV_PATH);
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY || env.RESEND_API_KEY;
  const EMAIL_TO = process.env.EMAIL_TO || env.EMAIL_TO || "nickjoref@gmail.com";
  const EMAIL_FROM = process.env.EMAIL_FROM || env.EMAIL_FROM || "onboarding@resend.dev";
  const MIN_DAILY = Number(process.env.MIN_DAILY_PRICE_USD || env.MIN_DAILY_PRICE_USD || 40);

  if (!ANTHROPIC_API_KEY) throw new Error(`ANTHROPIC_API_KEY missing (set in env or ${ENV_PATH})`);
  if (!RESEND_API_KEY) throw new Error(`RESEND_API_KEY missing (set in env or ${ENV_PATH})`);

  const runDate = process.argv[2] || chicagoToday();
  const dataDir = join(REPO_ROOT, "data");
  const fileA = join(dataDir, `AUS-Tiguans-${runDate}-window-a-3day.json`);
  const fileB = join(dataDir, `AUS-Tiguans-${runDate}-window-b-4day.json`);
  const configFile = join(REPO_ROOT, "config", "my-listings.json");

  console.error(`Building email for ${runDate}`);
  console.error(`  window A: ${fileA}`);
  console.error(`  window B: ${fileB}`);

  const myListings = JSON.parse(readFileSync(configFile, "utf8"));

  const missing = [];
  let windowA = null;
  let windowB = null;
  if (existsSync(fileA)) windowA = JSON.parse(readFileSync(fileA, "utf8"));
  else missing.push(fileA);
  if (existsSync(fileB)) windowB = JSON.parse(readFileSync(fileB, "utf8"));
  else missing.push(fileB);

  // Alert mode: missing data → send a terse alert, exit 0 (the alert IS the success)
  if (missing.length > 0) {
    console.error(`Missing data files: ${missing.join(", ")}`);
    const alertBody =
      `Today's Turo scrape data files were not found:\n\n` +
      missing.map((m) => `  ${m}`).join("\n") +
      `\n\nThe local scraper may have failed. Check logs/run-${runDate}.log on the Mac.\n` +
      `Run \`launchctl print gui/$(id -u)/com.nickorefice.turo-tiguans\` for launchd status.`;
    await sendViaResend({
      apiKey: RESEND_API_KEY,
      from: EMAIL_FROM,
      to: EMAIL_TO,
      subject: `[ALERT] Turo scrape missing for ${runDate}`,
      text: alertBody,
    });
    console.error("Sent alert email.");
    return;
  }

  const statsA = computeStats(windowA.tiguans);
  const statsB = computeStats(windowB.tiguans);
  console.error(`  window A: ${statsA.n} competitors, median $${statsA.median}/day`);
  console.error(`  window B: ${statsB.n} competitors, median $${statsB.median}/day`);

  const userPrompt = buildPrompt({ runDate, windowA, windowB, statsA, statsB, myListings });

  console.error(`Calling Anthropic (${ANTHROPIC_MODEL})...`);
  const { text, usage } = await callClaude({
    apiKey: ANTHROPIC_API_KEY,
    payload: {
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT.replace("(will be told via min_daily)", `($${MIN_DAILY}/day)`),
      messages: [{ role: "user", content: userPrompt }],
    },
  });
  console.error(`  used ${usage?.input_tokens} input + ${usage?.output_tokens} output tokens`);

  // Parse "SUBJECT: ..." from the first line, body from the rest.
  let subject = `Turo Austin daily — ${runDate}`;
  let body = text;
  const subjectMatch = text.match(/^SUBJECT:\s*(.+?)\s*\n/);
  if (subjectMatch) {
    subject = subjectMatch[1].trim();
    body = text.slice(subjectMatch[0].length).trimStart();
  }

  console.error(`Sending email to ${EMAIL_TO}...`);
  const sendResult = await sendViaResend({
    apiKey: RESEND_API_KEY,
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject,
    text: body,
  });
  console.error(`  Resend id: ${sendResult.id}`);
}

main().catch((err) => {
  console.error("Fatal:", err?.stack || err);
  process.exit(1);
});
