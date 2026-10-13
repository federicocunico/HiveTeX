//! Maintenance deletes only app-owned paths; never follow a symlink or Windows junction into a linked project.
use std::path::Path;

pub static COMPILER_ACTIVITY: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());
pub const CACHE_DIRS: &[&str] = &["builds", "tectonic-cache", "texcache", "downloads", "tectonic.tmp", "tinytex.tmp"];
const APP_ID: &str = "app.hivetex.desktop";
const LEGACY_ID: &str = "app.p2platex.desktop"; // Published v0.1.0/v0.1.1, before the HiveTeX name.

fn is_link(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    { meta.file_type().is_symlink() }
}

pub fn remove_owned_tree(path: &Path) -> Result<(), String> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("Cannot inspect {}: {e}", path.display())),
    };
    let linked = is_link(&meta);
    #[cfg(windows)]
    let directory = {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x10 != 0 // FILE_ATTRIBUTE_DIRECTORY remains set on directory junctions
    };
    #[cfg(not(windows))]
    let directory = meta.is_dir();
    if directory && !linked {
        for entry in std::fs::read_dir(path).map_err(|e| format!("Cannot list {}: {e}", path.display()))? {
            remove_owned_tree(&entry.map_err(|e| e.to_string())?.path())?;
        }
    }
    let result = if directory { std::fs::remove_dir(path) } else { std::fs::remove_file(path) };
    result.map_err(|e| format!("Cannot remove {}: {e}", path.display()))
}

pub fn clear_compiler_cache(root: &Path) -> Result<(), String> {
    let _exclusive = COMPILER_ACTIVITY.try_write().map_err(|_| "A compile or compiler installation is active. Wait for it to finish, then clear the cache.".to_string())?;
    let mut roots = vec![root.to_path_buf()];
    if root.file_name().is_some_and(|name| name == APP_ID) {
        if let Some(parent) = root.parent() { roots.push(parent.join(LEGACY_ID)); }
    }
    for root in roots {
        match std::fs::symlink_metadata(&root) {
            Ok(meta) if is_link(&meta) => return Err("The compiler data folder is linked to another location; cache reset cannot delete through that link.".into()),
            Ok(_) => {},
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("Cannot inspect {}: {e}", root.display())),
        }
        for name in CACHE_DIRS { remove_owned_tree(&root.join(name))?; }
    }
    crate::tex::forget_engine();
    Ok(())
}

/// An installer-only entry point: no window, tray, synchronization worker or compiler is initialized.
#[cfg(windows)]
pub fn uninstall(identifier: &str, startup_name: &str) -> Result<(), String> {
    if !matches!(identifier, "app.hivetex.desktop" | "app.hivetex.desktop.e2e") {
        return Err("Unrecognized HiveTeX application identity".into());
    }
    stop_apps(identifier)?;
    delete_credentials(identifier)?;
    remove_startup(startup_name)?;
    if identifier == APP_ID {
        delete_credentials(LEGACY_ID)?;
        remove_startup("p2platex")?;
    }
    for key in ["APPDATA", "LOCALAPPDATA"] {
        let base = std::env::var_os(key).map(std::path::PathBuf::from).ok_or_else(|| format!("{key} is unavailable"))?;
        if !base.is_absolute() { return Err(format!("{key} must be an absolute profile path")); }
        remove_owned_tree(&base.join(identifier))?;
        if identifier == APP_ID { remove_owned_tree(&base.join(LEGACY_ID))?; }
    }
    Ok(())
}

#[cfg(windows)]
fn stop_apps(identifier: &str) -> Result<(), String> {
    let system = sysinfo::System::new_all();
    let current = sysinfo::get_current_pid().map_err(|e| e.to_string())?;
    let user = system.process(current).and_then(|p| p.user_id()).ok_or("Cannot identify the uninstalling Windows user")?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?.canonicalize().map_err(|e| e.to_string())?;
    for (&pid, process) in system.processes() {
        let ours = process.name().eq_ignore_ascii_case("hivetex-desktop.exe")
            || process.name().eq_ignore_ascii_case("p2platex-desktop.exe");
        if pid != current && ours && process.user_id() == Some(user) {
            // The isolated test identity may never stop a person's installed production app.
            if identifier.ends_with(".e2e") && !process.exe().and_then(|p| p.canonicalize().ok()).is_some_and(|p| p == executable) { continue; }
            if !process.kill() { return Err(format!("Cannot stop HiveTeX process {pid}; quit HiveTeX and retry uninstall")); }
            // The app's kill-on-close job terminates its worker and compiler descendants.
            process.wait();
        }
    }
    Ok(())
}

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> { text.encode_utf16().chain(Some(0)).collect() }

#[cfg(windows)]
fn credential_belongs_to(target: &str, identifier: &str) -> bool {
    target.strip_suffix(&format!(".{identifier}")).is_some_and(|key| !key.is_empty())
}

#[cfg(windows)]
pub fn delete_credentials(identifier: &str) -> Result<(), String> {
    use windows_sys::Win32::{Foundation::{GetLastError, ERROR_NOT_FOUND}, Security::Credentials::*};
    unsafe {
        let mut count = 0;
        let mut entries: *mut *mut CREDENTIALW = std::ptr::null_mut();
        if CredEnumerateW(std::ptr::null(), 0, &mut count, &mut entries) == 0 {
            let error = GetLastError();
            return if error == ERROR_NOT_FOUND { Ok(()) } else { Err(format!("Cannot enumerate app credentials: Windows error {error}")) };
        }
        let mut result = Ok(());
        for entry in std::slice::from_raw_parts(entries, count as usize) {
            let entry = &**entry;
            let mut len = 0;
            while *entry.TargetName.add(len) != 0 { len += 1; }
            let target = String::from_utf16_lossy(std::slice::from_raw_parts(entry.TargetName, len));
            if entry.Type == CRED_TYPE_GENERIC && credential_belongs_to(&target, identifier) && CredDeleteW(entry.TargetName, entry.Type, 0) == 0 {
                let error = GetLastError();
                if error != ERROR_NOT_FOUND { result = Err(format!("Cannot remove an app credential: Windows error {error}")); }
            }
        }
        CredFree(entries.cast());
        result
    }
}

#[cfg(windows)]
fn remove_startup(name: &str) -> Result<(), String> {
    use windows_sys::Win32::{Foundation::{ERROR_SUCCESS, ERROR_FILE_NOT_FOUND}, System::Registry::*};
    for key in [r"Software\Microsoft\Windows\CurrentVersion\Run", r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"] {
        unsafe {
            let mut handle = std::ptr::null_mut();
            let opened = RegOpenKeyExW(HKEY_CURRENT_USER, wide(key).as_ptr(), 0, KEY_SET_VALUE, &mut handle);
            if opened == ERROR_FILE_NOT_FOUND { continue; }
            if opened != ERROR_SUCCESS { return Err(format!("Cannot open login startup: Windows error {opened}")); }
            let deleted = RegDeleteValueW(handle, wide(name).as_ptr());
            RegCloseKey(handle);
            if deleted != ERROR_SUCCESS && deleted != ERROR_FILE_NOT_FOUND { return Err(format!("Cannot remove login startup: Windows error {deleted}")); }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn credential_cleanup_matches_only_the_exact_app_service() {
        assert!(credential_belongs_to("device:server:alice.app.hivetex.desktop", "app.hivetex.desktop"));
        assert!(!credential_belongs_to("device:server:alice.app.hivetex.desktop.e2e", "app.hivetex.desktop"));
        assert!(!credential_belongs_to("device:server:alice.other-app", "app.hivetex.desktop"));
        assert!(!credential_belongs_to(".app.hivetex.desktop", "app.hivetex.desktop"));
    }

    #[cfg(windows)]
    #[test]
    fn credential_cleanup_removes_only_its_service_and_can_be_repeated() {
        let service = format!("app.hivetex.cleanup-test-{}", std::process::id());
        let owned = keyring::Entry::new(&service, "fixture").unwrap();
        let unrelated = keyring::Entry::new(&format!("{service}.unrelated"), "fixture").unwrap();
        owned.set_password("fixture-only").unwrap();
        unrelated.set_password("preserve").unwrap();
        delete_credentials(&service).unwrap();
        delete_credentials(&service).unwrap();
        assert!(matches!(owned.get_password(), Err(keyring::Error::NoEntry)));
        assert_eq!(unrelated.get_password().unwrap(), "preserve");
        unrelated.delete_credential().unwrap();
    }

    #[test]
    fn reset_clears_only_cache_and_is_idempotent() {
        let root = std::env::temp_dir().join(format!("hivetex-maintenance-{}", std::process::id()));
        remove_owned_tree(&root).unwrap();
        for name in CACHE_DIRS.iter().copied().chain(["projects", "tectonic", "tinytex", "stores"]) {
            std::fs::create_dir_all(root.join(name)).unwrap();
            std::fs::write(root.join(name).join("marker"), name).unwrap();
        }
        std::fs::write(root.join("startup.json"), "settings").unwrap();
        clear_compiler_cache(&root).unwrap();
        clear_compiler_cache(&root).unwrap();
        for name in CACHE_DIRS { assert!(!root.join(name).exists()); }
        for name in ["projects", "tectonic", "tinytex", "stores"] { assert!(root.join(name).join("marker").exists()); }
        assert!(root.join("startup.json").exists());
        remove_owned_tree(&root).unwrap();
    }

    #[test]
    fn reset_refuses_active_compilation() {
        let _active = COMPILER_ACTIVITY.try_read().unwrap();
        assert!(clear_compiler_cache(Path::new("unused")).unwrap_err().contains("active"));
    }

    #[test]
    fn cache_reset_includes_legacy_builds_and_preserves_legacy_documents() {
        let base = std::env::temp_dir().join(format!("hivetex-legacy-cache-{}", std::process::id()));
        remove_owned_tree(&base).unwrap();
        for id in [APP_ID, LEGACY_ID] {
            std::fs::create_dir_all(base.join(id).join("builds")).unwrap();
            std::fs::write(base.join(id).join("builds/output.pdf"), "cache").unwrap();
            std::fs::write(base.join(id).join("document.tex"), "retain").unwrap();
        }
        clear_compiler_cache(&base.join(APP_ID)).unwrap();
        for id in [APP_ID, LEGACY_ID] {
            assert!(!base.join(id).join("builds").exists());
            assert!(base.join(id).join("document.tex").exists());
        }
        remove_owned_tree(&base).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn cleanup_does_not_follow_a_directory_junction() {
        let base = std::env::temp_dir().join(format!("hivetex-junction-{}", std::process::id()));
        remove_owned_tree(&base).unwrap();
        let external = base.join("external");
        let owned = base.join("owned");
        std::fs::create_dir_all(&external).unwrap();
        std::fs::create_dir_all(external.join("builds")).unwrap();
        std::fs::write(external.join("builds/output.pdf"), "keep").unwrap();
        std::fs::create_dir_all(&owned).unwrap();
        std::fs::write(external.join("document.tex"), "preserve").unwrap();
        assert!(crate::proc::background_command("cmd.exe").args(["/c", "mklink", "/J"])
            .arg(owned.join("linked")).arg(&external).status().unwrap().success());
        assert!(clear_compiler_cache(&owned.join("linked")).unwrap_err().contains("linked"));
        assert!(external.join("builds/output.pdf").exists());
        remove_owned_tree(&owned).unwrap();
        assert_eq!(std::fs::read_to_string(external.join("document.tex")).unwrap(), "preserve");
        remove_owned_tree(&base).unwrap();
    }
}
