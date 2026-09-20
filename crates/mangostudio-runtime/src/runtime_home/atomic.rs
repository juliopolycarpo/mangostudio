//! Publishing a file with a temp write and a rename, so a reader never sees
//! half of one.
//!
//! Mirrors `writeFileAtomically` in `apps/runtime/src/runtime-home.ts`.
//! `std::fs::rename` is the only primitive this needs — no crate — because
//! its own documentation already spells out the two platform behaviours
//! that make this safe: a Unix `rename(2)` and a Windows `MoveFileExW` with
//! a `SetFileInformationByHandle` fallback. `ReplaceFileW` is deliberately
//! not used: that API exists to preserve the *destination's* ACLs and
//! alternate streams across a swap, which matters only when the writer
//! does not own both files — every writer here owns both.

use std::io;
use std::path::Path;
use std::time::Duration;

/// Where `std::fs::rename` runs, abstracted so a test can exercise the
/// retry loop below with a fake that fails on demand — a real Windows
/// sharing violation (an antivirus or a TypeScript process holding the
/// target without `FILE_SHARE_DELETE`) cannot be reproduced on demand on
/// any platform, including the Windows CI runs this crate's gate uses.
pub trait Rename {
    /// Attempts one `rename(from, to)`.
    ///
    /// # Errors
    /// Whatever the underlying rename failed with.
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
}

/// The real `std::fs::rename`.
pub struct StdRename;

impl Rename for StdRename {
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        std::fs::rename(from, to)
    }
}

/// Where the temp file is created and written, abstracted the same way
/// [`Rename`] is: a permission failure at `create_new` (a directory this
/// process cannot write into) is awkward to arrange portably and safely in
/// a test — a fake makes that failure branch as directly testable as the
/// rename failure branch already is.
pub trait Create {
    /// Creates `path` fresh (never overwriting one) and writes `bytes` to it.
    ///
    /// # Errors
    /// Whatever the underlying create or write failed with.
    fn create(&self, path: &Path, bytes: &[u8], mode: Option<u32>) -> io::Result<()>;
}

/// The real [`write_temp_file`].
pub struct StdCreate;

impl Create for StdCreate {
    fn create(&self, path: &Path, bytes: &[u8], mode: Option<u32>) -> io::Result<()> {
        write_temp_file(path, bytes, mode)
    }
}

/// How many times to retry a rename that failed for a reason
/// [`is_transient_windows_sharing_violation`] recognises, and how long to
/// wait between attempts.
///
/// Chosen for this crate, not mirrored from `runtime-home.ts`: Node's
/// `rename()` can race the same Windows sharing violation, but nothing in
/// scope here changes the TypeScript side, so its own retry behaviour (it
/// has none) is not a constraint this has to match. Four retries at 20ms
/// (80ms total) is enough to ride out a transient antivirus scan or a
/// concurrent writer's own temp-then-rename without turning a real,
/// lasting conflict into a long hang — the slot lock around every caller of
/// this module already owns serialising real contention.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenameRetryPolicy {
    /// Total attempts, including the first.
    pub attempts: u32,
    /// Delay between attempts.
    pub backoff: Duration,
}

impl Default for RenameRetryPolicy {
    fn default() -> Self {
        Self {
            attempts: 5,
            backoff: Duration::from_millis(20),
        }
    }
}

/// Windows' `ERROR_SHARING_VIOLATION` (32): another handle on the same file
/// has it open without `FILE_SHARE_DELETE`. Checked by raw OS error code
/// rather than `io::ErrorKind` because that error kind is unstable across
/// Rust versions for this specific code; it is never produced by a Unix
/// `rename(2)`, so this predicate is a no-op there rather than needing a
/// `cfg`.
fn is_transient_windows_sharing_violation(error: &io::Error) -> bool {
    error.raw_os_error() == Some(32)
}

/// Renames `from` to `to`, retrying while `rename` fails with something
/// [`is_transient_windows_sharing_violation`] recognises.
///
/// # Errors
/// The last rename error, once `policy.attempts` is exhausted or the
/// failure is not one this recognises as transient.
fn rename_with_retry(
    rename: &impl Rename,
    from: &Path,
    to: &Path,
    policy: &RenameRetryPolicy,
) -> io::Result<()> {
    let attempts = policy.attempts.max(1);
    for attempt in 1..=attempts {
        match rename.rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) if attempt < attempts && is_transient_windows_sharing_violation(&error) => {
                std::thread::sleep(policy.backoff);
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("the loop above always returns by its last iteration")
}

/// Writes `bytes` to a temporary file beside `path` and publishes it with a
/// rename, so a concurrent reader of `path` only ever sees the old contents
/// or the new ones, never a partial write.
///
/// The temporary file is staged in `path`'s own directory, never the OS
/// temp directory: a rename across filesystems fails `EXDEV`, and the OS
/// temp directory is routinely a different filesystem from a home
/// directory.
///
/// # Errors
/// Any I/O failure creating the temporary file, writing to it, or renaming
/// it into place. The temporary file is removed on either kind of
/// failure — a create/write failure and a rename failure both clean up
/// after themselves; only a process that never reaches either `remove_file`
/// call at all (a `SIGKILL` mid-write) leaves one behind, and a reader or a
/// later writer must simply never be confused by that stray file when it
/// happens.
///
/// # Example
/// ```
/// use mangostudio_runtime::runtime_home::atomic::write_new_file;
///
/// let dir = std::env::temp_dir().join(format!("mango-atomic-doctest-{}", std::process::id()));
/// std::fs::create_dir_all(&dir).unwrap();
/// let path = dir.join("runtime.json");
///
/// write_new_file(&path, b"{}\n", None).unwrap();
/// assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}\n");
/// # std::fs::remove_dir_all(&dir).ok();
/// ```
pub fn write_new_file(path: &Path, bytes: &[u8], mode: Option<u32>) -> io::Result<()> {
    write_new_file_with(
        &StdRename,
        &StdCreate,
        path,
        bytes,
        mode,
        &RenameRetryPolicy::default(),
    )
}

/// [`write_new_file`] with an injectable [`Rename`], [`Create`], and
/// [`RenameRetryPolicy`], for the retry and failure-cleanup tests.
pub fn write_new_file_with(
    rename: &impl Rename,
    create: &impl Create,
    path: &Path,
    bytes: &[u8],
    mode: Option<u32>,
    retry: &RenameRetryPolicy,
) -> io::Result<()> {
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(directory)?;
    let temp_path = directory.join(format!(
        "{}.{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("mango-runtime-home"),
        std::process::id(),
        temp_suffix()
    ));

    if let Err(error) = create.create(&temp_path, bytes, mode) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(error);
    }

    match rename_with_retry(rename, &temp_path, path, retry) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = std::fs::remove_file(&temp_path);
            Err(error)
        }
    }
}

/// Creates `temp_path` fresh (never overwriting one, mirroring `writeFile`'s
/// own new-file semantics for a name that carries a random suffix) and
/// writes `bytes` to it.
///
/// On Unix, `mode` is applied to the `OpenOptions` used to create the file
/// — never `chmod`ed on afterwards. `mode` on an *existing* file is
/// silently ignored by `open(2)`, so chmod-after-create would leave a stale,
/// loosely-permissioned file exactly as loose the next time this path is
/// reused; opening fresh with the mode already set has no such window, and
/// every write here creates a fresh inode via the temp-then-rename shape
/// specifically so that trap can never apply.
fn write_temp_file(temp_path: &Path, bytes: &[u8], mode: Option<u32>) -> io::Result<()> {
    use std::io::Write as _;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;

    let mut file = options.open(temp_path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// A per-call unique suffix, so two writers racing inside one process never
/// share a temporary name (the pid alone is unique across processes, not
/// across concurrent callers within one).
fn temp_suffix() -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    std::time::Instant::now().hash(&mut hasher);
    std::thread::current().id().hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::time::Duration;

    use super::{
        Create, Rename, RenameRetryPolicy, StdCreate, StdRename,
        is_transient_windows_sharing_violation, rename_with_retry, write_new_file,
        write_new_file_with,
    };

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mango-runtime-atomic-test-{name}-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn publishes_the_new_contents_and_leaves_no_temp_file_behind() {
        let dir = scratch_dir("publish");
        let path = dir.join("runtime.json");

        write_new_file(&path, b"{\"schemaVersion\":1}\n", None).unwrap();

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"schemaVersion\":1}\n"
        );
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path() != path)
            .collect();
        assert!(
            leftovers.is_empty(),
            "no temp file should survive a successful publish"
        );
    }

    #[test]
    fn a_second_write_replaces_the_first_rather_than_appending() {
        let dir = scratch_dir("replace");
        let path = dir.join("runtime.json");

        write_new_file(&path, b"first", None).unwrap();
        write_new_file(&path, b"second", None).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
    }

    #[test]
    fn a_stray_temp_file_from_an_interrupted_write_is_ignored_and_survives_untouched() {
        // What a SIGKILL, a lost machine, or a container torn down mid-write
        // leaves behind: a `.tmp` sibling nobody ever renamed into place.
        // Neither this crate nor `runtime-home.ts` sweeps these — a reader
        // must simply never be confused by one, and a later writer must
        // neither delete it (it is not this call's temp file) nor collide
        // with it (its own temp name is unique per call).
        let dir = scratch_dir("interrupted");
        let path = dir.join("runtime.json");
        std::fs::write(&path, b"real-contents").unwrap();
        let stray = dir.join("runtime.json.999.deadbeef.tmp");
        std::fs::write(&stray, b"orphaned-half-write").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "real-contents");

        write_new_file(&path, b"published-over-it", None).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "published-over-it");
        assert_eq!(
            std::fs::read_to_string(&stray).unwrap(),
            "orphaned-half-write"
        );
    }

    #[cfg(unix)]
    #[test]
    fn writing_through_a_symlink_never_exposes_the_new_contents_at_the_links_old_target() {
        // The security property the temp-file-then-rename shape buys for
        // free: a rename replaces whatever `path` names *right now*, which
        // for a symlink is the link itself, not whatever it used to point
        // at. A planted symlink can redirect one write, but it can never
        // make a later reader see this write's bytes at the original
        // target — the rename severs the link rather than following it.
        let dir = scratch_dir("symlink");
        let real_target = dir.join("elsewhere.json");
        std::fs::write(&real_target, b"never touch me").unwrap();
        let path = dir.join("credentials.json");
        std::os::unix::fs::symlink(&real_target, &path).unwrap();

        write_new_file(&path, b"the actual secret", Some(0o600)).unwrap();

        assert_eq!(
            std::fs::read_to_string(&real_target).unwrap(),
            "never touch me"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "the actual secret");
        assert!(
            std::fs::symlink_metadata(&path)
                .unwrap()
                .file_type()
                .is_file(),
            "the rename must replace the symlink itself with a regular file"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_stale_loosely_permissioned_file_is_tightened_by_the_next_write() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = scratch_dir("mode-trap");
        let path = dir.join("credentials.json");
        // The trap the module doc warns about: `mode` on `OpenOptions` is
        // silently ignored when the target already exists, so a naive
        // "open the real path directly with a mode" implementation would
        // leave this file at 0644 forever. The regression this guards is a
        // future edit that stops routing writes through a temp file.
        std::fs::write(&path, b"stale").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        write_new_file(&path, b"fresh", Some(0o600)).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "fresh");
    }

    /// Always fails with `ERROR_ACCESS_DENIED` (5) — not a sharing
    /// violation, so [`rename_with_retry`] must never retry it, and a
    /// realistic stand-in for whatever unretryable reason a real rename can
    /// fail for.
    struct AlwaysAccessDenied;
    impl Rename for AlwaysAccessDenied {
        fn rename(&self, _from: &Path, _to: &Path) -> io::Result<()> {
            Err(io::Error::from_raw_os_error(5))
        }
    }

    /// Always fails to create, standing in for a directory this process
    /// cannot write into — realistic, but awkward to arrange portably and
    /// safely (it would need a real permission change on a real directory)
    /// compared to a fake at this seam.
    struct AlwaysFailsToCreate;
    impl Create for AlwaysFailsToCreate {
        fn create(&self, _path: &Path, _bytes: &[u8], _mode: Option<u32>) -> io::Result<()> {
            Err(io::Error::from_raw_os_error(5))
        }
    }

    #[test]
    fn a_rename_failure_leaves_no_temp_file_behind() {
        let dir = scratch_dir("rename-failure");
        let path = dir.join("runtime.json");
        let policy = RenameRetryPolicy {
            attempts: 1,
            backoff: Duration::from_millis(1),
        };

        let result = write_new_file_with(
            &AlwaysAccessDenied,
            &StdCreate,
            &path,
            b"data",
            None,
            &policy,
        );

        assert!(result.is_err());
        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .count();
        assert_eq!(
            leftovers, 0,
            "the temp file created before the failing rename must be cleaned up"
        );
    }

    #[test]
    fn a_create_failure_leaves_no_temp_file_behind() {
        let dir = scratch_dir("create-failure");
        let path = dir.join("runtime.json");
        let policy = RenameRetryPolicy::default();

        let result = write_new_file_with(
            &StdRename,
            &AlwaysFailsToCreate,
            &path,
            b"data",
            None,
            &policy,
        );

        assert!(result.is_err());
        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .count();
        assert_eq!(
            leftovers, 0,
            "no temp file should exist when creation itself failed"
        );
    }

    #[test]
    fn is_transient_windows_sharing_violation_recognises_only_error_32() {
        assert!(is_transient_windows_sharing_violation(
            &io::Error::from_raw_os_error(32)
        ));
        assert!(!is_transient_windows_sharing_violation(
            &io::Error::from_raw_os_error(5)
        ));
        assert!(!is_transient_windows_sharing_violation(&io::Error::other(
            "x"
        )));
    }

    /// Fails with a sharing violation `fail_times` times, then succeeds —
    /// standing in for a real Windows antivirus or TypeScript-process
    /// handle overlap that this test cannot reproduce on Linux CI.
    struct FlakyRename {
        remaining_failures: Mutex<u32>,
        renamed: Mutex<Option<(PathBuf, PathBuf)>>,
    }

    impl FlakyRename {
        fn failing(times: u32) -> Self {
            Self {
                remaining_failures: Mutex::new(times),
                renamed: Mutex::new(None),
            }
        }
    }

    impl Rename for FlakyRename {
        fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
            let mut remaining = self.remaining_failures.lock().unwrap();
            if *remaining > 0 {
                *remaining -= 1;
                return Err(io::Error::from_raw_os_error(32));
            }
            *self.renamed.lock().unwrap() = Some((from.to_path_buf(), to.to_path_buf()));
            Ok(())
        }
    }

    #[test]
    fn retries_a_sharing_violation_until_it_clears() {
        let rename = FlakyRename::failing(2);
        let policy = RenameRetryPolicy {
            attempts: 5,
            backoff: Duration::from_millis(1),
        };

        rename_with_retry(&rename, Path::new("from"), Path::new("to"), &policy)
            .expect("the third attempt succeeds, well within the 5-attempt budget");

        assert_eq!(*rename.remaining_failures.lock().unwrap(), 0);
        assert!(rename.renamed.lock().unwrap().is_some());
    }

    #[test]
    fn gives_up_once_the_retry_budget_is_exhausted() {
        let rename = FlakyRename::failing(10);
        let policy = RenameRetryPolicy {
            attempts: 3,
            backoff: Duration::from_millis(1),
        };

        let error = rename_with_retry(&rename, Path::new("from"), Path::new("to"), &policy)
            .expect_err("only 3 attempts are budgeted against 10 failures");
        assert_eq!(error.raw_os_error(), Some(32));
        // Exactly `attempts` calls were made: 3 failures consumed, 7 left unconsumed.
        assert_eq!(*rename.remaining_failures.lock().unwrap(), 7);
    }

    #[test]
    fn a_non_transient_error_is_never_retried() {
        let policy = RenameRetryPolicy {
            attempts: 5,
            backoff: Duration::from_millis(1),
        };
        let error = rename_with_retry(
            &AlwaysAccessDenied,
            Path::new("from"),
            Path::new("to"),
            &policy,
        )
        .expect_err("access denied is not a sharing violation and must fail on the first try");
        assert_eq!(error.raw_os_error(), Some(5));
    }

    #[test]
    fn write_new_file_with_uses_the_injected_rename() {
        let dir = scratch_dir("injected-rename");
        let path = dir.join("runtime.json");
        let rename = FlakyRename::failing(1);
        let policy = RenameRetryPolicy {
            attempts: 3,
            backoff: Duration::from_millis(1),
        };

        write_new_file_with(&rename, &StdCreate, &path, b"payload", None, &policy).unwrap();

        // `FlakyRename` never actually touches the filesystem on success —
        // it just records the call — so the real path is untouched. This
        // proves the retry loop is exercised for real writes, not only in
        // the unit tests above that call `rename_with_retry` directly.
        assert!(!path.exists());
        let (from, to) = rename.renamed.lock().unwrap().clone().unwrap();
        assert_eq!(to, path);
        assert!(from.starts_with(&dir));

        let _ = StdRename; // StdRename is exercised via `write_new_file` in the tests above.
    }
}
