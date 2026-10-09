//! Confined file access for the "local folder mirror": the frontend can only touch files under folders the
//! user explicitly bound (chosen through the OS folder dialog), never arbitrary paths.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

pub struct Root {
    pub dir: PathBuf,
    _watcher: Option<RecommendedWatcher>,
}

#[derive(Default)]
pub struct MirrorState {
    roots: Mutex<HashMap<String, Root>>,
}

/// Folders the user chose in the native folder dialog on this device, persisted so a remembered folder can be
/// re-bound on the next start. These are the only folders the webview may ask to mirror or import: a path that
/// merely comes from page script (XSS, a compromised dependency) is refused.
pub struct PickedFolders {
    file: PathBuf,
    set: Mutex<Vec<PathBuf>>,
}

impl PickedFolders {
    pub fn load(file: PathBuf) -> Self {
        let set = fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
            .unwrap_or_default()
            .into_iter()
            .map(PathBuf::from)
            .collect();
        PickedFolders { file, set: Mutex::new(set) }
    }

    /// Records a folder the user just picked; returns its canonical path.
    pub fn add(&self, dir: &Path) -> Result<PathBuf, String> {
        let canon = dir.canonicalize().map_err(|e| format!("cannot open folder: {e}"))?;
        if !canon.is_dir() {
            return Err("not a folder".into());
        }
        let mut set = self.set.lock().unwrap();
        if !set.contains(&canon) {
            set.push(canon.clone());
            if let Some(parent) = self.file.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let list: Vec<String> = set.iter().map(|p| p.to_string_lossy().to_string()).collect();
            fs::write(&self.file, serde_json::to_string(&list).unwrap_or_default()).map_err(|e| e.to_string())?;
        }
        Ok(canon)
    }

    /// True only for a folder previously picked in the dialog (compared canonically, exact folder only).
    pub fn contains(&self, dir: &Path) -> bool {
        match dir.canonicalize() {
            Ok(c) => self.set.lock().unwrap().contains(&c),
            Err(_) => false,
        }
    }
}

#[derive(Serialize, Clone)]
pub struct Listed {
    pub path: String,
    pub size: u64,
}

fn skip_component(name: &str) -> bool {
    matches!(name, ".git" | "node_modules" | "target")
}

pub fn rel_posix(root: &Path, p: &Path) -> Option<String> {
    let rel = p.strip_prefix(root).ok()?;
    let parts: Vec<String> = rel.components().filter_map(|c| match c {
        Component::Normal(s) => Some(s.to_string_lossy().to_string()),
        _ => None,
    }).collect();
    if parts.is_empty() || parts.iter().any(|s| skip_component(s)) {
        return None;
    }
    Some(parts.join("/"))
}

/// Resolves a relative POSIX path inside the root, refusing traversal and symlinks that leave the root.
pub fn resolve_inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() || rel.contains('\0') || rel.starts_with('/') || rel.contains('\\') && cfg!(not(windows)) {
        return Err("invalid path".into());
    }
    let mut out = root.to_path_buf();
    for part in rel.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains(':') {
            return Err("invalid path".into());
        }
        out.push(part);
    }
    // Check the deepest existing ancestor: it must still live under the (canonical) root.
    let mut probe = out.clone();
    while !probe.exists() {
        if !probe.pop() {
            break;
        }
    }
    let canon = probe.canonicalize().map_err(|e| e.to_string())?;
    let root_canon = root.canonicalize().map_err(|e| e.to_string())?;
    if !canon.starts_with(&root_canon) {
        return Err("path escapes the bound folder".into());
    }
    Ok(out)
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<Listed>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if skip_component(&name) {
            continue;
        }
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue; // never follow links out of the folder
        }
        if ft.is_dir() {
            walk(root, &p, out);
        } else if ft.is_file() {
            if let (Some(rel), Ok(md)) = (rel_posix(root, &p), e.metadata()) {
                out.push(Listed { path: rel, size: md.len() });
            }
        }
    }
}

impl MirrorState {
    pub fn bind(&self, id: &str, dir: &Path, on_change: impl Fn(String) + Send + 'static) -> Result<(), String> {
        let canon = dir.canonicalize().map_err(|e| format!("cannot open folder: {e}"))?;
        if !canon.is_dir() {
            return Err("not a folder".into());
        }
        let root_for_events = canon.clone();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                for p in ev.paths {
                    if let Some(rel) = rel_posix(&root_for_events, &p) {
                        on_change(rel);
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;
        watcher.watch(&canon, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
        self.roots.lock().unwrap().insert(id.to_string(), Root { dir: canon, _watcher: Some(watcher) });
        Ok(())
    }

    pub fn unbind(&self, id: &str) {
        self.roots.lock().unwrap().remove(id);
    }

    fn root(&self, id: &str) -> Result<PathBuf, String> {
        self.roots.lock().unwrap().get(id).map(|r| r.dir.clone()).ok_or_else(|| "folder is not bound".to_string())
    }

    pub fn list(&self, id: &str) -> Result<Vec<Listed>, String> {
        let root = self.root(id)?;
        let mut out = Vec::new();
        walk(&root, &root, &mut out);
        Ok(out)
    }

    pub fn read(&self, id: &str, rel: &str) -> Result<Option<String>, String> {
        let p = resolve_inside(&self.root(id)?, rel)?;
        match fs::read(&p) {
            Ok(b) => Ok(Some(B64.encode(b))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn write(&self, id: &str, rel: &str, b64: &str) -> Result<(), String> {
        let p = resolve_inside(&self.root(id)?, rel)?;
        let bytes = B64.decode(b64).map_err(|e| e.to_string())?;
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp = p.with_extension("p2p-tmp");
        fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
        for attempt in 0..6 {
            match fs::rename(&tmp, &p) {
                Ok(()) => return Ok(()),
                Err(_) if attempt < 5 => std::thread::sleep(std::time::Duration::from_millis(15 * (attempt + 1))),
                Err(_) => {
                    fs::write(&p, &bytes).map_err(|e| e.to_string())?;
                    let _ = fs::remove_file(&tmp);
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    pub fn remove(&self, id: &str, rel: &str) -> Result<(), String> {
        let p = resolve_inside(&self.root(id)?, rel)?;
        match fs::remove_file(&p) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("p2p-mirror-rs-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        let d = tmp("trav");
        let c = d.canonicalize().unwrap();
        assert!(resolve_inside(&c, "a/b.tex").is_ok());
        assert!(resolve_inside(&c, "../x").is_err());
        assert!(resolve_inside(&c, "a/../../x").is_err());
        assert!(resolve_inside(&c, "/etc/passwd").is_err());
        assert!(resolve_inside(&c, "C:evil").is_err());
        assert!(resolve_inside(&c, "").is_err());
    }

    #[test]
    fn only_picked_folders_are_allowed_and_the_list_persists() {
        let store = tmp("picked-store").join("picked.json");
        let picked = tmp("picked-a");
        let other = tmp("picked-b");
        let p = PickedFolders::load(store.clone());
        assert!(!p.contains(&picked));
        p.add(&picked).unwrap();
        assert!(p.contains(&picked));
        fs::create_dir_all(picked.join("sub")).unwrap();
        // the same folder spelled differently is still recognised; others are not, nor are subfolders
        assert!(p.contains(&picked.join("sub").join("..")));
        assert!(!p.contains(&other));
        assert!(!p.contains(&picked.join("sub")));
        assert!(!p.contains(Path::new("/definitely/not/here")));
        // survives a restart
        assert!(PickedFolders::load(store).contains(&picked));
    }

    #[test]
    fn read_write_list_remove_roundtrip() {
        let d = tmp("rw");
        let st = MirrorState::default();
        st.bind("p", &d, |_| {}).unwrap();
        st.write("p", "sections/a.tex", &B64.encode("hi")).unwrap();
        assert_eq!(B64.decode(st.read("p", "sections/a.tex").unwrap().unwrap()).unwrap(), b"hi");
        assert!(st.read("p", "missing.tex").unwrap().is_none());
        fs::create_dir_all(d.join(".git")).unwrap();
        fs::write(d.join(".git/config"), "x").unwrap();
        let listed = st.list("p").unwrap();
        assert_eq!(listed.iter().map(|l| l.path.as_str()).collect::<Vec<_>>(), vec!["sections/a.tex"]);
        st.remove("p", "sections/a.tex").unwrap();
        assert!(st.read("p", "sections/a.tex").unwrap().is_none());
        assert!(st.read("unbound", "a").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_that_escape() {
        let d = tmp("link");
        let outside = tmp("outside");
        fs::write(outside.join("secret.txt"), "s").unwrap();
        std::os::unix::fs::symlink(&outside, d.join("evil")).unwrap();
        let st = MirrorState::default();
        st.bind("p", &d, |_| {}).unwrap();
        assert!(st.read("p", "evil/secret.txt").is_err());
        assert!(st.list("p").unwrap().is_empty());
    }

    #[test]
    fn watcher_reports_changes() {
        let d = tmp("watch");
        let st = MirrorState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        let tx = Mutex::new(tx);
        st.bind("p", &d, move |p| {
            let _ = tx.lock().unwrap().send(p);
        })
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        fs::write(d.join("new.tex"), "x").unwrap();
        let got = rx.recv_timeout(std::time::Duration::from_secs(5)).expect("no event");
        assert_eq!(got, "new.tex");
    }
}
