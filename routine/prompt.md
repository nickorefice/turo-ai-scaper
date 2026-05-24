# Daily Turo pricing routine

Run this every morning around 09:15 America/Chicago. You generate a short daily-pricing email for Nick's two Turo Tiguan listings in Austin and send it via the Resend API.

## Inputs available to you

- Env: `RESEND_API_KEY` (required), `MIN_DAILY_PRICE_USD` (default 40), `EMAIL_TO` (default `nickjoref@gmail.com`), `EMAIL_FROM` (default `onboarding@resend.dev`)
- `WebFetch` for HTTPS GETs (the only auth-free path to the scrape data)
- `Bash` for `date`, `jq`-style processing if you need it
- No `gh` CLI, no MCP servers required

## Step-by-step

### 1. Compute today's date in America/Chicago

The launchd scraper on Nick's Mac names files by local Chicago date (e.g. `2026-05-23`). You run in UTC. If you fire at 02:00 UTC, that's 21:00 yesterday in Chicago. Always compute `TODAY` as the date *in America/Chicago at the moment you run*.

```bash
TZ="America/Chicago" date +%Y-%m-%d
```

### 2. Fetch today's two data files

```
https://raw.githubusercontent.com/nickorefice/turo-ai-scaper/main/data/AUS-Tiguans-${TODAY}-window-a-3day.json
https://raw.githubusercontent.com/nickorefice/turo-ai-scaper/main/data/AUS-Tiguans-${TODAY}-window-b-4day.json
```

Cache raw.githubusercontent.com responses for ~5 min during the run.

**If either file 404s**, switch immediately to ALERT mode:
- Skip everything else
- Send email subject: `[ALERT] Turo scrape missing for ${TODAY}`
- Body: which file was missing, what the URLs were, suggest "check ~/Library/Logs/turo-scraper or run `launchctl print gui/$(id -u)/com.nickorefice.turo-tiguans`"
- Exit

### 3. Fetch the owner config

```
https://raw.githubusercontent.com/nickorefice/turo-ai-scaper/main/config/my-listings.json
```

This declares which `listing_id` values are Nick's. Use it as the source of truth (don't trust the scraper's `is_mine` flag if it disagrees — the config can change without a rescrape).

### 4. Optional: fetch yesterday's files for diff

```
https://raw.githubusercontent.com/nickorefice/turo-ai-scaper/main/data/AUS-Tiguans-${YESTERDAY}-window-a-3day.json
https://raw.githubusercontent.com/nickorefice/turo-ai-scaper/main/data/AUS-Tiguans-${YESTERDAY}-window-b-4day.json
```

On 404 (gap, first run, weekend skip): just omit the "change since yesterday" block. Don't error.

### 5. Compute competitor stats per window

For each window (A = 3-day, B = 4-day):
- Filter out Nick's listings (`is_mine: true`)
- Compute: median, min, max, and count of `avg_daily_usd` across competitors
- Note: Nick's `listings` are typically not in the competitor pool

### 6. For each of Nick's listings, decide a suggested price

Listings in `config/my-listings.json` (currently 2 Tiguans):
- `2189398` ("Tiguan A")
- `1695581` ("Tiguan B")

For each listing × each window:

**If the listing IS in today's scrape:**
- Current `avg_daily_usd`
- Position vs competitors (e.g. "$5/day above median, 3rd of 7")
- Suggested daily price + 1-2 sentence rationale

**Pricing judgment guidelines (you decide; these are weights, not rules):**
- Bias toward bookings. If Nick is the highest-priced in a window and no obvious quality edge, suggest a drop toward median.
- Bias toward margin. If Nick is below median and the median is well above `MIN_DAILY_PRICE_USD`, suggest staying put or nudging up $2-5.
- Quality signals to weigh: car year, host "All-Star" status, host name reputation (e.g., a host with "Best Host" in their name probably has reviews).
- **Hard floor:** never suggest below `MIN_DAILY_PRICE_USD` (default $40).
- **Hard ceiling:** never suggest > 120% of the highest current competitor price.

**If the listing is NOT in today's scrape** (e.g. booked, paused, removed):
- Print one explicit line: `Tiguan A (2189398): not listed in window A — booked, paused, or removed.`
- Don't compute a suggestion for that window.
- Do NOT silently omit.

### 7. Build the email body

Subject: `Turo Austin daily — ${TODAY}` (or `[ALERT] ...` per step 2)

Body (plain-text preferred; HTML optional):

```
Turo Austin — Volkswagen Tiguan — ${TODAY}

Window A (3 days, ${WINDOW_A_START} → ${WINDOW_A_END})
  Competitors (n=${N_A}): median $${MED_A}/day  min $${MIN_A}  max $${MAX_A}
  Tiguan A (2189398): {current $XX/day, rank Y/N — suggest $ZZ/day. <1-line why>}
                  OR  not listed
  Tiguan B (1695581): {...}

Window B (4 days, ${WINDOW_B_START} → ${WINDOW_B_END})
  Competitors (n=${N_B}): median $${MED_B}/day  min $${MIN_B}  max $${MAX_B}
  Tiguan A: {...}
  Tiguan B: {...}

Δ since ${YESTERDAY} (or "no prior data")
  competitor median window A: -$3
  competitor median window B: +$1
  any of Nick's listings newly appearing/disappearing

Raw data:
  https://github.com/nickorefice/turo-ai-scaper/blob/main/data/AUS-Tiguans-${TODAY}-window-a-3day.json
  https://github.com/nickorefice/turo-ai-scaper/blob/main/data/AUS-Tiguans-${TODAY}-window-b-4day.json
```

Keep it short. This email lands every morning — make it scannable in 10 seconds.

### 8. Send via Resend

```bash
curl -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer ${RESEND_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "'"${EMAIL_FROM}"'",
    "to": "'"${EMAIL_TO}"'",
    "subject": "'"${SUBJECT}"'",
    "text": "'"${BODY}"'"
  }'
```

On non-2xx response: do NOT fail silently. Print the response body to your stdout so it appears in routine logs.

## Critical reminders

- **Time zone**: `TODAY` is America/Chicago, not UTC. Re-check this every time you compute a date.
- **Missing listing ≠ missing data**: file present, listing absent → that's normal (Nick's car may be booked). File absent → that's ALERT mode.
- **Never invent prices**: if the scrape data shows tiguan_count=0 for a window (shouldn't happen given the wrapper's sanity check, but defensively), don't fabricate competitor stats. Skip the window with an explicit note.
- **One email per day**: don't retry on Resend errors unless you're sure no email went out (Resend's 4xx with a duplicate-detected message means it sent).
