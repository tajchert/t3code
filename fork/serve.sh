#!/usr/bin/env bash
# Build and run the custom server on this machine. Extra arguments go to `t3 serve`.
# Pass --no-build as the first argument to reuse the last build.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

export T3CODE_HOME="${T3CODE_HOME:-$HOME/.t3-custom}"
export T3CODE_PORT="${T3CODE_PORT:-3783}"

if [ "${1:-}" = "--no-build" ]; then
  shift
else
  pnpm install --frozen-lockfile
  pnpm exec vp run --filter t3 build
fi

exec node apps/server/dist/bin.mjs serve --lan "$@"
