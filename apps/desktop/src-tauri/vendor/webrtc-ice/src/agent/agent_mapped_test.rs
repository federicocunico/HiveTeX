//! Regression tests for mapped endpoints of a UDP mux socket (HiveTeX patch, see PATCHES.md).
//!
//! A sits behind a 1:1 NAT that forwards its public address to its LAN address with the same port, the shape of a
//! verified router port mapping. B sits behind a symmetric NAT. Neither gathers STUN or TURN, so the only working path
//! is B checking A's mapped server-reflexive candidate, which is backed by A's mux connection.

use std::net::IpAddr;
use std::result::Result;
use std::str::FromStr;

use async_trait::async_trait;
use portable_atomic::AtomicUsize;
use util::vnet::chunk::Chunk;
use util::vnet::nat;
use util::Conn;

use super::agent_vnet_test::{build_vnet, connect_with_vnet, VNet, VNET_GLOBAL_IPA, VNET_LOCAL_IPA, VNET_STUN_SERVER_IP, VNET_STUN_SERVER_PORT};
use super::*;
use crate::udp_mux::{UDPMux, UDPMuxDefault, UDPMuxParams};
use crate::udp_network::UDPNetwork;

const MUX_PORT: u16 = 40123;

/// A vnet socket owned by the mux.
struct Shared(Arc<dyn Conn + Send + Sync>);

#[async_trait]
impl Conn for Shared {
    async fn connect(&self, addr: SocketAddr) -> Result<(), util::Error> {
        self.0.connect(addr).await
    }
    async fn recv(&self, buf: &mut [u8]) -> Result<usize, util::Error> {
        self.0.recv(buf).await
    }
    async fn recv_from(&self, buf: &mut [u8]) -> Result<(usize, SocketAddr), util::Error> {
        self.0.recv_from(buf).await
    }
    async fn send(&self, buf: &[u8]) -> Result<usize, util::Error> {
        self.0.send(buf).await
    }
    async fn send_to(&self, buf: &[u8], target: SocketAddr) -> Result<usize, util::Error> {
        self.0.send_to(buf, target).await
    }
    fn local_addr(&self) -> Result<SocketAddr, util::Error> {
        self.0.local_addr()
    }
    fn remote_addr(&self) -> Option<SocketAddr> {
        self.0.remote_addr()
    }
    async fn close(&self) -> Result<(), util::Error> {
        self.0.close().await
    }
    fn as_any(&self) -> &(dyn std::any::Any + Send + Sync) {
        self
    }
}

struct MappedMux {
    inner: Arc<UDPMuxDefault>,
    mapped: Vec<(SocketAddr, SocketAddr)>,
}

#[async_trait]
impl UDPMux for MappedMux {
    async fn close(&self) -> Result<(), util::Error> {
        self.inner.close().await
    }
    async fn get_conn(self: Arc<Self>, ufrag: &str) -> Result<Arc<dyn Conn + Send + Sync>, util::Error> {
        Arc::clone(&self.inner).get_conn(ufrag).await
    }
    async fn remove_conn_by_ufrag(&self, ufrag: &str) {
        self.inner.remove_conn_by_ufrag(ufrag).await
    }
    fn mapped_endpoints(&self) -> Vec<(SocketAddr, SocketAddr)> {
        self.mapped.clone()
    }
    fn keeps_ordinary_gathering(&self) -> bool {
        true
    }
}

fn public_a() -> SocketAddr {
    SocketAddr::new(IpAddr::from_str(VNET_GLOBAL_IPA).unwrap(), MUX_PORT)
}
fn local_a() -> SocketAddr {
    SocketAddr::new(IpAddr::from_str(VNET_LOCAL_IPA).unwrap(), MUX_PORT)
}

async fn mapped_mux(v: &VNet, mapped: bool) -> Result<Arc<MappedMux>, Error> {
    let conn = v.net0.bind(local_a()).await?;
    Ok(Arc::new(MappedMux {
        inner: UDPMuxDefault::new(UDPMuxParams::new(Shared(conn))),
        mapped: if mapped { vec![(public_a(), local_a())] } else { vec![] },
    }))
}

fn quick(cfg: AgentConfig) -> AgentConfig {
    AgentConfig {
        network_types: vec![NetworkType::Udp4],
        multicast_dns_mode: MulticastDnsMode::Disabled,
        check_interval: Duration::from_millis(100),
        disconnected_timeout: Some(Duration::from_secs(2)),
        failed_timeout: Some(Duration::from_secs(3)),
        ..cfg
    }
}

async fn symmetric_vnet() -> Result<VNet, Error> {
    build_vnet(
        nat::NatType { mode: nat::NatMode::Nat1To1, ..Default::default() },
        nat::NatType {
            mapping_behavior: nat::EndpointDependencyType::EndpointAddrPortDependent,
            filtering_behavior: nat::EndpointDependencyType::EndpointAddrPortDependent,
            ..Default::default()
        },
    )
    .await
}

/// Connects A (mux) and B; returns whether ICE connected within the deadline and the packets B sent to A's
/// public mapped endpoint as observed on the WAN.
async fn run(mapped: bool) -> Result<(bool, usize, Option<CandidateType>), Error> {
    let v = symmetric_vnet().await?;
    let to_mapped = Arc::new(AtomicUsize::new(0));
    {
        let counter = Arc::clone(&to_mapped);
        let wan = v.wan.lock().await;
        wan.add_chunk_filter(Box::new(move |c: &(dyn Chunk + Send + Sync)| {
            if c.network() == "udp" && c.destination_addr() == public_a() {
                counter.fetch_add(1, Ordering::SeqCst);
            }
            true
        }))
        .await;
    }
    let mux = mapped_mux(&v, mapped).await?;
    let a = Arc::new(
        Agent::new(quick(AgentConfig {
            udp_network: UDPNetwork::Muxed(mux),
            net: Some(Arc::clone(&v.net0)),
            ..Default::default()
        }))
        .await?,
    );
    let b = Arc::new(Agent::new(quick(AgentConfig { net: Some(Arc::clone(&v.net1)), ..Default::default() })).await?);
    let connected = tokio::time::timeout(Duration::from_secs(8), connect_with_vnet(&a, &b)).await;
    let ok = matches!(connected, Ok(Ok(_)));
    let selected = b.get_selected_candidate_pair().map(|p| p.remote.candidate_type());
    let _ = a.close().await;
    let _ = b.close().await;
    v.close().await?;
    Ok((ok, to_mapped.load(Ordering::SeqCst), selected))
}

#[tokio::test]
async fn mapped_endpoint_is_gathered_on_the_mux_socket_next_to_host_and_stun() -> Result<(), Error> {
    let v = symmetric_vnet().await?;
    let mux = mapped_mux(&v, true).await?;
    let stun = Url::parse_url(&format!("stun:{VNET_STUN_SERVER_IP}:{VNET_STUN_SERVER_PORT}"))?;
    let a = Arc::new(
        Agent::new(quick(AgentConfig {
            udp_network: UDPNetwork::Muxed(mux),
            urls: vec![stun],
            net: Some(Arc::clone(&v.net0)),
            ..Default::default()
        }))
        .await?,
    );
    let (done_tx, mut done_rx) = mpsc::channel::<()>(1);
    let done_tx = Arc::new(Mutex::new(Some(done_tx)));
    a.on_candidate(Box::new(move |c: Option<Arc<dyn Candidate + Send + Sync>>| {
        let done_tx = Arc::clone(&done_tx);
        Box::pin(async move {
            if c.is_none() {
                done_tx.lock().await.take();
            }
        })
    }));
    a.gather_candidates()?;
    let _ = done_rx.recv().await;
    let candidates = a.get_local_candidates().await?;
    let summary: Vec<(CandidateType, String, u16, u16)> = candidates
        .iter()
        .map(|c| (c.candidate_type(), c.address(), c.port(), c.related_address().map(|r| r.port).unwrap_or(0)))
        .collect();

    // The ordinary host candidate on the mux socket is kept.
    assert!(summary.iter().any(|(t, ip, port, _)| *t == CandidateType::Host
        && ip == VNET_LOCAL_IPA
        && *port == MUX_PORT), "{summary:?}");
    // The mapped endpoint: server reflexive, exact public address and port, related to the real local endpoint.
    assert!(summary.iter().any(|(t, ip, port, rel)| *t == CandidateType::ServerReflexive
        && ip == VNET_GLOBAL_IPA
        && *port == MUX_PORT
        && *rel == MUX_PORT), "{summary:?}");
    // Ordinary STUN still runs, on its own ephemeral socket (a different port).
    assert!(summary.iter().any(|(t, ip, port, _)| *t == CandidateType::ServerReflexive
        && ip == VNET_GLOBAL_IPA
        && *port != MUX_PORT), "{summary:?}");
    let _ = a.close().await;
    v.close().await?;
    Ok(())
}

#[tokio::test]
async fn mapped_candidate_carries_traffic_when_nothing_else_can() -> Result<(), Error> {
    // Negative control: same topology without the mapping, no STUN/TURN: no path.
    let (ok, to_mapped, _) = run(false).await?;
    assert!(!ok, "connected without a mapping: the topology does not isolate the mapped path");
    assert_eq!(to_mapped, 0);

    let (ok, to_mapped, remote_type) = run(true).await?;
    assert!(ok, "ICE did not connect through the mapped endpoint");
    // Connectivity checks really went to the mapped public endpoint, and B selected A's mapped candidate.
    assert!(to_mapped > 0, "no packet reached the mapped endpoint");
    assert_eq!(remote_type, Some(CandidateType::ServerReflexive));
    Ok(())
}

#[tokio::test]
async fn default_mux_keeps_upstream_gathering() -> Result<(), Error> {
    let v = symmetric_vnet().await?;
    let conn = v.net0.bind(local_a()).await?;
    let mux = UDPMuxDefault::new(UDPMuxParams::new(Shared(conn)));
    let stun = Url::parse_url(&format!("stun:{VNET_STUN_SERVER_IP}:{VNET_STUN_SERVER_PORT}"))?;
    let a = Arc::new(
        Agent::new(quick(AgentConfig {
            udp_network: UDPNetwork::Muxed(mux),
            urls: vec![stun],
            net: Some(Arc::clone(&v.net0)),
            ..Default::default()
        }))
        .await?,
    );
    let (done_tx, mut done_rx) = mpsc::channel::<()>(1);
    let done_tx = Arc::new(Mutex::new(Some(done_tx)));
    a.on_candidate(Box::new(move |c: Option<Arc<dyn Candidate + Send + Sync>>| {
        let done_tx = Arc::clone(&done_tx);
        Box::pin(async move {
            if c.is_none() {
                done_tx.lock().await.take();
            }
        })
    }));
    a.gather_candidates()?;
    let _ = done_rx.recv().await;
    let types: Vec<CandidateType> = a.get_local_candidates().await?.iter().map(|c| c.candidate_type()).collect();
    assert_eq!(types, vec![CandidateType::Host]);
    let _ = a.close().await;
    v.close().await?;
    Ok(())
}

#[tokio::test]
async fn muxed_agent_still_connects_through_turn_only() -> Result<(), Error> {
    let v = symmetric_vnet().await?;
    let turn = || -> Result<Url, Error> {
        let mut u = Url::parse_url(&format!("turn:{VNET_STUN_SERVER_IP}:{VNET_STUN_SERVER_PORT}?transport=udp"))?;
        u.username = "user".to_owned();
        u.password = "pass".to_owned();
        Ok(u)
    };
    let mux = mapped_mux(&v, false).await?;
    let relay_only = |net, udp_network| AgentConfig {
        urls: vec![turn().unwrap()],
        candidate_types: vec![CandidateType::Relay],
        udp_network,
        net: Some(net),
        ..Default::default()
    };
    let a = Arc::new(Agent::new(quick(relay_only(Arc::clone(&v.net0), UDPNetwork::Muxed(mux)))).await?);
    let b = Arc::new(Agent::new(quick(relay_only(Arc::clone(&v.net1), UDPNetwork::default()))).await?);
    let connected = tokio::time::timeout(Duration::from_secs(10), connect_with_vnet(&a, &b)).await;
    assert!(matches!(connected, Ok(Ok(_))), "TURN-only connection failed with a muxed agent");
    let pair = a.get_selected_candidate_pair().expect("selected pair");
    assert_eq!(pair.local.candidate_type(), CandidateType::Relay);
    let _ = a.close().await;
    let _ = b.close().await;
    v.close().await?;
    Ok(())
}
