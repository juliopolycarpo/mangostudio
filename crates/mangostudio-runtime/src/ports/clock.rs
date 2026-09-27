//! When something happened, for an audit entry's duration.
//!
//! A trait rather than a bare call to [`std::time::Instant::now`] so a test
//! can control time without sleeping, and so a future change (a virtual
//! clock for deterministic replay, say) has a seam to implement against.

use std::time::Instant;

/// A source of the current instant.
pub trait Clock: Send + Sync + 'static {
    /// The current instant, by this clock's reckoning.
    fn now(&self) -> Instant;
}

/// The real wall clock. [`Clock::now`] is [`Instant::now`], nothing else.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

#[cfg(test)]
mod tests {
    use super::{Clock, SystemClock};

    #[test]
    fn the_system_clock_moves_forward() {
        let clock = SystemClock;
        let first = clock.now();
        let second = clock.now();
        assert!(second >= first);
    }
}
