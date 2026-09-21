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
//! of those copies with one, built on a process-wide atomic counter instead.
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

/// A directory under [`std::env::temp_dir`], unique for the lifetime of the
/// current process, removed recursively when this value is dropped.
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
    pub fn new(prefix: &str) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("mango-{prefix}-{}-{unique}", std::process::id()));
        Self(path)
    }

    /// Allocates a unique path under `prefix` and creates it (and any
    /// missing parents) immediately.
    ///
    /// # Panics
    /// If the directory cannot be created.
    pub fn created(prefix: &str) -> Self {
        let dir = Self::new(prefix);
        std::fs::create_dir_all(&dir.0).expect("scratch dir creation");
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
    use super::{scratch_dir, scratch_path};

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
}
