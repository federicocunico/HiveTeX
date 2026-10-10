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
                    // A new folder: report what is already inside. A tool that creates a folder and writes a file into
                    // it right away can be faster than the watch on the new folder (inotify), and that file's own event
                    // is then never delivered.
                    if matches!(ev.kind, notify::EventKind::Create(_)) && fs::symlink_metadata(&p).is_ok_and(|m| m.is_dir()) {
                        let mut inside = Vec::new();
                        walk(&root_for_events, &p, &mut inside);
                        for f in inside {
                            on_change(f.path);
                        }
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

    /// The bound folder itself (to reveal it in the system file manager).
    pub fn root_dir(&self, id: &str) -> Result<PathBuf, String> {
        self.root(id)
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

/// The project a folder's marker (`.hivetex.json`) names, if any.
fn marker_project(dir: &Path) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(dir.join(".hivetex.json")).ok()?).ok()?;
    v.get("project")?.get("id")?.as_str().map(str::to_string)
}

/// The folder HiveTeX creates for a project kept in the app, at the member's request: `<documents>/HiveTeX/<slug>`.
/// An existing folder is used only when it is empty or already this project's (its marker); otherwise `<slug>-2`,
/// `-3`, … The slug is reduced to `[a-z0-9_-]`, so the result is always a direct child of `<documents>/HiveTeX`.
pub fn default_project_folder(documents: &Path, slug: &str, project_id: &str) -> Result<PathBuf, String> {
    let clean: String = slug.to_ascii_lowercase().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    let clean = clean.trim_matches('-');
    if clean.is_empty() || clean.len() > 64 {
        return Err("invalid project ID".into());
    }
    let root = documents.join("HiveTeX");
    fs::create_dir_all(&root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;
    for n in 1..=99 {
        let dir = root.join(if n == 1 { clean.to_string() } else { format!("{clean}-{n}") });
        match fs::symlink_metadata(&dir) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
                return Ok(dir);
            }
            Ok(m) if m.is_dir() => {
                let empty = fs::read_dir(&dir).map(|mut d| d.next().is_none()).unwrap_or(false);
                if empty || marker_project(&dir).as_deref() == Some(project_id) {
                    return Ok(dir);
                }
            }
            // a file, a symlink or an unreadable entry: never reused
            _ => {}
        }
    }
    Err(format!("no free folder name for {clean} in {}", root.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opening_or_revealing_needs_a_bound_folder_and_stays_inside_it() {
        let state = MirrorState::default();
        assert!(state.root_dir("not-bound").is_err());
        let d = tmp("reveal");
        state.bind("p", &d, |_| {}).unwrap();
        let root = state.root_dir("p").unwrap();
        assert!(resolve_inside(&root, "main.tex").is_ok());
        assert!(resolve_inside(&root, "../outside.tex").is_err());
        state.unbind("p");
        assert!(state.root_dir("p").is_err());
    }

    #[test]
    fn default_folder_is_created_reused_only_when_empty_or_ours_and_otherwise_numbered() {
        let docs = tmp("docs");
        let root = docs.join("HiveTeX");
        // fresh
        let a = default_project_folder(&docs, "thesis-2026", "p1").unwrap();
        assert_eq!(a, root.join("thesis-2026"));
        assert!(a.is_dir());
        // empty: reused
        assert_eq!(default_project_folder(&docs, "thesis-2026", "p1").unwrap(), a);
        // our own marker: reused
        fs::write(a.join(".hivetex.json"), r#"{"project":{"id":"p1","slug":"thesis-2026"}}"#).unwrap();
        fs::write(a.join("main.tex"), "x").unwrap();
        assert_eq!(default_project_folder(&docs, "thesis-2026", "p1").unwrap(), a);
        // another project's marker: next name, existing folder untouched
        let b = default_project_folder(&docs, "thesis-2026", "p2").unwrap();
        assert_eq!(b, root.join("thesis-2026-2"));
        assert_eq!(fs::read_to_string(a.join("main.tex")).unwrap(), "x");
        // unrelated files (no marker)
        let c = docs.join("HiveTeX").join("notes");
        fs::create_dir_all(&c).unwrap();
        fs::write(c.join("todo.txt"), "mine").unwrap();
        assert_eq!(default_project_folder(&docs, "notes", "p3").unwrap(), root.join("notes-2"));
        // a file with the name
        fs::write(root.join("paper"), "file").unwrap();
        assert_eq!(default_project_folder(&docs, "paper", "p4").unwrap(), root.join("paper-2"));
        // hostile slugs stay inside HiveTeX
        for (slug, want) in [("../x", "x"), ("a/b", "ab"), (r"..\..\c", "c"), ("UP", "up")] {
            let d = default_project_folder(&docs, slug, "p5").unwrap();
            assert_eq!(d.parent().unwrap(), root, "{slug}");
            assert_eq!(d.file_name().unwrap().to_string_lossy(), want, "{slug}");
        }
        assert!(default_project_folder(&docs, "../..", "p6").is_err());
        assert!(default_project_folder(&docs, "", "p6").is_err());
    }

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

    #[test]
    fn files_in_a_new_folder_are_reported_even_when_written_at_once() {
        let d = tmp("watch-dir");
        let st = MirrorState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        let tx = Mutex::new(tx);
        st.bind("p", &d, move |p| {
            let _ = tx.lock().unwrap().send(p);
        })
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        fs::create_dir_all(d.join("sections/deep")).unwrap();
        fs::write(d.join("sections/deep/related.tex"), "x").unwrap();
        let end = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut seen = Vec::new();
        while std::time::Instant::now() < end {
            if let Ok(p) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                seen.push(p);
            }
            if seen.iter().any(|p| p == "sections/deep/related.tex") {
                return;
            }
        }
        panic!("file in a new folder never reported: {seen:?}");
    }
}
