//! Native LaTeX compilation: detects a system TeX distribution (TeX Live / MiKTeX / MacTeX) or a
//! `tectonic` binary and runs it in a hardened, incremental working directory.
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
    let path = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or(".EXE;.CMD;.BAT".into())
            .split(';')
            .map(|s| s.to_lowercase())
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&path) {
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
    let mut supports = Vec::new();
    let mut flavor = String::new();
    for e in ["pdflatex", "xelatex", "lualatex"] {
        if let Some(p) = find_exe(e) {
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
    if supports.is_empty() {
        if find_exe("tectonic").is_some() {
            return Some(EngineInfo { flavor: "tectonic".into(), supports: vec!["xelatex".into()], has_latexmk: false });
        }
        return None;
    }
    Some(EngineInfo { flavor, supports, has_latexmk: find_exe("latexmk").is_some() })
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
        .env("TEXMF_OUTPUT_DIRECTORY", ".");
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
        .args(["-interaction=nonstopmode", "-synctex=1", "-latexoption=-no-shell-escape"]);
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
            c.args(["-interaction=nonstopmode", "-synctex=1", "-no-shell-escape"]);
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
