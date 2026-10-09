//! Hardware / power probing that feeds the compile-leader election (battery vs mains, CPU load).

use serde::Serialize;
use std::sync::Mutex;
use sysinfo::System;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Probe {
    /// "mains" | "battery"
    pub power: String,
    pub battery_pct: u32,
    /// 0..1 average CPU utilisation since the previous probe.
    pub cpu_load: f32,
    pub cores: usize,
    pub memory_gb: f32,
}

pub struct ProbeState {
    sys: Mutex<System>,
}

impl Default for ProbeState {
    fn default() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_usage();
        Self { sys: Mutex::new(sys) }
    }
}

/// Interprets battery readings: a machine without a battery is on mains; otherwise it is on mains only
/// while charging or full.
pub fn power_from(batteries: &[(f32, bool)]) -> (String, u32) {
    if batteries.is_empty() {
        return ("mains".into(), 100);
    }
    let pct = (batteries.iter().map(|b| b.0).sum::<f32>() / batteries.len() as f32 * 100.0).round() as u32;
    let plugged = batteries.iter().any(|b| b.1);
    (if plugged { "mains" } else { "battery" }.into(), pct.min(100))
}

fn read_batteries() -> Vec<(f32, bool)> {
    use starship_battery::{units::ratio::ratio, Manager, State};
    let Ok(m) = Manager::new() else { return vec![] };
    let Ok(iter) = m.batteries() else { return vec![] };
    iter.flatten()
        .map(|b| (b.state_of_charge().get::<ratio>(), matches!(b.state(), State::Charging | State::Full)))
        .collect()
}

impl ProbeState {
    pub fn probe(&self) -> Probe {
        let mut sys = self.sys.lock().unwrap();
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        let load = (sys.global_cpu_usage() / 100.0).clamp(0.0, 1.0);
        let (power, pct) = power_from(&read_batteries());
        Probe {
            power,
            battery_pct: pct,
            cpu_load: load,
            cores: sys.cpus().len(),
            memory_gb: sys.total_memory() as f32 / (1024.0 * 1024.0 * 1024.0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_battery_means_mains() {
        assert_eq!(power_from(&[]), ("mains".to_string(), 100));
    }

    #[test]
    fn discharging_laptop_is_on_battery() {
        assert_eq!(power_from(&[(0.42, false)]), ("battery".to_string(), 42));
    }

    #[test]
    fn charging_or_full_counts_as_mains() {
        assert_eq!(power_from(&[(0.42, true)]), ("mains".to_string(), 42));
        assert_eq!(power_from(&[(1.0, true)]).0, "mains");
    }

    #[test]
    fn multiple_batteries_are_averaged() {
        assert_eq!(power_from(&[(0.2, false), (0.6, false)]), ("battery".to_string(), 40));
    }

    #[test]
    fn live_probe_returns_sane_values() {
        let p = ProbeState::default().probe();
        assert!(p.cpu_load >= 0.0 && p.cpu_load <= 1.0);
        assert!(p.cores >= 1);
        assert!(p.memory_gb > 0.1);
        assert!(p.battery_pct <= 100);
    }
}
