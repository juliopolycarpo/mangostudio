//! A scratch directory for tests, unique across calls rather than across
//! source locations.
//!
//! Every `#[cfg(test)] mod tests` in this crate used to define its own
//! `scratch_*(name)` helper ending the path in `line!()`, on the theory that
//! `name` plus the call site made every scratch directory unique. `line!()`
//! expands where it is *written*, not where it is called: every call from
//! inside one helper function shares that helper's single source line, so
//! uniqueness rested entirely on `name` — two tests in the same module
//! passing the same name raced for the same directory, and cargo runs a
//! module's tests on separate threads by default. This module replaces all
//! of those copies with one.
//!
//! Uniqueness is process id, wall-clock nanoseconds, and a per-process
//! atomic counter folded together — not pid-plus-counter alone. A few of
//! the copies this module replaces (`consent/invocation.rs`,
//! `tests/cli.rs`, the three `tests/transport_*.rs` files) already carried
//! a nanosecond component in their own `unique_suffix()`, because pid alone
//! is not unique across a process that was killed, aborted, or reused a pid
//! a later run reissues; the counter alone restarts at zero on every new
//! process, so two processes started in the same instant could still agree
//! on the first path they mint. Consolidating onto this module must not
//! lose the entropy those copies already had.
//!
//! This whole module is `#[cfg(test)]`, so it is invisible to `cargo doc`
//! and `cargo test --doc` the same as every other test helper — its own
//! tests below are its coverage.
//!
//! This file is compiled twice: once as `crate::test_support` behind
//! `#[cfg(test)]` in `lib.rs` for this crate's own unit tests, and once by
//! path from `tests/support/mod.rs` for the integration tests under
//! `tests/`, which link the library without `cfg(test)` and so cannot see
//! the first copy. It stays free of `crate::`-rooted imports so both builds
//! resolve it identically.

use std::ffi::OsStr;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// A value unique within this process and, via the wall-clock component,
/// overwhelmingly likely to be unique across processes too — unlike a bare
/// atomic counter, which restarts at zero every time a new process starts,
/// or a bare pid, which a later process can reuse once this one exits.
/// Folding a counter into the nanosecond reading (rather than trusting the
/// clock alone) also covers a platform whose `SystemTime` resolution is
/// coarser than a nanosecond, where two calls in quick succession could
/// otherwise read the same instant.
fn unique_suffix() -> u128 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the system clock reads after the Unix epoch")
        .as_nanos();
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    nanos.wrapping_add(u128::from(count))
}

/// A directory under [`std::env::temp_dir`], unique across processes (see
/// [`unique_suffix`]), removed recursively when this value is dropped.
///
/// Derefs to [`Path`], so `dir.join("sub")`, `&*dir`, and passing `&dir`
/// wherever `AsRef<Path>` is expected all work without unwrapping.
#[must_use]
pub struct ScratchDir(PathBuf);

impl ScratchDir {
    /// Allocates a unique path under `prefix`, without creating it on disk.
    ///
    /// For a test that must observe an absent directory (setup-on-first-use
    /// behaviour, a spawned binary that creates its own `MANGO_HOME`), this
    /// is the right constructor — [`ScratchDir::created`] would race the
    /// very thing under test. The directory is still removed on drop, on the
    /// chance something did create it in the meantime.
    ///
    /// # Panics
    /// If the path already exists. [`unique_suffix`] makes this vanishingly
    /// unlikely from a genuine collision, so a hit here almost certainly
    /// means a previous run of this same helper leaked its directory (a
    /// killed process, an aborted test, a directory a permission change
    /// left undeletable) — surfacing that loudly matters more here than
    /// almost anywhere else in this module, since a caller of
    /// [`scratch_path`] specifically depends on the path starting absent.
    pub fn new(prefix: &str) -> Self {
        Self::at_suffix(prefix, unique_suffix())
    }

    /// [`ScratchDir::new`], with the uniqueness value supplied by the
    /// caller instead of drawn from [`unique_suffix`] — the seam this
    /// module's own tests use to force two calls onto the same path
    /// deterministically, which a real [`unique_suffix`] value cannot do by
    /// design.
    fn at_suffix(prefix: &str, suffix: u128) -> Self {
        let path =
            std::env::temp_dir().join(format!("mango-{prefix}-{}-{suffix}", std::process::id()));
        assert!(
            !path.exists(),
            "scratch path {path:?} already exists — expected: absent | found: present. A \
             previous process most likely leaked it (killed, aborted, or left an undeletable \
             directory behind); remove it by hand and investigate before trusting this run."
        );
        Self(path)
    }

    /// Allocates a unique path under `prefix` and creates it immediately.
    ///
    /// Uses [`std::fs::create_dir`], not `create_dir_all`: the parent
    /// ([`std::env::temp_dir`]) always exists, so the only thing a
    /// recursive create would additionally paper over is the leaf itself
    /// already being there — silently reusing whatever a leaked prior run
    /// left inside it. This fails instead, for the same reason
    /// [`ScratchDir::new`] asserts the path is absent first.
    ///
    /// # Panics
    /// If the directory cannot be created, including because it already
    /// exists.
    pub fn created(prefix: &str) -> Self {
        let dir = Self::new(prefix);
        std::fs::create_dir(&dir.0).unwrap_or_else(|error| {
            panic!(
                "scratch dir creation at {:?} failed: {error} (expected: none of this path \
                 existed yet, so create_dir should not observe an existing directory or file)",
                dir.0
            )
        });
        dir
    }

    /// The directory's path, as a plain reference.
    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Deref for ScratchDir {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for ScratchDir {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<OsStr> for ScratchDir {
    fn as_ref(&self) -> &OsStr {
        self.0.as_os_str()
    }
}

impl std::fmt::Debug for ScratchDir {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        // Best-effort: the directory may never have been created (see
        // `ScratchDir::new`), and a panic mid-unwind here would abort the
        // process rather than report the test failure that is actually in
        // progress.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Allocates and creates a unique scratch directory under `prefix`. The
/// directory (and everything written under it) is removed when the
/// returned [`ScratchDir`] is dropped. This is what almost every caller
/// wants; see [`scratch_path`] for the handful that need the path to start
/// out absent.
pub fn scratch_dir(prefix: &str) -> ScratchDir {
    ScratchDir::created(prefix)
}

/// Allocates a unique scratch path under `prefix`, without creating it —
/// for a test asserting behaviour that only happens when a directory is
/// first created (see [`ScratchDir::new`]).
pub fn scratch_path(prefix: &str) -> ScratchDir {
    ScratchDir::new(prefix)
}

#[cfg(test)]
mod tests {
    use super::{ScratchDir, scratch_dir, scratch_path};

    #[test]
    fn scratch_dir_creates_the_directory_immediately() {
        let dir = scratch_dir("test-scratch-dir-creates");
        assert!(dir.is_dir());
    }

    #[test]
    fn scratch_path_does_not_create_the_directory() {
        let dir = scratch_path("test-scratch-path-lazy");
        assert!(!dir.exists());
    }

    #[test]
    fn two_calls_with_the_same_prefix_never_collide() {
        let first = scratch_dir("test-scratch-dir-unique");
        let second = scratch_dir("test-scratch-dir-unique");
        assert_ne!(first.path(), second.path());
    }

    #[test]
    fn dropping_a_created_scratch_dir_removes_it() {
        let path = {
            let dir = scratch_dir("test-scratch-dir-drop");
            dir.path().to_path_buf()
        };
        assert!(!path.exists());
    }

    /// Regression: `ScratchDir::new` (and by extension `created`, which
    /// calls it first) must refuse a path that is already there rather than
    /// silently handing it out — that silence is exactly what let a leaked
    /// directory from a killed or aborted prior run masquerade as a fresh
    /// one. `at_suffix` is the only way to force this deterministically: a
    /// real `unique_suffix()` value is designed never to repeat.
    #[test]
    fn new_refuses_a_path_that_already_exists() {
        let prefix = "test-scratch-dir-collision";
        let suffix = 424_242_424_242_424_242_424_242u128;
        let path =
            std::env::temp_dir().join(format!("mango-{prefix}-{}-{suffix}", std::process::id()));
        std::fs::create_dir_all(&path).expect("seed the collision directory");

        let result = std::panic::catch_unwind(|| ScratchDir::at_suffix(prefix, suffix));

        std::fs::remove_dir_all(&path).ok();
        assert!(
            result.is_err(),
            "expected: ScratchDir::new to panic on an already-existing path | found: it \
             returned Ok, silently handing out a path a previous run may have leaked"
        );
    }
}
