//! Native LaTeX compilation: detects a system TeX distribution (TeX Live / MiKTeX / MacTeX) and runs it
//! in a hardened, incremental working directory.
//!
//! Hardening: shell escape disabled, path-restricted file access, wall-clock timeout, memory limit
//! (Windows job object / Unix rlimit), whole process tree killed on timeout or cancellation, files confined to the
//! project working directory.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use crate::proc::background_command;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct EngineInfo {
    pub flavor: String,
    pub supports: Vec<String>,
    pub has_latexmk: bool,
    /// Whether what a document read can be verified (recorder); the quick compiler's reads cannot be.
    pub verified_reads: bool,
    /// Executables of an installation HiveTeX manages (TinyTeX, Tectonic); `None` = found on PATH.
    #[serde(skip)]
    pub bin_dir: Option<PathBuf>,
}

/// The app's data folder, where managed compilers live (`tinytex/`, `tectonic/`, `tectonic-cache/`). Set once at start.
static MANAGED_ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
pub fn set_managed_root(p: PathBuf) {
    let _ = MANAGED_ROOT.set(p);
}
fn managed_root() -> Option<&'static PathBuf> {
    MANAGED_ROOT.get()
}

/// The managed TinyTeX's `bin/<platform>` folder, if installed.
fn tinytex_bin(root: &Path) -> Option<PathBuf> {
    let bin = root.join("tinytex").join("bin");
    let rd = fs::read_dir(&bin).ok()?;
    rd.flatten().map(|e| e.path()).find(|p| p.is_dir() && find_exe_in("pdflatex", p.as_os_str()).is_some())
}

fn tectonic_exe(root: &Path) -> Option<PathBuf> {
    let p = root.join("tectonic").join(if cfg!(windows) { "tectonic.exe" } else { "tectonic" });
    p.is_file().then_some(p)
}

/// Compilers in order of preference: managed TinyTeX, working system TeX, managed Tectonic (local-only builds).
pub fn detect_with(path: Option<&std::ffi::OsStr>, managed: Option<&Path>) -> Option<EngineInfo> {
    if let Some(bin) = managed.and_then(tinytex_bin) {
        if let Some(mut info) = detect_in(bin.as_os_str()) {
            info.flavor = "tinytex (managed)".into();
            info.bin_dir = Some(bin);
            return Some(info);
        }
    }
    if let Some(info) = path.and_then(detect_in) {
        return Some(info);
    }
    let root = managed?;
    let exe = tectonic_exe(root)?;
    Some(EngineInfo {
        flavor: "tectonic (managed)".into(),
        // Tectonic always runs XeTeX; pdfLaTeX projects are built by it too (with a note in the log).
        supports: vec!["pdflatex".into(), "xelatex".into()],
        has_latexmk: false,
        verified_reads: false,
        bin_dir: exe.parent().map(Path::to_path_buf),
    })
}

#[derive(Deserialize, Debug)]
pub struct FileIn {
    pub path: String,
    pub hash: String,
    pub content_b64: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct CompileReq {
    pub project: String,
    pub files: Vec<FileIn>,
    pub main: String,
    pub engine: String,
    pub timeout_ms: u64,
    pub memory_mb: u64,
}

#[derive(Serialize, Debug, Default)]
pub struct CompileResp {
    pub ok: bool,
    /// Paths whose content the caller must send (the working directory did not have them).
    pub need: Vec<String>,
    pub pdf_b64: Option<String>,
    pub synctex_b64: Option<String>,
    pub log: String,
    pub timed_out: bool,
    /// Built by a compiler whose file reads cannot be verified (Tectonic). Every result stays on this device anyway.
    pub local_only: bool,
}

pub fn find_exe(name: &str) -> Option<PathBuf> {
    find_exe_in(name, &std::env::var_os("PATH")?)
}

/// `find_exe` over an explicit search path (tests).
pub fn find_exe_in(name: &str, path: &std::ffi::OsStr) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or(".EXE;.CMD;.BAT".into())
            .split(';')
            .map(|s| s.to_lowercase())
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(path) {
        for ext in &exts {
            let cand = dir.join(format!("{name}{ext}"));
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

/// A failed or hung program is not an installed compiler. Bound output and lifetime, including child processes.
fn probe_output(exe: &Path, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = background_command(exe).args(args).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    #[cfg(windows)]
    let job = winjob::JobGuard::attach(&child, 0);
    #[cfg(windows)]
    if job.is_none() { let _ = child.kill(); let _ = child.wait(); return None; }
    let output = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = output.take(65536).read_to_end(&mut bytes);
        bytes
    });
    let start = Instant::now();
    let ok = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    #[cfg(windows)]
    drop(job);
    let bytes = reader.join().ok()?;
    ok.then(|| String::from_utf8_lossy(&bytes).into_owned()).filter(|s| !s.trim().is_empty())
}

/// A system TeX that failed the start-up compiler check and could be replaced (compiler_health.rs).
static SKIP_SYSTEM_TEX: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_skip_system_tex(skip: bool) {
    SKIP_SYSTEM_TEX.store(skip, std::sync::atomic::Ordering::SeqCst);
}

pub fn detect() -> Option<EngineInfo> {
    let _activity = crate::maintenance::COMPILER_ACTIVITY.try_read().ok()?;
    // HIVETEX_IGNORE_SYSTEM_TEX=1: behave as on a machine without TeX (tests of the managed compilers).
    let skip = std::env::var_os("HIVETEX_IGNORE_SYSTEM_TEX").is_some() || SKIP_SYSTEM_TEX.load(std::sync::atomic::Ordering::SeqCst);
    let path = if skip { None } else { std::env::var_os("PATH") };
    detect_with(path.as_deref(), managed_root().map(PathBuf::as_path))
}

/// The last detection, reused by compiles: each detection starts processes (`--version`), and a save must not.
/// Refreshed when the UI asks (`detect_fresh`), cleared when a managed compiler is installed or removed.
pub struct EngineCache(std::sync::Mutex<Option<EngineInfo>>);

impl EngineCache {
    pub const fn new() -> Self {
        EngineCache(std::sync::Mutex::new(None))
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Option<EngineInfo>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The remembered engine while its executable is still there (a file check, no process); else detects again.
    /// "Nothing found" is not remembered, so a TeX installed meanwhile is found by the next compile.
    pub fn get_or_detect(&self, detect: &dyn Fn() -> Option<EngineInfo>) -> Option<EngineInfo> {
        if let Some(info) = self.slot().clone().filter(still_installed) {
            return Some(info);
        }
        self.refresh(detect)
    }

    pub fn refresh(&self, detect: &dyn Fn() -> Option<EngineInfo>) -> Option<EngineInfo> {
        let info = detect();
        *self.slot() = info.clone();
        info
    }

    pub fn forget(&self) {
        *self.slot() = None;
    }
}

static ENGINE: EngineCache = EngineCache::new();

/// Detects now and remembers the result for later compiles (compiler panel, project open).
pub fn detect_fresh() -> Option<EngineInfo> {
    ENGINE.refresh(&detect)
}

/// Forgets the remembered engine (a managed compiler was installed or removed).
pub fn forget_engine() {
    ENGINE.forget();
    if let Some(roots) = TEX_ROOTS.get() { roots.lock().unwrap_or_else(|e| e.into_inner()).clear(); }
}

/// Whether a detected engine's executable still exists.
fn still_installed(info: &EngineInfo) -> bool {
    if info.flavor.starts_with("tectonic") {
        return info.bin_dir.as_ref().is_some_and(|b| b.join(if cfg!(windows) { "tectonic.exe" } else { "tectonic" }).is_file());
    }
    let Some(engine) = info.supports.first() else { return false };
    match &info.bin_dir {
        Some(b) => find_exe_in(engine, b.as_os_str()).is_some(),
        None => find_exe(engine).is_some(),
    }
}

/// `detect` over an explicit search path (tests).
pub fn detect_in(path: &std::ffi::OsStr) -> Option<EngineInfo> {
    detect_in_with(path, &|p, timeout| probe_output(p, &["--version"], timeout))
}

fn detect_in_with(path: &std::ffi::OsStr, probe: &dyn Fn(&Path, Duration) -> Option<String>) -> Option<EngineInfo> {
    let deadline = Instant::now() + Duration::from_secs(6);
    for bin in std::env::split_paths(path).filter(|p| p.is_absolute()) {
        let mut supports = Vec::new();
        let mut flavor = String::new();
        for engine in ["pdflatex", "xelatex", "lualatex"] {
            let Some(exe) = find_exe_in(engine, bin.as_os_str()) else { continue };
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() { return None; }
            let Some(version) = probe(&exe, remaining.min(Duration::from_secs(2))) else { continue };
            let candidate = if version.contains("MiKTeX") { "miktex" }
                else if version.contains("TeX Live") { "texlive" } else { continue };
            if flavor.is_empty() { flavor = candidate.into(); }
            if flavor == candidate {
                supports.push(engine.to_string());
            }
        }
        if !supports.is_empty() {
            return Some(EngineInfo { flavor, supports, has_latexmk: find_exe_in("latexmk", bin.as_os_str()).is_some(), verified_reads: true, bin_dir: Some(bin) });
        }
    }
    // A Tectonic found on PATH is not offered: it writes no recorder file, so what a document read cannot be verified
    // (see verify_reads), and its I/O reads absolute paths directly. Only the managed Tectonic is used (detect_with),
    // and only for builds that stay on this device.
    None
}

/// Build tool configuration that must never come from a project (latexmk rc files are executable Perl).
pub fn is_build_tool_config(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_ascii_lowercase();
    name == "latexmkrc" || name == ".latexmkrc"
}

/// Accepts only plain relative paths made of normal components.
pub fn safe_rel(p: &str) -> Option<PathBuf> {
    if p.is_empty() || p.contains('\0') || p.contains('\\') && cfg!(not(windows)) {
        return None;
    }
    let path = Path::new(p);
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::Normal(s) => {
                let s = s.to_string_lossy();
                if s.contains(':') || s.is_empty() {
                    return None;
                }
                out.push(&*s);
            }
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() { None } else { Some(out) }
}

fn sanitize_project(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).take(64).collect()
}

fn sha256_hex(b: &[u8]) -> String {
    hex(&Sha256::digest(b))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

const MANIFEST: &str = ".p2p-manifest.json";

fn load_manifest(dir: &Path) -> HashMap<String, String> {
    fs::read_to_string(dir.join(MANIFEST)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("p2p-tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}

fn tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    s[start..].to_string()
}

type CancelFlag = std::sync::Arc<std::sync::atomic::AtomicBool>;

/// Builds that can be cancelled, by the id their caller chose (`tex_cancel`).
static CANCELS: std::sync::OnceLock<std::sync::Mutex<HashMap<String, CancelFlag>>> = std::sync::OnceLock::new();

fn cancels() -> std::sync::MutexGuard<'static, HashMap<String, CancelFlag>> {
    CANCELS.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner())
}

thread_local! {
    /// The cancel flag of the build running on this thread (a build runs on one blocking thread).
    static CURRENT_CANCEL: std::cell::RefCell<Option<CancelFlag>> = const { std::cell::RefCell::new(None) };
}

fn cancelled() -> bool {
    CURRENT_CANCEL.with(|c| c.borrow().as_ref().is_some_and(|f| f.load(std::sync::atomic::Ordering::SeqCst)))
}

/// Cancels build `id`: its process tree is killed, and a cancel that arrives before the build starts stops it at once.
pub fn cancel_build(id: &str) {
    let mut m = cancels();
    if m.len() >= 256 {
        // cancels for builds that already ended
        m.retain(|_, f| std::sync::Arc::strong_count(f) > 1);
    }
    m.entry(id.to_string()).or_default().store(true, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
pub fn tex_cancel(build: String) {
    cancel_build(&build);
}

/// `compile_with`, cancellable through `cancel_build(build)`.
pub fn compile_build(root: &Path, req: CompileReq, on_download: Option<OnDownload>, build: Option<&str>) -> CompileResp {
    let Some(id) = build else { return compile_with(root, req, on_download) };
    struct Current<'a>(&'a str);
    impl Drop for Current<'_> {
        fn drop(&mut self) {
            CURRENT_CANCEL.with(|c| *c.borrow_mut() = None);
            cancels().remove(self.0);
        }
    }
    let flag = cancels().entry(id.to_string()).or_default().clone();
    CURRENT_CANCEL.with(|c| *c.borrow_mut() = Some(flag));
    let _current = Current(id);
    compile_with(root, req, on_download)
}

fn cancelled_resp() -> CompileResp {
    CompileResp { log: "! Compilation cancelled\n".into(), ..Default::default() }
}

/// Runs a command with limits; returns (exit_success, timed_out).
fn run_limited(cmd: Command, timeout: Duration, memory_mb: u64) -> std::io::Result<(bool, bool)> {
    run_limited_io(cmd, timeout, memory_mb, None, None)
}

/// Overall limit for a build whose deadline is pushed back by downloads (the quick compiler's first build).
const DOWNLOAD_CAP: Duration = Duration::from_secs(15 * 60);

/// Milliseconds since the build started at which the compiler last downloaded something (0 = never).
pub(crate) type Activity = std::sync::Arc<std::sync::atomic::AtomicU64>;

/// Whether a build has run too long: `timeout` counts from the last download (or the start), within `cap` overall.
fn timed_out(elapsed: Duration, last_download: Option<Duration>, timeout: Duration, cap: Duration) -> bool {
    let since = elapsed.saturating_sub(last_download.unwrap_or(Duration::ZERO));
    since > timeout || elapsed > cap.max(timeout)
}

/// `run_limited`, with stderr written to `stderr` when given (Tectonic reports its downloads there), and the time limit
/// counted from the latest download recorded in `activity` when given.
fn run_limited_io(mut cmd: Command, timeout: Duration, memory_mb: u64, stderr: Option<fs::File>, activity: Option<Activity>) -> std::io::Result<(bool, bool)> {
    // Both streams go to the file when given (Tectonic prints its `note:` lines on stdout).
    let stdout = stderr.as_ref().and_then(|f| f.try_clone().ok());
    cmd.stdin(Stdio::null())
        .stdout(stdout.map(Stdio::from).unwrap_or_else(Stdio::null))
        .stderr(stderr.map(Stdio::from).unwrap_or_else(Stdio::null));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(move || {
                libc::setsid();
                if memory_mb > 0 {
                    let lim = libc::rlimit { rlim_cur: memory_mb * 1024 * 1024, rlim_max: memory_mb * 1024 * 1024 };
                    libc::setrlimit(libc::RLIMIT_AS, &lim);
                }
                Ok(())
            });
        }
    }
    // The window is already hidden (background_command); CREATE_SUSPENDED is awkward with std, so the job is
    // assigned right after spawn instead.
    let mut child = cmd.spawn()?;
    #[cfg(windows)]
    let _job = winjob::JobGuard::attach(&child, memory_mb);
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok((status.success(), false));
        }
        let last = activity.as_ref().map(|a| a.load(std::sync::atomic::Ordering::SeqCst)).filter(|&ms| ms > 0).map(Duration::from_millis);
        let cap = if activity.is_some() { DOWNLOAD_CAP } else { timeout };
        // A cancelled build ends like one over its limit: the whole tree is killed (callers report the cancellation).
        if cancelled() || timed_out(start.elapsed(), last, timeout, cap) {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            #[cfg(windows)]
            drop(_job); // closing the job (KILL_ON_JOB_CLOSE) terminates the whole process tree
            let _ = child.wait();
            return Ok((false, true));
        }
        std::thread::sleep(Duration::from_millis(15));
    }
}

#[cfg(windows)]
pub(crate) mod winjob {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::*;

    pub struct JobGuard(HANDLE);
    unsafe impl Send for JobGuard {}

    impl JobGuard {
        pub fn attach(child: &Child, memory_mb: u64) -> Option<JobGuard> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if memory_mb > 0 {
                    info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
                    info.ProcessMemoryLimit = (memory_mb * 1024 * 1024) as usize;
                }
                let configured = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if configured == 0 || AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0 {
                    CloseHandle(job);
                    return None;
                }
                Some(JobGuard(job))
            }
        }
    }

    impl Drop for JobGuard {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

fn base_command(exe: PathBuf, dir: &Path) -> Command {
    let mut c = background_command(&exe);
    if let Some(bin) = exe.parent().filter(|b| b.is_absolute()) {
        let mut paths = vec![bin.to_path_buf()];
        paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).filter(|p| p != bin));
        if let Ok(path) = std::env::join_paths(paths) { c.env("PATH", path); }
        if managed_root().is_some_and(|root| bin.starts_with(root.join("tinytex"))) {
            for key in ["TEXMFCNF", "TEXMFROOT", "TEXMFDIST", "TEXMFVAR", "TEXMFCONFIG", "TEXMFHOME", "TEXINPUTS", "BIBINPUTS", "BSTINPUTS"] {
                c.env_remove(key);
            }
        }
    }
    c.current_dir(dir)
        // TeX Live path restrictions (paranoid: no reads/writes outside the working tree).
        .env("openout_any", "p")
        .env("openin_any", "p")
        .env("shell_escape", "f")
        .env("TEXMF_OUTPUT_DIRECTORY", ".")
        // MiKTeX ignores openin_any/openout_any: these per-process switches make it refuse absolute and
        // parent-directory paths too (without touching the user's global MiKTeX configuration).
        .env("MIKTEX_CORE_ALLOWUNSAFEINPUTFILES", "f")
        .env("MIKTEX_CORE_ALLOWUNSAFEOUTPUTFILES", "f");
    c
}

pub fn compile(root: &Path, req: CompileReq) -> CompileResp {
    compile_with(root, req, None)
}

/// Callback for files a compiler downloads during a build (Tectonic's lazy packages).
pub type OnDownload = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

pub fn compile_with(root: &Path, req: CompileReq, on_download: Option<OnDownload>) -> CompileResp {
    if cancelled() {
        return cancelled_resp();
    }
    let mut resp = CompileResp::default();
    let Ok(_activity) = crate::maintenance::COMPILER_ACTIVITY.try_read() else {
        resp.log = "! Compiler maintenance is in progress; try compiling again when it finishes.".into();
        return resp;
    };
    let dir = root.join("builds").join(sanitize_project(&req.project));
    if fs::create_dir_all(&dir).is_err() {
        resp.log = "! cannot create build directory".into();
        return resp;
    }
    let Some(main_rel) = safe_rel(&req.main) else {
        resp.log = "! invalid main file path".into();
        return resp;
    };
    let mut manifest = load_manifest(&dir);
    let mut wanted: HashMap<String, String> = HashMap::new();

    // Validate everything first, then write only what changed.
    let mut writes: Vec<(PathBuf, Vec<u8>, String, String)> = Vec::new();
    for f in &req.files {
        let Some(rel) = safe_rel(&f.path) else {
            resp.log = format!("! refusing unsafe path: {}", f.path);
            return resp;
        };
        let key = rel.to_string_lossy().replace('\\', "/");
        if is_build_tool_config(&key) {
            // latexmk rc files are Perl: never place a collaborator's copy where latexmk could read it.
            continue;
        }
        wanted.insert(key.clone(), f.hash.clone());
        let current = manifest.get(&key) == Some(&f.hash) && dir.join(&rel).is_file();
        if current {
            continue;
        }
        match &f.content_b64 {
            Some(b) => match B64.decode(b) {
                Ok(bytes) => {
                    if sha256_hex(&bytes) != f.hash && !f.hash.is_empty() && f.hash.len() == 64 {
                        // text files are hashed by the caller over UTF-8 bytes too; mismatch means corruption
                        resp.log = format!("! hash mismatch for {}", f.path);
                        return resp;
                    }
                    writes.push((dir.join(&rel), bytes, key, f.hash.clone()));
                }
                Err(_) => {
                    resp.log = format!("! bad base64 for {}", f.path);
                    return resp;
                }
            },
            None => resp.need.push(f.path.clone()),
        }
    }
    if !resp.need.is_empty() {
        return resp;
    }
    for (path, bytes, key, hash) in writes {
        if write_atomic(&path, &bytes).is_err() {
            resp.log = format!("! cannot write {key}");
            return resp;
        }
        manifest.insert(key, hash);
    }
    // Remove sources that disappeared from the project (never generated artifacts: they are not in the manifest).
    let gone: Vec<String> = manifest.keys().filter(|k| !wanted.contains_key(*k)).cloned().collect();
    for k in gone {
        let _ = fs::remove_file(dir.join(&k));
        manifest.remove(&k);
    }
    let _ = fs::write(dir.join(MANIFEST), serde_json::to_string(&manifest).unwrap_or_default());

    let stem = main_rel.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or("main".into());
    let sub = main_rel.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let out_dir = dir.join(&sub);
    let pdf_path = out_dir.join(format!("{stem}.pdf"));
    let log_path = out_dir.join(format!("{stem}.log"));
    let _ = fs::remove_file(&pdf_path);

    let Some(info) = ENGINE.get_or_detect(&detect) else {
        resp.log = "! No TeX installation found (install TeX Live, MiKTeX or MacTeX)".into();
        return resp;
    };
    if info.flavor.starts_with("tectonic") {
        return compile_tectonic(&info, &dir, &out_dir, &main_rel, &stem, &req, on_download, resp);
    }
    if !info.supports.iter().any(|e| e == &req.engine) {
        resp.log = format!("! This device cannot run {}", req.engine);
        return resp;
    }
    let timeout = Duration::from_millis(req.timeout_ms.max(1000));
    let mem = req.memory_mb;
    let main_name = main_rel.to_string_lossy().to_string();
    let exe = |name: &str| match &info.bin_dir {
        Some(b) => find_exe_in(name, b.as_os_str()),
        None => find_exe(name),
    };
    let engine_exe = exe(&req.engine).unwrap_or_else(|| PathBuf::from(&req.engine));
    let installer = if info.flavor == "miktex" { Some("--enable-installer") } else { None };

    let (mut success, mut timed_out) = (false, false);
    // Managed TinyTeX: install the packages a failed build was missing, then build again (tinytex.rs).
    let managed_tinytex = info.flavor.starts_with("tinytex");
    let mut tried: Vec<String> = Vec::new();
    for round in 0..=crate::tinytex::MAX_ROUNDS {
        if info.has_latexmk {
            let Some(latexmk) = exe("latexmk") else {
                resp.log = "! latexmk not found".into();
                return resp;
            };
            let mut cmd = base_command(latexmk, &dir);
            cmd.arg(match req.engine.as_str() {
                "xelatex" => "-xelatex",
                "lualatex" => "-lualatex",
                _ => "-pdf",
            })
            // -norc: ignore every latexmkrc (system, user and the project's own); all options come from here.
            .args(["-norc", "-recorder", "-interaction=nonstopmode", "-synctex=1", "-latexoption=-no-shell-escape"]);
            if round > 0 {
                // packages were just installed: latexmk sees no changed source, so force the rebuild
                cmd.arg("-g");
            }
            if let Some(i) = installer {
                cmd.arg(format!("-latexoption={i}"));
            }
            cmd.arg(&main_name);
            match run_limited(cmd, timeout, mem) {
                Ok((s, t)) => (success, timed_out) = (s, t),
                Err(e) => resp.log = format!("! cannot start latexmk: {e}"),
            }
        } else {
            // Fallback without latexmk: engine, bibtex when needed, then two more passes.
            let run_engine = |dir: &Path| {
                let mut c = base_command(engine_exe.clone(), dir);
                c.args(["-recorder", "-interaction=nonstopmode", "-synctex=1", "-no-shell-escape"]);
                if let Some(i) = installer {
                    c.arg(i);
                }
                c.arg(&main_name);
                run_limited(c, timeout, mem)
            };
            let mut last = run_engine(&dir);
            if let Ok((_, false)) = last {
                let aux = fs::read_to_string(out_dir.join(format!("{stem}.aux"))).unwrap_or_default();
                if aux.contains("\\bibdata") {
                    if let Some(b) = exe("bibtex") {
                        let mut c = base_command(b, &dir);
                        c.arg(sub.join(&stem));
                        let _ = run_limited(c, timeout, mem);
                    }
                }
                for _ in 0..2 {
                    last = run_engine(&dir);
                    if matches!(last, Ok((_, true)) | Err(_)) {
                        break;
                    }
                }
            }
            match last {
                Ok((s, t)) => (success, timed_out) = (s, t),
                Err(e) => resp.log = format!("! cannot start {}: {e}", req.engine),
            }
        }
        if !managed_tinytex || success || timed_out || round == crate::tinytex::MAX_ROUNDS {
            break;
        }
        let missing = crate::tinytex::missing_files(&fs::read_to_string(&log_path).unwrap_or_default());
        let Some(bin) = info.bin_dir.as_deref() else { break };
        let run = crate::tinytex::tlmgr_runner(bin);
        let notify = |pkg: &str| {
            if let Some(cb) = &on_download {
                cb(&format!("installing {pkg}"));
            }
        };
        if cancelled() || missing.is_empty() || crate::tinytex::install_missing(&missing, &mut tried, &run, &notify).is_empty() {
            break;
        }
    }
    if cancelled() {
        return cancelled_resp();
    }

    // Distributions do not reliably stop a document from *reading* outside the project (TeX Live 2026 ignores
    // openin_any=p for reads; MiKTeX's switches do not cover \includegraphics). So check what was actually read,
    // and if anything came from outside the project or the TeX installation, nothing produced by this run leaves
    // the device: not the PDF, not SyncTeX, not even the log (it would show the content or the paths).
    if let Err(n) = verify_reads_with(&dir, &out_dir, &stem, &tex_roots_for(&info)) {
        resp.log = format!(
            "! The document tried to read {n} file(s) outside the project (for example \\input, \\includegraphics or a bibliography with an absolute or ../ path).\n! For your safety the result of this compile was discarded on the compiling device.\n"
        );
        resp.timed_out = timed_out;
        return resp;
    }
    let mut log = fs::read_to_string(&log_path).unwrap_or_default();
    if timed_out {
        log.push_str(&format!("\n! Compile timed out after {} s\n", timeout.as_secs()));
    }
    resp.log = tail(&format!("{}{}", resp.log, log), 200_000);
    resp.timed_out = timed_out;
    if pdf_path.is_file() {
        let mut bytes = Vec::new();
        if fs::File::open(&pdf_path).and_then(|mut f| f.read_to_end(&mut bytes)).is_ok() {
            resp.pdf_b64 = Some(B64.encode(&bytes));
        }
    }
    let sync_path = out_dir.join(format!("{stem}.synctex.gz"));
    if let Ok(bytes) = fs::read(&sync_path) {
        resp.synctex_b64 = Some(B64.encode(&bytes));
    }
    resp.ok = success && !timed_out && resp.pdf_b64.is_some();
    resp
}

/// Tectonic: one XeTeX run per pass, packages downloaded on demand into its cache. Its reads cannot be verified (no
/// recorder, absolute paths readable even with --untrusted), so the result is marked local-only; every result stays on
/// this device anyway.
#[allow(clippy::too_many_arguments)]
fn compile_tectonic(
    info: &EngineInfo,
    dir: &Path,
    out_dir: &Path,
    main_rel: &Path,
    stem: &str,
    req: &CompileReq,
    on_download: Option<OnDownload>,
    mut resp: CompileResp,
) -> CompileResp {
    resp.local_only = true;
    let Some(exe) = info.bin_dir.as_ref().map(|b| b.join(if cfg!(windows) { "tectonic.exe" } else { "tectonic" })) else {
        resp.log = "! the quick compiler is not installed".into();
        return resp;
    };
    let cache = managed_root().map(|r| r.join("tectonic-cache")).unwrap_or_else(|| dir.join(".tectonic-cache"));
    let _ = fs::create_dir_all(&cache);
    let _ = fs::create_dir_all(out_dir);
    let mut cmd = base_command(exe, dir);
    cmd.env("TECTONIC_CACHE_DIR", &cache)
        .args(["-X", "compile", "--untrusted", "--synctex", "--keep-logs", "--outdir"])
        .arg(out_dir)
        .arg(main_rel);
    let err_path = out_dir.join(format!("{stem}.tectonic-stderr.txt"));
    let Ok(err_file) = fs::File::create(&err_path) else {
        resp.log = "! cannot create the build log".into();
        return resp;
    };
    // Follow Tectonic's downloads (`note: downloading <file>` on stderr): reported to the UI when it listens, and each
    // one pushes the time limit back, so a first build that fetches its support files is not cut off (design D5).
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let activity: Activity = Default::default();
    let started = Instant::now();
    let watcher = {
        let (path, done, activity) = (err_path.clone(), done.clone(), activity.clone());
        std::thread::spawn(move || {
            let mut seen = 0usize;
            loop {
                let finished = done.load(std::sync::atomic::Ordering::SeqCst);
                if let Ok(text) = fs::read_to_string(&path) {
                    for line in text.lines().skip(seen) {
                        if let Some(f) = line.strip_prefix("note: downloading ") {
                            activity.store((started.elapsed().as_millis() as u64).max(1), std::sync::atomic::Ordering::SeqCst);
                            if let Some(cb) = &on_download {
                                cb(f.trim());
                            }
                        }
                        seen += 1;
                    }
                }
                if finished {
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        })
    };
    let timeout = Duration::from_millis(req.timeout_ms.max(1000));
    let run = run_limited_io(cmd, timeout, req.memory_mb, Some(err_file), Some(activity));
    done.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = watcher.join();
    if cancelled() {
        let _ = fs::remove_file(&err_path);
        return CompileResp { local_only: true, ..cancelled_resp() };
    }
    let (success, timed_out) = match run {
        Ok(r) => r,
        Err(e) => {
            resp.log = format!("! cannot start the quick compiler: {e}");
            return resp;
        }
    };
    let mut log = String::new();
    if req.engine == "pdflatex" {
        log.push_str("Note: built with the quick compiler (Tectonic, XeTeX engine). If this document needs pdfLaTeX, install full LaTeX in Account > Compiler.
");
    }
    log.push_str(&fs::read_to_string(out_dir.join(format!("{stem}.log"))).unwrap_or_default());
    let stderr = fs::read_to_string(&err_path).unwrap_or_default();
    let _ = fs::remove_file(&err_path);
    if !success {
        log.push_str("
--- compiler messages ---
");
        log.push_str(&stderr);
    }
    if timed_out {
        log.push_str(&format!("
! Compile timed out after {} s
", timeout.as_secs()));
    }
    resp.log = tail(&log, 200_000);
    resp.timed_out = timed_out;
    if let Ok(b) = fs::read(out_dir.join(format!("{stem}.pdf"))) {
        resp.pdf_b64 = Some(B64.encode(&b));
    }
    if let Ok(b) = fs::read(out_dir.join(format!("{stem}.synctex.gz"))) {
        resp.synctex_b64 = Some(B64.encode(&b));
    }
    resp.ok = success && !timed_out && resp.pdf_b64.is_some();
    resp
}

// ---------------------------------------------------------------------------------------------
// What did the engine read?
// ---------------------------------------------------------------------------------------------

/// Directories of the TeX installation (kpathsea variables), resolved once. Reading from these is expected.
static TEX_ROOTS: std::sync::OnceLock<std::sync::Mutex<HashMap<PathBuf, Vec<PathBuf>>>> = std::sync::OnceLock::new();

/// File-read verification belongs to the selected installation too, never whichever kpsewhich is first on PATH.
fn tex_roots_for(info: &EngineInfo) -> Vec<PathBuf> {
    let Some(bin) = &info.bin_dir else { return Vec::new() };
    let mut roots = TEX_ROOTS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    roots.entry(bin.clone()).or_insert_with(|| {
        let mut out = find_exe_in("kpsewhich", bin.as_os_str()).map(|k| roots_from(&k)).unwrap_or_default();
        if info.flavor.starts_with("tinytex") {
            if let Some(root) = bin.parent().and_then(Path::parent).and_then(|p| p.canonicalize().ok()) {
                if !out.contains(&root) { out.push(root); }
            }
        }
        out
    }).clone()
}

/// The directories a TeX installation reads from, asked from its kpsewhich (canonical paths).
fn roots_from(kpse: &Path) -> Vec<PathBuf> {
    {
        let mut out = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(6);
        let sep = if cfg!(windows) { ';' } else { ':' };
        for var in [
            "TEXMFROOT", "TEXMFDIST", "TEXMFMAIN", "TEXMFLOCAL", "TEXMFSYSVAR", "TEXMFSYSCONFIG", "TEXMFVAR",
            "TEXMFCONFIG", "TEXMFHOME", "TEXMFCACHE", "SELFAUTOPARENT",
        ] {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() { break; }
            let Some(text) = probe_output(kpse, &[&format!("-var-value={var}")], remaining.min(Duration::from_secs(2))) else { continue };
            for v in text.trim().split(sep) {
                let v = v.trim().trim_start_matches("!!");
                // unexpanded brace/variable lists are not usable roots
                if v.is_empty() || v.contains('{') || v.contains('$') {
                    continue;
                }
                if let Ok(c) = Path::new(v).canonicalize() {
                    // never treat a filesystem root or a home directory as "the TeX installation"
                    if c.components().count() > 2 && !out.contains(&c) {
                        out.push(c);
                    }
                }
            }
        }
        out
    }
}

const FONT_EXT: &[&str] = &["ttf", "otf", "ttc", "pfb", "pfa", "afm", "tfm", "vf", "dfont"];

fn read_allowed(path: &Path, build: &Path, roots: &[PathBuf]) -> bool {
    // System fonts (XeTeX/LuaTeX) live outside the TeX tree; font files carry no user secrets.
    if path.extension().and_then(|e| e.to_str()).map(|e| FONT_EXT.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false) {
        return true;
    }
    let canon = path.canonicalize().or_else(|_| path.parent().map(|p| p.canonicalize().map(|c| c.join(path.file_name().unwrap_or_default()))).unwrap_or(Err(std::io::Error::other("no parent"))));
    let Ok(c) = canon else { return false };
    c.starts_with(build) || roots.iter().any(|r| c.starts_with(r)) || c == Path::new("/dev/null")
}

/// Checks the recorder file (`.fls`: every file the engine opened) and the bibliography log (`.blg`: data sources of
/// bibtex/biber). Returns the number of files read from outside the project and the TeX installation.
pub fn verify_reads(build: &Path, out_dir: &Path, stem: &str) -> Result<(), usize> {
    let roots = ENGINE.get_or_detect(&detect).as_ref().map(tex_roots_for).unwrap_or_default();
    verify_reads_with(build, out_dir, stem, &roots)
}

fn verify_reads_with(build: &Path, out_dir: &Path, stem: &str, roots: &[PathBuf]) -> Result<(), usize> {
    let build = build.canonicalize().unwrap_or_else(|_| build.to_path_buf());
    let mut bad = 0usize;
    let mut check = |p: &Path, base: &Path| {
        let full = if p.is_absolute() { p.to_path_buf() } else { base.join(p) };
        if !read_allowed(&full, &build, roots) {
            bad += 1;
        }
    };
    if let Ok(fls) = fs::read_to_string(out_dir.join(format!("{stem}.fls"))) {
        let mut pwd = out_dir.to_path_buf();
        for line in fls.lines() {
            if let Some(p) = line.strip_prefix("PWD ") {
                pwd = PathBuf::from(p.trim());
            } else if let Some(p) = line.strip_prefix("INPUT ") {
                check(Path::new(p.trim()), &pwd);
            }
        }
    }
    if let Ok(blg) = fs::read_to_string(out_dir.join(format!("{stem}.blg"))) {
        for line in blg.lines() {
            // bibtex: "Database file #1: refs.bib"; biber: "Found BibTeX data source 'refs.bib'"
            let src = if let Some((_, rest)) = line.split_once("Database file #") {
                rest.split_once(": ").map(|(_, p)| p.trim().to_string())
            } else if let Some((_, rest)) = line.split_once("data source '") {
                rest.split_once('\'').map(|(p, _)| p.to_string())
            } else {
                None
            };
            if let Some(p) = src {
                check(Path::new(&p), out_dir);
            }
        }
    }
    if bad == 0 { Ok(()) } else { Err(bad) }
}

/// Tests with a real TeX build hold this, so they run one at a time: concurrent first-use builds under MiKTeX (on-the-fly
/// package installs) failed on CI runners with an empty log. None when this machine has no TeX.
#[cfg(test)]
pub(crate) fn test_tex() -> Option<std::sync::MutexGuard<'static, ()>> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    detect()?;
    Some(LOCK.lock().unwrap_or_else(|e| e.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deadline_counts_from_the_last_download_within_the_cap() {
        let (t, cap, s) = (Duration::from_secs(120), DOWNLOAD_CAP, Duration::from_secs);
        // no downloads: plain wall-clock limit
        assert!(!timed_out(s(119), None, t, cap));
        assert!(timed_out(s(121), None, t, cap));
        // still downloading at 140 s: a 200 s first build is not cut off
        assert!(!timed_out(s(200), Some(s(140)), t, cap));
        // downloads stopped at 140 s, then idle past the limit: stopped
        assert!(timed_out(s(261), Some(s(140)), t, cap));
        // downloading forever: the overall cap still stops it
        assert!(timed_out(cap + s(1), Some(cap), t, cap));
        // the cap never shortens the limit itself
        assert!(!timed_out(s(119), None, t, s(60)));
    }

    /// A 3 s process with a 1 s limit: kept alive while downloads are recorded, stopped when they are not.
    #[test]
    fn downloads_keep_a_slow_build_alive() {
        let slow = || {
            let mut c = if cfg!(windows) { Command::new("ping") } else { Command::new("sleep") };
            if cfg!(windows) { c.args(["-n", "4", "127.0.0.1"]); } else { c.arg("3"); }
            c
        };
        let activity: Activity = Default::default();
        let (a, stop) = (activity.clone(), std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)));
        let s2 = stop.clone();
        let started = Instant::now();
        let bumper = std::thread::spawn(move || {
            while !s2.load(std::sync::atomic::Ordering::SeqCst) {
                a.store(started.elapsed().as_millis() as u64 + 1, std::sync::atomic::Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(200));
            }
        });
        let (ok, killed) = run_limited_io(slow(), Duration::from_secs(1), 0, None, Some(activity)).unwrap();
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        bumper.join().unwrap();
        assert!(ok && !killed, "downloading build was stopped");
        let (_, killed) = run_limited_io(slow(), Duration::from_secs(1), 0, None, Some(Default::default())).unwrap();
        assert!(killed, "idle build was not stopped");
    }

    /// A cancel ends the running command at once (its tree, like a timeout), and one sent before the build starts stops it.
    #[test]
    fn a_cancelled_build_stops_its_process_and_an_early_cancel_stops_the_build() {
        let slow = || {
            let mut c = if cfg!(windows) { Command::new("ping") } else { Command::new("sleep") };
            if cfg!(windows) { c.args(["-n", "30", "127.0.0.1"]); } else { c.arg("29"); }
            c
        };
        let flag: CancelFlag = Default::default();
        CURRENT_CANCEL.with(|c| *c.borrow_mut() = Some(flag.clone()));
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        let started = Instant::now();
        let (ok, killed) = run_limited_io(slow(), Duration::from_secs(60), 0, None, None).unwrap();
        CURRENT_CANCEL.with(|c| *c.borrow_mut() = None);
        canceller.join().unwrap();
        assert!(!ok && killed, "cancelled command was not stopped");
        assert!(started.elapsed() < Duration::from_secs(10), "cancel waited for the command: {:?}", started.elapsed());

        cancel_build("early");
        let root = tmp("early-cancel");
        let r = compile_build(&root, req("pc0", vec![file("main.tex", "x")], 60_000), None, Some("early"));
        assert!(!r.ok && r.log.contains("cancelled"), "{}", r.log);
        assert!(!cancels().contains_key("early"), "the cancel outlived its build");
        assert!(!cancelled(), "the cancel leaked into this thread's next build");
    }

    fn file(path: &str, text: &str) -> FileIn {
        FileIn { path: path.into(), hash: sha256_hex(text.as_bytes()), content_b64: Some(B64.encode(text)) }
    }

    fn req(project: &str, files: Vec<FileIn>, timeout_ms: u64) -> CompileReq {
        CompileReq { project: project.into(), files, main: "main.tex".into(), engine: "pdflatex".into(), timeout_ms, memory_mb: 2048 }
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("p2p-tex-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    const DOC: &str = "\\documentclass{article}\\begin{document}Hello \\LaTeX{} hivetex\\end{document}\n";

    #[test]
    fn safe_paths() {
        assert!(safe_rel("sections/intro.tex").is_some());
        assert!(safe_rel("../evil.tex").is_none());
        assert!(safe_rel("/etc/passwd").is_none());
        assert!(safe_rel("C:\\x.tex").is_none());
        assert!(safe_rel("a/../../b").is_none());
        assert!(safe_rel("").is_none());
    }

    fn fake_exe(dir: &Path, name: &str) {
        fs::create_dir_all(dir).unwrap();
        let file = dir.join(if cfg!(windows) { format!("{name}.exe") } else { name.to_string() });
        fs::write(&file, b"").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn managed_tinytex(bin: &Path) -> EngineInfo {
        EngineInfo { flavor: "tinytex (managed)".into(), supports: vec!["pdflatex".into()], has_latexmk: false, verified_reads: true, bin_dir: Some(bin.to_path_buf()) }
    }

    #[test]
    fn saves_reuse_the_detected_engine() {
        let bin = tmp("cache-reuse");
        fake_exe(&bin, "pdflatex");
        let cache = EngineCache::new();
        let calls = std::cell::Cell::new(0);
        let detect = || {
            calls.set(calls.get() + 1);
            Some(managed_tinytex(&bin))
        };
        for _ in 0..10 {
            assert!(cache.get_or_detect(&detect).is_some());
        }
        assert_eq!(calls.get(), 1, "ten compiles, one detection");
        cache.refresh(&detect);
        assert_eq!(calls.get(), 2, "the UI asking always detects again");
    }

    #[test]
    fn forgotten_or_vanished_engine_is_detected_again() {
        let bin = tmp("cache-forget");
        fake_exe(&bin, "pdflatex");
        let cache = EngineCache::new();
        let calls = std::cell::Cell::new(0);
        let found = std::cell::Cell::new(true);
        let detect = || {
            calls.set(calls.get() + 1);
            found.get().then(|| managed_tinytex(&bin))
        };
        cache.get_or_detect(&detect);
        cache.forget(); // a managed compiler was installed or removed
        cache.get_or_detect(&detect);
        assert_eq!(calls.get(), 2);
        fs::remove_dir_all(&bin).unwrap(); // the engine was uninstalled behind our back
        found.set(false);
        assert!(cache.get_or_detect(&detect).is_none());
        assert!(cache.get_or_detect(&detect).is_none());
        assert_eq!(calls.get(), 4, "\"nothing found\" is not remembered");
    }

    #[test]
    fn managed_tinytex_is_preferred_to_system_versions_and_tectonic() {
        let root = tmp("managed-order");
        let empty = tmp("empty-path");
        assert!(detect_with(Some(empty.as_os_str()), Some(&root)).is_none(), "nothing installed: no engine");
        fake_exe(&root.join("tectonic"), "tectonic");
        let t = detect_with(Some(empty.as_os_str()), Some(&root)).unwrap();
        assert_eq!(t.flavor, "tectonic (managed)");
        assert!(!t.verified_reads, "Tectonic builds must stay local");
        let bin = root.join("tinytex").join("bin").join("x86_64-test");
        fake_versioned_engine(&bin);
        let tt = detect_with(Some(empty.as_os_str()), Some(&root)).unwrap();
        assert!(tt.flavor.starts_with("tinytex"), "{}", tt.flavor);
        assert!(tt.verified_reads);
        assert_eq!(tt.bin_dir.as_deref(), Some(bin.as_path()));
        let sys = tmp("system-path");
        fake_versioned_engine(&sys);
        let s = detect_with(Some(sys.as_os_str()), Some(&root)).unwrap();
        assert_eq!(s.bin_dir.as_deref(), Some(bin.as_path()), "managed full LaTeX wins over system installs");
        let s = detect_with(Some(sys.as_os_str()), None).unwrap();
        assert_eq!(s.bin_dir.as_deref(), Some(sys.as_path()), "system TeX keeps its bin directory");
    }

    fn fake_versioned_engine(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        #[cfg(windows)]
        fs::write(dir.join("pdflatex.cmd"), "@echo pdfTeX (TeX Live 2026)\r\n@exit /b 0\r\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join("pdflatex");
            fs::write(&path, "#!/bin/sh\necho 'pdfTeX (TeX Live 2026)'\n").unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn broken_candidates_are_skipped_without_mixing_installations() {
        let root = tmp("multiple-versions");
        let stale = root.join("stale");
        let good = root.join("good");
        let other = root.join("other");
        fake_exe(&stale, "pdflatex");
        fake_exe(&stale, "latexmk");
        fake_exe(&good, "pdflatex");
        fake_exe(&other, "xelatex");
        fake_exe(&other, "latexmk");
        let path = std::env::join_paths([&stale, &good, &other]).unwrap();
        let info = detect_in_with(&path, &|exe, _| (!exe.starts_with(&stale)).then(|| "pdfTeX (TeX Live 2026)".into())).unwrap();
        assert_eq!(info.bin_dir, Some(good));
        assert_eq!(info.supports, vec!["pdflatex"]);
        assert!(!info.has_latexmk, "latexmk in a different installation is not used");
    }

    #[test]
    fn failed_program_is_not_a_distribution() {
        let root = tmp("invalid-engine");
        fake_exe(&root, "pdflatex"); // existing file, but not an executable
        assert!(detect_in(root.as_os_str()).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn a_hung_version_probe_is_terminated_within_its_deadline() {
        let started = Instant::now();
        let cmd = std::env::var_os("ComSpec").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("cmd.exe"));
        assert!(probe_output(&cmd, &["/c", "ping -n 30 127.0.0.1 >nul"], Duration::from_millis(200)).is_none());
        assert!(started.elapsed() < Duration::from_secs(5), "a hung version probe was not bounded");
    }

    /// Real build with the managed Tectonic (downloads packages on first use). Run with
    /// HIVETEX_TECTONIC_ROOT=<folder containing tectonic/tectonic(.exe)> cargo test --lib real_tectonic -- --ignored
    #[test]
    #[ignore]
    fn real_tectonic_builds_with_lazy_packages_and_is_local_only() {
        let Some(root) = std::env::var_os("HIVETEX_TECTONIC_ROOT").map(PathBuf::from) else { return };
        set_managed_root(root.clone());
        let work = tmp("real-tectonic");
        let doc = r"\documentclass{article}
\usepackage{siunitx}
\begin{document}
Speed: \qty{3}{\metre\per\second}
\end{document}
";
        let req = CompileReq {
            project: "p1".into(),
            files: vec![FileIn { path: "main.tex".into(), hash: "h".into(), content_b64: Some(B64.encode(doc)) }],
            main: "main.tex".into(),
            engine: "pdflatex".into(),
            timeout_ms: 600_000,
            memory_mb: 0,
        };
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let s2 = seen.clone();
        let cb: OnDownload = std::sync::Arc::new(move |f: &str| s2.lock().unwrap().push(f.to_string()));
        let r = compile_with(&work, req, Some(cb));
        assert!(r.ok, "{}", r.log);
        assert!(r.local_only);
        assert!(r.log.contains("quick compiler"));
        eprintln!("downloaded during the build: {:?}", seen.lock().unwrap());
    }

    /// Real build with the managed TinyTeX installing a missing package. Run after real_tinytex_installs_and_compiles:
    /// HIVETEX_IGNORE_SYSTEM_TEX=1 HIVETEX_TINYTEX_ROOT=<root> cargo test --lib real_tinytex_installs_missing -- --ignored
    #[test]
    #[ignore]
    fn real_tinytex_installs_missing_packages() {
        let Some(root) = std::env::var_os("HIVETEX_TINYTEX_ROOT").map(PathBuf::from) else { return };
        set_managed_root(root);
        let work = tmp("real-tinytex");
        let doc = r"\documentclass{article}
\usepackage{tikz-cd}
\begin{document}
\begin{tikzcd} A \arrow[r] & B \end{tikzcd}
\end{document}
";
        let req = CompileReq {
            project: "p2".into(),
            files: vec![FileIn { path: "main.tex".into(), hash: "h".into(), content_b64: Some(B64.encode(doc)) }],
            main: "main.tex".into(),
            engine: "pdflatex".into(),
            timeout_ms: 900_000,
            memory_mb: 0,
        };
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let s2 = seen.clone();
        let cb: OnDownload = std::sync::Arc::new(move |f: &str| s2.lock().unwrap().push(f.to_string()));
        let r = compile_with(&work, req, Some(cb));
        eprintln!("events: {:?}", seen.lock().unwrap());
        eprintln!("ok={} local_only={} tail: {}", r.ok, r.local_only, &r.log[r.log.len().saturating_sub(600)..]);
        assert!(!r.local_only, "TinyTeX builds are verified and shareable");
        assert!(r.ok, "the missing package is installed and the build succeeds");
    }

    #[test]
    fn tectonic_alone_is_never_advertised() {
        // A PATH holding only a fake `tectonic` executable: detection must report no engine.
        let d = tmp("tectonic-only");
        let name = if cfg!(windows) { "tectonic.exe" } else { "tectonic" };
        fs::write(d.join(name), b"").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(d.join(name), fs::Permissions::from_mode(0o755)).unwrap();
        }
        // Only this module's own lookup is exercised, with an explicit PATH instead of the process environment.
        assert!(find_exe_in("pdflatex", d.as_os_str()).is_none());
        assert!(find_exe_in("tectonic", d.as_os_str()).is_some());
        assert!(detect_in(d.as_os_str()).is_none(), "a tectonic-only machine must not advertise an engine");
    }

    #[test]
    fn detects_a_distribution_or_skips() {
        match detect() {
            Some(i) => assert!(!i.supports.is_empty()),
            None => eprintln!("no TeX installed; detection returned None"),
        }
    }

    #[test]
    fn compiles_a_sample_document() {
        let Some(_tex) = test_tex() else {
            return;
        };
        let root = tmp("sample");
        let r = compile(&root, req("p1", vec![file("main.tex", DOC)], 120_000));
        assert!(r.ok, "log: {}", r.log);
        let pdf = B64.decode(r.pdf_b64.unwrap()).unwrap();
        assert!(pdf.starts_with(b"%PDF"));
        assert!(r.synctex_b64.is_some());
    }

    #[test]
    fn asks_for_missing_content_and_skips_unchanged_files() {
        let Some(_tex) = test_tex() else {
            return;
        };
        let root = tmp("need");
        let f = file("main.tex", DOC);
        let first = compile(&root, req("p2", vec![FileIn { path: f.path.clone(), hash: f.hash.clone(), content_b64: None }], 120_000));
        assert_eq!(first.need, vec!["main.tex".to_string()]);
        let ok = compile(&root, req("p2", vec![file("main.tex", DOC)], 120_000));
        assert!(ok.ok, "{}", ok.log);
        let written = fs::metadata(root.join("builds/p2/main.tex")).unwrap().modified().unwrap();
        std::thread::sleep(Duration::from_millis(30));
        // same hash, no content: must not ask again and must not rewrite the file
        let again = compile(&root, req("p2", vec![FileIn { path: f.path, hash: f.hash, content_b64: None }], 120_000));
        assert!(again.need.is_empty() && again.ok, "{:?}", again.log);
        assert_eq!(fs::metadata(root.join("builds/p2/main.tex")).unwrap().modified().unwrap(), written);
    }

    #[test]
    fn rejects_path_traversal() {
        let root = tmp("trav");
        let r = compile(&root, req("p3", vec![file("../escape.tex", "x"), file("main.tex", DOC)], 5_000));
        assert!(!r.ok);
        assert!(r.log.contains("unsafe path"));
        assert!(!root.join("builds/escape.tex").exists());
    }

    #[test]
    fn shell_escape_payload_does_not_execute() {
        let Some(_tex) = test_tex() else {
            return;
        };
        let root = tmp("write18");
        let payload = if cfg!(windows) { "cmd /c echo pwned > pwned.txt" } else { "echo pwned > pwned.txt" };
        let doc = format!(
            "\\documentclass{{article}}\\begin{{document}}\\immediate\\write18{{{payload}}}x\\end{{document}}\n"
        );
        let _ = compile(&root, req("p4", vec![file("main.tex", &doc)], 60_000));
        assert!(!root.join("builds/p4/pwned.txt").exists(), "shell escape executed!");
    }

    #[test]
    fn project_latexmkrc_is_never_executed() {
        let Some(_tex) = test_tex() else { return };
        if !detect().is_some_and(|i| i.has_latexmk) {
            return;
        }
        let root = tmp("rc");
        // latexmk rc files are Perl: untrusted project configuration must never run on the local compiler.
        let marker = root.join("rc-pwned.txt");
        let perl = format!("open(my $f, '>', '{}'); print $f 'pwned'; close($f);\n", marker.to_string_lossy().replace('\\', "/"));
        let files = vec![file("main.tex", DOC), file(".latexmkrc", &perl), file("latexmkrc", &perl)];
        let r = compile(&root, req("p9", files, 120_000));
        assert!(!marker.exists(), "latexmkrc from the project was executed! log: {}", r.log);
        assert!(!root.join("builds/p9/.latexmkrc").exists() && !root.join("builds/p9/latexmkrc").exists());
        assert!(r.ok, "the document itself must still compile: {}", r.log);
    }

    #[test]
    fn files_outside_the_project_are_not_read() {
        let Some(_tex) = test_tex() else {
            return;
        };
        let root = tmp("outside");
        // If TeX ever reads this file and shares the result, the log contains LEAKED.
        let secret = root.join("secret.tex");
        fs::write(&secret, "\\errmessage{LEAKED}\n").unwrap();
        // A 1x1 PNG standing in for a private image, and a private bibliography.
        let png = B64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==").unwrap();
        fs::write(root.join("private.png"), png).unwrap();
        fs::write(root.join("private.bib"), "@misc{leak, title={LEAKEDBIB}}\n").unwrap();
        let abs = |f: &str| root.join(f).to_string_lossy().replace('\\', "/");
        let cases = [
            ("abs", format!("\\input{{{}}}", abs("secret.tex"))),
            ("rel", "\\input{../../secret.tex}".to_string()),
            ("img", format!("\\includegraphics{{{}}}", abs("private.png"))),
            ("bib", format!("\\cite{{leak}}\\bibliographystyle{{plain}}\\bibliography{{{}}}", abs("private"))),
        ];
        for (n, body) in cases {
            let doc = format!("\\documentclass{{article}}\\usepackage{{graphicx}}\\begin{{document}}x{body}\\end{{document}}\n");
            let r = compile(&root, req(&format!("p10{n}"), vec![file("main.tex", &doc)], 120_000));
            assert!(!r.log.contains("LEAKED"), "{n}: content of a file outside the project was shared:\n{}", r.log);
            // Whether the engine refused the file (MiKTeX switches; bibtex with openin_any=p) or read it (TeX Live
            // ignores openin_any for \input/\includegraphics) depends on the distribution. What must hold everywhere:
            // if anything private was actually read, nothing produced by the run is shared.
            let build = root.join("builds").join(format!("p10{n}"));
            let fls = fs::read_to_string(build.join("main.fls")).unwrap_or_default();
            let bbl = fs::read_to_string(build.join("main.bbl")).unwrap_or_default();
            let read_private = fls.contains("secret.tex") || fls.contains("private.png") || bbl.contains("LEAKEDBIB");
            if read_private {
                assert!(
                    r.pdf_b64.is_none() && r.synctex_b64.is_none() && r.log.contains("outside the project"),
                    "{n}: a private file was read but the result was shared:\n{}",
                    r.log
                );
            }
        }
    }

    #[test]
    fn infinite_loop_is_aborted_at_the_time_limit() {
        let Some(_tex) = test_tex() else {
            return;
        };
        let root = tmp("loop");
        let doc = "\\documentclass{article}\\begin{document}\\def\\x{\\x}\\x\\end{document}\n";
        let t = Instant::now();
        let r = compile(&root, req("p5", vec![file("main.tex", doc)], 3_000));
        assert!(r.timed_out, "expected timeout, log: {}", r.log);
        assert!(!r.ok);
        assert!(r.log.contains("timed out"));
        assert!(t.elapsed() < Duration::from_secs(30));
    }

    /// Inputs changed (or the project closed) during a build that would run for minutes: cancelling it ends the compiler
    /// process tree, and the next build of the project starts without waiting for the old one.
    #[test]
    fn cancelled_native_build_ends_the_compiler_and_the_next_build_runs() {
        let Some(_tex) = test_tex() else {
            return;
        };
        let root = tmp("cancel");
        let looping = "\\documentclass{article}\\begin{document}\\def\\x{\\x}\\x\\end{document}\n";
        let r2 = root.clone();
        let t = Instant::now();
        let build = std::thread::spawn(move || compile_build(&r2, req("pc1", vec![file("main.tex", looping)], 300_000), None, Some("b1")));
        std::thread::sleep(Duration::from_secs(3));
        cancel_build("b1");
        let r = build.join().unwrap();
        assert!(!r.ok && r.log.contains("cancelled"), "{}", r.log);
        assert!(t.elapsed() < Duration::from_secs(30), "cancel waited for the build: {:?}", t.elapsed());
        let doc = "\\documentclass{article}\\begin{document}After cancel\\end{document}\n";
        let next = compile_build(&root, req("pc1", vec![file("main.tex", doc)], 120_000), None, Some("b2"));
        assert!(next.ok, "{}", next.log);
    }

    #[test]
    fn reports_errors_in_the_log() {
        let Some(_tex) = test_tex() else {
            return;
        };
        let root = tmp("err");
        let doc = "\\documentclass{article}\\begin{document}\\undefinedcommand\\end{document}\n";
        let r = compile(&root, req("p6", vec![file("main.tex", doc)], 60_000));
        assert!(!r.ok);
        assert!(r.log.contains("Undefined control sequence"), "{}", r.log);
    }
}
