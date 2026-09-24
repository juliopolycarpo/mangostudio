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
    // Reset by every outcome that is not a confirmed-absent access denial, so
    // the bound applies to a *run* of them rather than to the call as a whole:
    // a long, genuinely contended wait can cross the delete-pending window
    // repeatedly without ever spending its budget.
    let mut consecutive_absent = 0u32;

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
            Err(error) => match classify_create_failure(&error, lock_path, consecutive_absent) {
                CreateFailure::Contended => {
                    consecutive_absent = 0;
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
                // No sleep and no deadline check: the bound is what terminates
                // this arm, and both readings of it resolve on the next
                // attempt. Alternating absent/contended results still end at
                // `policy.timeout`, since only the `Contended` arm above can
                // repeat without limit and it honours the deadline.
                CreateFailure::RetryAbsent => consecutive_absent += 1,
                CreateFailure::Fatal => return Err(LockError::Io(error)),
            },
        }
    }
}

/// What a failed `create_lock_file` attempt means to [`with_slot_lock`]'s loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CreateFailure {
    /// Another holder owns the path: poll, reclaim, and honour the deadline.
    Contended,
    /// Retry the create straight away, without sleeping or consuming the
    /// deadline. Only ever returned a bounded number of times in a row.
    RetryAbsent,
    /// A real I/O failure: surface it as [`LockError::Io`].
    Fatal,
}

/// How many *consecutive* `ERROR_ACCESS_DENIED`-over-a-confirmed-absent-path
/// results [`with_slot_lock`] retries before reporting the error as fatal.
///
/// The ambiguity such a result carries resolves on the very next attempt:
/// either a previous holder's pending delete completed between the failed
/// `CREATE_NEW` and the probe, in which case the next `CREATE_NEW` succeeds,
/// or the parent directory is unwritable, in which case the next one fails
/// identically. One retry would therefore be enough to separate the two; two
/// is the deliberately conservative choice, cheap because every retry is
/// immediate — no sleep, no deadline spent.
///
/// This is a count of *retries*, not of attempts, so the **third** consecutive
/// miss is the one reported. Read against `classify_access_denied`'s
/// `consecutive_absent < MAX_CONSECUTIVE_ABSENT_RETRIES`, the ladder is:
///
/// | `consecutive_absent` | verdict |
/// | --- | --- |
/// | 0 | [`CreateFailure::RetryAbsent`] |
/// | 1 | [`CreateFailure::RetryAbsent`] |
/// | 2 | [`CreateFailure::Fatal`] |
///
/// Lowering this to 1 would drop a retry and narrow the very race the bounded
/// retry exists to close, so align the comment to the constant rather than the
/// other way round. A real permissions misconfiguration still surfaces as
/// [`LockError::Io`] within microseconds either way, never as a
/// `policy.timeout`-long wait behind a misleading "timed out waiting for the
/// runtime slot lock" message.
const MAX_CONSECUTIVE_ABSENT_RETRIES: u32 = 2;

/// Decides what a failed `create_lock_file` means, given the error it returned
/// and how many consecutive [`CreateFailure::RetryAbsent`] results preceded it.
///
/// `ERROR_FILE_EXISTS` ([`io::ErrorKind::AlreadyExists`]) is plain contention
/// on every platform. Windows additionally answers `ERROR_ACCESS_DENIED` (5)
/// to a `CREATE_NEW` while a previous holder's delete is still pending, which
/// is why that code gets an existence probe rather than a verdict of its own —
/// see [`classify_access_denied`]. On Unix, raw error 5 is `EIO` and says
/// nothing of the sort, so the probe never runs there.
///
/// # Example
/// ```ignore
/// let already_exists = io::Error::from(io::ErrorKind::AlreadyExists);
/// assert_eq!(
///     classify_create_failure(&already_exists, lock_path, 0),
///     CreateFailure::Contended,
/// );
/// ```
fn classify_create_failure(
    error: &io::Error,
    lock_path: &Path,
    consecutive_absent: u32,
) -> CreateFailure {
    if error.kind() == io::ErrorKind::AlreadyExists {
        return CreateFailure::Contended;
    }
    if is_windows_access_denied(error) {
        return classify_access_denied(lock_path.try_exists(), consecutive_absent);
    }
    CreateFailure::Fatal
}

/// Whether `error` is the `ERROR_ACCESS_DENIED` a Windows `CREATE_NEW` answers
/// while a previous holder's delete is still pending.
///
/// Always `false` off Windows: raw OS error 5 is `EIO` there, an unrelated
/// hardware-level failure that must stay fatal. Written as a runtime `cfg!`
/// rather than a `#[cfg]` block deliberately — every branch below it then
/// compiles, type-checks and unit-tests on a Linux or macOS development host,
/// instead of existing only in a Windows build nobody runs locally.
fn is_windows_access_denied(error: &io::Error) -> bool {
    cfg!(windows) && error.raw_os_error() == Some(5)
}

/// Decides what a Windows `ERROR_ACCESS_DENIED` create failure means, given
/// what a follow-up existence probe of the lock path answered.
///
/// The probe is a *second* syscall, and that is the whole difficulty. A path
/// that is still present, or whose own probe is denied, is a holder on its way
/// out: ordinary contention. A path the probe confirms **absent** is genuinely
/// ambiguous — either the pending delete completed in the window between the
/// two calls (transient, and the next create wins), or the parent directory is
/// unwritable (permanent). Neither reading can be settled from this one
/// answer, so the tie is broken by retrying a bounded number of times: see
/// [`MAX_CONSECUTIVE_ABSENT_RETRIES`]. A probe that fails for some *other*
/// reason is not a confirmed-absent path at all and stays fatal.
///
/// Kept cross-platform rather than `#[cfg(windows)]` so its decision table is
/// executable on every host this crate is developed on; reaching it at all is
/// what [`is_windows_access_denied`] gates.
///
/// # Example
/// ```ignore
/// // A delete that completed between the failed create and the probe:
/// // retry rather than report a permissions failure that is not there.
/// assert_eq!(classify_access_denied(Ok(false), 0), CreateFailure::RetryAbsent);
/// ```
fn classify_access_denied(presence: io::Result<bool>, consecutive_absent: u32) -> CreateFailure {
    match presence {
        Ok(true) => CreateFailure::Contended,
        // The probe itself being denied means the path is still there, with
        // its deletion pending — the same transient contention.
        Err(ref error) if error.raw_os_error() == Some(5) => CreateFailure::Contended,
        Ok(false) if consecutive_absent < MAX_CONSECUTIVE_ABSENT_RETRIES => {
            CreateFailure::RetryAbsent
        }
        Ok(false) | Err(_) => CreateFailure::Fatal,
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

/// Host identity used by the live-update lock, which shares this module's
/// cross-platform process probes with runtime.json's lock protocol.
pub(crate) fn current_hostname() -> io::Result<String> {
    platform::hostname()
}

/// Whether a same-host lock holder still exists.
pub(crate) fn is_process_alive(pid: u32) -> bool {
    platform::is_process_alive(pid)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Barrier};
    use std::time::Duration;

    #[cfg(unix)]
    use super::reclaim_if_abandoned;
    use super::{
        CreateFailure, LockError, LockOwner, LockPolicy, MAX_CONSECUTIVE_ABSENT_RETRIES,
        classify_access_denied, classify_create_failure, create_lock_file, platform,
        with_slot_lock,
    };
    use crate::test_support::scratch_dir;

    /// The `ERROR_ACCESS_DENIED` a Windows `CREATE_NEW` answers while a
    /// previous holder's delete is still pending.
    fn access_denied() -> std::io::Error {
        std::io::Error::from_raw_os_error(5)
    }

    #[test]
    fn an_access_denied_over_a_present_lock_path_is_contended() {
        assert_eq!(
            classify_access_denied(Ok(true), 0),
            CreateFailure::Contended,
            "expected Contended for a present lock path | received the classification above"
        );
    }

    #[test]
    fn an_access_denied_whose_probe_is_also_denied_is_contended() {
        assert_eq!(
            classify_access_denied(Err(access_denied()), 0),
            CreateFailure::Contended,
            "expected Contended while the previous holder's delete is still pending | received the classification above"
        );
    }

    #[test]
    fn an_access_denied_over_an_absent_lock_path_retries_within_the_bound() {
        for consecutive_absent in 0..MAX_CONSECUTIVE_ABSENT_RETRIES {
            assert_eq!(
                classify_access_denied(Ok(false), consecutive_absent),
                CreateFailure::RetryAbsent,
                "expected RetryAbsent at consecutive_absent={consecutive_absent} (bound is {}) | received the classification above",
                MAX_CONSECUTIVE_ABSENT_RETRIES
            );
        }
    }

    #[test]
    fn an_access_denied_over_an_absent_lock_path_is_fatal_past_the_bound() {
        assert_eq!(
            classify_access_denied(Ok(false), MAX_CONSECUTIVE_ABSENT_RETRIES),
            CreateFailure::Fatal,
            "expected Fatal at consecutive_absent={} (the bound itself) | received the classification above",
            MAX_CONSECUTIVE_ABSENT_RETRIES
        );
    }

    #[test]
    fn an_access_denied_whose_probe_fails_for_another_reason_is_fatal() {
        // Not a *confirmed* absent path, so the bounded retry must not apply.
        assert_eq!(
            classify_access_denied(
                Err(std::io::Error::from(std::io::ErrorKind::NotADirectory)),
                0
            ),
            CreateFailure::Fatal,
            "expected Fatal for a probe that errored with something other than ERROR_ACCESS_DENIED | received the classification above"
        );
    }

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
        assert_eq!(
            classify_create_failure(&error, &lock, 0),
            CreateFailure::Contended,
            "expected Contended for ErrorKind::AlreadyExists | received the classification above"
        );
    }

    /// What raw OS error 5 means to [`classify_create_failure`] here: on
    /// Windows it is `ERROR_ACCESS_DENIED` and gets the existence probe, while
    /// everywhere else it is `EIO` and stays fatal with no probe at all.
    ///
    /// Its two callers below therefore assert the *Windows* contract when CI
    /// runs them on `windows-latest`, and the "raw error 5 is plain `EIO`"
    /// contract when they run on Linux or macOS. Deliberately not
    /// `#[cfg(windows)]`: no development host here can compile, let alone run,
    /// a Windows-gated test body, so gating one would ship it unverified.
    fn raw_error_5_verdict(on_windows: CreateFailure) -> CreateFailure {
        if cfg!(windows) {
            on_windows
        } else {
            CreateFailure::Fatal
        }
    }

    #[test]
    fn access_denied_while_creating_a_lock_that_is_still_there_is_contended() {
        let dir = scratch_dir("access-denied-lock");
        let lock = dir.join("runtime.lock");
        std::fs::write(&lock, b"owner").unwrap();
        assert_eq!(
            classify_create_failure(&access_denied(), &lock, 0),
            raw_error_5_verdict(CreateFailure::Contended),
            "expected Contended on Windows (ERROR_ACCESS_DENIED over a lock path that is still present), Fatal elsewhere (EIO) | received the classification above"
        );
    }

    #[test]
    fn access_denied_without_a_lock_retries_within_the_bound() {
        // Contract change: this case (previously
        // `windows_access_denied_without_a_lock_is_not_contended`) used to be
        // classified fatal outright, which is the CI race — a previous
        // holder's delete completing between the failed `CREATE_NEW` and this
        // probe surfaced as `LockError::Io`. It is now retried, bounded, and
        // fatal only once the bound is spent.
        let dir = scratch_dir("access-denied-without-lock");
        let lock = dir.join("runtime.lock");
        assert_eq!(
            classify_create_failure(&access_denied(), &lock, 0),
            raw_error_5_verdict(CreateFailure::RetryAbsent),
            "expected RetryAbsent on Windows (ERROR_ACCESS_DENIED over an absent lock path, within the bound), Fatal elsewhere (EIO) | received the classification above"
        );
    }

    #[test]
    fn access_denied_without_a_lock_is_fatal_once_the_bound_is_spent() {
        // An unwritable parent directory answers this way every time, so the
        // bound runs out and the real error surfaces in microseconds rather
        // than after a `policy.timeout`-long wait.
        let dir = scratch_dir("access-denied-without-lock-exhausted");
        let lock = dir.join("runtime.lock");
        assert_eq!(
            classify_create_failure(&access_denied(), &lock, MAX_CONSECUTIVE_ABSENT_RETRIES),
            CreateFailure::Fatal,
            "expected Fatal for ERROR_ACCESS_DENIED over an absent lock path once {MAX_CONSECUTIVE_ABSENT_RETRIES} consecutive retries were spent | received the classification above"
        );
    }

    /// Restores a directory's permission bits when dropped.
    ///
    /// The restore has to survive an unwind, not just an early return: the
    /// closure handed to `with_slot_lock` below is `unreachable!`, and it runs
    /// only if the lock *was* acquired — exactly the regression the test
    /// guards. That panic would skip a plain restore call and leave the scratch
    /// directory at `0o555`, so `ScratchDir`'s own `Drop` could not remove it
    /// and a temp directory would leak on every failing run.
    ///
    /// # Example
    /// ```ignore
    /// let _restore = RestoreMode { dir: &dir, mode: original_mode };
    /// std::fs::set_permissions(&dir, Permissions::from_mode(0o555)).unwrap();
    /// // ... panic or return; the mode is restored either way.
    /// ```
    #[cfg(unix)]
    struct RestoreMode<'a> {
        dir: &'a std::path::Path,
        mode: u32,
    }

    #[cfg(unix)]
    impl Drop for RestoreMode<'_> {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt as _;
            // Best-effort: a panic here during an unwind would abort the
            // process instead of reporting the test failure in progress.
            let _ = std::fs::set_permissions(self.dir, std::fs::Permissions::from_mode(self.mode));
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_unwritable_parent_directory_fails_fast_instead_of_waiting_out_the_timeout() {
        // Pins the constraint the bounded retry had to preserve: a permission
        // error on the lock's parent surfaces as `LockError::Io` well inside
        // `policy.timeout`, never as a `TimedOut` blaming a holder that was
        // never there. This already held before the bounded retry landed, so
        // it is a regression guard, not evidence for the new behaviour.
        //
        // It deliberately does *not* reach the bounded retry. On Unix,
        // `create_new` into a `0o555` directory returns `EACCES` (errno 13),
        // not raw error 5, so `is_windows_access_denied` is false and
        // `classify_create_failure` answers `Fatal` on the first attempt:
        // `consecutive_absent` is never incremented and `RetryAbsent` is never
        // taken. The Windows contract — error 5 over a confirmed-absent path
        // retries, then reports `Io` once the bound is spent — is covered only
        // by the `classify_access_denied` / `classify_create_failure`
        // decision-table tests above; do not mistake this test for that
        // coverage.
        //
        // `#[cfg(unix)]` because staging an unwritable parent is Unix-specific
        // (`PermissionsExt`, plus the root bypass below). The Windows lane
        // skips it entirely, exactly as it already skips
        // `a_stale_lock_that_fails_to_delete_is_not_reported_as_reclaimed`.
        if nix::unistd::Uid::effective().is_root() {
            // Root bypasses the directory's write-permission check entirely,
            // so the create would succeed and never reach the branch this
            // test exists to guard.
            eprintln!(
                "skipping an_unwritable_parent_directory_fails_fast_instead_of_waiting_out_the_timeout: running as root"
            );
            return;
        }

        use std::os::unix::fs::PermissionsExt as _;

        let dir = scratch_dir("unwritable-parent");
        let lock = dir.join("runtime.lock");
        let original_mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        // Declared after `dir`, so it drops *before* the `ScratchDir` whose
        // own `Drop` removes the tree — the mode is back by the time the
        // directory is unlinked, on a panic as well as on a clean return.
        let _restore = RestoreMode {
            dir: dir.path(),
            mode: original_mode,
        };
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();

        // The full 5s production timeout, so a regression that falls through
        // to the poll loop is unmistakable rather than marginal.
        let policy = LockPolicy::default();
        let started = std::time::Instant::now();
        let result = with_slot_lock(&lock, &policy, || unreachable!("must never acquire"));
        let elapsed = started.elapsed();

        let error = result.expect_err("an unwritable parent directory cannot be locked");
        assert!(
            matches!(error, LockError::Io(_)),
            "expected LockError::Io for an unwritable parent directory | received: {error:?}"
        );
        assert!(
            elapsed < policy.timeout / 2,
            "expected the failure well inside the {:?} timeout | received: {elapsed:?}",
            policy.timeout
        );
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
