#!/usr/bin/env bash
# VideoMerge — one-click local dev server
set -euo pipefail

cd "$(dirname "$0")"

info() { printf '-> %s\n' "$*"; }
ok()   { printf 'OK %s\n' "$*"; }
fail() { printf 'ERROR %s\n' "$*" >&2; exit 1; }

echo ""
echo "  VideoMerge local dev server"
echo "  ---------------------------"

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js not found. Install from https://nodejs.org/"
fi
if ! command -v npm >/dev/null 2>&1; then
  fail "npm not found. Reinstall Node.js."
fi

ok "Node $(node -v)"

if [[ ! -d node_modules ]]; then
  info "Running npm install ..."
  npm install
  ok "Dependencies installed"
else
  ok "Dependencies ready"
fi

PORT="${PORT:-5173}"
info "Starting http://localhost:${PORT}/"
info "Press Ctrl+C to stop"
echo ""

exec npm run dev -- --host 127.0.0.1 --port "${PORT}" --open
