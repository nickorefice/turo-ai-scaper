#!/bin/bash
# Daily scrape wrapper. Designed to be called from launchd or by hand.
# Writes two files (window A: 3-day, window B: 4-day), then commits + pushes to GitHub.
# Defaults:
#   AUTO_COMMIT=0    (override to 1 to enable commit/push; PAT must be installed)
#   GH_TOKEN_FILE=~/.config/turo-scraper/gh-token
set -euo pipefail

REPO="/Users/nickorefice/Documents/GitHub/turo-ai-scaper"
NODE="/opt/homebrew/bin/node"
LOCK="/tmp/turo-scraper.lock"
AUTO_COMMIT="${AUTO_COMMIT:-0}"
GH_TOKEN_FILE="${GH_TOKEN_FILE:-$HOME/.config/turo-scraper/gh-token}"
GH_REPO="nickorefice/turo-ai-scaper"

cd "$REPO"
mkdir -p data logs

DATE="$(date +%Y-%m-%d)"
LOG="logs/run-${DATE}.log"
OUT_A="data/AUS-Tiguans-${DATE}-window-a-3day.json"
OUT_B="data/AUS-Tiguans-${DATE}-window-b-4day.json"

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

log "starting scrape (window=all) -> $OUT_A, $OUT_B"
WINDOW=all OUT_DIR=data "$NODE" src/tiguans.js 2>> "$LOG" > /dev/null
log "scrape finished"

# Sanity check: both files exist, non-zero counts.
for f in "$OUT_A" "$OUT_B"; do
  if [ ! -s "$f" ]; then
    log "ERROR: missing or empty output file: $f"
    exit 1
  fi
  COUNT="$(jq -r '.tiguan_count // 0' "$f")"
  if [ "$COUNT" -lt 1 ]; then
    log "ERROR: $f reports tiguan_count=$COUNT — refusing to commit"
    exit 1
  fi
  log "  $f: tiguan_count=$COUNT"
done

if [ "$AUTO_COMMIT" != "1" ]; then
  log "AUTO_COMMIT=$AUTO_COMMIT, skipping git commit/push (files left for manual review)"
  exit 0
fi

if [ ! -r "$GH_TOKEN_FILE" ]; then
  log "ERROR: AUTO_COMMIT=1 but PAT file not readable: $GH_TOKEN_FILE"
  exit 1
fi
GITHUB_TOKEN="$(cat "$GH_TOKEN_FILE")"

log "syncing with origin/main"
git fetch origin --quiet 2>> "$LOG"
git rebase --autostash origin/main 2>> "$LOG" || {
  log "ERROR: rebase failed; aborting and resetting"
  git rebase --abort 2>/dev/null || true
  exit 1
}

log "staging + committing $OUT_A, $OUT_B"
git add -- "$OUT_A" "$OUT_B"
if git diff --cached --quiet; then
  log "nothing to commit (files already match HEAD)"
  exit 0
fi

git -c user.name="turo-scraper" -c user.email="scraper@localhost" commit \
  -m "data: AUS Tiguans ${DATE} (window-a 3day, window-b 4day)" \
  2>> "$LOG" > /dev/null

PUSH_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${GH_REPO}.git"
log "pushing to ${GH_REPO}"
git push "$PUSH_URL" main 2>> "$LOG" > /dev/null
log "push complete"
