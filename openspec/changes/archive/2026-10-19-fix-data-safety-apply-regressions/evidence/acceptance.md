# Verbale di accettazione

18 ottobre 2026, Windows 11 Pro 26200. Change `fix-data-safety-apply-regressions`, applicata nella working tree sulla
base Git `9aeb8df`, senza commit, push o rollout. Build pesanti su `C:` (`CARGO_TARGET_DIR` e `E2E_TARGET_DIR` in
`%TEMP%\p2platex-acceptance-cargo-target`); nessuna cache o target dell'utente cancellato; firewall dell'host non
modificato e nessun prompt approvato.

## Difetti trovati e corretti durante l'applicazione

- **Crash del worker desktop alla perdita di rete** (presente anche in 0.8.0): `ws.onerror` del socket di signaling
  richiamava `close()`, che con il WebSocket di Node/undici rilancia `error` in modo sincrono → ricorsione fino allo
  stack overflow, worker uscito con codice 70, progetto aperto in "attachment closed". Corretto in
  `packages/sync/src/connect.ts` (handler staccato prima della chiusura) con il test
  `connect-lifecycle.test.ts` "a signaling socket that fails while connecting…", che fallisce sul codice precedente.
- **13 chiamate del renderer rifiutate dal worker** (`unknown worker method`): Recovery, undo/restore interrotti,
  export dello store e `mesh.reconcileDoc` mancavano dall'allowlist Rust. Corretto in `worker_service.rs`; il test
  `every_renderer_call_is_allowed` legge `renderer.ts` e fallisce se una chiamata manca.
- **`MemoryPersistence.transact` O(store)**: copiava le mappe a ogni transazione (5.4 a 290–500 ms per edit); ora valida
  e poi applica in place (~30 ms).
- Il worker registra ora i primi 15 frame distinti dello stack di un'eccezione non gestita.

Correzioni dell'harness `make sandbox-sync` (non del prodotto): echo UDP dell'host in un processo figlio, probe
host→sandbox chiuso una sola volta, scenario offline senza righe sovrapposte (le sovrapposizioni vanno in "Resolve
conflicts" per design), confronto degli autori senza maiuscole, sabotaggio esteso ai file binari, blocco reale in
`FAULT=offline` (il sandbox ha la regola "Container: allow outbound"), errori etichettati con lato e azione, nuovo
scenario `compile`, avvio non bloccante delle build.

## Esiti

| Verifica | Esito | Evidenza |
| --- | --- | --- |
| Sync | 529 pass + nuovo test del socket | log dei run di gruppo 1–7 |
| Compilazione | 39 pass | idem |
| Web | 335 pass, inclusi i due test 5.5 dell'export in streaming | idem |
| Rust | 161 pass, 7 ignored, + `every_renderer_call_is_allowed` | idem |
| Export 1 GiB | pass: picco +8 MiB, chiamata concorrente peggiore 1,4 ms | `docs/desktop-storage.md` |
| Browser | `workspace.spec` 11/11; lista CI 21/21 | idem |
| Desktop e2e | 12/12 + lifecycle; dopo il riaggancio 13/13 + lifecycle; nessun processo residuo | [desktop-e2e.log](desktop-e2e.log), [desktop-e2e-reattach.log](desktop-e2e-reattach.log) |
| Endpoint durante i test | cargo e sync: 0 socket fuori da loopback; browser: solo UDP WebRTC di Chromium | [endpoints-*.json](.) |
| Scenari sandbox (9.2) | **PASS** tutti: basic, assets, rename-delete, offline, crash, author, recovery, folder, compile, mixed | [runs/2026-10-18T06-29-36-all](runs/2026-10-18T06-29-36-all/) |
| Build locale reale (9.4) | **PASS**: host MiKTeX, sandbox "quick compiler" gestito; PDF con marcatore, errore con 2 diagnostiche e ultimo PDF conservato, build offline dalla cache, nessun PDF all'altro lato né output nel progetto | [runs/…-compile](runs/2026-10-18T06-25-54-compile/) |
| Matrice trasporto (9.3) | stun FAIL atteso; turn, relay, relay-stun, deaf, no-udp **PASS** | [matrix.md](matrix.md) |
| Sabotaggio (8.4) | ogni scenario fallisce sulla regressione indotta | `runs/…-sabotage*` |
| Fault (8.2) | `offline` e `no-udp` verificati, setup fail-fast | `runs/…-fault-offline5`, `runs/…-no-udp` |
| Firewall/raggiungibilità (8.1, 8.3) | simulazione con regola mancante ferma al preflight con `firewall:`; diagnosi `reachability:` | `runs/…-fw-sim`, `runs/…-basic` |
| Interruzione (8.5) | Ctrl+C → `INTERRUPTED`, pulizia; `summary.json` scritto anche se lo staging fallisce | `runs/…-interrupt`, `runs/…-stagefail` |

Il sandbox Windows e l'host sono la stessa macchina fisica, con il sandbox dietro il NAT Hyper-V del Default Switch:
questi risultati non valgono per NAT reali, VPN o router di altri utenti. Senza relay non si forma un link diretto tra i
due (ICE `checks-failed`), anche se l'echo UDP passa in entrambe le direzioni; gli scenari di dati usano TURN e il relay
applicativo.

## Gate integrato (9.1)

Checkout di verifica: worktree detached `%TEMP%p2platex-acceptance-55a586ed…` su `9aeb8df`, con la working tree
copiata (diff dei file tracciati identico, file nuovi confrontati byte per byte; esclusi `BUGS.md` e `__conntests.txt`
dell'utente); lo stato precedente del checkout dell'audit è conservato nel suo `git stash`. Target Cargo su `C:`,
`HIVETEX_NATIVE_TESTS=1`, `CI=1`. Versioni: Node 22.22.0, pnpm 10.34.6, Turbo 2.11.7, Rust/Cargo 1.93.1.
Script e log in [gate/](gate/) (`gate.sh`, poi `gate2.sh` per la riesecuzione).

Il primo tentativo con `turbo run build lint test` è stato fermato da Claude Code per memoria critica: i test del
server non limitano i worker e ognuno avvia un Postgres in memoria (~1,5 GB). Il gate esegue quindi
`turbo run build lint --force` e poi i test di ogni pacchetto uno alla volta con `vitest run --maxWorkers=2` (lo stesso
limite che sync, compile e web applicano già in CI). Nessuna soglia o asserzione è stata allentata.

| Verifica | Esito |
| --- | --- |
| `pnpm install --offline --frozen-lockfile` | ok, nessun download |
| `turbo run build lint --force` | 18/18, 0 da cache |
| Test protocol / crypto / ui / github / compile | 3 / 7 / nessun test / 29 / 39 pass |
| Test sync | **531 pass** (incluso il nuovo test del riaggancio) |
| Test web | **335 pass** |
| Test server | **181 pass, 15 skip** (Redis/Neon HTTP, parità backend e soak non configurati, come nell'audit) |
| svelte-check | 0 errori, 12 warning in 7 file |
| Budget JS iniziale | 189,2 KB gz su 250 KB |
| `cargo test --lib` | **162 pass, 7 ignored** (TinyTeX/Tectonic reali, CPU idle, terminale OS, export da 1 GiB eseguito a parte) |
| Browser: lista CI + `workspace.spec.ts` + `local-real-compile.spec.ts` | **22/22**, zero retry |
| Policy CI/deploy | 17 pass |
| `pnpm audit --audit-level=high` | 1 moderate, 0 high, 0 critical (esbuild 0.18.20, non esposto: vedi verbale dell'audit) |
| `openspec validate --strict` | valide le tre change |

Il primo giro completo ha avuto un fallimento: `e2e/recovery.spec.ts` (circa 1 run su 3). Causa: il test provocava
delete ed edit concorrenti prima che l'editor avesse il file confermato completo; aprire un file ne scarica il
contenuto ma solo una riconciliazione lo certifica, quindi Recovery mostrava, correttamente, "conflict status unknown".
Il test ora attende la conferma su entrambi i lati prima di intercettare i messaggi (10/10 ripetizioni). Inoltre
Recovery si aggiorna quando il contenuto di un file eliminato diventa completo (prima l'etichetta restava superata fino
a un altro evento). Dopo queste correzioni e il riaggancio del worker sono stati rieseguiti build/lint con `--force`,
test sync e web, svelte-check, budget, lista browser e validate ([gate/rerun](gate/rerun/)): tutti verdi.

## Collegamenti alle altre change (9.5)

- `audit-sync-data-safety` 8.3 e 8.4: spuntate con le evidenze sopra.
- `audit-sync-data-safety` 8.5: aperta. La matrice è eseguita in sandbox, ma la verifica su due reti reali non ha un
  report nel repository (`reliable-sync-transport` 8.3 è spuntata senza evidenza allegata).
- `reliable-sync-transport` 8.1: aperta, collegata a [matrix.md](matrix.md). Il task chiede che ogni scenario passi, e
  "STUN only" non passa su questa macchina (nessun link diretto host↔sandbox senza relay).

## Riaggancio dopo il riavvio del worker (corretto)

Prima: dopo un riavvio del worker il renderer desktop non si ricollegava e il progetto aperto rifiutava gli edit con
"attachment closed" fino alla riapertura. Ora, quando una nuova generazione segnala `ready`, l'editor riapre il
progetto con lo stesso attachment (gli edit già in custodia vengono riapplicati una volta dal nuovo worker), allinea i
documenti caricati e reinvia gli edit non ancora durevoli. Test: `worker-runtime.test.ts` "keeps the open editor
working across a worker restart" con un vero processo worker ucciso e sostituito (fallisce con il riaggancio
disattivato); e2e desktop "the sync worker dies with a project open" sull'app reale: il processo del worker viene
ucciso, un edit fatto durante il riavvio e uno successivo arrivano entrambi sul disco, il primo una sola volta.
Run completo dopo la correzione: 13/13 più lifecycle, nessun processo residuo ([desktop-e2e-reattach.log](desktop-e2e-reattach.log)).

## Verifica con il firewall dell'host attivo (follow-up, 19 ottobre 2026)

Firewall dell'host riattivato dall'utente (Domain, Private, Public). Con il firewall attivo e senza regola per l'app,
`SCENARIOS=basic` si ferma al preflight con `firewall:` e nessun passo di sync
([runs/2026-10-18T11-23-38-fw-on-norules](runs/2026-10-18T11-23-38-fw-on-norules/)). `make sandbox-firewall` non aveva
una ricetta nel `Makefile` (target solo in `.PHONY`): aggiunta, poi eseguita elevata con il prompt UAC approvato
dall'utente (regole per l'app del sandbox, `node.exe` e Chromium).

Due cambi dell'ambiente rispetto al 18 ottobre hanno fermato lo harness, non il prodotto:

- **WMI nel sandbox**: dopo gli aggiornamenti Windows del 19 ottobre (KB5127648, KB5127690; LCU 10.0.26100.9711) ogni
  chiamata CIM nel sandbox risponde "Access is denied", anche a System; `setup.ps1` si fermava senza `setup.json`
  ([…-fw-on-basic2](runs/2026-10-19T06-44-10-fw-on-basic2/)). Gli script del sandbox usano ora `netsh advfirewall`, .NET
  (gateway, prova TCP) e il service manager; i JSON letti dall'host hanno la stessa forma.
- **WebView2 nel sandbox**: il registro dell'immagine del sandbox indica WebView2 154.0.4258.53, ma su disco c'è solo
  155.0.4283.62 (aggiornato sull'host il 18 alle 15:14); l'app si chiudeva con "Could not find the webview runtime"
  ([…-fw-on-basic5](runs/2026-10-19T06-57-02-fw-on-basic5/)). `launch.ps1` passa la cartella del runtime con
  `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` quando la versione registrata non esiste (scelta in `webview.txt`). Diagnosi su
  un sandbox persistente: [sandbox-probe-2026-10-19.txt](sandbox-probe-2026-10-19.txt).

| Verifica (firewall attivo) | Esito | Evidenza |
| --- | --- | --- |
| `SCENARIOS=basic` | **PASS**, 19/19 passi, edit in 81/50 ms | [runs/…-fw-on-basic6](runs/2026-10-19T07-01-43-fw-on-basic6/) |
| Matrice | stun FAIL atteso; turn 125/55, relay 79/55, relay-stun 88/56, deaf 66/50, no-udp 65/61 ms **PASS** | `runs/2026-10-19T07-*` |
| Tutti gli scenari | **PASS** (basic … mixed, inclusi offline e compile) | [runs/…-fw-on-all](runs/2026-10-19T07-13-52-fw-on-all/) |
| 1.1 `cargo test --lib` | 0 endpoint fuori da loopback | [endpoints-cargo-fw.json](endpoints-cargo-fw.json) |
| 1.2 suite sync | 531 pass, 0 endpoint fuori da loopback | [endpoints-sync-fw.json](endpoints-sync-fw.json) |
| 1.2 browser | test verdi; fuori da loopback solo UDP WebRTC di Chromium, come prima | [endpoints-browser-fw.json](endpoints-browser-fw.json) |
| Regole `hivetex*` nate dai test | nessuna (65 prima e dopo) | — |

Durante il campionamento degli endpoint (netstat ogni 100 ms) `relay-transport.test.ts` "recovers lost, duplicated and
reordered frames…" è fallito due volte per tempo (8 s) con i worker predefiniti; da solo 5/5, la suite con 2 worker
(come in CI) e tre giri con i worker predefiniti tutti verdi, poi verde anche sotto campionamento. Il test ora riporta
lo stato del trasporto quando la condizione non arriva.
