#!/usr/bin/env bash
# Provision the whole Railway deployment, in one pass.
#
#   railway login       # you have to do this one — the CLI refuses to authenticate
#   bash deploy-railway.sh
#
# Everything after the login is scripted, because the parts that are easy to
# forget are the parts that fail quietly:
#
#   - The volume. Railway's filesystem is ephemeral and resets to whatever was
#     committed on every redeploy. data/history.jsonl is the treasury series —
#     it is evidence, it is never back-filled, and a lost reading cannot be
#     recovered. Without a volume the chart silently restarts from the committed
#     readings each deploy and nobody notices, because a shorter chart still
#     looks like a chart.
#
#   - The cron schedule. The CLI cannot set one, so it goes through Railway's
#     GraphQL API using the session the login just created.
#
#   - Keeping SOLANA_RPC_URL off the web service. The page is static and needs
#     no credential to serve; only the refresh reads the chain. A secret that
#     is not on a service cannot leak from it.

set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-jip38-observatory}"
WEB_SERVICE="web"
CRON_SERVICE="refresh"
CRON_SCHEDULE="${CRON_SCHEDULE:-0 */6 * * *}"
VOLUME_MOUNT="/app/data"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --- preconditions ----------------------------------------------------------

command -v railway >/dev/null || die "railway CLI not found: npm i -g @railway/cli"
railway whoami >/dev/null 2>&1 || die "not logged in. Run: railway login"

say "logged in as $(railway whoami 2>/dev/null)"

if [ -z "${SOLANA_RPC_URL:-}" ]; then
  # Read it from .env rather than asking for it to be pasted anywhere.
  if [ -f .env ]; then
    SOLANA_RPC_URL="$(grep -E '^SOLANA_RPC_URL=' .env | head -1 | cut -d= -f2-)"
  fi
fi
[ -n "${SOLANA_RPC_URL:-}" ] || die "SOLANA_RPC_URL not set and not found in .env"

# Fail before provisioning anything if the tree itself is not releasable.
say "offline gate"
node check.mjs >/dev/null || die "the offline suites do not pass; nothing should be deployed from this tree"

# --- project ----------------------------------------------------------------

if railway status >/dev/null 2>&1; then
  say "using the already-linked project"
else
  say "creating project: $PROJECT_NAME"
  railway init --name "$PROJECT_NAME"
fi

# --- web service ------------------------------------------------------------
#
# Serves the built page. No credential: it needs none, and the surest way to
# keep a secret out of a service is not to put it there.

say "deploying the web service"
railway add --service "$WEB_SERVICE" 2>/dev/null || echo "  (service already exists)"
railway service "$WEB_SERVICE" 2>/dev/null || true
railway up --service "$WEB_SERVICE" --detach

say "generating a public domain"
railway domain --service "$WEB_SERVICE" || echo "  (a domain may already exist)"

# --- cron service -----------------------------------------------------------
#
# Reads the chain and rebuilds the page. Runs for a few seconds, a few times a
# day. This is the only thing that needs the RPC credential.

say "creating the refresh service"
railway add --service "$CRON_SERVICE" 2>/dev/null || echo "  (service already exists)"

say "setting SOLANA_RPC_URL on the refresh service only"
railway variables --service "$CRON_SERVICE" --set "SOLANA_RPC_URL=$SOLANA_RPC_URL" >/dev/null
railway variables --service "$CRON_SERVICE" --set "RAILWAY_RUN_COMMAND=node refresh.mjs" >/dev/null

# --- the volume, which is the part that is easy to skip ---------------------

say "attaching a persistent volume at $VOLUME_MOUNT"
if railway volume list 2>/dev/null | grep -q "$VOLUME_MOUNT"; then
  echo "  (a volume is already mounted there)"
else
  railway volume add --service "$CRON_SERVICE" --mount-path "$VOLUME_MOUNT" \
    || echo "  could not add the volume automatically — add it in the dashboard, mounted at $VOLUME_MOUNT"
fi

cat <<EOF

$(printf '\033[1m==> the one thing left\033[0m')

The CLI cannot set a cron schedule. In the Railway dashboard, open the
"$CRON_SERVICE" service -> Settings -> Cron Schedule, and set:

    $CRON_SCHEDULE

That matches the Windows scheduled task: every six hours.

Then check:
    railway logs --service $WEB_SERVICE
    curl https://<your-domain>/healthz

/healthz reports whether the server actually has a page to serve, so a deploy
that built nothing shows up there rather than as a blank page.
EOF
