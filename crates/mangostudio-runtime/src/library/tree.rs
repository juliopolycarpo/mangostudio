//! `library.read-tree`: a whole resource's bytes, for writing it on another
//! machine — `readLibraryTree` from `instance-reader.ts` plus the service's
//! containment and refusal mapping.
//!
//! The walk is the scan's own [`collect_leaf_files`], so the entry-count,
//! total-byte and depth caps that bound a scan bound a transfer too. It is
//! the whole tree or nothing: a partial skill is not a skill. Cancellation
//! is checked before the walk, between every file, and after the last read.
//!
//! One inherited asymmetry is kept on purpose: a directory tree has no
//! per-file 2 MiB cap here (only the 16 MiB total the walk enforces), while
//! a single-file resource does — the TypeScript code enforces exactly that,
//! whatever its doc comment says.

use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use tokio_util::sync::CancellationToken;

use super::fs::{LibraryFs, ReadFailure};
use super::reader::{
    MAX_LIBRARY_FILE_BYTES, MAX_LIBRARY_INSTANCE_BYTES, WalkError, collect_leaf_files,
};
use super::types::{ReadTreeResult, TreeFile};

/// Why a tree read stopped without files.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum TreeError {
    /// Answered as a denied result.
    Denied(String),
    /// Anything the TypeScript service rethrows (`INTERNAL`).
    Failed(String),
    /// The caller cancelled.
    Cancelled,
    /// Consent no longer covers the call; answered as that refusal.
    Refused(mango_protocol::RemoteError),
}

/// `readLibraryTree` with the service's pre-check and error mapping.
/// `root` is the location root this host resolved; `path` is the absolute
/// resource path the hub sent.
///
/// # Example
///
/// ```ignore
/// let tree = read_library_tree(&NativeLibraryFs, "/home/u/.claude/skills/x", "/home/u/.claude/skills", &cancel)?;
/// ```
pub(crate) fn read_library_tree(
    fs: &dyn LibraryFs,
    path: &str,
    root: &str,
    platform: &str,
    cancel: &CancellationToken,
) -> Result<ReadTreeResult, TreeError> {
    check(cancel)?;
    if !is_lexically_within(root, path, platform) {
        return Err(TreeError::Denied(format!(
            "Library path \"{path}\" is outside its registered location."
        )));
    }
    let files =
        walk(fs, Path::new(path), Path::new(root), cancel).map_err(|error| match error {
            WalkError::PathEscape => TreeError::Denied(format!(
                "Library path \"{path}\" resolves outside its registered location."
            )),
            WalkError::TooLarge => TreeError::Denied(format!(
                "Library resource at \"{path}\" exceeds the transfer limits."
            )),
            WalkError::Cancelled => TreeError::Cancelled,
            WalkError::UnsafeName => {
                TreeError::Failed(format!("Library path \"{path}\" has an unsafe name."))
            }
            WalkError::Unreadable(message) => TreeError::Failed(message),
        })?;
    Ok(ReadTreeResult {
        files: files
            .into_iter()
            .map(|(relative_path, bytes)| TreeFile {
                relative_path,
                content_base64: STANDARD.encode(bytes),
            })
            .collect(),
        denied: None,
        reason: None,
    })
}

fn check(cancel: &CancellationToken) -> Result<(), TreeError> {
    if cancel.is_cancelled() {
        return Err(TreeError::Cancelled);
    }
    Ok(())
}

/// `isPathWithin` on the unresolved strings, before any filesystem call:
/// equal, or `root` followed by this platform's separator. Case-insensitive
/// only for a Windows drive path.
fn is_lexically_within(root: &str, candidate: &str, platform: &str) -> bool {
    let separator = if platform == "win32" { '\\' } else { '/' };
    let bytes = root.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\');
    let (root, candidate) = if drive {
        (root.to_lowercase(), candidate.to_lowercase())
    } else {
        (root.to_string(), candidate.to_string())
    };
    candidate == root || candidate.starts_with(&format!("{root}{separator}"))
}

fn walk(
    fs: &dyn LibraryFs,
    path: &Path,
    containment: &Path,
    cancel: &CancellationToken,
) -> Result<Vec<(String, Vec<u8>)>, WalkError> {
    let io = |error: std::io::Error| WalkError::Unreadable(error.to_string());
    let canonical_root = fs.real_path(path).map_err(io)?;
    let canonical_containment = fs.real_path(containment).map_err(io)?;
    if !canonical_root.starts_with(&canonical_containment) {
        return Err(WalkError::PathEscape);
    }
    let metadata = fs.stat(&canonical_root).map_err(io)?;
    if metadata.is_file {
        if metadata.size > MAX_LIBRARY_FILE_BYTES {
            return Err(WalkError::TooLarge);
        }
        let bytes = fs
            .read_file(
                Some(&canonical_containment),
                &canonical_root,
                MAX_LIBRARY_FILE_BYTES,
            )
            .map_err(WalkError::from)?;
        if cancel.is_cancelled() {
            return Err(WalkError::Cancelled);
        }
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        return Ok(vec![(name, bytes)]);
    }
    let leaves = collect_leaf_files(fs, path, cancel)?;
    let mut files = Vec::with_capacity(leaves.len());
    for leaf in leaves {
        if cancel.is_cancelled() {
            return Err(WalkError::Cancelled);
        }
        let canonical = fs.real_path(&leaf.absolute).map_err(io)?;
        if !canonical.starts_with(&canonical_root) {
            return Err(WalkError::PathEscape);
        }
        let bytes = fs
            .read_file(
                Some(&canonical_root),
                &canonical,
                MAX_LIBRARY_INSTANCE_BYTES,
            )
            .map_err(|failure| match failure {
                ReadFailure::TooLarge => WalkError::TooLarge,
                other => WalkError::from(other),
            })?;
        if cancel.is_cancelled() {
            return Err(WalkError::Cancelled);
        }
        files.push((leaf.relative, bytes));
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexical_containment_needs_a_separator_after_the_root() {
        assert!(is_lexically_within("/a/skills", "/a/skills/x", "linux"));
        assert!(is_lexically_within("/a/skills", "/a/skills", "linux"));
        assert!(!is_lexically_within(
            "/a/skills",
            "/a/skills-evil/x",
            "linux"
        ));
        assert!(is_lexically_within(
            "C:\\Users\\U",
            "c:\\users\\u\\x",
            "win32"
        ));
        assert!(!is_lexically_within("/A", "/a/x", "linux"));
    }
}
