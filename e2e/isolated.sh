#!/usr/bin/env bash
# Launch a fully isolated Hermes Desktop for the Sidebar Tidy E2E.
#
#   e2e/isolated.sh <hermes-agent checkout with deps> <template state.db> <scratch dir>
#
# Isolation matters: a dev Desktop pointed at a HERMES_HOME alone still finds
# the host's live gateway (host-wide rendezvous under XDG_STATE_HOME) and the
# real ~/.hermes/profiles. HOME, XDG_* and HERMES_GATEWAY_LOCK_DIR are all
# redirected into the scratch dir so the instance sees only the fixture.
#
# Prereqs in the checkout: `npm ci --workspace apps/desktop --include-workspace-root`
# (Node >= 26), `node node_modules/electron/install.js` if the binary is missing,
# and `node apps/desktop/scripts/bundle-electron-main.mjs --dev`. Start Vite
# yourself on 127.0.0.1:5194 (`npx vite --host 127.0.0.1 --port 5194 --strictPort`
# in apps/desktop). The template state.db is any freshly initialised Hermes
# state.db (schema only is used).
set -euo pipefail
CHECKOUT=$(cd "$1" && pwd)
TEMPLATE=$(realpath "$2")
S=$(mkdir -p "$3" && cd "$3" && pwd)
HERE=$(cd "$(dirname "$0")/.." && pwd)
HERMES_SRC=${HERMES_DESKTOP_HERMES_ROOT:-$CHECKOUT}

# A gateway from a previous run outlives Electron; stop anything still bound to
# this scratch home before swapping its state.db.
for pid in $(grep -l "HERMES_HOME=$S/home" /proc/[0-9]*/environ 2>/dev/null | cut -d/ -f3); do
  kill "$pid" 2>/dev/null || true
done
sleep 2
rm -rf "$S/home" "$S/ud" "$S/locks" "$S/xdg" "$S/fakehome"
mkdir -p "$S/home/desktop-plugins" "$S/ud" "$S/locks" "$S/xdg" "$S/fakehome"
python3 "$HERE/e2e/fixture_sql.py" "$TEMPLATE" "$S/home"
mkdir -p "$S/home/desktop-plugins/sidebar-tidy"
cp "$HERE/plugin.js" "$S/home/desktop-plugins/sidebar-tidy/plugin.js"

cd "$CHECKOUT/apps/desktop"
exec env HOME="$S/fakehome" HERMES_HOME="$S/home" HERMES_GATEWAY_LOCK_DIR="$S/locks" \
  XDG_STATE_HOME="$S/xdg" XDG_CONFIG_HOME="$S/fakehome/.config" XDG_DATA_HOME="$S/fakehome/.local/share" \
  HERMES_DESKTOP_HERMES_ROOT="$HERMES_SRC" HERMES_DISABLE_LAZY_INSTALLS=1 \
  HERMES_DESKTOP_DEV_SERVER=http://127.0.0.1:5194 HERMES_DESKTOP_CDP_PORT=9333 \
  xvfb-run -a -s "-screen 0 1440x1000x24" "$CHECKOUT/node_modules/electron/dist/electron" . \
  --user-data-dir="$S/ud" --no-sandbox
