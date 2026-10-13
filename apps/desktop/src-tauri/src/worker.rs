//! Supervision of the headless sync worker (D1, tasks 6.2-6.3). The native side starts exactly one program: the
//! bundled Node runtime with the bundled worker script, both at fixed paths inside the app's resources. It is started
//! hidden through `proc::background_command`, with a cleared environment (no NODE_OPTIONS / NODE_PATH injection), and
//! talks over its stdin/stdout pipes only (the framing of packages/sync/src/worker-ipc.ts). The worker exits when its
//! stdin closes; on Windows a kill-on-close job object and on Linux a parent-death signal make sure it cannot outlive
//! the app even if the app is killed.

use crate::proc::background_command;
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::time::{Duration, Instant};

pub const PROTOCOL: u64 = 1;
pub const MAX_FRAME: usize = 8 * 1024 * 1024;

/// Where the worker lives inside the app's resources. Nothing about it comes from the user or the network.
#[derive(Clone, Debug)]
pub struct WorkerSpec {
    pub node: PathBuf,
    pub script: PathBuf,
}

impl WorkerSpec {
    pub fn in_resources(dir: &Path) -> WorkerSpec {
        let exe = if cfg!(windows) { "node.exe" } else if cfg!(target_os = "macos") {
            if cfg!(target_arch = "aarch64") { "node-arm64" } else { "node-x64" }
        } else { "node" };
        WorkerSpec { node: dir.join("node").join(exe), script: dir.join("worker").join("hivetex-worker.mjs") }
    }

    /// Checks the packaged runtime and bundle against the manifests written at packaging time
    /// (`prepare-worker.mjs`, `worker-build.mjs`): the Node executable must be one of the pinned, checksummed
    /// downloads, and the script exactly the bundle that was built. A tampered or half-updated install never runs.
    pub fn verify(&self) -> Result<(), String> {
        use sha2::{Digest, Sha256};
        let hash = |p: &Path| -> Result<String, String> {
            let bytes = std::fs::read(p).map_err(|_| format!("{} is missing", p.display()))?;
            Ok(Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect())
        };
        let read = |p: PathBuf| -> Result<Value, String> {
            serde_json::from_slice(&std::fs::read(&p).map_err(|_| format!("{} is missing", p.display()))?)
                .map_err(|_| format!("{} is unreadable", p.display()))
        };
        let node_dir = self.node.parent().ok_or("bad runtime path")?;
        let script_dir = self.script.parent().ok_or("bad worker path")?;
        let runtime = read(node_dir.join("manifest.json"))?;
        let bundle = read(script_dir.join("manifest.json"))?;
        let node_hash = hash(&self.node)?;
        let pinned = runtime["assets"].as_array().is_some_and(|a| a.iter().any(|x| x["executableSha256"] == node_hash.as_str()));
        // Inside an AppImage, linuxdeploy rewrites every bundled ELF executable (its library search path), so the
        // runtime cannot keep the download's checksum. The image itself is read-only and signed for updates: check
        // that the bundled runtime is the pinned version instead. The worker bundle keeps its exact checksum below.
        let rewritten_by_appimage = !pinned && cfg!(target_os = "linux") && (std::env::var_os("APPIMAGE").is_some() || std::env::var_os("APPDIR").is_some()) && {
            let version = runtime["version"].as_str().unwrap_or_default();
            crate::proc::background_command(&self.node).env_clear().arg("--version").output()
                .is_ok_and(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == format!("v{version}"))
        };
        if !pinned && !rewritten_by_appimage {
            return Err("the bundled Node runtime does not match its pinned checksum".into());
        }
        if bundle["node"] != runtime["version"] {
            return Err("the sync worker was built for another Node version".into());
        }
        if bundle["sha256"] != hash(&self.script)?.as_str() {
            return Err("the sync worker bundle does not match its checksum".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod verify_tests {
    use super::*;

    #[test]
    fn packaged_worker_is_verified_against_its_manifests() {
        use sha2::{Digest, Sha256};
        let dir = std::env::temp_dir().join(format!("hivetex-verify-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("node")).unwrap();
        std::fs::create_dir_all(dir.join("worker")).unwrap();
        let spec = WorkerSpec { node: dir.join("node").join("node.exe"), script: dir.join("worker").join("hivetex-worker.mjs") };
        let hex = |b: &[u8]| Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect::<String>();
        std::fs::write(&spec.node, b"runtime").unwrap();
        std::fs::write(&spec.script, b"bundle").unwrap();
        std::fs::write(dir.join("node/manifest.json"), json!({"version":"22.22.0","assets":[{"executableSha256": hex(b"runtime")}]}).to_string()).unwrap();
        std::fs::write(dir.join("worker/manifest.json"), json!({"node":"22.22.0","sha256": hex(b"bundle")}).to_string()).unwrap();
        spec.verify().unwrap();
        std::fs::write(&spec.script, b"bundle+patched").unwrap();
        assert!(spec.verify().unwrap_err().contains("bundle"));
        std::fs::write(&spec.script, b"bundle").unwrap();
        std::fs::write(&spec.node, b"another node").unwrap();
        assert!(spec.verify().unwrap_err().contains("runtime"));
        std::fs::write(&spec.node, b"runtime").unwrap();
        std::fs::write(dir.join("worker/manifest.json"), json!({"node":"20.0.0","sha256": hex(b"bundle")}).to_string()).unwrap();
        assert!(spec.verify().unwrap_err().contains("Node version"));
        std::fs::remove_file(dir.join("node/manifest.json")).unwrap();
        assert!(spec.verify().is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_shipped_resources_pass_verification() {
        // The resources prepared for this build (prepare-worker.mjs) verify, as the packaged app does at startup.
        let spec = WorkerSpec::in_resources(&Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"));
        if spec.node.is_file() {
            spec.verify().unwrap();
        }
    }
}

/// Variables the worker keeps from the app's environment; everything else (NODE_OPTIONS, NODE_PATH, NODE_*, proxies of
/// the user's shell...) is dropped so nothing can inject code into it.
const KEEP_ENV: [&str; 10] = ["SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "LANG"];

pub struct Worker {
    pub child: Child,
    pub gen: u64,
    pub stdin: Option<ChildStdin>,
    #[cfg(windows)]
    _job: Option<crate::tex::winjob::JobGuard>,
}

pub fn spawn(spec: &WorkerSpec, gen: u64) -> io::Result<Worker> {
    let mut cmd = background_command(&spec.node);
    // Tauri's Windows resource path is canonical (\\?\C:\...). Node 22 treats that entry-point spelling as C:,
    // so pass a normal absolute DOS/UNC spelling of the same fixed packaged script, never a shell string.
    cmd.arg("--disable-warning=ExperimentalWarning").arg(node_path(&spec.script));
    if let Some(parent) = spec.script.parent() { cmd.current_dir(node_path(parent)); }
    cmd.env_clear();
    for k in KEEP_ENV {
        if let Some(v) = std::env::var_os(k) {
            cmd.env(k, v);
        }
    }
    cmd.env("HIVETEX_WORKER_GEN", gen.to_string());
    // background_command gives the program a null stdin; the worker's pipe replaces it.
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "linux")]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            // Killed with the app, even on SIGKILL of the app.
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
    let mut child = cmd.spawn()?;
    #[cfg(windows)]
    let job = crate::tex::winjob::JobGuard::attach(&child, 0);
    let stdin = child.stdin.take();
    Ok(Worker {
        child,
        gen,
        stdin,
        #[cfg(windows)]
        _job: job,
    })
}

fn node_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") { return PathBuf::from(format!(r"\\{unc}")); }
        if let Some(dos) = text.strip_prefix(r"\\?\") { return PathBuf::from(dos); }
    }
    path.to_path_buf()
}

pub fn encode(msg: &Value) -> io::Result<Vec<u8>> {
    let body = serde_json::to_vec(msg).map_err(io::Error::other)?;
    if body.len() > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut out = (body.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(&body);
    Ok(out)
}

/// Reads one frame. An oversized length or a non-JSON body is fatal for the stream (framing is lost).
pub fn read_frame(r: &mut impl Read) -> io::Result<Value> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let n = u32::from_be_bytes(len) as usize;
    if n > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut body = vec![0u8; n];
    r.read_exact(&mut body)?;
    serde_json::from_slice(&body).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "malformed frame"))
}

/// A message of this generation and protocol, or None (dropped: another generation, or not a protocol message).
pub fn accept(msg: &Value, gen: u64) -> Option<&Value> {
    (msg.get("v")?.as_u64()? == PROTOCOL && msg.get("gen")?.as_u64()? == gen).then_some(msg)
}

/// Requests the worker may make of the native side. Anything else (a shell, arbitrary files, other commands) is refused.
pub const WORKER_METHODS: &[&str] = &[
    "store.open", "store.close", "store.transact", "store.load", "store.listDocs", "store.putBlob", "store.stageChunk",
    "store.stageCommit", "store.stageAbort", "store.blobSize", "store.readBlob", "store.listBlobs", "store.putSnapshot",
    "store.listSnapshots", "store.getMeta", "store.listMeta", "store.putChange", "store.listChanges", "store.pruneChanges",
    "store.ingressPut", "store.ingressAck", "store.ingressPending",
    "rtc.create", "rtc.createDataChannel", "rtc.createOffer", "rtc.createAnswer", "rtc.setLocal", "rtc.setRemote", "rtc.localSdp",
    "rtc.addIce", "rtc.send", "rtc.close",
    "secret.get", "status.report",
];

pub fn allowed(method: &str) -> bool {
    WORKER_METHODS.contains(&method)
}

/// A response refusing a request that is not on the list.
pub fn refuse(id: &Value, gen: u64, method: &str) -> Value {
    json!({ "v": PROTOCOL, "gen": gen, "kind": "res", "id": id, "ok": false, "error": { "code": "unknown_method", "message": format!("method not allowed: {method}") } })
}

/// Restart policy (D1): exponential jittered backoff from 1 s to 30 s; more than five crashes within ten minutes stops
/// restarting and reports "needs attention" until the user retries.
#[derive(Debug)]
pub struct RestartPolicy {
    crashes: Vec<Instant>,
}

#[derive(Debug, PartialEq)]
pub enum Next {
    RestartAfter(Duration),
    NeedsAttention,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        RestartPolicy { crashes: Vec::new() }
    }
}

impl RestartPolicy {
    /// Records a crash at `now` and decides what to do; `jitter` in [0, 1).
    pub fn on_crash(&mut self, now: Instant, jitter: f64) -> Next {
        self.crashes.retain(|t| now.duration_since(*t) < Duration::from_secs(600));
        self.crashes.push(now);
        let n = self.crashes.len();
        if n > 5 {
            return Next::NeedsAttention;
        }
        let base = (1u64 << (n - 1).min(5)).min(30) as f64;
        let secs = (base * (0.75 + 0.5 * jitter.clamp(0.0, 1.0))).clamp(1.0, 30.0);
        Next::RestartAfter(Duration::from_secs_f64(secs))
    }
    /// The user asked to try again (or the worker ran healthily for a while): forget earlier crashes.
    pub fn reset(&mut self) {
        self.crashes.clear();
    }
}

/// Writes one framed message to the worker.
pub fn send(stdin: &mut ChildStdin, msg: &Value) -> io::Result<()> {
    stdin.write_all(&encode(msg)?)?;
    stdin.flush()
}

/// What the supervisor reports to the app (tray, dashboard).
#[derive(Clone, Debug, PartialEq)]
pub enum SupervisorState {
    Starting { gen: u64 },
    Running { gen: u64 },
    Exited { gen: u64, code: Option<i32> },
    Restarting { gen: u64, after: Duration },
    NeedsAttention,
    Stopped,
}

pub type FrameSink = std::sync::Arc<dyn Fn(u64, Value) + Send + Sync>;
pub type StateSink = std::sync::Arc<dyn Fn(SupervisorState) + Send + Sync>;

struct Shared {
    stopped: bool,
    gen: u64,
    stdin: Option<WorkerInput>,
    pid: Option<u32>,
    policy: RestartPolicy,
}

/// Frames queued for the worker beyond this (bytes) mean it stopped reading: sends fail instead of growing memory.
const INPUT_QUEUE_MAX: usize = 64 << 20;

/// The worker's stdin, written by a thread of its own. Writing to the pipe from the callers (under the supervisor lock)
/// deadlocked: a full pipe blocked the writer while holding the lock, the frame reader then waited for that lock, the
/// worker's own synchronous stdout writes blocked because nobody read them, so it never read its stdin again. Callers
/// now only enqueue; dropping the input closes the queue, and the thread then closes stdin (EOF) after the queued frames.
struct WorkerInput {
    tx: std::sync::mpsc::Sender<Vec<u8>>,
    queued: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl WorkerInput {
    fn start(mut stdin: ChildStdin) -> WorkerInput {
        use std::sync::atomic::Ordering;
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let queued = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let left = queued.clone();
        std::thread::spawn(move || {
            while let Ok(bytes) = rx.recv() {
                let ok = stdin.write_all(&bytes).and_then(|_| stdin.flush()).is_ok();
                left.fetch_sub(bytes.len(), Ordering::SeqCst);
                if !ok {
                    break;
                }
            }
        });
        WorkerInput { tx, queued }
    }

    fn send(&self, msg: &Value) -> io::Result<()> {
        use std::sync::atomic::Ordering;
        let bytes = encode(msg)?;
        if self.queued.load(Ordering::SeqCst) + bytes.len() > INPUT_QUEUE_MAX {
            return Err(io::Error::new(io::ErrorKind::WouldBlock, "worker is not reading its input"));
        }
        self.queued.fetch_add(bytes.len(), Ordering::SeqCst);
        self.tx.send(bytes).map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "worker input closed"))
    }
}

/// Keeps one worker generation running: forwards its frames (current generation only), restarts it after a crash with
/// the restart policy, and stops it on request. Old generations can never deliver frames after a restart.
pub struct Supervisor {
    shared: std::sync::Arc<std::sync::Mutex<Shared>>,
    state: StateSink,
}

impl Supervisor {
    /// `scale` shortens the restart delays (tests); 1.0 in the app.
    pub fn start(spec: WorkerSpec, on_frame: FrameSink, on_state: StateSink, scale: f64) -> Supervisor {
        let shared = std::sync::Arc::new(std::sync::Mutex::new(Shared { stopped: false, gen: 0, stdin: None, pid: None, policy: RestartPolicy::default() }));
        let sup = Supervisor { shared: shared.clone(), state: on_state.clone() };
        std::thread::spawn(move || Self::run(spec, shared, on_frame, on_state, scale));
        sup
    }

    fn run(spec: WorkerSpec, shared: std::sync::Arc<std::sync::Mutex<Shared>>, on_frame: FrameSink, on_state: StateSink, scale: f64) {
        loop {
            let gen = {
                let mut s = shared.lock().unwrap();
                if s.stopped {
                    return;
                }
                s.gen += 1;
                s.gen
            };
            on_state(SupervisorState::Starting { gen });
            let mut w = match spawn(&spec, gen) {
                Ok(w) => w,
                Err(_) => {
                    if !Self::backoff(&shared, &on_state, gen, scale) {
                        return;
                    }
                    continue;
                }
            };
            {
                let mut s = shared.lock().unwrap();
                s.stdin = w.stdin.take().map(WorkerInput::start);
                s.pid = Some(w.child.id());
                if s.stopped {
                    s.stdin = None; // EOF: the worker exits by itself
                }
            }
            on_state(SupervisorState::Running { gen });
            let initialized = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            // Drain the diagnostic pipe so a noisy failed generation cannot block. Only bounded, already-redacted
            // worker diagnostics are shown; stdout remains exclusively framed IPC.
            let err = w.child.stderr.take().unwrap();
            #[cfg(feature = "test-picker")]
            let initialized_err = initialized.clone();
            let diagnostics = std::thread::spawn(move || {
                use std::io::{BufRead, Read};
                let mut reader = std::io::BufReader::new(err);
                let mut bytes = Vec::new();
                loop {
                    bytes.clear();
                    if reader.by_ref().take(4097).read_until(b'\n', &mut bytes).unwrap_or(0) == 0 { break; }
                    if bytes.len() <= 4096 {
                        let line = String::from_utf8_lossy(&bytes);
                        if line.starts_with("hivetex-worker:") { eprint!("{line}"); }
                        #[cfg(feature = "test-picker")]
                        if !initialized_err.load(std::sync::atomic::Ordering::SeqCst) && !line.starts_with("hivetex-worker:") {
                            // Bootstrap diagnostics contain only bundled source/paths: no request has run yet.
                            eprint!("worker bootstrap: {line}");
                        }
                    }
                }
            });
            let mut out = w.child.stdout.take().unwrap();
            let sink = on_frame.clone();
            let reader = std::thread::spawn(move || {
                while let Ok(m) = read_frame(&mut out) {
                    if accept(&m, gen).is_some() {
                        if m["event"] == "ready" { initialized.store(true, std::sync::atomic::Ordering::SeqCst); }
                        sink(gen, m);
                    }
                }
            });
            let exit = w.child.wait();
            if let Ok(status) = exit {
                if !status.success() { eprintln!("sync worker generation {gen} exited: {status}"); }
                on_state(SupervisorState::Exited { gen, code: status.code() });
            }
            let _ = reader.join();
            let _ = diagnostics.join();
            let stopped = {
                let mut s = shared.lock().unwrap();
                s.stdin = None;
                s.pid = None;
                s.stopped
            };
            if stopped {
                on_state(SupervisorState::Stopped);
                return;
            }
            if !Self::backoff(&shared, &on_state, gen, scale) {
                return;
            }
        }
    }

    /// After a crash: waits per the policy; false when the supervisor gives up (needs attention) or was stopped.
    fn backoff(shared: &std::sync::Arc<std::sync::Mutex<Shared>>, on_state: &StateSink, gen: u64, scale: f64) -> bool {
        let next = {
            let mut s = shared.lock().unwrap();
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
            s.policy.on_crash(Instant::now(), (nanos % 1000) as f64 / 1000.0)
        };
        match next {
            Next::NeedsAttention => {
                on_state(SupervisorState::NeedsAttention);
                false
            }
            Next::RestartAfter(d) => {
                let d = d.mul_f64(scale);
                on_state(SupervisorState::Restarting { gen, after: d });
                std::thread::sleep(d);
                !shared.lock().unwrap().stopped
            }
        }
    }

    /// Sends a frame to the current generation: queued for its writer thread, never blocking on the pipe.
    pub fn send(&self, msg: &Value) -> io::Result<()> {
        let s = self.shared.lock().unwrap();
        let input = s.stdin.as_ref().ok_or_else(|| io::Error::new(io::ErrorKind::NotConnected, "worker not running"))?;
        input.send(msg)
    }

    pub fn generation(&self) -> u64 {
        self.shared.lock().unwrap().gen
    }
    pub fn pid(&self) -> Option<u32> {
        self.shared.lock().unwrap().pid
    }

    /// Orderly stop: closes the worker's stdin (it flushes and exits); the job object / process kill is the backstop.
    pub fn stop(&self) {
        let mut s = self.shared.lock().unwrap();
        s.stopped = true;
        s.stdin = None;
        if s.pid.is_none() {
            (self.state)(SupervisorState::Stopped);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn node_entry_point_accepts_tauri_canonical_resource_paths() {
        assert_eq!(node_path(Path::new(r"\\?\C:\Program Files\HiveTeX\worker\main.mjs")), PathBuf::from(r"C:\Program Files\HiveTeX\worker\main.mjs"));
        assert_eq!(node_path(Path::new(r"\\?\UNC\server\share\worker\main.mjs")), PathBuf::from(r"\\server\share\worker\main.mjs"));
        let Some(mut spec) = dev_spec() else { return; };
        spec.script = spec.script.canonicalize().unwrap();
        let mut child = spawn(&spec, 8).unwrap();
        let mut output = child.child.stdout.take().unwrap();
        assert_eq!(read_frame(&mut output).unwrap()["event"], "ready");
        child.stdin.take();
        assert!(child.child.wait().unwrap().success());
    }

    /// Builds the worker bundle with the repository's script and returns a spec using the developer's `node`.
    fn dev_spec() -> Option<WorkerSpec> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let out = std::env::temp_dir().join(format!("hivetex-worker-test-{}", std::process::id())).join("hivetex-worker.mjs");
        let node = which("node")?;
        let ok = crate::proc::background_command(&node).arg(root.join("worker-build.mjs")).arg(&out).current_dir(&root).status().ok()?.success();
        ok.then_some(WorkerSpec { node, script: out })
    }
    fn which(name: &str) -> Option<PathBuf> {
        let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
        std::env::split_paths(&std::env::var_os("PATH")?).map(|d| d.join(&exe)).find(|p| p.is_file())
    }
    fn request(w: &mut Worker, id: u64, method: &str) -> Value {
        send(w.stdin.as_mut().unwrap(), &json!({ "v": 1, "gen": w.gen, "kind": "req", "id": id, "method": method })).unwrap();
        let out = w.child.stdout.as_mut().unwrap();
        loop {
            let m = read_frame(out).unwrap();
            if m["kind"] == "res" && m["id"] == id {
                return m;
            }
        }
    }

    #[test]
    fn starts_the_bundled_worker_hidden_with_a_cleared_environment_and_it_exits_on_pipe_eof() {
        let Some(spec) = dev_spec() else {
            eprintln!("node not available; skipping");
            return;
        };
        // A poisoned NODE_OPTIONS in the app's environment must not reach the worker (it would fail to start).
        std::env::set_var("NODE_OPTIONS", "--require=/nonexistent/inject.js");
        let mut w = spawn(&spec, 3).unwrap();
        std::env::remove_var("NODE_OPTIONS");
        let hello = request(&mut w, 1, "hello");
        assert_eq!(hello["ok"], true);
        assert_eq!(hello["result"]["gen"], 3);
        assert_eq!(hello["gen"], 3);
        drop(w.stdin.take()); // the app went away
        let status = w.child.wait().unwrap();
        assert!(status.success());
    }

    #[cfg(windows)]
    #[test]
    fn the_job_object_terminates_the_worker_when_the_app_side_closes() {
        let Some(spec) = dev_spec() else { return };
        let mut w = spawn(&spec, 1).unwrap();
        let _ = request(&mut w, 1, "hello");
        let pid = w.child.id();
        let stdin = w.stdin.take(); // keep the pipe open: only the job may end it
        drop(w._job.take());
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(5) {
            if w.child.try_wait().unwrap().is_some() {
                drop(stdin);
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("worker {pid} survived its job");
    }

    fn wait_for(cond: impl Fn() -> bool, secs: u64) -> bool {
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(secs) {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn supervisor_restarts_a_crashed_worker_with_a_new_generation_and_stops_it_without_orphans() {
        let Some(spec) = dev_spec() else { return };
        let frames = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(u64, Value)>::new()));
        let states = std::sync::Arc::new(std::sync::Mutex::new(Vec::<SupervisorState>::new()));
        let (f2, s2) = (frames.clone(), states.clone());
        let sup = Supervisor::start(spec, std::sync::Arc::new(move |g, m| f2.lock().unwrap().push((g, m))), std::sync::Arc::new(move |s| s2.lock().unwrap().push(s)), 0.01);
        assert!(wait_for(|| frames.lock().unwrap().iter().any(|(g, m)| *g == 1 && m["event"] == "ready"), 10));
        // Crash generation 1 from outside, as a fault would.
        let pid1 = sup.pid().unwrap();
        kill(pid1);
        assert!(wait_for(|| sup.generation() == 2 && sup.pid().is_some(), 10), "restarted");
        assert!(wait_for(|| frames.lock().unwrap().iter().any(|(g, m)| *g == 2 && m["event"] == "ready"), 10));
        sup.send(&json!({ "v": 1, "gen": 2, "kind": "req", "id": 1, "method": "hello" })).unwrap();
        assert!(wait_for(|| frames.lock().unwrap().iter().any(|(g, m)| *g == 2 && m["kind"] == "res"), 10));
        let pid2 = sup.pid().unwrap();
        sup.stop();
        assert!(wait_for(|| states.lock().unwrap().last() == Some(&SupervisorState::Stopped), 10));
        assert!(wait_for(|| !alive(pid1) && !alive(pid2), 5), "no orphan worker");
        assert!(states.lock().unwrap().iter().any(|s| matches!(s, SupervisorState::Restarting { gen: 1, .. })));
    }

    /// The deadlock seen in a long relay session: the app sends frames under a lock while the worker is busy writing and
    /// does not read; the frame reader needs the same lock. Sends must never block on the pipe, so the worker's frames
    /// keep flowing.
    #[test]
    fn sending_never_blocks_the_frame_reader_when_the_worker_stops_reading() {
        let Some(node) = which("node") else { return };
        let dir = std::env::temp_dir().join(format!("hivetex-flood-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("flood.mjs");
        // A worker that never reads its stdin and keeps writing events.
        std::fs::write(&script, r#"
const gen = Number(process.env.HIVETEX_WORKER_GEN);
let n = 0;
const frame = (o) => { const b = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]); };
setInterval(() => { for (let i = 0; i < 20; i++) process.stdout.write(frame({ v: 1, gen, kind: 'evt', event: 'tick', data: { n: n++, pad: 'x'.repeat(4000) } })); }, 5);
"#).unwrap();
        let gate = std::sync::Arc::new(std::sync::Mutex::new(()));
        let ticks = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (g2, t2) = (gate.clone(), ticks.clone());
        // As WorkerService does: the frame handler takes the lock the senders hold while sending.
        let sup = std::sync::Arc::new(Supervisor::start(
            WorkerSpec { node, script },
            std::sync::Arc::new(move |_, _| {
                let _held = g2.lock().unwrap();
                t2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }),
            std::sync::Arc::new(|_| {}),
            0.01,
        ));
        assert!(wait_for(|| ticks.load(std::sync::atomic::Ordering::SeqCst) > 100, 10), "the worker writes");
        let (s2, g3) = (sup.clone(), gate.clone());
        let sender = std::thread::spawn(move || {
            let big = json!({ "v": 1, "gen": 1, "kind": "evt", "event": "flood", "data": "y".repeat(60_000) });
            let started = Instant::now();
            let mut refused = 0;
            for _ in 0..2_000 {
                let _held = g3.lock().unwrap();
                if s2.send(&big).is_err() { refused += 1; }
            }
            (started.elapsed(), refused)
        });
        let (took, refused) = sender.join().unwrap();
        assert!(took < Duration::from_secs(10), "sends blocked for {took:?}");
        assert!(refused > 0, "a worker that reads nothing makes sends fail once its queue is full");
        let before = ticks.load(std::sync::atomic::Ordering::SeqCst);
        assert!(wait_for(|| ticks.load(std::sync::atomic::Ordering::SeqCst) > before + 100, 10), "the worker's frames still flow");
        sup.stop();
    }

    #[test]
    fn repeated_crashes_end_in_needs_attention() {
        // A "worker" that exits at once.
        let Some(node) = which("node") else { return };
        let dir = std::env::temp_dir().join(format!("hivetex-crash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("crash.mjs");
        std::fs::write(&script, "process.exit(3)").unwrap();
        let states = std::sync::Arc::new(std::sync::Mutex::new(Vec::<SupervisorState>::new()));
        let s2 = states.clone();
        let _sup = Supervisor::start(WorkerSpec { node, script }, std::sync::Arc::new(|_, _| {}), std::sync::Arc::new(move |s| s2.lock().unwrap().push(s)), 0.001);
        assert!(wait_for(|| states.lock().unwrap().last() == Some(&SupervisorState::NeedsAttention), 20));
        let starts = states.lock().unwrap().iter().filter(|s| matches!(s, SupervisorState::Starting { .. })).count();
        assert_eq!(starts, 6, "five restarts after the first crash, then no more");
    }

    fn alive(pid: u32) -> bool {
        #[cfg(windows)]
        {
            let out = crate::proc::background_command("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
            String::from_utf8_lossy(&out.stdout).contains(&format!(" {pid} "))
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(pid as i32, 0) == 0
        }
    }
    fn kill(pid: u32) {
        #[cfg(windows)]
        {
            let _ = crate::proc::background_command("taskkill").args(["/PID", &pid.to_string(), "/F"]).status();
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }

    #[test]
    fn frames_are_bounded_and_other_generations_are_dropped() {
        let msg = json!({ "v": 1, "gen": 2, "kind": "evt", "event": "ready" });
        let bytes = encode(&msg).unwrap();
        assert_eq!(read_frame(&mut bytes.as_slice()).unwrap(), msg);
        assert!(accept(&msg, 2).is_some());
        assert!(accept(&msg, 3).is_none());
        assert!(accept(&json!({ "v": 2, "gen": 2 }), 2).is_none());
        let mut huge = ((MAX_FRAME + 1) as u32).to_be_bytes().to_vec();
        huge.extend_from_slice(b"{}");
        assert!(read_frame(&mut huge.as_slice()).is_err());
        let mut junk = 3u32.to_be_bytes().to_vec();
        junk.extend_from_slice(b"{{{");
        assert!(read_frame(&mut junk.as_slice()).is_err());
    }

    #[test]
    fn native_dispatch_is_an_allowlist() {
        for ok in ["store.transact", "rtc.send", "secret.get"] {
            assert!(allowed(ok));
        }
        for bad in ["shell.exec", "fs.read", "mirror.write", "secret.set", "tex.compile", ""] {
            assert!(!allowed(bad), "{bad}");
        }
        let r = refuse(&json!(7), 4, "shell.exec");
        assert_eq!(r["ok"], false);
        assert_eq!(r["error"]["code"], "unknown_method");
    }

    #[test]
    fn restart_backoff_grows_and_stops_after_five_crashes_in_ten_minutes() {
        let mut p = RestartPolicy::default();
        let t0 = Instant::now();
        let waits: Vec<Next> = (0..6).map(|i| p.on_crash(t0 + Duration::from_secs(i * 10), 0.5)).collect();
        assert_eq!(waits[0], Next::RestartAfter(Duration::from_secs(1)));
        assert_eq!(waits[1], Next::RestartAfter(Duration::from_secs(2)));
        assert_eq!(waits[4], Next::RestartAfter(Duration::from_secs(16)));
        assert_eq!(waits[5], Next::NeedsAttention);
        // Crashes older than ten minutes no longer count.
        let mut q = RestartPolicy::default();
        for i in 0..5 {
            q.on_crash(t0 + Duration::from_secs(i), 0.0);
        }
        assert!(matches!(q.on_crash(t0 + Duration::from_secs(700), 0.0), Next::RestartAfter(_)));
        q.reset();
        assert_eq!(q.on_crash(t0, 0.0), Next::RestartAfter(Duration::from_secs(1)));
    }
}
