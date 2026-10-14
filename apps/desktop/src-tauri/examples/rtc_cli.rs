//! Test harness: exposes the `rtc_*` bridge over stdin/stdout so the TypeScript adapter can be exercised against
//! the real Rust implementation without a webview. One JSON object per line.
//!   in : {"rid": 1, "cmd": "rtc_create", "args": {...}}
//!   out: {"rid": 1, "result": ...} | {"rid": 1, "error": "..."} | {"event": "rtc://x", "payload": {...}}
//! `rtc_create` takes `ice`, `muxed`, `policy` ("relay": relay candidates only) and `interfaces` ("all", "default",
//! "physical": see rtc.rs `interface_policy`); `rtc_log` returns the stack's own lines.

use hivetex_desktop_lib::portmap::{real_discover, Mapper};
use hivetex_desktop_lib::rtc::{Emit, IceServer, RtcState};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

#[tokio::main]
async fn main() {
    hivetex_desktop_lib::rtc_log::install();
    let state = Arc::new(RtcState::default());
    // Router port mapping for the shared listener (netlab router matrix): the real IGD client and mapping manager.
    let mapper = Mapper::new(state.transport.clone(), real_discover(), "netlab0000000000".into());
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
        let (state, emit, tx, mapper) = (state.clone(), emit.clone(), tx.clone(), mapper.clone());
        tokio::spawn(async move {
            let rid = req["rid"].clone();
            let a = &req["args"];
            let s = |k: &str| a[k].as_str().unwrap_or_default().to_string();
            let res: Result<Value, String> = match req["cmd"].as_str().unwrap_or_default() {
                "rtc_create" => {
                    let ice: Vec<IceServer> = serde_json::from_value(a["ice"].clone()).unwrap_or_default();
                    state.create_full(&s("id"), ice, emit, a["muxed"].as_bool().unwrap_or(false), a["policy"].as_str(), a["interfaces"].as_str()).await.map(|_| Value::Null)
                }
                "rtc_create_data_channel" => state.create_data_channel(&s("id"), &s("label"), emit).await.map(|_| Value::Null),
                "rtc_create_offer" => state.create_offer(&s("id")).await.map(Value::from),
                "rtc_create_answer" => state.create_answer(&s("id")).await.map(Value::from),
                "rtc_set_local" => state.set_local(&s("id"), &s("kind"), s("sdp")).await.map(|_| Value::Null),
                "rtc_set_remote" => state.set_remote(&s("id"), &s("kind"), s("sdp")).await.map(|_| Value::Null),
                "rtc_add_ice" => state.add_ice(&s("id"), a["candidate"].clone()).await.map(|_| Value::Null),
                "rtc_send" => state.send(&s("id"), &s("label"), &s("b64")).await.map(Value::from),
                "rtc_stats" => state.stats(&s("id")).await,
                // The stack's own log lines after `since` (masked, credential-free).
                "rtc_log" => Ok(json!(hivetex_desktop_lib::rtc_log::ring().since(a["since"].as_u64().unwrap_or(0)).into_iter().map(|(seq, line)| json!({"seq": seq, "line": line})).collect::<Vec<_>>())),
                "rtc_local_sdp" => state.local_sdp(&s("id")).await.map(|v| json!(v)),
                "upnp_enable" => {
                    // Bind the listener first: the mapping targets the socket connections will share.
                    let lease = state.transport.acquire().await;
                    std::mem::forget(lease);
                    mapper.enable();
                    Ok(Value::Null)
                }
                "upnp_disable" => {
                    mapper.disable().await;
                    Ok(Value::Null)
                }
                "upnp_status" => serde_json::to_value(mapper.status()).map_err(|e| e.to_string()),
                "listener" => Ok(json!(state.transport.current_local().map(|(g, a)| json!({"generation": g, "local": a.to_string()})))),
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
