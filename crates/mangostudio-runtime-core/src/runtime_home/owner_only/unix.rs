//! Restricting a file to its owner on Unix: `chmod 0600`.
//!
//! Mirrors the non-Windows branch of `restrictToOwner` in
//! `apps/runtime/src/services/owner-only.ts`.

use std::path::Path;

/// Sets `0o600` on `path`, reporting `false` rather than an error when it
/// could not — the caller has somewhere honest to put a `false` (a warning
/// that this machine's credentials file is readable by other accounts), and
/// `writeCredentials` on the TypeScript side treats a failed `chmod` the
/// same way.
pub(super) fn restrict_to_owner(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).is_ok()
}

/// Whether `path` grants nothing to its group or to others.
///
/// # Errors
/// The `io::Error` from reading `path`'s metadata, a missing file included.
pub(super) fn is_owner_only(path: &Path) -> std::io::Result<bool> {
    use std::os::unix::fs::PermissionsExt as _;
    Ok(std::fs::metadata(path)?.permissions().mode() & 0o077 == 0)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use super::{is_owner_only, restrict_to_owner};
    use crate::test_support::scratch_path;

    #[test]
    fn a_group_or_world_accessible_file_is_not_owner_only() {
        let path = scratch_path("owner-only-unix-loose");
        std::fs::write(&path, b"secret").unwrap();
        let mut verdicts = Vec::new();
        for mode in [0o600, 0o640, 0o604, 0o644, 0o700] {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
            verdicts.push((mode, is_owner_only(&path).unwrap()));
        }
        std::fs::remove_file(&path).ok();

        assert_eq!(
            verdicts,
            vec![
                (0o600, true),
                (0o640, false),
                (0o604, false),
                (0o644, false),
                (0o700, true)
            ],
            "expected only modes with no group or other bits to be owner-only"
        );
    }

    #[test]
    fn a_missing_file_is_an_error_not_an_answer() {
        let path = scratch_path("owner-only-unix-check-missing");
        let error = is_owner_only(&path).expect_err("expected an error for a missing file");
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn restricts_an_existing_file_to_owner_only() {
        let path = scratch_path("owner-only-unix-test");
        std::fs::write(&path, b"secret").unwrap();
        // Starts world-readable, which is exactly the loosely-permissioned
        // stale file this call has to tighten.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        assert!(restrict_to_owner(&path));
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn reports_false_rather_than_erroring_for_a_missing_file() {
        let path = scratch_path("owner-only-unix-missing");
        assert!(!restrict_to_owner(&path));
    }
}
