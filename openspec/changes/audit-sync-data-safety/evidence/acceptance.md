# Applicazione e verbale di accettazione

17 ottobre 2026, Windows. Change `audit-sync-data-safety`, applicata direttamente come richiesto dall'utente.
Base Git `9aeb8df323b4afc7654b8257c052a34ce00b965e`; le correzioni sono nella working tree, senza commit, push o rollout.
Il [baseline](verification.md) e le [riproduzioni negative](reproduction.md) restano evidenze storiche separate.

## Stato del requisito

Sono implementate le correzioni dei dieci difetti riprodotti, la compilazione esclusivamente locale, la conservazione
delle operazioni con autore/dispositivo e i percorsi integrati di undo, restore e Recovery. **La change non è ancora
interamente accettata e non certifica l'assenza assoluta di perdita dati in ogni configurazione.** I punti aperti sono
elencati sotto e restano senza spunta in `tasks.md`.

Le richieste di autorizzazione firewall scadute mentre l'utente è AFK sono una condizione ambientale, non un bug
dimostrato della piattaforma. Nessuna regola firewall è stata modificata e nessun prompt è stato approvato automaticamente.

## Correzioni applicate

- Compilazione: rimosse elezione, build per altri peer, risultati remoti e relativo probe hardware. Ogni sessione attiva
  compila su questa macchina, anche per i viewer; i seed non avviano compilatori. PDF/log/SyncTeX generati restano locali.
  Un PDF caricato come sorgente continua a sincronizzarsi. Le preferenze legacy migrano verso la modalità locale.
- Persistenza: stato del documento e registro dell'operazione sono atomici; errori conservano il pending e vengono
  mostrati fino al retry. Preimage e delta sono conservati a chunk, anche prima del grouping di Changes. Batch grandi
  riprendono dal suffisso non confermato. Il bridge locale frammenta messaggi grandi senza alzare il limite del frame.
- Provenienza: envelope firmati conservano autore e dispositivo originali attraverso inoltri e seed. Ticket, ruolo,
  epoch e revoca continuano a governare le scritture attuali; verificare una firma storica non restituisce permessi.
  Autori legacy sconosciuti restano esplicitamente sconosciuti.
- Eliminazioni e conflitti: tombstone con identità stabile e frontier causale; edit concorrenti al delete e versioni
  binarie concorrenti restano recuperabili. Una nuova versione successiva riapre un conflitto risolto in precedenza.
  Delta che eliminano fisicamente identità trattenute sono conservati e messi in quarantena prima dell'applicazione.
- Mirror: errori di lettura/scansione non significano file assenti. Il mirror sospende le mutazioni e riprova; conserva
  gli edit esterni non importati e quelli dei viewer. Native/Node trattengono l'inode originale in `.hivetex-recovery/`
  e pubblicano senza sovrascrivere un atomic-save concorrente. Restano recuperabili anche scritture tardive attraverso
  un handle già aperto. Collisioni case/Unicode/nomi riservati/file-directory e path duplicati sono bloccate anche in build.
- Undo e restore: baseline lazy completi, gruppi separati per origine/dispositivo, inversioni con precondizioni e
  checkpoint durevole. Un contributo successivo impedisce l'undo distruttivo della creazione. Restore rifiuta preview
  superate e permessi revocati; richieste persistenti e `undoOf` impediscono la doppia applicazione dopo un riavvio.
- UI: History → Recovery espone eliminati, conflitti, orfani legacy e copie private, con download/restore/Keep both/
  Keep deleted. Testo incompleto non viene scaricato come stringa vuota. L'export integrale include manifest SHA-256,
  documenti grezzi, blob trattenuti, metadati, snapshot, Changes e materiale pending/denied; dichiara le letture mancanti.
- Upgrade: IndexedDB v3 rifiuta un opener v2. Native conserva il vecchio SQLite e pubblica una copia verificata nello
  store `.safety-v1.sqlite3`; formati futuri sono rifiutati prima di modificare dati. Un vecchio binario può leggere la
  copia precedente, che non contiene gli edit successivi: downgrade non equivale a tornare indietro nel progetto.

Il confronto con Overleaf usa il checkout upstream fissato a `e039ad26c5bf5422eb57b89fc7e57c75055e631d` e i riferimenti
nel [rapporto](../audit-report.md). Sono stati ripresi i principi di versioni, provenienza, cancellazioni recuperabili e
restore esplicito, adattandoli al modello P2P/Yjs. Non viene attribuita a Overleaf una garanzia universale di assenza di bug.

Le cartelle browser sono ora importazioni in sola lettura. Il picker chiede `mode: read`, la preview registra le
modifiche al progetto e non viene avviato alcun mirror. Anche una chiamata diretta all'adapter rifiuta write/remove.
Il test browser con handle File System Access reali verifica che edit successivi e vecchi binding salvati non cambino
la cartella sorgente. La decisione segue il requisito prioritario dell'utente, confermato dalla richiesta di finire
il lavoro: non si accetta implicitamente il rischio della corsa finale del mirror browser.

L'export nativo completo crea una copia SQLite coerente, ne verifica l'integrità e la trasferisce in blocchi di 1 MiB.
Questa include tutte le tabelle, anche cronologia aggregata oltre il budget IPC e ingress pending/denied; i documenti
vivi dell'actor e del renderer sono inclusi separatamente. Test Rust riapre una copia con undici snapshot da 16 MiB,
superiore a 160 MiB, e verifica contenuti, versione coerente e journal. Test del worker Node reale verifica trasferimento
e chiusura in caso di completamento/interruzione. L'export non dipende più dal grande elenco JSON di snapshot/Changes.

## Regressioni dei dieci difetti

Queste sono asserzioni del comportamento corretto, eseguite dal normale test runner; non si riesegue lo script negativo
aspettandosi che continui a dimostrare perdita dati.

| Difetto | Prova positiva e comportamento richiesto |
| --- | --- |
| F01 | `apps/web/test/fs-access.test.ts`, `packages/sync/test/mirror-safety.test.ts`, `mirror-node-safety.test.ts`: permesso/I/O/scansione fallita non cancellano né inventano file vuoti; ripresa dopo recupero. |
| F02 | `mirror-safety.test.ts`: byte esterni non importati sopravvivono al delete prima del watcher; `mirror-node-safety.test.ts` e test Rust mirror verificano pubblicazione concorrente e handle tardivi. |
| F03 | `data-safety.test.ts`: delete/edit su tre repliche resta recuperabile e visibile come conflitto; `e2e/recovery.spec.ts` scarica e ripristina il testo esatto su due browser. |
| F04 | `data-safety.test.ts`, `changelog.test.ts`: undo-create rifiutato dopo contributi successivi, anche a testo finale uguale e su tre repliche. |
| F05 | `changelog.test.ts`: riapertura lazy, delete e undo conservano l'intero testo originale. |
| F06 | `changelog.test.ts`: la patch cartella non ingloba il contributo editor interleaved; l'inverso lascia quest'ultimo intatto. |
| F07 | `data-safety.test.ts`: Alice → Bob → Carol resta firmata da Alice; seed/reconnect deduplicano la storia; dispositivi dello stesso autore restano distinti. Il backup GitHub usa la stessa provenienza. |
| F08 | `changelog.test.ts`: il primo edit lazy è registrato con baseline corretto. |
| F09 | `changelog.test.ts`: edit e rename nello stesso gruppo restano entrambi invertibili. |
| F10 | `changelog.test.ts`, `operation-journal.test.ts`, `durability.test.ts`: errore di history/commit conserva pending, rollback atomico e retry; riapertura prima del grouping non perde la storia. |

Ulteriori prove: `version-restore.test.ts` riapre copie sacrificabili a checkpoint/prepared/committed/completed;
`operation-journal.test.ts` verifica store memory/IndexedDB/SQLite, upgrade v2→v3 e documento da 7 MiB con cronologia
attraverso NativePersistence e codec reale; test IPC JS e Rust scambiano payload grandi attraverso pipe e processi Node
reali. Il test da 7 MiB usa un backend SQLite di test, non un'istanza Tauri completa: questi livelli sono distinti.

## Ripetibilità e gate

Ambiente: Node `22.22.0`, pnpm `10.34.6`, Turbo `2.11.7`, Rust `1.93.1`, lockfile del progetto. Installazione di verifica:
worktree Git detached sacrificabile, applicazione del diff e dei nuovi file di questa change, esclusi `BUGS.md` e
`__conntests.txt` dell'utente; `pnpm install --offline --frozen-lockfile`, riuscito senza download. Le dipendenze erano
disponibili nella cache pnpm: non è una prova di provisioning interamente offline su un computer vergine.

Il target Cargo viene riusato per evitare ricompilazioni delle dipendenze, ma gli esempi sono sempre ricostruiti dal
checkout in esame. Sono state provate sia l'assenza dell'eseguibile RTC sia una sua copia obsoleta: il helper ricostruisce
il bridge e non usa quello vecchio. Sul checkout senza risorse Node prepara il runtime fissato e il worker corrente.
Una successiva preparazione calda riusa anche la licenza Node senza richiedere rete.

Esiti definitivi in [acceptance-results.json](acceptance-results.json), log conservati in [outputs](outputs/clean-gates.log).
Il [manifest delle sorgenti](source-manifest.json) identifica 118 file modificati/eliminati; il checkout sacrificabile
è stato confrontato byte per byte con la working tree finale. Gli artefatti OpenSpec e i due file preesistenti
dell'utente sono esclusi da questo fingerprint.

| Verifica | Risultato |
| --- | --- |
| Build/lint/test completi dal checkout pulito | **27/27**, zero cache, 5m33,666s. |
| Sync, dopo l'ultima regressione aggiunta | **483 pass**, bridge RTC ricostruito e obbligatorio, zero skip. |
| Compilazione locale | **37 pass**, inclusi i due test nativi obbligatori con PDF reale, zero skip. |
| Web, dopo l'avviso aggiunto all'export | **323 pass**; build e lint ripetuti sui file aggiornati. |
| Server | **181 pass, 15 skip** per servizi esterni/opzioni di laboratorio non configurati. |
| GitHub | **29 pass**, inclusa attribuzione dell'autore originale. |
| Rust | **150 pass, 5 ignored**, incluse copia SQLite >160 MiB e pipe Rust↔Node reali. |
| Browser | **11 pass**, zero retry, incluso WASM reale, cache calda offline, Recovery e migrazione delle cartelle import-only. |
| Tipi Svelte | **0 errori, 15 warning in 8 file**. |
| JS iniziale gzip | **181,8 KB**, budget 250 KB. |
| Policy CI/deploy | **17 pass**. |
| Dipendenze | **1 moderate, 0 high, 0 critical**; percorso esbuild documentato sotto. |

Il gate completo è seguito da una nuova esecuzione delle suite sync/web per i soli aggiornamenti finali, insieme a
build/lint web, tipi e budget. I numeri della tabella sono quelli della versione finale, non una somma di test duplicati.
I warning comprendono dichiarazioni di output Turbo per task senza artefatti, avvisi Svelte/accessibilità e diagnostica
Vite alla chiusura intenzionale dei client. Non sono test falliti. Gli skip server riguardano Redis/Neon HTTP,
parità backend e soak non abilitati; non diventano prove riuscite di infrastruttura esterna.

Comandi principali:

```powershell
$env:HIVETEX_NATIVE_TESTS = '1'
$env:CARGO_TARGET_DIR = Join-Path $env:TEMP 'p2platex-acceptance-cargo-target'
pnpm exec turbo run build lint test --force --concurrency=1 --env-mode=loose --output-logs=errors-only
pnpm --filter @hivetex/web exec svelte-check --tsconfig ./tsconfig.json --threshold error
pnpm --filter @hivetex/web size
# da apps/desktop/src-tauri
cargo test --locked --lib -- --test-threads=1
# dalla root
pnpm exec playwright test e2e/changes.spec.ts e2e/recovery.spec.ts e2e/folder-import.spec.ts e2e/compile-modes.spec.ts e2e/full-flow.spec.ts e2e/offline-and-compile.spec.ts e2e/compiler-state.spec.ts e2e/local-real-compile.spec.ts --retries=0 --reporter=list
node --test scripts/deploy-production.test.mjs scripts/advisory-report.test.mjs
pnpm audit --audit-level=high
openspec validate audit-sync-data-safety --strict
```

`--env-mode=loose` serve a passare al processo di test i due prerequisiti espliciti sopra: Turbo strict li elimina.
`--force` esclude successi da task cache. CI richiede separatamente bridge RTC/TeX, test Rust, smoke reale WASM e browser
per sicurezza dati, senza `continue-on-error`. I laboratori browser più ampi restano advisory. Non è stato eseguito un
push e non si dichiara un run GitHub Actions remoto verde.

Il primo gate pulito completo è riuscito (27/27). Dopo le ultime integrazioni un nuovo run ha trovato il volume `F:`
senza spazio sufficiente per l'archivio Cargo (OS error 112), prima di poter eseguire i test RTC. La pulizia della cache
generata è stata rifiutata dal controllo automatico; nessun file è stato cancellato. Le dipendenze compilate sono state
copiate su `C:` senza spostare o rimuovere gli originali. Bridge ricostruiti con `cargo build --locked --offline` e
verifica finale con `CARGO_NET_OFFLINE=true`. Questo guasto di spazio non viene attribuito al protocollo o al firewall.

Controprova negativa del gate: con `HIVETEX_IGNORE_SYSTEM_TEX=1` e compiler obbligatorio, entrambi i test nativi
falliscono con `Required native TeX compiler is unavailable`; nessuno skip viene contato come compilazione riuscita.
Questo è un guasto indotto tramite ambiente, non una conclusione ricavata da un prompt firewall scaduto.

Un run Rust sotto carico simultaneo ha superato di 0,78 s la soglia del test che serializza 2.000 invii verso un worker
che non legge. Il successivo run completo ha dato **150 pass, 0 fail, 5 ignored**, mantenendo la soglia di dieci secondi
e le asserzioni sulla coda e sul lettore. Non sono stati allentati test o cambiati timeout per ottenere il risultato.

La prova di fault della migrazione ora riusa una sorgente immutabile con il writer chiuso: ricrearne una nuova a ogni
punto poteva cambiare il coalescing degli update root e quindi il numero di scritture da interrompere. Rimane
l'asserzione che tutte le scritture target/manifest siano state interrotte e che i digest originali e riaperti coincidano.
L'aspettativa del test di salvataggio pieno è aggiornata per richiedere l'avviso di cronologia non ancora durevole;
il testo non salvato deve comunque essere presente esattamente nello ZIP.

### Compilazione reale e simulazioni

I due test `compile/test/native.test.ts` usano il bridge Rust ricostruito e MiKTeX disponibile su questa macchina:
producono PDF con firma `%PDF`, SyncTeX, aggiornamento incrementale e un errore LaTeX intenzionale. Non sono mock.
Lo smoke `e2e/local-real-compile.spec.ts` avvia il WASM vendorizzato reale, legge il PDF renderizzato e ricompila con cache
calda dopo avere chiuso la fixture dei pacchetti. La fixture serve pacchetti fissati per la vecchia versione del motore;
non sostituisce l'engine. Hash e provenienza sono in `e2e/tex-fixture.ts`.

Gli altri test UI usano intenzionalmente l'engine simulato di `newUser` per verificare routing locale e stati; non sono
conteggiati come compilazioni LaTeX reali. I cinque test Rust ignorati riguardano installazioni reali TinyTeX/Tectonic,
CPU idle e apertura del terminale OS. La suite verde non implica che quei test siano stati eseguiti.

## Dipendenza esbuild

Decisione: documentare la mancata esposizione del percorso vulnerabile nella configurazione esaminata, senza forzare
un override incompatibile del transpiler legacy. `pnpm why esbuild -r` trova `0.18.20` solo in
`server → drizzle-kit → @esbuild-kit/esm-loader → @esbuild-kit/core-utils`. È una devDependency; il wrapper installato
usa `transformSync`/`transform`, non `serve`/`context`/`startService`. Gli script di build/migrazione e il deployment
non avviano il server esbuild di quella copia. Vite/tsx risolvono esbuild `0.28.2`, il toolchain diretto `0.25.12`.
I test server applicano le migrazioni Drizzle a database PGlite sacrificabili, oltre alla build del server.

L'[advisory ufficiale GHSA-67mh-4wv8-2f99](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99)
riguarda la funzione di server sviluppo nelle versioni fino a `0.24.2`. `pnpm audit` continua quindi a segnalare
**1 moderate, 0 high, 0 critical**: la dipendenza vulnerabile non è stata eliminata. Usarne in futuro la funzione serve
riaprirebbe l'esposizione; questa conclusione vale per i percorsi esaminati, non per qualunque script aggiunto in seguito.

## Punti aperti, senza accettazione implicita

| Ambiente | Eseguito qui | Limite della prova |
| --- | --- | --- |
| Più browser, tre repliche e relay a 12 peer | Sì | Stessa macchina; nessuna conclusione su NAT remoto. |
| Trasporto RTC nativo e compilazione nativa | Sì | Bridge e motore locali; non due desktop fisici. |
| WASM reale e cache calda senza server pacchetti | Sì | Fixture di pacchetti fissata, non installazione gestita da Internet. |
| Desktop↔desktop e browser↔desktop su macchine distinte | No | Mancano due ambienti fisici controllabili. |
| STUN/TURN, due reti, deaf session e hold cinque minuti | No | Matrice residua della change trasporto, non dedotta dai test localhost. |
| TinyTeX/Tectonic gestiti da zero | No | Non si basa l'accettazione su download o prompt firewall AFK. |

1. **Accettazione fisica e rete.** Eseguiti browser multipli, mesh a tre repliche, RTC nativo e relay a 12 peer su questa
   macchina. Restano desktop↔desktop e misto con UI completa su macchine distinte, NAT/STUN/TURN su due reti, deaf session
   e hold cinque minuti della matrice `reliable-sync-transport`. Localhost non prova quei casi.
2. **Provisioning reale.** TeX nativo già installato e WASM reale/cache calda sono verificati; download/installazione
   gestita TinyTeX/Tectonic da zero e relativi pacchetti non sono stati eseguiti in questa accettazione.
3. **Retention e guasti esterni.** Questa release conserva materiale grezzo anche oltre il pruning dei gruppi e può
   consumare disco. Gli errori sono visibili e bloccano operazioni distruttive; ciò non è una garanzia contro guasto
   fisico del disco o eliminazione manuale dello store. Le copie filesystem native richiedono hard link supportati;
   l'assenza del supporto produce un errore conservativo.
4. **Risorse dell'export e liste UI.** L'archivio completo nativo non è limitato a 160 MiB, ma il ZIP finale viene
   assemblato in memoria e richiede spazio per la copia SQLite. Esaurimento memoria/disco rimane un errore esplicito.
   Elenchi UI estremamente grandi possono ancora superare il budget di un messaggio senza eliminare materiale storico;
   il backup integrale resta disponibile tramite il percorso a blocchi. Non si promette un export di dimensione illimitata.

Non archiviare la change né dichiarare soddisfatto il requisito assoluto finché i punti applicabili non sono risolti
e le prove residue non sono registrate. Nessuno di questi limiti viene trasformato in una spunta di completamento.
