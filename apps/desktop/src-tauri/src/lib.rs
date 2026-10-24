pub mod managed;
pub mod maintenance;
pub mod compiler_health;
pub mod helper;
pub mod igd;
pub mod lifecycle;
pub mod portmap;
pub mod mirror;
pub mod proc;
pub mod rtc;
pub mod rtc_log;
pub mod secrets;
pub mod catalog;
pub mod network;
pub mod store;
pub mod store_cmd;
pub mod tex;
pub mod terminal;
pub mod texcache;
pub mod tinytex;
pub mod transport;
pub mod worker;
pub mod worker_bridge;
pub mod worker_service;

use mirror::{Listed, MirrorState, PickedFolders};
use tauri::{Emitter, Manager, State};

#[tauri::command]
fn tex_detect() -> Option<tex::EngineInfo> {
    tex::detect_fresh()
}

/// Compiles on a blocking thread so the UI stays responsive. Packages the compiler downloads on the way are reported as
/// `compile://package` events. `build` names the build for `tex_cancel`, which kills its process tree.
#[tauri::command]
async fn tex_compile(app: tauri::AppHandle, req: tex::CompileReq, build: Option<String>) -> Result<tex::CompileResp, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let emitter = app.clone();
    let on_download: tex::OnDownload = std::sync::Arc::new(move |file: &str| {
        let _ = emitter.emit("compile://package", file.to_string());
    });
    tauri::async_runtime::spawn_blocking(move || tex::compile_build(&root, req, Some(on_download), build.as_deref()))
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
    let _exclusive = maintenance::COMPILER_ACTIVITY.try_write().map_err(|_| "A compile or compiler installation is active; wait for it to finish.".to_string())?;
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
    let res = managed::install(&client, &root, asset, &progress).await;
    tex::forget_engine();
    res
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
    let _exclusive = maintenance::COMPILER_ACTIVITY.try_write().map_err(|_| "A compile or compiler installation is active; wait for it to finish.".to_string())?;
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let res = managed::remove(&root, &component);
    tex::forget_engine();
    res?;
    if component == "tectonic" {
        maintenance::remove_owned_tree(&root.join("tectonic-cache"))?;
    }
    Ok(())
}

#[tauri::command]
fn compiler_cache_clear(app: tauri::AppHandle) -> Result<(), String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    maintenance::clear_compiler_cache(&root)
}

/// The last start-up compiler check (compiler_health.rs), for Account > Compiler.
#[tauri::command]
fn compiler_health(app: tauri::AppHandle) -> Result<Option<compiler_health::Report>, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(compiler_health::last(&root))
}

/// Checks (and repairs) the compiler now; also announced as `compiler://health`.
#[tauri::command]
async fn compiler_health_check(app: tauri::AppHandle) -> Result<compiler_health::Report, String> {
    run_compiler_check(app).await
}

/// Uses a system TeX that an earlier check set aside, then checks again.
#[tauri::command]
async fn compiler_use_system_tex(app: tauri::AppHandle) -> Result<compiler_health::Report, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    compiler_health::use_system_tex(&root);
    run_compiler_check(app).await
}

async fn run_compiler_check(app: tauri::AppHandle) -> Result<compiler_health::Report, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let report = tauri::async_runtime::spawn_blocking(move || compiler_health::run(&root)).await.map_err(|e| e.to_string())?;
    let _ = app.emit("compiler://health", report.clone());
    Ok(report)
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

/// Desktop UI tests (test-picker builds): folders and terminals are not really opened; what would have been opened is
/// appended to `<test pick dir>/.opened` so a test can check it. Returns true when the request was recorded.
fn record_open_for_tests(_what: &str, _path: &std::path::Path) -> bool {
    #[cfg(feature = "test-picker")]
    if let Some(base) = test_picker::base() {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(base.join(".opened")) {
            let _ = writeln!(f, "{_what} {}", _path.display());
        }
        return true;
    }
    false
}

/// Shows a bound folder, or a file in it (`rel`), selected in the system file manager. Only bound folders, never an
/// arbitrary path; `rel` must stay inside the folder.
#[tauri::command]
fn mirror_reveal(app: tauri::AppHandle, state: State<'_, MirrorState>, id: String, rel: Option<String>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = state.root_dir(&id)?;
    let target = match rel.as_deref() {
        Some(r) if !r.is_empty() => mirror::resolve_inside(&dir, r)?,
        _ => dir,
    };
    if record_open_for_tests("reveal", &target) {
        return Ok(());
    }
    app.opener().reveal_item_in_dir(target).map_err(|e| e.to_string())
}

/// Opens a bound folder itself in the system file manager.
#[tauri::command]
fn mirror_open(app: tauri::AppHandle, state: State<'_, MirrorState>, id: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = state.root_dir(&id)?;
    if record_open_for_tests("folder", &dir) {
        return Ok(());
    }
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Opens the system terminal in a bound folder (ready for `claude`, `codex`...). Without a known terminal, the folder
/// opens instead and the error says why.
#[tauri::command]
fn mirror_open_terminal(app: tauri::AppHandle, state: State<'_, MirrorState>, id: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = state.root_dir(&id)?;
    if record_open_for_tests("terminal", &dir) {
        return Ok(());
    }
    terminal::open(&dir).inspect_err(|_| {
        let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
    })
}

/// Creates (or reuses) `<Documents>/HiveTeX/<slug>` for a project kept in the app, at the member's request, and records
/// it as a folder the user chose. The path is built here, never taken from the page (see mirror::default_project_folder).
#[tauri::command]
fn mirror_default_folder(app: tauri::AppHandle, picked: State<'_, PickedFolders>, slug: String, project_id: String) -> Result<String, String> {
    #[cfg(feature = "test-picker")]
    let test_docs = test_picker::base();
    #[cfg(not(feature = "test-picker"))]
    let test_docs: Option<std::path::PathBuf> = None;
    let docs = match test_docs {
        Some(d) => d,
        None => app.path().document_dir().or_else(|_| app.path().home_dir()).map_err(|e| e.to_string())?,
    };
    let dir = mirror::default_project_folder(&docs, &slug, &project_id)?;
    picked.add(&dir)?;
    // the plain path (not the canonical \? form on Windows): it is shown and copied; binding compares canonically
    Ok(dir.to_string_lossy().to_string())
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
fn mirror_retained(state: State<'_, MirrorState>, id: String) -> Result<Vec<Listed>, String> {
    state.retained(&id)
}

#[tauri::command]
fn mirror_read(state: State<'_, MirrorState>, id: String, path: String) -> Result<Option<String>, String> {
    state.read(&id, &path)
}

#[tauri::command]
fn mirror_write(state: State<'_, MirrorState>, id: String, path: String, b64: String) -> Result<Option<String>, String> {
    state.write(&id, &path, &b64)
}

#[tauri::command]
fn mirror_remove(state: State<'_, MirrorState>, id: String, path: String) -> Result<Option<String>, String> {
    state.remove(&id, &path)
}

#[tauri::command]
fn mirror_drop_retained(state: State<'_, MirrorState>, id: String, path: String) -> Result<(), String> {
    state.drop_retained(&id, &path)
}

fn rtc_emit(app: tauri::AppHandle) -> rtc::Emit {
    std::sync::Arc::new(move |name, payload| {
        let _ = app.emit(&name, payload);
    })
}

#[tauri::command]
async fn rtc_create(app: tauri::AppHandle, state: State<'_, rtc::RtcState>, id: String, ice: Vec<rtc::IceServer>, policy: Option<String>) -> Result<(), String> {
    state.create_opts(&id, ice, rtc_emit(app), false, policy.as_deref()).await
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
fn texcache_contains(cache: State<'_, texcache::TexCache>, rel: String) -> Result<bool, String> {
    let path = texcache::safe_rel(&rel).ok_or("Invalid TeX cache path")?;
    Ok(cache.stats_contains(&path))
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
    /// Requests still waiting for an answer: a window opened for one fetches them (the event may predate it).
    requests: std::sync::Arc<std::sync::Mutex<Vec<helper::PairRequest>>>,
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
        let requests: std::sync::Arc<std::sync::Mutex<Vec<helper::PairRequest>>> = Default::default();
        let (handle, waiting, open) = (app.clone(), pending.clone(), requests.clone());
        let confirm: helper::ConfirmFn = std::sync::Arc::new(move |req: helper::PairRequest| {
            let (tx, rx) = std::sync::mpsc::channel();
            waiting.lock().unwrap().insert(req.id.clone(), tx);
            open.lock().unwrap().push(req.clone());
            // Browser-requested pairing always gets a visible window, even when it was closed to the tray.
            lifecycle::show_main(&handle);
            let _ = handle.emit("helper://pair-request", req.clone());
            let answer = rx.recv_timeout(std::time::Duration::from_secs(60)).unwrap_or(false);
            waiting.lock().unwrap().remove(&req.id);
            open.lock().unwrap().retain(|r| r.id != req.id);
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
        HelperState { helper, settings_path, settings: std::sync::Mutex::new(settings), pending, requests }
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

/// Desktop UI tests only (`test-picker` builds): close the main window the way the title-bar button does.
#[tauri::command]
fn test_close_main(app: tauri::AppHandle) -> Result<(), String> {
    if !cfg!(feature = "test-picker") { return Err("not available".into()); }
    let app2 = app.clone();
    // After this command has answered, so the page is not torn down mid-reply.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        if let Some(w) = app2.get_webview_window("main") { let _ = w.close(); }
    });
    Ok(())
}

/// Desktop soak tests only (`test-picker` builds): what the network monitor does after a route change or a resume
/// from sleep (new transport generation, `native.resume` to the worker, UPnP remapped).
#[tauri::command]
fn test_network_change(app: tauri::AppHandle, resumed: bool) -> Result<(), String> {
    if !cfg!(feature = "test-picker") { return Err("not available".into()); }
    let rtc = app.state::<rtc::RtcState>();
    let generation = rtc.transport.generation() + 1;
    rtc.transport.advance(generation);
    app.state::<worker_service::WorkerService>().notify("native.resume", serde_json::json!({ "generation": generation, "resumed": resumed, "online": true }));
    let upnp = app.state::<portmap::UpnpState>();
    if let (Some(mapper), true) = (upnp.existing(), upnp.wanted.load(std::sync::atomic::Ordering::SeqCst)) {
        tauri::async_runtime::spawn(async move { mapper.enable() });
    }
    Ok(())
}

/// Pairing requests still waiting for the user (a just-opened window shows them).
#[tauri::command]
fn helper_pending(state: State<'_, HelperState>) -> Vec<helper::PairRequest> {
    state.requests.lock().unwrap().clone()
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
    // The WebRTC stack's own warnings, for connection reports (masked, bounded; src/rtc_log.rs).
    rtc_log::install();
    let context = tauri::generate_context!();
    #[cfg(all(target_os = "windows", feature = "test-picker"))]
    let context = {
        let mut context = context;
        if let Some(args) = std::env::var("HIVETEX_TEST_CDP_PORT").ok().as_deref().and_then(test_cdp_args) {
            for window in &mut context.config_mut().app.windows {
                window.additional_browser_args = Some(args.clone());
            }
        }
        context
    };
    let builder = tauri::Builder::default();
    // A second launch focuses the running instance (one worker, one network identity per project).
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| lifecycle::show_main(app)));
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    // Launch at login, registered only when the user selects it (lifecycle::startup_set); no page permission.
    #[cfg(desktop)]
    let autostart = tauri_plugin_autostart::Builder::new()
        .args([lifecycle::BACKGROUND_ARG])
        .app_name(if cfg!(feature = "test-picker") { "HiveTeX E2E" } else { "HiveTeX" });
    #[cfg(target_os = "macos")]
    let autostart = autostart.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);
    #[cfg(desktop)]
    let builder = builder.plugin(autostart.build());
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
            // Before anything detects a compiler: a system TeX that an earlier check set aside stays aside.
            compiler_health::restore(&dir);
            app.manage(texcache::TexCache::new(dir.join("texcache")));
            app.manage(PickedFolders::load(dir.join("picked-folders.json")));
            app.manage(HelperState::start(app.handle(), &dir));
            // The fixed worker restores its scoped dormant catalog without requiring an editor.
            let started = worker_service::WorkerService::start(app.handle());
            if let Err(e) = &started {
                eprintln!("sync worker unavailable ({e}); open the app to inspect synchronization status");
            }
            // `--self-check` (release packaging, 12.1/12.2): the installed app verifies and starts its bundled worker
            // (no system Node), waits for its handshake, and exits 0, or 1 with the reason. No window, no tray.
            if std::env::args().any(|a| a == "--self-check") {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let ok = started.is_ok() && (0..600).any(|_| {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        handle.state::<worker_service::WorkerService>().is_ready()
                    });
                    println!("{}", if ok { "self-check: sync worker ready" } else { "self-check: sync worker did not start" });
                    handle.state::<worker_service::WorkerService>().stop();
                    handle.state::<lifecycle::Lifecycle>().quitting.store(true, std::sync::atomic::Ordering::SeqCst);
                    handle.exit(if ok { 0 } else { 1 });
                });
                return Ok(());
            }
            lifecycle::setup_tray(app.handle());
            #[cfg(feature = "test-picker")]
            lifecycle::test_monitor(app.handle());
            // Compiler check at every start (compiler_health.rs): compile a minimal document and repair the compiler if
            // that fails, before the user's first build does. Shortly after start, so it does not compete with it.
            // Desktop UI test builds skip it unless HIVETEX_COMPILER_CHECK=1 (no downloads, no timing changes).
            if !cfg!(feature = "test-picker") || std::env::var_os("HIVETEX_COMPILER_CHECK").is_some() {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    if let Err(e) = run_compiler_check(handle).await {
                        eprintln!("compiler check: {e}");
                    }
                });
            }
            // The firewall question at launch, not in the middle of a session: Windows asks the first time a program
            // opens a socket that can receive, which otherwise happens at the first peer connection. Bind the shared
            // UDP listener (the one every peer connection of this network uses) and release it shortly after. Windows
            // remembers the answer for this program path, so an installed app asks once.
            {
                let transport = app.state::<rtc::RtcState>().transport.clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(lease) = transport.acquire().await {
                        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                        drop(lease);
                    }
                });
            }
            // Desktop UI tests only: close the window shortly after start, as the title-bar button does (lifecycle.mjs).
            if cfg!(feature = "test-picker") {
                // ... or run the post-update restart path once (the restarted app does not repeat it).
                if let Some(ms) = std::env::var("HIVETEX_TEST_RESTART_MS").ok().and_then(|v| v.parse::<u64>().ok()) {
                    std::env::remove_var("HIVETEX_TEST_RESTART_MS");
                    let handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                        let _ = lifecycle::app_restart(handle).await;
                    });
                }
                if let Some(ms) = std::env::var("HIVETEX_TEST_CLOSE_MAIN_MS").ok().and_then(|v| v.parse::<u64>().ok()) {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(ms));
                        if let Some(w) = handle.get_webview_window("main") { let _ = w.close(); }
                    });
                }
            }
            let args: Vec<String> = std::env::args().collect();
            let requested_open = app.state::<lifecycle::Lifecycle>().finish_setup();
            if requested_open || !lifecycle::background_launch(&args, lifecycle::load_settings(app.handle())) {
                lifecycle::show_main(app.handle());
            }
            Ok(())
        })
        .manage(MirrorState::default())
        .manage(rtc::RtcState::default())
        .manage(portmap::UpnpState::default())
        .manage(lifecycle::Lifecycle::default())
        .on_window_event(|window, event| lifecycle::window_event(window, event))
        .manage(store::StoreState::default())
        .manage(worker_service::WorkerService::default())
        .invoke_handler(tauri::generate_handler![
            worker_service::worker_request,
            worker_service::worker_diagnostics,
            lifecycle::app_quit,
            helper_pending,
            test_close_main,
            test_network_change,
            portmap::upnp_status,
            lifecycle::app_restart,
            lifecycle::startup_get,
            lifecycle::startup_set,
            tex_detect,
            compiler_health,
            compiler_health_check,
            compiler_use_system_tex,
            tex_compile,
            tex::tex_cancel,
            texcache_set_upstream,
            managed_install,
            managed_status,
            managed_remove,
            texcache_stats,
            texcache_contains,
            texcache_clear,
            compiler_cache_clear,
            mirror_pick,
            mirror_bind,
            mirror_unbind,
            mirror_reveal,
            mirror_open,
            mirror_open_terminal,
            mirror_default_folder,
            mirror_list,
            mirror_retained,
            mirror_read,
            mirror_write,
            mirror_remove,
            mirror_drop_retained,
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
            helper_revoke,
            store_cmd::store_open,
            store_cmd::store_close,
            store_cmd::store_delete,
            store_cmd::store_exists,
            store_cmd::store_transact,
            store_cmd::store_load,
            store_cmd::store_list_docs,
            store_cmd::store_export_open,
            store_cmd::store_export_read,
            store_cmd::store_export_close,
            store_cmd::store_put_blob,
            store_cmd::store_stage_chunk,
            store_cmd::store_stage_commit,
            store_cmd::store_stage_abort,
            store_cmd::store_blob_size,
            store_cmd::store_read_blob,
            store_cmd::store_list_blobs,
            store_cmd::store_put_snapshot,
            store_cmd::store_list_snapshots,
            store_cmd::store_get_meta,
            store_cmd::store_list_meta,
            store_cmd::store_put_change,
            store_cmd::store_list_changes,
            store_cmd::store_prune_changes,
            store_cmd::store_ingress_put,
            store_cmd::store_ingress_ack,
            store_cmd::store_ingress_pending,
            store_cmd::store_ingress_page,
            store_cmd::store_ingress_deny,
            store_cmd::store_ingress_get,
            store_cmd::migration_manifest_read,
            store_cmd::migration_manifest_write,
            store_cmd::recovery_save_begin,
            store_cmd::recovery_save_append,
            store_cmd::recovery_save_finish,
            store_cmd::recovery_save_abort
        ])
        .build(context)
        .expect("error while running HiveTeX")
        .run(|app, event| {
            // Closing the last window keeps background synchronization running; only Quit exits.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                if lifecycle::keep_running(app, *code) {
                    api.prevent_exit();
                }
            }
            if let tauri::RunEvent::Exit = event {
                // Orderly quit: remove an owned router mapping (bounded by the three-second cleanup deadline).
                if let Some(mapper) = app.state::<portmap::UpnpState>().existing() {
                    tauri::async_runtime::block_on(mapper.disable());
                }
            }
        });
}

#[cfg(any(test, all(target_os = "windows", feature = "test-picker")))]
fn test_cdp_args(port: &str) -> Option<String> {
    let port: u16 = port.parse().ok()?;
    (port >= 1024).then(|| format!("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --remote-debugging-port={port}"))
}

/// Desktop UI tests: the "picked" folder is `$HIVETEX_TEST_PICK_DIR`, or the sub-folder named in its `.next-pick`
/// file (consumed), so a test can choose a different folder for each pick. Only compiled with `--features test-picker`.
#[cfg(feature = "test-picker")]
mod test_picker {
    use std::path::PathBuf;

    /// `--test-pick-dir <dir>` (WebDriver drivers forward app arguments, not always the environment) or the variable.
    pub fn base() -> Option<PathBuf> {
        let mut args = std::env::args_os().skip_while(|a| a != "--test-pick-dir");
        let from_args = args.nth(1);
        Some(PathBuf::from(from_args.or_else(|| std::env::var_os("HIVETEX_TEST_PICK_DIR"))?))
    }

    pub fn next() -> Option<PathBuf> {
        let base = base()?;
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
    #[test]
    fn test_cdp_port_accepts_only_unprivileged_numeric_ports() {
        assert!(super::test_cdp_args("9451").unwrap().ends_with("--remote-debugging-port=9451"));
        for valid in ["1024", "65535"] { assert!(super::test_cdp_args(valid).is_some()); }
        for invalid in ["0", "1023", "65536", "9451 --remote-debugging-address=0.0.0.0", ""] {
            assert!(super::test_cdp_args(invalid).is_none());
        }
    }
    /// The test picker must never be part of a default (release) build.
    #[test]
    fn test_picker_is_not_a_default_feature() {
        let manifest = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).unwrap();
        assert!(manifest.contains("test-picker = [\"tauri-plugin-single-instance/hivetex-test\"]"));
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
        // The opener may only open the GitHub authorize page and this project's releases page (update badge).
        let opener = cap["permissions"].as_array().unwrap().iter().find(|p| p["identifier"] == "opener:allow-open-url").expect("opener scoped permission");
        assert_eq!(
            opener["allow"],
            serde_json::json!([{ "url": "https://github.com/login/oauth/authorize*" }, { "url": "https://github.com/federicocunico/HiveTeX/releases*" }])
        );
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
        // http://ipc.localhost and http://texcache.localhost are the app's own protocols on Windows, not the network
        assert!(!csp.replace("http://ipc.localhost", "").replace("http://texcache.localhost", "").contains("http:"), "plain http connections are not allowed");
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
