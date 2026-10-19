#!/usr/bin/env bash
# Acceptance gate 9.1, run from the verification checkout. Each step: name, exit code, seconds -> results.tsv
W=/c/Users/feder/AppData/Local/Temp/p2platex-acceptance-55a586ed4f344eb3b76dfc31fe14fc05
OUT=/c/Users/feder/AppData/Local/Temp/p2platex-gate
mkdir -p "$OUT"
: > "$OUT/results.tsv"
export HIVETEX_NATIVE_TESTS=1
export CARGO_TARGET_DIR='C:\Users\feder\AppData\Local\Temp\p2platex-acceptance-cargo-target'
export CI=1
cd "$W" || exit 1
step() {
  local name=$1; shift
  local t0=$SECONDS
  echo "=== $name: $*" | tee -a "$OUT/gate.log"
  "$@" > "$OUT/$name.log" 2>&1
  local rc=$?
  printf '%s\t%s\t%ss\n' "$name" "$rc" "$((SECONDS - t0))" | tee -a "$OUT/results.tsv"
}
step versions bash -c 'node -v; pnpm -v; pnpm exec turbo --version; rustc --version; cargo --version; git -C . rev-parse HEAD'
step install pnpm install --offline --frozen-lockfile
step turbo pnpm exec turbo run build lint --force --concurrency=1 --env-mode=loose --output-logs=errors-only
for p in protocol crypto ui github compile sync web server; do
  step "test-$p" pnpm --filter "@hivetex/$p" exec vitest run --passWithNoTests --maxWorkers=2
done
step svelte-check pnpm --filter @hivetex/web exec svelte-check --tsconfig ./tsconfig.json --threshold error
step size pnpm --filter @hivetex/web size
step cargo bash -c 'cd apps/desktop/src-tauri && cargo test --locked --lib -- --test-threads=1'
step browser pnpm exec playwright test e2e/changes.spec.ts e2e/recovery.spec.ts e2e/folder-import.spec.ts e2e/compile-modes.spec.ts e2e/full-flow.spec.ts e2e/offline-and-compile.spec.ts e2e/compiler-state.spec.ts e2e/workspace.spec.ts e2e/local-real-compile.spec.ts --retries=0 --reporter=list
step policy node --test scripts/deploy-production.test.mjs scripts/advisory-report.test.mjs
step audit pnpm audit --audit-level=high
for c in audit-sync-data-safety reliable-sync-transport fix-data-safety-apply-regressions; do
  step "validate-$c" openspec validate "$c" --strict
done
echo DONE | tee -a "$OUT/gate.log"
