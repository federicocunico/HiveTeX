//! Compiler check at every start: compiles a minimal document with the compiler this device would use and, when that
//! fails, repairs it step by step (field reports 2026-10-14: compiles broken on customer machines). A detected compiler
//! is not necessarily a working one: a TeX Live / MiKTeX whose format files or package database broke, a managed
//! installation left half-written, or a stale compiler cache all pass detection (`--version`) and fail every build.
//!
//! Repair ladder, stopping at the first step after which the check document compiles:
//! 1. clear the compiler caches (build outputs, downloaded packages; documents and installations stay);
//! 2. a managed compiler (full LaTeX / quick compiler) is downloaded and installed again;
//! 3. a system TeX that still fails is set aside (this device then uses a managed compiler: an installed one, or the
//!    quick compiler, downloaded now). "Use system TeX again" in Account > Compiler undoes it.
//!
//! A failure that looks like missing network (a package download) is reported, not repaired: nothing is broken.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The document every check compiles: standard packages only, so any working LaTeX builds it.
pub const CHECK_DOC: &str = "\\documentclass{article}\n\\begin{document}\nHiveTeX compiler check.\n\\end{document}\n";
const CHECK_PROJECT: &str = "__compiler-check";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// `ok`, `repaired`, `failed`, `offline` (a download failed: nothing repaired), `none` (no compiler on this device).
    pub state: String,
    /// The compiler that built the check document, or the one that failed.
    pub compiler: Option<String>,
    /// What was tried, in order (repairs only).
    pub steps: Vec<String>,
    /// The end of the last failing build log.
    pub log: String,
    /// Unix milliseconds.
    pub at: u64,
}

pub enum Probe {
    Ok { compiler: String },
    NoCompiler,
    Failed { compiler: String, log: String },
}

/// What the check may do; the real one compiles and installs, tests script the outcomes.
pub trait Toolbox {
    fn probe(&self) -> Probe;
    fn clear_caches(&self) -> Result<(), String>;
    fn reinstall(&self, component: &str) -> Result<(), String>;
    /// Sets a system TeX aside (true) or uses it again (false).
    fn skip_system_tex(&self, skip: bool);
    fn installed(&self, component: &str) -> bool;
}

fn managed_component(compiler: &str) -> Option<&'static str> {
    if compiler.starts_with("tinytex") { Some("tinytex") } else if compiler.starts_with("tectonic") { Some("tectonic") } else { None }
}

/// A build that failed while fetching packages: the network, not the compiler.
pub fn looks_offline(log: &str) -> bool {
    let l = log.to_ascii_lowercase();
    ["could not resolve", "failed to download", "download failed", "network is unreachable", "no route to host",
     "connection refused", "connection reset", "dns error", "error sending request", "timed out while downloading",
     "cannot reach the package server", "unable to connect"]
        .iter()
        .any(|p| l.contains(p))
}

fn tail(s: &str, max: usize) -> String {
    let start = s.len().saturating_sub(max);
    let start = (start..=s.len()).find(|i| s.is_char_boundary(*i)).unwrap_or(s.len());
    s[start..].to_string()
}

fn report(state: &str, compiler: Option<String>, steps: Vec<String>, log: &str, now: u64) -> Report {
    Report { state: state.into(), compiler, steps, log: tail(log, 4000), at: now }
}

/// Runs the check and, if needed, the repair ladder.
pub fn check(t: &dyn Toolbox, now: u64) -> Report {
    let (compiler, mut log) = match t.probe() {
        Probe::Ok { compiler } => return report("ok", Some(compiler), vec![], "", now),
        Probe::NoCompiler => return report("none", None, vec![], "", now),
        Probe::Failed { compiler, log } => (compiler, log),
    };
    if looks_offline(&log) {
        return report("offline", Some(compiler), vec![], &log, now);
    }
    let mut steps = Vec::new();
    let retry = |steps: &mut Vec<String>, what: String| -> Option<Probe> {
        steps.push(what);
        Some(t.probe())
    };

    // 1. caches
    match t.clear_caches() {
        Ok(()) => {
            if let Some(Probe::Ok { compiler }) = retry(&mut steps, "cleared the compiler caches".into()) {
                return report("repaired", Some(compiler), steps, "", now);
            }
        }
        Err(e) => steps.push(format!("could not clear the compiler caches: {e}")),
    }

    // 2. a managed compiler: install it again
    if let Some(component) = managed_component(&compiler) {
        match t.reinstall(component) {
            Ok(()) => match retry(&mut steps, format!("installed the {} again", label(component))) {
                Some(Probe::Ok { compiler }) => return report("repaired", Some(compiler), steps, "", now),
                Some(Probe::Failed { log: l, .. }) => log = l,
                _ => {}
            },
            Err(e) => {
                steps.push(format!("could not install the {} again: {e}", label(component)));
                let state = if looks_offline(&e) { "offline" } else { "failed" };
                return report(state, Some(compiler), steps, &log, now);
            }
        }
        return report("failed", Some(compiler), steps, &log, now);
    }

    // 3. a system TeX that still fails: set it aside for a managed compiler
    t.skip_system_tex(true);
    let fallback = match retry(&mut steps, format!("set the system TeX ({compiler}) aside")) {
        Some(Probe::Ok { compiler }) => return report("repaired", Some(compiler), steps, "", now),
        Some(Probe::Failed { log: l, .. }) => {
            log = l;
            None
        }
        _ => Some("tectonic"),
    };
    if let Some(component) = fallback.filter(|c| !t.installed(c)) {
        match t.reinstall(component) {
            Ok(()) => match retry(&mut steps, format!("installed the {}", label(component))) {
                Some(Probe::Ok { compiler }) => return report("repaired", Some(compiler), steps, "", now),
                Some(Probe::Failed { log: l, .. }) => log = l,
                _ => {}
            },
            Err(e) => steps.push(format!("could not install the {}: {e}", label(component))),
        }
    }
    // Nothing better replaced it: keep using the system TeX rather than leaving no compiler at all.
    t.skip_system_tex(false);
    steps.push(format!("kept the system TeX ({compiler})"));
    report("failed", Some(compiler), steps, &log, now)
}

fn label(component: &str) -> &'static str {
    if component == "tinytex" { "full LaTeX" } else { "quick compiler" }
}

// ---- persistence and the real toolbox ----

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Saved {
    skip_system_tex: bool,
    last: Option<Report>,
}

fn saved_path(root: &Path) -> PathBuf {
    root.join("compiler-health.json")
}

fn load(root: &Path) -> Saved {
    std::fs::read(saved_path(root)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn store(root: &Path, s: &Saved) {
    if let Ok(b) = serde_json::to_vec_pretty(s) {
        let _ = std::fs::write(saved_path(root), b);
    }
}

/// At start, before anything detects a compiler: a system TeX set aside by an earlier check stays aside.
pub fn restore(root: &Path) {
    crate::tex::set_skip_system_tex(load(root).skip_system_tex);
}

/// The last check, for Account > Compiler.
pub fn last(root: &Path) -> Option<Report> {
    load(root).last
}

/// Uses the system TeX again (undoes step 3).
pub fn use_system_tex(root: &Path) {
    let mut s = load(root);
    s.skip_system_tex = false;
    store(root, &s);
    crate::tex::set_skip_system_tex(false);
    crate::tex::forget_engine();
}

struct Real {
    root: PathBuf,
}

impl Toolbox for Real {
    fn probe(&self) -> Probe {
        use base64::Engine as _;
        let Some(info) = crate::tex::detect_fresh() else { return Probe::NoCompiler };
        let engine = info.supports.first().cloned().unwrap_or_else(|| "pdflatex".into());
        let bytes = CHECK_DOC.as_bytes();
        let hash = {
            use sha2::Digest;
            let d = sha2::Sha256::digest(bytes);
            d.iter().map(|b| format!("{b:02x}")).collect::<String>()
        };
        let req = crate::tex::CompileReq {
            project: CHECK_PROJECT.into(),
            files: vec![crate::tex::FileIn { path: "check.tex".into(), hash, content_b64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)) }],
            main: "check.tex".into(),
            engine,
            timeout_ms: 180_000,
            memory_mb: 2048,
        };
        let resp = crate::tex::compile(&self.root, req);
        if resp.ok && resp.pdf_b64.is_some() {
            Probe::Ok { compiler: info.flavor }
        } else {
            Probe::Failed { compiler: info.flavor, log: resp.log }
        }
    }

    fn clear_caches(&self) -> Result<(), String> {
        crate::maintenance::clear_compiler_cache(&self.root)
    }

    fn reinstall(&self, component: &str) -> Result<(), String> {
        let asset = crate::managed::asset(component).ok_or_else(|| format!("{component} is not available for this system"))?;
        let root = self.root.clone();
        let result = tauri::async_runtime::block_on(async move {
            let _exclusive = crate::maintenance::COMPILER_ACTIVITY.try_write().map_err(|_| "a compile is running".to_string())?;
            let client = reqwest::Client::builder().build().map_err(|e| e.to_string())?;
            crate::managed::install(&client, &root, asset, &|_, _| {}).await
        });
        crate::tex::forget_engine();
        result.map(|_| ())
    }

    fn skip_system_tex(&self, skip: bool) {
        let mut s = load(&self.root);
        s.skip_system_tex = skip;
        store(&self.root, &s);
        crate::tex::set_skip_system_tex(skip);
        crate::tex::forget_engine();
    }

    fn installed(&self, component: &str) -> bool {
        crate::managed::status(&self.root, component).is_some()
    }
}

/// Checks (and repairs) now and remembers the result. Blocking: run it on a blocking thread.
pub fn run(root: &Path) -> Report {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let r = check(&Real { root: root.to_path_buf() }, now);
    let mut s = load(root);
    s.last = Some(r.clone());
    store(root, &s);
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Scripted outcomes: each probe pops the next one; every call is recorded.
    struct Script {
        probes: RefCell<Vec<Probe>>,
        calls: RefCell<Vec<String>>,
        reinstall_err: Option<String>,
        installed: Vec<&'static str>,
    }

    impl Script {
        fn new(probes: Vec<Probe>) -> Self {
            Script { probes: RefCell::new(probes.into_iter().rev().collect()), calls: RefCell::new(vec![]), reinstall_err: None, installed: vec![] }
        }
        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
    }

    impl Toolbox for Script {
        fn probe(&self) -> Probe {
            self.calls.borrow_mut().push("probe".into());
            self.probes.borrow_mut().pop().expect("an outcome for every probe")
        }
        fn clear_caches(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("clear".into());
            Ok(())
        }
        fn reinstall(&self, component: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("reinstall {component}"));
            self.reinstall_err.clone().map_or(Ok(()), Err)
        }
        fn skip_system_tex(&self, skip: bool) {
            self.calls.borrow_mut().push(format!("skip {skip}"));
        }
        fn installed(&self, component: &str) -> bool {
            self.installed.contains(&component)
        }
    }

    fn ok(c: &str) -> Probe {
        Probe::Ok { compiler: c.into() }
    }
    fn failed(c: &str) -> Probe {
        Probe::Failed { compiler: c.into(), log: "! Fatal format file error; I'm stymied".into() }
    }

    #[test]
    fn a_working_compiler_is_left_alone() {
        let s = Script::new(vec![ok("texlive")]);
        let r = check(&s, 1);
        assert_eq!((r.state.as_str(), r.compiler.as_deref()), ("ok", Some("texlive")));
        assert_eq!(s.calls(), ["probe"]);
    }

    #[test]
    fn no_compiler_is_reported_without_repairs() {
        let s = Script::new(vec![Probe::NoCompiler]);
        assert_eq!(check(&s, 1).state, "none");
        assert_eq!(s.calls(), ["probe"]);
    }

    #[test]
    fn a_stale_cache_is_cleared_first() {
        let s = Script::new(vec![failed("tectonic (managed)"), ok("tectonic (managed)")]);
        let r = check(&s, 1);
        assert_eq!(r.state, "repaired");
        assert_eq!(r.steps, ["cleared the compiler caches"]);
        assert_eq!(s.calls(), ["probe", "clear", "probe"]);
    }

    #[test]
    fn a_broken_managed_compiler_is_installed_again() {
        let s = Script::new(vec![failed("tinytex (managed)"), failed("tinytex (managed)"), ok("tinytex (managed)")]);
        let r = check(&s, 1);
        assert_eq!(r.state, "repaired");
        assert_eq!(s.calls(), ["probe", "clear", "probe", "reinstall tinytex", "probe"]);
    }

    #[test]
    fn a_broken_system_tex_is_set_aside_for_an_installed_managed_compiler() {
        let s = Script::new(vec![failed("miktex"), failed("miktex"), ok("tinytex (managed)")]);
        let r = check(&s, 1);
        assert_eq!((r.state.as_str(), r.compiler.as_deref()), ("repaired", Some("tinytex (managed)")));
        assert_eq!(s.calls(), ["probe", "clear", "probe", "skip true", "probe"]);
    }

    #[test]
    fn a_broken_system_tex_without_alternative_gets_the_quick_compiler() {
        let s = Script::new(vec![failed("texlive"), failed("texlive"), Probe::NoCompiler, ok("tectonic (managed)")]);
        let r = check(&s, 1);
        assert_eq!((r.state.as_str(), r.compiler.as_deref()), ("repaired", Some("tectonic (managed)")));
        assert_eq!(s.calls(), ["probe", "clear", "probe", "skip true", "probe", "reinstall tectonic", "probe"]);
    }

    #[test]
    fn when_nothing_works_the_system_tex_stays_in_use() {
        let mut s = Script::new(vec![failed("texlive"), failed("texlive"), Probe::NoCompiler]);
        s.reinstall_err = Some("failed to download: dns error".into());
        let r = check(&s, 1);
        assert_eq!(r.state, "failed");
        assert_eq!(s.calls().last().map(String::as_str), Some("skip false"));
        assert!(r.steps.iter().any(|x| x.starts_with("could not install the quick compiler")));
    }

    #[test]
    fn a_download_failure_is_reported_as_offline_and_nothing_is_touched() {
        let s = Script::new(vec![Probe::Failed { compiler: "tectonic (managed)".into(), log: "error: failed to download pdftex.map".into() }]);
        assert_eq!(check(&s, 1).state, "offline");
        assert_eq!(s.calls(), ["probe"]);
    }

    /// With a real TeX on this machine (CI installs one), the check document builds: a working compiler is never repaired.
    #[test]
    fn the_check_document_builds_with_this_machines_tex() {
        if crate::tex::detect().is_none() {
            eprintln!("no TeX here: skipped");
            return;
        }
        let root = std::env::temp_dir().join(format!("hivetex-health-real-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        match (Real { root: root.clone() }).probe() {
            Probe::Ok { .. } => {}
            Probe::Failed { compiler, log } => panic!("{compiler} failed the check document:\n{log}"),
            Probe::NoCompiler => panic!("detected, then gone"),
        }
        let _ = crate::maintenance::remove_owned_tree(&root);
    }

    #[test]
    fn the_saved_state_restores_a_set_aside_system_tex() {
        let root = std::env::temp_dir().join(format!("hivetex-health-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        store(&root, &Saved { skip_system_tex: true, last: Some(report("repaired", Some("tinytex (managed)".into()), vec![], "", 7)) });
        assert!(load(&root).skip_system_tex);
        assert_eq!(last(&root).map(|r| r.at), Some(7));
        use_system_tex(&root);
        assert!(!load(&root).skip_system_tex);
        let _ = std::fs::remove_dir_all(&root);
    }
}
