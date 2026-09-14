#!/usr/bin/env bash
# Provision the whole Railway deployment, in one pass.
#
#   railway login       # you have to do this one — the CLI refuses to
#                       # authenticate non-interactively, browserless included
#   bash deploy-railway.sh
#
# ---------------------------------------------------------------------------
# ONE SERVICE, NOT TWO
#
# The obvious design is a web service that serves and a cron service that reads
# the chain. This script built that first, and it silently does not work: each
# Railway service is its own container with its own disk, so the cron service
# rebuilds dist/dashboard.html inside ITSELF while the web service goes on
# serving a copy nothing ever updates. Both deployments stay green and the page
# never changes. A volume cannot bridge it — a volume instance binds to exactly
# one service.
#
# So there is one service. It serves, and it refreshes itself on a timer in the
# same process, writing to the same disk it reads from.
#
# The rest of what is scripted here is scripted because forgetting it fails
# quietly:
#
#   - The volume at /app/data. Railway's filesystem resets to whatever was
#     committed on every redeploy, and data/history.jsonl is the treasury
#     series — evidence, never back-filled, and a lost reading cannot be
#     recovered. Without it the chart restarts from the committed readings each
#     deploy, and a shorter chart still looks like a chart.
#
#   - PORT. Railway's edge returns "Application not found" if it cannot work out
#     which port to route to, while the container sits there serving happily.
# ---------------------------------------------------------------------------

set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-jip38-observatory}"
SERVICE="${SERVICE:-web}"
REFRESH_MINUTES="${REFRESH_MINUTES:-360}"   # six hours, matching the Windows task
VOLUME_MOUNT="/app/data"
APP_PORT="${APP_PORT:-8080}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --- preconditions ----------------------------------------------------------

command -v railway >/dev/null || die "railway CLI not found: npm i -g @railway/cli"
railway whoami >/dev/null 2>&1 || die "not logged in. Run: railway login"
say "logged in as $(railway whoami 2>/dev/null)"

if [ -z "${SOLANA_RPC_URL:-}" ] && [ -f .env ]; then
  # Read from .env rather than having it pasted anywhere.
  SOLANA_RPC_URL="$(grep -E '^SOLANA_RPC_URL=' .env | head -1 | cut -d= -f2-)"
fi
[ -n "${SOLANA_RPC_URL:-}" ] || die "SOLANA_RPC_URL not set and not found in .env"

# Fail before provisioning anything if the tree itself is not releasable.
say "offline gate"
node check.mjs >/dev/null || die "the offline suites do not pass; nothing should be deployed from this tree"

# --- project and service ----------------------------------------------------

if railway status >/dev/null 2>&1; then
  say "using the already-linked project"
else
  say "creating project: $PROJECT_NAME"
  railway init --name "$PROJECT_NAME"
fi

say "deploying $SERVICE"
railway add --service "$SERVICE" 2>/dev/null || echo "  (service already exists)"
railway service "$SERVICE" >/dev/null 2>&1 || true

# --- variables --------------------------------------------------------------
#
# PORT is set explicitly so the container and Railway's edge agree. Without it
# the edge 404s while the container serves happily, which reads as a broken
# deploy rather than a routing gap.

say "setting variables"
railway variables --service "$SERVICE" \
  --set "PORT=$APP_PORT" \
  --set "SOLANA_RPC_URL=$SOLANA_RPC_URL" \
  --set "REFRESH_INTERVAL_MINUTES=$REFRESH_MINUTES" >/dev/null
echo "  PORT=$APP_PORT  REFRESH_INTERVAL_MINUTES=$REFRESH_MINUTES  SOLANA_RPC_URL=(set)"

# --- the volume, which is the part that is easy to skip ---------------------

say "persistent volume at $VOLUME_MOUNT"
if railway volume list --json 2>/dev/null | grep -q '"mountPath": *"'"$VOLUME_MOUNT"'"'; then
  echo "  (already mounted)"
else
  # MSYS_NO_PATHCONV stops Git Bash on Windows rewriting /app/data into a
  # Windows path, which the CLI then rejects as not starting with a slash.
  MSYS_NO_PATHCONV=1 railway volume add -m "$VOLUME_MOUNT" \
    || echo "  could not add it automatically — add it in the dashboard at $VOLUME_MOUNT"
fi

# --- deploy -----------------------------------------------------------------

say "staging the upload: the committed tree, plus the live cycle's state"
#
# Staged from `git archive HEAD` rather than uploading the working directory, so
# what is deployed is exactly what is committed: no uncommitted edit, no .env,
# nothing untracked rides along by accident.
#
# The ledger and the decoded sweeps are hours of RPC work and are not committed
# (tens of megabytes, rewritten every cycle). They go in bootstrap/, compressed,
# and server.mjs unpacks each onto the volume only if the volume has none — so
# shipping them again on a later deploy is harmless: the volume's own, newer
# copies are never replaced.
[ -z "$(git status --porcelain --untracked-files=no)" ] \
  || echo "  NOTE: there are uncommitted changes; they will NOT be deployed"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
git archive HEAD | tar -x -C "$STAGE"
mkdir -p "$STAGE/bootstrap"
for f in track-state sweeps-state; do
  if [ -f "data/$f.json" ]; then
    gzip -9 -c "data/$f.json" > "$STAGE/bootstrap/$f.json.gz"
    echo "  bootstrap/$f.json.gz  $(du -h "$STAGE/bootstrap/$f.json.gz" | cut -f1)"
  else
    echo "  (no data/$f.json here — the live cycle skips ledger, sweeps and fees until the volume has one)"
  fi
done

say "uploading"
railway up "$STAGE" --path-as-root --service "$SERVICE" --detach

say "public domain"
railway domain --service "$SERVICE" 2>/dev/null || echo "  (a domain already exists)"

cat <<EOF

$(printf '\033[1m==> done\033[0m')

Check it:
    railway logs --service $SERVICE
    curl https://<your-domain>/healthz
    curl https://<your-domain>/cycle.json     # a couple of minutes after boot

/healthz reports whether the server actually has a page to serve, so a deploy
that built nothing shows up there rather than as a blank page.

The live cycle (ledger, sweeps, fees when due, refresh) runs inside the serving
process every $REFRESH_MINUTES minutes, the first shortly after boot, and records each
step at /cycle.json. A step that fails leaves the previously built page untouched
and still being served — stale and honest beats broken.
EOF
