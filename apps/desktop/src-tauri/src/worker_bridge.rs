//! Routing between the native side and the current worker generation (D1, task 6.4). Native RTC connections created
//! for the worker are keyed `w<gen>/<project>/<connection>`, so two projects connected to the same remote device never
//! share an entry, and every event they emit carries that generation: once the worker is replaced, events of the old
//! generation are dropped and its connections are closed, so a late callback can never reach the new runtime.
//! Events queue in a bounded channel; a worker that stops reading loses its connections instead of growing memory.

use crate::rtc::{Emit, RtcState};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::collections::BTreeSet;
use std::sync::Arc;

/// Events waiting for the worker; beyond this the producing connection is closed.
pub const EVENT_QUEUE: usize = 1024;
pub const EVENT_BYTES: usize = 4 * 1024 * 1024;

pub fn scoped_id(gen: u64, project: &str, conn: &str) -> Result<String, String> {
    let ok = |s: &str| !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b));
    if !ok(project) || !ok(conn) {
        return Err("invalid project or connection id".into());
    }
    Ok(format!("w{gen}/{project}/{conn}"))
}

/// The generation a scoped id belongs to.
pub fn generation_of(id: &str) -> Option<u64> {
    id.strip_prefix('w')?.split('/').next()?.parse().ok()
}

pub struct Router {
    current: Arc<AtomicU64>,
    tx: SyncSender<Value>,
    /// Ids whose events overflowed the queue: the dispatcher closes them.
    overflowed: Arc<std::sync::Mutex<BTreeSet<String>>>,
    bytes: Arc<AtomicUsize>,
}

impl Router {
    pub fn new(gen: u64) -> (Router, Receiver<Value>) {
        let (tx, rx) = sync_channel(EVENT_QUEUE);
        (Router { current: Arc::new(AtomicU64::new(gen)), tx, overflowed: Arc::default(), bytes:Arc::new(AtomicUsize::new(0)) }, rx)
    }

    pub fn generation(&self) -> u64 {
        self.current.load(Ordering::SeqCst)
    }
    pub fn queued_bytes(&self) -> usize { self.bytes.load(Ordering::SeqCst) }

    /// A new worker generation takes over: events of older ones are dropped from now on.
    pub fn advance(&self, gen: u64) {
        self.current.store(gen, Ordering::SeqCst);
    }

    /// The emitter handed to `RtcState` for one scoped connection.
    pub fn emitter(&self, id: String) -> Emit {
        let current = self.current.clone();
        let tx = self.tx.clone();
        let overflowed = self.overflowed.clone();
        let bytes = self.bytes.clone();
        let gen = generation_of(&id).unwrap_or(u64::MAX);
        Arc::new(move |name, payload| {
            if current.load(Ordering::SeqCst) != gen {
                return; // a late callback of a replaced worker
            }
            let frame = json!({ "v": crate::worker::PROTOCOL, "gen": gen, "kind": "evt", "event": "rtc", "data": { "id": id, "name": name, "payload": payload } });
            let size = serde_json::to_vec(&frame).map_or(EVENT_BYTES + 1, |v| v.len());
            let reserved = bytes.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(size).filter(|n|*n<=EVENT_BYTES)).is_ok();
            if !reserved || tx.try_send(frame).is_err() {
                if reserved { bytes.fetch_sub(size, Ordering::SeqCst); }
                let mut over = overflowed.lock().unwrap();
                if over.len()<EVENT_QUEUE {over.insert(id.clone());}
            }
        })
    }

    pub fn take_overflowed(&self) -> Vec<String> {
        std::mem::take(&mut *self.overflowed.lock().unwrap()).into_iter().collect()
    }
    pub fn release(&self, frame:&Value) {
        let size = serde_json::to_vec(frame).map_or(0, |v|v.len());
        let _ = self.bytes.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n|Some(n.saturating_sub(size)));
    }
}

/// Closes every native connection of generations older than `keep` (after a worker restart).
pub async fn close_stale(rtc: &RtcState, keep: u64) -> usize {
    rtc.close_where(|id| generation_of(id).is_some_and(|g| g < keep)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_bytes_are_bounded_and_released_after_delivery() {
        let (router,rx)=Router::new(1);
        let emitter=router.emitter(scoped_id(1,"p","c").unwrap());
        for _ in 0..6 { emitter("rtc://c".into(),json!({"b64":"a".repeat(1024*1024)})); }
        assert!(router.bytes.load(Ordering::SeqCst)<=EVENT_BYTES);
        assert_eq!(router.take_overflowed().len(),1);
        let mut count=0;
        while let Ok(frame)=rx.try_recv(){router.release(&frame);count+=1;}
        assert_eq!(count,3);
        assert_eq!(router.bytes.load(Ordering::SeqCst),0);
        emitter("rtc://c".into(),json!({"kind":"open"}));
        assert!(rx.try_recv().is_ok());
    }

    #[test]
    fn scoped_ids_separate_projects_and_generations() {
        let a = scoped_id(1, "projA", "dev-1").unwrap();
        let b = scoped_id(1, "projB", "dev-1").unwrap();
        assert_ne!(a, b, "same remote device in two projects");
        assert_eq!(generation_of(&a), Some(1));
        assert_eq!(generation_of(&scoped_id(12, "p", "c").unwrap()), Some(12));
        assert!(scoped_id(1, "../x", "c").is_err());
        assert!(scoped_id(1, "p", "").is_err());
    }

    #[test]
    fn events_of_a_replaced_generation_never_reach_the_worker() {
        let (router, rx) = Router::new(1);
        let old = router.emitter(scoped_id(1, "p", "dev").unwrap());
        old(String::from("rtc://x"), json!({ "kind": "open" }));
        assert_eq!(rx.try_recv().unwrap()["gen"], 1);
        router.advance(2);
        old(String::from("rtc://x"), json!({ "kind": "message" }));
        assert!(rx.try_recv().is_err());
        let new = router.emitter(scoped_id(2, "p", "dev").unwrap());
        new(String::from("rtc://x"), json!({ "kind": "open" }));
        let f = rx.try_recv().unwrap();
        assert_eq!(f["gen"], 2);
        assert_eq!(f["data"]["id"], "w2/p/dev");
    }

    #[test]
    fn a_full_queue_marks_the_connection_for_closing_instead_of_growing() {
        let (router, _rx) = Router::new(1);
        let e = router.emitter(scoped_id(1, "p", "dev").unwrap());
        for _ in 0..EVENT_QUEUE + 5 {
            e(String::from("rtc://x"), json!({ "kind": "message" }));
        }
        let over = router.take_overflowed();
        assert_eq!(over.len(), 1, "overflow notifications are bounded and deduplicated per connection");
        assert!(over.iter().all(|id| id == "w1/p/dev"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stale_connections_are_closed_after_a_restart() {
        let rtc = RtcState::default();
        let (router, _rx) = Router::new(1);
        for (g, p) in [(1, "a"), (1, "b"), (2, "a")] {
            let id = scoped_id(g, p, "dev").unwrap();
            rtc.create(&id, vec![], router.emitter(id.clone())).await.unwrap();
        }
        assert_eq!(close_stale(&rtc, 2).await, 2);
        assert_eq!(rtc.ids().await, vec!["w2/a/dev".to_string()]);
    }
}
