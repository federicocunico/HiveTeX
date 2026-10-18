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
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use webrtc::ice_transport::ice_candidate_pair::RTCIceCandidatePair;
use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::policy::ice_transport_policy::RTCIceTransportPolicy;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

/// Sends an event to the frontend: (event name, payload).
pub type Emit = Arc<dyn Fn(String, Value) + Send + Sync>;

/// ICE timeouts set on every connection (see `create_opts`).
pub const ICE_DISCONNECTED: std::time::Duration = std::time::Duration::from_secs(5);
pub const ICE_FAILED: std::time::Duration = std::time::Duration::from_secs(20);
pub const ICE_KEEPALIVE: std::time::Duration = std::time::Duration::from_secs(2);

struct Peer {
    pc: Arc<RTCPeerConnection>,
    dcs: Mutex<HashMap<String, Arc<RTCDataChannel>>>,
    /// The shared UDP listener this connection negotiated on (muxed connections only).
    _lease: Option<crate::transport::Lease>,
}

pub struct RtcState {
    peers: Mutex<HashMap<String, Arc<Peer>>>,
    /// Shared, generation-scoped UDP listeners for muxed connections (the worker's native transport).
    pub transport: Arc<crate::transport::Transport>,
    /// The `interface_policy` of connections created without one.
    interfaces: Option<&'static str>,
}

impl Default for RtcState {
    /// Every interface in the app; loopback only in this crate's tests (no firewall prompt, docs/testing.md).
    fn default() -> Self {
        if cfg!(test) { Self::loopback() } else { Self::all_interfaces() }
    }
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

/// Which local addresses gather host candidates (and so which pairs ICE checks):
/// - `None` / `"all"`: every interface (the stack's default);
/// - `"default"`: only the address of the default route, as Chromium does by default;
/// - `"physical"`: every interface except virtual adapters (Hyper-V, WSL, Docker, VPN tunnels, Wi-Fi Direct ...);
/// - `"loopback"`: loopback addresses only and no mDNS socket (tests on one machine: nothing listens on a real
///   interface, so no firewall prompt).
/// Fewer interfaces mean fewer pairs to check; whether that helps is measured in `make rtc-lab` (docs/decisions).
fn interface_policy(setting: &mut SettingEngine, mode: Option<&str>) {
    match mode {
        Some("loopback") => {
            setting.set_include_loopback_candidate(true);
            setting.set_ip_filter(Box::new(|a: std::net::IpAddr| a.is_loopback()));
            setting.set_ice_multicast_dns_mode(webrtc::ice::mdns::MulticastDnsMode::Disabled);
        }
        Some("default") => {
            if let Some(ip) = default_route_ip() {
                setting.set_ip_filter(Box::new(move |a: std::net::IpAddr| a == ip));
            }
        }
        Some("physical") => setting.set_interface_filter(Box::new(|name: &str| !is_virtual_interface(name))),
        _ => {}
    }
}

/// The local IPv4 address the system uses to reach the internet (no packet is sent: a connected UDP socket only).
fn default_route_ip() -> Option<std::net::IpAddr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    s.local_addr().ok().map(|a| a.ip()).filter(|ip| !ip.is_unspecified())
}

/// Names of virtual adapters on Windows, macOS and Linux.
pub fn is_virtual_interface(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    const PARTS: [&str; 14] = ["vethernet", "hyper-v", "wsl", "virtualbox", "vmware", "vmnet", "loopback", "nordlynx", "openvpn", "wireguard", "tailscale", "zerotier", "tap-", "local area connection*"];
    const PREFIXES: [&str; 12] = ["docker", "br-", "veth", "virbr", "tun", "tap", "wg", "utun", "awdl", "llw", "bridge", "zt"];
    PARTS.iter().any(|p| n.contains(p)) || PREFIXES.iter().any(|p| n.starts_with(p)) || n == "lo"
}

/// (protocol, local type, remote type) of a selected pair, from its text form
/// "(local) udp host 192.0.2.1:5000 <-> (remote) udp srflx 198.51.100.2:6000 ..." (the crate exposes no accessors);
/// addresses are not kept.
fn pair_types(text: &str) -> (String, String, String) {
    let side = |marker: &str| -> (String, String) {
        let mut words = text.split(marker).nth(1).unwrap_or("").split_whitespace();
        (words.next().unwrap_or("unknown").to_string(), words.next().unwrap_or("unknown").to_string())
    };
    let (protocol, local) = side("(local)");
    let (_, remote) = side("(remote)");
    (protocol, local, remote)
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
    pub fn all_interfaces() -> Self {
        let transport = crate::transport::Transport::with_bind_ip(std::net::Ipv4Addr::UNSPECIFIED.into());
        Self { peers: Mutex::default(), transport: Arc::new(transport), interfaces: None }
    }

    /// Listener and host candidates on loopback only (`interface_policy` "loopback").
    pub fn loopback() -> Self {
        let transport = crate::transport::Transport::with_bind_ip(std::net::Ipv4Addr::LOCALHOST.into());
        Self { peers: Mutex::default(), transport: Arc::new(transport), interfaces: Some("loopback") }
    }

    async fn peer(&self, id: &str) -> Result<Arc<Peer>, String> {
        self.peers.lock().await.get(id).cloned().ok_or_else(|| "unknown peer connection".to_string())
    }

    pub async fn create(&self, id: &str, ice: Vec<IceServer>, emit: Emit) -> Result<(), String> {
        self.create_with(id, ice, emit, false).await
    }

    /// Creates a connection; `muxed` negotiates on the shared listener of the current network generation, keeping
    /// ordinary host/STUN/TURN gathering and adding a verified mapped endpoint when one is published.
    pub async fn create_with(&self, id: &str, ice: Vec<IceServer>, emit: Emit, muxed: bool) -> Result<(), String> {
        self.create_opts(id, ice, emit, muxed, None).await
    }

    /// `create_with`, plus the transport policy: `Some("relay")` gathers and checks relay candidates only (the
    /// connection test's relay-only variant), anything else all candidates.
    pub async fn create_opts(&self, id: &str, ice: Vec<IceServer>, emit: Emit, muxed: bool, policy: Option<&str>) -> Result<(), String> {
        self.create_full(id, ice, emit, muxed, policy, None).await
    }

    /// `create_opts`, plus which local interfaces gather host candidates (`interfaces`, see `interface_policy`).
    pub async fn create_full(&self, id: &str, ice: Vec<IceServer>, emit: Emit, muxed: bool, policy: Option<&str>, interfaces: Option<&str>) -> Result<(), String> {
        let lease = if muxed { Some(self.transport.acquire().await?) } else { None };
        let mut setting = SettingEngine::default();
        if let Some(lease) = &lease {
            setting.set_udp_network(lease.udp_network());
        }
        interface_policy(&mut setting, interfaces.or(self.interfaces));
        // Explicit rather than the stack's defaults: a pair is "disconnected" after 5 s without answers, the agent fails
        // after 20 s (the client's attempt deadline is longer, so relay pairs get the whole window), keepalive 2 s.
        setting.set_ice_timeouts(Some(ICE_DISCONNECTED), Some(ICE_FAILED), Some(ICE_KEEPALIVE));
        let mut m = MediaEngine::default();
        m.register_default_codecs().map_err(|e| e.to_string())?;
        let registry = register_default_interceptors(Registry::new(), &mut m).map_err(|e| e.to_string())?;
        let api = APIBuilder::new().with_media_engine(m).with_interceptor_registry(registry).with_setting_engine(setting).build();
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
        let ice_transport_policy = if policy == Some("relay") { RTCIceTransportPolicy::Relay } else { RTCIceTransportPolicy::All };
        let pc = Arc::new(api.new_peer_connection(RTCConfiguration { ice_servers, ice_transport_policy, ..Default::default() }).await.map_err(|e| e.to_string())?);
        let peer = Arc::new(Peer { pc: pc.clone(), dcs: Mutex::new(HashMap::new()), _lease: lease });

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
            // The ICE agent's own state (checking, connected, disconnected, failed ...): the connection state above
            // hides when checks start and when consent stops.
            let (e, id) = (emit.clone(), id.to_string());
            pc.on_ice_connection_state_change(Box::new(move |s: RTCIceConnectionState| {
                e(event_name(&id), json!({ "kind": "ice-state", "state": s.to_string() }));
                Box::pin(async {})
            }));
        }
        {
            // Which candidate pair carries the connection, by type only (host, srflx, prflx, relay): a later change is
            // a switch of path.
            let (e, id) = (emit.clone(), id.to_string());
            pc.sctp().transport().ice_transport().on_selected_candidate_pair_change(Box::new(move |p: RTCIceCandidatePair| {
                let (protocol, local, remote) = pair_types(&p.to_string());
                e(event_name(&id), json!({ "kind": "pair", "local": local, "remote": remote, "protocol": protocol }));
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

    /// The selected candidate pair in the shape of standard WebRTC statistics (`transport`, `candidate-pair`,
    /// `local-candidate`, `remote-candidate`). Addresses stay on this device; peers never receive them from here.
    pub async fn stats(&self, id: &str) -> Result<Value, String> {
        use webrtc::stats::StatsReportType;
        let report = self.peer(id).await?.pc.get_stats().await;
        let mut pair = None;
        for r in report.reports.values() {
            if let StatsReportType::CandidatePair(p) = r {
                let succeeded = format!("{:?}", p.state).eq_ignore_ascii_case("succeeded");
                if p.nominated && succeeded {
                    pair = Some(p);
                }
            }
        }
        let Some(pair) = pair else { return Ok(json!([])) };
        let candidate = |cid: &str, kind: &str| {
            report.reports.values().find_map(|r| match r {
                StatsReportType::LocalCandidate(c) | StatsReportType::RemoteCandidate(c) if c.id == cid => Some(json!({
                    "id": c.id, "type": kind, "candidateType": c.candidate_type.to_string(),
                    "address": c.ip, "port": c.port,
                    "relayProtocol": if c.candidate_type.to_string() == "relay" { Some(c.relay_protocol.clone()) } else { None },
                })),
                _ => None,
            })
        };
        let mut out = vec![
            json!({ "id": "T", "type": "transport", "selectedCandidatePairId": pair.id }),
            json!({ "id": pair.id, "type": "candidate-pair", "selected": true, "nominated": true, "state": "succeeded",
                "localCandidateId": pair.local_candidate_id, "remoteCandidateId": pair.remote_candidate_id,
                "bytesSent": pair.bytes_sent, "bytesReceived": pair.bytes_received }),
        ];
        out.extend(candidate(&pair.local_candidate_id, "local-candidate"));
        out.extend(candidate(&pair.remote_candidate_id, "remote-candidate"));
        Ok(Value::Array(out))
    }

    pub async fn close(&self, id: &str) {
        if let Some(p) = self.peers.lock().await.remove(id) {
            let _ = p.pc.close().await;
        }
    }

    /// Closes every connection whose id matches (a replaced worker generation); returns how many.
    pub async fn close_where(&self, f: impl Fn(&str) -> bool) -> usize {
        let gone: Vec<Arc<Peer>> = {
            let mut peers = self.peers.lock().await;
            let ids: Vec<String> = peers.keys().filter(|k| f(k)).cloned().collect();
            ids.iter().filter_map(|k| peers.remove(k)).collect()
        };
        for p in &gone {
            let _ = p.pc.close().await;
        }
        gone.len()
    }

    pub async fn ids(&self) -> Vec<String> {
        let mut v: Vec<String> = self.peers.lock().await.keys().cloned().collect();
        v.sort();
        v
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
        let st = RtcState::loopback();
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

    /// Connects `a` (on `sa`) to `b` (on `sb`) with trickle ICE, both muxed. Returns the message receivers of each side
    /// (payload bytes) once A sent its first message.
    async fn pair(sa: Arc<RtcState>, a: &str, sb: Arc<RtcState>, b: &str, muxed: bool) -> (mpsc::UnboundedReceiver<Vec<u8>>, mpsc::UnboundedReceiver<Vec<u8>>) {
        let (ea, ra) = emitter();
        let (eb, rb) = emitter();
        sa.create_with(a, vec![], ea.clone(), muxed).await.unwrap();
        sb.create_with(b, vec![], eb.clone(), muxed).await.unwrap();
        sa.create_data_channel(a, "sync", ea.clone()).await.unwrap();
        let offer = sa.create_offer(a).await.unwrap();
        sa.set_local(a, "offer", offer.clone()).await.unwrap();
        sb.set_remote(b, "offer", offer).await.unwrap();
        let answer = sb.create_answer(b).await.unwrap();
        sb.set_local(b, "answer", answer.clone()).await.unwrap();
        sa.set_remote(a, "answer", answer).await.unwrap();
        fn pump(mut rx: mpsc::UnboundedReceiver<(String, Value)>, to: String, st: Arc<RtcState>) -> mpsc::UnboundedReceiver<Vec<u8>> {
            let (tx, out) = mpsc::unbounded_channel();
            tokio::spawn(async move {
                while let Some((_, v)) = rx.recv().await {
                    match v["kind"].as_str() {
                        Some("ice") => { let _ = st.add_ice(&to, v["candidate"].clone()).await; }
                        Some("message") => { let _ = tx.send(B64.decode(v["b64"].as_str().unwrap()).unwrap()); }
                        _ => {}
                    }
                }
            });
            out
        }
        let ma = pump(ra, b.to_string(), sb.clone());
        let mb = pump(rb, a.to_string(), sa.clone());
        let mut opened = false;
        for _ in 0..150 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if sa.send(a, "sync", &B64.encode(b"hello")).await.is_ok() { opened = true; break; }
        }
        assert!(opened, "muxed channel never opened");
        (ma, mb)
    }

    async fn recv(rx: &mut mpsc::UnboundedReceiver<Vec<u8>>) -> Vec<u8> {
        tokio::time::timeout(Duration::from_secs(15), rx.recv()).await.expect("timed out").expect("closed")
    }

    /// CPU time of this process (seconds).
    #[cfg(windows)]
    fn cpu_seconds() -> f64 {
        use windows_sys::Win32::Foundation::FILETIME;
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
        let z = || FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut c, mut e, mut k, mut u) = (z(), z(), z(), z());
        unsafe { GetProcessTimes(GetCurrentProcess(), &mut c, &mut e, &mut k, &mut u) };
        let t = |f: FILETIME| ((f.dwHighDateTime as u64) << 32 | f.dwLowDateTime as u64) as f64 / 1e7;
        t(k) + t(u)
    }
    #[cfg(not(windows))]
    fn cpu_seconds() -> f64 {
        0.0
    }

    /// Measures the CPU an established but idle connection costs (manual: `cargo test --lib idle_connection_cpu -- --ignored --nocapture`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore]
    async fn idle_connection_cpu() {
        for muxed in [false, true] {
            let (sa, sb) = (Arc::new(RtcState::loopback()), Arc::new(RtcState::loopback()));
            let (_ra, _rb) = pair(sa.clone(), "a", sb.clone(), "b", muxed).await;
            tokio::time::sleep(Duration::from_secs(3)).await;
            let start = cpu_seconds();
            tokio::time::sleep(Duration::from_secs(10)).await;
            let used = cpu_seconds() - start;
            println!("idle pair (muxed={muxed}): {:.1}% of one core over 10 s", used * 10.0);
            sa.close("a").await;
            sb.close("b").await;
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn muxed_connections_share_one_listener_and_survive_each_others_close() {
        let (sa, sb) = (Arc::new(RtcState::loopback()), Arc::new(RtcState::loopback()));
        let (_a1, mut b1) = pair(sa.clone(), "a1", sb.clone(), "b1", true).await;
        let (_a2, mut b2) = pair(sa.clone(), "a2", sb.clone(), "b2", true).await;
        assert_eq!(recv(&mut b1).await, b"hello");
        assert_eq!(recv(&mut b2).await, b"hello");
        // Both of A's connections negotiated on the same bound socket.
        let port = sa.transport.current_local().unwrap().1.port();
        for id in ["a1", "a2"] {
            let sdp = sa.local_sdp(id).await.unwrap().unwrap();
            assert!(sdp.contains(&format!(" {port} typ host")), "{id} not on the shared listener: {sdp}");
        }
        // The selected pair is visible as standard statistics.
        let stats = sa.stats("a2").await.unwrap();
        let types: Vec<&str> = stats.as_array().unwrap().iter().filter_map(|s| s["type"].as_str()).collect();
        assert!(types.contains(&"candidate-pair") && types.contains(&"local-candidate"), "{stats}");
        // Closing one connection leaves the shared listener and the other connection working.
        sa.close("a1").await;
        sb.close("b1").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        sa.send("a2", "sync", &B64.encode(b"still here")).await.unwrap();
        loop {
            if recv(&mut b2).await == b"still here" { break; }
        }
        assert_eq!(sa.transport.current_local().unwrap().1.port(), port);
        sa.close("a2").await;
        sb.close("b2").await;
    }

    async fn gathered_sdp(st: &RtcState, id: &str) -> String {
        st.create_with(id, vec![], Arc::new(|_, _| {}), true).await.unwrap();
        st.create_data_channel(id, "sync", Arc::new(|_, _| {})).await.unwrap();
        let offer = st.create_offer(id).await.unwrap();
        st.set_local(id, "offer", offer).await.unwrap();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        st.local_sdp(id).await.unwrap().unwrap()
    }

    /// Lab test: gathers on the machine's real interfaces, so it binds sockets a firewall asks about (`make rtc-lab`, or
    /// `cargo test --lib muxed_gathering_keeps_ipv6 -- --ignored`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "lab: real interfaces (make rtc-lab)"]
    async fn muxed_gathering_keeps_ipv6_host_candidates_where_the_machine_has_them() {
        let v6_hosts = |sdp: &str| -> usize {
            sdp.lines().filter(|l| l.starts_with("a=candidate") && l.contains(" typ host") && l.split(' ').nth(4).is_some_and(|ip| ip.contains(':'))).count()
        };
        let plain = RtcState::all_interfaces();
        plain.create("p", vec![], Arc::new(|_, _| {})).await.unwrap();
        plain.create_data_channel("p", "sync", Arc::new(|_, _| {})).await.unwrap();
        let offer = plain.create_offer("p").await.unwrap();
        plain.set_local("p", "offer", offer).await.unwrap();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let ordinary = plain.local_sdp("p").await.unwrap().unwrap();
        let muxed = gathered_sdp(&RtcState::all_interfaces(), "m").await;
        // IPv6 host candidates come from ephemeral sockets next to the IPv4 mux: same set as ordinary gathering.
        assert_eq!(v6_hosts(&muxed), v6_hosts(&ordinary), "ordinary:\n{ordinary}\nmuxed:\n{muxed}");
        println!("ipv6 host candidates: {}", v6_hosts(&muxed));
        plain.close("p").await;
    }

    #[test]
    fn virtual_adapters_are_recognised_on_every_platform() {
        for name in ["vEthernet (Default Switch)", "vEthernet (WSL (Hyper-V firewall))", "NordLynx", "OpenVPN Data Channel Offload for NordVPN", "Local Area Connection* 10", "docker0", "br-1a2b", "veth12ab", "virbr0", "tun0", "wg0", "utun3", "awdl0", "tailscale0", "lo"] {
            assert!(is_virtual_interface(name), "{name}");
        }
        for name in ["Ethernet", "Wi-Fi", "eth0", "enp3s0", "wlan0", "en0", "en1"] {
            assert!(!is_virtual_interface(name), "{name}");
        }
    }

    #[test]
    fn selected_pair_types_without_addresses() {
        let (p, l, r) = pair_types("(local) udp host 192.0.2.1:5000 <-> (remote) udp srflx 198.51.100.2:6000 related 10.0.0.1:1");
        assert_eq!((p.as_str(), l.as_str(), r.as_str()), ("udp", "host", "srflx"));
        assert_eq!(pair_types("garbled").1, "unknown");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn relay_policy_gathers_no_host_or_reflexive_candidates() {
        let st = RtcState::loopback();
        // No TURN server: with the relay policy nothing at all may be gathered.
        st.create_opts("r", vec![], Arc::new(|_, _| {}), false, Some("relay")).await.unwrap();
        st.create_data_channel("r", "sync", Arc::new(|_, _| {})).await.unwrap();
        let offer = st.create_offer("r").await.unwrap();
        st.set_local("r", "offer", offer).await.unwrap();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let sdp = st.local_sdp("r").await.unwrap().unwrap();
        assert!(!sdp.contains("a=candidate"), "{sdp}");
        st.close("r").await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn ice_state_and_selected_pair_are_reported() {
        let (sa, sb) = (Arc::new(RtcState::loopback()), Arc::new(RtcState::loopback()));
        let (ea, mut ra) = emitter();
        let (eb, rb) = emitter();
        sa.create("a", vec![], ea.clone()).await.unwrap();
        sb.create("b", vec![], eb.clone()).await.unwrap();
        sa.create_data_channel("a", "sync", ea.clone()).await.unwrap();
        let offer = sa.create_offer("a").await.unwrap();
        sa.set_local("a", "offer", offer.clone()).await.unwrap();
        sb.set_remote("b", "offer", offer).await.unwrap();
        let answer = sb.create_answer("b").await.unwrap();
        sb.set_local("b", "answer", answer.clone()).await.unwrap();
        sa.set_remote("a", "answer", answer).await.unwrap();
        // b's candidates to a; a's candidates go to b as they come (collected below).
        let sa2 = sa.clone();
        tokio::spawn(async move {
            let mut rb = rb;
            while let Some((_, v)) = rb.recv().await {
                if v["kind"] == "ice" { let _ = sa2.add_ice("a", v["candidate"].clone()).await; }
            }
        });
        let (mut ice_states, mut pair) = (vec![], None);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while pair.is_none() || !ice_states.iter().any(|s: &String| s == "connected") {
            let Ok(Some((_, v))) = tokio::time::timeout_at(deadline, ra.recv()).await else { break };
            match v["kind"].as_str() {
                Some("ice") => { let _ = sb.add_ice("b", v["candidate"].clone()).await; }
                Some("ice-state") => ice_states.push(v["state"].as_str().unwrap_or_default().to_string()),
                Some("pair") => pair = Some(v),
                _ => {}
            }
        }
        assert!(ice_states.iter().any(|s| s == "checking") && ice_states.iter().any(|s| s == "connected"), "{ice_states:?}");
        let pair = pair.expect("no selected pair event");
        assert_eq!(pair["local"], "host", "{pair}");
        assert!(!pair.to_string().contains('.'), "an address leaked: {pair}");
        sa.close("a").await;
        sb.close("b").await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn negotiation_does_not_wait_for_a_slow_router_and_publishes_nothing_unverified() {
        let st = RtcState::loopback();
        let discover: crate::portmap::Discover = Arc::new(|| Box::pin(async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Err(crate::igd::IgdError::NotFound)
        }));
        let mapper = crate::portmap::Mapper::new(st.transport.clone(), discover, "tok".into());
        mapper.enable();
        let started = std::time::Instant::now();
        let sdp = gathered_sdp(&st, "slow").await;
        assert!(started.elapsed() < Duration::from_secs(3), "ICE waited for UPnP");
        assert!(sdp.contains(" typ host") && !sdp.contains("typ srflx raddr"), "{sdp}");
        // Tests gather on loopback only: nothing listens on a real interface.
        let hosts: Vec<&str> = sdp.lines().filter(|l| l.starts_with("a=candidate")).filter_map(|l| l.split(' ').nth(4)).collect();
        assert!(!hosts.is_empty() && hosts.iter().all(|ip| ip.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())), "{sdp}");
        assert_eq!(mapper.status(), crate::portmap::MapStatus::Discovering);
        mapper.disable().await;
        st.close("slow").await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn verified_mapping_is_offered_by_new_negotiations_only_while_published() {
        let st = RtcState::loopback();
        let lease = st.transport.acquire().await.unwrap();
        let port = lease.local_addr().port();
        let external: std::net::SocketAddr = format!("203.0.113.7:{port}").parse().unwrap();
        let internal: std::net::SocketAddr = format!("192.168.1.20:{port}").parse().unwrap();
        assert!(st.transport.set_mapping(0, Some((external, internal))));
        let with = gathered_sdp(&st, "m1").await;
        assert!(with.contains(&format!("203.0.113.7 {port} typ srflx raddr 192.168.1.20 rport {port}")), "{with}");
        assert!(with.contains(&format!(" {port} typ host")), "ordinary host candidates kept: {with}");
        // Withdrawn (expired or changed): excluded from the next negotiation at once.
        assert!(st.transport.set_mapping(0, None));
        let without = gathered_sdp(&st, "m2").await;
        assert!(!without.contains("203.0.113.7"), "{without}");
        st.close("m1").await;
        st.close("m2").await;
        drop(lease);
    }

}
