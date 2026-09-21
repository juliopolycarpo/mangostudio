//! The runtime-home lock protocol, reimplemented bit for bit from
//! `apps/runtime/src/runtime-home.ts`'s `withSlotLock` — not an OS lock.
//!
//! A TypeScript runtime and a Rust runtime can run concurrently against the
//! same `MANGO_HOME`, and neither an OS mandatory lock nor an OS advisory
//! lock lets them serialise against each other:
//!
//! - Windows' `LockFileEx` (what `std::fs::File::lock` calls) takes a
//!   **mandatory** range lock. While this process held it, the TypeScript
//!   side's `readFile()` of the lock body would fail with a sharing
//!   violation — which breaks *its* reclaim path, since that path starts by
//!   reading `{ pid, host }` back out of the file.
//! - Unix `flock`/`fcntl` is advisory, and `runtime-home.ts` never calls it
//!   (it opens the file with Node's `'wx'` flag instead). A Rust `flock`
//!   would be invisible to it and would prevent nothing.
//!
//! So both sides speak the same on-disk protocol instead: create the lock
//! file with `O_EXCL`/`CREATE_NEW`, write a JSON body naming the holder,
//! delete it when done, and poll/reclaim exactly as documented below. Every
//! constant in [`LockPolicy::default`] and every reclaim rule in
//! `reclaim_if_abandoned` is copied from `runtime-home.ts`, not chosen
//! independently — a value picked separately here would make one side
//! reclaim a lock the other still considers live.

use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

#[cfg(unix)]
#[path = "lock/unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "lock/windows.rs"]
mod platform;

/// Poll/timeout/stale tunables for [`with_slot_lock`].
///
/// [`LockPolicy::default`] is the protocol every writer — Rust or
/// TypeScript — must run with against a shared `MANGO_HOME`: 25ms poll,
/// 5s timeout, 60s stale floor, taken verbatim from `runtime-home.ts`'s
/// `SLOT_LOCK_POLL_MS`, `SLOT_LOCK_TIMEOUT_MS`, `SLOT_LOCK_STALE_MS`. A
/// caller may override it for a test; production code has no reason to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LockPolicy {
    /// How long to sleep between attempts while another holder has the lock.
    pub poll_interval: Duration,
    /// How long to wait for a live, unreclaimed holder before giving up.
    pub timeout: Duration,
    /// How old an unidentifiable lock must be before it counts as abandoned.
    pub stale_after: Duration,
}

impl Default for LockPolicy {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_millis(25),
            timeout: Duration::from_secs(5),
            stale_after: Duration::from_secs(60),
        }
    }
}

/// What a lock holder writes into the file: `{"pid": <u32>, "host": "<name>"}`,
/// mirroring `JSON.stringify({ pid: process.pid, host: hostname() })`. Field
/// order is never compared — both sides parse this as JSON.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct LockOwner {
    pid: Option<u32>,
    host: Option<String>,
}

/// Why [`with_slot_lock`] could not run its closure.
#[derive(Debug)]
pub enum LockError {
    /// A live, unreclaimed holder still had the lock when `policy.timeout` elapsed.
    TimedOut {
        /// The lock file a caller can inspect to see who still holds it.
        path: PathBuf,
    },
    /// An I/O failure other than "the lock file already exists": a missing
    /// parent directory, a permissions error, and so on.
    Io(io::Error),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::TimedOut { path } => {
                write!(
                    formatter,
                    "timed out waiting for the runtime slot lock at {}",
                    path.display()
                )
            }
            LockError::Io(error) => write!(formatter, "runtime slot lock I/O error: {error}"),
        }
    }
}

impl std::error::Error for LockError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            LockError::TimedOut { .. } => None,
            LockError::Io(error) => Some(error),
        }
    }
}

/// Runs `run` while holding the lock at `lock_path`, serialising every
/// writer — Rust or TypeScript — that takes the same path.
///
/// The lock is released as soon as `run` returns, including when it panics:
/// cleanup happens in a guard's `Drop`, mirroring the TypeScript `finally`
/// that removes the file whether `run()` resolved or threw.
///
/// # Errors
/// [`LockError::TimedOut`] when a live holder never released it within
/// `policy.timeout`. [`LockError::Io`] for anything else that stopped this
/// call from creating or writing the lock file.
///
/// # Example
/// ```
/// use mangostudio_runtime::runtime_home::lock::{LockPolicy, with_slot_lock};
///
/// let dir = std::env::temp_dir().join(format!("mango-lock-doctest-{}", std::process::id()));
/// std::fs::create_dir_all(&dir).unwrap();
/// let lock_path = dir.join("runtime.lock");
///
/// let doubled = with_slot_lock(&lock_path, &LockPolicy::default(), || 21 * 2).unwrap();
/// assert_eq!(doubled, 42);
/// assert!(!lock_path.exists(), "the lock is released once the closure returns");
/// # std::fs::remove_dir_all(&dir).ok();
/// ```
pub fn with_slot_lock<T>(
    lock_path: &Path,
    policy: &LockPolicy,
    run: impl FnOnce() -> T,
) -> Result<T, LockError> {
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent).map_err(LockError::Io)?;
    }
    let deadline = Instant::now() + policy.timeout;

    loop {
        match create_lock_file(lock_path) {
            Ok(file) => {
                let mut guard = LockGuard {
                    path: lock_path,
                    file: Some(file),
                };
                let body = serde_json::to_vec(&LockOwner {
                    pid: Some(std::process::id()),
                    host: platform::hostname().ok(),
                })
                .expect("LockOwner has no field that can fail to serialise");
                guard
                    .file
                    .as_mut()
                    .expect("the lock guard retains its creation handle")
                    .write_all(&body)
                    .map_err(LockError::Io)?;
                return Ok(run());
            }
            Err(error) if is_lock_contended(&error, lock_path) => {
                if reclaim_if_abandoned(lock_path, policy) {
                    continue;
                }
                if Instant::now() >= deadline {
                    return Err(LockError::TimedOut {
                        path: lock_path.to_path_buf(),
                    });
                }
                std::thread::sleep(policy.poll_interval);
            }
            Err(error) => return Err(LockError::Io(error)),
        }
    }
}

/// Whether an error says another process still owns the lock path.
///
/// Windows can return `ERROR_ACCESS_DENIED` (5), rather than
/// `ERROR_FILE_EXISTS`, while another handle to an exclusive-create lock is
/// still being released. When the lock path exists, or its deletion is still
/// pending, that is a transient contention result and must take the same
/// poll-and-reclaim path as an ordinary existing lock. A confirmed absent
/// path with the same error is an ordinary I/O failure, such as an unwritable
/// parent directory.
fn is_lock_contended(error: &io::Error, lock_path: &Path) -> bool {
    if error.kind() == io::ErrorKind::AlreadyExists {
        return true;
    }
    #[cfg(windows)]
    {
        error.raw_os_error() == Some(5) // ERROR_ACCESS_DENIED
            && access_denied_lock_is_contended(lock_path.try_exists())
    }
    #[cfg(not(windows))]
    {
        let _ = lock_path;
        false
    }
}

#[cfg(windows)]
fn access_denied_lock_is_contended(presence: io::Result<bool>) -> bool {
    match presence {
        Ok(present) => present,
        Err(error) => error.raw_os_error() == Some(5), // ERROR_ACCESS_DENIED
    }
}

/// Releases the lock on drop, so every early return above — including a
/// write failure and a panic inside `run` — still closes and unlinks the file.
struct LockGuard<'a> {
    path: &'a Path,
    file: Option<std::fs::File>,
}

impl Drop for LockGuard<'_> {
    fn drop(&mut self) {
        // The TypeScript implementation closes its `wx` handle before
        // unlinking. Windows otherwise rejects the unlink while the owner
        // handle remains live.
        drop(self.file.take());
        let _ = std::fs::remove_file(self.path);
    }
}

/// Creates the lock file, refusing if one is already there.
///
/// `create_new` is documented atomic (`O_EXCL` on Unix, `CREATE_NEW` on
/// Windows) — the same primitive Node's `open(path, 'wx')` uses, which is
/// what makes this interoperable with the TypeScript side at all.
///
/// Unix opens it `0o600`: nothing in the protocol requires that (the
/// TypeScript writer does not restrict it), but nothing forbids a Rust
/// holder from being the stricter one either. It is not free, though: a
/// TypeScript process running under a *different* account than the Rust
/// holder gets `EACCES` reading this lock's body back, which makes
/// `reclaim_if_abandoned` return `false` on that side — a dead Rust
/// holder's lock can then never be reclaimed by that other-account
/// process, only time out at `policy.timeout` forever. Off-design for the
/// per-account `~/.mango` this protocol assumes; noted rather than fixed.
fn create_lock_file(path: &Path) -> io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options.open(path)
}

/// Removes a lock whose owner is provably gone, and says whether it did.
///
/// Two questions, because neither alone is sound. A dead pid is the fast
/// answer, but a pid means nothing unless it was recorded on *this*
/// machine — a runtime home can sit on a mounted share — so it is only
/// trusted when the hostnames agree. Age covers a lock recorded on a
/// foreign host: every holder does one small write, so a lock that has
/// survived far longer than any of them could is a leftover.
///
/// Age is **not** consulted once a lock is `owned_here`, matching
/// `reclaimAbandonedLock` in `runtime-home.ts` exactly (`ownedHere ?
/// !isProcessAlive(pid) : age > SLOT_LOCK_STALE_MS`, not both). A same-host
/// lock whose recorded pid is recycled by an unrelated long-lived process
/// stays wedged past `stale_after` on both sides — a known, shared gap in
/// this protocol, not one this crate can close alone.
///
/// Hostnames are compared case-insensitively, unlike `runtime-home.ts`'s
/// exact `===`: this crate's own `GetComputerNameExW`/`gethostname` call is
/// not guaranteed to agree on casing with Node's `os.hostname()` for the
/// same machine, and only *this* side needs the extra care — a Rust holder
/// reading its own lock back always matches itself exactly.
///
/// Two waiters racing to reclaim are **not** safe from each other, and this
/// is a real, unfixed hole in the shared protocol, not a Rust-only one:
/// both `reclaim_if_abandoned` here and `reclaimAbandonedLock` in
/// `runtime-home.ts` read the body, decide, then `unlink` by path with no
/// identity check on what is actually there. If waiter A reclaims and
/// recreates the lock between waiter B's read and B's `unlink`, B deletes
/// A's fresh lock — both then believe they hold it. Fixing only the Rust
/// side would not close the window, since a TypeScript waiter can still
/// blind-unlink a Rust winner's fresh lock; closing it needs an
/// identity-checked delete (e.g. compare-and-unlink by inode, or a rename
/// into place) on *both* sides at once, which is out of scope for this
/// module alone.
fn reclaim_if_abandoned(path: &Path, policy: &LockPolicy) -> bool {
    let Ok(raw) = std::fs::read(path) else {
        return false;
    };
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    let Ok(modified) = metadata.modified() else {
        return false;
    };
    let age = SystemTime::now()
        .duration_since(modified)
        .unwrap_or(Duration::ZERO);

    // An empty file is a holder between `create_new` and its first write,
    // not a leftover; a parse failure lands on the same "no owner" answer.
    let owner: LockOwner = if raw.is_empty() {
        LockOwner::default()
    } else {
        serde_json::from_slice(&raw).unwrap_or_default()
    };

    let owned_here = owner.pid.is_some()
        && owner
            .host
            .as_deref()
            .zip(platform::hostname().ok())
            .is_some_and(|(recorded, here)| recorded.eq_ignore_ascii_case(&here));
    let abandoned = if owned_here {
        !platform::is_process_alive(owner.pid.expect("checked by owned_here"))
    } else {
        age > policy.stale_after
    };
    if !abandoned {
        return false;
    }
    // `true` here is what tells `with_slot_lock` to retry `create_lock_file`
    // immediately, with no deadline check and no sleep in between — correct
    // only when the path really is clear. `NotFound` means another waiter's
    // own reclaim already won the race (mirroring `reclaimAbandonedLock`'s
    // swallowed-`ENOENT` intent), so the file is gone either way and a
    // retry is exactly right. Any other error — a read-only directory, a
    // Windows handle still open on the file — means the stale file is
    // still sitting there: reporting `true` anyway would send the caller
    // straight back into the same `AlreadyExists` with nothing changed,
    // spinning instead of backing off to its poll interval and deadline.
    match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(error) if error.kind() == io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Barrier};
    use std::time::Duration;

    #[cfg(windows)]
    use super::access_denied_lock_is_contended;
    #[cfg(unix)]
    use super::reclaim_if_abandoned;
    use super::{
        LockError, LockOwner, LockPolicy, create_lock_file, is_lock_contended, platform,
        with_slot_lock,
    };
    use crate::test_support::scratch_dir;

    #[test]
    fn the_default_policy_matches_the_shared_protocol_constants() {
        // The regression this test guards: a value changed here without
        // changing `runtime-home.ts` (or vice versa) makes one side reclaim
        // a lock the other still considers live.
        let policy = LockPolicy::default();
        assert_eq!(policy.poll_interval, Duration::from_millis(25));
        assert_eq!(policy.timeout, Duration::from_secs(5));
        assert_eq!(policy.stale_after, Duration::from_secs(60));
    }

    #[test]
    fn an_existing_lock_is_contended() {
        let dir = scratch_dir("existing-lock");
        let lock = dir.join("runtime.lock");
        std::fs::write(&lock, b"owner").unwrap();
        let error = std::io::Error::from(std::io::ErrorKind::AlreadyExists);
        assert!(is_lock_contended(&error, &lock));
    }

    #[cfg(windows)]
    #[test]
    fn windows_access_denied_while_creating_a_lock_is_contended() {
        let dir = scratch_dir("access-denied-lock");
        let lock = dir.join("runtime.lock");
        std::fs::write(&lock, b"owner").unwrap();
        let error = std::io::Error::from_raw_os_error(5); // ERROR_ACCESS_DENIED
        assert!(is_lock_contended(&error, &lock));
    }

    #[cfg(windows)]
    #[test]
    fn windows_access_denied_without_a_lock_is_not_contended() {
        let dir = scratch_dir("access-denied-without-lock");
        let lock = dir.join("runtime.lock");
        let error = std::io::Error::from_raw_os_error(5); // ERROR_ACCESS_DENIED
        assert!(!is_lock_contended(&error, &lock));
    }

    #[cfg(windows)]
    #[test]
    fn windows_access_denied_while_lock_deletion_is_pending_is_contended() {
        assert!(access_denied_lock_is_contended(Err(
            std::io::Error::from_raw_os_error(5), // ERROR_ACCESS_DENIED
        )));
    }

    #[test]
    fn runs_the_closure_and_releases_the_lock_afterwards() {
        let dir = scratch_dir("basic");
        let lock = dir.join("runtime.lock");

        let value = with_slot_lock(&lock, &LockPolicy::default(), || 7).expect("uncontended lock");
        assert_eq!(value, 7);
        assert!(
            !lock.exists(),
            "the guard must remove the lock file on the way out"
        );
    }

    #[test]
    fn releases_the_lock_even_when_the_closure_panics() {
        let dir = scratch_dir("panic");
        let lock = dir.join("runtime.lock");

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            with_slot_lock(&lock, &LockPolicy::default(), || panic!("boom")).ok();
        }));
        assert!(result.is_err());
        assert!(
            !lock.exists(),
            "the Drop guard must run even when the closure unwinds"
        );
    }

    #[test]
    fn writes_this_processs_pid_and_hostname_into_the_lock_body() {
        let dir = scratch_dir("body");
        let lock = dir.join("runtime.lock");
        let lock_for_closure = lock.clone();
        let seen = Arc::new(std::sync::Mutex::new(None));
        let seen_clone = Arc::clone(&seen);

        with_slot_lock(&lock, &LockPolicy::default(), move || {
            let raw = std::fs::read(&lock_for_closure).expect("the lock file exists while held");
            *seen_clone.lock().unwrap() = Some(serde_json::from_slice::<LockOwner>(&raw).unwrap());
        })
        .unwrap();

        let owner = seen
            .lock()
            .unwrap()
            .take()
            .expect("the closure ran and recorded the body");
        assert_eq!(owner.pid, Some(std::process::id()));
        assert_eq!(owner.host.as_deref(), platform::hostname().ok().as_deref());
    }

    #[test]
    fn waits_for_a_lock_held_by_this_alive_process_instead_of_stealing_it() {
        let dir = scratch_dir("live-wait");
        let lock = dir.join("runtime.lock");
        // Held by *this* process's own pid: `is_process_alive` reports true,
        // so reclaim must refuse it no matter how long the wait runs.
        create_lock_file(&lock).unwrap();
        std::fs::write(
            &lock,
            serde_json::to_vec(&LockOwner {
                pid: Some(std::process::id()),
                host: platform::hostname().ok(),
            })
            .unwrap(),
        )
        .unwrap();

        let policy = LockPolicy {
            poll_interval: Duration::from_millis(5),
            timeout: Duration::from_millis(60),
            stale_after: Duration::from_secs(60),
        };
        let error = with_slot_lock(&lock, &policy, || unreachable!("must never acquire"))
            .expect_err("the lock is live for the whole timeout");
        assert!(matches!(error, LockError::TimedOut { .. }));
        std::fs::remove_file(&lock).ok();
    }

    #[cfg(unix)]
    #[test]
    fn waits_for_a_lock_held_by_a_genuinely_foreign_live_pid() {
        // The case the test above cannot exercise: `std::process::id()` is
        // trivially alive because it is *this* test. A separately spawned,
        // still-running child proves `is_process_alive` actually queries the
        // pid it is given rather than special-casing the caller's own.
        let dir = scratch_dir("foreign-live-pid");
        let lock = dir.join("runtime.lock");
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("`sleep` is on PATH on every Unix this crate targets");

        create_lock_file(&lock).unwrap();
        std::fs::write(
            &lock,
            serde_json::to_vec(&LockOwner {
                pid: Some(child.id()),
                host: platform::hostname().ok(),
            })
            .unwrap(),
        )
        .unwrap();

        let policy = LockPolicy {
            poll_interval: Duration::from_millis(5),
            timeout: Duration::from_millis(60),
            stale_after: Duration::from_secs(60),
        };
        let error = with_slot_lock(&lock, &policy, || unreachable!("must never acquire"))
            .expect_err("the child is still running for the whole timeout");
        assert!(matches!(error, LockError::TimedOut { .. }));

        std::fs::remove_file(&lock).ok();
        child.kill().ok();
        child.wait().ok();
    }

    #[cfg(unix)]
    #[test]
    fn reclaims_a_lock_left_by_a_pid_that_no_longer_exists_on_this_host() {
        let dir = scratch_dir("dead-pid");
        let lock = dir.join("runtime.lock");
        let mut child = std::process::Command::new("true")
            .spawn()
            .expect("`true` exists");
        let dead_pid = child.id();
        child.wait().unwrap();

        create_lock_file(&lock).unwrap();
        std::fs::write(
            &lock,
            serde_json::to_vec(&LockOwner {
                pid: Some(dead_pid),
                host: platform::hostname().ok(),
            })
            .unwrap(),
        )
        .unwrap();

        // Reclaim must happen well inside the poll interval, not after
        // waiting out the whole timeout — this asserts the abandoned branch
        // fired, not the stale-age branch.
        let policy = LockPolicy {
            poll_interval: Duration::from_millis(5),
            timeout: Duration::from_millis(500),
            stale_after: Duration::from_secs(60),
        };
        let value =
            with_slot_lock(&lock, &policy, || 99).expect("a dead owner's lock is reclaimed");
        assert_eq!(value, 99);
    }

    #[test]
    fn a_lock_whose_host_does_not_match_waits_for_the_stale_floor_not_the_pid_check() {
        let dir = scratch_dir("foreign-host");
        let lock = dir.join("runtime.lock");
        // This process's own pid is alive, but the recorded host is not this
        // machine's, so the pid check must never run — only age can reclaim it.
        create_lock_file(&lock).unwrap();
        std::fs::write(
            &lock,
            serde_json::to_vec(&LockOwner {
                pid: Some(std::process::id()),
                host: Some("definitely-not-this-host.invalid".to_string()),
            })
            .unwrap(),
        )
        .unwrap();
        set_lock_age(&lock, Duration::from_secs(61));

        let policy = LockPolicy {
            poll_interval: Duration::from_millis(5),
            timeout: Duration::from_millis(200),
            stale_after: Duration::from_secs(60),
        };
        let value = with_slot_lock(&lock, &policy, || 5)
            .expect("aged past the stale floor, a foreign-host lock is reclaimed on age alone");
        assert_eq!(value, 5);
    }

    #[test]
    fn an_empty_lock_body_is_a_holder_mid_write_not_an_abandoned_lock() {
        let dir = scratch_dir("empty-body");
        let lock = dir.join("runtime.lock");
        create_lock_file(&lock).unwrap();
        // No body written yet — the window `runtime-home.ts` calls out
        // between `open()` and the holder's first write.

        let policy = LockPolicy {
            poll_interval: Duration::from_millis(5),
            timeout: Duration::from_millis(60),
            stale_after: Duration::from_secs(60),
        };
        let error = with_slot_lock(&lock, &policy, || unreachable!("must never acquire"))
            .expect_err("an empty, fresh lock file must not be reclaimed as abandoned");
        assert!(matches!(error, LockError::TimedOut { .. }));
        std::fs::remove_file(&lock).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_stale_lock_that_fails_to_delete_is_not_reported_as_reclaimed() {
        if nix::unistd::Uid::effective().is_root() {
            // Root bypasses a directory's write-permission check entirely,
            // which would make `remove_file` succeed anyway and this test
            // pass without ever exercising the branch it exists to guard.
            eprintln!(
                "skipping a_stale_lock_that_fails_to_delete_is_not_reported_as_reclaimed: running as root"
            );
            return;
        }

        use std::os::unix::fs::PermissionsExt as _;

        let dir = scratch_dir("undeletable-stale-lock");
        let lock = dir.join("runtime.lock");
        create_lock_file(&lock).unwrap();
        std::fs::write(
            &lock,
            serde_json::to_vec(&LockOwner {
                pid: Some(std::process::id()),
                host: Some("definitely-not-this-host.invalid".to_string()),
            })
            .unwrap(),
        )
        .unwrap();
        set_lock_age(&lock, Duration::from_secs(61));

        let original_mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        // A directory without write permission refuses `unlink` on anything
        // inside it, regardless of the file's own permissions.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let policy = LockPolicy {
            stale_after: Duration::from_secs(60),
            ..LockPolicy::default()
        };

        let reclaimed = reclaim_if_abandoned(&lock, &policy);

        // Restored before any assertion, so a failure here still leaves the
        // scratch directory cleanable.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(original_mode)).unwrap();

        assert!(
            !reclaimed,
            "remove_file must have failed under a read-only directory, so this must not report a reclaim"
        );
        assert!(
            lock.exists(),
            "the lock file must still be there, since the delete never actually happened"
        );
    }

    /// Backdates a lock file's mtime by `age`, so a stale-floor test does not
    /// need to sleep for the real 60 seconds.
    fn set_lock_age(path: &std::path::Path, age: Duration) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        let past = std::time::SystemTime::now() - age;
        file.set_modified(past)
            .expect("set_modified is stable since Rust 1.75");
    }

    #[cfg(unix)]
    #[test]
    fn hostname_casing_does_not_block_reclaiming_this_hosts_own_dead_lock() {
        let dir = scratch_dir("case-fold");
        let lock = dir.join("runtime.lock");
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let dead_pid = child.id();
        child.wait().unwrap();
        let real_host = platform::hostname().unwrap();

        create_lock_file(&lock).unwrap();
        std::fs::write(
            &lock,
            serde_json::to_vec(&LockOwner {
                pid: Some(dead_pid),
                // Deliberately the wrong case, simulating a Node process on
                // the same box that reported this hostname differently.
                host: Some(flip_case(&real_host)),
            })
            .unwrap(),
        )
        .unwrap();

        let policy = LockPolicy {
            poll_interval: Duration::from_millis(5),
            timeout: Duration::from_millis(500),
            stale_after: Duration::from_secs(60),
        };
        let value = with_slot_lock(&lock, &policy, || 1)
            .expect("a case-differing hostname must still be recognised as this host");
        assert_eq!(value, 1);
    }

    #[cfg(unix)]
    fn flip_case(value: &str) -> String {
        value
            .chars()
            .map(|c| {
                if c.is_uppercase() {
                    c.to_ascii_lowercase()
                } else {
                    c.to_ascii_uppercase()
                }
            })
            .collect()
    }

    #[test]
    fn two_threads_racing_for_one_lock_never_run_the_closure_concurrently() {
        let dir = scratch_dir("mutual-exclusion");
        let lock = Arc::new(dir.join("runtime.lock"));
        let counter = Arc::new(AtomicU32::new(0));
        let barrier = Arc::new(Barrier::new(2));

        let spawn_one =
            |lock: Arc<std::path::PathBuf>, counter: Arc<AtomicU32>, barrier: Arc<Barrier>| {
                std::thread::spawn(move || {
                    barrier.wait();
                    with_slot_lock(&lock, &LockPolicy::default(), || {
                        // If two threads were ever inside at once, both would
                        // observe 0 here at least once across many iterations.
                        let before = counter.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(10));
                        assert_eq!(counter.load(Ordering::SeqCst), before + 1);
                        counter.fetch_sub(1, Ordering::SeqCst);
                    })
                    .unwrap();
                })
            };

        let a = spawn_one(
            Arc::clone(&lock),
            Arc::clone(&counter),
            Arc::clone(&barrier),
        );
        let b = spawn_one(
            Arc::clone(&lock),
            Arc::clone(&counter),
            Arc::clone(&barrier),
        );
        a.join().unwrap();
        b.join().unwrap();
    }
}
