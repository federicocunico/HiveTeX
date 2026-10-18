//! Tauri commands of the native project store (see store.rs). Binary values travel as base64; every call is bounded
//! (one chunk at most `store::MAX_CHUNK`, one transaction at most `MAX_CALL` encoded bytes).

use crate::store::{StoreOp, StoreState, MAX_CHUNK};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Deserialize;
use tauri::{Manager, State};

/// Encoded bytes accepted in one call (a document update batch, a meta value).
const MAX_CALL: usize = 48 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum WireOp {
    Append { doc: String, updates: Vec<String> },
    Compact { doc: String, state: String },
    Meta { key: String, value: Option<String> },
}

fn decode(s: &str) -> Result<Vec<u8>, String> {
    B64.decode(s).map_err(|_| "invalid base64".to_string())
}

#[tauri::command]
pub fn store_open(app: tauri::AppHandle, state: State<'_, StoreState>, scope: String) -> Result<u32, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    state.open(&root, &scope)
}

#[tauri::command]
pub fn store_delete(app: tauri::AppHandle, state: State<'_, StoreState>, scope: String) -> Result<(), String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    state.delete(&root, &scope)
}

#[tauri::command]
pub fn store_exists(app: tauri::AppHandle, state: State<'_, StoreState>, scope: String) -> Result<bool, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    state.exists(&root, &scope)
}

#[tauri::command]
pub fn store_close(state: State<'_, StoreState>, id: u32) {
    state.close(id);
}

#[tauri::command]
pub fn store_export_open(state: State<'_, StoreState>, id: u32) -> Result<crate::store::ExportDescriptor, String> { state.export_open(id) }
#[tauri::command]
pub fn store_export_read(state: State<'_, StoreState>, id: u32, token: String, offset: u64) -> Result<String, String> {
    state.export_read(id, &token, offset).map(|bytes| B64.encode(bytes))
}
#[tauri::command]
pub fn store_export_close(state: State<'_, StoreState>, id: u32, token: String) -> Result<(), String> { state.export_close(id, &token) }

#[tauri::command]
pub fn store_transact(state: State<'_, StoreState>, id: u32, ops: Vec<WireOp>) -> Result<(), String> {
    let mut size = 0usize;
    let mut decoded = Vec::with_capacity(ops.len());
    for op in ops {
        decoded.push(match op {
            WireOp::Append { doc, updates } => {
                let mut out = Vec::with_capacity(updates.len());
                for u in updates {
                    size += u.len();
                    out.push(decode(&u)?);
                }
                StoreOp::Append { doc, updates: out }
            }
            WireOp::Compact { doc, state } => {
                size += state.len();
                StoreOp::Compact { doc, state: decode(&state)? }
            }
            WireOp::Meta { key, value } => {
                size += value.as_ref().map_or(0, |v| v.len());
                StoreOp::Meta { key, value }
            }
        });
        if size > MAX_CALL {
            return Err("transaction too large".into());
        }
    }
    state.with(id, |s| s.transact(&decoded))
}

#[tauri::command]
pub fn store_load(state: State<'_, StoreState>, id: u32, doc: String) -> Result<Vec<String>, String> {
    state.with(id, |s| s.load(&doc)).map(|v| v.iter().map(|u| B64.encode(u)).collect())
}

#[tauri::command]
pub fn store_list_docs(state: State<'_, StoreState>, id: u32) -> Result<Vec<String>, String> {
    state.with(id, |s| s.list_docs())
}

#[tauri::command]
pub fn store_put_blob(state: State<'_, StoreState>, id: u32, hash: String, b64: String) -> Result<(), String> {
    if b64.len() > MAX_CHUNK * 4 / 3 + 4 {
        return Err("blob too large for one call: stage it in chunks".into());
    }
    let bytes = decode(&b64)?;
    state.with(id, |s| s.put_blob(&hash, &bytes))
}

#[tauri::command]
pub fn store_stage_chunk(state: State<'_, StoreState>, id: u32, upload: String, hash: String, size: usize, part: u32, b64: String) -> Result<(), String> {
    let bytes = decode(&b64)?;
    state.with(id, |s| s.stage_chunk(&upload, &hash, size, part, &bytes))
}

#[tauri::command]
pub fn store_stage_commit(state: State<'_, StoreState>, id: u32, upload: String) -> Result<(), String> {
    state.with(id, |s| s.stage_commit(&upload))
}

#[tauri::command]
pub fn store_stage_abort(state: State<'_, StoreState>, id: u32, upload: String) -> Result<(), String> {
    state.with(id, |s| s.stage_abort(&upload))
}

#[tauri::command]
pub fn store_blob_size(state: State<'_, StoreState>, id: u32, hash: String) -> Result<Option<i64>, String> {
    state.with(id, |s| s.blob_size(&hash))
}

#[tauri::command]
pub fn store_read_blob(state: State<'_, StoreState>, id: u32, hash: String, offset: usize, len: usize) -> Result<Option<String>, String> {
    state.with(id, |s| s.read_blob_chunk(&hash, offset, len)).map(|o| o.map(|b| B64.encode(b)))
}

#[tauri::command]
pub fn store_list_blobs(state: State<'_, StoreState>, id: u32) -> Result<Vec<String>, String> {
    state.with(id, |s| s.list_blobs())
}

#[tauri::command]
pub fn store_put_snapshot(state: State<'_, StoreState>, id: u32, sid: String, at: i64, value: String) -> Result<(), String> {
    state.with(id, |s| s.put_snapshot(&sid, at, &value))
}

#[tauri::command]
pub fn store_list_snapshots(state: State<'_, StoreState>, id: u32) -> Result<Vec<String>, String> {
    state.with(id, |s| s.list_snapshots())
}

#[tauri::command]
pub fn store_get_meta(state: State<'_, StoreState>, id: u32, key: String) -> Result<Option<String>, String> {
    state.with(id, |s| s.get_meta(&key))
}

#[tauri::command]
pub fn store_list_meta(state: State<'_, StoreState>, id: u32, prefix: Option<String>, after: Option<String>, limit: Option<u32>) -> Result<Vec<String>, String> {
    if prefix.is_none() && after.is_none() && limit.is_none() { return state.with(id, |s| s.list_meta()); }
    state.with(id, |s| s.list_meta_page(prefix.as_deref().unwrap_or(""), after.as_deref().unwrap_or(""), limit.unwrap_or(10_000)))
}

#[tauri::command]
pub fn store_put_change(state: State<'_, StoreState>, id: u32, cid: String, ended_at: i64, value: String) -> Result<(), String> {
    state.with(id, |s| s.put_change(&cid, ended_at, &value))
}

#[tauri::command]
pub fn store_list_changes(state: State<'_, StoreState>, id: u32) -> Result<Vec<String>, String> {
    state.with(id, |s| s.list_changes())
}

#[tauri::command]
pub fn store_prune_changes(state: State<'_, StoreState>, id: u32, now: i64) -> Result<usize, String> {
    state.with(id, |s| s.prune_changes(now))
}

#[derive(serde::Serialize)]
pub struct IngressRow {
    attachment: String,
    seq: i64,
    doc: String,
    b64: String,
    source: String,
    denied: bool,
}

#[tauri::command]
pub fn store_ingress_put(state: State<'_, StoreState>, id: u32, attachment: String, seq: i64, doc: String, b64: String, source: Option<String>) -> Result<(), String> {
    let bytes = decode(&b64)?;
    state.with(id, |s| s.ingress_put_source(&attachment, seq, &doc, &bytes, source.as_deref().unwrap_or("editor")))
}

#[tauri::command]
pub fn store_ingress_ack(state: State<'_, StoreState>, id: u32, attachment: String, seq: i64) -> Result<(), String> {
    state.with(id, |s| s.ingress_ack(&attachment, seq))
}

#[tauri::command]
pub fn store_ingress_pending(state: State<'_, StoreState>, id: u32) -> Result<Vec<IngressRow>, String> {
    state
        .with(id, |s| {
            let rows = s.ingress_page("", 0)?;
            if let Some(last) = rows.last() {
                if s.ingress_has_after(&last.0, last.1)? { return Err("journal too large; use store_ingress_page".into()); }
            }
            Ok(rows)
        })
        .map(|rows| rows.into_iter().map(|(attachment, seq, doc, data, source, denied)| IngressRow { attachment, seq, doc, b64: B64.encode(data), source, denied }).collect())
}

#[tauri::command]
pub fn store_ingress_page(state: State<'_, StoreState>, id: u32, after_attachment: Option<String>, after_seq: Option<i64>) -> Result<Vec<IngressRow>, String> {
    state.with(id, |s| s.ingress_page(after_attachment.as_deref().unwrap_or(""), after_seq.unwrap_or(0)))
        .map(|rows| rows.into_iter().map(|(attachment, seq, doc, data, source, denied)| IngressRow { attachment, seq, doc, b64: B64.encode(data), source, denied }).collect())
}

#[tauri::command]
pub fn store_ingress_deny(state:State<'_,StoreState>,id:u32,attachment:String,seq:i64)->Result<(),String>{state.with(id,|s|s.ingress_deny(&attachment,seq))}

#[tauri::command]
pub fn store_ingress_get(state:State<'_,StoreState>,id:u32,attachment:String,seq:i64)->Result<Option<IngressRow>,String>{
    state.with(id,|s|s.ingress_get(&attachment,seq)).map(|row|row.map(|(attachment,seq,doc,data,source,denied)|IngressRow{attachment,seq,doc,b64:B64.encode(data),source,denied}))
}

#[tauri::command]
pub fn migration_manifest_read(app: tauri::AppHandle, project: String) -> Result<Option<String>, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::store::read_manifest(&root, &project)
}

#[tauri::command]
pub fn migration_manifest_write(app: tauri::AppHandle, project: String, json: String) -> Result<(), String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::store::write_manifest(&root, &project, &json)
}

/// Recovery archive written to a file the user picks in the native save dialog, in bounded appends (D7): the archive is
/// never assembled in webview memory. The page never names a path; it holds only a token. A `.part` file becomes the
/// chosen file on `recovery_save_finish`; an aborted or abandoned export leaves nothing at the destination.
struct SaveTarget { path: std::path::PathBuf, part: std::path::PathBuf, file: Option<std::fs::File>, written: u64 }
impl Drop for SaveTarget {
    fn drop(&mut self) { if self.file.take().is_some() { let _ = std::fs::remove_file(&self.part); } }
}
fn saves() -> &'static std::sync::Mutex<std::collections::HashMap<String, SaveTarget>> {
    static SAVES: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, SaveTarget>>> = std::sync::OnceLock::new();
    SAVES.get_or_init(Default::default)
}
/// Largest archive accepted (the ZIP format without ZIP64).
const SAVE_LIMIT: u64 = (1 << 32) - 1;

fn save_open(path: std::path::PathBuf) -> Result<String, String> {
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
    let token: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let part = std::path::PathBuf::from(format!("{}.{}.part", path.display(), &token[..8]));
    let file = std::fs::OpenOptions::new().write(true).create_new(true).open(&part).map_err(|e| e.to_string())?;
    let mut table = saves().lock().map_err(|_| "save lock poisoned")?;
    if table.len() >= 2 { return Err("too many active recovery exports".into()); }
    table.insert(token.clone(), SaveTarget { path, part, file: Some(file), written: 0 });
    Ok(token)
}

/// Asks where to save `name` (a file name only); `None` when the member cancels.
#[tauri::command]
pub async fn recovery_save_begin(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let name: String = std::path::Path::new(&name).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let name = if name.is_empty() || name.len() > 200 { "hivetex-recovery.zip".to_string() } else { name };
    #[cfg(feature = "test-picker")]
    if let Some(dir) = std::env::var_os("HIVETEX_TEST_SAVE_DIR") { return save_open(std::path::PathBuf::from(dir).join(&name)).map(Some); }
    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || handle.dialog().file().set_file_name(&name).add_filter("ZIP archive", &["zip"]).blocking_save_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(fp) = picked else { return Ok(None) };
    save_open(fp.into_path().map_err(|e| e.to_string())?).map(Some)
}

pub fn save_append(token: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut table = saves().lock().map_err(|_| "save lock poisoned")?;
    let target = table.get_mut(token).ok_or("unknown recovery export")?;
    if target.written + bytes.len() as u64 > SAVE_LIMIT { table.remove(token); return Err("recovery archive exceeds the ZIP size limit".into()); }
    let result = target.file.as_mut().ok_or("closed recovery export")?.write_all(bytes);
    if let Err(e) = result { table.remove(token); return Err(e.to_string()); }
    target.written += bytes.len() as u64;
    Ok(())
}

#[tauri::command]
pub fn recovery_save_append(token: String, b64: String) -> Result<(), String> {
    if b64.len() > MAX_CHUNK * 4 / 3 + 4 { return Err("recovery export chunk too large".into()); }
    save_append(&token, &decode(&b64)?)
}

/// Durable, then visible under the chosen name (replacing a file the member chose to overwrite).
#[tauri::command]
pub fn recovery_save_finish(token: String) -> Result<(), String> {
    let mut target = saves().lock().map_err(|_| "save lock poisoned")?.remove(&token).ok_or("unknown recovery export")?;
    let file = target.file.take().ok_or("closed recovery export")?;
    let done = file.sync_all().map_err(|e| e.to_string()).and_then(|()| { drop(file); std::fs::rename(&target.part, &target.path).map_err(|e| e.to_string()) });
    if done.is_err() { let _ = std::fs::remove_file(&target.part); }
    done
}

#[tauri::command]
pub fn recovery_save_abort(token: String) {
    if let Ok(mut table) = saves().lock() { table.remove(&token); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_saves_appear_only_when_finished_and_aborts_leave_nothing() {
        let dir = std::env::temp_dir().join(format!("hivetex-recovery-save-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("p-recovery.zip");
        let token = save_open(path.clone()).unwrap();
        save_append(&token, b"PK first").unwrap(); save_append(&token, b" second").unwrap();
        assert!(!path.exists(), "nothing at the destination before finish");
        recovery_save_finish(token.clone()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"PK first second");
        assert!(save_append(&token, b"late").is_err());
        let aborted = save_open(dir.join("aborted.zip")).unwrap();
        save_append(&aborted, b"partial").unwrap();
        recovery_save_abort(aborted);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "an aborted export leaves no file");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
