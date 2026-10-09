//! WebRTC through `webrtc-rs`, exposed to the frontend over Tauri IPC. It exists for platforms whose system
//! webview has no (or a broken) `RTCPeerConnection`, notably some Linux WebKitGTK builds. The TypeScript side
//! wraps these commands in the same `RtcPeerLike` interface the browser implementation satisfies, so the sync
//! engine cannot tell the difference. Payloads cross the IPC boundary as base64.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use bytes::Bytes;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

/// Sends an event to the frontend: (event name, payload).
pub type Emit = Arc<dyn Fn(String, Value) + Send + Sync>;

struct Peer {
    pc: Arc<RTCPeerConnection>,
    dcs: Mutex<HashMap<String, Arc<RTCDataChannel>>>,
}

#[derive(Default)]
pub struct RtcState {
    peers: Mutex<HashMap<String, Arc<Peer>>>,
}

#[derive(Deserialize, Debug)]
pub struct IceServer {
    pub urls: Value,
    pub username: Option<String>,
    pub credential: Option<String>,
}

fn event_name(id: &str) -> String {
    format!("rtc://{id}")
}

fn wire_channel(id: String, dc: Arc<RTCDataChannel>, emit: Emit) {
    let label = dc.label().to_string();
    {
        let (e, id, label) = (emit.clone(), id.clone(), label.clone());
        dc.on_open(Box::new(move || {
            e(event_name(&id), json!({ "kind": "open", "label": label }));
            Box::pin(async {})
        }));
    }
    {
        let (e, id, label) = (emit.clone(), id.clone(), label.clone());
        dc.on_close(Box::new(move || {
            e(event_name(&id), json!({ "kind": "close", "label": label }));
            Box::pin(async {})
        }));
    }
    {
        let (e, id, label) = (emit.clone(), id.clone(), label.clone());
        dc.on_message(Box::new(move |msg: DataChannelMessage| {
            e(event_name(&id), json!({ "kind": "message", "label": label, "b64": B64.encode(&msg.data) }));
            Box::pin(async {})
        }));
    }
    {
        let (e, id, label) = (emit, id, label);
        let dc2 = dc.clone();
        watch_buffer(dc2, e, id, label);
    }
}

fn watch_buffer(dc: Arc<RTCDataChannel>, emit: Emit, id: String, label: String) {
    tokio::spawn(async move {
        dc.set_buffered_amount_low_threshold(512 * 1024).await;
        dc.on_buffered_amount_low(Box::new(move || {
            emit(event_name(&id), json!({ "kind": "bufferedlow", "label": label }));
            Box::pin(async {})
        }))
        .await;
    });
}

impl RtcState {
    async fn peer(&self, id: &str) -> Result<Arc<Peer>, String> {
        self.peers.lock().await.get(id).cloned().ok_or_else(|| "unknown peer connection".to_string())
    }

    pub async fn create(&self, id: &str, ice: Vec<IceServer>, emit: Emit) -> Result<(), String> {
        let mut m = MediaEngine::default();
        m.register_default_codecs().map_err(|e| e.to_string())?;
        let registry = register_default_interceptors(Registry::new(), &mut m).map_err(|e| e.to_string())?;
        let api = APIBuilder::new().with_media_engine(m).with_interceptor_registry(registry).build();
        let ice_servers = ice
            .into_iter()
            .map(|s| RTCIceServer {
                urls: match s.urls {
                    Value::String(u) => vec![u],
                    Value::Array(a) => a.into_iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
                    _ => vec![],
                },
                username: s.username.unwrap_or_default(),
                credential: s.credential.unwrap_or_default(),
                ..Default::default()
            })
            .collect();
        let pc = Arc::new(api.new_peer_connection(RTCConfiguration { ice_servers, ..Default::default() }).await.map_err(|e| e.to_string())?);
        let peer = Arc::new(Peer { pc: pc.clone(), dcs: Mutex::new(HashMap::new()) });

        {
            let (e, id) = (emit.clone(), id.to_string());
            pc.on_ice_candidate(Box::new(move |c: Option<RTCIceCandidate>| {
                if let Some(c) = c {
                    if let Ok(init) = c.to_json() {
                        e(event_name(&id), json!({ "kind": "ice", "candidate": init }));
                    }
                }
                Box::pin(async {})
            }));
        }
        {
            let (e, id) = (emit.clone(), id.to_string());
            pc.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
                e(event_name(&id), json!({ "kind": "state", "state": s.to_string() }));
                Box::pin(async {})
            }));
        }
        {
            let (e, id, peer2) = (emit, id.to_string(), peer.clone());
            pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
                let (e, id, peer2) = (e.clone(), id.clone(), peer2.clone());
                Box::pin(async move {
                    let label = dc.label().to_string();
                    peer2.dcs.lock().await.insert(label.clone(), dc.clone());
                    wire_channel(id.clone(), dc, e.clone());
                    e(event_name(&id), json!({ "kind": "datachannel", "label": label }));
                })
            }));
        }
        self.peers.lock().await.insert(id.to_string(), peer);
        Ok(())
    }

    pub async fn create_data_channel(&self, id: &str, label: &str, emit: Emit) -> Result<(), String> {
        let peer = self.peer(id).await?;
        let dc = peer
            .pc
            .create_data_channel(label, Some(RTCDataChannelInit { ordered: Some(true), ..Default::default() }))
            .await
            .map_err(|e| e.to_string())?;
        peer.dcs.lock().await.insert(label.to_string(), dc.clone());
        wire_channel(id.to_string(), dc, emit);
        Ok(())
    }

    pub async fn create_offer(&self, id: &str) -> Result<String, String> {
        Ok(self.peer(id).await?.pc.create_offer(None).await.map_err(|e| e.to_string())?.sdp)
    }

    pub async fn create_answer(&self, id: &str) -> Result<String, String> {
        Ok(self.peer(id).await?.pc.create_answer(None).await.map_err(|e| e.to_string())?.sdp)
    }

    fn desc(kind: &str, sdp: String) -> Result<RTCSessionDescription, String> {
        match kind {
            "offer" => RTCSessionDescription::offer(sdp),
            "answer" => RTCSessionDescription::answer(sdp),
            _ => return Err("unsupported description type".into()),
        }
        .map_err(|e| e.to_string())
    }

    pub async fn set_local(&self, id: &str, kind: &str, sdp: String) -> Result<(), String> {
        self.peer(id).await?.pc.set_local_description(Self::desc(kind, sdp)?).await.map_err(|e| e.to_string())
    }

    pub async fn set_remote(&self, id: &str, kind: &str, sdp: String) -> Result<(), String> {
        self.peer(id).await?.pc.set_remote_description(Self::desc(kind, sdp)?).await.map_err(|e| e.to_string())
    }

    pub async fn local_sdp(&self, id: &str) -> Result<Option<String>, String> {
        Ok(self.peer(id).await?.pc.local_description().await.map(|d| d.sdp))
    }

    pub async fn add_ice(&self, id: &str, candidate: Value) -> Result<(), String> {
        let init: RTCIceCandidateInit = serde_json::from_value(candidate).map_err(|e| e.to_string())?;
        self.peer(id).await?.pc.add_ice_candidate(init).await.map_err(|e| e.to_string())
    }

    pub async fn send(&self, id: &str, label: &str, b64: &str) -> Result<usize, String> {
        let peer = self.peer(id).await?;
        let dc = peer.dcs.lock().await.get(label).cloned().ok_or("unknown data channel")?;
        let bytes = B64.decode(b64).map_err(|e| e.to_string())?;
        dc.send(&Bytes::from(bytes)).await.map_err(|e| e.to_string())?;
        Ok(dc.buffered_amount().await)
    }

    pub async fn close(&self, id: &str) {
        if let Some(p) = self.peers.lock().await.remove(id) {
            let _ = p.pc.close().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::mpsc;

    /// Collects events per peer id into a channel the test can read.
    fn emitter() -> (Emit, mpsc::UnboundedReceiver<(String, Value)>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Arc::new(move |name, v| {
            let _ = tx.send((name, v));
        }), rx)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_bridged_peers_connect_and_exchange_binary_messages() {
        let st = RtcState::default();
        let (ea, mut ra) = emitter();
        let (eb, mut rb) = emitter();
        st.create("a", vec![], ea.clone()).await.unwrap();
        st.create("b", vec![], eb.clone()).await.unwrap();

        // A offers (creating the channels first, like the TypeScript RtcLink initiator does).
        st.create_data_channel("a", "sync", ea.clone()).await.unwrap();
        st.create_data_channel("a", "bulk", ea.clone()).await.unwrap();
        let offer = st.create_offer("a").await.unwrap();
        st.set_local("a", "offer", offer.clone()).await.unwrap();
        st.set_remote("b", "offer", offer).await.unwrap();
        let answer = st.create_answer("b").await.unwrap();
        st.set_local("b", "answer", answer.clone()).await.unwrap();
        st.set_remote("a", "answer", answer).await.unwrap();

        // Trickle ICE: forward candidates both ways until both channels are open.
        let st = Arc::new(st);
        let relay = |from: &'static str, to: &'static str, mut rx: mpsc::UnboundedReceiver<(String, Value)>, st: Arc<RtcState>| {
            tokio::spawn(async move {
                let mut opened = 0;
                let mut seen_dc = 0;
                while let Some((_, v)) = rx.recv().await {
                    match v["kind"].as_str() {
                        Some("ice") => {
                            let _ = st.add_ice(to, v["candidate"].clone()).await;
                        }
                        Some("open") => opened += 1,
                        Some("datachannel") => seen_dc += 1,
                        Some("message") => return (from, opened, seen_dc, Some(v)),
                        _ => {}
                    }
                }
                (from, opened, seen_dc, None)
            })
        };
        let ha = relay("a", "b", ra_take(&mut ra), st.clone());
        let hb = relay("b", "a", rb_take(&mut rb), st.clone());

        // Wait for channels, then send from A to B on the bulk channel.
        let mut sent = false;
        for _ in 0..150 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if st.send("a", "bulk", &B64.encode([1u8, 2, 3, 4, 5])).await.is_ok() {
                sent = true;
                break;
            }
        }
        assert!(sent, "channel never opened");
        let (who, _, _, msg) = tokio::time::timeout(Duration::from_secs(15), hb).await.expect("b timed out").unwrap();
        assert_eq!(who, "b");
        let msg = msg.expect("b received nothing");
        assert_eq!(msg["label"], "bulk");
        assert_eq!(B64.decode(msg["b64"].as_str().unwrap()).unwrap(), vec![1, 2, 3, 4, 5]);

        // And back the other way on the sync channel.
        st.send("b", "sync", &B64.encode(b"pong")).await.unwrap();
        let (_, _, _, back) = tokio::time::timeout(Duration::from_secs(15), ha).await.expect("a timed out").unwrap();
        assert_eq!(B64.decode(back.unwrap()["b64"].as_str().unwrap()).unwrap(), b"pong");

        st.close("a").await;
        st.close("b").await;
    }

    fn ra_take(rx: &mut mpsc::UnboundedReceiver<(String, Value)>) -> mpsc::UnboundedReceiver<(String, Value)> {
        let (_, empty) = mpsc::unbounded_channel();
        std::mem::replace(rx, empty)
    }
    fn rb_take(rx: &mut mpsc::UnboundedReceiver<(String, Value)>) -> mpsc::UnboundedReceiver<(String, Value)> {
        ra_take(rx)
    }
}
