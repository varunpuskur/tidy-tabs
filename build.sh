#!/bin/bash
# Usage: ./build.sh https://tidy-tabs.yourname.workers.dev
# Puts the trial server URL into background.js, runs the tests, and builds the Web Store zip.
set -euo pipefail
cd "$(dirname "$0")"
URL="${1:-}"
if [[ ! "$URL" =~ ^https://[a-z0-9.-]+$ ]]; then echo "Give the Worker URL, e.g. ./build.sh https://tidy-tabs.yourname.workers.dev"; exit 1; fi

# Replace whatever URL is there now (placeholder or an old one).
perl -pi -e "s#^const TRIAL_URL = \".*\";#const TRIAL_URL = \"$URL\";#" background.js
grep -q "const TRIAL_URL = \"$URL\";" background.js || { echo "Couldn't set TRIAL_URL"; exit 1; }

node test/run.js >/dev/null && echo "Extension tests passed" || { node test/run.js; exit 1; }
curl -fsS "$URL/" | grep -q tidy-tabs-trial && echo "Worker is up" || echo "Warning: $URL didn't answer like the Worker. Check DEPLOY.md step 2."

rm -f tidy-tabs-store.zip
zip -rq tidy-tabs-store.zip manifest.json background.js options.html options.js welcome.html welcome.js whatsnew.html whatsnew.js pages.css icons -x "*.DS_Store"
echo "Built tidy-tabs-store.zip (version $(grep '"version"' manifest.json | cut -d'"' -f4))"
