#!/bin/bash
# Daily multi-group scrape wrapper. Designed to be called from launchd or by hand.
# - Runs `node src/scrape.js` once (loops over all groups internally, shared browser).
# - Writes one JSON file per (group, window) into data/.
# - Validates each expected file exists and has listing_count >= 1.
# - Sends one email per group via Resend (independent invocations — one group's
#   email failure does not block the others).
# - Optionally commits + pushes the day's data files to GitHub when AUTO_COMMIT=1.
#
# Defaults:
#   AUTO_COMMIT=0    (override to 1 to enable commit/push; PAT must be installed)
#   GH_TOKEN_FILE=~/.config/turo-scraper/gh-token
#   SEND_EMAIL=1     (override to 0 to skip the per-group email loop)
set -euo pipefail

# Derive REPO from this script's location so future relocations don't
# need a code edit (just update the plist's absolute paths).
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="/opt/homebrew/bin/node"
LOCK="/tmp/turo-scraper.lock"
AUTO_COMMIT="${AUTO_COMMIT:-0}"
GH_TOKEN_FILE="${GH_TOKEN_FILE:-$HOME/.config/turo-scraper/gh-token}"
GH_REPO="nickorefice/turo-ai-scaper"

cd "$REPO"
mkdir -p data logs

DATE="$(date +%Y-%m-%d)"
LOG="logs/run-${DATE}.log"
CONFIG="config/my-listings.json"

log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG" >&2; }

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

log "starting scrape across all groups"
"$NODE" src/scrape.js 2>> "$LOG" > /dev/null
log "scrape finished"

# Validate per-(group, window) output files. Track which groups have full data.
OK_GROUP_IDS=()
FAILED_GROUP_IDS=()
COMMIT_FILES=()
for group in $GROUP_IDS; do
  group_ok=1
  for win in "window-a-3day" "window-b-4day"; do
    f="data/AUS-${group}-${DATE}-${win}.json"
    if [ ! -s "$f" ]; then
      log "  WARN: missing or empty: $f"
      group_ok=0
      continue
    fi
    COUNT="$(jq -r '.listing_count // 0' "$f" 2>/dev/null || echo 0)"
    if [ "$COUNT" -lt 1 ]; then
      log "  WARN: $f reports listing_count=$COUNT"
      group_ok=0
      continue
    fi
    log "  ok: $f (listing_count=$COUNT)"
    COMMIT_FILES+=("$f")
  done
  if [ "$group_ok" = "1" ]; then
    OK_GROUP_IDS+=("$group")
  else
    FAILED_GROUP_IDS+=("$group")
  fi
done

log "scrape summary: ok=[${OK_GROUP_IDS[*]:-}] failed=[${FAILED_GROUP_IDS[*]:-}]"

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
