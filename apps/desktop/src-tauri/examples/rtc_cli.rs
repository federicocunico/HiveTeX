//! Test harness: exposes the `rtc_*` bridge over stdin/stdout so the TypeScript adapter can be exercised against
//! the real Rust implementation without a webview. One JSON object per line.
//!   in : {"rid": 1, "cmd": "rtc_create", "args": {...}}
//!   out: {"rid": 1, "result": ...} | {"rid": 1, "error": "..."} | {"event": "rtc://x", "payload": {...}}

use p2platex_desktop_lib::rtc::{Emit, IceServer, RtcState};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

#[tokio::main]
async fn main() {
    let state = Arc::new(RtcState::default());
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    // Single writer task keeps lines intact.
    tokio::spawn(async move {
        use std::io::Write;
        let stdout = std::io::stdout();
        while let Some(line) = rx.recv().await {
            let mut out = stdout.lock();
            let _ = writeln!(out, "{line}");
            let _ = out.flush();
        }
    });
    let emit: Emit = {
        let tx = tx.clone();
        Arc::new(move |name, payload| {
            let _ = tx.send(json!({ "event": name, "payload": payload }).to_string());
        })
    };

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let (state, emit, tx) = (state.clone(), emit.clone(), tx.clone());
        tokio::spawn(async move {
            let rid = req["rid"].clone();
            let a = &req["args"];
            let s = |k: &str| a[k].as_str().unwrap_or_default().to_string();
            let res: Result<Value, String> = match req["cmd"].as_str().unwrap_or_default() {
                "rtc_create" => {
                    let ice: Vec<IceServer> = serde_json::from_value(a["ice"].clone()).unwrap_or_default();
                    state.create(&s("id"), ice, emit).await.map(|_| Value::Null)
                }
                "rtc_create_data_channel" => state.create_data_channel(&s("id"), &s("label"), emit).await.map(|_| Value::Null),
                "rtc_create_offer" => state.create_offer(&s("id")).await.map(Value::from),
                "rtc_create_answer" => state.create_answer(&s("id")).await.map(Value::from),
                "rtc_set_local" => state.set_local(&s("id"), &s("kind"), s("sdp")).await.map(|_| Value::Null),
                "rtc_set_remote" => state.set_remote(&s("id"), &s("kind"), s("sdp")).await.map(|_| Value::Null),
                "rtc_add_ice" => state.add_ice(&s("id"), a["candidate"].clone()).await.map(|_| Value::Null),
                "rtc_send" => state.send(&s("id"), &s("label"), &s("b64")).await.map(Value::from),
                "rtc_close" => {
                    state.close(&s("id")).await;
                    Ok(Value::Null)
                }
                other => Err(format!("unknown command {other}")),
            };
            let out = match res {
                Ok(v) => json!({ "rid": rid, "result": v }),
                Err(e) => json!({ "rid": rid, "error": e }),
            };
            let _ = tx.send(out.to_string());
        });
    }
}
