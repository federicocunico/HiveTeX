//! Secrets (session token, device private keys) live in the OS credential store — Windows Credential
//! Manager, macOS Keychain or the Secret Service on Linux — never in plain files under the app data dir.

const SERVICE: &str = "app.hivetex.desktop";
/** Service name used before the product was renamed (p2platex); entries are moved over on first read. */
const LEGACY_SERVICE: &str = "app.p2platex.desktop";

fn entry_in(service: &str, key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, key).map_err(|e| e.to_string())
}

fn entry(key: &str) -> Result<keyring::Entry, String> {
    entry_in(SERVICE, key)
}

fn read(service: &str, key: &str) -> Result<Option<String>, String> {
    match entry_in(service, key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn get(key: &str) -> Result<Option<String>, String> {
    get_from(SERVICE, LEGACY_SERVICE, key)
}

/** Reads `key` from `service`; if absent there, moves it over from `legacy` (once). */
fn get_from(service: &str, legacy: &str, key: &str) -> Result<Option<String>, String> {
    if let Some(v) = read(service, key)? {
        return Ok(Some(v));
    }
    let Some(v) = read(legacy, key)? else { return Ok(None) };
    entry_in(service, key)?.set_password(&v).map_err(|e| e.to_string())?;
    let _ = entry_in(legacy, key)?.delete_credential();
    Ok(Some(v))
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    entry(key)?.set_password(value).map_err(|e| e.to_string())
}

pub fn delete(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_in_the_os_keychain() {
        let key = format!("test-{}", std::process::id());
        // Headless Linux CI may have no Secret Service; skip rather than fail there.
        if set(&key, "s3cret-token").is_err() {
            eprintln!("no credential store available; skipping");
            return;
        }
        assert_eq!(get(&key).unwrap().as_deref(), Some("s3cret-token"));
        set(&key, "rotated").unwrap();
        assert_eq!(get(&key).unwrap().as_deref(), Some("rotated"));
        delete(&key).unwrap();
        assert_eq!(get(&key).unwrap(), None);
        delete(&key).unwrap(); // idempotent
    }

    #[test]
    fn entries_under_the_previous_service_are_moved_over() {
        let key = format!("legacy-test-{}", std::process::id());
        let (new_svc, old_svc) = ("app.hivetex.test-new", "app.hivetex.test-old");
        if entry_in(old_svc, &key).and_then(|e| e.set_password("kept-token").map_err(|e| e.to_string())).is_err() {
            eprintln!("no credential store available; skipping");
            return;
        }
        assert_eq!(get_from(new_svc, old_svc, &key).unwrap().as_deref(), Some("kept-token"));
        assert_eq!(read(new_svc, &key).unwrap().as_deref(), Some("kept-token"));
        assert_eq!(read(old_svc, &key).unwrap(), None, "the old entry is removed after the move");
        let _ = entry_in(new_svc, &key).map(|e| e.delete_credential());
    }
}
