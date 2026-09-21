//! Wire path policies evaluated by the host that owns the filesystem.

use std::path::{Path, PathBuf};

use mango_protocol::error::{RemoteError, codes};
use serde::Deserialize;

use crate::workspace::{lexically_normalize, resolve_through_existing_ancestor};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PathPolicy {
    pub allowed_roots: Vec<PathBuf>,
    pub denied_roots: Vec<PathBuf>,
    pub containment_root: Option<PathBuf>,
}

struct Root {
    lexical: PathBuf,
    canonical: PathBuf,
}

pub(super) struct CompiledPolicy {
    allowed: Vec<Root>,
    denied: Vec<Root>,
    containment: Option<Root>,
}

impl PathPolicy {
    /// Resolves configured roots once per operation; mutation callers recompile under locks.
    pub fn compile(&self) -> Result<CompiledPolicy, RemoteError> {
        Ok(CompiledPolicy {
            allowed: self
                .allowed_roots
                .iter()
                .map(|path| compile_root(path))
                .collect::<Result<_, _>>()?,
            denied: self
                .denied_roots
                .iter()
                .map(|path| compile_root(path))
                .collect::<Result<_, _>>()?,
            containment: self
                .containment_root
                .as_deref()
                .map(compile_root)
                .transpose()?,
        })
    }
}

impl CompiledPolicy {
    pub fn check(&self, path: &Path) -> Result<(), RemoteError> {
        if self.allows(path) {
            return Ok(());
        }
        Err(RemoteError::new(
            codes::INTERNAL,
            format!(
                "Path \"{}\" resolves outside the paths this chat may access on this environment.",
                path.display()
            ),
        )
        .with_detail("kind", "path_access"))
    }

    pub fn allows(&self, path: &Path) -> bool {
        if self.allowed.is_empty() && self.denied.is_empty() && self.containment.is_none() {
            return true;
        }
        let Ok(absolute) = absolute(path) else {
            return false;
        };
        let Some(effective) = resolve_through_existing_ancestor(&absolute) else {
            return false;
        };
        #[cfg(windows)]
        let effective = normalize_windows_final_path(&effective);
        if !self.allowed.is_empty()
            && !self
                .allowed
                .iter()
                .any(|root| prefix_relation(&root.canonical, &effective) == Some(true))
        {
            return false;
        }
        if self.denied.iter().any(|root| {
            denied_prefix_relation(prefix_relation(&root.canonical, &effective))
                || denied_prefix_relation(prefix_relation(&root.lexical, &absolute))
        }) {
            return false;
        }
        self.containment
            .as_ref()
            .is_none_or(|root| prefix_relation(&root.canonical, &effective) == Some(true))
    }

    /// Checks a final, absolute path obtained from an already-open filesystem
    /// object. Callers must first check the requested path with [`Self::check`]
    /// so lexical deny rules still apply.
    ///
    /// # Example
    ///
    /// ```ignore
    /// policy.check(requested)?;
    /// let file = open_once(requested)?;
    /// policy.check_final_handle_path(requested, &path_from_file_handle(&file)?)?;
    /// ```
    pub(super) fn check_final_handle_path(
        &self,
        requested: &Path,
        final_path: &Path,
    ) -> Result<(), RemoteError> {
        if self.allows_final_handle_path(final_path) {
            return Ok(());
        }
        Err(RemoteError::new(
            codes::INTERNAL,
            format!(
                "Path \"{}\" resolves outside the paths this chat may access on this environment.",
                requested.display()
            ),
        )
        .with_detail("kind", "path_access"))
    }

    pub(super) fn is_unrestricted(&self) -> bool {
        self.allowed.is_empty() && self.denied.is_empty() && self.containment.is_none()
    }

    fn allows_final_handle_path(&self, path: &Path) -> bool {
        if self.is_unrestricted() {
            return true;
        }
        if !path.is_absolute() {
            return false;
        }
        if !self.allowed.is_empty()
            && !self
                .allowed
                .iter()
                .any(|root| prefix_relation(&root.canonical, path) == Some(true))
        {
            return false;
        }
        if self
            .denied
            .iter()
            .any(|root| denied_prefix_relation(prefix_relation(&root.canonical, path)))
        {
            return false;
        }
        self.containment
            .as_ref()
            .is_none_or(|root| prefix_relation(&root.canonical, path) == Some(true))
    }
}

fn absolute(path: &Path) -> Result<PathBuf, RemoteError> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(path))
        .map_err(|error| RemoteError::new(codes::INTERNAL, error.to_string()))
}

fn compile_root(path: &Path) -> Result<Root, RemoteError> {
    let lexical = lexically_normalize(&absolute(path)?);
    let canonical = resolve_through_existing_ancestor(&lexical).unwrap_or_else(|| lexical.clone());
    #[cfg(windows)]
    let canonical = normalize_windows_final_path(&canonical);
    Ok(Root { lexical, canonical })
}

/// Normalizes final and canonical Windows paths to the same Win32 spelling.
#[cfg(windows)]
pub(super) fn normalize_windows_final_path(path: &Path) -> PathBuf {
    windows::normalize_final_path(path)
}

pub(super) fn is_prefix(root: &Path, path: &Path) -> bool {
    prefix_relation(root, path) == Some(true)
}

fn denied_prefix_relation(relation: Option<bool>) -> bool {
    relation != Some(false)
}

fn prefix_relation(root: &Path, path: &Path) -> Option<bool> {
    // Keep path identity as OsStr. Lossy display conversion must never grant access.
    #[cfg(windows)]
    return windows::prefix_relation(root, path);

    #[cfg(not(windows))]
    Some(path.starts_with(root))
}

#[cfg(windows)]
mod windows {
    #![allow(
        unsafe_code,
        reason = "Windows path identity requires documented handle metadata and ordinal comparison APIs"
    )]
    #![deny(clippy::undocumented_unsafe_blocks)]

    use std::ffi::{OsString, c_void};
    use std::mem::{MaybeUninit, size_of};
    use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};
    use std::path::{Component, Path, PathBuf};

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_CASE_SENSITIVE_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FileCaseSensitiveInfo,
        GetFileInformationByHandleEx, OPEN_EXISTING,
    };
    #[cfg(test)]
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_WRITE_ATTRIBUTES, SetFileInformationByHandle,
    };

    const FILE_CS_FLAG_CASE_SENSITIVE_DIR: u32 = 1;

    #[derive(Debug, PartialEq, Eq)]
    pub(super) enum MetadataRelation {
        Directory,
        Missing,
        NotDirectory,
        Indeterminate,
    }

    pub(super) fn normalize_final_path(path: &Path) -> PathBuf {
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

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: this wrapper is constructed only from a live, owned handle.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    pub(super) fn prefix_relation(root: &Path, path: &Path) -> Option<bool> {
        let mut candidate = path.components();
        let mut parent = PathBuf::new();
        let mut inherited_case_sensitive = None;
        for expected in root.components() {
            let Some(actual) = candidate.next() else {
                return Some(false);
            };
            let equal = match (expected, actual) {
                (Component::Normal(_), Component::Normal(_)) => {
                    match metadata_relation(std::fs::metadata(&parent)) {
                        MetadataRelation::Directory => {
                            let Some(case_sensitive) = directory_is_case_sensitive(&parent) else {
                                return None;
                            };
                            inherited_case_sensitive = Some(case_sensitive);
                        }
                        MetadataRelation::Missing => {}
                        MetadataRelation::NotDirectory => return Some(false),
                        MetadataRelation::Indeterminate => return None,
                    }
                    inherited_case_sensitive.is_some_and(|case_sensitive| {
                        if case_sensitive {
                            expected.as_os_str() == actual.as_os_str()
                        } else {
                            components_equal(expected.as_os_str(), actual.as_os_str())
                        }
                    })
                }
                (Component::Prefix(_), Component::Prefix(_))
                | (Component::RootDir, Component::RootDir) => {
                    components_equal(expected.as_os_str(), actual.as_os_str())
                }
                _ => false,
            };
            if !equal {
                return Some(false);
            }
            parent.push(actual.as_os_str());
        }
        Some(true)
    }

    pub(super) fn metadata_relation(
        result: std::io::Result<std::fs::Metadata>,
    ) -> MetadataRelation {
        match result {
            Ok(metadata) if metadata.is_dir() => MetadataRelation::Directory,
            Ok(_) => MetadataRelation::NotDirectory,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                MetadataRelation::Missing
            }
            Err(_) => MetadataRelation::Indeterminate,
        }
    }

    fn directory_is_case_sensitive(path: &Path) -> Option<bool> {
        let handle = open_directory(path, FILE_READ_ATTRIBUTES)?;
        let mut info = MaybeUninit::<FILE_CASE_SENSITIVE_INFO>::uninit();
        // SAFETY: `info` points to writable storage of exactly the size passed,
        // and `handle` remains live until after the call.
        let succeeded = unsafe {
            GetFileInformationByHandleEx(
                handle.0,
                FileCaseSensitiveInfo,
                info.as_mut_ptr().cast::<c_void>(),
                size_of::<FILE_CASE_SENSITIVE_INFO>() as u32,
            )
        };
        if succeeded == 0 {
            return None;
        }
        // SAFETY: a successful call initialized the complete fixed-size structure.
        let info = unsafe { info.assume_init() };
        Some(info.Flags & FILE_CS_FLAG_CASE_SENSITIVE_DIR != 0)
    }

    fn open_directory(path: &Path, access: u32) -> Option<OwnedHandle> {
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        if wide.contains(&0) {
            return None;
        }
        wide.push(0);
        // SAFETY: `wide` is NUL-terminated and remains alive for the call; null
        // security/template handles request the documented defaults.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return None;
        }
        Some(OwnedHandle(handle))
    }

    #[cfg(test)]
    pub(super) fn enable_case_sensitivity(path: &Path) -> std::io::Result<()> {
        let handle = open_directory(path, FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES)
            .ok_or_else(std::io::Error::last_os_error)?;
        let info = FILE_CASE_SENSITIVE_INFO {
            Flags: FILE_CS_FLAG_CASE_SENSITIVE_DIR,
        };
        // SAFETY: `info` is a fully initialized fixed-size structure and the
        // owned directory handle stays live for the call.
        let succeeded = unsafe {
            SetFileInformationByHandle(
                handle.0,
                FileCaseSensitiveInfo,
                std::ptr::from_ref(&info).cast::<c_void>(),
                size_of::<FILE_CASE_SENSITIVE_INFO>() as u32,
            )
        };
        if succeeded == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    fn components_equal(left: &std::ffi::OsStr, right: &std::ffi::OsStr) -> bool {
        if left == right {
            return true;
        }
        let left: Vec<u16> = left.encode_wide().collect();
        let right: Vec<u16> = right.encode_wide().collect();
        let Ok(left_len) = i32::try_from(left.len()) else {
            return false;
        };
        let Ok(right_len) = i32::try_from(right.len()) else {
            return false;
        };
        // SAFETY: both pointers remain readable for the explicit checked lengths.
        unsafe {
            CompareStringOrdinal(left.as_ptr(), left_len, right.as_ptr(), right_len, 1)
                == CSTR_EQUAL
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::scratch_dir;

    #[test]
    fn an_indeterminate_prefix_relation_fails_closed_for_denied_roots() {
        assert!(denied_prefix_relation(None));
        assert!(denied_prefix_relation(Some(true)));
        assert!(!denied_prefix_relation(Some(false)));
    }

    #[test]
    fn containment_accepts_missing_children_but_not_sibling_prefixes() {
        let dir = scratch_dir("filesystem-policy");
        let root = dir.join("root");
        std::fs::create_dir_all(&root).unwrap();
        let policy = PathPolicy {
            containment_root: Some(root.clone()),
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();
        assert!(policy.check(&root.join("missing/file")).is_ok());
        assert!(policy.check(&dir.join("root-other/file")).is_err());
        assert!(!policy.allows(&root.join("missing/../../outside")));
    }

    #[test]
    fn allow_and_deny_both_apply_with_component_boundaries() {
        let dir = scratch_dir("filesystem-policy-deny");
        let policy = PathPolicy {
            allowed_roots: vec![dir.to_path_buf()],
            denied_roots: vec![dir.join("private")],
            containment_root: None,
        }
        .compile()
        .unwrap();
        assert!(!policy.allows(&dir.join("private/secret")));
        assert!(policy.allows(&dir.join("private-copy/file")));
        assert!(!policy.allows(&dir.join("../elsewhere")));
        assert!(
            PathPolicy::default()
                .compile()
                .unwrap()
                .allows(Path::new("any/path"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn rechecks_symlink_swaps_and_refuses_cycles() {
        use std::os::unix::fs::symlink;
        let dir = scratch_dir("filesystem-policy-swap");
        let root = dir.join("root");
        std::fs::create_dir_all(root.join("safe")).unwrap();
        let link = root.join("link");
        symlink(root.join("safe"), &link).unwrap();
        let policy = PathPolicy {
            containment_root: Some(root.clone()),
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();
        assert!(policy.allows(&link.join("file")));
        std::fs::remove_file(&link).unwrap();
        symlink(&dir, &link).unwrap();
        assert!(!policy.allows(&link.join("file")));
        assert!(!policy.allows(&link.join("../outside")));
        symlink("cycle", root.join("cycle")).unwrap();
        assert!(!policy.allows(&root.join("cycle/file")));
    }

    // macOS filesystems reject these deliberately invalid UTF-8 names before
    // the path policy can observe them. Linux exercises the byte-path case.
    #[cfg(target_os = "linux")]
    #[test]
    fn lossy_display_aliases_never_share_path_authority() {
        use std::os::unix::ffi::OsStringExt;
        let dir = scratch_dir("filesystem-nonutf8-policy");
        let allowed = dir.join(std::ffi::OsString::from_vec(vec![0xff]));
        let refused = dir.join(std::ffi::OsString::from_vec(vec![0xfe]));
        std::fs::create_dir(&allowed).unwrap();
        std::fs::create_dir(&refused).unwrap();
        assert_eq!(allowed.to_string_lossy(), refused.to_string_lossy());
        let policy = PathPolicy {
            allowed_roots: vec![allowed.clone()],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();
        assert!(policy.allows(&allowed.join("file")));
        assert!(!policy.allows(&refused.join("file")));
    }

    #[cfg(windows)]
    #[test]
    fn normalizes_verbatim_handle_and_canonical_paths_to_win32_spelling() {
        assert_eq!(
            normalize_windows_final_path(Path::new(r"\\?\C:\workspace\root")),
            PathBuf::from(r"C:\workspace\root")
        );
        assert_eq!(
            normalize_windows_final_path(Path::new(r"\\?\UNC\server\share\root")),
            PathBuf::from(r"\\server\share\root")
        );
    }

    #[cfg(windows)]
    #[test]
    fn normalized_canonical_roots_authorize_existing_children() {
        let dir = scratch_dir("filesystem-windows-canonical-policy");
        let root = dir.join("root");
        let child = root.join("existing.txt");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(&child, "contents").unwrap();
        let policy = PathPolicy {
            allowed_roots: vec![root],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();

        assert!(policy.allows(&child));
    }

    #[cfg(windows)]
    #[test]
    fn windows_metadata_errors_are_indeterminate_for_denied_roots() {
        let relation = windows::metadata_relation(Err(std::io::Error::from(
            std::io::ErrorKind::PermissionDenied,
        )));

        assert_eq!(relation, windows::MetadataRelation::Indeterminate);
        assert!(denied_prefix_relation(None));
    }

    #[cfg(windows)]
    #[test]
    fn compares_missing_path_components_with_windows_identity() {
        use std::os::windows::ffi::OsStringExt as _;

        let dir = scratch_dir("filesystem-windows-case-policy");
        let root = dir.join("Root");
        std::fs::create_dir(&root).unwrap();
        let policy = PathPolicy {
            allowed_roots: vec![dir.join("ROOT")],
            denied_roots: vec![dir.join("root/PrIvAtE")],
            containment_root: Some(dir.join("root")),
        }
        .compile()
        .unwrap();
        assert!(policy.allows(&dir.join("rOoT/public/missing")));
        assert!(!policy.allows(&dir.join("ROOT/pRiVaTe/missing")));

        let first = dir.join(std::ffi::OsString::from_wide(&[0xd800]));
        let second = dir.join(std::ffi::OsString::from_wide(&[0xd801]));
        let policy = PathPolicy {
            allowed_roots: vec![first.clone()],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();
        assert!(policy.allows(&first.join("file")));
        assert!(!policy.allows(&second.join("file")));
    }

    #[cfg(windows)]
    #[test]
    fn preserves_case_sensitive_directory_identity_for_existing_and_missing_paths() {
        let dir = scratch_dir("filesystem-windows-sensitive-policy");
        let sensitive = dir.join("sensitive");
        std::fs::create_dir(&sensitive).unwrap();
        windows::enable_case_sensitivity(&sensitive)
            .expect("the Windows test volume supports per-directory case sensitivity");
        let root = sensitive.join("Root");
        std::fs::create_dir(&root).unwrap();
        let policy = PathPolicy {
            allowed_roots: vec![root.clone()],
            containment_root: Some(root.clone()),
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();

        assert!(policy.allows(&root.join("missing/deeper/file")));
        assert!(!policy.allows(&sensitive.join("root/missing/deeper/file")));
    }

    #[cfg(windows)]
    #[test]
    fn junction_swaps_cannot_move_a_contained_write_outside_its_root() {
        let dir = scratch_dir("filesystem-junction-policy");
        let root = dir.join("root");
        let safe = root.join("safe");
        let outside = dir.join("outside");
        let link = root.join("link");
        std::fs::create_dir_all(&safe).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let script = dir.join("junction.ps1");
        std::fs::write(&script, "param([string]$LinkPath, [string]$TargetPath)\nNew-Item -ItemType Junction -Path $LinkPath -Target $TargetPath -ErrorAction Stop | Out-Null\n").unwrap();
        create_test_junction(&script, &link, &safe);
        let policy = PathPolicy {
            containment_root: Some(root),
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();
        assert!(policy.allows(&link.join("file")));
        std::fs::remove_dir(&link).unwrap();
        create_test_junction(&script, &link, &outside);
        assert!(!policy.allows(&link.join("file")));
        std::fs::remove_dir(&link).unwrap();
    }

    #[cfg(windows)]
    fn create_test_junction(script: &Path, link: &Path, target: &Path) {
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(script)
            .arg("-LinkPath")
            .arg(link)
            .arg("-TargetPath")
            .arg(target)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
