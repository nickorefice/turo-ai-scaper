#!/bin/bash
# Builds bin/ScrapeRunner.app — the TCC-grantable AppleScript wrapper
# around bin/run-scrape.sh.
#
# macOS LaunchAgents that exec a bash script directly cannot access
# ~/Documents (TCC blocks it), and as of Sonoma 14.4+/Sequoia, /bin/bash
# itself cannot be added to Full Disk Access. The Apple-blessed
# workaround is to wrap the script in an AppleScript applet, which is
# a proper .app bundle that TCC tracks by bundle ID — children inherit
# its FDA grant.
#
# After running this, you MUST grant the applet Full Disk Access in
# System Settings → Privacy & Security → Full Disk Access → "+".
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="$REPO/bin/ScrapeRunner.app"
SCRIPT="$REPO/bin/run-scrape.sh"
LOG="/tmp/scrape-runner-stdout.log"

rm -rf "$APP"
osacompile -o "$APP" -e "do shell script \"$SCRIPT > $LOG 2>&1\""

PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string com.nickorefice.scraperunner' "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.nickorefice.scraperunner' "$PLIST"
/usr/libexec/PlistBuddy -c 'Add :CFBundleDisplayName string "Turo Scrape Runner"' "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c 'Set :CFBundleDisplayName "Turo Scrape Runner"' "$PLIST"
/usr/libexec/PlistBuddy -c 'Add :LSUIElement bool true' "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c 'Set :LSUIElement true' "$PLIST"

echo "Built $APP"
echo "Next: System Settings → Privacy & Security → Full Disk Access → + → add this applet."
