//! UPnP port mapping for the shared native UDP listener (D7, tasks 10.2-10.6).
//!
//! - Same-port UDP mapping (external port = listener port) with a finite 30-minute lease. On a conflict, up to three
//!   newly bound listener ports are tried; a router that reports a different internal endpoint, or only accepts
//!   permanent leases, is not used.
//! - Ownership: the description carries a random installation token, and every renewal/removal first queries the
//!   tuple. A mapping whose internal endpoint or token differs is never modified or removed.
//! - Publication: only a mapping verified (queried back after AddPortMapping) for the current listener and network
//!   generation is handed to [`Transport::set_mapping`]; ordinary ICE never waits for it.
//! - Lifetime: renewal halfway through the granted lease with jitter, with public-address revalidation. Disable,
//!   pause, logout, last session and quit remove an owned mapping within a three-second deadline. A crash relies on
//!   lease expiry. Results that arrive after a disable are compensated (removed) and never published.

use std::net::{Ipv4Addr, SocketAddrV4};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

use crate::igd::{Gateway, IgdError, MappingEntry};
use crate::transport::{Lease, Transport};

pub const LEASE_SECS: u32 = 1800;
pub const CLEANUP_DEADLINE: Duration = Duration::from_secs(3);
const ALTERNATIVES: usize = 3;
const RETRY: [Duration; 3] = [Duration::from_secs(5), Duration::from_secs(15), Duration::from_secs(45)];

/// What the mapping layer can say. It never claims a connection: the selected route is reported separately.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum MapStatus {
    Disabled,
    Discovering,
    Mapped { external: String, lease_secs: u32 },
    Renewing { external: String },
    Unsupported { reason: String },
    Failed { reason: String },
}

/// A mapping this installation created and verified.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Owned {
    pub external: SocketAddrV4,
    pub internal: SocketAddrV4,
    pub lease_secs: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MapError {
    /// Port taken by another mapping (try another listener port).
    Conflict,
    Unsupported(String),
    Failed(String),
    /// The mapper was disabled (or the network changed) while this attempt ran.
    Cancelled,
}

pub fn description(token: &str) -> String {
    format!("HiveTeX {token}")
}

fn is_public(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    !(ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() || ip.is_broadcast()
        || (o[0] == 100 && (64..128).contains(&o[1])) // CGNAT 100.64/10
        || o[0] >= 224)
}

fn ours(entry: &Option<MappingEntry>, internal: SocketAddrV4, token: &str) -> bool {
    entry.as_ref().is_some_and(|e| e.internal == internal && e.description == description(token))
}

/// One mapping attempt for `internal` (same external port). `alive` is checked after every gateway call: when it
/// turns false, a mapping created by this attempt is removed again (compensation) and `Cancelled` is returned.
pub async fn map_same_port(gw: &dyn Gateway, internal: SocketAddrV4, token: &str, alive: &(dyn Fn() -> bool + Send + Sync)) -> Result<Owned, MapError> {
    let port = internal.port();
    let failed = |e: IgdError| MapError::Failed(e.to_string());
    let external_ip = gw.external_ip().await.map_err(failed)?;
    if !alive() {
        return Err(MapError::Cancelled);
    }
    if !is_public(external_ip) {
        return Err(MapError::Unsupported(format!("router has no public address ({external_ip}): double NAT or carrier-grade NAT")));
    }
    let existing = gw.get_mapping(port).await.map_err(failed)?;
    if existing.is_some() && !ours(&existing, internal, token) {
        return Err(MapError::Conflict);
    }
    match gw.add_mapping(port, internal, LEASE_SECS, &description(token)).await {
        Ok(()) => {}
        Err(IgdError::Conflict) => return Err(MapError::Conflict),
        Err(IgdError::PermanentOnly) => return Err(MapError::Unsupported("router only accepts permanent mappings".into())),
        Err(e) => return Err(failed(e)),
    }
    let verified = gw.get_mapping(port).await.map_err(failed)?;
    if !alive() {
        // Late result: never published; remove what we created if it is still ours.
        if ours(&verified, internal, token) {
            let _ = gw.delete_mapping(port).await;
        }
        return Err(MapError::Cancelled);
    }
    if !ours(&verified, internal, token) {
        // The router accepted but reports another tuple: ownership is ambiguous, so it is left alone.
        return Err(MapError::Failed("router did not keep the requested mapping".into()));
    }
    let lease_secs = verified.map(|e| e.lease_secs).filter(|&l| l > 0).unwrap_or(LEASE_SECS);
    Ok(Owned { external: SocketAddrV4::new(external_ip, port), internal, lease_secs })
}

/// Removes `owned` if the gateway still reports it as ours, within the cleanup deadline.
pub async fn remove_owned(gw: &dyn Gateway, owned: Owned, token: &str) -> bool {
    tokio::time::timeout(CLEANUP_DEADLINE, async {
        match gw.get_mapping(owned.external.port()).await {
            Ok(entry) if ours(&entry, owned.internal, token) => gw.delete_mapping(owned.external.port()).await.is_ok(),
            _ => false,
        }
    })
    .await
    .unwrap_or(false)
}

/// Halfway through the lease, with up to ±10% jitter.
pub fn renew_after(lease_secs: u32, jitter: f64) -> Duration {
    let half = f64::from(lease_secs.max(60)) / 2.0;
    Duration::from_secs_f64(half * (1.0 + jitter.clamp(-0.1, 0.1)))
}

/// Opens the gateway for the current network (real: SSDP + description on the default route).
pub type Discover = Arc<dyn Fn() -> futures_lite_box::BoxFuture<Result<Arc<dyn Gateway>, IgdError>> + Send + Sync>;

pub mod futures_lite_box {
    pub type BoxFuture<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send>>;
}

struct Active {
    gateway: Arc<dyn Gateway>,
    owned: Owned,
    /// Keeps the mapped listener bound while the mapping exists.
    _lease: Lease,
}

/// Runs mapping for the transport's listener while enabled.
pub struct Mapper {
    transport: Arc<Transport>,
    discover: Discover,
    token: String,
    epoch: AtomicU64,
    status: Mutex<MapStatus>,
    active: tokio::sync::Mutex<Option<Active>>,
    on_status: Mutex<Option<Arc<dyn Fn(&MapStatus) + Send + Sync>>>,
}

impl Mapper {
    pub fn new(transport: Arc<Transport>, discover: Discover, token: String) -> Arc<Self> {
        Arc::new(Self {
            transport,
            discover,
            token,
            epoch: AtomicU64::new(0),
            status: Mutex::new(MapStatus::Disabled),
            active: tokio::sync::Mutex::new(None),
            on_status: Mutex::new(None),
        })
    }

    pub fn on_status(&self, cb: Arc<dyn Fn(&MapStatus) + Send + Sync>) {
        *self.on_status.lock().unwrap() = Some(cb);
    }

    pub fn status(&self) -> MapStatus {
        self.status.lock().unwrap().clone()
    }

    fn set(&self, epoch: u64, s: MapStatus) {
        if self.epoch.load(Ordering::SeqCst) != epoch {
            return;
        }
        *self.status.lock().unwrap() = s.clone();
        if let Some(cb) = self.on_status.lock().unwrap().clone() {
            cb(&s);
        }
    }

    /// Starts (or restarts, e.g. after a network change) mapping. Returns at once; ICE never waits for it.
    pub fn enable(self: &Arc<Self>) {
        let epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        self.set(epoch, MapStatus::Discovering);
        let me = Arc::clone(self);
        tokio::spawn(async move {
            me.release(epoch).await;
            me.run(epoch).await;
        });
    }

    /// Disable, pause, logout, last session or quit: withdraw at once, remove the owned mapping within the deadline.
    pub async fn disable(&self) {
        let epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        self.release(epoch).await;
        self.set(epoch, MapStatus::Disabled);
    }

    async fn release(&self, _epoch: u64) {
        let active = self.active.lock().await.take();
        if let Some(a) = active {
            self.transport.set_mapping(a._lease.generation(), None);
            remove_owned(a.gateway.as_ref(), a.owned, &self.token).await;
        }
    }

    async fn run(self: Arc<Self>, epoch: u64) {
        let alive = {
            let me = Arc::clone(&self);
            move || me.epoch.load(Ordering::SeqCst) == epoch
        };
        self.set(epoch, MapStatus::Discovering);
        let gateway = match (self.discover)().await {
            Ok(g) => g,
            Err(IgdError::NotFound) => return self.set(epoch, MapStatus::Unsupported { reason: "no UPnP gateway found".into() }),
            Err(e) => return self.set(epoch, MapStatus::Failed { reason: e.to_string() }),
        };
        if !alive() {
            return;
        }
        let mut result = Err(MapError::Conflict);
        let mut lease = None;
        for attempt in 0..=ALTERNATIVES {
            let l = match if attempt == 0 { self.transport.acquire().await } else { self.transport.fresh_listener().await } {
                Ok(l) => l,
                Err(e) => return self.set(epoch, MapStatus::Failed { reason: e }),
            };
            let Some(internal) = self.internal_endpoint(&l) else {
                return self.set(epoch, MapStatus::Failed { reason: "no IPv4 address on the default route".into() });
            };
            result = map_same_port(gateway.as_ref(), internal, &self.token, &alive).await;
            lease = Some(l);
            if result != Err(MapError::Conflict) {
                break;
            }
        }
        let lease = lease.expect("at least one attempt");
        let owned = match result {
            Ok(o) => o,
            Err(MapError::Cancelled) => return,
            Err(MapError::Conflict) => return self.set(epoch, MapStatus::Unsupported { reason: "ports already mapped by other devices".into() }),
            Err(MapError::Unsupported(r)) => return self.set(epoch, MapStatus::Unsupported { reason: r }),
            Err(MapError::Failed(r)) => return self.set(epoch, MapStatus::Failed { reason: r }),
        };
        // Publish only for the listener and generation it was verified for.
        if !alive() || !self.transport.set_mapping(lease.generation(), Some((owned.external.into(), owned.internal.into()))) {
            remove_owned(gateway.as_ref(), owned, &self.token).await;
            return;
        }
        *self.active.lock().await = Some(Active { gateway: Arc::clone(&gateway), owned, _lease: lease.clone() });
        self.set(epoch, MapStatus::Mapped { external: owned.external.to_string(), lease_secs: owned.lease_secs });
        self.renew_loop(epoch, gateway, owned, lease).await;
    }

    fn internal_endpoint(&self, lease: &Lease) -> Option<SocketAddrV4> {
        let port = lease.local_addr().port();
        local_ipv4().map(|ip| SocketAddrV4::new(ip, port))
    }

    async fn renew_loop(&self, epoch: u64, gateway: Arc<dyn Gateway>, mut owned: Owned, lease: Lease) {
        let alive = || self.epoch.load(Ordering::SeqCst) == epoch;
        let mut failures = 0usize;
        loop {
            let jitter = (rand_unit() - 0.5) * 0.2;
            let wait = if failures == 0 { renew_after(owned.lease_secs, jitter) } else { RETRY[failures - 1] };
            tokio::time::sleep(wait).await;
            if !alive() {
                return;
            }
            self.set(epoch, MapStatus::Renewing { external: owned.external.to_string() });
            let entry = gateway.get_mapping(owned.external.port()).await;
            let outcome = match entry {
                // Another device took the port: never touched; stop publishing.
                Ok(Some(e)) if !(e.internal == owned.internal && e.description == description(&self.token)) => {
                    self.transport.set_mapping(lease.generation(), None);
                    self.active.lock().await.take();
                    return self.set(epoch, MapStatus::Failed { reason: "port taken over by another mapping".into() });
                }
                // Ours (renew in place) or gone after a gateway reset (re-create).
                Ok(_) => map_same_port(gateway.as_ref(), owned.internal, &self.token, &alive).await,
                Err(e) => Err(MapError::Failed(e.to_string())),
            };
            match outcome {
                Ok(next) => {
                    failures = 0;
                    if next.external != owned.external {
                        // Public address changed: the old one is withdrawn at once, the new one published.
                        self.transport.set_mapping(lease.generation(), Some((next.external.into(), next.internal.into())));
                    }
                    owned = next;
                    if let Some(a) = self.active.lock().await.as_mut() {
                        a.owned = owned;
                    }
                    self.set(epoch, MapStatus::Mapped { external: owned.external.to_string(), lease_secs: owned.lease_secs });
                }
                Err(MapError::Cancelled) => return,
                Err(MapError::Failed(r)) | Err(MapError::Unsupported(r)) if failures + 1 >= RETRY.len() => {
                    self.transport.set_mapping(lease.generation(), None);
                    self.active.lock().await.take();
                    return self.set(epoch, MapStatus::Failed { reason: r });
                }
                Err(MapError::Conflict) => {
                    self.transport.set_mapping(lease.generation(), None);
                    self.active.lock().await.take();
                    return self.set(epoch, MapStatus::Failed { reason: "port taken over by another mapping".into() });
                }
                Err(_) => failures += 1,
            }
        }
    }
}

fn rand_unit() -> f64 {
    let mut b = [0u8; 8];
    let _ = getrandom::fill(&mut b);
    (u64::from_le_bytes(b) >> 11) as f64 / (1u64 << 53) as f64
}

/// The IPv4 address of the default-route interface, if any.
pub fn local_ipv4() -> Option<Ipv4Addr> {
    #[cfg(test)]
    if let Some(ip) = TEST_LOCAL.with(|v| *v.borrow()) {
        return Some(ip);
    }
    netdev::get_default_interface().ok()?.ipv4.first().map(|n| n.addr())
}

/// The default-route gateway's IPv4 address, if any.
pub fn gateway_ipv4() -> Option<Ipv4Addr> {
    netdev::get_default_interface().ok()?.gateway?.ipv4.first().copied()
}

#[cfg(test)]
thread_local! {
    static TEST_LOCAL: std::cell::RefCell<Option<Ipv4Addr>> = const { std::cell::RefCell::new(None) };
}

/// A random token identifying this installation's mappings (16 hex digits).
pub fn new_token() -> String {
    let mut b = [0u8; 8];
    let _ = getrandom::fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Mapping status for the projects page (never a connection claim; the route is shown per peer).
#[tauri::command]
pub fn upnp_status(app: tauri::AppHandle) -> MapStatus {
    use tauri::Manager;
    app.state::<UpnpState>().existing().map(|m| m.status()).unwrap_or(MapStatus::Disabled)
}

/// The real gateway of the current default route: SSDP to the multicast group, replies only from the route's gateway.
pub fn real_discover() -> Discover {
    Arc::new(|| {
        Box::pin(async {
            let (Some(local), Some(gateway)) = (local_ipv4(), gateway_ipv4()) else { return Err(IgdError::NotFound) };
            let gw = crate::igd::SoapGateway::discover(local, gateway, crate::igd::SSDP_MULTICAST, Duration::from_secs(3)).await?;
            Ok(Arc::new(gw) as Arc<dyn Gateway>)
        })
    })
}

/// The installation's mapping token, created once under the app data directory.
pub fn installation_token(root: &std::path::Path) -> String {
    let path = root.join("upnp-token");
    if let Ok(t) = std::fs::read_to_string(&path) {
        let t = t.trim();
        if t.len() == 16 && t.chars().all(|c| c.is_ascii_hexdigit()) {
            return t.to_string();
        }
    }
    let t = new_token();
    let _ = std::fs::create_dir_all(root);
    let _ = std::fs::write(&path, &t);
    t
}

/// App-wide UPnP state: one mapper for the native transport, plus whether the worker currently wants mapping.
#[derive(Default)]
pub struct UpnpState {
    mapper: std::sync::OnceLock<Arc<Mapper>>,
    pub wanted: std::sync::atomic::AtomicBool,
}

impl UpnpState {
    pub fn mapper(&self, transport: &Arc<Transport>, root: &std::path::Path) -> Arc<Mapper> {
        Arc::clone(self.mapper.get_or_init(|| Mapper::new(Arc::clone(transport), real_discover(), installation_token(root))))
    }
    pub fn existing(&self) -> Option<Arc<Mapper>> {
        self.mapper.get().cloned()
    }
    /// Applies the worker's demand: start when wanted (unless already running), stop and clean up otherwise.
    pub async fn set(&self, mapper: Arc<Mapper>, wanted: bool) {
        self.wanted.store(wanted, Ordering::SeqCst);
        if wanted {
            if matches!(mapper.status(), MapStatus::Disabled | MapStatus::Failed { .. }) {
                mapper.enable();
            }
        } else {
            mapper.disable().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::igd::emulated::{Router, RouterBehaviour};
    use async_trait::async_trait;
    use std::collections::HashMap;

    const LAN: Ipv4Addr = Ipv4Addr::new(192, 168, 1, 20);

    /// In-memory gateway for timing tests.
    #[derive(Default)]
    struct Mock {
        map: Mutex<HashMap<u16, MappingEntry>>,
        external: Mutex<Option<Ipv4Addr>>,
        add_delay: Mutex<Duration>,
        unreachable: std::sync::atomic::AtomicBool,
        deletes: AtomicU64,
    }
    #[async_trait]
    impl Gateway for Mock {
        async fn external_ip(&self) -> Result<Ipv4Addr, IgdError> {
            if self.unreachable.load(Ordering::SeqCst) {
                return Err(IgdError::Io("down".into()));
            }
            Ok(self.external.lock().unwrap().unwrap_or(Ipv4Addr::new(198, 51, 100, 9)))
        }
        async fn get_mapping(&self, p: u16) -> Result<Option<MappingEntry>, IgdError> {
            if self.unreachable.load(Ordering::SeqCst) {
                return Err(IgdError::Io("down".into()));
            }
            Ok(self.map.lock().unwrap().get(&p).cloned())
        }
        async fn add_mapping(&self, p: u16, internal: SocketAddrV4, lease: u32, d: &str) -> Result<(), IgdError> {
            let delay = *self.add_delay.lock().unwrap();
            tokio::time::sleep(delay).await;
            let mut m = self.map.lock().unwrap();
            if m.get(&p).is_some_and(|e| e.internal != internal) {
                return Err(IgdError::Conflict);
            }
            m.insert(p, MappingEntry { internal, description: d.into(), lease_secs: lease, enabled: true });
            Ok(())
        }
        async fn delete_mapping(&self, p: u16) -> Result<(), IgdError> {
            self.deletes.fetch_add(1, Ordering::SeqCst);
            self.map.lock().unwrap().remove(&p).map(|_| ()).ok_or(IgdError::NoSuchEntry)
        }
    }

    fn always() -> impl Fn() -> bool + Send + Sync {
        || true
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn same_port_mapping_against_the_emulated_router_keeps_third_party_mappings() {
        let router = Router::start(RouterBehaviour::default());
        let gw = router.gateway().await.unwrap();
        let internal = SocketAddrV4::new(LAN, 41000);
        let owned = map_same_port(&gw, internal, "tok", &always()).await.unwrap();
        assert_eq!(owned.external, SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 7), 41000));
        assert_eq!(owned.lease_secs, LEASE_SECS);
        // A third-party mapping on the next port: reported as a conflict, never modified or removed.
        let theirs = MappingEntry { internal: SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 50), 41001), description: "game console".into(), lease_secs: 0, enabled: true };
        router.mappings.lock().unwrap().insert(41001, theirs.clone());
        assert_eq!(map_same_port(&gw, SocketAddrV4::new(LAN, 41001), "tok", &always()).await, Err(MapError::Conflict));
        assert!(!remove_owned(&gw, Owned { external: SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 7), 41001), internal: SocketAddrV4::new(LAN, 41001), lease_secs: 1 }, "tok").await);
        assert_eq!(router.mappings.lock().unwrap().get(&41001), Some(&theirs));
        // Ours is removed on cleanup.
        assert!(remove_owned(&gw, owned, "tok").await);
        assert!(router.mappings.lock().unwrap().get(&41000).is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn permanent_only_double_nat_and_ineffective_routers_are_not_used() {
        let router = Router::start(RouterBehaviour { permanent_only: true, ..Default::default() });
        let gw = router.gateway().await.unwrap();
        assert!(matches!(map_same_port(&gw, SocketAddrV4::new(LAN, 41010), "t", &always()).await, Err(MapError::Unsupported(_))));
        assert!(router.mappings.lock().unwrap().is_empty());

        let cgnat = Router::start(RouterBehaviour { external_ip: Some(Ipv4Addr::new(100, 72, 1, 2)), ..Default::default() });
        let gw = cgnat.gateway().await.unwrap();
        let r = map_same_port(&gw, SocketAddrV4::new(LAN, 41011), "t", &always()).await;
        assert!(matches!(&r, Err(MapError::Unsupported(why)) if why.contains("carrier-grade")), "{r:?}");
        let private = Router::start(RouterBehaviour { external_ip: Some(Ipv4Addr::new(10, 0, 0, 2)), ..Default::default() });
        let gw = private.gateway().await.unwrap();
        assert!(matches!(map_same_port(&gw, SocketAddrV4::new(LAN, 41012), "t", &always()).await, Err(MapError::Unsupported(_))), "double NAT");

        let liar = Router::start(RouterBehaviour { lie_about_internal: true, ..Default::default() });
        let gw = liar.gateway().await.unwrap();
        assert!(matches!(map_same_port(&gw, SocketAddrV4::new(LAN, 41013), "t", &always()).await, Err(MapError::Failed(_))));
        // Ambiguous ownership: left alone rather than removed.
        assert_eq!(liar.mappings.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_late_add_after_disable_is_compensated_and_never_published() {
        let mock = Arc::new(Mock::default());
        *mock.add_delay.lock().unwrap() = Duration::from_millis(200);
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let a2 = alive.clone();
        let internal = SocketAddrV4::new(LAN, 41020);
        let m2 = mock.clone();
        let task = tokio::spawn(async move { map_same_port(m2.as_ref(), internal, "t", &move || a2.load(Ordering::SeqCst)).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        alive.store(false, Ordering::SeqCst); // disabled while AddPortMapping is in flight
        assert_eq!(task.await.unwrap(), Err(MapError::Cancelled));
        assert!(mock.map.lock().unwrap().is_empty(), "the late mapping was removed");
        assert_eq!(mock.deletes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn renewal_is_halfway_through_the_lease_with_bounded_jitter() {
        assert_eq!(renew_after(1800, 0.0), Duration::from_secs(900));
        assert_eq!(renew_after(1800, 0.5), Duration::from_secs(990));
        assert_eq!(renew_after(1800, -0.5), Duration::from_secs(810));
        assert!(!is_public(Ipv4Addr::new(100, 64, 0, 1)) && !is_public(Ipv4Addr::new(192, 168, 0, 1)) && is_public(Ipv4Addr::new(198, 51, 100, 9)));
    }

    fn mapper_with(mock: Arc<Mock>) -> (Arc<Mapper>, Arc<Transport>) {
        TEST_LOCAL.with(|v| *v.borrow_mut() = Some(LAN));
        let transport = Arc::new(Transport::default());
        let discover: Discover = Arc::new(move || {
            let g: Arc<dyn Gateway> = mock.clone();
            Box::pin(async move { Ok(g) })
        });
        (Mapper::new(transport.clone(), discover, "tok".into()), transport)
    }

    async fn until(mapper: &Mapper, f: impl Fn(&MapStatus) -> bool) -> MapStatus {
        for _ in 0..2000 {
            let s = mapper.status();
            if f(&s) {
                return s;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("status never matched: {:?}", mapper.status());
    }

    #[tokio::test(start_paused = true)]
    async fn mapper_publishes_renews_survives_a_gateway_reset_and_cleans_up_within_the_deadline() {
        let mock = Arc::new(Mock::default());
        let (mapper, transport) = mapper_with(mock.clone());
        mapper.enable();
        let s = until(&mapper, |s| matches!(s, MapStatus::Mapped { .. })).await;
        let port = transport.current_local().unwrap().1.port();
        assert_eq!(s, MapStatus::Mapped { external: format!("198.51.100.9:{port}"), lease_secs: LEASE_SECS });
        assert_eq!(transport.published_mapping(), vec![(SocketAddrV4::new(Ipv4Addr::new(198, 51, 100, 9), port).into(), SocketAddrV4::new(LAN, port).into())]);

        // Long-running: several renewals over hours keep exactly one owned mapping.
        for _ in 0..6 {
            tokio::time::sleep(Duration::from_secs(1000)).await;
        }
        assert_eq!(mock.map.lock().unwrap().len(), 1);
        assert!(matches!(mapper.status(), MapStatus::Mapped { .. }));

        // Gateway reset: the mapping vanished; the next renewal recreates it.
        mock.map.lock().unwrap().clear();
        tokio::time::sleep(Duration::from_secs(1000)).await;
        assert_eq!(mock.map.lock().unwrap().len(), 1, "recreated after reset");

        // Public address changed: revalidated at renewal and republished.
        *mock.external.lock().unwrap() = Some(Ipv4Addr::new(198, 51, 100, 77));
        tokio::time::sleep(Duration::from_secs(1000)).await;
        assert_eq!(transport.published_mapping()[0].0, SocketAddrV4::new(Ipv4Addr::new(198, 51, 100, 77), port).into());

        // Disable: withdrawn and removed within the cleanup deadline.
        let started = tokio::time::Instant::now();
        mapper.disable().await;
        assert!(started.elapsed() <= CLEANUP_DEADLINE);
        assert!(transport.published_mapping().is_empty());
        assert!(mock.map.lock().unwrap().is_empty());
        assert_eq!(mapper.status(), MapStatus::Disabled);
        // No late reactivation.
        tokio::time::sleep(Duration::from_secs(5000)).await;
        assert!(mock.map.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn conflicts_try_at_most_three_new_listener_ports_and_an_unreachable_gateway_withdraws() {
        let mock = Arc::new(Mock::default());
        let (mapper, transport) = mapper_with(mock.clone());
        // Every port the mapper could pick is taken by someone else.
        let busy2 = Arc::new(Mock::default());
        let tries = Arc::new(AtomicU64::new(0));
        let tries2 = tries.clone();
        let discover: Discover = Arc::new(move || {
            let g: Arc<dyn Gateway> = Arc::new(AlwaysTaken(busy2.clone(), tries2.clone()));
            Box::pin(async move { Ok(g) })
        });
        struct AlwaysTaken(Arc<Mock>, Arc<AtomicU64>);
        #[async_trait]
        impl Gateway for AlwaysTaken {
            async fn external_ip(&self) -> Result<Ipv4Addr, IgdError> { self.0.external_ip().await }
            async fn get_mapping(&self, p: u16) -> Result<Option<MappingEntry>, IgdError> {
                self.1.fetch_add(1, Ordering::SeqCst);
                Ok(Some(MappingEntry { internal: SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 50), p), description: "other".into(), lease_secs: 0, enabled: true }))
            }
            async fn add_mapping(&self, _: u16, _: SocketAddrV4, _: u32, _: &str) -> Result<(), IgdError> { Err(IgdError::Conflict) }
            async fn delete_mapping(&self, _: u16) -> Result<(), IgdError> { panic!("never removes a foreign mapping") }
        }
        let crowded = Mapper::new(transport.clone(), discover, "tok".into());
        crowded.enable();
        let s = until(&crowded, |s| matches!(s, MapStatus::Unsupported { .. })).await;
        assert!(matches!(s, MapStatus::Unsupported { .. }));
        assert_eq!(tries.load(Ordering::SeqCst), 1 + ALTERNATIVES as u64, "first port plus three alternatives");
        assert!(transport.published_mapping().is_empty());

        // An owned mapping whose gateway becomes unreachable is withdrawn after bounded retries.
        mapper.enable();
        until(&mapper, |s| matches!(s, MapStatus::Mapped { .. })).await;
        mock.unreachable.store(true, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(1000 + 5 + 15 + 45 + 10)).await;
        assert!(matches!(mapper.status(), MapStatus::Failed { .. }), "{:?}", mapper.status());
        assert!(transport.published_mapping().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_network_change_restarts_mapping_for_the_new_listener_only() {
        let mock = Arc::new(Mock::default());
        let (mapper, transport) = mapper_with(mock.clone());
        mapper.enable();
        until(&mapper, |s| matches!(s, MapStatus::Mapped { .. })).await;
        let old_port = transport.current_local().unwrap().1.port();
        transport.advance(5);
        assert!(transport.published_mapping().is_empty() || transport.current_local().is_none());
        mapper.enable(); // the network monitor restarts mapping on a generation change
        until(&mapper, |s| matches!(s, MapStatus::Mapped { .. })).await;
        let (generation, local) = transport.current_local().unwrap();
        assert_eq!(generation, 5);
        assert_ne!(local.port(), old_port);
        let ports: Vec<u16> = mock.map.lock().unwrap().keys().copied().collect();
        assert_eq!(ports, vec![local.port()], "the old network's mapping was removed");
        mapper.disable().await;
    }
}
