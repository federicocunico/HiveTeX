//! "Open in terminal" for a project folder: the system's terminal, started in the folder (for `claude`, `codex`, ...).
//! The folder is always a bound project root chosen on the native side; it is passed as the working directory or as a
//! single argument, never inside a shell command string.

use std::path::Path;
use std::process::Command;

#[derive(Debug, PartialEq)]
pub struct Launch {
    pub program: &'static str,
    /// Arguments; `{dir}` stands for the folder.
    pub args: Vec<&'static str>,
    /// Windows: open a new console window for the program.
    pub new_console: bool,
}

/// The terminal to start on `os`, given which executables exist (`has`). Pure, so every platform is testable.
pub fn choose(os: &str, has: &dyn Fn(&str) -> bool) -> Option<Launch> {
    let l = |program, args: &[&'static str]| Some(Launch { program, args: args.to_vec(), new_console: false });
    match os {
        "windows" => {
            // Windows Terminal; `-d .` = the working directory we start it in (a path argument could contain `;`,
            // which wt treats as a command separator).
            if has("wt.exe") {
                l("wt.exe", &["-d", "."])
            } else {
                Some(Launch { program: "cmd.exe", args: vec!["/K"], new_console: true })
            }
        }
        "macos" => l("open", &["-a", "Terminal", "{dir}"]),
        _ => {
            let candidates: [(&'static str, &[&'static str]); 7] = [
                ("x-terminal-emulator", &[]),
                ("gnome-terminal", &["--working-directory={dir}"]),
                ("konsole", &["--workdir", "{dir}"]),
                ("xfce4-terminal", &["--working-directory={dir}"]),
                ("kitty", &["--directory", "{dir}"]),
                ("alacritty", &["--working-directory", "{dir}"]),
                ("xterm", &[]),
            ];
            candidates.into_iter().find(|(p, _)| has(p)).and_then(|(p, a)| l(p, a))
        }
    }
}

/// Whether `name` is an executable on PATH.
pub fn on_path(name: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|paths| std::env::split_paths(&paths).any(|d| d.join(name).is_file()))
}

/// Starts the terminal in `dir`. Err when no known terminal exists (the caller opens the folder instead).
pub fn open(dir: &Path) -> Result<(), String> {
    let launch = choose(std::env::consts::OS, &on_path).ok_or("No terminal app was found on this computer.")?;
    let d = dir.to_string_lossy();
    let mut cmd = Command::new(launch.program);
    cmd.current_dir(dir);
    for a in &launch.args {
        cmd.arg(a.replace("{dir}", &d));
    }
    #[cfg(windows)]
    if launch.new_console {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        cmd.creation_flags(CREATE_NEW_CONSOLE);
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("Could not open a terminal: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_prefers_windows_terminal_then_a_new_cmd_window() {
        let wt = choose("windows", &|n| n == "wt.exe").unwrap();
        assert_eq!((wt.program, wt.args, wt.new_console), ("wt.exe", vec!["-d", "."], false));
        let cmd = choose("windows", &|_| false).unwrap();
        assert_eq!((cmd.program, cmd.new_console), ("cmd.exe", true));
    }

    #[test]
    fn macos_opens_terminal_app_on_the_folder() {
        assert_eq!(choose("macos", &|_| false).unwrap().args, vec!["-a", "Terminal", "{dir}"]);
    }

    #[test]
    fn linux_takes_the_first_terminal_available_or_none() {
        assert_eq!(choose("linux", &|n| n == "x-terminal-emulator" || n == "xterm").unwrap().program, "x-terminal-emulator");
        assert_eq!(choose("linux", &|n| n == "konsole").unwrap().args, vec!["--workdir", "{dir}"]);
        assert_eq!(choose("linux", &|n| n == "gnome-terminal").unwrap().args, vec!["--working-directory={dir}"]);
        assert_eq!(choose("linux", &|n| n == "xterm").unwrap().program, "xterm");
        assert_eq!(choose("linux", &|_| false), None);
    }
}

#[cfg(test)]
mod real_tests {
    /// Opens a real terminal window (manual check): HIVETEX_REAL_TERMINAL=1 cargo test --lib real_terminal -- --ignored
    #[test]
    #[ignore]
    fn real_terminal_opens_in_the_folder() {
        if std::env::var("HIVETEX_REAL_TERMINAL").is_err() {
            return;
        }
        let d = std::env::temp_dir().join("hivetex terminal; check");
        std::fs::create_dir_all(&d).unwrap();
        super::open(&d).unwrap();
    }
}
