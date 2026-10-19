# Proposal

## Why

L'audit del commit `9aeb8df323b4afc7654b8257c052a34ce00b965e` ha riprodotto cancellazioni involontarie, undo che rimuovono lavoro successivo e cronologia incompleta o attribuita al peer che inoltra anziché all'autore. I requisiti minimi di compilazione locale, sincronizzazione utilizzabile e recupero verificabile richiedono correzioni prima di poter considerare sicuro il lavoro collaborativo; evidenze, limiti e confronto con Overleaf sono in `audit-report.md`.

## What Changes

- Le cartelle browser diventano importazioni in sola lettura; il mirror con editor esterni resta nel desktop, che
  conserva l'inode originale e pubblica senza sovrascrivere scritture concorrenti. I vecchi binding web sono disattivati
  senza cambiare la cartella.
- L'export nativo integrale trasferisce una copia SQLite coerente in blocchi limitati, con hash e stati Yjs vivi,
  evitando il limite dei grandi elenchi di cronologia nel bridge.

- Conservare testo, asset e metadati prima di cancellazioni o sostituzioni; introdurre eliminazioni recuperabili, conflitti modifica/eliminazione anche online e recupero delle copie già orfane.
- Separare file assente, errore di lettura e scansione incompleta negli adattatori delle cartelle; preservare il contenuto esterno modificato prima di rimuovere o rinominare un file.
- Registrare operazioni durevoli con identità dell'autore, dispositivo, origine, riferimenti causali e contenuti necessari al recupero; replicare questa provenienza fra peer autorizzati senza affidarsi al mittente dell'ultimo salto.
- Derivare Changes dal registro delle operazioni, con raggruppamento solo di presentazione; correggere primo edit dopo caricamento, cancellazioni di documenti non aperti, edit seguito da rename e retry della cronologia.
- Rendere undo e restore condizionali, visibili e recuperabili, preservando contributi successivi e proponendo conflitti quando l'inversione non è sicura.
- **BREAKING**: rimuovere la compilazione distribuita già deprecata: elezione del leader, pubblicazione delle capacità, richieste di build ai peer e distribuzione di PDF, log e SyncTeX. Ogni dispositivo costruisce e visualizza soltanto i propri risultati; il sync dei sorgenti resta indipendente.
- Verificare compilazione locale reale e sync su browser/desktop, comprese disconnessioni, riavvii e guasti di storage, con controlli obbligatori e binari diagnostici ricostruiti dal commit corrente. Il helper su loopback resta una build sulla stessa macchina.
- Definire compatibilità con client precedenti: una modifica senza provenienza verificabile resta riconoscibile come legacy, senza inventare l'autore o promettere protezioni non negoziate.

## Capabilities

### New Capabilities

- `local-compilation`: compilazione esclusivamente sulla macchina dell'utente, acquisizione coerente degli input, risultati locali, errori e limiti, migrazione delle vecchie preferenze.

### Modified Capabilities

- `peer-sync`: eliminazioni recuperabili, conflitti strutturali online, scambio della provenienza e migrazione conservativa delle repliche.
- `change-history`: registro durevole, autore originale verificabile, undo condizionale, snapshot coerenti e retention sicura.
- `project-locations`: errori filesystem distinti dall'assenza, rimozioni con controllo della copia esterna, scritture atomiche e collisioni dei nomi.
- `distributed-compilation`: rimozione di tutti i requisiti della capacità deprecata; le garanzie locali pertinenti passano a `local-compilation`.
- `compiler-provisioning`: tutti i compilatori producono risultati locali, compreso il helper sulla stessa macchina; nessun fallback verso compilatori di co-autori.
- `latex-workspace`: preview e indicatori descrivono la build di questo dispositivo, senza dipendere da un PDF condiviso.

## Impact

Interessa `packages/sync` (model, changelog, mesh, persistence, ingress, fork, mirror, worker), store e mirror Rust, editor e pannelli Changes/History/Sync, `packages/compile`, selezione dei compilatori e test/CI. Richiede migrazione additiva dello storage e negoziazione delle nuove capacità del protocollo. Le fonti Overleaf sono riferimenti di progetto, non una sostituzione del CRDT Yjs con il loro backend OT centralizzato. Il contenuto e la cronologia restano sui dispositivi dei membri; nessun nuovo archivio documentale sul control plane.

La change `reliable-sync-transport` è già aperta: questa proposta ne usa il trasporto e coordina i test d'integrazione, senza duplicarne le modifiche. La sua matrice e la misura dei costi ancora aperte restano prerequisiti per le relative garanzie di rete. Questa change è soltanto pianificata: l'audit non applica correzioni al prodotto.
