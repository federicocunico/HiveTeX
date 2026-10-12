//! Process-level UDP transport for native WebRTC (D6/D7, tasks 9.2-9.4).
//!
//! Every native peer connection of the current network generation shares one UDP socket through the ICE mux
//! (`webrtc-ice` `UDPNetwork::Muxed`). The listener is reference counted: it is bound when the first connection needs
//! it and closed when the last connection of its generation is gone. A network change advances the generation; new
//! connections then get a new listener while existing ones keep theirs until they close.
//!
//! The mux keeps ordinary gathering (host candidates for the other address family, STUN and TURN on their own
//! sockets) and adds verified mapped endpoints of this very socket as server-reflexive candidates. That last part is
//! the pinned `webrtc-ice` patch in `vendor/webrtc-ice` (see `vendor/PATCHES.md`). Only a mapping verified for the
//! listener's own generation and port is published, and only to negotiations that start after it was set.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex, RwLock, Weak};

use async_trait::async_trait;
use webrtc::ice::udp_mux::{UDPMux, UDPMuxDefault, UDPMuxParams};
use webrtc::ice::udp_network::UDPNetwork;
use webrtc::util::{Conn, Error as UtilError};

/// The shared socket of one network generation, as seen by ICE.
pub struct SharedMux {
    inner: Arc<UDPMuxDefault>,
    local: SocketAddr,
    /// Verified (external, internal) endpoints for this socket; read by each new ICE gathering.
    mapped: RwLock<Vec<(SocketAddr, SocketAddr)>>,
}

#[async_trait]
impl UDPMux for SharedMux {
    async fn close(&self) -> Result<(), UtilError> {
        self.inner.close().await
    }
    async fn get_conn(self: Arc<Self>, ufrag: &str) -> Result<Arc<dyn Conn + Send + Sync>, UtilError> {
        Arc::clone(&self.inner).get_conn(ufrag).await
    }
    async fn remove_conn_by_ufrag(&self, ufrag: &str) {
        self.inner.remove_conn_by_ufrag(ufrag).await
    }
    fn mapped_endpoints(&self) -> Vec<(SocketAddr, SocketAddr)> {
        self.mapped.read().unwrap().clone()
    }
    fn keeps_ordinary_gathering(&self) -> bool {
        true
    }
}

/// One bound listener. Dropping the last lease closes its socket.
pub struct Listener {
    pub generation: u64,
    mux: Arc<SharedMux>,
}

impl Drop for Listener {
    fn drop(&mut self) {
        let mux = Arc::clone(&self.mux.inner);
        // Closing stops the mux's receive task (which otherwise keeps the socket alive).
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                let _ = mux.close().await;
            });
        } else {
            std::thread::spawn(move || {
                if let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() {
                    rt.block_on(async move {
                        let _ = mux.close().await;
                    });
                }
            });
        }
    }
}

/// A connection's hold on a listener; the connection keeps it for its whole life.
#[derive(Clone)]
pub struct Lease(Arc<Listener>);

impl Lease {
    pub fn generation(&self) -> u64 {
        self.0.generation
    }
    pub fn local_addr(&self) -> SocketAddr {
        self.0.mux.local
    }
    pub fn udp_network(&self) -> UDPNetwork {
        UDPNetwork::Muxed(Arc::clone(&self.0.mux) as Arc<dyn UDPMux + Send + Sync>)
    }
}

#[derive(Default)]
struct Inner {
    generation: u64,
    current: Weak<Listener>,
    /// The mapping to apply when the current generation's listener is (re)bound.
    mapping: Option<(SocketAddr, SocketAddr)>,
}

/// The process-wide transport service.
#[derive(Default)]
pub struct Transport {
    inner: Mutex<Inner>,
    bind: Mutex<()>,
}

impl Transport {
    /// A lease on the current generation's listener, binding it if no connection holds one.
    pub async fn acquire(&self) -> Result<Lease, String> {
        let _bind = self.bind.lock().unwrap_or_else(|e| e.into_inner());
        let generation = {
            let inner = self.inner.lock().unwrap();
            if let Some(listener) = inner.current.upgrade() {
                return Ok(Lease(listener));
            }
            inner.generation
        };
        let socket = std::net::UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("bind UDP listener: {e}"))?;
        socket.set_nonblocking(true).map_err(|e| e.to_string())?;
        let socket = tokio::net::UdpSocket::from_std(socket).map_err(|e| e.to_string())?;
        let local = socket.local_addr().map_err(|e| e.to_string())?;
        let mux = Arc::new(SharedMux {
            inner: UDPMuxDefault::new(UDPMuxParams::new(socket)),
            local,
            mapped: RwLock::new(Vec::new()),
        });
        let listener = Arc::new(Listener { generation, mux });
        let mut inner = self.inner.lock().unwrap();
        if inner.generation != generation {
            // The network changed while binding: this listener belongs to no current generation.
            return Err("network changed".into());
        }
        if let Some((external, internal)) = inner.mapping {
            if internal.port() == local.port() {
                *listener.mux.mapped.write().unwrap() = vec![(external, internal)];
            }
        }
        inner.current = Arc::downgrade(&listener);
        Ok(Lease(listener))
    }

    /// Binds a new listener for the current generation (a mapping conflict on the old port). Connections holding
    /// the previous listener keep it; new ones use the new socket.
    pub async fn fresh_listener(&self) -> Result<Lease, String> {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.current = Weak::new();
            inner.mapping = None;
        }
        self.acquire().await
    }

    /// Advances the network generation: later connections use a fresh listener and no mapping of the old network.
    pub fn advance(&self, generation: u64) {
        let mut inner = self.inner.lock().unwrap();
        if generation <= inner.generation {
            return;
        }
        inner.generation = generation;
        inner.mapping = None;
        if let Some(old) = inner.current.upgrade() {
            // Existing connections keep their socket, but nothing new is negotiated with its old mapping.
            old.mux.mapped.write().unwrap().clear();
        }
        inner.current = Weak::new();
    }

    pub fn generation(&self) -> u64 {
        self.inner.lock().unwrap().generation
    }

    /// The local endpoint of the current listener, if one is bound (what a router mapping must target).
    pub fn current_local(&self) -> Option<(u64, SocketAddr)> {
        let inner = self.inner.lock().unwrap();
        inner.current.upgrade().map(|l| (l.generation, l.mux.local))
    }

    /// Publishes a verified mapping for the listener of `generation`, or withdraws it (`None`). A late result for an
    /// older generation, or one that does not target the listener's port, is refused (returns false).
    pub fn set_mapping(&self, generation: u64, mapping: Option<(SocketAddr, SocketAddr)>) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if generation != inner.generation {
            return false;
        }
        let current = inner.current.upgrade();
        if let (Some((_, internal)), Some(listener)) = (mapping, current.as_ref()) {
            if internal.port() != listener.mux.local.port() {
                return false;
            }
        }
        inner.mapping = mapping;
        if let Some(listener) = current {
            *listener.mux.mapped.write().unwrap() = mapping.into_iter().collect();
        }
        true
    }

    /// The mapped endpoints new negotiations would gather now.
    pub fn published_mapping(&self) -> Vec<(SocketAddr, SocketAddr)> {
        let inner = self.inner.lock().unwrap();
        inner.current.upgrade().map(|l| l.mux.mapped_endpoints()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn listeners_are_shared_reference_counted_and_scoped_to_a_generation() {
        let t = Transport::default();
        let a = t.acquire().await.unwrap();
        let b = t.acquire().await.unwrap();
        assert_eq!(a.local_addr(), b.local_addr(), "connections of one generation share the socket");
        drop(a);
        let c = t.acquire().await.unwrap();
        assert_eq!(c.local_addr(), b.local_addr(), "closing one connection keeps the shared listener");
        t.advance(2);
        let d = t.acquire().await.unwrap();
        assert_ne!(d.local_addr(), b.local_addr(), "a new network generation gets a new listener");
        assert_eq!(d.generation(), 2);
        let old_port = b.local_addr().port();
        drop(b);
        drop(c);
        // The last lease of the old generation closed its socket: the port can be bound again.
        let mut rebound = false;
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            if std::net::UdpSocket::bind(("0.0.0.0", old_port)).is_ok() {
                rebound = true;
                break;
            }
        }
        assert!(rebound, "old listener was not closed");
    }

    #[test]
    fn lockfile_pins_the_vendored_patched_ice() {
        let lock = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.lock")).unwrap().replace("\r\n", "\n");
        let block = lock.split("[[package]]\n").find(|b| b.starts_with("name = \"webrtc-ice\"\n")).expect("webrtc-ice locked");
        assert!(block.contains("version = \"0.13.0\"\n"), "{block}");
        assert!(!block.contains("source = "), "webrtc-ice must resolve to vendor/webrtc-ice, not a registry: {block}");
        let vendored = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/vendor/webrtc-ice/src/udp_mux/mod.rs")).unwrap();
        assert!(vendored.contains("fn mapped_endpoints(&self)") && vendored.contains("fn keeps_ordinary_gathering(&self)"));
    }

    #[tokio::test]
    async fn mappings_are_accepted_only_for_the_current_listener_and_withdrawn_on_network_change() {
        let t = Transport::default();
        let lease = t.acquire().await.unwrap();
        let port = lease.local_addr().port();
        let external: SocketAddr = format!("203.0.113.7:{port}").parse().unwrap();
        let internal: SocketAddr = format!("192.168.1.20:{port}").parse().unwrap();
        let wrong_port: SocketAddr = format!("192.168.1.20:{}", port.wrapping_add(1).max(1)).parse().unwrap();
        assert!(!t.set_mapping(0, Some((external, wrong_port))), "a mapping for another socket is refused");
        assert!(!t.set_mapping(7, Some((external, internal))), "a late result of another generation is refused");
        assert!(t.set_mapping(0, Some((external, internal))));
        assert_eq!(t.published_mapping(), vec![(external, internal)]);
        assert!(t.set_mapping(0, None));
        assert!(t.published_mapping().is_empty(), "an invalid mapping is excluded from new negotiations at once");
        assert!(t.set_mapping(0, Some((external, internal))));
        t.advance(1);
        assert!(lease.0.mux.mapped_endpoints().is_empty(), "the old network's mapping is withdrawn");
        assert!(!t.set_mapping(0, Some((external, internal))));
    }
}
