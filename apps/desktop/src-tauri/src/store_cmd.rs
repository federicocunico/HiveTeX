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
pub fn store_list_meta(state: State<'_, StoreState>, id: u32) -> Result<Vec<String>, String> {
    state.with(id, |s| s.list_meta())
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
