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
        if !self.allowed.is_empty()
            && !self
                .allowed
                .iter()
                .any(|root| is_prefix(&root.canonical, &effective))
        {
            return false;
        }
        if self.denied.iter().any(|root| {
            is_prefix(&root.canonical, &effective) || is_prefix(&root.lexical, &absolute)
        }) {
            return false;
        }
        self.containment
            .as_ref()
            .is_none_or(|root| is_prefix(&root.canonical, &effective))
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
    Ok(Root { lexical, canonical })
}

fn is_prefix(root: &Path, path: &Path) -> bool {
    // Keep path identity as OsStr. Lossy display conversion must never grant access.
    #[cfg(windows)]
    return windows::is_prefix(root, path);

    #[cfg(not(windows))]
    path.starts_with(root)
}

#[cfg(windows)]
mod windows {
    #![allow(
        unsafe_code,
        reason = "CompareStringOrdinal is the Windows API for case-insensitive path identity; the single call is documented"
    )]
    #![deny(clippy::undocumented_unsafe_blocks)]

    use std::os::windows::ffi::OsStrExt as _;
    use std::path::Path;

    use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};

    pub(super) fn is_prefix(root: &Path, path: &Path) -> bool {
        let mut candidate = path.components();
        root.components().all(|expected| {
            candidate
                .next()
                .is_some_and(|actual| components_equal(expected.as_os_str(), actual.as_os_str()))
        })
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
