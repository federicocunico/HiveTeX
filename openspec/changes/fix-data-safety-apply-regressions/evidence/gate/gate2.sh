#!/usr/bin/env bash
# Re-run of the parts touched by the reattach and Recovery fixes, same checkout and settings as gate.sh.
W=/c/Users/feder/AppData/Local/Temp/p2platex-acceptance-55a586ed4f344eb3b76dfc31fe14fc05
OUT=/c/Users/feder/AppData/Local/Temp/p2platex-gate/rerun
mkdir -p "$OUT"; : > "$OUT/results.tsv"
export HIVETEX_NATIVE_TESTS=1 CARGO_TARGET_DIR='C:\Users\feder\AppData\Local\Temp\p2platex-acceptance-cargo-target' CI=1
cd "$W" || exit 1
step() { local name=$1; shift; local t0=$SECONDS; "$@" > "$OUT/$name.log" 2>&1; printf '%s\t%s\t%ss\n' "$name" "$?" "$((SECONDS - t0))" | tee -a "$OUT/results.tsv"; }
step turbo pnpm exec turbo run build lint --force --concurrency=1 --env-mode=loose --output-logs=errors-only
step test-sync pnpm --filter @hivetex/sync exec vitest run --passWithNoTests --maxWorkers=2
step test-web pnpm --filter @hivetex/web exec vitest run --passWithNoTests --maxWorkers=2
step svelte-check pnpm --filter @hivetex/web exec svelte-check --tsconfig ./tsconfig.json --threshold error
step size pnpm --filter @hivetex/web size
step browser pnpm exec playwright test e2e/changes.spec.ts e2e/recovery.spec.ts e2e/folder-import.spec.ts e2e/compile-modes.spec.ts e2e/full-flow.spec.ts e2e/offline-and-compile.spec.ts e2e/compiler-state.spec.ts e2e/workspace.spec.ts e2e/local-real-compile.spec.ts --retries=0 --reporter=list
for c in audit-sync-data-safety reliable-sync-transport fix-data-safety-apply-regressions; do step "validate-$c" openspec validate "$c" --strict; done
echo DONE
