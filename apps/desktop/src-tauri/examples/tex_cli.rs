//! Test/diagnostic harness: reads one JSON line {"cmd":"tex_detect"|"tex_compile","args":{...}} per line on
//! stdin and answers with one JSON line. Lets the TypeScript NativeEngine be tested against the real Rust code.

use hivetex_desktop_lib::tex;
use std::io::{BufRead, Write};

fn main() {
    let root = std::env::args().nth(1).map(std::path::PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("p2p-tex-cli"));
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
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
