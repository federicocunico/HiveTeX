//! Missing packages for the TinyTeX that HiveTeX installed itself: when a build fails because a file is not found,
//! find the package providing it (`tlmgr search --global --file`), install it (`tlmgr install`) and build again.
//! Never used for a TeX installation HiveTeX did not install.

use std::path::{Path, PathBuf};
use crate::proc::background_command;

/// Rounds of "install what is missing, build again" per compile.
pub const MAX_ROUNDS: usize = 3;

/// Files a LaTeX log reports as missing (``! LaTeX Error: File `tikz-cd.sty' not found.``).
pub fn missing_files(log: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in log.lines() {
        if let Some(rest) = line.split("! LaTeX Error: File `").nth(1) {
            if let Some(name) = rest.split("' not found").next() {
                let name = name.trim();
                let ok = !name.is_empty() && name.len() < 128 && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
                if ok && !out.iter().any(|n| n == name) {
                    out.push(name.to_string());
                }
            }
        }
    }
    out
}

/// A TeX Live package name we are willing to pass to tlmgr.
pub fn valid_package(name: &str) -> bool {
    !name.is_empty() && name.len() < 64 && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Package name from `tlmgr search --global --file /<file>` output (`tikz-cd:` followed by indented paths).
pub fn package_from_search(output: &str, file: &str) -> Option<String> {
    let mut current: Option<&str> = None;
    for line in output.lines() {
        if !line.starts_with(char::is_whitespace) && line.trim_end().ends_with(':') {
            current = Some(line.trim_end().trim_end_matches(':'));
        } else if let Some(pkg) = current {
            // exact file match (…/<file>), not a substring of another file name
            if line.trim().rsplit('/').next() == Some(file) && valid_package(pkg) {
                return Some(pkg.to_string());
            }
        }
    }
    None
}

/// Runs tlmgr with fixed arguments; returns (success, stdout + stderr). Replaceable in tests.
pub type Runner<'a> = &'a dyn Fn(&[&str]) -> Option<(bool, String)>;

pub fn tlmgr_runner<'a>(bin_dir: &'a Path, deadline: std::time::Instant, memory_mb: u64, on_timeout: &'a dyn Fn()) -> impl Fn(&[&str]) -> Option<(bool, String)> + 'a {
    let exe: PathBuf = if cfg!(windows) { bin_dir.join("tlmgr.bat") } else { bin_dir.join("tlmgr") };
    move |args: &[&str]| {
        let mut cmd = background_command(&exe);
        cmd.args(args);
        let (ok, timed_out, text) = crate::tex::run_package(cmd, deadline.saturating_duration_since(std::time::Instant::now()), memory_mb).ok()?;
        if timed_out { on_timeout(); return None; }
        Some(outcome(ok, text))
    }
}

/// tlmgr's result from its exit status and output. `tlmgr.bat` exits 0 even when tlmgr stopped ("Terminating"), so a
/// stop it reports counts as a failure whatever the status says.
fn outcome(exit_ok: bool, text: String) -> (bool, String) {
    let stopped = text.lines().any(|l| l.contains(": Terminating"));
    (exit_ok && !stopped, text)
}

/// Installs the packages providing `files`; reports each with `on_install`. Returns the packages installed.
/// `tried` remembers files already attempted in this compile, so an unresolvable file cannot loop.
pub fn install_missing(files: &[String], tried: &mut Vec<String>, run: Runner, on_install: &dyn Fn(&str)) -> Vec<String> {
    let mut installed = Vec::new();
    for f in files {
        if tried.contains(f) {
            continue;
        }
        tried.push(f.clone());
        let Some((true, out)) = run(&["search", "--global", "--file", &format!("/{f}")]) else { continue };
        let Some(pkg) = package_from_search(&out, f) else { continue };
        on_install(&pkg);
        let mut res = run(&["install", &pkg]);
        // A TinyTeX older than its repository refuses to install until tlmgr updates itself (once).
        if matches!(&res, Some((false, out)) if out.contains("tlmgr itself needs to be updated")) {
            if let Some((true, _)) = run(&["update", "--self"]) {
                // On Windows the self-update completes in a separate process after tlmgr exits: retry a few times.
                for attempt in 0..5 {
                    res = run(&["install", &pkg]);
                    if res.is_none() { break; }
                    if matches!(res, Some((true, _))) {
                        break;
                    }
                    if cfg!(not(test)) {
                        std::thread::sleep(std::time::Duration::from_secs(2 + attempt));
                    }
                }
            }
        }
        if let Some((true, _)) = res {
            installed.push(pkg);
        }
    }
    installed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const LOG: &str = "(./main.tex\n! LaTeX Error: File `tikz-cd.sty' not found.\n\nType X to quit\n! LaTeX Error: File `tikz-cd.sty' not found.\n! LaTeX Error: File `../../etc/passwd' not found.\n";
    const SEARCH: &str = "tlmgr: package repository https://mirror.example/tlnet\ntikz-cd:\n\ttexmf-dist/tex/latex/tikz-cd/tikz-cd.sty\nother:\n\ttexmf-dist/tex/latex/other/not-tikz-cd.sty\n";

    #[test]
    fn finds_missing_files_once_and_ignores_odd_names() {
        assert_eq!(missing_files(LOG), vec!["tikz-cd.sty".to_string()]);
    }

    #[test]
    fn picks_the_package_with_the_exact_file() {
        assert_eq!(package_from_search(SEARCH, "tikz-cd.sty").as_deref(), Some("tikz-cd"));
        assert_eq!(package_from_search(SEARCH, "missing.sty"), None);
        assert!(!valid_package("evil; rm -rf /"));
        assert!(!valid_package("Tikz"));
    }

    #[test]
    fn updates_tlmgr_itself_when_it_is_too_old() {
        let calls = RefCell::new(Vec::<String>::new());
        let updated = RefCell::new(false);
        let run = |args: &[&str]| {
            calls.borrow_mut().push(args.join(" "));
            match args[0] {
                "search" => Some((true, SEARCH.to_string())),
                "update" => {
                    *updated.borrow_mut() = true;
                    Some((true, String::new()))
                }
                _ if *updated.borrow() => Some((true, String::new())),
                _ => Some((false, "tlmgr itself needs to be updated.
".to_string())),
            }
        };
        let mut tried = Vec::new();
        let got = install_missing(&["tikz-cd.sty".into()], &mut tried, &run, &|_| {});
        assert_eq!(got, vec!["tikz-cd"]);
        assert_eq!(*calls.borrow(), vec!["search --global --file /tikz-cd.sty", "install tikz-cd", "update --self", "install tikz-cd"]);
    }

    #[test]
    fn a_stop_reported_with_exit_code_zero_is_a_failure() {
        // what tlmgr.bat returns on Windows when tlmgr is too old for its repository
        let text = "tlmgr itself needs to be updated.\r\n===\r\ntlmgr.pl: Terminating; please see warning above!\r\n".to_string();
        assert!(!outcome(true, text).0);
        assert!(outcome(true, "[1/1] install: tikz-cd [7k]\r\nrunning mktexlsr ...\r\n".into()).0);
        assert!(!outcome(false, String::new()).0);
    }

    #[test]
    fn installs_each_missing_package_once_per_compile() {
        let calls = RefCell::new(Vec::<String>::new());
        let run = |args: &[&str]| {
            calls.borrow_mut().push(args.join(" "));
            Some((true, if args[0] == "search" { SEARCH.to_string() } else { String::new() }))
        };
        let reported = RefCell::new(Vec::<String>::new());
        let mut tried = Vec::new();
        let files = missing_files(LOG);
        let got = install_missing(&files, &mut tried, &run, &|p| reported.borrow_mut().push(p.into()));
        assert_eq!(got, vec!["tikz-cd"]);
        assert_eq!(*reported.borrow(), vec!["tikz-cd"]);
        // the same file in a later round is not tried again (loop guard)
        assert!(install_missing(&files, &mut tried, &run, &|_| {}).is_empty());
        assert_eq!(calls.borrow().iter().filter(|c| c.starts_with("install")).count(), 1);
    }
}
