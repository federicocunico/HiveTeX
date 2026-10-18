# Tasks

Le correzioni si applicano sopra la working tree di `audit-sync-data-safety`, che non è committata.

Regole d'ambiente:
- Build e output pesanti vanno su un volume con spazio sufficiente. F: ha 1,6 GB liberi; usare `CARGO_TARGET_DIR`, per
  esempio il target esistente in `%TEMP%\p2platex-acceptance-cargo-target`.
- Non cancellare cache né target dell'utente.
- Non modificare il firewall dell'host e non approvare prompt.

## 1. Test locali indipendenti dal firewall e build E2E isolate

- [x] 1.1 Aggiungere a `Transport` un IP di bind configurabile e una `interface_policy` `loopback` in `rtc.rs`, usata dai test di `transport.rs` e `rtc.rs`, e spostare `muxed_gathering_keeps_ipv6_host_candidates` tra i test lab `#[ignore]`. Verifica: `cargo test --locked --lib -- --test-threads=1` con lo stesso numero di pass, e durante il run nessun endpoint UDP/TCP dei binari di test su indirizzi non loopback (`Get-NetUDPEndpoint`/`Get-NetTCPConnection`).
- [x] 1.2 Far accettare a `rtc_cli` `interfaces: "loopback"` e passarlo da `packages/sync/test/tauri-rtc.test.ts`; far accettare al server locale (`server/src/local.ts`) `HOST`, e usare `127.0.0.1` in Playwright e nei test locali. Verifica: suite sync e browser verdi; con il controllo endpoint di 1.1 nessun listener `node.exe` o `rtc_cli.exe` fuori da loopback.
- [x] 1.3 Rendere esplicito lo skip di `nativeTestBinary`: nome della suite, comando per abilitarla e riepilogo a fine run, mantenendo l'errore con `HIVETEX_NATIVE_TESTS=1`. Verifica: `pnpm --filter @hivetex/sync test` senza bridge mostra lo skip motivato; con la variabile e senza TeX fallisce.
- [x] 1.4 Far usare a `run.mjs`, `lifecycle.mjs`, `background.mjs` e `sandbox-sync.mjs` un `CARGO_TARGET_DIR` E2E dedicato e un output configurabile. Ogni harness deve controllare che non giri un'istanza `app.hivetex.desktop.e2e` e chiudere con `app_quit` prima del kill forzato. Verifica: dopo `make desktop-e2e`, `target/debug/hivetex-desktop.exe` è invariato e `Get-Process hivetex-desktop` non mostra residui.
- [x] 1.5 Documentare in `docs/testing.md` binding loopback, test lab, variabili `CARGO_TARGET_DIR`/output e la procedura per verificare l'assenza di prompt a firewall attivo. Verifica: i comandi documentati girano come scritti.

## 2. Registro con preimmagine proporzionale alla modifica

- [x] 2.1 Sostituire in `DocPersister` lo stato completo per transazione con un delta inverso: testo rimosso con posizioni, valori precedenti della root, hash dei blob sostituiti. Aggiungere snapshot deduplicati solo all'apertura di un gruppo e sulle operazioni che rimuovono più di metà del documento. Verifica: test di round trip delta inverso + update → testo precedente, con fuzz di 10.000 operazioni; F05/F08/F10 restano verdi.
- [x] 2.2 Rimuovere `before` dall'envelope firmato e dal payload di `signOperation`/`verifyOperation`, e calcolare il delta inverso sul ricevente in `applyAuthored`. Aggiornare `history-projection`. Verifica: F07 (Alice → Bob → Carol) e i test di firma alterata, replay e progetto errato restano verdi.
- [x] 2.3 Aggiungere il test di crescita dello spec `peer-sync`: 1.000 battiture su un documento da 100 KB con un co-autore, misurando byte aggiunti allo store e inviati. Fissare la soglia dopo la prima misura e registrarla in `docs/runtime.md`. Verifica: il test fallisce sul codice attuale e passa dopo 2.1–2.2.
- [x] 2.4 Convertire i record di sviluppo con `before` completo: restano letti come snapshot e non vengono più scritti. Verifica: test che riapre uno store creato con il formato dell'apply e mostra Changes e Recovery identici.

## 3. Eliminazioni compatibili e admission della radice

- [x] 3.1 Spostare le tombstone dal campo `deleted` di `files` a una mappa di root `tombstones` con lo stesso id e la stessa frontier. Ripristino, Keep both e Keep deleted devono operare sulla nuova mappa, con conversione idempotente degli store di sviluppo. Verifica: test F03 su tre repliche, rename/edit/delete concorrenti e restore, tutti verdi.
- [x] 3.2 Far sì che `admitRootUpdate` salvi in Recovery come "rimosso da <dispositivo>" le voci rimosse fisicamente senza tombstone e poi applichi l'update; rifiutare solo i formati futuri. Verifica: test con cancellazione pre-upgrade mentre l'altro peer è offline, più creazione di `b.tex`: `b.tex` arriva, `a.tex` è in Recovery una sola volta dopo tre riconnessioni, e non resta nessuna quarantena.
- [x] 3.3 Aggiungere un test con un vero peer 0.8.0: il pacchetto sync di `9aeb8df` estratto in un worktree temporaneo su C:. Il peer aggiornato elimina un file e il client 0.8.0 lo vede sparire e non lo riscrive; poi 0.8.0 elimina e il peer aggiornato applica e conserva in Recovery. Verifica: test verde e incluso nella suite sync richiesta.
- [x] 3.4 Aggiornare `docs/protocol.md` e `docs/desktop-storage.md` con la nuova rappresentazione e la compatibilità 0.8.0. Verifica: nessun riferimento rimasto al campo `deleted` dentro `files`.

## 4. Sync live indipendente da storage e cronologia

- [x] 4.1 Separare in `mesh.ts` la coda live per connessione dalla coda di cronologia, con priorità agli edit live. Inviare le operazioni locali dopo la firma senza attendere `storeAuthoredOperation`, e fare attendere a `model.flush()` solo la durabilità del documento. Verifica: test con store dell'autorità che fallisce in modo continuo, dove gli edit arrivano entro il tempo normale e l'avviso resta visibile; test con bootstrap della cronologia a Carol mentre Alice e Bob continuano a editare.
- [x] 4.2 Inoltrare in `applyAuthored` come `UPDATE` verso i peer senza capacità di sicurezza. Verifica: test topologia Alice → Bob → Carol (0.8.0), con il peer reale di 3.3, in cui gli edit arrivano senza resync completo.
- [x] 4.3 Saltare e registrare i `history-part` che falliscono verifica o storage, e applicare un timeout a `history-want`, con stato "cronologia incompleta". Verifica: test con un record firmato da una chiave non fidata e uno senza risposta; la paginazione continua e lo stato si assesta.

## 5. Cronologia, undo, Recovery ed export

- [x] 5.1 Chiudere il gruppo locale aperto quando arriva un `AuthoredOrigin` sullo stesso documento. Verifica: test A/B/C interleaved fra repliche autenticate in cui l'undo di Alice toglie "C" e lascia "B".
- [x] 5.2 Segnare come proiettati i record dei gruppi chiusi vuoti e serializzare `recoverJournal` con i flush della sessione. Verifica: test con primo sync, riavvio senza edit, nessun Changes "autore sconosciuto" e nessun gruppo duplicato.
- [x] 5.3 Restore: spostare il checkpoint `prepared` dopo le precondizioni. Undo: registrare i file già invertiti. In History mostrare l'operazione interrotta con "completa" e "annulla". Verifica: test con precondizione fallita, nessun checkpoint residuo e restore successivo riuscito; test con undo interrotto a metà, poi completato e poi annullato.
- [x] 5.4 Aggiungere a `listMetaKeys` gli intervalli di prefisso in memory, IndexedDB e SQLite, e indici per Recovery e record proiettati. `RecoverySection` deve aggiornarsi su evento e `knownDocIds` usare le chiavi. Verifica: test con 500.000 record in cui ogni edit remoto non esegue scansioni complete (contatore delle chiamate) e il pannello resta reattivo.
- [x] 5.5 Produrre l'export in streaming verso file, con hash incrementale e rifiuto anticipato oltre 4 GiB meno il margine. Su Rust eseguire `VACUUM INTO` fuori dal lock globale. Verifica: test Rust/worker con store di almeno 1 GiB e picco di memoria misurato sotto la dimensione dello store più l'overhead dichiarato; test di rifiuto senza scritture; manifest verificato.
- [x] 5.6 IndexedDB: gestire `onblocked` con un messaggio e `onversionchange` chiudendo la connessione. Desktop: registrare l'impronta del SQLite legacy alla migrazione e unire gli update di un file legacy cambiato dopo un rollback. Verifica: test con due connessioni aperte; test upgrade → rollback 0.8.0 → edit → upgrade con edit presenti.
- [x] 5.7 Aggiornare `docs/runtime.md`, `docs/desktop-storage.md` e la guida History/Recovery. Verifica: esempi di export e ripresa di undo/restore eseguibili come scritti.

## 6. Mirror su ogni filesystem

- [x] 6.1 Sostituire la pubblicazione con `hard_link` con il rename senza sostituzione in Rust (Windows, Linux, macOS), e in Node con il fallback `link` → `copyFile COPYFILE_EXCL`. Rollback con lo stesso meccanismo ed errore riportato; marcare i path "in pubblicazione". Verifica: test Rust e Node con link forzato a fallire dopo il retain, in cui il target ha sempre il contenuto precedente o nuovo e nessuna cancellazione viene inviata; prova manuale su una VHD exFAT creata in `%TEMP%`, se il montaggio è disponibile senza elevazione, altrimenti segnalata come non eseguita.
- [x] 6.2 Rendere transitorie le copie `.hivetex-recovery`: rimozione se i byte coincidono con l'ultimo scritto o letto, altrimenti cattura nello store e rimozione, con cattura incrementale. Verifica: test con un'ora simulata di edit remoti senza copie in cartella; test con edit esterno non letto che produce una sola voce in Recovery.
- [x] 6.3 Filtrare gli eventi su directory, separare i timer `retryStart`/retry tabella e gestire gli errori per path con backoff in `applyTableToDisk`. Verifica: test con creazione di una sottocartella senza loop di notice; test con un file bloccato da un handle senza condivisione, dove gli altri file arrivano e il blocco si risolve alla chiusura; test di disconnessione e ripresa del volume senza riavvio.
- [x] 6.4 Correggere i punti minori del mirror:
  - collisioni su rename solo di maiuscole/minuscole e NFD da `readdir` su macOS;
  - marker mancante senza retry infinito;
  - nomi riservati mancanti (`CONIN$`, `CONOUT$`, `COM0`, `LPT0`, cifre in apice);
  - filtro ignore coerente in `applyTableToDisk`;
  - parità Rust/TS per `target/` e per un parent diventato file;
  - tooltip "read and write" in `Workspace.svelte`.

  Verifica: test unitari per ciascun caso e un test su NTFS reale per `Intro.tex`/`intro.tex`.
- [x] 6.5 Aggiornare `docs/folders.md` con filesystem senza hard link, copie transitorie e limiti. Verifica: nessuna frase che prometta copie permanenti in cartella.

## 7. Compilazione locale (completamento dei task 2.x dell'audit)

- [x] 7.1 Rendere `engine` reattivo in sessione e barra di stato, e rimuovere il comando "Compile on this device only". Verifica: test web dopo l'abbinamento dell'helper senza "Set up a local compiler"; il comando non compare più nella palette.
- [x] 7.2 Aggiornare `e2e/workspace.spec.ts` al nuovo indicatore e aggiungerlo alla lista browser richiesta in `ci.yml`. Verifica: lo spec passa localmente e la policy CI lo elenca.
- [x] 7.3 Annunciare solo blob referenziati da file vivi o versioni trattenute. Verifica: test con uno store contenente il PDF di un vecchio leader, non annunciato, e `figure.pdf` usato come input, sincronizzato.
- [x] 7.4 Gestire il ciclo di vita dei runner:
  - terminare i runner WASM alla chiusura della sessione;
  - escludere il download del `.wasm` dalla deadline di avvio;
  - controllare le risposte `mkdir`/`writefile`;
  - aggiungere la cancellazione delle build native con kill dell'albero di processi;
  - riprovare la raggiungibilità invece di bloccarla per 10 minuti.

  Verifica: test con dieci aperture e chiusure senza runner residui; test di cancellazione nativa che termina il processo.
- [x] 7.5 Correggere il messaggio di migrazione una tantum consumato da sessioni chiuse subito e aggiungere l'offerta di setup locale richiesta dallo spec. Allineare README (`automatic compilation`), `docs/compilation.md` (ultimo PDF in memoria) e il commento di `helper.rs`. Verifica: test della notice e grep senza frasi obsolete.

## 8. Harness a due macchine con Windows Sandbox

- [x] 8.1 Aggiungere a `sandbox-sync.mjs` un preflight:
  - spazio libero sul volume di output;
  - istanze residue;
  - profilo host isolato;
  - stato firewall dell'host (`ActiveStore`, profilo dell'interfaccia vEthernet, regole per i path esatti di app e
    `node.exe`, blocchi "Query User") registrato in `summary.json`;
  - uscita immediata con diagnosi `firewall:` quando un profilo attivo può bloccare.

  Aggiungere `make sandbox-firewall` (elevato, eseguito dall'utente) per creare le regole sui path esatti. Verifica: simulazione con regola mancante, dove il run si ferma prima del login con il messaggio previsto.
- [x] 8.2 Rendere fail-fast `setup.ps1` e farlo girare come System:
  - senza fault: spegnere e verificare il firewall del sandbox;
  - `FAULT=no-udp`: mantenerlo attivo con il blocco e verificare la route `relay` senza coppia UDP;
  - `FAULT=offline`: bloccare escludendo la porta CDP, e verificare.

  Verifica: `setup.txt` contiene lo stato verificato; il run fallisce se il fault non è effettivo.
- [x] 8.3 Aggiungere i controlli di raggiungibilità prima del login (TCP verso il server dell'host, echo UDP host↔sandbox con il `node.exe` spedito) e la diagnosi `reachability:`. Verifica: run `basic` con i risultati in `summary.json`; run con UDP bloccato che si ferma con la diagnosi.
- [x] 8.4 Implementare gli scenari `assets`, `rename-delete`, `offline`, `crash`, `author`, `recovery`, `folder` e `mixed` (Chromium Playwright sull'host ↔ desktop nel sandbox), con confronto di albero e hash dei byte e traccia unita in caso di errore. Verifica: ogni scenario fallisce su una regressione indotta (per esempio un edit scartato in un hook di test) e passa sul codice corretto.
- [x] 8.5 Aggiungere alla matrice del trasporto la misura "sync entro 5 s" e la rotazione indotta del socket durante l'hold; con `TURN_*` mancanti riportare "non eseguito". Gestire `SIGINT` con pulizia e scrivere `summary.json` anche se build o staging falliscono. Verifica: run `MATRIX=stun,relay-stun` con tabella completa; run interrotto con Ctrl+C senza processi residui.
- [x] 8.6 Documentare in `docs/testing.md`: prerequisiti, gestione del firewall su host e sandbox, variabili, scenari e limiti (stessa macchina fisica, NAT Hyper-V). Verifica: un run seguendo solo la documentazione.

## 9. Accettazione integrata

- [x] 9.1 Rieseguire dal checkout di verifica, con target su C:, build/lint/test con `--force`, `svelte-check`, budget del bundle, `cargo test`, la lista browser richiesta (inclusi `workspace.spec.ts` e gli scenari reali) e `openspec validate --strict` per le tre change. Verifica: verbale con esiti, skip motivati e versioni in `evidence/acceptance.md` di questa change.
- [x] 9.2 Eseguire `make sandbox-sync` con `SCENARIOS=basic,assets,rename-delete,offline,crash,author,recovery,folder,mixed`, firewall del sandbox spento e verificato e stato dell'host registrato. Verifica: tutti gli scenari passano e i log sono allegati in `evidence/`. Un fallimento con diagnosi `firewall:` o `reachability:` va riportato come ambiente e non risolto con modifiche al prodotto.
- [x] 9.3 Eseguire la matrice `MATRIX=stun,turn,relay,relay-stun,deaf,no-udp` con `HOLD_S=300`, solo per gli scenari che hanno credenziali. Verifica: tabella allegata con sync entro 5 s, hold e rotazione del socket; gli scenari senza credenziali sono marcati "non eseguito".
- [x] 9.4 Verificare la build locale reale (task 8.4 dell'audit): desktop con TeX di sistema, sandbox senza TeX con provisioning gestito e cache calda offline. Verifica: PDF con il contenuto atteso, errori e ultima preview corretti, nessun messaggio di build ai peer. Ciò che richiede download non disponibili viene riportato come non eseguito.
- [x] 9.5 Aggiornare `evidence/acceptance.md` e `tasks.md` di `audit-sync-data-safety` (8.3–8.5) e di `reliable-sync-transport` (8.1), collegando le evidenze di questa change e distinguendo i risultati in sandbox dai NAT reali. Verifica: ogni casella spuntata ha un'evidenza collegata.

## Workflow follow-up

- Prima dell'archiviazione, l'utente riattiva il firewall dell'host (profili Public e Private). Poi:
  - esegue `make sandbox-firewall` con elevazione, oppure risponde ai prompt;
  - ripete 1.1/1.2 e `SCENARIOS=basic`;
  - verifica che non nascano nuove regole `hivetex*` dai test locali.
- Archiviare nell'ordine `audit-sync-data-safety`, `reliable-sync-transport` e poi questa change, sincronizzando le delta
  spec.
- A ogni push che attivi la CI: attendere l'esito, diagnosticare i fallimenti e riportare lo stato finale.
- Le regole firewall `hivetex*` accumulate dai worktree (`p2platex-harden`, `-syncinv`, `-synctest`) possono essere rimosse
  dall'utente: è una pulizia manuale, fuori da questa change.
