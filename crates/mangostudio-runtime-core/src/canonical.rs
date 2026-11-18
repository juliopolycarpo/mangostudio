//! The canonical spelling of an existing directory, shared by `workspace.validate` and the
//! external-agent workspace authorization.

use std::path::{Path, PathBuf};

/// The canonical form of an existing directory: `std::fs::canonicalize`
/// (symlinks resolved, case folded to the on-disk spelling where the
/// filesystem is case-insensitive), with Windows' verbatim prefix removed.
/// `None` when `path` is not an existing directory.
///
/// This is the single canonicalization both `workspace.validate` (whose
/// `resolvedPath` the hub stores as a chat workdir) and the external-agent
/// workspace authorization use, so the hub's exact-equality check compares
/// two strings produced by the same function.
///
/// ```
/// use mangostudio_runtime_core::canonical::canonical_directory;
///
/// let canonical = canonical_directory(&std::env::temp_dir());
/// assert!(canonical.is_some_and(|path| path.is_absolute()));
/// assert!(canonical_directory(&std::env::temp_dir().join("absent-canonical-doctest")).is_none());
/// ```
#[must_use]
pub fn canonical_directory(path: &Path) -> Option<PathBuf> {
    if !std::fs::metadata(path).ok()?.is_dir() {
        return None;
    }
    let canonical = std::fs::canonicalize(path).ok()?;
    #[cfg(windows)]
    let canonical = normalize_windows_final_path(&canonical);
    Some(canonical)
}

/// Normalizes final and canonical Windows paths to the same Win32 spelling: a verbatim drive
/// path loses its `\\?\` prefix and a verbatim UNC path becomes `\\server\share`.
///
/// Works on UTF-16 code units, so an unpaired surrogate in a path survives untouched.
#[cfg(windows)]
#[must_use]
pub fn normalize_windows_final_path(path: &Path) -> PathBuf {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};

    const VERBATIM: &[u16] = &[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    const UNC: &[u16] = &[b'U' as u16, b'N' as u16, b'C' as u16, b'\\' as u16];
    let path: Vec<u16> = path.as_os_str().encode_wide().collect();
    let Some(rest) = path.strip_prefix(VERBATIM) else {
        return PathBuf::from(OsString::from_wide(&path));
    };
    if let Some(unc) = rest.strip_prefix(UNC) {
        let mut normal = vec![b'\\' as u16, b'\\' as u16];
        normal.extend_from_slice(unc);
        return PathBuf::from(OsString::from_wide(&normal));
    }
    PathBuf::from(OsString::from_wide(rest))
}

#[cfg(test)]
mod tests {
    use super::canonical_directory;
    use crate::test_support::scratch_dir;

    #[test]
    fn a_file_and_a_missing_path_have_no_canonical_directory() {
        let dir = scratch_dir("canonical-directory-refuses");
        let file = dir.join("file.txt");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(
            canonical_directory(&file),
            None,
            "(canonical_directory): expected None for a regular file | received: {:?}",
            canonical_directory(&file)
        );
        assert_eq!(canonical_directory(&dir.join("absent")), None);
    }

    #[cfg(windows)]
    #[test]
    fn verbatim_handle_and_canonical_paths_normalize_to_win32_spelling() {
        use std::path::{Path, PathBuf};

        assert_eq!(
            super::normalize_windows_final_path(Path::new(r"\\?\C:\workspace\root")),
            PathBuf::from(r"C:\workspace\root")
        );
        assert_eq!(
            super::normalize_windows_final_path(Path::new(r"\\?\UNC\server\share\root")),
            PathBuf::from(r"\\server\share\root")
        );
    }
}
