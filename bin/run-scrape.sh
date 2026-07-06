#!/bin/bash
# Daily multi-group scrape wrapper. Designed to be called from launchd or by hand.
# - Runs `node src/scrape.js` once (loops over all groups internally, shared browser).
# - Writes one JSON file per (group, window) into data/.
# - Validates each expected file exists and has listing_count >= 1.
# - Sends one email per group via Resend (independent invocations — one group's
#   email failure does not block the others).
# - Optionally commits + pushes the day's data files to GitHub when AUTO_COMMIT=1.
# - Idempotent per day: after scrape+email succeeds, later scheduled invocations
#   exit without touching Turo. Use FORCE_RUN=1 to ignore the daily success stamp.
#
# Defaults:
#   AUTO_COMMIT=0    (override to 1 to enable commit/push; PAT must be installed)
#   GH_TOKEN_FILE=~/.config/turo-scraper/gh-token
#   SEND_EMAIL=1     (override to 0 to skip the per-group email loop)
#   START_JITTER_MAX_SECONDS=0
set -euo pipefail

# Derive REPO from this script's location so future relocations don't
# need a code edit (just update the plist's absolute paths).
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="/opt/homebrew/bin/node"
LOCK="/tmp/turo-scraper.lock"
AUTO_COMMIT="${AUTO_COMMIT:-0}"
GH_TOKEN_FILE="${GH_TOKEN_FILE:-$HOME/.config/turo-scraper/gh-token}"
GH_REPO="nickorefice/turo-ai-scaper"
START_JITTER_MAX_SECONDS="${START_JITTER_MAX_SECONDS:-0}"

cd "$REPO"
mkdir -p data logs

DATE="$(date +%Y-%m-%d)"
LOG="logs/run-${DATE}.log"
CONFIG="config/my-listings.json"
SUCCESS_STAMP="logs/success-${DATE}.stamp"

log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG" >&2; }

# launchd fires at fixed wall-clock times. Add an optional random startup delay
# so Turo does not see the same scrape cadence every day.
if [ "${FORCE_RUN:-0}" != "1" ] && [ "$START_JITTER_MAX_SECONDS" -gt 0 ] 2>/dev/null; then
  jitter_seconds=$((RANDOM % (START_JITTER_MAX_SECONDS + 1)))
  log "startup jitter enabled: sleeping ${jitter_seconds}s (max ${START_JITTER_MAX_SECONDS}s)"
  sleep "$jitter_seconds"
fi

# Lockfile (mkdir is atomic on macOS). Auto-clean on exit.
if ! mkdir "$LOCK" 2>/dev/null; then
  log "ERROR: another scrape is running (lock at $LOCK). Aborting."
  exit 1
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# Worktree preflight: refuse to run if anything outside data/ + logs/ is dirty.
DIRTY="$(git status --porcelain | awk '{print $2}' | grep -Ev '^(data/|logs/)' || true)"
if [ -n "$DIRTY" ]; then
  log "ERROR: refusing to run — uncommitted changes outside data/ + logs/:"
  printf '%s\n' "$DIRTY" | tee -a "$LOG" >&2
  exit 1
fi

# Discover groups from config (e.g., "tiguans taos corolla-hybrid civic 2-series").
if ! GROUP_IDS="$(jq -r '.groups[].group_id' "$CONFIG" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"; then
  log "ERROR: could not parse $CONFIG with jq"
  exit 1
fi
if [ -z "$GROUP_IDS" ]; then
  log "ERROR: no groups found in $CONFIG"
  exit 1
fi
log "discovered groups: $GROUP_IDS"

if [ "${FORCE_RUN:-0}" != "1" ] && [ -s "$SUCCESS_STAMP" ]; then
  log "daily success stamp exists ($SUCCESS_STAMP); skipping scrape/email"
  exit 0
fi

# Validate per-(group, window) output files. With 16 windows per group, we
# relax the "ok" criterion: a group is OK for emailing if AT LEAST ONE window
# has listing_count >= 1. The email layout handles missing/empty windows
# gracefully ("(no data)" rows in the summary table).
OK_GROUP_IDS=()
FAILED_GROUP_IDS=()
COMMIT_FILES=()
WINDOW_LABELS=(
  "wk1-weekdays-4day" "wk1-weekend-3day"
  "wk2-weekdays-4day" "wk2-weekend-3day"
  "wk3-weekdays-4day" "wk3-weekend-3day"
  "wk4-weekdays-4day" "wk4-weekend-3day"
  "wk5-weekdays-4day" "wk5-weekend-3day"
  "wk6-weekdays-4day" "wk6-weekend-3day"
  "wk7-weekdays-4day" "wk7-weekend-3day"
  "wk8-weekdays-4day" "wk8-weekend-3day"
)

existing_data_ok=1
for group in $GROUP_IDS; do
  group_windows_ok=0
  for win in "${WINDOW_LABELS[@]}"; do
    f="data/AUS-${group}-${DATE}-${win}.json"
    if [ ! -s "$f" ]; then
      continue
    fi
    COUNT="$(jq -r '.listing_count // 0' "$f" 2>/dev/null || echo 0)"
    if [ "$COUNT" -ge 1 ]; then
      group_windows_ok=$((group_windows_ok + 1))
    fi
  done
  if [ "$group_windows_ok" -lt 1 ]; then
    existing_data_ok=0
    break
  fi
done

if [ "${FORCE_RUN:-0}" != "1" ] && [ "$existing_data_ok" = "1" ]; then
  log "today's data already exists for all groups; skipping scrape and continuing to validation/email"
else
  log "starting scrape across all groups"
  "$NODE" src/scrape.js 2>> "$LOG" > /dev/null
  log "scrape finished"
fi

for group in $GROUP_IDS; do
  group_windows_ok=0
  group_windows_total=0
  for win in "${WINDOW_LABELS[@]}"; do
    f="data/AUS-${group}-${DATE}-${win}.json"
    group_windows_total=$((group_windows_total + 1))
    if [ ! -s "$f" ]; then
      log "  WARN: missing or empty: $f"
      continue
    fi
    COUNT="$(jq -r '.listing_count // 0' "$f" 2>/dev/null || echo 0)"
    if [ "$COUNT" -lt 1 ]; then
      log "  empty: $f (listing_count=0)"
      # Still commit the file — documents the bot-blocked attempt.
      COMMIT_FILES+=("$f")
      continue
    fi
    log "  ok: $f (listing_count=$COUNT)"
    COMMIT_FILES+=("$f")
    group_windows_ok=$((group_windows_ok + 1))
  done
  if [ "$group_windows_ok" -ge 1 ]; then
    OK_GROUP_IDS+=("$group")
    log "  $group: ${group_windows_ok}/${group_windows_total} windows have data"
  else
    FAILED_GROUP_IDS+=("$group")
    log "  $group: ALL ${group_windows_total} windows empty"
  fi
done

log "scrape summary: ok=[${OK_GROUP_IDS[*]:-}] failed=[${FAILED_GROUP_IDS[*]:-}]"

# Include the persistent host cache in the commit if it changed.
if [ -f "data/host-cache.json" ] && ! git diff --quiet -- data/host-cache.json 2>/dev/null; then
  COMMIT_FILES+=("data/host-cache.json")
  log "  host-cache.json: modified, will be included in commit"
fi

if [ "${#OK_GROUP_IDS[@]}" -eq 0 ]; then
  log "ERROR: no groups produced valid output — refusing to commit/email"
  exit 1
fi

# --- Per-group email sends FIRST. ---
# Emails are the user-facing output and must not be blocked by housekeeping
# (commit / push) failures further down. Each group is independent — one
# email failure does not block the others.
SEND_EMAIL="${SEND_EMAIL:-1}"
if [ "$SEND_EMAIL" = "1" ]; then
  for group in "${OK_GROUP_IDS[@]}"; do
    log "sending email for group: $group"
    if GROUP_ID="$group" "$NODE" src/send-email.js 2>> "$LOG"; then
      log "  email sent for $group"
    else
      log "  ERROR: email failed for $group"
    fi
  done
  # Send alert email per failed group (uses the [ALERT] codepath in send-email.js).
  for group in "${FAILED_GROUP_IDS[@]}"; do
    log "sending [ALERT] for failed group: $group"
    GROUP_ID="$group" "$NODE" src/send-email.js 2>> "$LOG" || log "  ERROR: alert send failed for $group"
  done
else
  log "SEND_EMAIL=$SEND_EMAIL, skipping email"
fi

{
  echo "date=${DATE}"
  echo "ok_groups=${OK_GROUP_IDS[*]:-}"
  echo "failed_groups=${FAILED_GROUP_IDS[*]:-}"
  echo "send_email=${SEND_EMAIL}"
  date -Iseconds
} > "$SUCCESS_STAMP"
log "wrote daily success stamp: $SUCCESS_STAMP"

# --- AUTO_COMMIT is housekeeping. Failures here log and continue. ---
# A push failure must NEVER block tomorrow's run (which only checks worktree
# cleanliness via the data/+logs/ filter, not whether origin is ahead).
if [ "$AUTO_COMMIT" = "1" ]; then
  if [ ! -r "$GH_TOKEN_FILE" ]; then
    log "WARN: AUTO_COMMIT=1 but PAT file not readable: $GH_TOKEN_FILE — skipping commit/push"
  else
    GITHUB_TOKEN="$(cat "$GH_TOKEN_FILE")"

    log "syncing with origin/main"
    if git fetch origin --quiet 2>> "$LOG" && git rebase --autostash origin/main 2>> "$LOG"; then
      OK_LIST="$(IFS=,; echo "${OK_GROUP_IDS[*]}")"
      log "staging + committing ${#COMMIT_FILES[@]} files for groups: ${OK_LIST}"
      git add -- "${COMMIT_FILES[@]}"
      if git diff --cached --quiet; then
        log "nothing to commit (files already match HEAD)"
      else
        git -c user.name="turo-scraper" -c user.email="scraper@localhost" commit \
          -m "data: AUS daily ${DATE} (${OK_LIST})" \
          2>> "$LOG" > /dev/null

        PUSH_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${GH_REPO}.git"
        log "pushing to ${GH_REPO}"
        if git push "$PUSH_URL" main 2>> "$LOG" > /dev/null; then
          log "push complete"
        else
          log "WARN: push failed (commit kept locally; will be pushed by next successful run)"
        fi
      fi
    else
      log "WARN: fetch/rebase failed — skipping commit/push"
      git rebase --abort 2>/dev/null || true
    fi
  fi
else
  log "AUTO_COMMIT=$AUTO_COMMIT, skipping git commit/push"
fi

log "wrapper complete"
