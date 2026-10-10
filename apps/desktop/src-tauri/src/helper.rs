//! Local compile helper: while the desktop app runs, the HiveTeX web app can compile on this computer.
//! Loopback only; requests must come from the configured web origin and (for /compile) carry a token obtained by
//! pairing, which the user confirms in the desktop app. Tokens are stored only as SHA-256 hashes.

use crate::tex::{CompileReq, CompileResp, FileIn};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const PORTS: [u16; 4] = [47812, 47813, 47814, 47815];
const MAX_BODY: usize = 50 * 1024 * 1024;
const RATE_PER_MIN: usize = 30;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Pairing {
    pub id: String,
    pub username: String,
    pub server: String,
    pub created: u64,
    /// SHA-256 of the token (hex); the token itself is only ever held by the web app.
    pub token_hash: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct PairRequest {
    pub id: String,
    pub username: String,
    pub server: String,
    pub origin: String,
}

pub type CompileFn = Arc<dyn Fn(CompileReq) -> CompileResp + Send + Sync>;
/// Asks the user to allow a pairing; returns their decision (false on timeout).
pub type ConfirmFn = Arc<dyn Fn(PairRequest) -> bool + Send + Sync>;
/// The local compiler /status reports (None: no compiler on this computer).
pub type StatusFn = Arc<dyn Fn() -> Option<crate::tex::EngineInfo> + Send + Sync>;

pub struct Helper {
    pub port: u16,
    state: Arc<State>,
}

struct State {
    allowed_origins: Mutex<Vec<String>>,
    enabled: Mutex<bool>,
    pairings: Mutex<Vec<Pairing>>,
    store: Option<PathBuf>,
    rate: Mutex<HashMap<String, Vec<Instant>>>,
    busy: Mutex<()>,
    compile: CompileFn,
    confirm: ConfirmFn,
    status: StatusFn,
}

fn sha_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("system randomness");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Deserialize)]
struct PairBody {
    username: String,
    server: String,
}

#[derive(Deserialize)]
struct CompileBody {
    main: String,
    engine: String,
    files: Vec<CompileFile>,
    /// Keeps each project's build folder (and auxiliary files) apart.
    #[serde(default)]
    project: String,
}

#[derive(Deserialize)]
struct CompileFile {
    path: String,
    b64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompileReply {
    ok: bool,
    log: String,
    pdf_b64: Option<String>,
    synctex_b64: Option<String>,
    timed_out: bool,
    /// The build must not be shared with co-authors (quick compiler).
    local_only: bool,
}

impl Helper {
    /// Starts the service on the first free port of PORTS (loopback only).
    pub fn start(store: Option<PathBuf>, allowed_origins: Vec<String>, compile: CompileFn, confirm: ConfirmFn, status: StatusFn) -> Result<Helper, String> {
        let pairings = store.as_ref().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let state = Arc::new(State {
            allowed_origins: Mutex::new(allowed_origins),
            enabled: Mutex::new(true),
            pairings: Mutex::new(pairings),
            store,
            rate: Mutex::new(HashMap::new()),
            busy: Mutex::new(()),
            compile,
            confirm,
            status,
        });
        for port in PORTS {
            if let Ok(server) = tiny_http::Server::http(("127.0.0.1", port)) {
                let st = state.clone();
                std::thread::spawn(move || {
                    for req in server.incoming_requests() {
                        let st = st.clone();
                        // Each request on its own thread: a pairing waits for the user without blocking /status.
                        std::thread::spawn(move || handle(&st, req));
                    }
                });
                return Ok(Helper { port, state });
            }
        }
        Err("no free port for the local compile helper".into())
    }

    pub fn set_allowed_origins(&self, origins: Vec<String>) {
        *self.state.allowed_origins.lock().unwrap() = origins;
    }

    pub fn set_enabled(&self, on: bool) {
        *self.state.enabled.lock().unwrap() = on;
    }

    pub fn enabled(&self) -> bool {
        *self.state.enabled.lock().unwrap()
    }

    pub fn pairings(&self) -> Vec<Pairing> {
        self.state.pairings.lock().unwrap().clone()
    }

    pub fn revoke(&self, id: &str) {
        self.state.pairings.lock().unwrap().retain(|p| p.id != id);
        self.state.save();
    }
}

impl State {
    fn save(&self) {
        if let Some(p) = &self.store {
            let list = self.pairings.lock().unwrap().clone();
            if let Ok(json) = serde_json::to_vec_pretty(&list) {
                let _ = std::fs::write(p, json);
            }
        }
    }

    fn origin_allowed(&self, origin: &str) -> bool {
        self.allowed_origins.lock().unwrap().iter().any(|o| o == origin)
    }

    fn pairing_for(&self, auth: Option<&str>) -> Option<Pairing> {
        let token = auth?.strip_prefix("Bearer ")?.trim();
        if token.len() != 64 {
            return None;
        }
        let h = sha_hex(token);
        self.pairings.lock().unwrap().iter().find(|p| p.token_hash == h).cloned()
    }

    fn rate_ok(&self, id: &str) -> bool {
        let mut r = self.rate.lock().unwrap();
        let v = r.entry(id.to_string()).or_default();
        let now = Instant::now();
        v.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
        if v.len() >= RATE_PER_MIN {
            return false;
        }
        v.push(now);
        true
    }
}

fn header(req: &tiny_http::Request, name: &str) -> Option<String> {
    req.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str().to_string())
}

fn respond(req: tiny_http::Request, status: u16, body: String, origin: Option<&str>) {
    let mut res = tiny_http::Response::from_string(body).with_status_code(status);
    let mut add = |k: &str, v: &str| {
        if let Ok(h) = tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()) {
            res.add_header(h);
        }
    };
    add("Content-Type", "application/json");
    add("Cache-Control", "no-store");
    if let Some(o) = origin {
        add("Access-Control-Allow-Origin", o);
        add("Vary", "Origin");
    }
    let _ = req.respond(res);
}

fn json_err(msg: &str) -> String {
    serde_json::json!({ "error": msg }).to_string()
}

fn handle(st: &State, mut req: tiny_http::Request) {
    let origin = header(&req, "Origin").unwrap_or_default();
    // Only the HiveTeX web app may talk to the helper (DNS rebinding and other sites are refused here).
    if !st.origin_allowed(&origin) {
        return respond(req, 403, json_err("origin not allowed"), None);
    }
    let allow = Some(origin.as_str());
    if !*st.enabled.lock().unwrap() {
        return respond(req, 503, json_err("the desktop app does not accept compiles from the web app right now"), allow);
    }
    let path = req.url().split('?').next().unwrap_or("").to_string();
    if req.method() == &tiny_http::Method::Options {
        let mut res = tiny_http::Response::empty(204);
        for (k, v) in [
            ("Access-Control-Allow-Origin", origin.as_str()),
            ("Access-Control-Allow-Methods", "GET, POST"),
            ("Access-Control-Allow-Headers", "Authorization, Content-Type"),
            ("Access-Control-Allow-Private-Network", "true"),
            ("Access-Control-Max-Age", "600"),
            ("Vary", "Origin"),
        ] {
            if let Ok(h) = tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()) {
                res.add_header(h);
            }
        }
        let _ = req.respond(res);
        return;
    }
    if req.body_length().unwrap_or(0) > MAX_BODY {
        return respond(req, 413, json_err("project too large"), allow);
    }
    let mut body = Vec::new();
    if req.as_reader().take(MAX_BODY as u64 + 1).read_to_end(&mut body).is_err() || body.len() > MAX_BODY {
        return respond(req, 413, json_err("project too large"), allow);
    }
    match (req.method(), path.as_str()) {
        (tiny_http::Method::Get, "/status") => {
            let compiler = (st.status)();
            let reply = serde_json::json!({
                "app": "hivetex",
                "version": env!("CARGO_PKG_VERSION"),
                "compiler": compiler.as_ref().map(|c| c.flavor.clone()),
                "supports": compiler.as_ref().map(|c| c.supports.clone()).unwrap_or_default(),
                "verifiedReads": compiler.map(|c| c.verified_reads).unwrap_or(false),
            });
            respond(req, 200, reply.to_string(), allow)
        }
        (tiny_http::Method::Post, "/pair") => {
            let Ok(b) = serde_json::from_slice::<PairBody>(&body) else { return respond(req, 400, json_err("bad request"), allow) };
            if b.username.len() > 64 || b.server.len() > 256 {
                return respond(req, 400, json_err("bad request"), allow);
            }
            let id = random_hex(8);
            let ok = (st.confirm)(PairRequest { id: id.clone(), username: b.username.clone(), server: b.server.clone(), origin: origin.clone() });
            if !ok {
                return respond(req, 403, json_err("not allowed on the desktop"), allow);
            }
            let token = random_hex(32);
            let created = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            st.pairings.lock().unwrap().push(Pairing { id: id.clone(), username: b.username, server: b.server, created, token_hash: sha_hex(&token) });
            st.save();
            respond(req, 200, serde_json::json!({ "token": token, "id": id }).to_string(), allow)
        }
        (tiny_http::Method::Post, "/compile") => {
            let Some(pairing) = st.pairing_for(header(&req, "Authorization").as_deref()) else {
                return respond(req, 401, json_err("not paired"), allow);
            };
            if !st.rate_ok(&pairing.id) {
                return respond(req, 429, json_err("too many compiles; wait a minute"), allow);
            }
            let Ok(b) = serde_json::from_slice::<CompileBody>(&body) else { return respond(req, 400, json_err("bad request"), allow) };
            if crate::tex::safe_rel(&b.main).is_none() || b.files.iter().any(|f| crate::tex::safe_rel(&f.path).is_none()) {
                return respond(req, 400, json_err("file paths must stay inside the project"), allow);
            }
            let mut files = Vec::with_capacity(b.files.len());
            for f in b.files {
                let Ok(bytes) = B64.decode(&f.b64) else { return respond(req, 400, json_err("bad request"), allow) };
                let hash = Sha256::digest(&bytes).iter().map(|x| format!("{x:02x}")).collect();
                files.push(FileIn { hash, path: f.path, content_b64: Some(f.b64) });
            }
            let creq = CompileReq { project: format!("helper-{}-{}", pairing.id, b.project.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect::<String>()), files, main: b.main, engine: b.engine, timeout_ms: 300_000, memory_mb: 2048 };
            // One compile at a time on this computer.
            let _guard = st.busy.lock().unwrap();
            let r = (st.compile)(creq);
            let reply = CompileReply { ok: r.ok, log: r.log, pdf_b64: r.pdf_b64, synctex_b64: r.synctex_b64, timed_out: r.timed_out, local_only: r.local_only };
            respond(req, 200, serde_json::to_string(&reply).unwrap_or_default(), allow)
        }
        _ => respond(req, 404, json_err("not found"), allow),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WEB: &str = "https://hivetex.vercel.app";

    fn start(confirm: bool) -> Helper {
        let compile: CompileFn = Arc::new(|r: CompileReq| CompileResp {
            ok: true,
            log: format!("built {} with {} files", r.main, r.files.len()),
            pdf_b64: Some(B64.encode(b"%PDF")),
            ..Default::default()
        });
        let confirm_fn: ConfirmFn = Arc::new(move |_| confirm);
        let status: StatusFn = Arc::new(|| Some(crate::tex::EngineInfo { flavor: "texlive".into(), supports: vec!["pdflatex".into()], has_latexmk: true, verified_reads: true, bin_dir: None }));
        Helper::start(None, vec![WEB.into()], compile, confirm_fn, status).unwrap()
    }

    fn call(h: &Helper, method: &str, path: &str, origin: Option<&str>, token: Option<&str>, body: &str) -> (u16, String) {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let c = reqwest::Client::new();
            let mut r = c.request(method.parse().unwrap(), format!("http://127.0.0.1:{}{path}", h.port)).body(body.to_string());
            if let Some(o) = origin {
                r = r.header("Origin", o);
            }
            if let Some(t) = token {
                r = r.header("Authorization", format!("Bearer {t}"));
            }
            let res = r.send().await.unwrap();
            (res.status().as_u16(), res.text().await.unwrap())
        })
    }

    // The tests share the fixed ports, so they run as one sequence.
    #[test]
    fn helper_security_and_compile() {
        let h = start(true);
        // other websites and requests without an Origin are refused outright
        assert_eq!(call(&h, "GET", "/status", Some("https://evil.example"), None, "").0, 403);
        assert_eq!(call(&h, "GET", "/status", None, None, "").0, 403);
        let (s, body) = call(&h, "GET", "/status", Some(WEB), None, "");
        assert_eq!(s, 200);
        assert!(body.contains("\"verifiedReads\":true") && !body.contains("token"));
        // compile without pairing, or with a wrong token
        let files = r#"{"main":"main.tex","engine":"pdflatex","files":[{"path":"main.tex","b64":"eA=="}]}"#;
        assert_eq!(call(&h, "POST", "/compile", Some(WEB), None, files).0, 401);
        assert_eq!(call(&h, "POST", "/compile", Some(WEB), Some(&"0".repeat(64)), files).0, 401);
        // pairing (confirmed by the user) gives a token that compiles
        let (s, body) = call(&h, "POST", "/pair", Some(WEB), None, r#"{"username":"alice","server":"https://hivetex.vercel.app"}"#);
        assert_eq!(s, 200);
        let token = serde_json::from_str::<serde_json::Value>(&body).unwrap()["token"].as_str().unwrap().to_string();
        assert_eq!(h.pairings().len(), 1);
        assert!(!h.pairings()[0].token_hash.contains(&token), "only the hash is kept");
        let (s, body) = call(&h, "POST", "/compile", Some(WEB), Some(&token), files);
        assert_eq!(s, 200, "{body}");
        assert!(body.contains("\"ok\":true") && body.contains("built main.tex with 1 files"));
        // paths outside the project
        let evil = r#"{"main":"main.tex","engine":"pdflatex","files":[{"path":"../x.tex","b64":"eA=="}]}"#;
        assert_eq!(call(&h, "POST", "/compile", Some(WEB), Some(&token), evil).0, 400);
        // oversized project
        let big = format!(r#"{{"main":"m","engine":"pdflatex","files":[{{"path":"a","b64":"{}"}}]}}"#, "A".repeat(MAX_BODY));
        assert_eq!(call(&h, "POST", "/compile", Some(WEB), Some(&token), &big).0, 413);
        // revoked pairing no longer compiles
        let id = h.pairings()[0].id.clone();
        h.revoke(&id);
        assert_eq!(call(&h, "POST", "/compile", Some(WEB), Some(&token), files).0, 401);
        // turned off
        h.set_enabled(false);
        assert_eq!(call(&h, "GET", "/status", Some(WEB), None, "").0, 503);
        h.set_enabled(true);
        drop(h);
    }

    #[test]
    fn compiles_through_the_native_pipeline() {
        if crate::tex::detect().is_none() {
            eprintln!("no TeX on this machine: skipped");
            return;
        }
        let root = std::env::temp_dir().join(format!("hivetex-helper-{}", random_hex(4)));
        let r2 = root.clone();
        let compile: CompileFn = Arc::new(move |req| crate::tex::compile_with(&r2, req, None));
        let h = Helper::start(None, vec![WEB.into()], compile, Arc::new(|_| true), Arc::new(|| None)).unwrap();
        let (_, body) = call(&h, "POST", "/pair", Some(WEB), None, r#"{"username":"alice","server":"s"}"#);
        let token = serde_json::from_str::<serde_json::Value>(&body).unwrap()["token"].as_str().unwrap().to_string();
        let doc = B64.encode("\\documentclass{article}\\begin{document}Hello helper\\end{document}\n");
        let files = format!(r#"{{"main":"main.tex","engine":"pdflatex","files":[{{"path":"main.tex","b64":"{doc}"}}]}}"#);
        let (s, body) = call(&h, "POST", "/compile", Some(WEB), Some(&token), &files);
        assert_eq!(s, 200);
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["ok"], true, "{}", v["log"]);
        assert!(B64.decode(v["pdfB64"].as_str().unwrap()).unwrap().starts_with(b"%PDF"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn pairing_refused_on_the_desktop_gives_no_token() {
        // runs on another port: the first helper of this process holds 47812 for the whole run
        let h = start(false);
        let (s, body) = call(&h, "POST", "/pair", Some(WEB), None, r#"{"username":"mallory","server":"x"}"#);
        assert_eq!(s, 403, "{body}");
        assert!(!body.contains("token"));
        assert!(h.pairings().is_empty());
    }
}
