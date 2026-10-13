//! Desktop application lifetime (D9, tasks 11.1-11.4): tray, close-to-background, single instance, launch at login,
//! start in background and durable quit.
//!
//! - Closing the main window destroys the editor webview (its attachments are detached in the worker) but keeps the
//!   process, the sync worker and the seeds running. **Open** (tray, second launch, browser pairing) recreates it.
//! - Without a tray the window is never hidden: closing minimizes it and the page explains how to pause or quit.
//! - **Quit** asks the worker to flush every project durably first. If that fails, the window opens with the failure
//!   and the recovery choices; only an explicit "quit anyway" exits.
//! - Launch at login is off until the user selects it; "start in background" then skips opening the window.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindowBuilder, Window, WindowEvent, Wry};

use crate::worker_service::WorkerService;

pub const BACKGROUND_ARG: &str = "--background";

#[derive(Default)]
pub struct Lifecycle {
    pub tray: AtomicBool,
    pub quitting: AtomicBool,
    paused: AtomicBool,
    items: Mutex<Option<(MenuItem<Wry>, MenuItem<Wry>)>>,
    refreshing: AtomicBool,
    last_refresh: Mutex<Option<Instant>>,
}

#[derive(Serialize, Deserialize, Default, Clone, Copy, PartialEq, Eq, Debug)]
pub struct StartupSettings {
    /// Start without opening the window when launched at login.
    #[serde(default)]
    pub background: bool,
}

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("startup.json"))
}

pub fn load_settings(app: &AppHandle) -> StartupSettings {
    settings_path(app).and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: StartupSettings) -> Result<(), String> {
    let p = settings_path(app).ok_or("no app data directory")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, serde_json::to_vec(&s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Whether this launch should stay in the background: launched at login with "start in background" selected.
pub fn background_launch(args: &[String], settings: StartupSettings) -> bool {
    settings.background && args.iter().any(|a| a == BACKGROUND_ARG)
}

/// Shows the main window, recreating it if it was closed.
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let Some(config) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() else { return };
    if let Ok(builder) = WebviewWindowBuilder::from_config(app, &config) {
        if let Ok(w) = builder.visible(true).build() {
            let _ = w.set_focus();
        }
    }
}

/// Creates the tray. On failure (no tray host, e.g. some Linux desktops) the app keeps a recoverable window.
pub fn setup_tray(app: &AppHandle) {
    let state = app.state::<Lifecycle>();
    let built = (|| -> tauri::Result<()> {
        let status = MenuItem::with_id(app, "status", "Starting…", false, None::<&str>)?;
        let open = MenuItem::with_id(app, "open", "Open HiveTeX", true, None::<&str>)?;
        let pause = MenuItem::with_id(app, "pause", "Pause all synchronization", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "Quit HiveTeX", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&status, &PredefinedMenuItem::separator(app)?, &open, &pause, &PredefinedMenuItem::separator(app)?, &quit])?;
        let mut tray = TrayIconBuilder::with_id("main")
            .tooltip("HiveTeX")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, e| match e.id.as_ref() {
                "open" => show_main(app),
                "pause" => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move { toggle_pause(&app).await });
                }
                "quit" => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = self::quit(&app, false).await;
                    });
                }
                _ => {}
            })
            .on_tray_icon_event(|tray, e| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                    show_main(tray.app_handle());
                }
            });
        if let Some(icon) = app.default_window_icon() {
            tray = tray.icon(icon.clone());
        }
        tray.build(app)?;
        *state.items.lock().unwrap() = Some((status, pause));
        Ok(())
    })();
    state.tray.store(built.is_ok(), Ordering::SeqCst);
    if let Err(e) = built {
        eprintln!("system tray unavailable ({e}); closing will minimize the window instead");
    }
}

/// Window close and destroy handling for the main window.
pub fn window_event(window: &Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    let app = window.app_handle();
    let state = app.state::<Lifecycle>();
    match event {
        WindowEvent::CloseRequested { api, .. } if !state.quitting.load(Ordering::SeqCst) && !state.tray.load(Ordering::SeqCst) => {
            // No tray: hiding would leave an unreachable app. Keep it as a minimized window and explain.
            api.prevent_close();
            let _ = window.minimize();
            let _ = window.emit("app://no-tray", ());
        }
        WindowEvent::Destroyed if !state.quitting.load(Ordering::SeqCst) => {
            // The editor is gone: release its attachments; background seeds continue in the worker.
            app.state::<WorkerService>().notify("native.renderer", json!({ "closed": true }));
        }
        _ => {}
    }
}

/// Keeps the process alive after the last window closes, unless the user quit.
pub fn keep_running(app: &AppHandle, code: Option<i32>) -> bool {
    code.is_none() && !app.state::<Lifecycle>().quitting.load(Ordering::SeqCst)
}

fn decode(v: Value) -> Value {
    match v {
        Value::String(s) => serde_json::from_str(&s).unwrap_or(Value::Null),
        other => other,
    }
}

/// The tray status line and paused flag from `catalog.list`.
pub fn summarize(list: &Value) -> (String, bool) {
    let paused = list["paused"] == true;
    let projects = list["projects"].as_array().cloned().unwrap_or_default();
    if paused {
        return ("Synchronization paused".into(), true);
    }
    if projects.is_empty() {
        return ("No projects kept in the background".into(), false);
    }
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for p in &projects {
        let label = match p["stage"].as_str().unwrap_or("") {
            "dormant" => "reachable on request",
            "waking" | "connecting" | "alone" => "waking",
            "receiving" | "reconciling" => "receiving",
            "synced" => "up to date",
            "queued" => "queued",
            "paused" | "disabled" => "paused",
            "auth-required" => "sign in needed",
            "ring-channel-unreachable" => "wake-up service unreachable",
            "save-failure" => "cannot save",
            _ => "offline",
        };
        match counts.iter_mut().find(|(l, _)| *l == label) {
            Some((_, n)) => *n += 1,
            None => counts.push((label, 1)),
        }
    }
    let n = projects.len();
    let parts: Vec<String> = counts.iter().map(|(l, c)| format!("{c} {l}")).collect();
    (format!("{n} project{}: {}", if n == 1 { "" } else { "s" }, parts.join(", ")), false)
}

/// Refreshes the tray status after a catalog change (coalesced to at most once a second).
pub fn catalog_changed(app: &AppHandle) {
    let state = app.state::<Lifecycle>();
    if !state.tray.load(Ordering::SeqCst) || state.refreshing.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let since = app.state::<Lifecycle>().last_refresh.lock().unwrap().map(|t| t.elapsed());
        if let Some(e) = since.filter(|e| *e < Duration::from_secs(1)) {
            tokio::time::sleep(Duration::from_secs(1) - e).await;
        }
        let list = app.state::<WorkerService>().call("catalog.list".into(), "null".into()).await.map(decode);
        let state = app.state::<Lifecycle>();
        *state.last_refresh.lock().unwrap() = Some(Instant::now());
        state.refreshing.store(false, Ordering::SeqCst);
        let Ok(list) = list else { return };
        let (text, paused) = summarize(&list);
        state.paused.store(paused, Ordering::SeqCst);
        if let Some((status, pause)) = state.items.lock().unwrap().as_ref() {
            let _ = status.set_text(&text);
            let _ = pause.set_text(if paused { "Resume synchronization" } else { "Pause all synchronization" });
        }
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_tooltip(Some(format!("HiveTeX: {text}")));
        }
    });
}

async fn toggle_pause(app: &AppHandle) {
    let paused = !app.state::<Lifecycle>().paused.load(Ordering::SeqCst);
    let _ = app.state::<WorkerService>().call("catalog.settings".into(), json!({ "paused": paused }).to_string()).await;
    catalog_changed(app);
}

/// Explicit quit. Returns the worker's answer; on `ok: false` the app stays open and the window shows the failure.
pub async fn quit(app: &AppHandle, discard: bool) -> Result<Value, String> {
    let state = app.state::<Lifecycle>();
    state.quitting.store(true, Ordering::SeqCst);
    let service = app.state::<WorkerService>();
    let answer = if service.generation() == 0 {
        json!({ "ok": true, "failing": [] })
    } else {
        match tokio::time::timeout(Duration::from_secs(20), service.call("app.quit".into(), json!({ "discard": discard }).to_string())).await {
            Ok(Ok(v)) => decode(v),
            // A worker that cannot answer holds no unsaved state beyond the native journal, which is durable.
            _ => json!({ "ok": true, "failing": [], "workerUnavailable": true }),
        }
    };
    if answer["ok"] != true {
        state.quitting.store(false, Ordering::SeqCst);
        show_main(app);
        let _ = app.emit("app://quit-failed", answer.clone());
        return Ok(answer);
    }
    finish(app).await;
    app.exit(0);
    Ok(answer)
}

/// Owned router mappings removed, worker stopped: the last steps before exit or restart.
async fn finish(app: &AppHandle) {
    if let Some(mapper) = app.state::<crate::portmap::UpnpState>().existing() {
        mapper.disable().await;
    }
    // Give the worker a moment to finish its own durable shutdown, then stop the supervisor.
    tokio::time::sleep(Duration::from_millis(300)).await;
    app.state::<WorkerService>().stop();
}

#[tauri::command]
pub async fn app_quit(app: AppHandle, discard: bool) -> Result<Value, String> {
    quit(&app, discard).await
}

/// After an installed update: quit durably (one seed, one network identity), then start the new version.
#[tauri::command]
pub async fn app_restart(app: AppHandle) -> Result<Value, String> {
    let state = app.state::<Lifecycle>();
    state.quitting.store(true, Ordering::SeqCst);
    let service = app.state::<WorkerService>();
    if service.generation() != 0 {
        let answer = decode(service.call("app.quit".into(), json!({ "discard": false }).to_string()).await.unwrap_or(json!("{\"ok\":true}")));
        if answer["ok"] != true {
            state.quitting.store(false, Ordering::SeqCst);
            let _ = app.emit("app://quit-failed", answer.clone());
            return Ok(answer);
        }
    }
    finish(&app).await;
    app.restart();
}

#[derive(Serialize)]
pub struct StartupState {
    login: bool,
    background: bool,
    tray: bool,
}

#[tauri::command]
pub fn startup_get(app: AppHandle) -> StartupState {
    use tauri_plugin_autostart::ManagerExt;
    StartupState {
        login: app.autolaunch().is_enabled().unwrap_or(false),
        background: load_settings(&app).background,
        tray: app.state::<Lifecycle>().tray.load(Ordering::SeqCst),
    }
}

/// Launch at login is registered only on the user's selection, and removed when deselected.
#[tauri::command]
pub fn startup_set(app: AppHandle, login: bool, background: bool) -> Result<StartupState, String> {
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    if login { launcher.enable() } else { launcher.disable() }.map_err(|e| e.to_string())?;
    save_settings(&app, StartupSettings { background })?;
    Ok(startup_get(app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_launch_needs_both_the_login_argument_and_the_setting() {
        let on = StartupSettings { background: true };
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(background_launch(&args(&["hivetex", BACKGROUND_ARG]), on));
        assert!(!background_launch(&args(&["hivetex"]), on), "a manual launch always opens the window");
        assert!(!background_launch(&args(&["hivetex", BACKGROUND_ARG]), StartupSettings::default()));
    }

    #[test]
    fn tray_status_distinguishes_project_states() {
        let list = json!({ "paused": false, "projects": [
            { "stage": "dormant" }, { "stage": "dormant" }, { "stage": "receiving" }, { "stage": "queued" },
            { "stage": "auth-required" }, { "stage": "ring-channel-unreachable" }, { "stage": "save-failure" }, { "stage": "offline" },
        ] });
        let (text, paused) = summarize(&list);
        assert!(!paused);
        assert_eq!(text, "8 projects: 2 reachable on request, 1 receiving, 1 queued, 1 sign in needed, 1 wake-up service unreachable, 1 cannot save, 1 offline");
        assert_eq!(summarize(&json!({ "paused": true, "projects": [{ "stage": "dormant" }] })), ("Synchronization paused".into(), true));
        assert_eq!(summarize(&json!({ "paused": false, "projects": [] })).0, "No projects kept in the background");
        assert_eq!(summarize(&json!({ "paused": false, "projects": [{ "stage": "synced" }] })).0, "1 project: 1 up to date");
    }
}
