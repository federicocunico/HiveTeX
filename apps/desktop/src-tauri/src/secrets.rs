//! Secrets (session token, device private keys) live in the OS credential store — Windows Credential
//! Manager, macOS Keychain or the Secret Service on Linux — never in plain files under the app data dir.

const SERVICE: &str = "app.hivetex.desktop";

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

pub fn get(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
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
}
