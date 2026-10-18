# Design

## Context

Vedere `proposal.md` per motivazione e `audit-report.md` per evidenze. Il progetto usa un documento Yjs per albero/impostazioni e documenti caricati su richiesta per i testi. `Persistence.transact`, journal di ingress, checkpoint di `OfflineFork`, acquisizione immutabile in `snapshot.ts` e worker desktop forniscono già basi riutilizzabili. Non vanno sostituiti con un secondo sistema indipendente.

La cronologia attuale è un osservatore locale degli update, raggruppati prima della scrittura: non rappresenta un registro affidabile delle operazioni originali. Le eliminazioni rimuovono l'entry dall'albero; un testo ancora presente nello store può diventare invisibile e non recuperabile dall'interfaccia. I mirror scrivono e cancellano file reali.

Il codice ha già `local` come modalità predefinita e indica `auto`/`peers` come deprecate, ma crea ancora `Election`, `CompileLeader` e `CompileClient`. Le specifiche principali e parte dei documenti descrivono ancora la distribuzione delle build. La decisione esplicita dell'utente in questa sessione risolve tale divergenza: rimuovere la compilazione distribuita, mantenendo soltanto build sulla macchina dell'utente.

## Goals / Non-Goals

**Goals:**

- Rendere ogni mutazione confermata durevole riconducibile a una provenienza, e ogni operazione distruttiva recuperabile nella finestra dichiarata.
- Preservare contributi concorrenti online e offline, compresi file non aperti e modifiche esterne non ancora importate.
- Separare convergenza CRDT, salvataggio locale, completezza della cronologia e recuperabilità; una sola spunta Sync non attesta tutte queste proprietà.
- Rimuovere realmente la compilazione distribuita da protocollo applicativo, sessione, interfaccia, test e documenti; preservare acquisizione coerente, diagnostica e SyncTeX locali.

**Non-Goals:**

- Trasferire i sorgenti o la cronologia a un archivio centrale, cambiare Yjs con OT o replicare l'architettura di hosting Overleaf.
- Attribuire retroattivamente autori sconosciuti, ricostruire byte mai salvati da alcun dispositivo o promettere recupero dopo perdita fisica di tutte le copie.
- Richiedere staging o conferma per normali salvataggi della cartella. Le scelte esplicite riguardano conflitti e operazioni distruttive non sicure.
- Pubblicare o distribuire automaticamente il software: l'utente ha autorizzato l'apply diretto della proposta nel
  workspace; deploy e rilascio non sono parte di questa autorizzazione.

## Decisions

### 1. Registro durevole, integrato nella persistenza esistente

Introdurre un record versione 1 per operazione con `opId`, progetto, `uid`, identità del dispositivo e chiave, nome visualizzato, origine (`editor`, `folder`, `import`, `undo`, `restore`, `legacy`), riferimenti causali, ID dei file, tempi dichiarati, delta e riferimenti ai contenuti prima/dopo. I tempi non stabiliscono da soli l'ordine né l'autorizzazione. I byte binari rimangono indirizzati per hash.

Usare le transazioni IndexedDB/SQLite già esposte dal contratto Persistence per registrare operazione, riferimenti di recupero e stato applicato. L'ack di durevolezza richiede anche la cronologia; l'ack di sola presa in carico dell'ingress resta distinto. Prima di una mutazione distruttiva salvare il preimage e ricontrollare le revisioni dopo ogni attesa; se lo stato è cambiato, ricalcolare o esporre conflitto.

Per gli update in ingresso conservare payload originale e base necessari al replay prima dell'ack; il journal distingue ricevuto, autorizzato, applicato e salvato. Riprendere idempotentemente per `opId` dopo crash. Lo stato in memoria può essere già cambiato per edit non distruttivi, ma non può essere mostrato come salvato se il registro fallisce. Pending e retry non vengono rimossi prima del commit.

Alternativa scartata: rendere durevole soltanto il testo Yjs e ricostruire Changes a posteriori. La compattazione e il relay non conservano una prova sufficiente dell'autore o il contenuto cancellato.

### 2. Provenienza originale firmata, scambiata fra membri

Associare le operazioni a envelope firmati con la chiave del dispositivo, contenenti identità del progetto, hash del payload, ID dell'operazione e dipendenze. Il peer inoltra gli stessi envelope; il mittente del trasporto resta un dato separato. Negoziare capacità e intervalli di registro disponibili, scambiare operazioni mancanti con limiti di byte, paginazione e deduplica. Bootstrap e seed scaricano anche il materiale storico trattenuto, separando il progresso dei sorgenti da quello della cronologia.

L'evidenza storica non concede nuovi diritti: le operazioni nuove restano soggette a ticket, ruolo, epoch e revoca esistenti. Non accettare una scrittura nuova con un ticket scaduto soltanto perché l'autore ha dichiarato un timestamp precedente. Gli edit offline vengono autorizzati alla riconnessione; certificati ed eventuali ricevute già acquisiti servono a verificare la storia, non a riaprire l'accesso. Una firma valida prova l'origine del dispositivo, non chi materialmente usava la tastiera.

Un'importazione senza log originale registra l'importatore come autore dell'importazione, lasciando sconosciuto l'autore del testo. Record legacy restano consultabili con la loro minore attendibilità. Per delta legacy distruttivi preparare su una replica temporanea, conservare il precedente e mettere in quarantena l'operazione quando non è possibile soddisfare le precondizioni. Mostrare la necessità di aggiornare il peer; non dichiarare completa la protezione della sessione mista.

Alternativa scartata: dedurre l'autore da `PeerConnection.claims.uname`, presence o client ID Yjs. Il test Alice → Bob → Carol dimostra che tale deduzione attribuisce a Bob il lavoro di Alice.

### 3. Eliminazione logica e conflitti strutturali causali

Per le nuove operazioni conservare l'entry stabile e rappresentare l'eliminazione con un tombstone versionato, collegato all'operazione e al frontier osservato del file. Non usare `files.delete` come unico significato persistente della cancellazione. I testi e i blob di versioni trattenute restano referenziati dal vault di recupero.

La vista attiva è derivata da entry, operazioni e risoluzioni. Un edit/rename/nuovo hash non incluso nel contesto causale della cancellazione produce un conflitto modifica/eliminazione, anche se i dispositivi erano collegati. Una risoluzione è una nuova operazione che cita tutte le versioni coinvolte. La UI offre conservare, eliminare con recuperabilità o esportare/conservare entrambe; non reinserisce automaticamente un file storico durante bootstrap.

Prima di modificare lo schema Yjs della root prevedere una migrazione con snapshot e copia originale; non reinterpretare silenziosamente il formato per un vecchio client. Il codice di compatibilità intercetta delta distruttivi legacy prima di proiettarli nel modello attivo.

Retention: almeno sette giorni o 500 gruppi, mantenendo più a lungo dati referenziati da conflitti, versioni trattenute, operazioni pending/denied o recuperi non risolti. Nessun GC di un blob ancora referenziato. Il pruning è transazionale e pubblica il punto di recupero più vecchio. La scomparsa di un file dall'albero non autorizza il GC del contenuto.

Alternativa scartata: usare solo l'UndoManager Yjs o disabilitare il GC. Questo non protegge la copia filesystem e non crea una cronologia persistente con autori e risoluzioni.

### 4. Changes come proiezione; undo e restore con precondizioni

Derivare i gruppi di presentazione da operazioni immutabili. Ciascun gruppo conserva l'elenco delle operazioni originali; non ricavare la sua patch leggendo il testo globale alla chiusura del timer. Il caricamento di un documento stabilisce il baseline prima del primo edit; una cancellazione usa la versione conservata, anche se il documento non è mai stato aperto. Edit, rename e sostituzione binaria rimangono operazioni distinte nello stesso gruppo.

Per undo calcolare un piano inverso contro versioni e dipendenze attuali. Edit non sovrapposti restano intatti; contesto ambiguo o sovrapposizione producono conflitto, senza applicare il risultato parziale di patch fuzzy. Per undo di create richiedere che non esistano contributi successivi; per binary confrontare l'hash attuale con l'hash prodotto; per rename controllare path e destinazione; per restore di delete verificare tombstone e occupazione del path. Registrare `undoOf` e un ID di richiesta idempotente. Un'interruzione può riprendere senza invertire due volte.

Riutilizzare il modello di acquisizione sincrona di `snapshot.ts` dopo avere caricato i documenti, estendendolo ai riferimenti necessari per versioning e impostazioni. `captureSnapshot` attuale legge invece un file alla volta attraverso await. Restore ha preview, precondizioni di revisione e checkpoint durevole prima di modificare qualunque file; root, testi, impostazioni e asset fanno parte dello stesso piano recuperabile. La UI espone conflitti e recupero anche quando nessuna inversione sicura è applicabile.

Alternativa scartata: considerare un elenco `partial` sufficiente dopo avere già applicato la patch o cancellato il file. L'avviso successivo non evita la rimozione del contributo.

### 5. Contratto filesystem esplicito e rimozioni protette

Decisione di apply per il requisito prioritario di conservazione: le cartelle browser sono solo importazioni in
lettura, con preview e normale registro delle modifiche al progetto. Non vengono usate per un mirror bidirezionale:
File System Access API non può impedire la corsa finale contro uno scrittore esterno. Il vecchio binding browser
viene disattivato senza toccare la cartella o reimportarla automaticamente. Il desktop mantiene il mirror completo,
con conservazione dell'inode precedente e pubblicazione esclusiva tramite hard link; se il filesystem non la supporta,
l'operazione fallisce conservativamente. Questo elimina il percorso browser non protetto, invece di accettarne il rischio.

Cambiare il contratto FsAdapter in lettura discriminata (`present`, `missing`, `error`) e scansione con esito di completezza; propagare gli errori diversi da NotFound. Il Rust distingue già NotFound nella lettura: preservare tale comportamento e portarlo negli adattatori browser/Node. Watcher e polling devono segnalare errori, senza convertirli in assenza.

Serializzare le riconciliazioni per identità del file, verificare contenuto/revisione su disco immediatamente prima di rimuovere o sostituire un file e salvare nel vault eventuali byte esterni non importati. Le cancellazioni effettive passano per un checkpoint durevole e una rimozione condizionata; errore o stato cambiato mantiene la copia. Anche le modifiche non autorizzate dei viewer vengono conservate solo per recupero locale, senza pubblicarle.

Due letture uguali non provano l'intento di cancellare: conservare il periodo di stabilizzazione, aggiungere stato della directory e marker di associazione, e assicurare sempre il recupero prima di propagare l'eliminazione. Un volume indisponibile o una scansione parziale sospende il mirror. Il normale salvataggio resta automatico e non richiede staging.

Usare temporanei univoci con nome completo e commit atomico supportato dalla piattaforma. Rimuovere il fallback `writeFile`/`fs::write` sul target dopo fallimento del rename. `p.with_extension("p2p-tmp")` deve cessare di far condividere il temporaneo a `main.tex` e `main.bib`. In caso di lock persistente segnalare errore e riprovare conservando il file precedente.

Rilevare collisioni del filesystem host prima di scrivere: case, Unicode, nomi riservati e file/directory. Se non esiste una mappatura reversibile e non distruttiva, lasciare le versioni nel progetto/vault e chiedere di risolvere il path; non forzare una sovrascrittura. Questi rischi hanno evidenza statica aggiuntiva nell'audit, non vengono conteggiati fra i dieci casi dinamici.

### 6. Una pipeline esclusivamente locale

Estrarre dal percorso `CompileLeader.compileLocally` un servizio locale indipendente da `Election`, `Mesh` come canale applicativo e `CompileClient`. La pipeline può acquisire sorgenti e asset dai peer tramite il sync già esistente, ma schedulazione e risultati restano nella sessione di questo dispositivo. PDF, log e SyncTeX generati usano una cache locale separata dagli asset condivisi. Un PDF importato volontariamente come input resta un asset sincronizzato.

Eliminare `capability` announcements di compilazione, elezione/failover, `compile-request`, `compiled` e accettazione dei risultati remoti. Ignorare messaggi di compilazione di client precedenti senza interrompere il sync dei sorgenti. Rimuovere le opzioni `auto` condivisa/`peers`, `compileForOthers`, benchmark/score/power usati soltanto per la leadership, nomi dei leader e UI di delega. Preservare tipi engine, parser log e supporto SyncTeX utilizzati localmente.

Migrare `auto` e `peers` verso `local` con spiegazione una tantum; il comportamento locale esistente resta quello predefinito, con build automatica dopo modifiche e build esplicita. Non introdurre una nuova modalità di compilazione manuale come parte di questa migrazione; eventuali preferenze automatiche già indipendenti restano valide. Nessun download/build solo perché un seed in background si sveglia.

Il helper `127.0.0.1` abbinato resta ammesso: è lo stesso computer, non un compilatore di un co-autore. Mantenere pairing e confini di origine. Un dispositivo senza engine mostra setup locale, non attende un peer. Distinguere bootstrap di engine/pacchetti, durata del build e scadenza complessiva; il worker deve avere timeout anche prima dell'evento ready. Un probe HEAD fallito non disabilita cache locale completa: tentare il percorso cached e descrivere dipendenze mancanti. Non promettere avvio offline del sito se shell/engine non sono stati resi disponibili localmente.

Preservare i limiti e l'isolamento dei compilatori verificati. Il quick compiler mantiene l'eccezione già documentata sulle letture non verificabili, visibile prima dell'uso; la rimozione dello sharing non viene usata per allentare shell escape o configurazioni eseguibili.

### 7. Verifica obbligatoria delle garanzie, separata dai laboratori ambientali

Convertire i dieci casi in regressioni del comportamento corretto; aggiungere taglio del processo a ogni checkpoint di registrazione/eliminazione/restore, guasti IndexedDB/SQLite e scansioni filesystem fallite. Controllare sia convergenza degli stati attivi sia conservazione ed esportabilità delle versioni concorrenti e provenienza originale.

Build, lint, tipi, regressioni browser dati/compilazione locale e test nativi indispensabili devono bloccare il merge; la configurazione attuale rende diagnostica browser e parte della UI desktop advisory. Ricostruire `rtc_cli`/`tex_cli` prima dei test che li usano: il primo run dell'audit ha usato un binario RTC obsoleto. Test di compilazione con engine reale devono fallire se il motore obbligatorio del job è assente, senza `return` che risulti un successo.

La matrice reale di NAT/TURN/relay e i costi della change `reliable-sync-transport` restano verifiche distinte e nominate; non si deduce la loro riuscita dai fake transport o da localhost. La soglia di rilascio è assenza di regressioni di perdita/provenienza e risultati ripetibili nelle configurazioni dichiarate, non una promessa assoluta su hardware/reti mai verificati.

## Risks / Trade-offs

- [Registro e vault aumentano disco e traffico] → Delta, blob per hash, paginazione e retention con pin dei riferimenti; limiti non cancellano recuperi irrisolti per fare spazio.
- [Nuovo protocollo e vecchi peer] → Negoziazione esplicita, conservazione preimage e quarantena dei delta distruttivi non sicuri; nessuna attribuzione inventata.
- [CRDT convergente ma perdita semantica] → Frontier causale per file e conflitti anche online; la sola uguaglianza del testo non è un criterio sufficiente.
- [Rimozione delle build condivise lascia dispositivi senza engine] → Migrazione spiegata e setup locale; test del percorso senza TeX e messaggi su pacchetti mancanti.
- [Guasto durante operazioni su più documenti] → Journal dell'operazione, checkpoint durevole e replay idempotente; niente cancellazione dei dati di recupero prima del commit.
- [Finestra di retention finita] → Mostrare il punto recuperabile e consentire export; proteggere ogni versione ancora referenziata. Il requisito riguarda perdita involontaria da sync, non conservazione infinita di ogni storia.

## Migration Plan

Per l'export nativo completo, creare una copia SQLite coerente e verificarne l'integrità, quindi trasferirla a blocchi
di 1 MiB attraverso handle opachi associati allo store e all'attachment. Includere anche le copie Yjs vive dei documenti,
comprese quelle dell'actor non ancora persistite. Il manifest espone hash e revisioni di inizio/fine. Non raccogliere
tutta la cronologia in un singolo messaggio IPC: il budget resta 160 MiB per messaggio, non per archivio. Cancel/close
rilasciano la copia temporanea; un crash può lasciarla disponibile accanto allo store senza alterare l'originale.

1. Aggiungere regressioni e gate sui dati senza cambiare lo schema esistente. Estrarre la pipeline locale e rimuovere lo sharing con migrazione delle preferenze e aggiornamento coerente delle specifiche/documenti.
2. Prima di migrare lo storage, conservare un export completo verificato di docs, blob, meta, ingress, snapshot e Changes; annotare versione e hash del backup.
3. Aggiungere tabelle/record versionati, vault e migrazione riprendibile. Preservare doc orfani e dati pending/denied. Identità storiche mancanti restano sconosciute.
4. Abilitare il nuovo contratto di cronologia/eliminazione per repliche compatibili, con controllo della sessione mista; completare UI e verifiche prima del rollout generale.
5. Per rollback del software conservare lo store nuovo e sospendere le mutazioni se il vecchio binario non ne comprende il formato; non aprirlo direttamente con una versione distruttiva. Ripristinare la copia precedente in uno store separato e salvare/esportare prima tutte le operazioni successive. Non riabilitare la compilazione distribuita come fallback.
6. Eseguire la matrice browser/desktop, crash/restart, filesystem e rete documentata in `tasks.md`; solo allora archiviare la change e riportare esiti, casi saltati e limiti.
