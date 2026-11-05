#!/usr/bin/env bash
# Captures the whole app for a design review: every capture spec, each into its own folder.
#
#   pnpm build
#   bash e2e/scripts/design-capture.sh /some/dir [spec ...]
#
# With no spec names it runs all of them: the full-app suite (welcome, pairing, settings, history, devices)
# and the Home, sidebar, question, composer, follow-up, photo, terminal drawer and agent state captures.
# Each spec drives the real PWA against its own real relay on its own port, checks what it claims to show
# before it writes, and fails when an expected file is missing. Up to three specs run side by side
# (DESIGN_CAPTURE_JOBS to change it). The script fails if any spec fails or writes no images, and prints one
# line per spec with its image count.
set -uo pipefail

OUT="${1:?usage: design-capture.sh <output dir> [spec ...]}"
shift
SPECS=("$@")
if [ ${#SPECS[@]} -eq 0 ]; then
  SPECS=(screenshots home-capture sidebar-capture question-chat-capture composer-capture
    follow-ups-capture photos-capture terminal-drawer-capture agent-state-capture)
fi
JOBS="${DESIGN_CAPTURE_JOBS:-3}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
case "$(cd "$(dirname "$OUT")" 2>/dev/null && pwd)/" in
  "$ROOT"/*) echo "design-capture: write captures outside the repository, not $OUT" >&2; exit 2 ;;
esac
if [ ! -f "$ROOT/app/dist/index.html" ]; then
  echo "design-capture: app/dist is missing; run pnpm build first" >&2
  exit 2
fi
mkdir -p "$OUT"

run_spec() {
  local spec="$1" dir="$OUT/$1"
  rm -rf "$dir" && mkdir -p "$dir"
  (cd "$ROOT" && DESIGN_CAPTURE_DIR="$dir" pnpm --filter @daintreehq/decisions-e2e exec vitest run "tests/$spec.test.ts") \
    >"$OUT/$spec.log" 2>&1
  echo $? >"$OUT/$spec.exit"
}

# Batches rather than `wait -n`, which the bash that ships with macOS (3.2) lacks.
i=0
for spec in "${SPECS[@]}"; do
  run_spec "$spec" &
  i=$((i + 1))
  if [ $((i % JOBS)) -eq 0 ]; then wait; fi
done
wait

failed=0
for spec in "${SPECS[@]}"; do
  code="$(cat "$OUT/$spec.exit" 2>/dev/null || echo missing)"
  count="$(find "$OUT/$spec" -name '*.png' 2>/dev/null | wc -l | tr -d ' ')"
  echo "CAPTURE $spec exit=$code images=$count"
  if [ "$code" != 0 ] || [ "$count" -eq 0 ]; then failed=1; fi
done
total="$(find "$OUT" -name '*.png' | wc -l | tr -d ' ')"
echo "CAPTURE total=$total failed=$failed dir=$OUT"
exit "$failed"
