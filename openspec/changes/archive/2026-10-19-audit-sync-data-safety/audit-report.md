# Audit della piattaforma: sincronizzazione, recupero e build locale

Data: 16 ottobre 2026. Repository: HiveTeX/p2platex. Commit esaminato: `9aeb8df323b4afc7654b8257c052a34ce00b965e`.

## Stato dopo apply

L'applicazione diretta autorizzata dall'utente ha rimosso la compilazione distribuita e introdotto registro durevole,
provenienza firmata, cancellazioni recuperabili, protezioni del mirror e undo/restore con precondizioni. I dieci casi
del baseline sono ora regressioni del comportamento corretto. Esiti, comandi, limiti e casi ancora da eseguire sono
nel [verbale di applicazione e accettazione](evidence/acceptance.md).

**La change resta aperta per l'accettazione ambientale: non viene attestata una garanzia assoluta su configurazioni
non provate.** Le cartelle browser sono ora import-only; l'export nativo completo usa una copia SQLite trasferita a
blocchi e supera il limite degli elenchi aggregati. Restano le prove fisiche su macchine/reti distinte e il provisioning
gestito da zero. Le richieste firewall scadute mentre l'utente è AFK non sono classificate come bug.

## Esito del baseline precedente all'apply

**Il requisito di assenza di perdita involontaria da sincronizzazione non era soddisfatto dal commit esaminato.** Dieci casi riproducibili mostrano rimozione di file, perdita di recuperabilità, undo che comprende lavoro successivo e attribuzione errata. La compilazione locale e alcuni flussi ordinari di sync funzionavano nelle prove eseguite; questo non copriva i casi di sicurezza dei dati riprodotti nell'audit.

La decisione di prodotto aggiornata è **solo compilazione locale**. Nel baseline la compilazione distribuita era deprecata nelle preferenze ma ancora implementata; l'apply l'ha rimossa.

Le sezioni successive conservano l'audit e le riproduzioni storiche; i riferimenti di riga si riferiscono al baseline.
Non è possibile attribuire con certezza l'episodio storico dei file scomparsi a un singolo percorso senza la replica
interessata e i suoi dati di recovery; i percorsi riprodotti sono spiegazioni tecnicamente possibili, non una diagnosi
retroattiva di quell'episodio.

## Perimetro e metodo

- Lettura di modello Yjs, file tree, mesh, ChangeLog, persistence IndexedDB/native, ingress, checkpoint offline, acquisizione input, mirror Node/browser/Rust, bridge worker e relativi test.
- Lettura della pipeline di compilazione, selezione modalità, worker WASM, bridge Rust, provisioning, UI Changes/History e workflow CI/desktop.
- Esecuzione di repliche sacrificabili in memoria per dieci riproduzioni mirate. Lo script completo è in [evidence/reproduction.md](evidence/reproduction.md).
- Build, lint, unit test, controlli tipi, test Rust e flussi browser reali. Una compilazione reale è stata eseguita anche direttamente tramite `tex_cli` ricostruito.
- Studio del codice pubblico Overleaf su un checkout temporaneo, senza introdurne file o dipendenze nel prodotto.
- Confronto con specifiche principali e change aperta `reliable-sync-transport`; lettura dei file non tracciati `BUGS.md` e `__conntests.txt`, lasciati intatti.

Ambiente: Windows, Node `22.22.0`, pnpm `10.34.6`, Turbo `2.11.7`, Yjs della lockfile corrente. Le riproduzioni usano il modello e i trasporti di test reali del progetto; non sono riproduzioni dell'intera UI su una rete remota. Non sono stati eseguiti test distruttivi su progetti personali, rollout o push. Non è stato svolto un penetration test completo di ogni endpoint dell'account: l'analisi si concentra sui requisiti dati/compilazione richiesti, con verifica delle dipendenze applicative coinvolte.

## Dieci difetti riprodotti

P1: blocca la garanzia richiesta di conservazione, recupero o attribuzione. P2: cronologia/undo errati che riducono la possibilità di controllare e recuperare una modifica. Gli ID sono usati anche in `tasks.md`.

| ID | Priorità | Problema | Caso nello script |
| --- | --- | --- | --- |
| F01 | P1 | Errore di accesso browser trasformato in cancellazione | `browser-permission-error` |
| F02 | P1 | Delete remoto cancella byte esterni prima del watcher | `remote-delete-before-watcher` |
| F03 | P1 | Delete/edit online converge nascondendo il contributo | `linked-delete-edit` |
| F04 | P1 | Undo della creazione elimina anche lavoro successivo | `undo-create-after-edit` |
| F05 | P1 | Undo del delete di un file lazy ripristina testo vuoto | `lazy-delete-undo` |
| F06 | P1 | Gruppo di una sorgente ingloba e annulla l'altra | `mixed-source-undo` |
| F07 | P1 | Autore originale sostituito dal peer che inoltra | `three-peer-attribution` |
| F08 | P2 | Primo edit di un documento lazy non registrato | `lazy-first-edit` |
| F09 | P2 | Edit seguito da rename perde l'inversione del testo | `edit-then-rename` |
| F10 | P1 | Errore di scrittura della cronologia perde il pending | `history-write-failure` |

### F01 — Il file illeggibile diventa un file eliminato

Riferimenti: `apps/web/src/lib/fs-access.ts:95`, `packages/sync/src/mirror-node.ts:30`, `packages/sync/src/mirror.ts:541` e `:555`.

`webFs.read` cattura qualsiasi errore e restituisce `null`; il mirror interpreta `null` come file cancellato e chiama `model.delete`. Anche Node confonde errori di lettura e assenza. Il Rust, invece, distingue già NotFound da altri errori: non va generalizzato il difetto del browser a quel percorso nativo.

Riproduzione: il file contiene `original`; dopo il binding una lettura del File System Access API lancia `NotAllowedError`, simulando perdita temporanea del permesso durante un evento. **Osservato:** `readResult: null`, `visibleFiles: 0`, mentre i byte fisici sono ancora `original`. È sufficiente un evento già pendente; il polling che intercetta a sua volta errori non elimina il problema.

Correzione proposta: esiti distinti e retry visibile; nessuna mutazione della replica da errori o scansioni incomplete.

### F02 — Il delete remoto non conserva l'edit esterno non importato

Riferimenti: `packages/sync/src/mirror.ts:411` e `:419`.

La riconciliazione dell'albero chiama direttamente `fs.remove` per i path scomparsi. Il confronto con il contenuto attuale del disco esiste per alcune scritture, ma non per questa rimozione.

Riproduzione: binding di `main.tex`, modifica dei byte sul disco a `external unsynced contribution` senza ancora consegnare l'evento watcher, rimozione dell'entry del modello come avviene ricevendo un delete. **Osservato:** `diskFile: false`, `projectFiles: 0`. La copia nuova esterna viene effettivamente rimossa e non è mai passata nel modello o nella cronologia.

Correzione proposta: controllo della copia esterna e sua conservazione durevole prima di qualunque rimozione o rename; serializzazione e verifica di precondizioni per evitare corse.

### F03 — La convergenza dell'albero non protegge l'edit concorrente al delete

Riferimenti: `packages/sync/src/model.ts:599`, `packages/sync/src/mesh.ts:773`.

La cancellazione toglie l'entry dall'albero, mentre l'edit del testo avviene in un altro documento Yjs. Le due operazioni possono convergere entrambe senza lasciare il file visibile; la gestione offline non interviene perché i peer sono già collegati.

Riproduzione: due peer collegati con latenza di 30 ms; Alice elimina e Bob inserisce `important concurrent work` prima di ricevere il delete. **Osservato:** entrambi hanno zero file visibili, ma il documento testuale separato contiene ancora `base important concurrent work`.

Il test dimostra perdita della visibilità e del recupero ordinario, non distruzione fisica immediata di quei byte Yjs. Tale distinzione è essenziale: la presenza del documento orfano nello store non equivale a una funzione di rollback utilizzabile.

Correzione proposta: tombstone e contesto causale, conflitto modifica/eliminazione online e percorso di recupero degli orfani.

### F04 — Undo di create cancella senza verificare gli edit successivi

Riferimento: `packages/sync/src/changelog.ts:261`.

Per `op === 'create'` l'undo chiama direttamente `model.delete` se l'entry esiste, senza verificare chi l'abbia modificata in seguito.

Riproduzione: creazione di `new.tex` con `author A`, chiusura del change set, contributo successivo, undo della creazione. **Osservato:** zero file visibili; il documento nascosto contiene `author A plus later contribution`. Non viene richiesto un conflitto prima della rimozione.

Correzione proposta: invertire la creazione solo se non esistono operazioni successive incompatibili; altrimenti conservare e far risolvere il conflitto.

### F05 — Delete di documento non caricato e restore vuoto

Riferimenti: `packages/sync/src/changelog.ts:183` e `:265`.

La cronologia usa la cache `texts` come contenuto prima del delete e sostituisce una voce assente con stringa vuota. Per documenti lazy già persistiti ma non aperti questa cache non contiene il testo.

Riproduzione: creare/persistire `main.tex = original`, riaprire il modello, avviare ChangeLog senza aprire il testo, eliminare e annullare. **Osservato:** `beforeRecorded: ""`, `restored: ""`; il vecchio documento contiene ancora `original`, ma l'undo crea una nuova entry vuota.

Correzione proposta: riferire la versione completa conservata per identità e recuperarla indipendentemente dal caricamento dell'editor; vietare placeholder vuoti per dati sconosciuti.

### F06 — Il timer di raggruppamento include modifiche di un'altra origine

Riferimenti: `packages/sync/src/changelog.ts:143`, `:222` e `:258`.

Ogni gruppo conserva il suo `before`, ma alla chiusura legge l'`after` globale. Se nel frattempo interviene un'altra sorgente, la patch del primo gruppo include anche il secondo contributo.

Riproduzione: `base` → `base folder` con origine cartella → `base folder EDITOR` con origine editor, chiusura dei gruppi, undo del gruppo cartella. **Osservato:** la patch della cartella contiene `+ folder EDITOR` e l'undo restituisce `base`, rimuovendo anche `EDITOR`.

Correzione proposta: gruppi come proiezione di operazioni per sorgente, inversioni condizionali sulle sole operazioni referenziate. Aumentare o diminuire il timer non risolve l'errore.

### F07 — L'ultimo salto di rete sostituisce l'autore

Riferimenti: `packages/sync/src/changelog.ts:123`, `packages/sync/src/mesh.ts:773` e `:811`, `packages/sync/src/persistence.ts:29`.

ChangeLog classifica l'update tramite `PeerConnection.claims.uname`. La mesh inoltra update Yjs, mentre il record ChangeSet contiene solo tipo/nome della sorgente e non una prova durevole dell'autore originale.

Riproduzione: Alice collegata a Bob, Bob a Carol, nessun collegamento Alice–Carol; baseline comune, poi Alice aggiunge `by Alice`. **Osservato su Carol:** `source = {kind: "peer", name: "bob"}`.

Correzione proposta: envelope dell'operazione originale con identità stabile, integrità e riferimenti causali; relay e bootstrap conservano tali informazioni. Le vecchie attribuzioni non diventano verificabili a posteriori.

### F08 — Il primo edit dopo il caricamento lazy scompare dalla storia

Riferimento: `packages/sync/src/changelog.ts:142`.

Se `before` è undefined, il primo update è trattato come baseline. Il caricamento da storage avviene prima che il modello colleghi l'osservatore degli update del documento; quindi può essere proprio il primo edit effettivo a essere saltato.

Riproduzione: riaprire uno store con `main.tex`, avviare ChangeLog, aprire il testo e cambiarlo immediatamente in `changed`. **Osservato:** testo aggiornato ma `recorded: 0`.

Correzione proposta: baseline stabilito al caricamento prima di ammettere la mutazione, oppure registro direttamente nel percorso delle operazioni.

### F09 — Rename sovrascrive il record dell'edit nello stesso gruppo

Riferimento: `packages/sync/src/changelog.ts:163`.

Per una rinomina la mappa pending sostituisce la voce per file con `op: rename`, perdendo il `before` dell'edit già presente.

Riproduzione: `a.tex = before`, cambiare in `after`, rinominare `b.tex`, chiudere il gruppo e annullarlo. **Osservato:** il gruppo registra solo rename; l'undo ripristina `a.tex` ma lascia il testo `after`.

Correzione proposta: più operazioni immutabili per la stessa identità di file, ordinate e invertibili come gruppo.

### F10 — Il fallimento di putChangeSet elimina il lavoro da ritentare

Riferimenti: `packages/sync/src/changelog.ts:210` e `:231`.

`close` rimuove pending e timer prima di attendere `putChangeSet`. In caso di errore il gruppo non viene reinserito, né entra nel retry dei documenti Yjs. Un testo salvato correttamente non dimostra che la sua storia sia salvata.

Riproduzione: edit, storage che rifiuta `putChangeSet` con `disk full`, primo flush fallito, storage ripristinato e secondo flush. **Osservato:** `failed: true`, `historyAfterRetry: 0`.

Correzione proposta: registro nel commit durevole, pending mantenuto fino al successo, retry e avviso persistente separati dalla sola sincronizzazione.

## Altri rischi osservati nel codice

Queste osservazioni sono fondate sulla lettura del codice; non sono incluse nel conteggio delle dieci riproduzioni dinamiche.

| ID | Evidenza | Rischio / verifica da aggiungere |
| --- | --- | --- |
| S01 | `mirror-node.ts:49`; `mirror.rs:214` | Fallback a scrittura in-place dopo rename fallito: il target può essere troncato invece di preservare il precedente. Provare errore durante il fallback. |
| S02 | `mirror.rs:207` | `with_extension("p2p-tmp")` produce lo stesso temporaneo per `main.tex` e `main.bib`; servono staging univoco e prova concorrente. |
| S03 | `model.ts:718`, `:738`; `HistorySnapshot` | Snapshot letti con await per file, privi delle impostazioni main/engine; restore multi-file senza un journal unico dell'operazione. Provare mutazioni fra await, asset assenti e kill durante restore. |
| S04 | `wasm-engine.ts:87`, `:106` | Il timeout del build parte dopo `start()`: worker che non emette ready/error può lasciare l'avvio pendente. Aggiungere timeout dell'avvio e retry con cleanup. |
| S05 | `wasm-engine.ts:163`; `public/sw.js` | Probe HEAD richiesto prima del setup cache; il service worker intercetta solo GET. Dopo scadenza del probe cached, una rete assente può disabilitare anche pacchetti locali completi. Provare warm cache in una nuova sessione offline. |
| S06 | `model.ts` validazione e dedupe path; mirror host | Le collisioni logiche sono confrontate come stringhe sensibili al case: l'host Windows può far coincidere path diversi. Provare case, Unicode, nomi riservati e file/directory. |
| S07 | `changelog.ts:258`, `:274` | Patch inverse fuzzy anche parzialmente applicate e binary undo senza confronto dell'hash attuale: verificare sovrapposizioni e sostituzioni successive. |
| S08 | `.github/workflows/ci.yml`, `desktop.yml`; test native | Parte della diagnostica è advisory; alcuni test native possono restituire successo quando non rilevano un engine. I gate sui requisiti minimi devono verificare che il lavoro sia stato effettivamente eseguito. |

Il pannello History crea uno snapshot quando viene aperto; non sostituisce un journal automatico di ogni mutazione. La retention implementata di sette giorni/500 gruppi è una buona base ma non può compensare record mancanti o content non conservato.

## Cosa è già protetto correttamente

- Identità stabili dei file per rename/edit e deduplica che ricontrolla completezza e revisioni, evitando confronti fra testi non ancora arrivati.
- Separazione fra disponibilità del contenuto, durevolezza locale e ricevute di riconciliazione; lo stato cached non basta a dichiarare una riconnessione aggiornata.
- `DocPersister` mantiene gli update non salvati e li ritenta; ingress e `OfflineFork` hanno journal/checkpoint. F10 riguarda il percorso diverso della cronologia.
- Acquisizione immutabile in `snapshot.ts` per input di compilazione/export e rifiuto dei sorgenti mancanti. Può essere riutilizzata per snapshot/versioning.
- Handshake con ticket e prova della chiave del dispositivo, filtro viewer e limiti di trasporto/blob coperti dai test esistenti. Tali protezioni non dimostrano l'attribuzione dell'operazione originale dopo il forwarding.

Questi elementi suggeriscono di rinforzare i confini fra componenti, mantenendo il modello CRDT e la persistenza già presenti.

## Confronto con Overleaf

Checkout di riferimento: [`overleaf/overleaf` a `e039ad26c5bf5422eb57b89fc7e57c75055e631d`](https://github.com/overleaf/overleaf/tree/e039ad26c5bf5422eb57b89fc7e57c75055e631d), consultato il 16 ottobre 2026. Il confronto riguarda il codice dei servizi selezionati, non una prova end-to-end dell'installazione Overleaf o una certificazione della sua assenza di bug.

| Meccanismo osservato | Fonte primaria | Applicazione proposta in HiveTeX |
| --- | --- | --- |
| Update con versione, duplicati riconosciuti, delete mismatch e verifica hash quando applicabile | [ShareJsUpdateManager.js](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/document-updater/app/js/ShareJsUpdateManager.js) | ID e dipendenze causali per operazione Yjs, replay idempotente e precondizioni delle inversioni. Non copiare un contatore centrale in una mesh P2P. |
| Elaborazione delle code sotto lock del progetto, metadati delle operazioni e coda della storia separata | [UpdateManager.js](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/document-updater/app/js/UpdateManager.js) | Serializzazione per identità, commit recuperabili e provenienza indipendente dal trasporto; nessun lock globale fra utenti. |
| Recupero di documenti soft-deleted con contenuto e ranges, nome restaurato distinto | [ProjectEntityRestoreHandler.mjs](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/app/src/Features/Project/ProjectEntityRestoreHandler.mjs) | Tombstone, contenuti conservati e vista Deleted/Recovery, senza sovrascrivere un nuovo file allo stesso path. |
| Ripristino da versione esplicita con userId e origine di restore | [RestoreManager.mjs](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/app/src/Features/History/RestoreManager.mjs), [RestoreFileOrigin](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/libraries/overleaf-editor-core/lib/origin/restore_file_origin.js) | Snapshot completi e restore come nuova operazione con identità, versione sorgente e recovery point. |
| Chunks/versioni storiche e blob conservati dal servizio storico | [HistoryStoreManager.js](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/project-history/app/js/HistoryStoreManager.js) | Registro e vault sui dispositivi dei membri, trasferiti end-to-end, con pin dei riferimenti e retention esplicita. |

Overleaf usa servizi centrali e percorsi OT/versionati; HiveTeX usa Yjs e peer senza server documentale. I principi trasferibili sono conservazione delle versioni, identità delle operazioni, recupero esplicito e precondizioni. Non è corretto concludere che usare un CRDT o copiare una funzione Overleaf elimini tutti i conflitti.

Nel codice Overleaf sono inoltre visibili compromessi da non trasferire: `UpdateManager` può riconoscere una scrittura anche dopo errore della coda storica, e `HistoryStoreManager` ha un fallback a contenuto vuoto per un file non reperibile nello storage. La proposta di HiveTeX sceglie esplicitamente di preservare dati sconosciuti/mancanti e di non dichiarare salvata una cronologia non durevole. Overleaf è un riferimento da valutare, non una garanzia automatica.

## Verifiche eseguite

| Verifica | Esito | Limite pratico |
| --- | --- | --- |
| `pnpm turbo run build lint test --concurrency=1 --output-logs=errors-only --force` | **27 task riuscite**, nessuna cache, secondo run completo | Il primo run falliva due test RTC contro un `rtc_cli` precedente; ricostruiti gli esempi, il run passa senza modificare sorgenti. Non classificato come bug del commit. |
| Unit sync | **433 pass** | Fake mesh e bridge native non coprono ogni rete reale. |
| Unit compilazione | **59 pass** | I test rimasti di build distribuita descrivono ancora il comportamento da rimuovere. |
| Unit web | **320 pass** | Non includono le dieci regressioni mirate nuove. |
| Unit server | **181 pass, 15 skip** | Alcuni backend/relay richiedono ambiente specifico. |
| `svelte-check --tsconfig ./tsconfig.json --threshold error` | **0 errori, 11 warning in 7 file** | Warning preesistenti, non corretti durante la pianificazione. |
| `cargo test --locked --lib -- --test-threads=1` | **146 pass, 5 ignored** | Ignorati provisioning TinyTeX/Tectonic, terminale reale e test CPU; il sample con TeX installato passa. |
| `cargo build --locked --example rtc_cli --example tex_cli` | **riuscito** | Esempi ricostruiti prima della ripetizione della suite. |
| Smoke diretto `tex_cli`, MiKTeX/pdfLaTeX | **ok**, timeout false, PDF **14.128 byte**, firma `%PDF` | TeX presente sulla macchina; non è prova di provisioning su una macchina vuota. |
| Playwright: `changes`, `offline-and-compile`, `realtime` | **5 pass, 1 skip**, 1,6 minuti | Il caso relay è saltato senza ambiente application relay; browser Chromium su macchina locale. |
| Compilazione browser nel flusso Playwright del baseline | **PDF visualizzato e stato stale aggiornato con engine simulato** | `newUser` imposta `hivetex.fakeEngine=1`: questa prova non dimostra esecuzione LaTeX/WASM reale. Lo smoke reale è aggiunto nella fase apply. |
| Sync diretto con sette utenti | **pass**, p95 osservato **7,2 ms**, 180 campioni | Misura localhost, non SLO per Internet o NAT differenti. |
| Dieci riproduzioni negative | **tutti e dieci i difetti osservati** | Riproduzioni deterministiche a livello componente; la suite ordinaria resta verde perché non verifica questi casi. |
| Validazione OpenSpec | `openspec validate audit-sync-data-safety --strict` | Validazione degli artefatti, non delle correzioni ancora da implementare. |
| Budget bundle e policy CI/deploy | **172,3 KB gzip su 250 KB**, **17 test pass** | Controlli aggiuntivi del baseline. |
| Audit dipendenze | **0 high/critical, 1 moderate** | Esbuild transitivo GHSA-67mh-4wv8-2f99; presenza confermata, esposizione della funzione serve non dimostrata. Dettagli e fonte in `evidence/verification.md`. |

I warning Turbo sugli output mancanti dei task `tsc --noEmit` e degli stub desktop non hanno bloccato la suite; il task desktop `build/test` da solo non equivale a costruire un installer o eseguire un'app desktop completa. I test Rust e gli esempi sono stati perciò eseguiti separatamente. La verifica bundle aggiuntiva è riportata in `evidence/verification.md`.

## Cosa resta non dimostrato

- Provisioning reale da zero, TinyTeX/Tectonic con download effettivi e installazione su macchine pulite.
- Intera UI desktop installata e matrice macOS/Linux; doppia icona tray non riprodotta come incidente durante questo audit. Il codice contiene già single-instance e test lifecycle, ma non basta a diagnosticare il report storico.
- Nuova matrice Internet/NAT/TURN/application relay e misura dei costi: le task 6.1 e 8.1 della change `reliable-sync-transport` sono ancora aperte, mentre altre prove sono documentate come completate. Non vengono qui ripetute o presentate come nuove prove.
- Taglio del processo in ogni fase di snapshot/restore e guasti di filesystem reale a livello disco/permessi su tutti i sistemi supportati.
- Assenza assoluta di bug o conservazione dopo cancellazione di tutti gli storage. La garanzia da costruire è: nessuna perdita involontaria da sync nei casi supportati e nessuna operazione distruttiva senza contenuto e traccia recuperabili.

## Criteri di uscita proposti

1. Tutte le dieci riproduzioni diventano regressioni che verificano il comportamento corretto e passano su store memory/IndexedDB/SQLite dove applicabile.
2. Ogni delete/replace/undo/restore ha operazione, autore e recovery point durevoli; errore o conflitto non cancella le versioni concorrenti.
3. Un terzo peer e un nuovo dispositivo mostrano l'autore originale delle operazioni trattenute; dati legacy restano esplicitamente non verificati.
4. Le build sono soltanto locali, senza capacità, leader, richieste e risultati di compilazione fra peer; sorgenti e asset continuano a sincronizzarsi.
5. Kill/restart, disco pieno, lettura fallita, watcher ritardato, documento lazy, delete/edit online e rename/binary concorrenti non perdono byte recuperabili e non producono successi falsi.
6. I gate minimi sono obbligatori, con risultati reali di compilazione e skip dichiarati; prove ambientali mancanti non vengono convertite in garanzie.

Approccio e ordine di attuazione sono in [design.md](design.md) e [tasks.md](tasks.md). Tutti gli artefatti necessari all'implementazione sono pronti. L'utente ha successivamente autorizzato esplicitamente l'apply diretto al termine della pianificazione; l'applicazione procede in quella fase distinta, senza modificare il significato delle evidenze del baseline riportate qui.
