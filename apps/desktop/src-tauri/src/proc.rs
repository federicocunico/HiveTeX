//! Programs the app starts on its own (TeX detection, builds, tlmgr, ...) run without a window: on Windows a console
//! program started from a GUI app otherwise opens a console that flashes and can take focus. Its children inherit the
//! hidden console. Every background launch goes through `background_command`; only "Open in terminal" (terminal.rs)
//! is meant to be seen.

use std::ffi::OsStr;
use std::process::{Command, Stdio};

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A `Command` for a program the user does not need to see: no window, no input.
pub fn background_command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[cfg(windows)]
    #[test]
    fn console_program_runs_hidden() {
        let out = background_command("cmd").args(["/c", "echo hidden"]).output().unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hidden");
    }

    #[cfg(unix)]
    #[test]
    fn program_runs() {
        assert!(background_command("true").status().unwrap().success());
    }

    /// Lines of `src` that start a process directly instead of through `background_command`.
    fn raw_launches(src: &str) -> Vec<String> {
        let mut out = Vec::new();
        for line in src.lines() {
            let code = line.trim_start();
            if code.starts_with("//") {
                continue;
            }
            // test modules sit at the end of each file
            if code.starts_with("#[cfg(test)]") {
                break;
            }
            if code.contains("Command::new(") {
                out.push(line.trim().to_string());
            }
        }
        out
    }

    #[test]
    fn every_launch_is_hidden() {
        const ALLOWED: [&str; 2] = ["proc.rs", "terminal.rs"]; // the helper itself; a terminal the user asked for
        let mut found = Vec::new();
        let mut stack = vec![Path::new(env!("CARGO_MANIFEST_DIR")).join("src")];
        while let Some(dir) = stack.pop() {
            for e in std::fs::read_dir(&dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.extension().is_some_and(|x| x == "rs") && !ALLOWED.iter().any(|a| p.ends_with(a)) {
                    let src = std::fs::read_to_string(&p).unwrap();
                    found.extend(raw_launches(&src).into_iter().map(|l| format!("{}: {l}", p.display())));
                }
            }
        }
        assert!(found.is_empty(), "start background programs with proc::background_command:\n{}", found.join("\n"));
    }

    #[test]
    fn guard_sees_raw_launches_but_not_comments_or_tests() {
        let src = "fn a() { std::process::Command::new(\"x\"); }\n// Command::new(\"y\")\n#[cfg(test)]\nmod t { fn b() { Command::new(\"z\"); } }\n";
        assert_eq!(raw_launches(src), vec!["fn a() { std::process::Command::new(\"x\"); }"]);
    }
}
