//! A bounded pool for the blocking OS calls this crate's methods make.
//!
//! `apps/runtime`'s Rust rewrite is not allowed a synchronous filesystem,
//! process, or PTY call sitting directly on a Tokio executor thread — one
//! slow `stat` or DNS lookup on that thread stalls every other task this
//! process is mid-way through, including the heartbeat loop and any other
//! request in flight on the same session. Tokio's own answer,
//! [`tokio::task::spawn_blocking`], moves the call off the executor onto a
//! dedicated thread — but its pool defaults to up to 512 threads, a limit
//! Tokio picked for a generic pool serving arbitrary blocking work across
//! every crate in a process, not a bound this crate chose for its own.
//!
//! [`run_blocking`] is this crate's own bound on top of that: every call
//! first acquires a permit from a small, process-wide [`tokio::sync::Semaphore`]
//! before it ever reaches `spawn_blocking`. [`MAX_CONCURRENT_BLOCKING_TASKS`]
//! names that bound so a reviewer can find and change it in one place,
//! rather than this crate quietly inheriting whatever Tokio's default
//! happens to be this release.

use std::sync::OnceLock;

use tokio::sync::Semaphore;

/// How many blocking calls this crate lets run at once, across every caller.
///
/// The blocking work this crate does today (a `PATH` walk's `stat` calls,
/// a `git --version` probe's process bookkeeping — see [`crate::health`])
/// is short: a handful of syscalls per call, not a long-running job. A
/// small bound is enough concurrency for several simultaneous protocol
/// calls each doing one or two of these lookups, while keeping this
/// crate's blocking work from competing for OS threads with everything
/// else the process does — including Tokio's own worker threads and its
/// blocking pool serving other crates linked into the same binary. Picked
/// as a small multiple of a typical machine's core count without reading
/// [`std::thread::available_parallelism`] at startup: this crate has no
/// per-machine tuning knob for it yet, and a fixed, named constant is
/// easier to reason about than a value that varies by host.
pub const MAX_CONCURRENT_BLOCKING_TASKS: usize = 8;

/// The process-wide gate every [`run_blocking`] call acquires a permit from
/// before it ever reaches [`tokio::task::spawn_blocking`].
fn blocking_pool() -> &'static Semaphore {
    static POOL: OnceLock<Semaphore> = OnceLock::new();
    POOL.get_or_init(|| Semaphore::new(MAX_CONCURRENT_BLOCKING_TASKS))
}

/// Runs `f` on Tokio's blocking thread pool, gated by
/// [`MAX_CONCURRENT_BLOCKING_TASKS`] concurrent callers across this whole
/// process.
///
/// The permit is acquired before `f` is ever handed to `spawn_blocking`,
/// and released — via the guard's own `Drop` — as soon as `f` returns,
/// whether it returned normally or panicked. A caller past the bound
/// simply waits its turn on the semaphore; nothing here drops or reorders
/// work.
///
/// # Panics
/// Panics if `f` itself panics (the original payload is re-raised, not
/// swallowed) or if the spawned task was cancelled from outside this
/// function — the latter cannot happen through this function's own API,
/// since it never exposes the `JoinHandle` a caller would need to cancel
/// it, so seeing it would mean a bug in this function itself.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::blocking::run_blocking;
///
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// let doubled = run_blocking(|| 21 * 2).await;
/// assert_eq!(doubled, 42);
/// # }
/// ```
pub async fn run_blocking<F, T>(f: F) -> T
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let _permit = blocking_pool()
        .acquire()
        .await
        .expect("the blocking pool's semaphore is never closed, so acquiring it never fails");
    match tokio::task::spawn_blocking(f).await {
        Ok(value) => value,
        Err(join_error) if join_error.is_panic() => {
            std::panic::resume_unwind(join_error.into_panic())
        }
        Err(join_error) => {
            panic!("a run_blocking task was cancelled rather than run to completion: {join_error}")
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use tokio::sync::mpsc;

    use super::{MAX_CONCURRENT_BLOCKING_TASKS, run_blocking};

    #[tokio::test]
    async fn a_successful_closure_returns_its_value() {
        assert_eq!(run_blocking(|| 2 + 2).await, 4);
    }

    #[tokio::test]
    #[should_panic(expected = "boom")]
    async fn a_panicking_closure_re_panics_with_the_original_payload() {
        run_blocking(|| panic!("boom")).await;
    }

    /// The bound this module exists for: once [`MAX_CONCURRENT_BLOCKING_TASKS`]
    /// permits are held, one more task must wait — it must not be admitted
    /// early, and it must be admitted the moment a permit frees, without a
    /// wall-clock sleep anywhere in the proof.
    ///
    /// Ordering is established structurally rather than by timing: this
    /// runs on the default (current-thread) `#[tokio::test]` executor, so a
    /// freshly spawned task only runs up to its own first real await point
    /// once every task spawned before it has reached one of its own. Every
    /// held task below reaches its first `.await` inside `run_blocking`
    /// only *after* signalling "started" on an async channel, so draining
    /// exactly `MAX_CONCURRENT_BLOCKING_TASKS` "started" signals proves
    /// that many permits are held concurrently before the extra task is
    /// even spawned.
    #[tokio::test]
    async fn a_task_past_the_bound_waits_for_a_permit_to_free() {
        let (started_tx, mut started_rx) = mpsc::unbounded_channel::<usize>();
        let mut held = Vec::new();
        for i in 0..MAX_CONCURRENT_BLOCKING_TASKS {
            let started_tx = started_tx.clone();
            // A std (blocking) channel: the release signal is consumed
            // from inside the blocking closure itself, which a tokio
            // channel cannot be awaited from.
            let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
            let handle = tokio::spawn(run_blocking(move || {
                started_tx
                    .send(i)
                    .expect("the test still holds the receiver");
                let _ = release_rx.recv();
            }));
            held.push((handle, release_tx));
        }
        drop(started_tx);

        // Every held task has acquired a permit and is now blocked inside
        // its closure, waiting to be released.
        let mut seen = std::collections::HashSet::new();
        for _ in 0..MAX_CONCURRENT_BLOCKING_TASKS {
            seen.insert(
                started_rx
                    .recv()
                    .await
                    .expect("every held task must signal that it started"),
            );
        }
        assert_eq!(seen.len(), MAX_CONCURRENT_BLOCKING_TASKS);

        let extra_ran = Arc::new(AtomicBool::new(false));
        let extra_ran_flag = Arc::clone(&extra_ran);
        let extra = tokio::spawn(run_blocking(move || {
            extra_ran_flag.store(true, Ordering::SeqCst);
        }));

        // Cooperative yields, not a sleep: with every permit held, the
        // extra task's own `acquire().await` can only resolve to `Pending`
        // no matter how many turns the scheduler gives it.
        for _ in 0..64 {
            tokio::task::yield_now().await;
        }
        assert!(
            !extra_ran.load(Ordering::SeqCst),
            "a task past the bound must not run while every permit is held"
        );

        // Releasing exactly one held task frees exactly one permit, which
        // must be enough for the extra task to proceed.
        let (released_handle, released_tx) = held.remove(0);
        released_tx
            .send(())
            .expect("the held closure is still waiting on this channel");
        released_handle
            .await
            .expect("the released held task must complete cleanly");
        extra
            .await
            .expect("the extra task must complete once a permit frees");
        assert!(
            extra_ran.load(Ordering::SeqCst),
            "the extra task must have actually run its closure"
        );

        // Release the remaining held tasks so nothing outlives the test.
        for (handle, release_tx) in held {
            let _ = release_tx.send(());
            handle.await.expect("every held task must complete cleanly");
        }
    }
}
