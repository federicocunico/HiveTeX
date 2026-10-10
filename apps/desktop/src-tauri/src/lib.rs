pub mod managed;
pub mod helper;
pub mod mirror;
pub mod probe;
pub mod rtc;
pub mod secrets;
pub mod tex;
pub mod texcache;
pub mod tinytex;

use mirror::{Listed, MirrorState, PickedFolders};
use tauri::{Emitter, Manager, State};

#[tauri::command]
fn tex_detect() -> Option<tex::EngineInfo> {
    tex::detect()
}

/// Compiles on a blocking thread so the UI stays responsive. Packages the compiler downloads on the way are reported as
/// `compile://package` events.
#[tauri::command]
async fn tex_compile(app: tauri::AppHandle, req: tex::CompileReq) -> Result<tex::CompileResp, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let emitter = app.clone();
    let on_download: tex::OnDownload = std::sync::Arc::new(move |file: &str| {
        let _ = emitter.emit("compile://package", file.to_string());
    });
    tauri::async_runtime::spawn_blocking(move || tex::compile_with(&root, req, Some(on_download)))
        .await
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize, Clone)]
struct ManagedProgress {
    component: String,
    received: u64,
    total: u64,
}

/// Installs a compiler HiveTeX manages (`tectonic` = quick compiler, `tinytex` = full LaTeX) into the app's folder.
#[tauri::command]
async fn managed_install(app: tauri::AppHandle, component: String) -> Result<managed::Installed, String> {
    let asset = managed::asset(&component).ok_or_else(|| format!("{component} is not available for this system"))?;
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder().build().map_err(|e| e.to_string())?;
    let emitter = app.clone();
    let name = component.clone();
    let last = std::sync::Mutex::new(0u64);
    let progress = move |received: u64, total: u64| {
        // at most ~1 event per 256 KB
        let mut l = last.lock().unwrap();
        if received >= *l + 262_144 || received == total {
            *l = received;
            let _ = emitter.emit("managed://progress", ManagedProgress { component: name.clone(), received, total });
        }
    };
    managed::install(&client, &root, asset, &progress).await
}

#[derive(serde::Serialize)]
struct ManagedStatus {
    tectonic: Option<managed::Installed>,
    tinytex: Option<managed::Installed>,
    tectonic_cache_bytes: u64,
    /// Sizes of the downloads, to show before installing.
    tectonic_download: Option<u64>,
    tinytex_download: Option<u64>,
}

#[tauri::command]
fn managed_status(app: tauri::AppHandle) -> Result<ManagedStatus, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let cache = texcache::TexCache::new(root.join("tectonic-cache")).stats().bytes;
    Ok(ManagedStatus {
        tectonic: managed::status(&root, "tectonic"),
        tinytex: managed::status(&root, "tinytex"),
        tectonic_cache_bytes: cache,
        tectonic_download: managed::asset("tectonic").map(|a| a.size),
        tinytex_download: managed::asset("tinytex").map(|a| a.size),
    })
}

#[tauri::command]
fn managed_remove(app: tauri::AppHandle, component: String) -> Result<(), String> {
    if component != "tectonic" && component != "tinytex" {
        return Err("unknown component".into());
    }
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    managed::remove(&root, &component)?;
    if component == "tectonic" {
        let _ = std::fs::remove_dir_all(root.join("tectonic-cache"));
    }
    Ok(())
}

/// Opens the native folder dialog and records the choice; the only way a folder becomes usable by the webview.
#[tauri::command]
async fn mirror_pick(app: tauri::AppHandle, title: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    #[cfg(feature = "test-picker")]
    if let Some(path) = test_picker::next() {
        app.state::<PickedFolders>().add(&path)?;
        return Ok(Some(path.to_string_lossy().to_string()));
    }
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

/// Shows a bound folder in the system file manager (only folders already bound, never an arbitrary path).
#[tauri::command]
fn mirror_reveal(app: tauri::AppHandle, state: State<'_, MirrorState>, id: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = state.root_dir(&id)?;
    app.opener().reveal_item_in_dir(dir).map_err(|e| e.to_string())
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

/// The built-in compiler's TeX files on disk (see texcache.rs).
#[tauri::command]
fn texcache_set_upstream(cache: State<'_, texcache::TexCache>, url: String) -> Result<(), String> {
    cache.set_upstream(&url)
}

#[tauri::command]
fn texcache_stats(cache: State<'_, texcache::TexCache>) -> texcache::Stats {
    cache.stats()
}

#[tauri::command]
fn texcache_clear(cache: State<'_, texcache::TexCache>) -> Result<(), String> {
    cache.clear()
}

#[derive(serde::Serialize, Clone)]
struct TexFetch {
    file: String,
    state: &'static str,
}

/// `texcache://localhost/<path>`: TeX files for the built-in compiler, from the disk cache or downloaded once.
fn texcache_response(app: &tauri::AppHandle, path: &str) -> impl std::future::Future<Output = tauri::http::Response<Vec<u8>>> {
    let app = app.clone();
    let path = path.to_string();
    async move {
        let reply = |status: u16, body: Vec<u8>| {
            tauri::http::Response::builder()
                .status(status)
                .header("Access-Control-Allow-Origin", "*")
                .header("Content-Type", "application/octet-stream")
                .body(body)
                .unwrap()
        };
        let Some(rel) = texcache::safe_rel(&path) else { return reply(400, Vec::new()) };
        let cache = app.state::<texcache::TexCache>();
        let file = rel.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
        let cached = cache.inner().stats_contains(&rel);
        if !cached {
            let _ = app.emit("texcache://fetch", TexFetch { file: file.clone(), state: "start" });
        }
        let out = match cache.get(&rel).await {
            Ok(texcache::Lookup::Hit(b)) => reply(200, b),
            Ok(texcache::Lookup::Missing) => reply(404, Vec::new()),
            Err(_) => reply(502, Vec::new()),
        };
        if !cached {
            let state = if out.status() == 200 { "done" } else { "failed" };
            let _ = app.emit("texcache://fetch", TexFetch { file, state });
        }
        out
    }
}

/// Origin of the web app the helper serves by default (the shipped server).
const DEFAULT_WEB_ORIGIN: &str = "https://hivetex.vercel.app";

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct HelperSettings {
    enabled: bool,
    /// Extra web origins allowed besides the default (a self-hosted server's web app).
    origins: Vec<String>,
}

impl Default for HelperSettings {
    fn default() -> Self {
        HelperSettings { enabled: true, origins: Vec::new() }
    }
}

/// The local compile helper (helper.rs) and the pairing requests waiting for the user's answer.
struct HelperState {
    helper: Option<helper::Helper>,
    settings_path: std::path::PathBuf,
    settings: std::sync::Mutex<HelperSettings>,
    pending: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, std::sync::mpsc::Sender<bool>>>>,
}

impl HelperState {
    fn origins(settings: &HelperSettings) -> Vec<String> {
        let mut o = vec![DEFAULT_WEB_ORIGIN.to_string()];
        o.extend(settings.origins.iter().cloned());
        // Development and UI tests: the web app served locally.
        if let Ok(extra) = std::env::var("HIVETEX_HELPER_ORIGINS") {
            o.extend(extra.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));
        }
        o
    }

    fn start(app: &tauri::AppHandle, dir: &std::path::Path) -> HelperState {
        let settings_path = dir.join("helper-settings.json");
        let settings: HelperSettings = std::fs::read(&settings_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let pending: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, std::sync::mpsc::Sender<bool>>>> = Default::default();
        let root = dir.to_path_buf();
        let compile: helper::CompileFn = std::sync::Arc::new(move |req| tex::compile_with(&root, req, None));
        let (handle, waiting) = (app.clone(), pending.clone());
        let confirm: helper::ConfirmFn = std::sync::Arc::new(move |req: helper::PairRequest| {
            let (tx, rx) = std::sync::mpsc::channel();
            waiting.lock().unwrap().insert(req.id.clone(), tx);
            if let Some(w) = handle.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            let _ = handle.emit("helper://pair-request", req.clone());
            let answer = rx.recv_timeout(std::time::Duration::from_secs(60)).unwrap_or(false);
            waiting.lock().unwrap().remove(&req.id);
            answer
        });
        let status: helper::StatusFn = std::sync::Arc::new(tex::detect);
        let helper = match helper::Helper::start(Some(dir.join("helper-pairings.json")), Self::origins(&settings), compile, confirm, status) {
            Ok(h) => {
                h.set_enabled(settings.enabled);
                Some(h)
            }
            Err(e) => {
                eprintln!("local compile helper: {e}");
                None
            }
        };
        HelperState { helper, settings_path, settings: std::sync::Mutex::new(settings), pending }
    }
}

#[derive(serde::Serialize)]
struct HelperInfo {
    running: bool,
    port: Option<u16>,
    enabled: bool,
    origins: Vec<String>,
    pairings: Vec<PairingInfo>,
}

#[derive(serde::Serialize)]
struct PairingInfo {
    id: String,
    username: String,
    server: String,
    created: u64,
}

fn helper_info_of(state: &HelperState) -> HelperInfo {
    let s = state.settings.lock().unwrap().clone();
    let pairings = state.helper.as_ref().map(|h| h.pairings()).unwrap_or_default();
    HelperInfo {
        running: state.helper.is_some(),
        port: state.helper.as_ref().map(|h| h.port),
        enabled: s.enabled,
        origins: HelperState::origins(&s),
        pairings: pairings.into_iter().map(|p| PairingInfo { id: p.id, username: p.username, server: p.server, created: p.created }).collect(),
    }
}

#[tauri::command]
fn helper_info(state: State<'_, HelperState>) -> HelperInfo {
    helper_info_of(&state)
}

/// Turns the helper on or off and sets the extra web origins it serves (a self-hosted server's web app).
#[tauri::command]
fn helper_configure(state: State<'_, HelperState>, enabled: bool, origins: Vec<String>) -> Result<HelperInfo, String> {
    let origins: Vec<String> = origins.into_iter().map(|o| o.trim().trim_end_matches('/').to_string()).filter(|o| !o.is_empty()).collect();
    for o in &origins {
        let ok = (o.starts_with("https://") || o.starts_with("http://localhost") || o.starts_with("http://127.0.0.1")) && !o[8..].contains('/');
        if !ok {
            return Err(format!("not a web app origin: {o}"));
        }
    }
    let s = HelperSettings { enabled, origins };
    std::fs::write(&state.settings_path, serde_json::to_vec_pretty(&s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if let Some(h) = &state.helper {
        h.set_enabled(enabled);
        h.set_allowed_origins(HelperState::origins(&s));
    }
    *state.settings.lock().unwrap() = s;
    Ok(helper_info_of(&state))
}

/// The user's answer to a `helper://pair-request`.
#[tauri::command]
fn helper_answer(state: State<'_, HelperState>, id: String, allow: bool) {
    if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(allow);
    }
}

#[tauri::command]
fn helper_revoke(state: State<'_, HelperState>, id: String) -> HelperInfo {
    if let Some(h) = &state.helper {
        h.revoke(&id);
    }
    helper_info_of(&state)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `--ignore-system-tex`: behave as on a computer without TeX (UI tests of the quick compiler; only removes options).
    if std::env::args().any(|a| a == "--ignore-system-tex") {
        std::env::set_var("HIVETEX_IGNORE_SYSTEM_TEX", "1");
    }
    // TLS for the package-server downloads (ring, already used by the WebRTC stack).
    let _ = rustls::crypto::ring::default_provider().install_default();
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("texcache", |ctx, request, responder| {
            let fut = texcache_response(ctx.app_handle(), request.uri().path());
            tauri::async_runtime::spawn(async move { responder.respond(fut.await) });
        })
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            tex::set_managed_root(dir.clone());
            app.manage(texcache::TexCache::new(dir.join("texcache")));
            let picked = dir.join("picked-folders.json");
            adopt_legacy_file(&picked, LEGACY_IDENTIFIER);
            app.manage(PickedFolders::load(picked));
            app.manage(HelperState::start(app.handle(), &dir));
            Ok(())
        })
        .manage(MirrorState::default())
        .manage(probe::ProbeState::default())
        .manage(rtc::RtcState::default())
        .invoke_handler(tauri::generate_handler![
            tex_detect,
            tex_compile,
            texcache_set_upstream,
            managed_install,
            managed_status,
            managed_remove,
            texcache_stats,
            texcache_clear,
            mirror_pick,
            mirror_bind,
            mirror_unbind,
            mirror_reveal,
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
            secret_delete,
            helper_info,
            helper_configure,
            helper_answer,
            helper_revoke
        ])
        .run(tauri::generate_context!())
        .expect("error while running HiveTeX");
}

/// Bundle identifier before the product was renamed (p2platex): its app-data folder is a sibling of the current one.
const LEGACY_IDENTIFIER: &str = "app.p2platex.desktop";

/// Copies `file` from the previous identifier's app-data folder when the current one has none yet (once: after the
/// copy, the current file exists). Folders the user picked under the old name stay allowed.
fn adopt_legacy_file(file: &std::path::Path, legacy_identifier: &str) {
    if file.exists() {
        return;
    }
    let (Some(dir), Some(name)) = (file.parent(), file.file_name()) else { return };
    let Some(legacy) = dir.parent().map(|p| p.join(legacy_identifier).join(name)) else { return };
    if legacy.is_file() {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::copy(&legacy, file);
    }
}

#[cfg(test)]
mod legacy_tests {
    #[test]
    fn picked_folders_are_adopted_from_the_previous_identifier_once() {
        let base = std::env::temp_dir().join(format!("hivetex-legacy-{}", std::process::id()));
        let old = base.join("app.p2platex.desktop");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("picked-folders.json"), "[\"C:/thesis\"]").unwrap();
        let new_file = base.join("app.hivetex.desktop").join("picked-folders.json");
        super::adopt_legacy_file(&new_file, "app.p2platex.desktop");
        assert_eq!(std::fs::read_to_string(&new_file).unwrap(), "[\"C:/thesis\"]");
        // later changes under the new name are never overwritten by the old file
        std::fs::write(&new_file, "[]").unwrap();
        super::adopt_legacy_file(&new_file, "app.p2platex.desktop");
        assert_eq!(std::fs::read_to_string(&new_file).unwrap(), "[]");
        // nothing to adopt: no file is created
        let other = base.join("fresh").join("picked-folders.json");
        super::adopt_legacy_file(&other, "missing.identifier");
        assert!(!other.exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}

/// Desktop UI tests: the "picked" folder is `$HIVETEX_TEST_PICK_DIR`, or the sub-folder named in its `.next-pick`
/// file (consumed), so a test can choose a different folder for each pick. Only compiled with `--features test-picker`.
#[cfg(feature = "test-picker")]
mod test_picker {
    use std::path::PathBuf;

    pub fn next() -> Option<PathBuf> {
        // `--test-pick-dir <dir>` (WebDriver drivers forward app arguments, not always the environment) or the variable.
        let mut args = std::env::args_os().skip_while(|a| a != "--test-pick-dir");
        let from_args = args.nth(1);
        let base = PathBuf::from(from_args.or_else(|| std::env::var_os("HIVETEX_TEST_PICK_DIR"))?);
        let next = base.join(".next-pick");
        let dir = match std::fs::read_to_string(&next) {
            Ok(name) => {
                let _ = std::fs::remove_file(&next);
                base.join(name.trim())
            }
            Err(_) => base,
        };
        std::fs::create_dir_all(&dir).ok()?;
        Some(dir)
    }
}

#[cfg(test)]
mod picker_tests {
    /// The test picker must never be part of a default (release) build.
    #[test]
    fn test_picker_is_not_a_default_feature() {
        let manifest = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).unwrap();
        assert!(manifest.contains("test-picker = []"));
        for line in manifest.lines().filter(|l| l.trim_start().starts_with("default")) {
            assert!(!line.contains("test-picker"), "test-picker must not be a default feature: {line}");
        }
        // The release workflow builds without `--features` (checked by the CI step that greps the binary).
        let wf = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../.github/workflows/desktop.yml")).unwrap();
        for line in wf.lines().filter(|l| l.contains("tauri build") || l.contains("tauri-action")) {
            assert!(!line.contains("test-picker"), "release build must not enable test-picker: {line}");
        }
    }
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
