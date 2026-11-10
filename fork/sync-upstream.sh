#!/usr/bin/env bash
# Rebase the fork branch (custom) onto the latest upstream main. See FORK.md.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ "$(git rev-parse --abbrev-ref HEAD)" != "custom" ]; then
  echo "Check out the custom branch first." >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Commit or discard your changes first." >&2
  exit 1
fi

git remote get-url upstream >/dev/null 2>&1 ||
  git remote add upstream https://github.com/pingdotgg/t3code.git
# rerere replays a conflict resolution the next time the same conflict appears.
git config rerere.enabled true
git config rerere.autoupdate true

git fetch upstream main
git fetch origin custom
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/custom)" ]; then
  echo "Local custom differs from origin/custom. Pull or push first." >&2
  exit 1
fi

git tag -f custom-before-sync >/dev/null
echo "Rebasing $(git rev-list --count upstream/main..HEAD) fork commits onto upstream/main ($(git rev-parse --short upstream/main))."
git rebase upstream/main
pnpm install --frozen-lockfile

cat <<'NEXT'

Rebased. Undo with: git reset --hard custom-before-sync
Next:
  pnpm exec vp run check:changed
  git push --force-with-lease origin custom
  git push origin upstream/main:main
NEXT
