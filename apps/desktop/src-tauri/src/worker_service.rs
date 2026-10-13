//! Live supervisor and bounded renderer/native dispatch for the fixed packaged sync worker.
use crate::{store::StoreState, worker::{Supervisor, SupervisorState, WorkerSpec, PROTOCOL}, worker_bridge::{Router, scoped_id}};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::{Mutex, Arc, atomic::{AtomicU64, AtomicBool, Ordering}}, time::Duration};
use tauri::{Manager, Emitter};
use tokio::sync::oneshot;

#[derive(Default)]
pub struct WorkerService {
    supervisor: Mutex<Option<Supervisor>>,
    pending: Mutex<HashMap<(u64, u64), oneshot::Sender<Result<Value, String>>>>,
    stores: Mutex<HashMap<u32, u64>>,
    projects: Mutex<HashMap<(u64, String), u32>>,
    attachments: Mutex<HashMap<String, (u32, u64)>>,
    seq: AtomicU64,
    ready: AtomicU64,
    router: Mutex<Option<Arc<Router>>>,
    network_watch: Mutex<Option<Arc<AtomicBool>>>,
}

impl WorkerService {
    /// Whether the current worker generation completed its handshake.
    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst) != 0
    }
    pub fn generation(&self) -> u64 {
        self.supervisor.lock().unwrap().as_ref().map_or(0, |s| s.generation())
    }
    /// Sends a native event to the current worker generation (no-op while none is ready).
    pub fn notify(&self, event: &str, data: Value) {
        let gen = self.ready.load(Ordering::SeqCst);
        if gen != 0 { let _ = self.send(gen, &event_frame(gen, event, data)); }
    }
    fn send(&self, gen: u64, msg: &Value) -> Result<(), String> {
        let lock = self.supervisor.lock().unwrap();
        let sup = lock.as_ref().ok_or("worker unavailable")?;
        if sup.generation() != gen { return Err("obsolete worker generation".into()); }
        sup.send(msg).map_err(|_| "worker pipe unavailable".into())
    }
    pub fn start(app: &tauri::AppHandle) -> Result<(), String> {
        let state = app.state::<Self>();
        let mut supervisor = state.supervisor.lock().unwrap();
        // Called before every renderer request: once running there is nothing to do. The integrity check below hashes
        // the whole runtime (about a second of CPU) and runs only when the worker is actually started.
        if supervisor.is_some() { return Ok(()); }
        let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
        let spec = WorkerSpec::in_resources(&resources);
        if !spec.node.is_file() || !spec.script.is_file() { return Err("packaged sync worker is missing".into()); }
        spec.verify()?;
        let (router, rx) = Router::new(0);
        *state.router.lock().unwrap() = Some(Arc::new(router));
        let a = app.clone();
        std::thread::spawn(move || while let Ok(frame) = rx.recv() {
            let gen = frame["gen"].as_u64().unwrap_or(0);
            let service = a.state::<WorkerService>();
            if let Some(r)=service.router.lock().unwrap().as_ref(){r.release(&frame);}
            let _ = service.send(gen, &frame);
            let ids = service.router.lock().unwrap().as_ref().map(|r| r.take_overflowed()).unwrap_or_default();
            if !ids.is_empty() {
                let a = a.clone();
                tauri::async_runtime::spawn(async move { for id in ids { a.state::<crate::rtc::RtcState>().close(&id).await; } });
            }
        });
        let frames_app = app.clone();
        let status_app = app.clone();
        let sup = Supervisor::start(spec, Arc::new(move |gen, frame| {
            let service = frames_app.state::<WorkerService>();
            if service.generation() != gen { return; }
            match frame["kind"].as_str() {
                Some("res") => {
                    if let Some(id) = frame["id"].as_u64() {
                        if let Some(tx) = service.pending.lock().unwrap().remove(&(gen, id)) {
                            let answer = if frame["ok"] == true { Ok(frame["result"].clone()) }
                                else { Err(frame["error"]["message"].as_str().unwrap_or("worker request failed").to_string()) };
                            let _ = tx.send(answer);
                        }
                    }
                }
                Some("evt") => {
                    if frame["event"] == "ready" { service.ready.store(gen, Ordering::SeqCst); crate::lifecycle::catalog_changed(&frames_app); }
                    if frame["event"] == "catalog.change" { crate::lifecycle::catalog_changed(&frames_app); }
                    let _ = frames_app.emit("worker://event", frame);
                }
                Some("req") => {
                    let a = frames_app.clone();
                    tauri::async_runtime::spawn(async move {
                        let params = &frame["params"];
                        let cmd = params["cmd"].as_str().unwrap_or("");
                        let result = if frame["method"] == "native.call" {
                            dispatch(&a, gen, cmd, params["args"].clone(), params["project"].as_str().unwrap_or("")).await
                        } else { Err("unknown native method".into()) };
                        let response = match result {
                            Ok(v) => json!({"v":PROTOCOL,"gen":gen,"kind":"res","id":frame["id"],"ok":true,"result":v}),
                            Err(e) => {
                                // The worker shows this to the user: name the operation and its reason (native messages
                                // carry no secrets), and keep it in the diagnostics log.
                                let message = native_failure(cmd, &e);
                                log_native_failure(&a, &message);
                                json!({"v":PROTOCOL,"gen":gen,"kind":"res","id":frame["id"],"ok":false,"error":{"code":"native_error","message":message}})
                            }
                        };
                        let _ = a.state::<WorkerService>().send(gen, &response);
                    });
                }
                _ => {}
            }
        }), Arc::new(move |status| {
            let a = status_app.clone();
            if let SupervisorState::Exited { code, gen } = status {
                for (_, tx) in a.state::<WorkerService>().pending.lock().unwrap().drain() {
                    let _ = tx.send(Err(format!("sync worker exited (code {code:?})")));
                }
                let service = a.state::<WorkerService>();
                service.ready.compare_exchange(gen, 0, Ordering::SeqCst, Ordering::SeqCst).ok();
                if let Some(router) = service.router.lock().unwrap().as_ref() { router.advance(gen + 1); }
                let ids: Vec<_> = service.stores.lock().unwrap().iter().filter_map(|(&id, &owner)| (owner <= gen).then_some(id)).collect();
                service.projects.lock().unwrap().retain(|(owner,_),_| *owner > gen);
                service.attachments.lock().unwrap().retain(|_,(_,owner)| *owner > gen);
                for id in ids { service.stores.lock().unwrap().remove(&id); a.state::<StoreState>().close(id); }
                let app = a.clone();
                tauri::async_runtime::spawn(async move { crate::worker_bridge::close_stale(&app.state::<crate::rtc::RtcState>(), gen + 1).await; });
            }
            if let SupervisorState::Starting { gen } = status {
                a.state::<WorkerService>().ready.store(0, Ordering::SeqCst);
                let service = a.state::<WorkerService>();
                if let Some(r) = service.router.lock().unwrap().as_ref() { r.advance(gen); }
                for (_, tx) in service.pending.lock().unwrap().drain() { let _ = tx.send(Err("worker restarted".into())); }
                let stale: Vec<u32> = service.stores.lock().unwrap().iter().filter_map(|(&id, &g)| (g < gen).then_some(id)).collect();
                for id in stale { service.stores.lock().unwrap().remove(&id); a.state::<StoreState>().close(id); }
                service.attachments.lock().unwrap().retain(|_,(_,g)| *g>=gen);
                service.projects.lock().unwrap().retain(|(g,_),_| *g>=gen);
                let a2 = a.clone();
                tauri::async_runtime::spawn(async move { crate::worker_bridge::close_stale(&a2.state::<crate::rtc::RtcState>(), gen).await; });
                // A new worker generation states its own demand; mapping of the previous one is removed meanwhile.
                let upnp = a.state::<crate::portmap::UpnpState>();
                upnp.wanted.store(false, Ordering::SeqCst);
                if let Some(m) = upnp.existing() { tauri::async_runtime::spawn(async move { m.disable().await }); }
            }
            let _ = a.emit("worker://state", format!("{status:?}"));
        }), 1.0);
        *supervisor = Some(sup);
        let handle = app.clone();
        *state.network_watch.lock().unwrap() = Some(crate::network::watch(Arc::new(move |change| {
            // New connections negotiate on a listener (and mapping) of the new network only.
            handle.state::<crate::rtc::RtcState>().transport.advance(change.generation);
            // An active mapping belongs to the old network: remap for the new listener (the old one is removed).
            let upnp = handle.state::<crate::portmap::UpnpState>();
            if let (Some(mapper), true) = (upnp.existing(), upnp.wanted.load(Ordering::SeqCst)) {
                tauri::async_runtime::spawn(async move { mapper.enable() });
            }
            let service = handle.state::<WorkerService>();
            service.notify("native.resume", json!(change));
        })));
        Ok(())
    }
    pub async fn request(&self, method: String, params: String) -> Result<Value, String> {
        if !renderer_method(&method) { return Err("unknown worker method".into()); }
        self.call(method, params).await
    }
    /// A request from native code (tray, quit): any worker method, encoded parameters.
    pub async fn call(&self, method: String, params: String) -> Result<Value, String> {
        let gen = self.generation();
        let id = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.len() >= 128 { return Err("worker request queue full".into()); }
            pending.insert((gen, id), tx);
        }
        if let Err(e) = self.send(gen, &json!({"v":PROTOCOL,"gen":gen,"kind":"req","id":id,"method":method,"params":params})) {
            self.pending.lock().unwrap().remove(&(gen, id)); return Err(e);
        }
        let answer = tokio::time::timeout(Duration::from_secs(120), rx).await;
        self.pending.lock().unwrap().remove(&(gen, id));
        match answer {
            Ok(Ok(value)) => value,
            _ => { let _ = self.send(gen, &json!({"v":PROTOCOL,"gen":gen,"kind":"cancel","id":id})); Err("worker request interrupted".into()) }
        }
    }
    pub fn stop(&self) {
        if let Some(watch) = self.network_watch.lock().unwrap().take() { watch.store(true, Ordering::SeqCst); }
        if let Some(s) = self.supervisor.lock().unwrap().as_ref() { s.stop(); }
    }
}

fn renderer_method(m: &str) -> bool {
    if matches!(m, "blob.has" | "blob.held" | "blob.begin" | "blob.chunk" | "blob.commit" | "blob.abort" | "project.recovery") { return true; }
    if m == "catalog.pause" || m == "account.freeze" { return true; }
    matches!(m, "catalog.activate" | "catalog.list" | "catalog.select" | "catalog.settings" | "project.open" | "project.detach" | "account.stop" | "project.status" | "project.pause" | "project.sync" | "project.probe" | "project.refresh" | "project.flush" | "doc.attach" | "doc.edit" | "project.command" | "conflict.text" | "conflict.file" | "project.history" | "project.snapshots" | "project.snapshot" | "project.docs" | "blob.read" | "blob.add" | "project.meta" | "project.metaSet" | "project.merge" | "project.folderConflict" | "project.presence" | "mesh.app" | "mesh.reconcile" | "mesh.openDoc")
}

#[tauri::command]
pub fn worker_diagnostics(state: tauri::State<'_, WorkerService>) -> Value {
    json!({ "generation": state.generation(), "ready": state.is_ready(),
        "pendingRequests": state.pending.lock().unwrap().len(),
        "stores": state.stores.lock().unwrap().len(), "attachments": state.attachments.lock().unwrap().len(),
        "rtcEventQueueBytes": state.router.lock().unwrap().as_ref().map_or(0, |router| router.queued_bytes()) })
}

#[tauri::command]
pub async fn worker_request(app: tauri::AppHandle, method: String, params: String) -> Result<Value, String> {
    if params.len() > crate::worker::MAX_FRAME - 1024 { return Err("worker request too large".into()); }
    if (method == "account.stop" || method == "account.freeze") && app.state::<WorkerService>().supervisor.lock().unwrap().is_none() { return Ok(json!("null")); }
    WorkerService::start(&app)?;
    let mut ready = false;
    for _ in 0..100 {
        let service = app.state::<WorkerService>();
        if service.ready.load(Ordering::SeqCst) != 0 && service.ready.load(Ordering::SeqCst) == service.generation() { ready = true; break; }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if !ready { return Err("worker not ready".into()); }
    if method == "doc.edit" {
        // Custody precedes pipe delivery. A worker dying before application leaves a durable ingress row.
        let edit: Value = serde_json::from_str(&params).map_err(|_| "invalid edit")?;
        let attachment = arg::<String>(&edit, "attachment")?;
        let service = app.state::<WorkerService>();
        let gen = service.generation();
        let (store, owner) = *service.attachments.lock().unwrap().get(&attachment).ok_or("attachment closed")?;
        if owner != gen { return Err("obsolete attachment".into()); }
        let seq = arg::<i64>(&edit,"seq")?;
        if seq<1{return Err("invalid edit sequence".into());}
        crate::store_cmd::store_ingress_put(app.state(), store, attachment, seq, arg(&edit,"docId")?, arg(&edit["update"],"$u8")?, arg(&edit,"source")?)?;
    }
    app.state::<WorkerService>().request(method, params).await
}

fn arg<T: serde::de::DeserializeOwned>(a: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(a[key].clone()).map_err(|_| format!("invalid parameter {key}"))
}

async fn dispatch(app: &tauri::AppHandle, gen: u64, cmd: &str, a: Value, project: &str) -> Result<Value, String> {
    let service = app.state::<WorkerService>();
    if service.generation() != gen { return Err("obsolete generation".into()); }
    if cmd == "catalog_load" || cmd == "catalog_save" {
        let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
        if cmd == "catalog_load" { return serde_json::to_value(crate::catalog::load(&root)?).map_err(|_| "encode catalog".into()); }
        crate::catalog::save(&root, a["value"].clone())?;
        return Ok(Value::Null);
    }
    if cmd == "upnp_set" || cmd == "upnp_status" {
        let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let upnp = app.state::<crate::portmap::UpnpState>();
        let mapper = upnp.mapper(&app.state::<crate::rtc::RtcState>().transport, &root);
        if cmd == "upnp_set" {
            upnp.set(mapper, a["enabled"].as_bool() == Some(true)).await;
            return Ok(Value::Null);
        }
        return serde_json::to_value(mapper.status()).map_err(|e| e.to_string());
    }
    if cmd == "storage_status" {
        let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let (free, retained) = crate::store::storage_status(&root);
        return Ok(json!({ "free": free, "retained": retained }));
    }
    if cmd == "secret_get" || cmd == "secret_set" {
        let key = arg::<String>(&a, "key")?;
        if !key.starts_with("session-token:") && key != "github-tokens" && !key.starts_with("device:") { return Err("unknown secret".into()); }
        if cmd == "secret_set" { crate::secrets::set(&key, &arg::<String>(&a, "value")?)?; return Ok(Value::Null); }
        return serde_json::to_value(crate::secrets::get(&key)?).map_err(|_| "encode secret reply".into());
    }
    if cmd.starts_with("rtc_") {
        let owner = service.projects.lock().unwrap().get(&(gen, project.to_string())).copied().ok_or("project stopped")?;
        let original = arg::<String>(&a, "id")?;
        let id = scoped_id(gen, project, &original)?;
        let rtc = app.state::<crate::rtc::RtcState>();
        let router = service.router.lock().unwrap().clone().ok_or("router not ready")?;
        let output = router.emitter(id.clone());
        let event_project = project.to_string();
        let event_app = app.clone();
        let name = format!("rtc://{original}");
        let emit: crate::rtc::Emit = Arc::new(move |_, payload| {
            let service = event_app.state::<WorkerService>();
            if service.projects.lock().unwrap().get(&(gen, event_project.clone())) == Some(&owner) {
                output(name.clone(), json!({"project":event_project,"name":name,"payload":payload}));
            }
        });
        let result = match cmd {
            "rtc_create" => { rtc.create_with(&id, arg(&a, "ice")?, emit, true).await?; Value::Null },
            "rtc_create_data_channel" => { rtc.create_data_channel(&id, &arg::<String>(&a, "label")?, emit).await?; Value::Null },
            "rtc_create_offer" => json!(rtc.create_offer(&id).await?),
            "rtc_create_answer" => json!(rtc.create_answer(&id).await?),
            "rtc_local_sdp" => json!(rtc.local_sdp(&id).await?),
            "rtc_set_local" => { rtc.set_local(&id, &arg::<String>(&a, "kind")?, arg(&a, "sdp")?).await?; Value::Null },
            "rtc_set_remote" => { rtc.set_remote(&id, &arg::<String>(&a, "kind")?, arg(&a, "sdp")?).await?; Value::Null },
            "rtc_add_ice" => { rtc.add_ice(&id, a["candidate"].clone()).await?; Value::Null },
            "rtc_send" => json!(rtc.send(&id, &arg::<String>(&a, "label")?, &arg::<String>(&a, "b64")?).await?),
            "rtc_stats" => rtc.stats(&id).await?,
            "rtc_close" => { rtc.close(&id).await; Value::Null },
            _ => return Err("unknown RTC method".into()),
        };
        if service.generation() != gen { rtc.close(&id).await; return Err("obsolete generation".into()); }
        finish_project_rtc(&rtc, &service.projects, gen, project, owner, &id).await?;
        return Ok(result);
    }
    if cmd == "store_open" {
        let id = crate::store_cmd::store_open(app.clone(), app.state(), arg(&a, "scope")?)?;
        if service.generation() != gen { app.state::<StoreState>().close(id); return Err("obsolete generation".into()); }
        service.stores.lock().unwrap().insert(id, gen);
        service.projects.lock().unwrap().insert((gen, project.to_string()), id);
        return Ok(json!(id));
    }
    let id = arg::<u32>(&a, "id")?;
    if service.stores.lock().unwrap().get(&id) != Some(&gen) { return Err("wrong store generation".into()); }
    if cmd == "attachment_register" {
        let attachment=arg::<String>(&a,"attachment")?;
        if attachment.is_empty() || attachment.len()>128 { return Err("invalid attachment".into()); }
        service.attachments.lock().unwrap().insert(attachment,(id,gen));
        return Ok(Value::Null);
    }
    if cmd == "attachment_unregister" {
        service.attachments.lock().unwrap().remove(&arg::<String>(&a,"attachment")?);
        return Ok(Value::Null);
    }
    match cmd {
        "store_close" => {
            // Invalidate project ownership before awaiting any native cleanup. Late RTC creation compensates itself.
            service.projects.lock().unwrap().retain(|_, owner| *owner != id);
            service.attachments.lock().unwrap().retain(|_, (store,_)| *store != id);
            crate::store_cmd::store_close(app.state(), id); service.stores.lock().unwrap().remove(&id);
            let prefix = format!("w{gen}/{project}/");
            let rtc = app.state::<crate::rtc::RtcState>();
            for id in rtc.ids().await.into_iter().filter(|id| id.starts_with(&prefix)) { rtc.close(&id).await; }
            Ok(Value::Null)
        }
        // Store operations are a closed set, using the same bounded implementation as the renderer migration.
        _ => dispatch_store(app, id, cmd, &a),
    }
}

/// Compensate RTC allocation that completed after this project was stopped/replaced within one worker generation.
async fn finish_project_rtc(rtc: &crate::rtc::RtcState, owners: &Mutex<HashMap<(u64, String), u32>>, gen: u64, project: &str, owner: u32, id: &str) -> Result<(), String> {
    let current = owners.lock().unwrap().get(&(gen, project.to_string())) == Some(&owner);
    if current { Ok(()) } else { rtc.close(id).await; Err("project stopped".into()) }
}

fn dispatch_store(app: &tauri::AppHandle, id: u32, cmd: &str, a: &Value) -> Result<Value, String> {
    macro_rules! reply { ($expr:expr) => { serde_json::to_value($expr?).map_err(|_| "encode store reply".to_string()) }; }
    use crate::store_cmd as s;
    match cmd {
        "store_transact" => reply!(s::store_transact(app.state(), id, arg(a, "ops")?)),
        "store_load" => reply!(s::store_load(app.state(), id, arg(a, "doc")?)),
        "store_list_docs" => reply!(s::store_list_docs(app.state(), id)),
        "store_put_blob" => reply!(s::store_put_blob(app.state(), id, arg(a, "hash")?, arg(a, "b64")?)),
        "store_stage_chunk" => reply!(s::store_stage_chunk(app.state(), id, arg(a, "upload")?, arg(a, "hash")?, arg(a, "size")?, arg(a, "part")?, arg(a, "b64")?)),
        "store_stage_commit" => reply!(s::store_stage_commit(app.state(), id, arg(a, "upload")?)),
        "store_stage_abort" => reply!(s::store_stage_abort(app.state(), id, arg(a, "upload")?)),
        "store_blob_size" => reply!(s::store_blob_size(app.state(), id, arg(a, "hash")?)),
        "store_read_blob" => reply!(s::store_read_blob(app.state(), id, arg(a, "hash")?, arg(a, "offset")?, arg(a, "len")?)),
        "store_list_blobs" => reply!(s::store_list_blobs(app.state(), id)),
        "store_put_snapshot" => reply!(s::store_put_snapshot(app.state(), id, arg(a, "sid")?, arg(a, "at")?, arg(a, "value")?)),
        "store_list_snapshots" => reply!(s::store_list_snapshots(app.state(), id)),
        "store_get_meta" => reply!(s::store_get_meta(app.state(), id, arg(a, "key")?)),
        "store_list_meta" => reply!(s::store_list_meta(app.state(), id)),
        "store_put_change" => reply!(s::store_put_change(app.state(), id, arg(a, "cid")?, arg(a, "endedAt")?, arg(a, "value")?)),
        "store_list_changes" => reply!(s::store_list_changes(app.state(), id)),
        "store_prune_changes" => reply!(s::store_prune_changes(app.state(), id, arg(a, "now")?)),
        "store_ingress_put" => reply!(s::store_ingress_put(app.state(), id, arg(a, "attachment")?, arg(a, "seq")?, arg(a, "doc")?, arg(a, "b64")?, arg(a,"source")?)),
        "store_ingress_ack" => reply!(s::store_ingress_ack(app.state(), id, arg(a, "attachment")?, arg(a, "seq")?)),
        "store_ingress_pending" => reply!(s::store_ingress_pending(app.state(), id)),
        "store_ingress_page" => reply!(s::store_ingress_page(app.state(), id, a["afterAttachment"].as_str().map(String::from), a["afterSeq"].as_i64())),
        "store_ingress_deny" => reply!(s::store_ingress_deny(app.state(),id,arg(a,"attachment")?,arg(a,"seq")?)),
        "store_ingress_get" => reply!(s::store_ingress_get(app.state(),id,arg(a,"attachment")?,arg(a,"seq")?)),
        _ => Err("unknown native method".into()),
    }
}

/// A worker event frame (protocol kind `evt`; anything else is a protocol error that ends the worker).
pub fn event_frame(gen: u64, event: &str, data: Value) -> Value {
    json!({ "v": PROTOCOL, "gen": gen, "kind": "evt", "event": event, "data": data })
}

/// "<operation>: <reason>", bounded, for a native call the worker made that failed.
fn native_failure(cmd: &str, reason: &str) -> String {
    let cmd: String = cmd.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(48).collect();
    let reason: String = reason.chars().map(|c| if c.is_control() { ' ' } else { c }).take(300).collect();
    format!("{} failed: {reason}", if cmd.is_empty() { "native operation" } else { &cmd })
}

/// Appends a failure to `<app data>/logs/native.log` (restarted past 1 MB), so a report can say what failed.
fn log_native_failure(app: &tauri::AppHandle, message: &str) {
    use std::io::Write;
    let Ok(dir) = app.path().app_data_dir().map(|d| d.join("logs")) else { return };
    if std::fs::create_dir_all(&dir).is_err() { return; }
    let path = dir.join("native.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > 1 << 20) { let _ = std::fs::remove_file(&path); }
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{at} {message}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_events_use_the_worker_protocol_event_kind() {
        // The worker accepts only req/res/evt/cancel; an unknown kind is a fatal protocol error (worker exit 66).
        let f = event_frame(3, "native.resume", json!({"generation": 2, "resumed": false, "online": true}));
        assert_eq!(f["kind"], "evt");
        assert_eq!((f["v"].as_u64(), f["gen"].as_u64(), f["event"].as_str()), (Some(PROTOCOL as u64), Some(3), Some("native.resume")));
    }
    #[test]
    fn native_failures_name_the_operation_and_stay_bounded() {
        assert_eq!(native_failure("store_open", "store already open"), "store_open failed: store already open");
        assert_eq!(native_failure("", "x"), "native operation failed: x");
        let long = native_failure("a\nb", &"y\n".repeat(1000));
        assert!(long.starts_with("ab failed: y y") && long.len() < 400 && !long.contains('\n'));
    }
    #[test]
    fn renderer_cannot_dispatch_native_or_unknown_calls() {
        assert!(!renderer_method("native.call"));
        assert!(!renderer_method("fs.read"));
        assert!(renderer_method("doc.edit"));
        assert!(renderer_method("account.stop"));
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn late_rtc_allocation_is_closed_without_touching_the_replacement_project() {
        let rtc = crate::rtc::RtcState::default();
        let owners = Mutex::new(HashMap::from([((1, "p".to_string()), 11)]));
        let old = scoped_id(1, "p", "old").unwrap();
        // The old allocation finishes after removal/reopen gave this project a different store handle.
        rtc.create(&old, vec![], Arc::new(|_, _| {})).await.unwrap();
        let new = scoped_id(1, "p", "new").unwrap();
        rtc.create(&new, vec![], Arc::new(|_, _| {})).await.unwrap();
        assert!(finish_project_rtc(&rtc, &owners, 1, "p", 10, &old).await.is_err());
        finish_project_rtc(&rtc, &owners, 1, "p", 11, &new).await.unwrap();
        assert_eq!(rtc.ids().await, vec![new.clone()]); rtc.close(&new).await;
    }
}
