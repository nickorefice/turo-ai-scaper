#!/bin/bash
# Daily scrape wrapper. Designed to be called from launchd or by hand.
# Writes data/AUS-Tiguans-YYYY-MM-DD-next-weekend.json and logs to logs/.
set -euo pipefail

REPO="/Users/nickorefice/Documents/GitHub/turo-ai-scaper"
NODE="/opt/homebrew/bin/node"

cd "$REPO"
mkdir -p data logs

DATE=$(date +%Y-%m-%d)
OUT="data/AUS-Tiguans-${DATE}-next-weekend.json"
LOG="logs/run-${DATE}.log"

echo "[$(date -Iseconds)] starting scrape -> $OUT" >> "$LOG"
MODE=next-weekend "$NODE" src/tiguans.js > "$OUT" 2>> "$LOG"
echo "[$(date -Iseconds)] done ($(wc -c <"$OUT") bytes)" >> "$LOG"
