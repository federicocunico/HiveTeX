# Proposal

## Why

La verifica dell'apply di `audit-sync-data-safety` (working tree non committata su `9aeb8df`) conferma i numeri del
verbale: sync 483, compile 37, web 323, Rust 150 pass / 5 ignored. La revisione del codice ha però trovato difetti che
quei gate non coprono. Il registro salva e invia uno stato completo del documento a ogni transazione. Una cancellazione
precedente all'upgrade mette in quarantena per sempre il sync della radice. Su filesystem senza hard link il mirror
toglie il file dalla cartella e può propagarne l'eliminazione. Le copie di recupero crescono senza limite a ogni
scrittura.

Anche le prove ancora aperte (8.3–8.5 dell'audit, 8.1 del trasporto) non possono essere chiuse in modo affidabile. Diversi
test aprono socket su tutte le interfacce e quindi generano prompt del firewall di Windows. L'harness a due macchine
con Windows Sandbox non controlla né registra lo stato del firewall, quindi un esito non distingue un blocco del firewall
da un difetto del sync. Prima dell'archiviazione servono correzioni e una prova a due macchine che non dipenda dal
firewall.

## What Changes

- **Registro limitato.** Niente più stato completo del documento per transazione, né su disco né nell'envelope firmato.
  La preimmagine si cattura solo dove serve al recupero (inizio di un gruppo, operazione distruttiva) ed è deduplicata per
  contenuto. Un test misura la crescita per battitura.
- **Radice mai bloccata da cancellazioni legacy.** Una cancellazione fisica ricevuta da un peer conserva localmente in
  Recovery il file rimosso e applica comunque l'update. Il resto dello stato del peer non resta in quarantena. Le
  eliminazioni recuperabili usano una rappresentazione che i client 0.8.0 leggono come normale cancellazione.
- **Sync live non serializzato dietro storage e cronologia.** Gli edit live non attendono il retry della persistenza
  della provenienza né il trasferimento della cronologia di un altro peer. Un record storico non verificabile viene
  saltato e segnalato, non blocca la paginazione. I peer 0.8.0 ricevono gli edit inoltrati come `UPDATE`.
- **Cronologia e undo.** Un edit remoto chiude il gruppo locale aperto, quindi l'undo non rimuove il contributo di un
  co-autore. Checkpoint di undo o restore interrotti diventano riprendibili o annullabili. Baseline vuote non diventano
  falsi edit "autore sconosciuto". I percorsi caldi non scorrono tutte le chiavi meta. L'export non duplica il database in
  memoria e rifiuta in modo esplicito archivi oltre il limite ZIP.
- **Mirror su ogni filesystem.** Il supporto degli hard link si rileva al bind e il ripristino non dipende da essi; il
  file non sparisce mai dalla cartella. Si conserva una copia solo quando il disco contiene byte non scritti da HiveTeX,
  con retention limitata. Eventi di directory, timer di retry condivisi e un singolo path bloccato non fermano il mirror.
- **Upgrade.** L'upgrade IndexedDB bloccato da un'altra scheda produce un messaggio. Su desktop, un file legacy più
  recente dopo un rollback non viene ignorato.
- **Compilazione locale (completamento dei task 2.x dell'audit).** Lo stato del compilatore in barra segue il motore
  attivo. Si allineano lo spec e2e rimasto rotto, il comando ridondante e la documentazione. I blob generati legacy non
  vengono più annunciati. Worker WASM e build native si chiudono con la sessione.
- **Build E2E isolate.** Le build E2E usano una directory target propria. Gli harness chiudono l'app in modo ordinato
  prima del kill forzato e verificano che non sia rimasta un'istanza precedente, così la prova a due macchine non guida
  una build vecchia.
- **Test indipendenti dal firewall.** I test locali Rust e JS legano socket e candidati ICE solo a loopback. I test
  nativi richiesti non risultano più verdi per un salto silenzioso.
- **Prova a due macchine affidabile.** L'harness Windows Sandbox:
  - spegne e verifica il firewall dentro il sandbox, salvo `FAULT=no-udp`, dove verifica che il blocco sia attivo;
  - registra lo stato del firewall dell'host e si ferma subito con diagnosi "firewall" se la configurazione può bloccare;
  - prova la raggiungibilità TCP/UDP prima del sync;
  - copre gli scenari di dati richiesti da 8.3, compreso il misto browser↔desktop;
  - non scrive build e output su un volume pieno.
- **Accettazione.** Si eseguono e registrano matrice e hold di cinque minuti, riportando i casi non eseguibili (TURN senza
  credenziali, host con firewall attivo) senza trasformarli in successi.

## Capabilities

### New Capabilities

Nessuna.

### Modified Capabilities

- `peer-sync`: crescita limitata della provenienza, admission della radice senza blocchi permanenti, sync live non
  bloccato da storage o cronologia, compatibilità degli edit inoltrati e delle eliminazioni con peer 0.8.0.
- `change-history`: separazione dei contributi remoti nei gruppi, ripresa di undo/restore interrotti, baseline senza
  falsi edit, export limitato in memoria, upgrade dello store bloccato.
- `project-locations`: mirror su filesystem senza hard link, copie di recupero limitate, retry indipendenti per path e
  per tipo.
- `compiler-provisioning`: lo stato del compilatore segue il motore attivo, anche dopo l'abbinamento dell'helper.
- `local-compilation`: risorse del compilatore rilasciate alla chiusura; nessun output di build condivise offerto ai peer.
  La capacità è introdotta da `audit-sync-data-safety`: archiviare questa change dopo quella.
- `local-dev-environment`: test locali che non dipendono dal firewall, harness a due macchine con controllo del firewall
  e scenari di sicurezza dati, build E2E isolate.

## Impact

- **Sync:** `packages/sync/src/` (persistence, mesh, authorship, changelog, model, recovery, runtime, mirror, mirror-node,
  path-collisions) e relativi test.
- **Desktop Rust:** `apps/desktop/src-tauri/src/` (mirror, store, tex, rtc, transport, examples
  `rtc_cli`) e harness `apps/desktop/e2e/` (sandbox-sync, run, lifecycle, background, tauri.e2e.conf.json).
- **Web:** `apps/web/src/` (session, StatusBar, Workspace, RecoverySection, recovery-export, wasm-engine).
- **Test, CI e server:** `e2e/workspace.spec.ts`, `.github/workflows/ci.yml`, `scripts/native-test-bin.mjs`,
  `server/src/local.ts`.
- **Documentazione:** `docs/` (testing, desktop-storage, folders, compilation, protocol), README.
- **Formati:** formati del registro, dell'envelope e delle eliminazioni introdotti dall'apply non ancora rilasciato. Si
  possono cambiare senza migrazione pubblica, ma serve una conversione per gli store di sviluppo già creati.
  Compatibilità di rete garantita con i peer 0.8.0.
- **Ambiente:** su F: restano 1,6 GB liberi, quindi build e output dell'harness vanno su un volume configurabile.
  L'agente non può cambiare il firewall dell'host: lo stato viene solo registrato e verificato.
- **Coordinamento:** chiude i punti 8.3–8.5 di `audit-sync-data-safety` e 8.1 di `reliable-sync-transport`. Si archivia
  dopo `audit-sync-data-safety`.
