//! Disk cache for the built-in (in-browser) TeX compiler on desktop. The compiler's worker fetches each TeX file from
//! `texcache://localhost/<path>`; this module serves it from `<app data>/texcache/<path>`, downloading it once from the
//! configured package server (HTTPS only) when missing. Files the server reports missing are remembered for an hour.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use sha2::{Digest, Sha256};

pub const DEFAULT_UPSTREAM: &str = "https://texlive2.swiftlatex.com/";
const NEGATIVE_TTL: Duration = Duration::from_secs(3600);

pub struct TexCache {
    root: PathBuf,
    upstream: Mutex<String>,
    client: reqwest::Client,
}

#[derive(serde::Serialize, Clone)]
pub struct Stats {
    pub files: u64,
    pub bytes: u64,
}

pub enum Lookup {
    Hit(Vec<u8>),
    Missing,
}

/// Validates a request path (`pdftex/10/article.cls`): relative, plain segments only, so it can never leave the cache.
pub fn safe_rel(path: &str) -> Option<PathBuf> {
    let path = path.trim_start_matches('/');
    let segs: Vec<&str> = path.split('/').collect();
    if path.is_empty() || segs.len() > 8 {
        return None;
    }
    let ok = |s: &str| !s.is_empty() && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c));
    if !segs.iter().all(|s| ok(s)) {
        return None;
    }
    Some(segs.iter().collect())
}

/// Upstream must be an `https://` origin (or `http://localhost` for development); always ends with `/`.
pub fn normalize_upstream(url: &str) -> Result<String, String> {
    let u = url.trim();
    let local = u.starts_with("http://localhost") || u.starts_with("http://127.0.0.1");
    if !(u.starts_with("https://") || local) || u.contains(char::is_whitespace) {
        return Err("The TeX package server must use https://".into());
    }
    Ok(if u.ends_with('/') { u.to_string() } else { format!("{u}/") })
}

impl TexCache {
    pub fn new(root: PathBuf) -> Self {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(60)).build().unwrap_or_default();
        Self { root, upstream: Mutex::new(DEFAULT_UPSTREAM.into()), client }
    }

    pub fn set_upstream(&self, url: &str) -> Result<(), String> {
        *self.upstream.lock().unwrap() = normalize_upstream(url)?;
        Ok(())
    }

    fn distribution_root(&self, upstream: &str) -> PathBuf {
        self.root.join(format!("v2-{:x}", Sha256::digest(upstream.as_bytes())))
    }

    fn missing_marker(file: &Path) -> PathBuf {
        let mut m = file.as_os_str().to_owned();
        m.push(".missing");
        PathBuf::from(m)
    }

    /// Serves `rel` from disk, else downloads it once. `Ok(Missing)` = the server does not have it.
    pub async fn get(&self, rel: &Path) -> Result<Lookup, String> {
        let _active = crate::maintenance::COMPILER_ACTIVITY.try_read().map_err(|_| "Compiler maintenance is active".to_string())?;
        // Snapshot the endpoint together with its cache identity before awaiting network I/O.
        // Old unversioned resources remain recoverable, but never enter a different distribution.
        let upstream = self.upstream.lock().unwrap().clone();
        let file = self.distribution_root(&upstream).join(rel);
        if let Ok(b) = std::fs::read(&file) {
            return Ok(Lookup::Hit(b));
        }
        let marker = Self::missing_marker(&file);
        if let Ok(meta) = std::fs::metadata(&marker) {
            let fresh = meta.modified().ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|age| age < NEGATIVE_TTL);
            if fresh {
                return Ok(Lookup::Missing);
            }
        }
        let url = format!("{}{}", upstream, rel.to_string_lossy().replace('\\', "/"));
        let res = self.client.get(&url).send().await.map_err(|e| e.to_string())?;
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        match res.status().as_u16() {
            200 => {
                let bytes = res.bytes().await.map_err(|e| e.to_string())?.to_vec();
                let tmp = file.with_extension(format!("tmp{}", std::process::id()));
                std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
                std::fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(&marker);
                Ok(Lookup::Hit(bytes))
            }
            404 => {
                let _ = std::fs::write(&marker, b"");
                Ok(Lookup::Missing)
            }
            s => Err(format!("package server answered {s}")),
        }
    }

    /// Whether `rel` is already on disk (no download needed).
    pub fn stats_contains(&self, rel: &Path) -> bool {
        self.distribution_root(&self.upstream.lock().unwrap()).join(rel).is_file()
    }

    pub fn stats(&self) -> Stats {
        fn walk(d: &Path, s: &mut Stats) {
            let Ok(rd) = std::fs::read_dir(d) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, s);
                } else if let Ok(m) = e.metadata() {
                    if !p.to_string_lossy().ends_with(".missing") {
                        s.files += 1;
                        s.bytes += m.len();
                    }
                }
            }
        }
        let mut s = Stats { files: 0, bytes: 0 };
        walk(&self.root, &mut s);
        s
    }

    pub fn clear(&self) -> Result<(), String> {
        self.clear_guarded(&crate::maintenance::COMPILER_ACTIVITY)
    }

    /// Tests pass a lock of their own: compile tests running in parallel hold the shared one.
    fn clear_guarded(&self, activity: &tokio::sync::RwLock<()>) -> Result<(), String> {
        let _exclusive = activity.try_write().map_err(|_| "Compiler activity is in progress; wait for it to finish.".to_string())?;
        crate::maintenance::remove_owned_tree(&self.root)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Minimal HTTP server: `/pdftex/hit.sty` -> 200, anything else -> 404; counts requests.
    fn server() -> (String, Arc<AtomicUsize>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("http://127.0.0.1:{}/", l.local_addr().unwrap().port());
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        std::thread::spawn(move || {
            for s in l.incoming() {
                let Ok(mut s) = s else { continue };
                let mut buf = [0u8; 2048];
                let n = s.read(&mut buf).unwrap_or(0);
                h.fetch_add(1, Ordering::SeqCst);
                let req = String::from_utf8_lossy(&buf[..n]);
                let resp = if req.starts_with("GET /pdftex/hit.sty") {
                    "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nHELLO"
                } else {
                    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                };
                let _ = s.write_all(resp.as_bytes());
            }
        });
        (addr, hits)
    }

    fn cache(name: &str) -> TexCache {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let dir = std::env::temp_dir().join(format!("hivetex-texcache-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        TexCache::new(dir)
    }

    #[test]
    fn paths_cannot_leave_the_cache() {
        assert!(safe_rel("pdftex/10/article.cls").is_some());
        for bad in ["", "../x", "pdftex/../../x", "pdftex//x", "C:\\x", "pdftex/a b", "a/b/c/d/e/f/g/h/i"] {
            assert!(safe_rel(bad).is_none(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn upstream_must_be_https() {
        assert_eq!(normalize_upstream("https://tex.example.org").unwrap(), "https://tex.example.org/");
        assert!(normalize_upstream("http://tex.example.org").is_err());
        assert!(normalize_upstream("ftp://x").is_err());
        assert!(normalize_upstream("http://localhost:8080").is_ok());
    }

    #[tokio::test]
    async fn downloads_once_then_serves_from_disk_and_remembers_missing_files() {
        let (upstream, hits) = server();
        let c = cache("main");
        c.set_upstream(&upstream).unwrap();
        let hit = safe_rel("pdftex/hit.sty").unwrap();
        assert!(matches!(c.get(&hit).await.unwrap(), Lookup::Hit(b) if b == b"HELLO"));
        assert!(matches!(c.get(&hit).await.unwrap(), Lookup::Hit(_)));
        assert_eq!(hits.load(Ordering::SeqCst), 1, "second read comes from disk");
        let missing = safe_rel("pdftex/nope.sty").unwrap();
        assert!(matches!(c.get(&missing).await.unwrap(), Lookup::Missing));
        assert!(matches!(c.get(&missing).await.unwrap(), Lookup::Missing));
        assert_eq!(hits.load(Ordering::SeqCst), 2, "a missing file is not requested again within the hour");
        assert_eq!(c.stats().files, 1);
        c.clear_guarded(&tokio::sync::RwLock::new(())).unwrap();
        assert_eq!(c.stats().files, 0);
    }

    #[tokio::test]
    async fn switching_distributions_never_reuses_incompatible_resources_or_removes_the_old_cache() {
        let (first, first_hits) = server();
        let (second, second_hits) = server();
        let c = cache("distribution-isolation");
        let path = safe_rel("pdftex/hit.sty").unwrap();
        c.set_upstream(&first).unwrap();
        assert!(matches!(c.get(&path).await.unwrap(), Lookup::Hit(_)));
        c.set_upstream(&second).unwrap();
        assert!(!c.stats_contains(&path));
        assert!(matches!(c.get(&path).await.unwrap(), Lookup::Hit(_)));
        assert_eq!(second_hits.load(Ordering::SeqCst), 1);
        c.set_upstream(&first).unwrap();
        assert!(c.stats_contains(&path));
        assert!(matches!(c.get(&path).await.unwrap(), Lookup::Hit(_)));
        assert_eq!(first_hits.load(Ordering::SeqCst), 1);
        c.clear_guarded(&tokio::sync::RwLock::new(())).unwrap();
    }
}
