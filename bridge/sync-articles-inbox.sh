#!/usr/bin/env bash
#
# Sync the article-tracker xlsx (and any supporting docs) from a local
# operator machine to gda-ai01's openclaw-ess inbox. Elliot's Scraper
# agent reads from there.
#
# Usage (from a local Mac/Linux box):
#
#     ./sync-articles-inbox.sh
#
# Defaults:
#     LOCAL_DIR=$HOME/Downloads/essentialbaliNopenclaw/articles/
#     REMOTE   =gda-ai01:/opt/.openclaw-ess/inbox/articles/
#
# Override with env vars if your local path is different:
#
#     LOCAL_DIR=~/work/eb/articles ./sync-articles-inbox.sh
#
# After dev period ends and the local folder is removed, this script can
# be deleted or repurposed for a different ingestion source.
set -euo pipefail

LOCAL_DIR="${LOCAL_DIR:-$HOME/Downloads/essentialbaliNopenclaw/articles/}"
REMOTE_HOST="${REMOTE_HOST:-gda-ai01}"
REMOTE_DIR="${REMOTE_DIR:-/opt/.openclaw-ess/inbox/articles/}"

if [ ! -d "$LOCAL_DIR" ]; then
  echo "✕ local dir missing: $LOCAL_DIR" >&2
  exit 1
fi

echo "→ ensuring remote dir exists..."
ssh "$REMOTE_HOST" "mkdir -p $REMOTE_DIR"

echo "→ syncing $LOCAL_DIR → $REMOTE_HOST:$REMOTE_DIR"
rsync -avh --delete \
  --exclude='.DS_Store' --exclude='~$*' --exclude='.~lock.*' \
  "$LOCAL_DIR" "${REMOTE_HOST}:${REMOTE_DIR}"

echo "→ remote inventory:"
ssh "$REMOTE_HOST" "ls -la $REMOTE_DIR"

cat <<EOF

✓ synced. Next:

  ssh $REMOTE_HOST 'python3 /opt/.openclaw-ess/workspace-scraper/scripts/read-articles-xlsx.py | jq ".count"'

EOF
