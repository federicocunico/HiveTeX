# Verifiche dell'audit sul codice precedente alle correzioni

Commit `9aeb8df323b4afc7654b8257c052a34ce00b965e`, Windows, 16 ottobre 2026. Nessun push eseguito. Questi risultati attestano il baseline esaminato, non l'implementazione della proposta.

| Comando / prova | Esito osservato |
| --- | --- |
| `pnpm turbo run build lint test --concurrency=1 --output-logs=errors-only --force` | 27 successful / 27 total; zero cache; 4m21s. Prima ricostruiti `rtc_cli` e `tex_cli`; prima della ricostruzione due test RTC fallivano sul binario precedente. |
| `cargo build --locked --example rtc_cli --example tex_cli` da `apps/desktop/src-tauri` | Successo. |
| `pnpm --filter @hivetex/web exec svelte-check --tsconfig ./tsconfig.json --threshold error` | 0 errori, 11 warning in 7 file. |
| `pnpm --filter @hivetex/web size` | JS iniziale 172,3 KB gzip, budget 250 KB. |
| `node --test scripts/deploy-production.test.mjs scripts/advisory-report.test.mjs` | 17 pass, zero fail/skip. |
| `cargo test --locked --lib -- --test-threads=1` da `apps/desktop/src-tauri` | 146 pass, 5 ignored. |
| `pnpm exec playwright test e2e/realtime.spec.ts e2e/offline-and-compile.spec.ts e2e/changes.spec.ts --reporter=list` | 5 pass, 1 skip (application relay non abilitato). |
| `pnpm audit --audit-level=high` | Exit 0; una vulnerabilità moderate, nessuna high/critical segnalata. |
| `pnpm audit --json` | Esbuild 0.18.20 transitivo da `server > drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils`; GHSA-67mh-4wv8-2f99. |
| `openspec validate audit-sync-data-safety --strict` | Valido. |

Test unitari estratti dai log dei singoli package: sync 433 pass; compile 59 pass; web 320 pass; server 181 pass / 15 skip. Il run Turbo include anche altri package e stub desktop: non equivale a un installer testato.

## Smoke nativo reale

Il bridge ricostruito `tex_cli.exe` ha rilevato `flavor: miktex`, engine pdfLaTeX/XeLaTeX/LuaLaTeX, `verified_reads: true`. Richiesta sacrificabile con un solo `main.tex`, contenuto `\documentclass{article}\begin{document}HiveTeX local audit\end{document}`, timeout 45 s, memoria 2048 MB.

Risposta: `ok: true`, `timed_out: false`, `need: []`, PDF 14128 byte, primi quattro byte `%PDF`. Il test Playwright del baseline attende canvas e transizione stale, ma usa l'engine simulato predisposto da `newUser`: non costituisce una verifica LaTeX/WASM reale. La fase apply aggiunge `e2e/local-real-compile.spec.ts` disabilitando quel simulatore.

## Dipendenza segnalata

L'[advisory originale esbuild](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99) riguarda il server di sviluppo della funzione serve nelle versioni fino a 0.24.2; correzione disponibile da 0.25.0. La presenza transitiva è confermata, l'esposizione della funzione vulnerabile nel deployment di HiveTeX non è stata dimostrata. Non viene classificata come un undicesimo difetto di perdita dati riprodotto. Valutare aggiornamento compatibile del toolchain o documentare con prova l'assenza del percorso vulnerabile.

## Riproduzioni negative

Lo script conservato in [reproduction.md](reproduction.md) ha prodotto tutti i dieci risultati riportati in `../audit-report.md`. I testi seguenti sono evidenze minime del run:

```json
{
  "lazy-first-edit": {"text": "changed", "recorded": 0},
  "lazy-delete-undo": {"beforeRecorded": "", "restored": "", "originalDoc": "original"},
  "undo-create-after-edit": {"visibleFiles": 0, "retainedHiddenDoc": "author A plus later contribution"},
  "mixed-source-undo": {"after": "base", "incorrectlyIncluded": "folder EDITOR"},
  "edit-then-rename": {"recordedOp": "rename", "afterUndo": {"path": "a.tex", "text": "after"}},
  "history-write-failure": {"failed": true, "historyAfterRetry": 0},
  "three-peer-attribution": {"actualAuthor": "alice", "recordedAuthor": "bob"},
  "linked-delete-edit": {"visibleA": 0, "visibleB": 0, "hiddenText": "base important concurrent work"},
  "browser-permission-error": {"readResult": null, "visibleFiles": 0, "physicalContent": "original"},
  "remote-delete-before-watcher": {"diskFile": false, "projectFiles": 0}
}
```

## Autorizzazione alla fase successiva

Dopo la richiesta iniziale di proposta/audit, l'utente ha aggiunto: «alla fine, procedi con apply direttamente». Questa nuova istruzione autorizza l'applicazione dopo il completamento e la validazione degli artefatti, senza una nuova richiesta di conferma. Gli esiti della fase apply saranno riportati separatamente dal baseline di questo documento.
