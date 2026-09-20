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

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use super::restrict_to_owner;

    #[test]
    fn restricts_an_existing_file_to_owner_only() {
        let path = std::env::temp_dir().join(format!(
            "mango-owner-only-unix-test-{}-{}",
            std::process::id(),
            line!()
        ));
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
        let path = std::env::temp_dir().join(format!(
            "mango-owner-only-unix-missing-{}-{}",
            std::process::id(),
            line!()
        ));
        assert!(!restrict_to_owner(&path));
    }
}
