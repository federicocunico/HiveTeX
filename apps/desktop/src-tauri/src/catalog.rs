//! Fixed native catalog. Public preferences/trust only; private credentials stay in the OS keychain.
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile { pub server: String, pub account: String }
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    pub server: String, pub account: String, pub project: String, pub scope: String,
    pub role: String, pub is_local: bool, pub created_here: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bell { pub url: String, pub topic: String }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Trust { pub kid: String, pub jwk: serde_json::Map<String, serde_json::Value> }
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Retained {
    pub project: Project, pub seed_enabled: bool, pub paused: bool,
    pub doorbell: Option<Bell>, pub epoch: u64, pub trusted: Vec<Trust>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Catalog {
    pub v: u32, pub active: Option<Profile>, pub background: bool, pub paused: bool,
    pub projects: Vec<Retained>,
    /// Automatic router port mapping (UPnP); absent means on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upnp: Option<bool>,
    /// Server rollout switches last received with a ticket; absent fields mean on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollout: Option<Rollout>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rollout {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upnp: Option<bool>,
}
impl Default for Catalog {
    fn default() -> Self { Self { v: 1, active: None, background: true, paused: false, projects: Vec::new(), upnp: None, rollout: None } }
}
fn server(s: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(s) else { return false };
    (u.scheme() == "https" || (u.scheme() == "http" && matches!(u.host_str(), Some("localhost" | "127.0.0.1"))))
        && u.username().is_empty() && u.password().is_none() && u.query().is_none() && u.fragment().is_none()
}
fn validate(c: &Catalog) -> Result<(), String> {
    if c.v != 1 || c.projects.len() > 20_000 { return Err("unsupported catalog".into()); }
    if c.active.as_ref().is_some_and(|p| !server(&p.server) || p.account.is_empty() || p.account.len() > 128) { return Err("invalid active profile".into()); }
    for r in &c.projects {
        let p = &r.project;
        if !server(&p.server) || p.is_local || p.project.is_empty() || p.project.len() > 128 || p.account.is_empty()
            || p.account.len() > 128 || p.scope.len() != 64 || !p.scope.bytes().all(|b| b.is_ascii_hexdigit())
            || !matches!(p.role.as_str(), "owner" | "editor" | "viewer") || r.trusted.len() > 16 {
            return Err("invalid retained project".into());
        }
        for k in &r.trusted {
            if k.kid.len() > 128 || k.jwk.keys().any(|key| !matches!(key.as_str(), "kty" | "crv" | "x" | "y" | "n" | "e" | "alg" | "kid" | "use" | "key_ops" | "ext")) {
                return Err("only public verification keys belong in the catalog".into());
            }
        }
        if r.doorbell.as_ref().is_some_and(|b| !server(&b.url) || b.topic.len() > 256 || b.topic.is_empty()) {
            return Err("invalid ring configuration".into());
        }
    }
    Ok(())
}
fn open(root: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let conn = Connection::open(root.join("seed-catalog.sqlite3")).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS catalog(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);").map_err(|e| e.to_string())?;
    Ok(conn)
}
pub fn load(root: &Path) -> Result<Catalog, String> {
    let value: Option<String> = open(root)?.query_row("SELECT value FROM catalog WHERE id=1", [], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    let result = match value { Some(s) => serde_json::from_str(&s).map_err(|_| "invalid catalog".to_string())?, None => Catalog::default() };
    validate(&result)?;
    Ok(result)
}
pub fn save(root: &Path, value: serde_json::Value) -> Result<(), String> {
    let data = serde_json::to_vec(&value).map_err(|_| "invalid catalog")?;
    if data.len() > 4 * 1024 * 1024 { return Err("catalog too large".into()); }
    let catalog: Catalog = serde_json::from_value(value).map_err(|_| "invalid catalog fields")?;
    validate(&catalog)?;
    let mut conn = open(root)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT OR REPLACE INTO catalog(id,value) VALUES(1,?1)", [std::str::from_utf8(&data).map_err(|_| "invalid encoding")?]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn durable_catalog_rejects_credentials_and_preserves_previous_state() {
        let root = std::env::temp_dir().join(format!("hivetex-catalog-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let mut value = serde_json::to_value(Catalog::default()).unwrap();
        value["active"] = serde_json::json!({"server":"https://example.com","account":"ann"});
        save(&root, value.clone()).unwrap();
        value["token"] = "never persist this".into();
        assert!(save(&root, value).is_err());
        assert_eq!(load(&root).unwrap().active.unwrap().account, "ann");
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn accepts_every_field_the_worker_catalog_writes() {
        // The shape SeedCatalog saves (packages/sync/src/worker/catalog.ts) after a production ticket: UPnP setting,
        // rollout switches, a ring and trusted keys. Rejecting any of it made opening a project fail.
        let root = std::env::temp_dir().join(format!("hivetex-catalog-w-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let value = serde_json::json!({
            "v": 1, "active": {"server": "https://hivetex.vercel.app", "account": "a1"}, "background": true, "paused": false,
            "upnp": false, "rollout": {"background": true, "upnp": false},
            "projects": [{
                "project": {"server": "https://hivetex.vercel.app", "account": "a1", "project": "p1", "scope": "ab".repeat(32),
                    "role": "editor", "isLocal": false, "createdHere": false},
                "seedEnabled": true, "paused": false, "doorbell": {"url": "https://ntfy.sh", "topic": "t1"}, "epoch": 2,
                "trusted": [{"kid": "k1", "jwk": {"kty": "OKP", "crv": "Ed25519", "x": "AA", "alg": "EdDSA", "use": "sig", "kid": "k1"}}]
            }]
        });
        save(&root, value.clone()).unwrap();
        assert_eq!(serde_json::to_value(load(&root).unwrap()).unwrap(), value);
        let _ = std::fs::remove_dir_all(root);
    }
}
