pub mod mirror;
pub mod probe;
pub mod rtc;
pub mod secrets;
pub mod tex;

use mirror::{Listed, MirrorState, PickedFolders};
use tauri::{Emitter, Manager, State};

#[tauri::command]
fn tex_detect() -> Option<tex::EngineInfo> {
    tex::detect()
}

/// Compiles on a blocking thread so the UI stays responsive.
#[tauri::command]
async fn tex_compile(app: tauri::AppHandle, req: tex::CompileReq) -> Result<tex::CompileResp, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || tex::compile(&root, req))
        .await
        .map_err(|e| e.to_string())
}

/// Opens the native folder dialog and records the choice; the only way a folder becomes usable by the webview.
#[tauri::command]
async fn mirror_pick(app: tauri::AppHandle, title: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || handle.dialog().file().set_title(title).blocking_pick_folder())
        .await
        .map_err(|e| e.to_string())?;
    let Some(fp) = picked else { return Ok(None) };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    app.state::<PickedFolders>().add(&path)?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
fn mirror_bind(
    app: tauri::AppHandle,
    state: State<'_, MirrorState>,
    picked: State<'_, PickedFolders>,
    id: String,
    dir: String,
) -> Result<(), String> {
    // Paths coming from page script are never trusted on their own: the user must have picked this folder.
    if !picked.contains(std::path::Path::new(&dir)) {
        return Err("This folder was not chosen in the folder picker on this device. Choose it again.".into());
    }
    let event = format!("mirror://{id}");
    state.bind(&id, std::path::Path::new(&dir), move |rel| {
        let _ = app.emit(&event, rel);
    })
}

#[tauri::command]
fn mirror_unbind(state: State<'_, MirrorState>, id: String) {
    state.unbind(&id);
}

#[tauri::command]
fn mirror_list(state: State<'_, MirrorState>, id: String) -> Result<Vec<Listed>, String> {
    state.list(&id)
}

#[tauri::command]
fn mirror_read(state: State<'_, MirrorState>, id: String, path: String) -> Result<Option<String>, String> {
    state.read(&id, &path)
}

#[tauri::command]
fn mirror_write(state: State<'_, MirrorState>, id: String, path: String, b64: String) -> Result<(), String> {
    state.write(&id, &path, &b64)
}

#[tauri::command]
fn mirror_remove(state: State<'_, MirrorState>, id: String, path: String) -> Result<(), String> {
    state.remove(&id, &path)
}

fn rtc_emit(app: tauri::AppHandle) -> rtc::Emit {
    std::sync::Arc::new(move |name, payload| {
        let _ = app.emit(&name, payload);
    })
}

#[tauri::command]
async fn rtc_create(app: tauri::AppHandle, state: State<'_, rtc::RtcState>, id: String, ice: Vec<rtc::IceServer>) -> Result<(), String> {
    state.create(&id, ice, rtc_emit(app)).await
}

#[tauri::command]
async fn rtc_create_data_channel(app: tauri::AppHandle, state: State<'_, rtc::RtcState>, id: String, label: String) -> Result<(), String> {
    state.create_data_channel(&id, &label, rtc_emit(app)).await
}

#[tauri::command]
async fn rtc_create_offer(state: State<'_, rtc::RtcState>, id: String) -> Result<String, String> {
    state.create_offer(&id).await
}

#[tauri::command]
async fn rtc_create_answer(state: State<'_, rtc::RtcState>, id: String) -> Result<String, String> {
    state.create_answer(&id).await
}

#[tauri::command]
async fn rtc_set_local(state: State<'_, rtc::RtcState>, id: String, kind: String, sdp: String) -> Result<(), String> {
    state.set_local(&id, &kind, sdp).await
}

#[tauri::command]
async fn rtc_set_remote(state: State<'_, rtc::RtcState>, id: String, kind: String, sdp: String) -> Result<(), String> {
    state.set_remote(&id, &kind, sdp).await
}

#[tauri::command]
async fn rtc_local_sdp(state: State<'_, rtc::RtcState>, id: String) -> Result<Option<String>, String> {
    state.local_sdp(&id).await
}

#[tauri::command]
async fn rtc_add_ice(state: State<'_, rtc::RtcState>, id: String, candidate: serde_json::Value) -> Result<(), String> {
    state.add_ice(&id, candidate).await
}

#[tauri::command]
async fn rtc_send(state: State<'_, rtc::RtcState>, id: String, label: String, b64: String) -> Result<usize, String> {
    state.send(&id, &label, &b64).await
}

#[tauri::command]
async fn rtc_close(state: State<'_, rtc::RtcState>, id: String) -> Result<(), String> {
    state.close(&id).await;
    Ok(())
}

#[tauri::command]
fn probe_system(state: State<'_, probe::ProbeState>) -> probe::Probe {
    state.probe()
}

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    secrets::get(&key)
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    secrets::set(&key, &value)
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    secrets::delete(&key)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            app.manage(PickedFolders::load(dir.join("picked-folders.json")));
            Ok(())
        })
        .manage(MirrorState::default())
        .manage(probe::ProbeState::default())
        .manage(rtc::RtcState::default())
        .invoke_handler(tauri::generate_handler![
            tex_detect,
            tex_compile,
            mirror_pick,
            mirror_bind,
            mirror_unbind,
            mirror_list,
            mirror_read,
            mirror_write,
            mirror_remove,
            probe_system,
            rtc_create,
            rtc_create_data_channel,
            rtc_create_offer,
            rtc_create_answer,
            rtc_set_local,
            rtc_set_remote,
            rtc_local_sdp,
            rtc_add_ice,
            rtc_send,
            rtc_close,
            secret_get,
            secret_set,
            secret_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running p2platex");
}

#[cfg(test)]
mod config_tests {
    //! The shipped configuration must stay locked down (design D3/D15).
    fn read(rel: &str) -> String {
        std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)).unwrap()
    }

    #[test]
    fn capabilities_grant_no_shell_or_generic_fs_access() {
        let cap: serde_json::Value = serde_json::from_str(&read("capabilities/default.json")).unwrap();
        let perms: Vec<String> = cap["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().map(str::to_string).unwrap_or_else(|| p["identifier"].as_str().unwrap().to_string()))
            .collect();
        // The opener may only open the GitHub authorize page.
        let opener = cap["permissions"].as_array().unwrap().iter().find(|p| p["identifier"] == "opener:allow-open-url").expect("opener scoped permission");
        assert_eq!(opener["allow"], serde_json::json!([{ "url": "https://github.com/login/oauth/authorize*" }]));
        for p in &perms {
            assert!(!p.starts_with("shell:") && !p.starts_with("fs:") && !p.starts_with("http:") && !p.starts_with("process:"), "unexpected permission {p}");
        }
        // Folders come only from the native picker opened by Rust (mirror_pick), never from page script.
        assert!(!perms.iter().any(|p| p.starts_with("dialog:")), "the webview must not open dialogs itself");
        assert_eq!(cap["windows"], serde_json::json!(["main"]));
    }

    #[test]
    fn csp_is_strict_and_no_remote_content_is_loaded() {
        let conf: serde_json::Value = serde_json::from_str(&read("tauri.conf.json")).unwrap();
        let csp = conf["app"]["security"]["csp"].as_str().expect("CSP must be set");
        assert!(csp.contains("default-src 'self'"));
        assert!(csp.contains("object-src 'none'"));
        assert!(!csp.contains("'unsafe-eval'"));
        assert!(!csp.contains("script-src *"));
        assert!(!csp.replace("http://ipc.localhost", "").contains("http:"), "plain http connections are not allowed");
        assert!(conf["build"]["devUrl"].as_str().unwrap().starts_with("http://localhost"));
        assert_eq!(conf["app"]["withGlobalTauri"], serde_json::json!(false));
    }

    #[test]
    fn no_plugin_with_broad_access_is_registered() {
        let manifest = read("Cargo.toml");
        for banned in ["tauri-plugin-shell", "tauri-plugin-fs", "tauri-plugin-http", "tauri-plugin-process"] {
            assert!(!manifest.contains(&format!("{banned} =")), "{banned} must not be a direct dependency");
        }
    }

    #[test]
    fn secrets_are_never_written_to_the_app_data_directory() {
        // Tokens and keys go through secrets.rs (OS credential store); the only file writers are tex.rs
        // (build output) and mirror.rs (user-bound folders). Guard against someone adding a token file.
        let lib = read("src/lib.rs");
        let lib_prod = lib.split("#[cfg(test)]").next().unwrap_or("");
        let src = [read("src/tex.rs"), read("src/mirror.rs"), lib_prod.to_string()].join("\n");
        assert!(!src.to_lowercase().contains("token.json"));
        assert!(!src.contains("app_data_dir().map_err(|e| e.to_string())?.join(\"session"));
    }
}
