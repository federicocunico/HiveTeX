//! Native project store (D4): one SQLite database per scoped project (server, account, project), implementing the
//! sync package's `Persistence` contract. Document/metadata transitions are single SQLite transactions (all or nothing),
//! commits are durable (WAL, `synchronous=FULL`), blobs are published only after their SHA-256 matches and large blobs
//! arrive in bounded chunks through a staging table. Values of metadata, snapshots and change sets are opaque strings
//! encoded by the JS adapter (so binary values survive); the store never interprets project content.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Largest blob (the sync layer's blob limit is 50 MiB) and largest chunk / IPC payload accepted.
pub const MAX_BLOB: usize = 50 * 1024 * 1024;
pub const MAX_CHUNK: usize = 4 * 1024 * 1024;
/// Change sets kept regardless of age, and how long all of them are kept (mirrors persistence.ts).
const CHANGES_KEEP_MIN: i64 = 500;
const CHANGES_KEEP_MS: i64 = 7 * 24 * 3600 * 1000;
const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum StoreOp {
    Append { doc: String, updates: Vec<Vec<u8>> },
    Compact { doc: String, state: Vec<u8> },
    /// `value: None` removes the key.
    Meta { key: String, value: Option<String> },
}

pub struct Store {
    conn: Connection,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn valid_hash(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn err(e: rusqlite::Error) -> String {
    e.to_string()
}

impl Store {
    pub fn open(path: &Path) -> Result<Store, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(err)?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn in_memory() -> Result<Store, String> {
        Self::init(Connection::open_in_memory().map_err(err)?)
    }

    fn init(conn: Connection) -> Result<Store, String> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             CREATE TABLE IF NOT EXISTS updates(id INTEGER PRIMARY KEY AUTOINCREMENT, doc TEXT NOT NULL, data BLOB NOT NULL);
             CREATE INDEX IF NOT EXISTS updates_doc ON updates(doc, id);
             CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS blobs(hash TEXT PRIMARY KEY, data BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS staging(id TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(id, part));
             CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, at INTEGER NOT NULL, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY, ended_at INTEGER NOT NULL, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS store_info(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS ingress(attachment TEXT NOT NULL, seq INTEGER NOT NULL, doc TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(attachment, seq));",
        )
        .map_err(err)?;
        let has_source = {
            let mut statement = conn.prepare("PRAGMA table_info(ingress)").map_err(err)?;
            let names = statement.query_map([], |row| row.get::<_, String>(1)).map_err(err)?;
            names.collect::<Result<Vec<_>, _>>().map_err(err)?.iter().any(|name| name == "source")
        };
        if !has_source { conn.execute("ALTER TABLE ingress ADD COLUMN source TEXT NOT NULL DEFAULT 'editor'", []).map_err(err)?; }
        let has_denied = {
            let mut statement=conn.prepare("PRAGMA table_info(ingress)").map_err(err)?;
            let names=statement.query_map([],|row|row.get::<_,String>(1)).map_err(err)?;
            names.collect::<Result<Vec<_>,_>>().map_err(err)?.iter().any(|name|name=="denied")
        };
        if !has_denied {conn.execute("ALTER TABLE ingress ADD COLUMN denied INTEGER NOT NULL DEFAULT 0",[]).map_err(err)?;}
        conn.execute("INSERT OR IGNORE INTO store_info(key, value) VALUES('schema', ?1)", params![SCHEMA_VERSION.to_string()]).map_err(err)?;
        // Chunks of an upload interrupted by a crash are never published; start clean.
        conn.execute("DELETE FROM staging", []).map_err(err)?;
        Ok(Store { conn })
    }

    /// All ops commit together or none does (the transaction rolls back on the first error).
    pub fn transact(&mut self, ops: &[StoreOp]) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(err)?;
        for op in ops {
            match op {
                StoreOp::Append { doc, updates } => {
                    for u in updates {
                        tx.execute("INSERT INTO updates(doc, data) VALUES(?1, ?2)", params![doc, u]).map_err(err)?;
                    }
                }
                StoreOp::Compact { doc, state } => {
                    tx.execute("DELETE FROM updates WHERE doc = ?1", params![doc]).map_err(err)?;
                    tx.execute("INSERT INTO updates(doc, data) VALUES(?1, ?2)", params![doc, state]).map_err(err)?;
                }
                StoreOp::Meta { key, value } => match value {
                    Some(v) => {
                        tx.execute("INSERT INTO meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, v]).map_err(err)?;
                    }
                    None => {
                        tx.execute("DELETE FROM meta WHERE key = ?1", params![key]).map_err(err)?;
                    }
                },
            }
        }
        tx.commit().map_err(err)
    }

    pub fn load(&self, doc: &str) -> Result<Vec<Vec<u8>>, String> {
        let mut st = self.conn.prepare_cached("SELECT data FROM updates WHERE doc = ?1 ORDER BY id").map_err(err)?;
        let rows = st.query_map(params![doc], |r| r.get::<_, Vec<u8>>(0)).map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }

    pub fn list_docs(&self) -> Result<Vec<String>, String> {
        let mut st = self.conn.prepare_cached("SELECT DISTINCT doc FROM updates ORDER BY doc").map_err(err)?;
        let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }

    /// Stores a blob only if its content hashes to `hash`.
    pub fn put_blob(&self, hash: &str, bytes: &[u8]) -> Result<(), String> {
        if !valid_hash(hash) || bytes.len() > MAX_BLOB {
            return Err("invalid blob".into());
        }
        if hex(&Sha256::digest(bytes)) != hash {
            return Err("blob content does not match its hash".into());
        }
        self.conn.execute("INSERT OR IGNORE INTO blobs(hash, data) VALUES(?1, ?2)", params![hash, bytes]).map_err(err)?;
        Ok(())
    }

    pub fn get_blob(&self, hash: &str) -> Result<Option<Vec<u8>>, String> {
        self.conn.query_row("SELECT data FROM blobs WHERE hash = ?1", params![hash], |r| r.get(0)).optional().map_err(err)
    }

    /// The blob's size, without reading it (for chunked reads by the adapter).
    pub fn blob_size(&self, hash: &str) -> Result<Option<i64>, String> {
        self.conn.query_row("SELECT length(data) FROM blobs WHERE hash = ?1", params![hash], |r| r.get(0)).optional().map_err(err)
    }

    pub fn read_blob_chunk(&self, hash: &str, offset: usize, len: usize) -> Result<Option<Vec<u8>>, String> {
        let len = len.min(MAX_CHUNK);
        self.conn
            .query_row("SELECT substr(data, ?2, ?3) FROM blobs WHERE hash = ?1", params![hash, offset as i64 + 1, len as i64], |r| r.get(0))
            .optional()
            .map_err(err)
    }

    pub fn list_blobs(&self) -> Result<Vec<String>, String> {
        let mut st = self.conn.prepare_cached("SELECT hash FROM blobs ORDER BY hash").map_err(err)?;
        let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }

    /// One chunk of a large blob upload. Chunks are kept in staging until `stage_commit` verifies the whole blob.
    pub fn stage_chunk(&self, id: &str, hash: &str, size: usize, part: u32, bytes: &[u8]) -> Result<(), String> {
        if !valid_hash(hash) || size > MAX_BLOB || bytes.len() > MAX_CHUNK || id.is_empty() || id.len() > 64 {
            return Err("invalid blob chunk".into());
        }
        let staged: i64 = self.conn.query_row("SELECT coalesce(sum(length(data)), 0) FROM staging WHERE id = ?1", params![id], |r| r.get(0)).map_err(err)?;
        if staged as usize + bytes.len() > size {
            self.stage_abort(id)?;
            return Err("blob chunks exceed the declared size".into());
        }
        self.conn
            .execute("INSERT OR REPLACE INTO staging(id, hash, size, part, data) VALUES(?1, ?2, ?3, ?4, ?5)", params![id, hash, size as i64, part, bytes])
            .map_err(err)?;
        Ok(())
    }

    /// Assembles the staged chunks, verifies size and hash, and publishes the blob atomically; staging is cleared either way.
    pub fn stage_commit(&mut self, id: &str) -> Result<(), String> {
        let (hash, size): (String, i64) = match self
            .conn
            .query_row("SELECT hash, size FROM staging WHERE id = ?1 LIMIT 1", params![id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(err)?
        {
            Some(v) => v,
            None => return Err("nothing staged".into()),
        };
        let mut data = Vec::with_capacity(size as usize);
        {
            let mut st = self.conn.prepare("SELECT data FROM staging WHERE id = ?1 ORDER BY part").map_err(err)?;
            let rows = st.query_map(params![id], |r| r.get::<_, Vec<u8>>(0)).map_err(err)?;
            for row in rows {
                data.extend_from_slice(&row.map_err(err)?);
            }
        }
        let result = if data.len() as i64 != size {
            Err("staged blob is incomplete".to_string())
        } else {
            self.put_blob(&hash, &data)
        };
        self.stage_abort(id)?;
        result
    }

    pub fn stage_abort(&self, id: &str) -> Result<(), String> {
        self.conn.execute("DELETE FROM staging WHERE id = ?1", params![id]).map_err(err)?;
        Ok(())
    }

    pub fn put_snapshot(&self, id: &str, at: i64, value: &str) -> Result<(), String> {
        self.conn
            .execute("INSERT INTO snapshots(id, at, value) VALUES(?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET at = excluded.at, value = excluded.value", params![id, at, value])
            .map_err(err)?;
        Ok(())
    }

    pub fn list_snapshots(&self) -> Result<Vec<String>, String> {
        let mut st = self.conn.prepare_cached("SELECT value FROM snapshots ORDER BY at, id").map_err(err)?;
        let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<String>, String> {
        self.conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get(0)).optional().map_err(err)
    }

    pub fn list_meta(&self) -> Result<Vec<String>, String> {
        let mut st = self.conn.prepare_cached("SELECT key FROM meta ORDER BY key").map_err(err)?;
        let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }

    pub fn put_change(&self, id: &str, ended_at: i64, value: &str) -> Result<(), String> {
        self.conn
            .execute("INSERT INTO changes(id, ended_at, value) VALUES(?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, value = excluded.value", params![id, ended_at, value])
            .map_err(err)?;
        Ok(())
    }

    /// Newest first.
    pub fn list_changes(&self) -> Result<Vec<String>, String> {
        let mut st = self.conn.prepare_cached("SELECT value FROM changes ORDER BY ended_at DESC, id").map_err(err)?;
        let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }

    /// Keeps everything from the last 7 days and at least the newest 500; returns how many were removed.
    pub fn prune_changes(&self, now: i64) -> Result<usize, String> {
        self.conn
            .execute(
                "DELETE FROM changes WHERE ended_at < ?1 AND id NOT IN (SELECT id FROM changes ORDER BY ended_at DESC LIMIT ?2)",
                params![now - CHANGES_KEEP_MS, CHANGES_KEEP_MIN],
            )
            .map_err(err)
    }
}

impl Store {
    /// Editor edits not yet durable in the replica (D3 ingress journal). Idempotent on (attachment, seq); durable on return.
    pub fn ingress_put(&self, attachment: &str, seq: i64, doc: &str, data: &[u8]) -> Result<(), String> {
        self.ingress_put_source(attachment, seq, doc, data, "editor")
    }
    pub fn ingress_put_source(&self, attachment: &str, seq: i64, doc: &str, data: &[u8], source: &str) -> Result<(), String> {
        if attachment.is_empty() || attachment.len() > 128 || doc.len() > 200 || seq < 1 || seq > 9_007_199_254_740_991 || data.len() > MAX_CHUNK {
            return Err("invalid ingress entry".into());
        }
        if source != "editor" && source != "folder" { return Err("invalid edit source".into()); }
        self.conn
            .execute("INSERT OR IGNORE INTO ingress(attachment, seq, doc, data, source) VALUES(?1, ?2, ?3, ?4, ?5)", params![attachment, seq, doc, data, source])
            .map_err(err)?;
        Ok(())
    }
    pub fn ingress_ack(&self, attachment: &str, seq: i64) -> Result<(), String> {
        self.conn.execute("DELETE FROM ingress WHERE attachment = ?1 AND seq <= ?2 AND denied = 0", params![attachment, seq]).map_err(err)?;
        Ok(())
    }
    pub fn ingress_pending(&self) -> Result<Vec<(String, i64, String, Vec<u8>)>, String> {
        let mut st = self.conn.prepare("SELECT attachment, seq, doc, data FROM ingress ORDER BY attachment, seq").map_err(err)?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }
    pub fn ingress_pending_source(&self) -> Result<Vec<(String, i64, String, Vec<u8>, String, bool)>, String> {
        let mut st = self.conn.prepare("SELECT attachment, seq, doc, data, source, denied FROM ingress ORDER BY attachment, seq").map_err(err)?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))).map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }
    /// Keyset pagination remains correct when replay acknowledges earlier rows. No whole-journal IPC reply.
    pub fn ingress_page(&self, after_attachment: &str, after_seq: i64) -> Result<Vec<(String, i64, String, Vec<u8>, String, bool)>, String> {
        if after_attachment.len() > 128 || after_seq < 0 { return Err("invalid journal cursor".into()); }
        let mut st = self.conn.prepare("SELECT attachment, seq, doc, data, source, denied FROM ingress WHERE attachment > ?1 OR (attachment = ?1 AND seq > ?2) ORDER BY attachment, seq LIMIT 65").map_err(err)?;
        let mut rows = st.query(params![after_attachment, after_seq]).map_err(err)?;
        let mut out = Vec::new();
        let mut bytes = 0;
        while let Some(row) = rows.next().map_err(err)? {
            let data: Vec<u8> = row.get(3).map_err(err)?;
            if !out.is_empty() && (out.len() >= 64 || bytes + data.len() > 3 * 1024 * 1024) { break; }
            bytes += data.len();
            out.push((row.get(0).map_err(err)?, row.get(1).map_err(err)?, row.get(2).map_err(err)?, data, row.get(4).map_err(err)?, row.get(5).map_err(err)?));
        }
        Ok(out)
    }
    pub fn ingress_has_after(&self, attachment: &str, seq: i64) -> Result<bool, String> {
        self.conn.query_row("SELECT EXISTS(SELECT 1 FROM ingress WHERE attachment > ?1 OR (attachment = ?1 AND seq > ?2))", params![attachment, seq], |r| r.get(0)).map_err(err)
    }
    pub fn ingress_deny(&self,attachment:&str,seq:i64)->Result<(),String>{
        self.conn.execute("UPDATE ingress SET denied = 1 WHERE attachment = ?1 AND seq = ?2",params![attachment,seq]).map_err(err)?;Ok(())
    }
    pub fn ingress_get(&self,attachment:&str,seq:i64)->Result<Option<(String,i64,String,Vec<u8>,String,bool)>,String>{
        use rusqlite::OptionalExtension;
        self.conn.query_row("SELECT attachment,seq,doc,data,source,denied FROM ingress WHERE attachment = ?1 AND seq = ?2",params![attachment,seq],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(err)
    }
}

/// Open stores by handle. Each scoped project has at most one open handle in this process (one writer).
#[derive(Default)]
pub struct StoreState {
    inner: Mutex<StoreTable>,
}
#[derive(Default)]
struct StoreTable {
    next: u32,
    open: HashMap<u32, (String, Store)>,
}

/// Scopes are derived by the client from (server, account, project): 64 lowercase hex characters, or `local-` plus a
/// local project id. Nothing else can name a file.
pub fn scope_path(root: &Path, scope: &str) -> Result<PathBuf, String> {
    let ok = valid_hash(scope)
        || (scope.starts_with("local-") && scope.len() <= 70 && scope[6..].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    if !ok {
        return Err("invalid store scope".into());
    }
    Ok(root.join("stores").join(format!("{scope}.sqlite3")))
}

impl StoreState {
    pub fn open(&self, root: &Path, scope: &str) -> Result<u32, String> {
        let path = scope_path(root, scope)?;
        let mut t = self.inner.lock().map_err(|_| "store lock poisoned")?;
        if t.open.values().any(|(s, _)| s == scope) {
            return Err("store already open".into());
        }
        let store = Store::open(&path)?;
        t.next += 1;
        let id = t.next;
        t.open.insert(id, (scope.to_string(), store));
        Ok(id)
    }
    /// Deletes a scope's database (and its WAL/SHM files). Refused while the store is open: one writer, no surprises.
    pub fn delete(&self, root: &Path, scope: &str) -> Result<(), String> {
        let path = scope_path(root, scope)?;
        let t = self.inner.lock().map_err(|_| "store lock poisoned")?;
        if t.open.values().any(|(s, _)| s == scope) {
            return Err("store is open".into());
        }
        for suffix in ["", "-wal", "-shm"] {
            let f = PathBuf::from(format!("{}{suffix}", path.display()));
            match std::fs::remove_file(&f) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(())
    }
    pub fn exists(&self, root: &Path, scope: &str) -> Result<bool, String> {
        Ok(scope_path(root, scope)?.exists())
    }
    pub fn close(&self, id: u32) {
        if let Ok(mut t) = self.inner.lock() {
            t.open.remove(&id);
        }
    }
    pub fn with<T>(&self, id: u32, f: impl FnOnce(&mut Store) -> Result<T, String>) -> Result<T, String> {
        let mut t = self.inner.lock().map_err(|_| "store lock poisoned")?;
        let (_, store) = t.open.get_mut(&id).ok_or("unknown store handle")?;
        f(store)
    }
}

/// Free bytes on the volume holding the stores (None when it cannot be determined) and the bytes the stores occupy,
/// for the background transfer budget (D8): downloads wait instead of filling the disk or evicting anything.
pub fn storage_status(root: &Path) -> (Option<u64>, u64) {
    let dir = root.join("stores");
    let mut used = 0u64;
    let mut stack = vec![dir.clone()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                match e.metadata() {
                    Ok(m) if m.is_dir() => stack.push(e.path()),
                    Ok(m) => used += m.len(),
                    Err(_) => {}
                }
            }
        }
    }
    let target = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let free = disks
        .list()
        .iter()
        .filter(|d| target.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space());
    (free, used)
}

/// Migration manifests (5.4): one JSON file per project, replaced atomically (temporary file, fsync, rename) so a crash
/// leaves either the previous or the new manifest, never a torn one.
pub fn manifest_path(root: &Path, project: &str) -> Result<PathBuf, String> {
    if project.is_empty() || project.len() > 128 || !project.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("invalid project id".into());
    }
    Ok(root.join("stores").join("migrations").join(format!("{project}.json")))
}

pub fn read_manifest(root: &Path, project: &str) -> Result<Option<String>, String> {
    match std::fs::read_to_string(manifest_path(root, project)?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn write_manifest(root: &Path, project: &str, json: &str) -> Result<(), String> {
    use std::io::Write;
    if json.len() > 4 * 1024 * 1024 || serde_json::from_str::<serde_json::Value>(json).is_err() {
        return Err("invalid manifest".into());
    }
    let path = manifest_path(root, project)?;
    let dir = path.parent().ok_or("no manifest directory")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".{project}.json.tmp"));
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denied_ingress_and_original_source_survive_later_acknowledgements() {
        let s=Store::in_memory().unwrap();
        s.ingress_put_source("a",1,"f:a",&[1],"folder").unwrap();s.ingress_deny("a",1).unwrap();
        s.ingress_put_source("a",1,"f:other",&[9],"editor").unwrap();
        s.ingress_put("a",2,"f:a",&[2]).unwrap();s.ingress_ack("a",2).unwrap();
        let row=s.ingress_get("a",1).unwrap().unwrap();
        assert_eq!(row.2,"f:a");assert_eq!(row.3,vec![1]);assert_eq!(row.4,"folder");assert!(row.5);
        assert_eq!(s.ingress_pending().unwrap().len(),1);
    }

    fn sha(b: &[u8]) -> String {
        hex(&Sha256::digest(b))
    }

    #[test]
    fn appends_loads_and_compacts_per_document() {
        let mut s = Store::in_memory().unwrap();
        s.transact(&[StoreOp::Append { doc: "a".into(), updates: vec![vec![1], vec![2]] }, StoreOp::Append { doc: "b".into(), updates: vec![vec![9]] }]).unwrap();
        s.transact(&[StoreOp::Append { doc: "a".into(), updates: vec![vec![3]] }]).unwrap();
        assert_eq!(s.load("a").unwrap(), vec![vec![1], vec![2], vec![3]]);
        assert_eq!(s.list_docs().unwrap(), vec!["a".to_string(), "b".to_string()]);
        s.transact(&[StoreOp::Compact { doc: "a".into(), state: vec![7, 7] }]).unwrap();
        assert_eq!(s.load("a").unwrap(), vec![vec![7, 7]]);
        assert_eq!(s.load("b").unwrap(), vec![vec![9]]);
    }

    #[test]
    fn a_failing_transaction_changes_nothing() {
        let mut s = Store::in_memory().unwrap();
        s.transact(&[StoreOp::Append { doc: "a".into(), updates: vec![vec![1]] }, StoreOp::Meta { key: "k".into(), value: Some("v1".into()) }]).unwrap();
        // Make the second statement fail inside the transaction: a trigger rejecting meta writes.
        s.conn.execute_batch("CREATE TRIGGER no_meta BEFORE INSERT ON meta BEGIN SELECT RAISE(ABORT, 'refused'); END;").unwrap();
        let r = s.transact(&[StoreOp::Compact { doc: "a".into(), state: vec![5] }, StoreOp::Meta { key: "k2".into(), value: Some("x".into()) }]);
        assert!(r.is_err());
        assert_eq!(s.load("a").unwrap(), vec![vec![1]], "the compaction rolled back too");
        assert_eq!(s.get_meta("k").unwrap().as_deref(), Some("v1"));
    }

    #[test]
    fn sqlite_full_preserves_committed_data_and_ingress_across_reopen_then_recovers() {
        let dir = std::env::temp_dir().join(format!("hivetex-full-test-{}", std::process::id()));
        let path = dir.join("project.sqlite3");
        let mut s = Store::open(&path).unwrap();
        s.transact(&[StoreOp::Append { doc: "a".into(), updates: vec![vec![1]] }, StoreOp::Meta { key: "checkpoint".into(), value: Some("before".into()) }]).unwrap();
        s.ingress_put("editor", 1, "a", &[2]).unwrap();
        let pages: i64 = s.conn.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
        s.conn.execute_batch(&format!("PRAGMA max_page_count={pages}")).unwrap();
        let failure = s.transact(&[StoreOp::Meta { key: "checkpoint".into(), value: Some("after".into()) }, StoreOp::Append { doc: "a".into(), updates: vec![vec![9; 1024 * 1024]] }]).unwrap_err();
        assert!(failure.contains("full"), "expected SQLITE_FULL, got {failure}");
        assert_eq!(s.load("a").unwrap(), vec![vec![1]]);
        assert_eq!(s.get_meta("checkpoint").unwrap().as_deref(), Some("before"));
        drop(s);
        let mut reopened = Store::open(&path).unwrap();
        assert_eq!(reopened.load("a").unwrap(), vec![vec![1]]);
        assert_eq!(reopened.ingress_pending().unwrap().len(), 1, "unacknowledged input is durable");
        reopened.conn.execute_batch("PRAGMA max_page_count=1073741823").unwrap();
        reopened.transact(&[StoreOp::Append { doc: "a".into(), updates: vec![vec![2]] }]).unwrap();
        reopened.ingress_ack("editor", 1).unwrap();
        assert_eq!(reopened.load("a").unwrap(), vec![vec![1], vec![2]]);
        assert!(reopened.ingress_pending().unwrap().is_empty());
        drop(reopened);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn meta_set_replace_and_remove() {
        let mut s = Store::in_memory().unwrap();
        s.transact(&[StoreOp::Meta { key: "k".into(), value: Some("1".into()) }]).unwrap();
        s.transact(&[StoreOp::Meta { key: "k".into(), value: Some("2".into()) }]).unwrap();
        assert_eq!(s.get_meta("k").unwrap().as_deref(), Some("2"));
        s.transact(&[StoreOp::Meta { key: "k".into(), value: None }]).unwrap();
        assert_eq!(s.get_meta("k").unwrap(), None);
    }

    #[test]
    fn blobs_are_published_only_with_a_matching_hash() {
        let s = Store::in_memory().unwrap();
        let data = b"image bytes".to_vec();
        assert!(s.put_blob(&sha(b"other"), &data).is_err());
        assert!(s.put_blob("not-a-hash", &data).is_err());
        assert_eq!(s.list_blobs().unwrap(), Vec::<String>::new());
        s.put_blob(&sha(&data), &data).unwrap();
        s.put_blob(&sha(&data), &data).unwrap(); // idempotent
        assert_eq!(s.get_blob(&sha(&data)).unwrap(), Some(data.clone()));
        assert_eq!(s.blob_size(&sha(&data)).unwrap(), Some(data.len() as i64));
        assert_eq!(s.read_blob_chunk(&sha(&data), 6, 100).unwrap(), Some(b"bytes".to_vec()));
    }

    #[test]
    fn staged_uploads_verify_the_whole_blob_and_never_publish_partial_or_wrong_content() {
        let mut s = Store::in_memory().unwrap();
        let data: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8).collect();
        let h = sha(&data);
        s.stage_chunk("u1", &h, data.len(), 0, &data[..4000]).unwrap();
        s.stage_chunk("u1", &h, data.len(), 1, &data[4000..]).unwrap();
        s.stage_commit("u1").unwrap();
        assert_eq!(s.get_blob(&h).unwrap(), Some(data.clone()));
        // incomplete
        s.stage_chunk("u2", &sha(b"x"), 10, 0, b"12345").unwrap();
        assert!(s.stage_commit("u2").is_err());
        // wrong content for the declared hash
        s.stage_chunk("u3", &sha(b"expected"), 8, 0, b"tampered").unwrap();
        assert!(s.stage_commit("u3").is_err());
        assert_eq!(s.list_blobs().unwrap(), vec![h]);
        // more bytes than declared
        assert!(s.stage_chunk("u4", &sha(b"ab"), 2, 0, b"abc").is_err());
        let staged: i64 = s.conn.query_row("SELECT count(*) FROM staging", [], |r| r.get(0)).unwrap();
        assert_eq!(staged, 0);
    }

    #[test]
    fn change_sets_are_pruned_like_the_js_stores() {
        let s = Store::in_memory().unwrap();
        let now = 100 * CHANGES_KEEP_MS;
        for i in 0..600 {
            s.put_change(&format!("old{i:03}"), now - 2 * CHANGES_KEEP_MS - i, "{}").unwrap();
        }
        s.put_change("recent", now - 1000, "{}").unwrap();
        assert_eq!(s.prune_changes(now).unwrap(), 101); // 601 kept as the newest 500 + recent is one of them
        assert_eq!(s.list_changes().unwrap().len(), 500);
    }

    #[test]
    fn ingress_journal_is_idempotent_ordered_and_acknowledged_per_attachment() {
        let s = Store::in_memory().unwrap();
        s.ingress_put("att1", 2, "f:a", &[2]).unwrap();
        s.ingress_put("att1", 1, "f:a", &[1]).unwrap();
        s.ingress_put("att1", 1, "f:a", &[9]).unwrap(); // redelivery keeps the first copy
        s.ingress_put("att2", 1, "root", &[7]).unwrap();
        let p = s.ingress_pending().unwrap();
        assert_eq!(p.iter().map(|e| (e.0.as_str(), e.1, e.3.clone())).collect::<Vec<_>>(), vec![("att1", 1, vec![1]), ("att1", 2, vec![2]), ("att2", 1, vec![7])]);
        s.ingress_ack("att1", 1).unwrap();
        assert_eq!(s.ingress_pending().unwrap().len(), 2);
        s.ingress_ack("att1", 5).unwrap();
        assert_eq!(s.ingress_pending().unwrap().iter().map(|e| e.0.as_str()).collect::<Vec<_>>(), vec!["att2"]);
    }

    #[test]
    fn ingress_pages_bound_bytes_and_keep_the_cursor_valid_while_replay_removes_rows() {
        let s = Store::in_memory().unwrap();
        for seq in 1..=12 { s.ingress_put("a", seq, "f:a", &vec![1; 1024 * 1024]).unwrap(); }
        s.ingress_deny("a", 2).unwrap();
        let first = s.ingress_page("", 0).unwrap();
        assert_eq!(first.len(), 3);
        assert!(first[1].5);
        s.ingress_ack("a", 3).unwrap(); // row 2 is denied and survives, but must not be read a second time
        let mut cursor = ("a".to_string(), 3);
        let mut seen = Vec::new();
        loop {
            let page = s.ingress_page(&cursor.0, cursor.1).unwrap();
            if page.is_empty() { break; }
            assert!(page.iter().map(|r| r.3.len()).sum::<usize>() <= 3 * 1024 * 1024);
            for row in page { seen.push(row.1); cursor = (row.0, row.1); }
        }
        assert_eq!(seen, (4..=12).collect::<Vec<_>>());
        assert_eq!(s.ingress_get("a", 2).unwrap().unwrap().3.len(), 1024 * 1024);
    }

    #[test]
    fn manifests_are_replaced_atomically_and_validated() {
        let dir = std::env::temp_dir().join(format!("hivetex-manifest-test-{}", std::process::id()));
        assert_eq!(read_manifest(&dir, "p1").unwrap(), None);
        write_manifest(&dir, "p1", r#"{"state":"copying"}"#).unwrap();
        write_manifest(&dir, "p1", r#"{"state":"done"}"#).unwrap();
        assert_eq!(read_manifest(&dir, "p1").unwrap().as_deref(), Some(r#"{"state":"done"}"#));
        assert!(write_manifest(&dir, "p1", "not json").is_err());
        assert_eq!(read_manifest(&dir, "p1").unwrap().as_deref(), Some(r#"{"state":"done"}"#), "a rejected write keeps the old one");
        assert!(write_manifest(&dir, "../x", "{}").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn storage_status_reports_free_space_and_store_bytes() {
        let dir = std::env::temp_dir().join(format!("hivetex-storage-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("stores").join("migrations")).unwrap();
        std::fs::write(dir.join("stores").join("a.sqlite3"), vec![0u8; 1000]).unwrap();
        std::fs::write(dir.join("stores").join("migrations").join("a.json"), b"{}").unwrap();
        let (free, used) = storage_status(&dir);
        assert_eq!(used, 1002);
        assert!(free.unwrap_or(1) > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scopes_cannot_name_arbitrary_files() {
        let root = Path::new("/data");
        assert!(scope_path(root, &"a".repeat(64)).is_ok());
        assert!(scope_path(root, "local-proj_1").is_ok());
        for bad in ["../x", "local-../../etc", "", "ABC", "local-a/b"] {
            assert!(scope_path(root, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn data_survives_reopening_and_one_handle_per_scope() {
        let dir = std::env::temp_dir().join(format!("hivetex-store-test-{}", std::process::id()));
        let state = StoreState::default();
        let scope = "b".repeat(64);
        let id = state.open(&dir, &scope).unwrap();
        assert!(state.open(&dir, &scope).is_err(), "a second writer is refused");
        state.with(id, |s| s.transact(&[StoreOp::Append { doc: "d".into(), updates: vec![vec![4, 2]] }])).unwrap();
        state.close(id);
        let id2 = state.open(&dir, &scope).unwrap();
        assert_eq!(state.with(id2, |s| s.load("d")).unwrap(), vec![vec![4, 2]]);
        assert!(state.delete(&dir, &scope).is_err(), "an open store cannot be deleted");
        state.close(id2);
        assert!(state.exists(&dir, &scope).unwrap());
        state.delete(&dir, &scope).unwrap();
        assert!(!state.exists(&dir, &scope).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
