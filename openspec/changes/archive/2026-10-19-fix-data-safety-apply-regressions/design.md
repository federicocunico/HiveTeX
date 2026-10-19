# Design

## Context

L'apply di `audit-sync-data-safety` è nella working tree, non committato e non rilasciato. I formati che introduce non
sono mai usciti dalla macchina dello sviluppatore:
- registro operazioni;
- envelope firmato, con il campo `before` che contiene lo stato completo;
- tombstone come campo `deleted` dentro `files`;
- copie `.retained` nella cartella.

Per questo possono cambiare senza compatibilità pubblica. L'unico vincolo di compatibilità di rete è la release 0.8.0,
cioè HEAD `9aeb8df`.

La verifica di questa sessione ha:
- rieseguito i gate: sync 483, compile 37, web 323, Rust 150 pass / 5 ignored, tutti verdi;
- eseguito quattro revisioni del codice indipendenti, per compilazione, filesystem, persistenza/provenienza e
  desktop/harness;
- confermato a mano, rileggendo il codice, i blocker citati sotto.

I riferimenti `file:riga` si riferiscono alla working tree attuale.

Vincoli d'ambiente osservati:
- **Firewall dell'host:** il profilo attivo (Public) è spento e il profilo Domain è acceso ma non attivo. L'agente non ha
  privilegi per cambiare il firewall dell'host. Esistono 60 regole `hivetex*` nate da prompt "Query User": una per ogni
  binario di test Rust (`target\debug\deps\hivetex_desktop_lib-<hash>.exe`) e per le build sandbox.
- **Windows Sandbox:** il CLI `wsb` è disponibile; può girare una sola istanza alla volta. Dentro il sandbox i comandi
  eseguiti come System possono cambiare il firewall.
- **Disco:** F: ha 1,6 GB liberi e `target` occupa 64 GB. Un target Cargo riusabile da 24 GB esiste in
  `%TEMP%\p2platex-acceptance-cargo-target` su C:, che ha 125 GB liberi. `sandbox-sync.mjs` usa per forza
  `src-tauri/target/debug`.

## Goals / Non-Goals

**Goals:**
- Correggere i blocker e i major confermati senza indebolire le garanzie di recupero dell'audit.
- Rendere i test locali indipendenti dal firewall, e la prova a due macchine deterministica rispetto al firewall o
  esplicitamente diagnosticata.
- Chiudere con evidenze reali i punti 8.3–8.5 dell'audit e 8.1 del trasporto, oppure dichiararli non eseguibili con il
  motivo.

**Non-Goals:**
- Non si cambia il firewall dell'host e non si approvano prompt in automatico.
- Nessuna modifica al client 0.8.0 già distribuito.
- Nessuna nuova capacità di prodotto oltre a quanto serve a correggere i difetti.
- Non si riprogetta il raggruppamento dei Changes: resta quello dell'audit, con bound di sette giorni e 500 gruppi.

## Decisions

### D1. Preimmagine per delta, non per stato completo

Oggi `DocPersister` (`persistence.ts:368-386`) codifica l'intero documento a ogni `beforeTransaction` e lo salva a
chunk per ogni update. `Mesh` (`mesh.ts:182-184`, `875-893`) lo ricattura e lo mette nell'envelope firmato come
`before`. Poiché i documenti usano `gc: true`, il contenuto cancellato non è ricostruibile dagli update, quindi una
preimmagine serve ancora. Basta però che sia proporzionale alla modifica.

**Decisione:**
- Nel callback della transazione, quando gli item cancellati sono ancora leggibili prima del GC, il record operazione
  salva un **delta inverso**: le parti di testo rimosse con la loro posizione, i valori precedenti delle chiavi di root
  modificate o rimosse, gli hash dei blob sostituiti.
- Uno snapshot completo del testo si salva solo:
  - all'apertura di un nuovo gruppo di Changes, deduplicato per hash del contenuto;
  - quando una singola operazione rimuove più di metà del documento.
- L'envelope firmato non contiene più `before`.
- Il ricevente calcola il proprio delta inverso quando applica l'operazione, dal suo stato locale, che possiede già.
- `history-projection` ricostruisce il testo precedente applicando il delta inverso al testo successivo.

**Alternative scartate:**
- **Disattivare il GC.** La memoria crescerebbe per ogni documento vivo, e su un documento con molta storia il costo
  ricadrebbe su ogni apertura.
- **Comprimere lo stato completo.** La crescita resterebbe O(documento) per battitura.

**Verifica:** un test misura i byte aggiunti a store e rete per 1.000 battiture su un documento da 100 KB; la soglia è
nello spec `peer-sync`.

### D2. Eliminazioni recuperabili in una mappa separata

Oggi la tombstone è il campo `deleted` dentro `files` (`model.ts:719`). Il client 0.8.0 non lo filtra: mostra il file e
il suo mirror lo riscrive. Al contrario, una cancellazione fisica da 0.8.0, o precedente all'upgrade, fa scartare
l'intero update da `admitRootUpdate` (`mesh.ts:939-956`).

**Decisione:**
- Eliminare un file sposta la sua voce in una mappa di root `tombstones`, con lo stesso id e la frontier causale, e rimuove
  la chiave da `files`. Per 0.8.0 è una normale cancellazione.
- Il ripristino reinserisce la voce in `files` e toglie la tombstone.
- `admitRootUpdate` non scarta più: per ogni id che sparisce da `files` senza comparire in `tombstones`, salva prima la
  voce e l'ultimo contenuto in Recovery come "rimosso da <dispositivo>", poi applica l'update.
- Resta rifiutato solo un formato di tombstone sconosciuto, cioè una versione futura, e il rifiuto mostra un messaggio di
  aggiornamento.
- Una conversione locale idempotente porta gli store di sviluppo che hanno il campo `deleted` nella nuova forma.

**Conflitti delete/edit:** il documento di testo ha lo stesso id. Un edit con frontier successiva alla tombstone rende il
file "eliminato con modifiche successive", visibile in Recovery su ogni replica. È la stessa garanzia dell'audit, con
un'altra rappresentazione.

**Alternativa scartata:** mantenere la quarantena e aggiungere un pulsante "accetta". Il sync resterebbe fermo fino a
un'azione manuale, e chi non apre Recovery vedrebbe un albero divergente senza capire perché.

### D3. Percorso live separato da persistenza e cronologia

**Decisione:**
- L'operazione locale si firma, perché Ed25519 è veloce, e si invia subito ai peer interessati in una coda live per
  connessione.
- La persistenza dell'operazione firmata procede in parallelo, con retry. Il suo errore resta visibile tramite
  `durabilityError` ma non sospende l'invio.
- Le parti di cronologia (`history-part`) usano una coda a priorità inferiore che cede a ogni frame live.
- `model.flush()` attende la durabilità del documento, non il retry della provenienza.
- Un record storico che fallisce verifica o storage viene tolto dalla coda e registrato come saltato.
- Un `history-want` senza risposta va in timeout dopo 30 s.
- Ai peer senza capacità di sicurezza, cioè 0.8.0, anche gli inoltri (`applyAuthored`) vanno come `UPDATE`.

**Alternativa scartata:** un unico canale con backpressure condivisa. Un bootstrap da 96 MB continuerebbe a ritardare
gli edit di tutti.

### D4. Gruppi Changes e checkpoint

**Gruppi:**
- Un'operazione `AuthoredOrigin` chiude il gruppo locale aperto sullo stesso documento prima di aggiornare la baseline
  (`changelog.ts:186-212`).
- I gruppi chiusi vuoti segnano comunque come proiettati i loro record, così `recoverJournal` non li ripropone come
  "autore sconosciuto".

**Checkpoint:**
- Restore: precondizioni e `changeSeq` si controllano prima di scrivere il checkpoint `prepared`.
- Undo: il checkpoint registra i file già invertiti. History mostra "interrotto" con le azioni "completa" e "annulla".
- Un retry non fallisce per un checkpoint orfano: lo riprende o lo chiude.

### D5. Mirror: pubblicazione esclusiva senza hard link e recupero transitorio

Oggi `atomic_replace` (`mirror.rs:170-191`, `mirror-node.ts:55-71`) sposta l'originale in `.hivetex-recovery/` e poi
usa `hard_link`. Anche il rollback usa `hard_link`, e il suo errore è ignorato.

**Pubblicazione:**
- La pubblicazione usa un **rename senza sostituzione**: `MoveFileExW` senza `MOVEFILE_REPLACE_EXISTING` su Windows,
  `renameat2(RENAME_NOREPLACE)` su Linux, `renamex_np(RENAME_EXCL)` su macOS. Funziona anche su FAT ed exFAT e mantiene
  l'esclusività rispetto a un atomic-save esterno.
- Node non ha un rename esclusivo. Il worker usa quindi `link` e, se riceve `EPERM`/`ENOTSUP`/`EXDEV`, ripiega su
  `copyFile` con `COPYFILE_EXCL` più `fsync`.
- Il rollback usa lo stesso rename esclusivo, e il suo errore viene riportato.
- Durante la pubblicazione il path è marcato "in pubblicazione": un evento di assenza su quel path non diventa una
  cancellazione.

**Copie di recupero:**
- La copia in `.hivetex-recovery/` diventa transitoria.
- Dopo la pubblicazione, se i byte messi da parte coincidono con `lastWritten`/`lastRead`, la copia viene rimossa.
- Altrimenti viene catturata nello store, dove vale la retention del registro, e poi rimossa dalla cartella.
- La cattura è incrementale: legge solo i file nuovi, non tutta la directory a ogni avvio.

**Errori:**
- Gli eventi su directory vengono filtrati prima della lettura.
- `retryStart` e il retry della tabella hanno timer distinti.
- `applyTableToDisk` gestisce gli errori per path, con backoff, e continua con gli altri path.

**Alternativa scartata:** usare sempre `rename` con sostituzione. Una scrittura esterna concorrente verrebbe
sovrascritta, mentre l'audit richiede di non farlo (F02).

### D6. Percorsi caldi su chiavi meta

**Decisione:**
- `listMetaKeys` accetta un intervallo di prefisso: range di IndexedDB, `BETWEEN` su SQLite.
- Recovery e Changes leggono indici dedicati (`recovery:index`, `operation:projected`) invece di scansioni complete.
- `RecoverySection` si aggiorna su un evento "recovery cambiato", non a ogni update di documento.
- `knownDocIds` usa le chiavi, non `getAll()` dei valori.

### D7. Export in streaming e upgrade

**Export:**
- Lo ZIP si produce in streaming con la classe `Zip` di fflate verso un sink: append via comando Tauri su desktop,
  `FileSystemWritableFileStream` o parti di Blob nel browser.
- La copia SQLite arriva a blocchi e viene hashata in modo incrementale.
- Se la dimensione stimata supera 4 GiB meno un margine, l'export viene rifiutato prima di iniziare, perché fflate non
  supporta ZIP64.
- Rust esegue `VACUUM INTO` fuori dal lock globale di `StoreState`, su una connessione dedicata.

**Upgrade:**
- IndexedDB gestisce `onblocked` con un messaggio e `onversionchange` chiudendo la connessione.
- Su desktop la migrazione registra l'impronta della sorgente legacy. Se al riavvio il file legacy è cambiato, i suoi
  update Yjs vengono uniti nello store nuovo come importazione con provenienza sconosciuta. L'unione CRDT è sicura e
  il file legacy non viene modificato.

### D8. Compilazione

Si correggono solo i punti in cui l'apply non completa i propri task 2.x. Il lock di manutenzione del compilatore
(`tex.rs:171`) e la riutilizzazione del risultato in cache su Recompile sono precedenti all'apply o conformi al suo spec,
e restano fuori.

**Interfaccia:**
- `engine` diventa stato reattivo: oggi `StatusBar.svelte:80` non si aggiorna dopo l'abbinamento dell'helper.
- Il comando "Compile on this device only" viene rimosso: ogni build è già locale.

**Allineamenti:**
- `e2e/workspace.spec.ts` viene aggiornato ed entra nella lista browser richiesta in CI.
- `docs/compilation.md` chiarisce che l'ultimo PDF valido è in memoria per la sessione.
- Il README non cita più un controllo "automatic compilation" che non esiste.

**Risorse:**
- `BlobManager` annuncia solo blob referenziati da file vivi o versioni trattenute.
- Le sessioni web terminano i propri runner WASM alla chiusura, e la deadline di avvio esclude il download del `.wasm`.
- Le build native si annullano con un comando di cancellazione che uccide l'albero di processi.

### D9. Test locali senza esposizione al firewall

**Rust:**
- `Transport` accetta un IP di bind; i test usano `127.0.0.1`.
- Nei test `rtc.rs` una `interface_policy` `loopback` usa `set_include_loopback_candidate(true)` e un filtro IP solo
  loopback.
- `muxed_gathering_keeps_ipv6_host_candidates` diventa un test lab `#[ignore]`, eseguito da `make rtc-lab`.

**JS:**
- `rtc_cli` accetta `interfaces: "loopback"` e `tauri-rtc.test.ts` lo passa.
- Il server locale accetta `HOST`; i test locali e Playwright usano `127.0.0.1`. Restano su tutte le interfacce
  solo `sandbox-sync` e rtclab, che le richiedono esplicitamente.

**Test nativi mancanti:** `nativeTestBinary` che restituisce `null` produce uno skip con nome e istruzione, e un
riepilogo finale lo ripete. In CI resta l'errore.

**Verifica:** finché il firewall è spento non si può osservare l'assenza di prompt. La prova è quindi un controllo degli
endpoint: durante le suite, `Get-NetUDPEndpoint`/`Get-NetTCPConnection` filtrati sui processi di test non devono mostrare
indirizzi diversi da loopback. Quando l'utente riattiva il firewall, un nuovo run non deve creare regole `hivetex*`.

### D10. Harness a due macchine

Si riscrive per fasi `apps/desktop/e2e/sandbox-sync.mjs`, mantenendo il formato di output, con quattro fasi.

**1. Preflight**
- Controlla lo spazio libero sul volume di output.
- `CARGO_TARGET_DIR` e `SANDBOX_OUT` sono configurabili, con default `target/e2e`.
- Verifica che nessuna istanza `app.hivetex.desktop.e2e` sia in esecuzione e isola il profilo dell'app sull'host
  (`%APPDATA%` del run).
- Registra in `summary.json` il firewall dell'host:
  - `Get-NetFirewallProfile -PolicyStore ActiveStore`;
  - il profilo dell'interfaccia rivolta al sandbox (vEthernet Default Switch);
  - le regole per i path esatti di `hivetex-desktop.exe` e del `node.exe` del server;
  - le eventuali regole di blocco "Query User".
- Se il profilo rivolto al sandbox è attivo e manca una regola allow per uno dei due eseguibili, il run termina con
  `firewall: …`, il comando elevato suggerito (`make sandbox-firewall`, script che crea le regole per i path esatti) e
  nessun passo di sync.

**2. Sandbox**
- `setup.ps1` gira come System con `$ErrorActionPreference = 'Stop'`.
- Senza fault: `Set-NetFirewallProfile -All -Enabled False`, poi verifica e scrittura in `setup.txt`.
- `FAULT=no-udp`: firewall attivo con la regola di blocco, poi verifica che la regola sia effettiva. Durante il run si
  controlla che la route sia `relay` e che non ci sia una coppia UDP selezionata.
- `FAULT=offline`: blocco in uscita verso host e Internet, eccetto il canale di controllo CDP, poi verifica.

**3. Raggiungibilità**
- Prima del login: dal sandbox `Test-NetConnection host:3000` e un echo UDP host↔sandbox con il `node.exe` già spedito
  con l'app.
- Il risultato va in `summary.json`. Un fallimento produce una diagnosi `reachability:` e il run si ferma.

**4. Scenari (`SCENARIOS=`)**

| Scenario | Cosa verifica |
| --- | --- |
| `basic` | Il flusso attuale. |
| `assets` | Binario: hash dei byte e albero completo id/path/hash. |
| `rename-delete` | Rename e delete concorrenti, edit contro delete. |
| `offline` | Offline su entrambi i lati, con la modalità offline dell'app oppure `FAULT=offline`. |
| `crash` | `taskkill /F` del sandbox durante una raffica di edit, relaunch, poi verifica degli edit confermati. |
| `author` | Autore e dispositivo nei Changes su entrambi i lati. |
| `recovery` | `exportRecovery` su entrambi i lati, apertura dello ZIP e verifica del manifest. |
| `folder` | Progetto legato a una cartella, con `HIVETEX_TEST_PICK_DIR`. |
| `mixed` | Chromium Playwright sull'host contro il desktop nel sandbox. |

**Chiusura:**
- L'app viene chiusa in modo ordinato (`app_quit` via pagina), poi con kill forzato.
- La pulizia gestisce anche `SIGINT`.
- `summary.json` viene scritto anche se build o staging falliscono.

**Matrice del trasporto:**
- Si aggiungono la misura "sync entro 5 s" e una rotazione del socket indotta durante l'hold.
- Gli scenari `turn`, `relay` e `deaf` richiedono `TURN_*`. Se le credenziali mancano, il risultato è "non eseguito: mancano
  credenziali", non un successo.

**Alternativa scartata:** spegnere il firewall dell'host dal test. Richiede elevazione, cambia la sicurezza della
macchina dell'utente e non rappresenta l'installazione reale. Lo stato si registra e la configurazione realistica
(firewall attivo con regole per l'eseguibile installato) è un run separato fatto dall'utente.

### D11. Build E2E isolate

Serve alla prova a due macchine: un'istanza E2E rimasta da un run precedente riceve il lancio successivo tramite
single-instance, e il test guida una build vecchia.

**Decisione:**
- Le build E2E (`run.mjs`, `sandbox-sync.mjs`, `lifecycle.mjs`, `background.mjs`) usano `CARGO_TARGET_DIR` dedicato, così
  non sovrascrivono `target/debug/hivetex-desktop.exe` di `tauri dev` e possono stare su un volume con spazio.
- Il kill forzato è il fallback dopo `app_quit`.

**Verifica:** dopo un run E2E, `Get-Process hivetex-desktop` mostra solo le istanze attese.

## Risks / Trade-offs

- **[Rischio] Delta inverso incompleto per strutture Yjs non testuali.**
  - Mitigazione: si catturano anche i valori precedenti delle mappe root e dei settings, con snapshot completo di
    fallback per i tipi sconosciuti.
  - Test di round trip: delta inverso più update producono il testo precedente, su fuzz di 10.000 operazioni.
- **[Rischio] La mappa `tombstones` cambia la semantica di rename concorrente a delete.** Il rename su una voce rimossa
  va perso. Il contenuto resta nella tombstone e nel documento, e il caso è coperto da test a tre repliche.
- **[Rischio] `copyFile EXCL` su Node non è atomico per il contenuto.** È usato solo come fallback su filesystem senza hard
  link, e un lettore esterno può vedere un file parziale per un istante. Va documentato in `docs/folders.md`.
- **[Rischio] `FAULT=offline` via firewall del sandbox può rompere il canale CDP.** La regola esclude la porta CDP. In
  alternativa resta lo scenario con la modalità offline dell'app.
- **[Rischio] La prova a due macchine resta "stessa macchina fisica, NAT di Hyper-V".** Non sostituisce due reti reali.
  Il task 8.3 del trasporto, già fatto dall'utente con due PC, resta il riferimento per NAT reali, e il verbale lo
  distingue.
- **[Rischio] Il firewall dell'host è oggi spento sul profilo Public.** I run registrano questo stato. Un run con firewall
  attivo e regole precise è richiesto prima dell'archiviazione e si fa dopo che l'utente lo ha riattivato.
- **[Trade-off] Rimuovere le copie di cartella dopo la cattura nello store.** La copia esterna vive solo nello store, ma
  resta esportabile e visibile in Recovery, e la cartella dell'utente non cresce.

## Migration Plan

1. Nessun rilascio intermedio: le correzioni si applicano sopra la working tree dell'audit, prima del primo commit.
2. Una conversione idempotente all'apertura porta gli store di sviluppo creati dall'apply alla nuova forma:
   - il campo `deleted` passa alla mappa `tombstones`;
   - i record con `before` completo vengono mantenuti, letti come snapshot e non più scritti;
   - le copie `.retained` esistenti vengono catturate e poi rimosse dalla cartella.
3. Rollback: lo store `.safety-v1` e il SQLite legacy restano intatti, come nell'audit. D7 copre il nuovo upgrade
   successivo a un rollback.

## Open Questions

- Le soglie numeriche, cioè il limite di crescita per battitura in D1 e il timeout di `history-want` in D3, si fissano
  dopo la prima misura. Non cambiano né l'approccio né i task.
