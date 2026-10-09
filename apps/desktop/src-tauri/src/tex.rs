//! Native LaTeX compilation: detects a system TeX distribution (TeX Live / MiKTeX / MacTeX) and runs it
//! in a hardened, incremental working directory.
//!
//! Hardening: shell escape disabled, path-restricted file access, wall-clock timeout, memory limit
//! (Windows job object / Unix rlimit), whole process tree killed on timeout, files confined to the
//! project working directory.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct EngineInfo {
    pub flavor: String,
    pub supports: Vec<String>,
    pub has_latexmk: bool,
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

fn version_text(exe: &Path) -> String {
    Command::new(exe)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

pub fn detect() -> Option<EngineInfo> {
    detect_in(&std::env::var_os("PATH")?)
}

/// `detect` over an explicit search path (tests).
pub fn detect_in(path: &std::ffi::OsStr) -> Option<EngineInfo> {
    let mut supports = Vec::new();
    let mut flavor = String::new();
    for e in ["pdflatex", "xelatex", "lualatex"] {
        if let Some(p) = find_exe_in(e, path) {
            supports.push(e.to_string());
            if flavor.is_empty() {
                let v = version_text(&p);
                flavor = if v.contains("MiKTeX") {
                    "miktex"
                } else if v.contains("TeX Live") || v.contains("TeX Live") {
                    "texlive"
                } else {
                    "tex"
                }
                .into();
            }
        }
    }
    // Tectonic alone is deliberately not offered: it writes no recorder file, so what a document read cannot be
    // verified (see verify_reads), and its I/O reads absolute paths directly. A device without a regular TeX
    // distribution therefore advertises no engine and is never elected.
    if supports.is_empty() {
        return None;
    }
    Some(EngineInfo { flavor, supports, has_latexmk: find_exe_in("latexmk", path).is_some() })
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

/// Runs a command with limits; returns (exit_success, timed_out).
fn run_limited(mut cmd: Command, timeout: Duration, memory_mb: u64) -> std::io::Result<(bool, bool)> {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
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
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW | CREATE_SUSPENDED is awkward with std; assign the job right after spawn instead.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn()?;
    #[cfg(windows)]
    let _job = winjob::JobGuard::attach(&child, memory_mb);
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok((status.success(), false));
        }
        if start.elapsed() > timeout {
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
mod winjob {
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
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE);
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
    let mut c = Command::new(exe);
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
    let mut resp = CompileResp::default();
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

    let Some(info) = detect() else {
        resp.log = "! No TeX installation found (install TeX Live, MiKTeX or MacTeX)".into();
        return resp;
    };
    if !info.supports.iter().any(|e| e == &req.engine) {
        resp.log = format!("! This device cannot run {}", req.engine);
        return resp;
    }
    let timeout = Duration::from_millis(req.timeout_ms.max(1000));
    let mem = req.memory_mb;
    let main_name = main_rel.to_string_lossy().to_string();
    let engine_exe = find_exe(&req.engine).unwrap_or_else(|| PathBuf::from(&req.engine));
    let installer = if info.flavor == "miktex" { Some("--enable-installer") } else { None };

    let (mut success, mut timed_out) = (false, false);
    if info.has_latexmk {
        let mut cmd = base_command(find_exe("latexmk").unwrap(), &dir);
        cmd.arg(match req.engine.as_str() {
            "xelatex" => "-xelatex",
            "lualatex" => "-lualatex",
            _ => "-pdf",
        })
        // -norc: ignore every latexmkrc (system, user and the project's own); all options come from here.
        .args(["-norc", "-recorder", "-interaction=nonstopmode", "-synctex=1", "-latexoption=-no-shell-escape"]);
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
                if let Some(b) = find_exe("bibtex") {
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

    // Distributions do not reliably stop a document from *reading* outside the project (TeX Live 2026 ignores
    // openin_any=p for reads; MiKTeX's switches do not cover \includegraphics). So check what was actually read,
    // and if anything came from outside the project or the TeX installation, nothing produced by this run leaves
    // the device: not the PDF, not SyncTeX, not even the log (it would show the content or the paths).
    if let Err(n) = verify_reads(&dir, &out_dir, &stem) {
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

// ---------------------------------------------------------------------------------------------
// What did the engine read?
// ---------------------------------------------------------------------------------------------

/// Directories of the TeX installation (kpathsea variables), resolved once. Reading from these is expected.
fn tex_roots() -> &'static Vec<PathBuf> {
    static ROOTS: std::sync::OnceLock<Vec<PathBuf>> = std::sync::OnceLock::new();
    ROOTS.get_or_init(|| {
        let mut out = Vec::new();
        let Some(kpse) = find_exe("kpsewhich") else { return out };
        let sep = if cfg!(windows) { ';' } else { ':' };
        for var in [
            "TEXMFROOT", "TEXMFDIST", "TEXMFMAIN", "TEXMFLOCAL", "TEXMFSYSVAR", "TEXMFSYSCONFIG", "TEXMFVAR",
            "TEXMFCONFIG", "TEXMFHOME", "TEXMFCACHE", "SELFAUTOPARENT",
        ] {
            let Ok(o) = Command::new(&kpse).arg(format!("-var-value={var}")).stdin(Stdio::null()).stderr(Stdio::null()).output() else { continue };
            for v in String::from_utf8_lossy(&o.stdout).trim().split(sep) {
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
    })
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
    let build = build.canonicalize().unwrap_or_else(|_| build.to_path_buf());
    let roots = tex_roots();
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

#[cfg(test)]
mod tests {
    use super::*;

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

    const DOC: &str = "\\documentclass{article}\\begin{document}Hello \\LaTeX{} p2platex\\end{document}\n";

    #[test]
    fn safe_paths() {
        assert!(safe_rel("sections/intro.tex").is_some());
        assert!(safe_rel("../evil.tex").is_none());
        assert!(safe_rel("/etc/passwd").is_none());
        assert!(safe_rel("C:\\x.tex").is_none());
        assert!(safe_rel("a/../../b").is_none());
        assert!(safe_rel("").is_none());
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
        if detect().is_none() {
            return;
        }
        let root = tmp("sample");
        let r = compile(&root, req("p1", vec![file("main.tex", DOC)], 120_000));
        assert!(r.ok, "log: {}", r.log);
        let pdf = B64.decode(r.pdf_b64.unwrap()).unwrap();
        assert!(pdf.starts_with(b"%PDF"));
        assert!(r.synctex_b64.is_some());
    }

    #[test]
    fn asks_for_missing_content_and_skips_unchanged_files() {
        if detect().is_none() {
            return;
        }
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
        if detect().is_none() {
            return;
        }
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
        if detect().map(|i| i.has_latexmk) != Some(true) {
            return;
        }
        let root = tmp("rc");
        // latexmk rc files are Perl: a collaborator could run anything on the compile leader.
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
        if detect().is_none() {
            return;
        }
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
        if detect().is_none() {
            return;
        }
        let root = tmp("loop");
        let doc = "\\documentclass{article}\\begin{document}\\def\\x{\\x}\\x\\end{document}\n";
        let t = Instant::now();
        let r = compile(&root, req("p5", vec![file("main.tex", doc)], 3_000));
        assert!(r.timed_out, "expected timeout, log: {}", r.log);
        assert!(!r.ok);
        assert!(r.log.contains("timed out"));
        assert!(t.elapsed() < Duration::from_secs(30));
    }

    #[test]
    fn reports_errors_in_the_log() {
        if detect().is_none() {
            return;
        }
        let root = tmp("err");
        let doc = "\\documentclass{article}\\begin{document}\\undefinedcommand\\end{document}\n";
        let r = compile(&root, req("p6", vec![file("main.tex", doc)], 60_000));
        assert!(!r.ok);
        assert!(r.log.contains("Undefined control sequence"), "{}", r.log);
    }
}
