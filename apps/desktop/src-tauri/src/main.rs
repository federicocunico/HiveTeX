#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|a| a == "--uninstall-cleanup") {
        #[cfg(windows)]
        {
            let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
            let startup_name = if cfg!(feature = "test-picker") { "HiveTeX E2E" } else { &context.package_info().name };
            match hivetex_desktop_lib::maintenance::uninstall(&context.config().identifier, startup_name) {
                Ok(()) => std::process::exit(0),
                Err(e) => {
                    eprintln!("HiveTeX uninstall cleanup: {e}");
                    if let Some(log) = std::env::var_os("HIVETEX_MAINTENANCE_LOG") { let _ = std::fs::write(log, &e); }
                    std::process::exit(1);
                }
            }
        }
        #[cfg(not(windows))]
        std::process::exit(1);
    }
    hivetex_desktop_lib::run()
}
