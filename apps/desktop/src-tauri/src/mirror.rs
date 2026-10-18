//! Confined file access for the "local folder mirror": the frontend can only touch files under folders the
//! user explicitly bound (chosen through the OS folder dialog), never arbitrary paths.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
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
    matches!(name, ".git" | "node_modules" | "target" | ".hivetex-recovery")
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

fn walk(root: &Path, dir: &Path, out: &mut Vec<Listed>) -> Result<(), String> {
    let rd = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for item in rd {
        let e = item.map_err(|e| e.to_string())?;
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if skip_component(&name) {
            continue;
        }
        let ft = e.file_type().map_err(|e| e.to_string())?;
        if ft.is_symlink() {
            continue; // never follow links out of the folder
        }
        if ft.is_dir() {
            walk(root, &p, out)?;
        } else if ft.is_file() {
            if let Some(rel) = rel_posix(root, &p) {
                let md = e.metadata().map_err(|e| e.to_string())?;
                out.push(Listed { path: rel, size: md.len() });
            }
        }
    }
    Ok(())
}

/// Test-only faults: publication failing after the retain, an external atomic-save racing it, and filesystems without
/// exclusive rename flags or hard links (FAT, exFAT, some network drives).
#[cfg(test)]
mod fault {
    use std::cell::Cell;
    pub const PUBLISH: u8 = 1;
    pub const RACE: u8 = 2;
    pub const NO_FLAGS: u8 = 4;
    pub const NO_LINK: u8 = 8;
    thread_local!(pub static ON: Cell<u8> = const { Cell::new(0) });
    pub fn on(bit: u8) -> bool { ON.with(|c| c.get() & bit != 0) }
    pub fn set(bits: u8) { ON.with(|c| c.set(bits)) }
}

#[cfg(windows)]
fn os_rename_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let wide = |p: &Path| p.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    let (f, t) = (wide(from), wide(to));
    // No MOVEFILE_REPLACE_EXISTING: an existing target fails with ERROR_ALREADY_EXISTS (FAT and exFAT included).
    if unsafe { MoveFileExW(f.as_ptr(), t.as_ptr(), 0) } != 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn os_rename_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let f = std::ffi::CString::new(from.as_os_str().as_bytes())?;
    let t = std::ffi::CString::new(to.as_os_str().as_bytes())?;
    // The raw syscall needs no glibc 2.28 wrapper; renamex_np is the macOS equivalent.
    #[cfg(target_os = "linux")]
    let r = unsafe { libc::syscall(libc::SYS_renameat2, libc::AT_FDCWD, f.as_ptr(), libc::AT_FDCWD, t.as_ptr(), libc::RENAME_NOREPLACE) } as i32;
    #[cfg(target_os = "macos")]
    let r = unsafe { libc::renamex_np(f.as_ptr(), t.as_ptr(), libc::RENAME_EXCL) };
    if r == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn os_rename_noreplace(_: &Path, _: &Path) -> std::io::Result<()> {
    Err(std::io::ErrorKind::Unsupported.into())
}

/// The filesystem or kernel lacks the exclusive flag (Linux EINVAL/ENOSYS, macOS ENOTSUP, SMB servers on Windows).
fn flag_unsupported(e: &std::io::Error) -> bool {
    let code = e.raw_os_error();
    #[cfg(unix)]
    let os = code.is_some_and(|c| [libc::EINVAL, libc::ENOSYS, libc::ENOTSUP, libc::EOPNOTSUPP].contains(&c));
    #[cfg(windows)]
    let os = matches!(code, Some(1 | 50)); // ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED
    #[cfg(not(any(unix, windows)))]
    let os = code.is_none();
    os || e.kind() == std::io::ErrorKind::Unsupported
}

/// Moves `from` to `to` only while `to` is absent, so an external atomic-save that already filled `to` is never replaced.
/// Without an exclusive rename: a hard link, then an exclusive copy with fsync (not atomic for readers, see folders.md).
fn rename_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if fault::on(fault::PUBLISH) && from.to_string_lossy().ends_with(".p2p-tmp") {
        return Err(std::io::Error::other("injected publication failure"));
    }
    #[cfg(test)]
    let os = if fault::on(fault::NO_FLAGS) { Err(std::io::ErrorKind::Unsupported.into()) } else { os_rename_noreplace(from, to) };
    #[cfg(not(test))]
    let os = os_rename_noreplace(from, to);
    match os {
        Err(e) if flag_unsupported(&e) => (),
        r => return r,
    }
    #[cfg(test)]
    let link = if fault::on(fault::NO_LINK) { Err(std::io::ErrorKind::PermissionDenied.into()) } else { fs::hard_link(from, to) };
    #[cfg(not(test))]
    let link = fs::hard_link(from, to);
    match link {
        Ok(()) => { let _ = fs::remove_file(from); return Ok(()); }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Err(e),
        Err(_) => (),
    }
    let mut src = fs::File::open(from)?;
    let mut dst = fs::OpenOptions::new().write(true).create_new(true).open(to)?;
    if let Err(e) = std::io::copy(&mut src, &mut dst).and_then(|_| dst.sync_all()) {
        drop(dst);
        let _ = fs::remove_file(to); // our own partial file: create_new made it
        return Err(e);
    }
    drop(src);
    let _ = fs::remove_file(from);
    Ok(())
}

/// Atomically retain the original inode, including writes through an external handle racing our last read.
/// The copy is transient: the mirror compares it with what it last wrote or read, captures differing bytes into the
/// device's Recovery and then drops it (`MirrorState::drop_retained`). It is never synchronized.
fn retain_file(p: &Path) -> Result<Option<PathBuf>, String> {
    match fs::symlink_metadata(p) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => return Err("Refusing to replace a directory or symlink".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
        _ => (),
    }
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
    let suffix: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let name = p.file_name().ok_or("invalid target file name")?.to_string_lossy();
    let dir = p.parent().ok_or("invalid parent")?.join(".hivetex-recovery");
    let backup = dir.join(format!("{name}.{suffix}.retained"));
    // Twice: an emptied recovery directory may be removed by drop_retained between creating it and the rename.
    for _ in 0..2 {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        if fs::symlink_metadata(&dir).map_err(|e| e.to_string())?.file_type().is_symlink() { return Err("Recovery directory must not be a symlink".into()); }
        match fs::rename(p, &backup) {
            Ok(()) => return Ok(Some(backup)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && fs::symlink_metadata(p).is_ok() => continue,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("the recovery directory kept disappearing".into())
}

/// Prepare a unique complete file, retain the previous inode and publish without replacing a racing writer. A failed
/// publication puts the previous file back with the same exclusive rename, and a failed rollback is reported: the path
/// is never left empty silently. Returns the transient retained copy.
fn atomic_replace(p: &Path, bytes: &[u8]) -> Result<Option<PathBuf>, String> {
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
    let suffix: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let name = p.file_name().ok_or("invalid target file name")?.to_string_lossy();
    let tmp = p.with_file_name(format!("{name}.{suffix}.p2p-tmp"));
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        let backup = retain_file(p)?;
        #[cfg(test)]
        if fault::on(fault::RACE) { fs::write(p, b"external atomic save").map_err(|e| e.to_string())?; }
        if let Err(error) = rename_noreplace(&tmp, p) {
            let Some(backup) = backup else { return Err(error.to_string()) };
            return match rename_noreplace(&backup, p) {
                Ok(()) => Err(error.to_string()),
                // AlreadyExists: an external save filled the path; the previous bytes stay in the recovery copy.
                Err(e) => Err(format!("{error}; the previous file was kept in {} ({e})", backup.display())),
            };
        }
        Ok(backup)
    })();
    let _ = fs::remove_file(&tmp);
    result
}

/// Relative POSIX path of a retained copy, as `retained()` lists it.
fn rel_any(root: &Path, p: &Path) -> Result<String, String> {
    Ok(p.strip_prefix(root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/"))
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
                    // Directories are never reported: reading one is not a file read failure (no retry loop).
                    let is_dir = fs::symlink_metadata(&p).is_ok_and(|m| m.is_dir());
                    if !is_dir {
                        if let Some(rel) = rel_posix(&root_for_events, &p) {
                            on_change(rel);
                        }
                    }
                    // A new or renamed folder: report what is already inside. A tool that creates a folder and writes a
                    // file into it right away can be faster than the watch on the new folder (inotify), and that file's
                    // own event is then never delivered.
                    if is_dir && rel_posix(&root_for_events, &p).is_some() && matches!(ev.kind, notify::EventKind::Create(_) | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))) {
                        let mut inside = Vec::new();
                        if let Err(error) = walk(&root_for_events, &p, &mut inside) {
                            on_change(format!("\0error:{error}"));
                        } else {
                            for f in inside {
                                on_change(f.path);
                            }
                        }
                    }
                }
            } else if let Err(error) = res {
                on_change(format!("\0error:{error}"));
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
        walk(&root, &root, &mut out)?;
        Ok(out)
    }

    pub fn retained(&self, id: &str) -> Result<Vec<Listed>, String> {
        fn visit(root: &Path, dir: &Path, private: bool, out: &mut Vec<Listed>) -> Result<(), String> {
            for item in fs::read_dir(dir).map_err(|e| e.to_string())? {
                let entry = item.map_err(|e| e.to_string())?;
                let name = entry.file_name().to_string_lossy().to_string();
                if skip_component(&name) && name != ".hivetex-recovery" { continue; }
                let kind = entry.file_type().map_err(|e| e.to_string())?;
                if kind.is_symlink() { continue; }
                let path = entry.path();
                if kind.is_dir() { visit(root, &path, private || name == ".hivetex-recovery", out)?; }
                else if private && kind.is_file() {
                    out.push(Listed { path: path.strip_prefix(root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/"), size: entry.metadata().map_err(|e| e.to_string())?.len() });
                }
            }
            Ok(())
        }
        let root = self.root(id)?;
        let mut out = Vec::new(); visit(&root, &root, false, &mut out)?; Ok(out)
    }

    pub fn read(&self, id: &str, rel: &str) -> Result<Option<String>, String> {
        let p = resolve_inside(&self.root(id)?, rel)?;
        match fs::read(&p) {
            Ok(b) => Ok(Some(B64.encode(b))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if !self.root(id)?.is_dir() { return Err("Bound folder is unavailable".into()); }
                Ok(None)
            },
            Err(e) => Err(e.to_string()),
        }
    }

    /// Returns the transient retained copy of the replaced file, if there was one.
    pub fn write(&self, id: &str, rel: &str, b64: &str) -> Result<Option<String>, String> {
        let root = self.root(id)?;
        let p = resolve_inside(&root, rel)?;
        let bytes = B64.decode(b64).map_err(|e| e.to_string())?;
        // A parent that became a file is a collision (as in mirror-node.ts): reported, never removed to make room.
        let mut dir = root.clone();
        for part in rel.split('/').take(rel.split('/').count() - 1) {
            dir.push(part);
            match fs::metadata(&dir) {
                Ok(m) if !m.is_dir() => return Err(format!("ENOTDIR: a parent folder of \"{rel}\" is a file")),
                Ok(_) => (),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                Err(e) => return Err(e.to_string()),
            }
        }
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        atomic_replace(&p, &bytes)?.map(|b| rel_any(&root, &b)).transpose()
    }

    pub fn remove(&self, id: &str, rel: &str) -> Result<Option<String>, String> {
        let root = self.root(id)?;
        let p = resolve_inside(&root, rel)?;
        retain_file(&p)?.map(|b| rel_any(&root, &b)).transpose()
    }

    /// Deletes a transient retained copy once the mirror compared or captured it. Only `.hivetex-recovery/*.retained`.
    pub fn drop_retained(&self, id: &str, rel: &str) -> Result<(), String> {
        let parts: Vec<&str> = rel.split('/').collect();
        if parts.len() < 2 || parts[parts.len() - 2] != ".hivetex-recovery" || !rel.ends_with(".retained") {
            return Err("not a retained recovery copy".into());
        }
        let p = resolve_inside(&self.root(id)?, rel)?;
        match fs::symlink_metadata(&p) {
            Ok(m) if m.is_file() => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            _ => return Err("not a retained recovery copy".into()),
        }
        fs::remove_file(&p).map_err(|e| e.to_string())?;
        if let Some(dir) = p.parent() { let _ = fs::remove_dir(dir); } // only succeeds once empty
        Ok(())
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
    fn replacements_with_the_same_stem_keep_their_own_content() {
        let d = tmp("atomic-same-stem");
        let a = d.join("main.tex");
        let b = d.join("main.bib");
        std::thread::scope(|scope| {
            scope.spawn(|| { for _ in 0..20 { atomic_replace(&a, b"source").unwrap(); } });
            scope.spawn(|| { for _ in 0..20 { atomic_replace(&b, b"bibliography").unwrap(); } });
        });
        assert_eq!(fs::read(&a).unwrap(), b"source");
        assert_eq!(fs::read(&b).unwrap(), b"bibliography");
        let mut files = Vec::new(); walk(&d, &d, &mut files).unwrap(); assert_eq!(files.len(), 2);
        assert!(!fs::read_dir(&d).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".p2p-tmp")));
    }

    #[cfg(windows)]
    #[test]
    fn failed_atomic_commit_keeps_a_locked_original() {
        use std::os::windows::fs::OpenOptionsExt;
        let d = tmp("atomic-locked");
        let p = d.join("main.tex");
        fs::write(&p, b"original").unwrap();
        let lock = fs::OpenOptions::new().read(true).share_mode(0).open(&p).unwrap();
        assert!(atomic_replace(&p, b"replacement").is_err());
        drop(lock);
        assert_eq!(fs::read(&p).unwrap(), b"original");
        assert!(!fs::read_dir(&d).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".p2p-tmp")));
        atomic_replace(&p, b"replacement").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"replacement");
    }

    fn names(d: &Path) -> Vec<String> {
        let mut n: Vec<String> = fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        n.sort();
        n
    }

    #[test]
    fn failed_publication_after_the_retain_puts_the_previous_file_back() {
        let d = tmp("publish-rollback");
        let st = MirrorState::default(); st.bind("p", &d, |_| {}).unwrap();
        fs::write(d.join("main.tex"), b"previous").unwrap();
        fault::set(fault::PUBLISH);
        let err = st.write("p", "main.tex", &B64.encode(b"new")).unwrap_err();
        fault::set(0);
        assert!(err.contains("injected"), "{err}");
        assert_eq!(fs::read(d.join("main.tex")).unwrap(), b"previous");
        assert!(st.retained("p").unwrap().is_empty(), "the rollback moved the copy back");
        assert!(!names(&d).iter().any(|n| n.ends_with(".p2p-tmp")));
        // The same, on a filesystem without exclusive rename flags or hard links (FAT, exFAT, network drives).
        fault::set(fault::PUBLISH | fault::NO_FLAGS | fault::NO_LINK);
        assert!(st.write("p", "main.tex", &B64.encode(b"new")).is_err());
        fault::set(0);
        assert_eq!(fs::read(d.join("main.tex")).unwrap(), b"previous");
        assert!(st.retained("p").unwrap().is_empty());
    }

    #[test]
    fn publication_without_rename_flags_or_hard_links_keeps_the_path_present() {
        let d = tmp("publish-nolink");
        let st = MirrorState::default(); st.bind("p", &d, |_| {}).unwrap();
        fault::set(fault::NO_FLAGS | fault::NO_LINK);
        assert_eq!(st.write("p", "main.tex", &B64.encode(b"first")).unwrap(), None);
        let copy = st.write("p", "main.tex", &B64.encode(b"second")).unwrap().expect("retained copy");
        fault::set(0);
        assert_eq!(fs::read(d.join("main.tex")).unwrap(), b"second");
        assert_eq!(B64.decode(st.read("p", &copy).unwrap().unwrap()).unwrap(), b"first");
        assert_eq!(names(&d), vec![".hivetex-recovery", "main.tex"]);
        st.drop_retained("p", &copy).unwrap();
        assert_eq!(names(&d), vec!["main.tex"], "the emptied recovery directory is removed too");
        assert!(st.drop_retained("p", "main.tex").is_err());
        assert!(st.drop_retained("p", ".hivetex-recovery/../main.tex").is_err());
        assert!(d.join("main.tex").exists());
    }

    #[test]
    fn exclusive_publication_never_replaces_an_external_save_and_reports_the_kept_copy() {
        let d = tmp("publish-race");
        let st = MirrorState::default(); st.bind("p", &d, |_| {}).unwrap();
        fs::write(d.join("main.tex"), b"original").unwrap();
        for bits in [fault::RACE, fault::RACE | fault::NO_FLAGS | fault::NO_LINK] {
            fault::set(bits);
            let err = st.write("p", "main.tex", &B64.encode(b"project")).unwrap_err();
            fault::set(0);
            assert!(err.contains("previous file was kept"), "{err}");
            assert_eq!(fs::read(d.join("main.tex")).unwrap(), b"external atomic save");
            let kept = st.retained("p").unwrap();
            assert_eq!(B64.decode(st.read("p", &kept[0].path).unwrap().unwrap()).unwrap(), b"original");
            st.drop_retained("p", &kept[0].path).unwrap();
            fs::write(d.join("main.tex"), b"original").unwrap();
        }
    }

    #[test]
    fn a_parent_that_became_a_file_is_reported_and_kept() {
        let d = tmp("parent-file");
        let st = MirrorState::default(); st.bind("p", &d, |_| {}).unwrap();
        fs::write(d.join("sections"), b"a file").unwrap();
        let err = st.write("p", "sections/a.tex", &B64.encode(b"x")).unwrap_err();
        assert!(err.starts_with("ENOTDIR"), "{err}");
        assert_eq!(fs::read(d.join("sections")).unwrap(), b"a file");
    }

    #[cfg(windows)]
    #[test]
    fn case_only_rename_on_ntfs_removes_then_publishes_the_new_name() {
        let d = tmp("ntfs-case");
        let st = MirrorState::default(); st.bind("p", &d, |_| {}).unwrap();
        st.write("p", "Intro.tex", &B64.encode(b"intro")).unwrap();
        // NTFS treats the variant as the same name: an exclusive publication refuses it instead of replacing.
        let tmpfile = d.join("x.p2p-tmp"); fs::write(&tmpfile, b"other").unwrap();
        assert_eq!(rename_noreplace(&tmpfile, &d.join("intro.tex")).unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
        fs::remove_file(&tmpfile).unwrap();
        let copy = st.remove("p", "Intro.tex").unwrap().unwrap();
        st.drop_retained("p", &copy).unwrap();
        st.write("p", "intro.tex", &B64.encode(b"intro")).unwrap();
        assert_eq!(st.list("p").unwrap().iter().map(|l| l.path.as_str()).collect::<Vec<_>>(), vec!["intro.tex"]);
    }

    #[test]
    fn creating_a_folder_reports_no_directory_path() {
        let d = tmp("watch-mkdir");
        let st = MirrorState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        let tx = Mutex::new(tx);
        st.bind("p", &d, move |p| { let _ = tx.lock().unwrap().send(p); }).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        fs::create_dir_all(d.join("figs/sub")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        fs::write(d.join("after.tex"), "x").unwrap();
        let end = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut seen = Vec::new();
        while std::time::Instant::now() < end && !seen.iter().any(|p: &String| p == "after.tex") {
            if let Ok(p) = rx.recv_timeout(std::time::Duration::from_millis(200)) { seen.push(p); }
        }
        assert!(seen.iter().any(|p| p == "after.tex"), "{seen:?}");
        assert!(!seen.iter().any(|p| p == "figs" || p == "figs/sub"), "{seen:?}");
    }

    #[test]
    fn failed_scan_is_an_error_instead_of_an_empty_folder() {
        let d = tmp("scan-failure");
        fs::write(d.join("not-a-directory"), b"keep").unwrap();
        assert!(walk(&d, &d.join("not-a-directory"), &mut Vec::new()).is_err());
    }

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

    #[test]
    fn replacement_retains_late_external_writes_and_removal_retains_bytes() {
        let d = tmp("retained-inode");
        let st = MirrorState::default(); st.bind("p", &d, |_| {}).unwrap();
        fs::write(d.join("main.tex"), b"original").unwrap();
        let mut external = fs::OpenOptions::new().write(true).open(d.join("main.tex")).unwrap();
        st.write("p", "main.tex", &B64.encode(b"project")).unwrap();
        external.write_all(b"late external contribution").unwrap(); external.sync_all().unwrap();
        assert_eq!(fs::read(d.join("main.tex")).unwrap(), b"project");
        let retained = st.retained("p").unwrap(); assert_eq!(retained.len(), 1);
        assert_eq!(B64.decode(st.read("p", &retained[0].path).unwrap().unwrap()).unwrap(), b"late external contribution");
        st.remove("p", "main.tex").unwrap();
        assert!(!d.join("main.tex").exists()); assert_eq!(st.retained("p").unwrap().len(), 2);
        assert!(st.list("p").unwrap().is_empty());
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
