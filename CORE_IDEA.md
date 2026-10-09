Il progetto è un'alternativa gratuita e decentralizzata a piattaforme come Overleaf, ideata per scrivere documenti in LaTeX collaborando in tempo reale senza dipendere da cloud a pagamento.

Scrittura offline e sincronia automatica: Puoi lavorare al tuo paper ovunque, anche senza connessione internet. Appena ritrovi la rete, il sistema unisce in automatico le tue modifiche con quelle dei tuoi colleghi, paragrafo per paragrafo, senza creare file duplicati o sovrascritture.

Connessione diretta (Peer-to-Peer): Non esiste un server centrale o un database aziendale che immagazzina i file. I computer dei co-autori comunicano direttamente tra loro creando un network privato per scambiarsi testo, immagini e bibliografia.

Compilazione "intelligente": È l'innovazione principale del sistema. Invece di far faticare i portatili di tutti o pagare un server per generare il PDF, la rete valuta in automatico quale tra i computer connessi in quel momento ha l'hardware migliore. Quel computer si fa carico silenziosamente di compilare il codice sorgente e trasmette all'istante il PDF pronto agli schermi di tutti gli altri. Se il proprietario del PC più potente spegne il computer, il sistema passa il testimone al secondo migliore.

Privacy totale: I sorgenti del documento non lasciano mai i dispositivi degli autori, garantendo la massima riservatezza per le ricerche non ancora pubblicate.

Voglio poterci lavorare localmente con claude code/codex/cursor/openrouter etc.
Questo dovrebbe essere configurato per uso local only. 

Repository pubbliche su cui basarsi da prendere componenti:
- https://github.com/overleaf/overleaf
- https://github.com/Oleafly/Oleafly  (repository in fase di sviluppo, ma sembra interessante)

Voglio anche una integrazione oauth con github per fare copia della repo/storing su github. Una volta questa feature era presente anche su overleaf, ma è una cosa in più oltre al discorso p2p (magari impostare un backup ogni tot modifiche, o quando non modifico da tot tempo)


Il server con la lista dei candiabili diciamo è ok su vercel, purché sia appunto a costo zero. possiamo valutare database tipo airtable o api dropbox per i file dove salvare gli id o quel che serve.

L'idea di fonto è che ho un ID univoco fornito alla creazione del progetto (personalizzabile magari) che poi mi permetta di inviarla ad altri, che si collegano alla piattaforma, inseriscono l'ID e arrivano all'overleaf della persona. Potenzialmente, protetto da pwd (default=on). Solo per l'owner: possibilità di mettere readonly per le varie persone, e per l'owner di gestire i permessi di chi si unisce al progetto (no limits). Ovviamente meglio avere un username/account per ogni persona. 

Deve essere SICURO per un uso online, e privacy. 


