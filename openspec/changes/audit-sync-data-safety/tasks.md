# Tasks

Le caselle distinguono le attività completate da quelle ancora aperte. Le prove del baseline sono documentate in
`audit-report.md`; risultati e limiti dell'apply sono in `evidence/acceptance.md`.

## 1. Regressioni e prerequisiti ripetibili

- [x] 1.1 Convertire F01/F02 dello script `evidence/reproduction.md` in test mirror/adapter: verificare che permesso negato non generi delete e che un delete remoto preservi byte esterni non importati.
- [x] 1.2 Convertire F03/F04 in test online delete/edit e undo-create: verificare presenza del conflitto e recuperabilità del contributo su entrambe le repliche, non soltanto uguaglianza dell'albero.
- [x] 1.3 Convertire F05/F08/F09 in regressioni ChangeLog con store riaperto e documenti lazy: verificare contenuto completo dopo delete/undo, primo edit registrato ed edit+rename entrambi invertibili.
- [x] 1.4 Convertire F06/F07/F10 in regressioni di attribuzione e persistenza: verificare sorgenti interleaved isolate, Alice → Bob → Carol attribuita ad Alice e history retry dopo errore.
- [x] 1.5 Ricostruire esempi nativi come prerequisito dei test TS che li usano; verificare il comando da checkout pulito e con un eseguibile RTC obsoleto, e documentarlo in `docs/testing.md`.

## 2. Rimozione della compilazione distribuita

- [x] 2.1 Estrarre pipeline e cache dei risultati locali da `CompileLeader.compileLocally`; verificare con test che input catturati, debounce, risultato stale, parser log e SyncTeX funzionino senza `Election` o handlers di build sulla mesh.
- [x] 2.2 Rimuovere `Election`, ricezione/pubblicazione capacità, `compile-request`, `compiled`, client dei risultati remoti e logiche di failover da package/sessione; verificare che un peer legacy non avvii build né cambi la preview e che il sync sorgenti continui.
- [x] 2.3 Separare PDF/log/SyncTeX generati dall'asset store condiviso; verificare che non siano annunciati o trasferibili ai peer mentre un PDF caricato come input continui a sincronizzarsi.
- [x] 2.4 Migrare `auto`/`peers` e rimuovere `compileForOthers`, scelte condivise e indicatori del leader; verificare upgrade di tutte le vecchie preferenze, messaggio una tantum e indicatore del compilatore di questa macchina.
- [x] 2.5 Rendere locale ogni azione Compile, inclusi shortcut e viewer; verificare due utenti con compilatori diversi, perdita del peer e riapertura senza connessione, senza avvio compiler nei seed.
- [x] 2.6 Introdurre deadline e cleanup per startup/errore del worker WASM e retry su istanza pulita; verificare worker silente, crash, pacchetto mancante, errore LaTeX corretto e cache completa con probe upstream fallito.
- [x] 2.7 Aggiornare test `compile-mode`, `compile-modes`, `compiler-state`, UI, README e `docs/compilation.md`/`docs/protocol.md`; verificare che non restino percorsi attivi o istruzioni che propongano build sui co-autori e preservare pairing loopback e isolamento locale.

## 3. Contratto filesystem e commit atomico

- [x] 3.1 Introdurre esiti di lettura/scansione espliciti in FsAdapter, Node, web e bridge Rust; verificare NotFound distinto da EACCES/NotAllowed/lock/I/O e nessun delete da scansione incompleta (F01).
- [x] 3.2 Propagare stato di errore e retry bounded del mirror a workspace/worker; verificare che il ripristino permessi riprenda il sync senza ricreare file vuoti o nascondere il guasto.
- [x] 3.3 Usare temporanei univoci e commit atomico in mirror Node/Rust, eliminando il fallback con troncamento del target; verificare lock persistente, errore durante commit, crash e scritture concorrenti `main.tex`/`main.bib`.
- [x] 3.4 Rilevare collisioni case/Unicode/nomi riservati/file-directory prima delle scritture; verificare `Intro.tex`/`intro.tex` su Windows e conflitto `sections`/`sections/a.tex` senza sovrascrivere contenuti.
- [x] 3.5 Aggiornare `docs/folders.md` e `docs/desktop-storage.md` con errori, recupero e collisioni; verificare i messaggi nei percorsi browser e desktop e nessuna richiesta di staging per un salvataggio normale.

## 4. Registro e conservazione dei contenuti

- [x] 4.1 Estendere il contratto Persistence e store IndexedDB/SQLite con operazioni versionate, stato di replay e riferimenti al vault; verificare atomicità con fault injection prima/dopo ogni commit e parità fra store.
- [x] 4.2 Integrare ingress e mutazioni di modello/mirror/import con il registro: catturare contenuti e revisioni prima delle operazioni distruttive; verificare che l'ack durevole comprenda stato e storia e che errori conservino pending e retry (F10).
- [x] 4.3 Salvare e ripristinare operazioni non ancora raggruppate dopo riavvio; verificare kill prima del timeout di grouping e nessuna doppia applicazione durante replay.
- [x] 4.4 Implementare riferimenti/pin di testo e blob per versioni, tombstone, conflitti e pending/denied; verificare restore dei byte esatti dopo sostituzione/eliminazione e pruning con sette giorni/500 gruppi.
- [x] 4.5 Produrre export integrale con manifest/hash e migrazione additiva riprendibile; verificare errore a metà migrazione, formato futuro, doc orfani e nessuna cancellazione dello store originale.
- [x] 4.6 Documentare schema, ack e retention in `docs/runtime.md`/`docs/desktop-storage.md`; verificare esempi di recovery/export e punto recuperabile più vecchio mostrato correttamente.

## 5. Provenienza originale fra peer

- [x] 5.1 Definire envelope firmato con opId, progetto, utente/dispositivo, hash e dipendenze; verificare firma alterata, progetto errato, replay e separazione fra autore e forwarder.
- [x] 5.2 Aggiungere negoziazione e scambio paginato/deduplicato del registro con budget del trasporto; verificare Alice → Bob → Carol (F07), bootstrap da seed e riconnessione senza raddoppiare la storia.
- [x] 5.3 Collegare admission a ticket/epoch/ruolo correnti senza usare timestamp storico per autorizzare una scrittura; verificare revoca, ticket scaduto, edit offline autorizzato alla riconnessione e storia verificabile senza ripristino dei permessi.
- [x] 5.4 Gestire record legacy e import senza metadati con attribuzione dichiaratamente ignota; verificare che un payload distruttivo non sicuro sia conservato e messo in quarantena, con messaggio di compatibilità.
- [x] 5.5 Aggiornare `docs/protocol.md` e UI di progress della cronologia; verificare che completezza dei sorgenti e disponibilità storica siano stati distinti e nessun payload storico sia inviato al control plane.

## 6. Eliminazioni recuperabili e conflitti online

- [x] 6.1 Introdurre tombstone e frontier causale mantenendo l'identità del file; verificare delete normale, rename/edit/delete concorrenti e sostituzioni binarie concorrenti su almeno tre repliche (F03).
- [x] 6.2 Integrare conflitti strutturali online con risoluzioni versionate e checkpoint offline esistenti; verificare Keep/Delete/Both, chiusura durante conflitto e edit ulteriore prima della risoluzione senza sparizione delle versioni.
- [x] 6.3 Serializzare rimozioni/rename del mirror e confrontare il contenuto su disco prima del commit; verificare evento watcher ritardato (F02), atomic-save esterno, volume indisponibile e cambiamenti a raffica senza perdita della copia esterna.
- [x] 6.4 Preservare in vault locale modifiche esterne dei viewer prima del ripristino senza pubblicarle; verificare cambio ruolo durante read/write e recupero locale dopo revoca.
- [x] 6.5 Aggiungere vista dei file eliminati e recupero di documenti già orfani, con autore/path sconosciuti espliciti; verificare export, restore autorizzato e nessuna resurrezione automatica quando un vecchio peer rientra.
- [x] 6.6 Aggiornare documentazione di sync/cartelle e UI dei conflitti; verificare che una cancellazione intenzionale resti automatica e recuperabile e che nessun errore filesystem venga presentato come scelta dell'utente.

## 7. Changes, undo e version restore

- [x] 7.1 Derivare change set da operazioni immutabili e baselines corretti per documenti lazy; verificare F05/F08/F09 e preservare separatamente create, edit, rename, binary e delete.
- [x] 7.2 Calcolare diff per singola origine con identità stabile di utente e dispositivo; verificare sorgenti interleaved (F06), più dispositivi dello stesso utente, import e forwarding senza fusione indebita dei contributi.
- [x] 7.3 Implementare piano inverso con precondizioni per testo, create, rename, delete e binary; verificare F04/F06, edit sovrapposti, hash cambiato, path occupato e doppio click sullo stesso undo.
- [x] 7.4 Acquisire snapshot coerenti con impostazioni e asset disponibili; verificare cambiamenti durante await, file non ricevuti, asset mancante e round trip di main/engine senza snapshot misti.
- [x] 7.5 Implementare preview/commit/checkpoint di restore e `undoOf` persistente; verificare modifica remota dopo preview, revoca durante restore e riavvio a ogni fase senza perdita né doppia applicazione.
- [x] 7.6 Aggiornare Changes/History e guida utente con autore, dispositivo, provenienza, conflitti e avvisi durevoli; verificare tutti i percorsi anche quando nessuna inversione è applicabile e per viewer.

## 8. Gate e integrazione finale

- [x] 8.1 Rendere obbligatori in CI i test deterministici dei dati e smoke locali browser/nativi; verificare che regressioni F01–F10 o assenza del compilatore obbligatorio rendano il job rosso, senza successo da test saltato.
- [x] 8.2 Eseguire build/lint/test, svelte-check e budget bundle dal checkout pulito con esempi nativi ricostruiti; verificare tutti gli esiti e registrare warning, skip e versioni in un verbale di accettazione.
- [x] 8.3 Eseguire browser↔browser, desktop↔desktop e misto con testo/asset, rename/delete concorrenti, offline su entrambi e crash/restart; verificare albero, byte, autore originale, recupero ed export di ciascuna versione. Evidenza: `../fix-data-safety-apply-regressions/evidence/runs/2026-10-18T06-29-36-all` (desktop↔desktop in sandbox e misto browser↔desktop), browser↔browser in `e2e/recovery.spec.ts` e `e2e/changes.spec.ts`; stessa macchina fisica, NAT Hyper-V.
- [x] 8.4 Verificare build locale reale su macchine con TeX, senza TeX con provisioning e con cache calda offline; verificare PDF e contenuto atteso, errori e ultima preview, senza messaggi build ai peer. Evidenza: `../fix-data-safety-apply-regressions/evidence/runs/2026-10-18T06-25-54-compile` (host MiKTeX, sandbox senza TeX con compilatore gestito, build offline da cache).
- [ ] 8.5 Eseguire e allegare la matrice rete residua di `reliable-sync-transport` (STUN/TURN/relay/deaf session, hold di cinque minuti) e verifica su due reti; distinguere il sync dei sorgenti dalle build sempre locali e riportare i casi non eseguibili. Matrice eseguita in sandbox: `../fix-data-safety-apply-regressions/evidence/matrix.md`. Aperto: la verifica su due reti reali non ha un report allegato (`reliable-sync-transport` 8.3 è spuntata senza evidenza nel repository).
- [x] 8.6 Provare upgrade e rollback software su copie sacrificabili con store precedente/nuovo; verificare integrità degli export, conservazione delle operazioni post-upgrade e rifiuto conservativo del formato non supportato.
- [x] 8.7 Rieseguire lo script dell'audit convertito in asserzioni del comportamento corretto e verificare assenza di tutti i dieci difetti; aggiornare il rapporto con correzioni, evidenze e limiti prima di dichiarare il requisito di recuperabilità soddisfatto.
- [x] 8.8 Verificare il percorso transitivo esbuild 0.18.20 segnalato da GHSA-67mh-4wv8-2f99 e aggiornare compatibilmente il toolchain o documentare la non esposizione; verificare build, migrazioni e output di `pnpm audit` dopo la decisione.

## Workflow follow-up

- L'utente ha autorizzato l'applicazione diretta con una richiesta successiva durante la pianificazione; procedere dopo validazione degli artefatti senza chiedere ulteriore conferma.
- Archiviare dopo revisione degli esiti, coordinando `reliable-sync-transport` e sincronizzando tutte le delta spec.
- A ogni eventuale push che attivi CI, attendere il risultato, diagnosticare i fallimenti e riportare lo stato finale come richiesto da AGENTS.md.
