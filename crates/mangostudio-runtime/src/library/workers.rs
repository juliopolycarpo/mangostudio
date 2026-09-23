//! The library's own bound on blocking work, below the crate-wide pool.
//!
//! A cold scan walks up to every registered location at once, and each
//! walk is a long blocking job (it hashes every byte under a location).
//! Spending one [`crate::blocking::run_blocking`] permit per location would
//! let a single scan hold every permit the process has for its whole
//! duration, starving `fs.*`, `probing.*`, health and cleanup calls behind
//! it. [`LIBRARY_MAX_CONCURRENT_BLOCKING`] caps library jobs at half of
//! [`crate::blocking::MAX_CONCURRENT_BLOCKING_TASKS`], so the rest of the
//! pool always stays available to everything else.

use std::sync::{Arc, OnceLock};

use tokio::sync::Semaphore;

use crate::blocking::{MAX_CONCURRENT_BLOCKING_TASKS, run_blocking};

/// How many library blocking jobs may run at once, across every caller.
pub(crate) const LIBRARY_MAX_CONCURRENT_BLOCKING: usize = MAX_CONCURRENT_BLOCKING_TASKS / 2;

fn library_permits() -> &'static Arc<Semaphore> {
    static PERMITS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    PERMITS.get_or_init(|| Arc::new(Semaphore::new(LIBRARY_MAX_CONCURRENT_BLOCKING)))
}

/// Runs `job` on the shared blocking pool once a library permit is free.
/// The permit moves into the job, so it is returned only when the job
/// actually finishes — never merely when a caller stops waiting.
///
/// # Example
///
/// ```ignore
/// let answer = run_library_blocking(|| walk(location)).await;
/// ```
pub(crate) async fn run_library_blocking<F, T>(job: F) -> T
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let permit = Arc::clone(library_permits())
        .acquire_owned()
        .await
        .expect("the library semaphore is never closed");
    run_blocking(move || {
        let _permit = permit;
        job()
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use super::*;

    /// Named for the acceptance item "bounded workers": with every library
    /// permit held by a stalled job, an unrelated `run_blocking` call still
    /// completes, and no more than the cap of library jobs ever run at once.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_saturated_library_leaves_the_shared_pool_available() {
        let _guard = crate::blocking::pool_saturation_test_lock().lock().await;
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let (release, gate) = tokio::sync::watch::channel(false);
        let mut jobs = Vec::new();
        for _ in 0..(LIBRARY_MAX_CONCURRENT_BLOCKING * 3) {
            let running = Arc::clone(&running);
            let peak = Arc::clone(&peak);
            let mut gate = gate.clone();
            jobs.push(tokio::spawn(run_library_blocking(move || {
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                while !*gate.borrow_and_update() {
                    std::thread::sleep(Duration::from_millis(5));
                }
                running.fetch_sub(1, Ordering::SeqCst);
            })));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        let unrelated = tokio::time::timeout(Duration::from_secs(5), run_blocking(|| 42)).await;
        assert_eq!(
            unrelated.ok(),
            Some(42),
            "expected an unrelated blocking call to finish while the library is saturated | received a timeout"
        );
        release.send(true).unwrap();
        for job in jobs {
            job.await.unwrap();
        }
        let peak = peak.load(Ordering::SeqCst);
        assert!(
            peak <= LIBRARY_MAX_CONCURRENT_BLOCKING,
            "expected at most {LIBRARY_MAX_CONCURRENT_BLOCKING} concurrent library jobs | received {peak}"
        );
    }
}
