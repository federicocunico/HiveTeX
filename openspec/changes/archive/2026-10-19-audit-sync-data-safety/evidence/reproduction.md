# Riproduzione dei dieci difetti

Eseguito sul commit 9aeb8df323b4afc7654b8257c052a34ce00b965e, Node 22.22.0, pnpm 10.34.6, Windows. Lo script usa solo repliche in memoria; non apre progetti personali, non usa servizi esterni e non modifica codice del prodotto. I file URL riportano il workspace dell'audit: adattarli se si esegue altrove.

Salvare il blocco come un file .mts temporaneo ed eseguire dalla root: pnpm --filter @hivetex/sync exec tsx <percorso-assoluto-del-file.mts>. Ogni case stampa il comportamento effettivo difettoso; non è un test di accettazione che dichiara corretto quel comportamento.

```typescript
import {ProjectModel,applyTextDiff} from 'file:///F:/github/p2platex/packages/sync/src/model.ts';
import {MemoryPersistence} from 'file:///F:/github/p2platex/packages/sync/src/persistence.ts';
import {ChangeLog} from 'file:///F:/github/p2platex/packages/sync/src/changelog.ts';
import {MIRROR_ORIGIN,MirrorSync} from 'file:///F:/github/p2platex/packages/sync/src/mirror.ts';
import {Net,converged,waitFor} from 'file:///F:/github/p2platex/packages/sync/src/testkit.ts';
import {BlobManager} from 'file:///F:/github/p2platex/packages/sync/src/blobs.ts';
import {webFs} from 'file:///F:/github/p2platex/apps/web/src/lib/fs-access.ts';
const out:any[]=[];const logs:any[]=[];const models:any[]=[];const nets:any[]=[];const mirrors:any[]=[];
const solo=async(store=new MemoryPersistence())=>{const m=new ProjectModel(store,{flushMs:5});await m.init();models.push(m);return {m,store};};
const track=(m:any,store:any)=>{const log=new ChangeLog({model:m,store,idleMs:60000});log.start();logs.push(log);return log;};
const reopened=async()=>{const {m,store}=await solo();const id=await m.createTextNow('main.tex','original');await m.flush();await m.destroy();const n=await solo(store);return {...n,id};};
{
 const {m,store,id}=await reopened();const log=track(m,store);applyTextDiff(await m.openText(id),'changed');await log.flush();out.push({case:'lazy-first-edit',text:(await m.openText(id)).toString(),recorded:(await log.list()).length});
}
{
 const {m,store,id}=await reopened();const log=track(m,store);m.delete(id);await log.flush();const set=(await log.list())[0];await log.undo(set);const restored=m.find('main.tex');out.push({case:'lazy-delete-undo',beforeRecorded:set.files[0].before,restored:restored?(await m.openText(restored.id)).toString():null,originalDoc:(await m.openText(id)).toString()});
}
{
 const {m,store}=await solo();const log=track(m,store);const id=await m.createTextNow('new.tex','author A');await log.flush();const creation=(await log.list())[0];applyTextDiff(await m.openText(id),'author A plus later contribution');await log.flush();await log.undo(creation);out.push({case:'undo-create-after-edit',visibleFiles:m.list().length,retainedHiddenDoc:(await m.openText(id)).toString()});
}
{
 const {m,store}=await solo();const id=await m.createTextNow('main.tex','base');const log=track(m,store);applyTextDiff(await m.openText(id),'base folder',MIRROR_ORIGIN);applyTextDiff(await m.openText(id),'base folder EDITOR');await log.flush();const sets=await log.list();const folder=sets.find(s=>s.source.kind==='folder')!;await log.undo(folder);out.push({case:'mixed-source-undo',patch:folder.files[0].patch,after:(await m.openText(id)).toString()});
}
{
 const {m,store}=await solo();const id=await m.createTextNow('a.tex','before');const log=track(m,store);applyTextDiff(await m.openText(id),'after');m.rename(id,'b.tex');await log.flush();const set=(await log.list())[0];await log.undo(set);out.push({case:'edit-then-rename',record:set.files,afterUndo:{path:m.byId(id)?.path,text:(await m.openText(id)).toString()}});
}
{
 const {m,store}=await solo();const id=await m.createTextNow('a.tex','before');const log=track(m,store);applyTextDiff(await m.openText(id),'after');const put=store.putChangeSet.bind(store);store.putChangeSet=async()=>{throw new Error('disk full')};let failed=false;try{await log.flush()}catch{failed=true}store.putChangeSet=put;await log.flush();out.push({case:'history-write-failure',failed,historyAfterRetry:(await log.list()).length});
}
{
 const net=await Net.create();nets.push(net);const a=await net.add('alice','owner'),b=await net.add('bob','editor'),c=await net.add('carol','editor');await net.link(a,b);await net.link(b,c);const id=await a.model.createTextNow('main.tex','base');await converged([a,b,c],id);const log=track(c.model,c.store);(await a.model.openText(id)).insert(4,' by Alice');await waitFor(async()=>(await c.model.openText(id)).toString().includes('Alice'));await log.flush();out.push({case:'three-peer-attribution',actualAuthor:'alice',recorded:(await log.list()).map(s=>s.source)});
}
{
 const net=await Net.create();nets.push(net);const a=await net.add('alice','owner'),b=await net.add('bob','editor');await net.link(a,b,{latencyMs:30});const id=await a.model.createTextNow('main.tex','base');await converged([a,b],id);a.model.delete(id);(await b.model.openText(id)).insert(4,' important concurrent work');await new Promise(r=>setTimeout(r,150));out.push({case:'linked-delete-edit',visibleA:a.model.list().length,visibleB:b.model.list().length,hiddenText:(await b.model.openText(id)).toString()});
}
{
 const net=await Net.create();nets.push(net);const n=await net.add('owner','owner');await n.model.createTextNow('main.tex','original');let denied=false;const bytes=new TextEncoder().encode('original');const root:any={async getFileHandle(){return {async getFile(){if(denied)throw new DOMException('revoked','NotAllowedError');return {size:bytes.length,lastModified:1,async arrayBuffer(){return bytes.buffer}}}}}};
 const web=webFs(root);let event:any;const fs:any={list:async()=>[{path:'main.tex',size:8}],read:web.read,write:async()=>{},remove:async()=>{},watch:(cb:any)=>{event=cb;return()=>{}}};const mirror=new MirrorSync({model:n.model,mesh:n.mesh,blobs:new BlobManager(n.mesh,n.store),fs,getRole:()=>n.role,debounceMs:1});mirrors.push(mirror);await mirror.start();denied=true;event({path:'main.tex'});await new Promise(r=>setTimeout(r,100));out.push({case:'browser-permission-error',readResult:await web.read('main.tex'),visibleFiles:n.model.list().length,physicalContent:new TextDecoder().decode(bytes)});
}
{
 const net=await Net.create();nets.push(net);const n=await net.add('owner','owner');const id=await n.model.createTextNow('main.tex','original');const disk=new Map([['main.tex',new TextEncoder().encode('original')]]);const fs:any={list:async()=>[...disk].map(([path,b])=>({path,size:b.length})),read:async(p:string)=>disk.get(p)??null,write:async(p:string,b:Uint8Array)=>{disk.set(p,b)},remove:async(p:string)=>{disk.delete(p)},watch:()=>()=>{}};const mirror=new MirrorSync({model:n.model,mesh:n.mesh,blobs:new BlobManager(n.mesh,n.store),fs,getRole:()=>n.role,debounceMs:1});mirrors.push(mirror);await mirror.start();disk.set('main.tex',new TextEncoder().encode('external unsynced contribution'));n.model.delete(id);await new Promise(r=>setTimeout(r,50));out.push({case:'remote-delete-before-watcher',diskFile:disk.has('main.tex'),projectFiles:n.model.list().length});
}
for(const m of mirrors)m.stop();for(const l of logs){await l.flush().catch(()=>{});l.stop()}for(const n of nets)n.destroy();for(const m of models)await m.destroy().catch(()=>{});console.log(JSON.stringify(out,null,2));process.exit(0);

```

