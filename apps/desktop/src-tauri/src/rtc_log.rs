//! The native WebRTC stack's own log (`webrtc`, `webrtc_ice`, `turn`, ...), kept in a bounded ring so a connection
//! report can say why ICE or TURN failed in the stack's words. Nothing else in the app logs through `log`.
//!
//! Records carrying TURN credentials (username, password, realm, nonce, integrity) are dropped, and IP addresses are
//! masked before a line is stored: the ring can be copied into a shareable report.

use std::collections::VecDeque;
use std::sync::Mutex;

/// Lines kept (oldest dropped first).
const CAPACITY: usize = 600;
/// Longest stored line, in characters.
const MAX_LINE: usize = 300;
/// Crates of the WebRTC stack whose records are kept.
const TARGETS: [&str; 8] = ["webrtc", "webrtc_ice", "webrtc_dtls", "webrtc_sctp", "webrtc_data", "turn", "stun", "webrtc_util"];
/// A record mentioning any of these is dropped whole (credentials or their derivatives).
const SECRET_WORDS: [&str; 6] = ["username", "password", "credential", "realm", "nonce", "integrity"];

pub struct Ring {
    lines: Mutex<(u64, VecDeque<(u64, String)>)>,
}

impl Default for Ring {
    fn default() -> Self {
        Self { lines: Mutex::new((0, VecDeque::with_capacity(CAPACITY))) }
    }
}

impl Ring {
    /// Stores one record (already filtered by target and level); returns false when it was dropped.
    pub fn push(&self, level: log::Level, target: &str, message: &str) -> bool {
        let lower = message.to_ascii_lowercase();
        if SECRET_WORDS.iter().any(|w| lower.contains(w)) {
            return false;
        }
        let mut text: String = mask_addresses(message).chars().filter(|c| !c.is_control()).take(MAX_LINE).collect();
        if text.is_empty() {
            text.push('-');
        }
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let crate_name = target.split("::").next().unwrap_or(target);
        let mut g = self.lines.lock().unwrap();
        g.0 += 1;
        let seq = g.0;
        if g.1.len() == CAPACITY {
            g.1.pop_front();
        }
        g.1.push_back((seq, format!("{at} {level} {crate_name}: {text}")));
        true
    }

    /// Lines after sequence number `since` (0: all kept), oldest first, with their sequence numbers.
    pub fn since(&self, since: u64) -> Vec<(u64, String)> {
        self.lines.lock().unwrap().1.iter().filter(|(s, _)| *s > since).cloned().collect()
    }
}

/// Replaces IPv4 and IPv6 addresses (with an optional port) by `<ip>`.
pub fn mask_addresses(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < b.len() {
        if let Some(end) = ipv4_at(b, i).or_else(|| ipv6_at(b, i)) {
            out.push_str("<ip>");
            i = end;
            // a port after the address
            if i < b.len() && b[i] == b':' && i + 1 < b.len() && b[i + 1].is_ascii_digit() {
                i += 1;
                while i < b.len() && b[i].is_ascii_digit() {
                    i += 1;
                }
            }
            continue;
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn boundary(b: &[u8], i: usize) -> bool {
    i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'.' || b[i - 1] == b':')
}

/// End of a dotted quad starting at `i`.
fn ipv4_at(b: &[u8], i: usize) -> Option<usize> {
    if !boundary(b, i) {
        return None;
    }
    let mut j = i;
    for part in 0..4 {
        let start = j;
        while j < b.len() && b[j].is_ascii_digit() && j - start < 3 {
            j += 1;
        }
        if j == start {
            return None;
        }
        if part < 3 {
            if j >= b.len() || b[j] != b'.' {
                return None;
            }
            j += 1;
        }
    }
    if j < b.len() && (b[j].is_ascii_digit() || b[j] == b'.' && j + 1 < b.len() && b[j + 1].is_ascii_digit()) {
        return None;
    }
    Some(j)
}

/// End of an IPv6 address starting at `i` (optionally in brackets): hex groups and at least two colons.
fn ipv6_at(b: &[u8], i: usize) -> Option<usize> {
    if !boundary(b, i) {
        return None;
    }
    let bracket = b[i] == b'[';
    let mut j = if bracket { i + 1 } else { i };
    let start = j;
    let (mut colons, mut hex) = (0, 0);
    while j < b.len() && (b[j].is_ascii_hexdigit() || b[j] == b':' || b[j] == b'%' || b[j] == b'.') {
        if b[j] == b':' {
            colons += 1;
        } else if b[j].is_ascii_hexdigit() {
            hex += 1;
        }
        j += 1;
    }
    if colons < 2 || hex == 0 || j - start < 3 {
        return None;
    }
    // "12:30:45" (a time) has no hex letters and exactly two colons; real addresses have more groups or a "::".
    let text = &b[start..j];
    let has_double = text.windows(2).any(|w| w == b"::");
    if colons < 3 && !has_double {
        return None;
    }
    if bracket {
        if j < b.len() && b[j] == b']' {
            j += 1;
        } else {
            return None;
        }
    }
    Some(j)
}

struct Logger;

static RING: std::sync::OnceLock<Ring> = std::sync::OnceLock::new();

/// The process-wide ring the logger writes to.
pub fn ring() -> &'static Ring {
    RING.get_or_init(Ring::default)
}

impl log::Log for Logger {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= log::Level::Info && TARGETS.contains(&m.target().split("::").next().unwrap_or(""))
    }
    fn log(&self, r: &log::Record) {
        if self.enabled(r.metadata()) {
            ring().push(r.level(), r.target(), &r.args().to_string());
        }
    }
    fn flush(&self) {}
}

static LOGGER: Logger = Logger;

/// Installs the logger once (later calls and an already installed logger are ignored).
pub fn install() {
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_are_masked_and_times_kept() {
        assert_eq!(mask_addresses("from 192.168.1.20:52000 to 203.0.113.7"), "from <ip> to <ip>");
        assert_eq!(mask_addresses("peer [2001:db8::1]:3478 and fe80::5cd5:c860:28d4:6f93%205"), "peer <ip> and <ip>");
        assert_eq!(mask_addresses("at 12:30:45 version 0.13.0 port 3478"), "at 12:30:45 version 0.13.0 port 3478");
    }

    #[test]
    fn credentials_never_reach_the_ring() {
        let r = Ring::default();
        assert!(!r.push(log::Level::Info, "turn::client", "allocate username=alice credential=s3cret to 198.51.100.4:3478"));
        assert!(!r.push(log::Level::Warn, "turn::client", "stale nonce \"abc\" from server"));
        assert!(r.push(log::Level::Warn, "webrtc_ice::agent", "pair 10.0.0.5:5000 <-> 198.51.100.4:61000 failed"));
        let lines: Vec<String> = r.since(0).into_iter().map(|(_, l)| l).collect();
        assert_eq!(lines.len(), 1);
        let all = lines.join("\n");
        for leak in ["alice", "s3cret", "198.51.100.4", "10.0.0.5", "abc"] {
            assert!(!all.contains(leak), "{leak} leaked: {all}");
        }
        assert!(all.contains("WARN webrtc_ice: pair <ip> <-> <ip> failed"), "{all}");
    }

    #[test]
    fn the_ring_is_bounded_and_reads_from_a_sequence_number() {
        let r = Ring::default();
        for i in 0..(CAPACITY + 10) {
            r.push(log::Level::Info, "webrtc", &format!("line {i}"));
        }
        let all = r.since(0);
        assert_eq!(all.len(), CAPACITY);
        assert!(all[0].1.ends_with("line 10"));
        let last = all.last().unwrap().0;
        assert!(r.since(last).is_empty());
        assert_eq!(r.since(last - 2).len(), 2);
    }

    #[test]
    fn the_installed_logger_keeps_only_the_webrtc_stack() {
        install();
        let before = ring().since(0).last().map(|(s, _)| *s).unwrap_or(0);
        log::info!(target: "webrtc_ice::agent::agent_gather", "gathering relay candidate from 203.0.113.9:3478");
        log::debug!(target: "webrtc_ice::agent", "debug is not kept");
        log::info!(target: "hivetex_desktop_lib::other", "other crates are not kept");
        let new: Vec<String> = ring().since(before).into_iter().map(|(_, l)| l).collect();
        assert_eq!(new.len(), 1, "{new:?}");
        assert!(new[0].contains("INFO webrtc_ice: gathering relay candidate from <ip>"), "{new:?}");
    }
}
