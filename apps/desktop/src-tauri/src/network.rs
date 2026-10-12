//! Native route/resume observation. Samples OS metadata only; no control-plane request or probe payload.
use std::{sync::{Arc, atomic::{AtomicBool, Ordering}}, time::{Duration, SystemTime}};

#[derive(Clone, Default, PartialEq, Eq)]
pub struct Route {
    pub interface: u32,
    pub addresses: Vec<String>,
    pub gateway: Vec<String>,
}
pub fn current_route() -> Route {
    let Ok(interface) = netdev::get_default_interface() else { return Route::default() };
    let mut addresses: Vec<_> = interface.ipv4.iter().map(ToString::to_string)
        .chain(interface.ipv6.iter().map(ToString::to_string)).collect();
    addresses.sort();
    let mut gateway = Vec::new();
    if let Some(device) = interface.gateway {
        gateway.push(device.mac_addr.to_string());
        gateway.extend(device.ipv4.iter().map(ToString::to_string));
        gateway.extend(device.ipv6.iter().map(ToString::to_string));
    }
    gateway.sort();
    Route { interface: interface.index, addresses, gateway }
}
#[derive(Clone, Copy, serde::Serialize)]
pub struct Change { pub generation: u64, pub resumed: bool, pub online: bool }
pub struct Monitor { route: Route, generation: u64 }
impl Monitor {
    pub fn new(route: Route) -> Self { Self { route, generation: 1 } }
    pub fn sample(&mut self, route: Route, elapsed: Duration) -> Option<Change> {
        let resumed = elapsed > Duration::from_secs(15);
        if route == self.route && !resumed { return None; }
        let online = route.interface != 0 && !route.addresses.is_empty();
        self.route = route; self.generation += 1;
        Some(Change { generation: self.generation, resumed, online })
    }
}
/// Poll interval is local, independent of the number of dormant projects. Recovery signal arrives within 5 s.
pub fn watch(notify: Arc<dyn Fn(Change) + Send + Sync>) -> Arc<AtomicBool> {
    let stop = Arc::new(AtomicBool::new(false));
    let closed = stop.clone();
    std::thread::spawn(move || {
        let mut monitor = Monitor::new(current_route());
        // Wall time includes suspend on Linux/macOS; monotonic uptime may deliberately exclude it.
        let mut last = SystemTime::now();
        while !closed.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_secs(5));
            if closed.load(Ordering::SeqCst) { break; }
            let now = SystemTime::now();
            let elapsed = now.duration_since(last).unwrap_or(Duration::from_secs(16));
            if let Some(change) = monitor.sample(current_route(), elapsed) { notify(change); }
            last = now;
        }
    });
    stop
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn route_gateway_and_resume_changes_advance_generation_without_idle_events() {
        let route = Route { interface: 1, addresses: vec!["192.168.1.2/24".into()], gateway: vec!["192.168.1.1".into()] };
        let mut monitor = Monitor::new(route.clone());
        for _ in 0..720 { assert!(monitor.sample(route.clone(), Duration::from_secs(5)).is_none()); }
        let mut next = route.clone(); next.gateway = vec!["192.168.1.254".into()];
        let change = monitor.sample(next.clone(), Duration::from_secs(5)).unwrap();
        assert_eq!(change.generation, 2); assert!(!change.resumed); assert!(change.online);
        let change = monitor.sample(next, Duration::from_secs(601)).unwrap();
        assert_eq!(change.generation, 3); assert!(change.resumed);
        assert!(!monitor.sample(Route::default(), Duration::from_secs(5)).unwrap().online);
    }
}
