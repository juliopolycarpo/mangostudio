//! A consent read that stays stuck until the test releases it.
//!
//! The consent tests used to model a hung store as `thread::sleep(400ms)`
//! against a 50 ms bound. That only holds while the machine is idle: under
//! load the blocking pool can start the read late and the sleep can end
//! before the last poll, so a "stuck" read finished mid-test and a second
//! read started. A gate holds the read for exactly as long as the test needs
//! it held, however slow the scheduler is.

use std::sync::{Arc, Condvar, Mutex, PoisonError};

/// Blocks every [`StallGate::wait`] caller until the gate is released.
///
/// Release happens on drop too, so a failing assertion still frees the
/// blocking threads. Dropping a Tokio runtime waits for its blocking tasks,
/// and a read left parked would hang the test instead of failing it.
///
/// # Example
///
/// ```ignore
/// let gate = StallGate::new();
/// let held = gate.handle();
/// let read = reader.read(BOUND, move || { held.wait(); true });
/// // ... assert on the stuck state ...
/// gate.release();
/// ```
pub(crate) struct StallGate {
    state: Arc<(Mutex<bool>, Condvar)>,
    /// Only the original handle releases on drop, not the clones moved into reads.
    owner: bool,
}

impl StallGate {
    /// A closed gate; the returned handle releases it when dropped.
    pub(crate) fn new() -> Self {
        Self {
            state: Arc::default(),
            owner: true,
        }
    }

    /// A handle for a read closure; dropping it does not release the gate.
    pub(crate) fn handle(&self) -> Self {
        Self {
            state: Arc::clone(&self.state),
            owner: false,
        }
    }

    /// Parks the calling thread until [`StallGate::release`] runs.
    pub(crate) fn wait(&self) {
        let (released, wake) = &*self.state;
        let mut open = released.lock().unwrap_or_else(PoisonError::into_inner);
        while !*open {
            open = wake.wait(open).unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// Opens the gate for every current and future waiter.
    pub(crate) fn release(&self) {
        let (released, wake) = &*self.state;
        *released.lock().unwrap_or_else(PoisonError::into_inner) = true;
        wake.notify_all();
    }
}

impl Drop for StallGate {
    fn drop(&mut self) {
        if self.owner {
            self.release();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::StallGate;

    #[test]
    fn a_waiter_stays_parked_until_the_gate_is_released() {
        let gate = StallGate::new();
        let held = gate.handle();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || {
            held.wait();
            done_tx.send(()).unwrap();
        });
        let early = done_rx.recv_timeout(Duration::from_millis(100)).is_ok();
        gate.release();
        let released = done_rx.recv_timeout(Duration::from_secs(5)).is_ok();
        waiter.join().unwrap();
        assert_eq!(
            (early, released),
            (false, true),
            "expected (finished before release, finished after release) = (false, true) | \
             received ({early}, {released})"
        );
    }

    #[test]
    fn dropping_the_owner_releases_but_dropping_a_handle_does_not() {
        let gate = StallGate::new();
        let held = gate.handle();
        drop(gate.handle());
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || {
            held.wait();
            done_tx.send(()).unwrap();
        });
        let after_handle_drop = done_rx.recv_timeout(Duration::from_millis(100)).is_ok();
        drop(gate);
        let after_owner_drop = done_rx.recv_timeout(Duration::from_secs(5)).is_ok();
        waiter.join().unwrap();
        assert_eq!(
            (after_handle_drop, after_owner_drop),
            (false, true),
            "expected (released by a handle drop, released by the owner drop) = (false, true) | \
             received ({after_handle_drop}, {after_owner_drop})"
        );
    }
}
