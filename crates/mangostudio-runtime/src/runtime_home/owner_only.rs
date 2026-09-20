//! Making one file readable by this account and nobody else.
//!
//! Mirrors `apps/runtime/src/services/owner-only.ts`. POSIX spells that
//! `chmod 0600`. Windows has no mode bits to set — `chmod` there sets the
//! read-only attribute and reports success, which would make a caller
//! trust a file it never actually protected — so the real mechanism there
//! is a DACL rewrite; see [`windows`] for how this crate does it without
//! spawning `icacls.exe`.
//!
//! The answer is a `bool` rather than a `Result`, on both platforms, for
//! the same reason the TypeScript version returns one: the caller has
//! somewhere honest to put a `false` — a warning that this machine's
//! credentials file is readable by other accounts on it — and a hard
//! failure here would take down a write that otherwise succeeded.

use std::path::Path;

#[cfg(unix)]
#[path = "owner_only/unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "owner_only/windows.rs"]
mod platform;

/// Restricts `path` to this account, reporting whether it actually
/// happened.
///
/// # Example
/// ```
/// use mangostudio_runtime::runtime_home::owner_only::restrict_to_owner;
///
/// let path = std::env::temp_dir().join(format!("mango-owner-only-doctest-{}", std::process::id()));
/// std::fs::write(&path, b"example").unwrap();
/// let restricted = restrict_to_owner(&path);
/// # #[cfg(unix)]
/// assert!(restricted);
/// std::fs::remove_file(&path).ok();
/// ```
#[must_use]
pub fn restrict_to_owner(path: &Path) -> bool {
    #[cfg(unix)]
    {
        platform::restrict_to_owner(path)
    }
    #[cfg(windows)]
    {
        platform::restrict_to_owner(path).is_ok()
    }
}
