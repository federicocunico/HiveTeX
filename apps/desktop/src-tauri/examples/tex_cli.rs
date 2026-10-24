//! Test/diagnostic harness: reads one JSON line {"cmd":"tex_detect"|"tex_compile","args":{...}} per line on
//! stdin and answers with one JSON line. Lets the TypeScript NativeEngine be tested against the real Rust code.

use hivetex_desktop_lib::tex;
use hivetex_desktop_lib::helper::Helper;
use std::io::{BufRead, Write};
use std::sync::Arc;

fn main() {
    // Acceptance may supply a disposable managed distribution, never the user's TeX configuration.
    if let Some(managed) = std::env::var_os("HIVETEX_TINYTEX_ROOT") {
        tex::set_managed_root(managed.into());
    }
    let root = std::env::args().nth(1).map(std::path::PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("p2p-tex-cli"));
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    let mut helper: Option<Helper> = None;
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let _ = writeln!(out, "{}", serde_json::json!({ "error": e.to_string() }));
                continue;
            }
        };
        let reply = match v["cmd"].as_str() {
            // Isolated acceptance only: this CLI owns the helper and its automatic pairing approval.
            Some("helper_start") => {
                if helper.is_none() {
                    let work = root.clone();
                    helper = Some(Helper::start(None, vec!["http://localhost:1420".into()],
                        Arc::new(move |req| tex::compile_with(&work, req, None)),
                        Arc::new(|_| true), Arc::new(tex::detect)).expect("start acceptance helper"));
                }
                serde_json::json!({ "port": helper.as_ref().unwrap().port })
            },
            Some("tex_detect") => serde_json::to_value(tex::detect()).unwrap(),
            Some("tex_compile") => match serde_json::from_value::<tex::CompileReq>(v["args"]["req"].clone()) {
                Ok(req) => serde_json::to_value(tex::compile(&root, req)).unwrap(),
                Err(e) => serde_json::json!({ "error": e.to_string() }),
            },
            _ => serde_json::json!({ "error": "unknown command" }),
        };
        let _ = writeln!(out, "{reply}");
        let _ = out.flush();
    }
}
