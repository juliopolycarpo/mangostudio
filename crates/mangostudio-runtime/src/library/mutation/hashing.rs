//! `hashResourceAt`: the digest a mutation verifies a write against and
//! undo compares a destination with — the same hash domains a scan
//! reports, computed straight from disk.
//!
//! Deliberately not the scan path. The scan memoizes by size and mtime, and
//! a rewrite inside the mtime granularity would hand back the previous
//! digest — masking a verification failure, or faking a
//! `changed-since-apply`. Nor does it apply the scan's per-leaf and
//! `SKILL.md` caps, which `hashResourceAt` never had: a file hashes whatever
//! its size (streamed, so its size never becomes memory), and a directory is
//! bounded only by the leaf walk's entry, byte and depth limits.

use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::super::fs::{LibraryFs, NativeLibraryFs, ReadFailure, join_relative};
use super::super::hash::{
    DirectoryManifest, ManifestViolation, hash_file_bytes, relative_path_violation,
};
use super::super::reader::{MAX_LIBRARY_INSTANCE_BYTES, WalkError, collect_leaf_files};
use super::paths::ResourceKind;

const FILE_HASH_DOMAIN: &[u8] = b"mangostudio/library/file\0";

/// Why `hashResourceAt` produced no digest. The split matters on the wire:
/// [`HashError::Invalid`] is `LibraryHashInvalidError` (a
/// `verification-failed` apply row), everything else is a plain failure (a
/// `write-failed` row), exactly as the TypeScript engine classifies them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HashError {
    /// `hashLibraryDirectory` refused a manifest name: `path-escape` or
    /// `unsafe-name`.
    Invalid(&'static str),
    /// The leaf walk left the tree (`PathEscapeError`).
    Escape,
    /// The leaf walk hit a cap (`InstanceTooLargeError`).
    TooLarge,
    /// Anything else, with its description.
    Io(String),
}

impl std::fmt::Display for HashError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(reason) => write!(formatter, "Library directory hash invalid: {reason}"),
            Self::Escape => formatter.write_str("Library resource resolves outside its root."),
            Self::TooLarge => formatter.write_str("Library resource exceeds the hashing limits."),
            Self::Io(message) => formatter.write_str(message),
        }
    }
}

/// `hashResourceAt(path, kind)`.
///
/// # Example
///
/// ```ignore
/// let digest = hash_resource_at("/home/u/.claude/skills/gh", ResourceKind::Directory, "linux")?;
/// ```
pub(crate) fn hash_resource_at(
    path: &str,
    kind: ResourceKind,
    platform: &str,
) -> Result<String, HashError> {
    match kind {
        ResourceKind::File => hash_file_streamed(Path::new(path)),
        ResourceKind::Directory => hash_directory(Path::new(path), platform),
    }
}

fn hash_file_streamed(path: &Path) -> Result<String, HashError> {
    let io = |error: std::io::Error| HashError::Io(format!("{}: {error}", path.display()));
    let mut file = std::fs::File::open(path).map_err(io)?;
    let mut hasher = Sha256::new();
    hasher.update(FILE_HASH_DOMAIN);
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(io)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn hash_directory(root: &Path, platform: &str) -> Result<String, HashError> {
    let fs = NativeLibraryFs;
    // A mutation's verification is one bounded step of the owner that is
    // already running; it is never abandoned half way, so nothing cancels it.
    let leaves = collect_leaf_files(&fs, root, &CancellationToken::new()).map_err(walk_error)?;
    let io = |error: std::io::Error| HashError::Io(error.to_string());
    let canonical_root = fs.real_path(root).map_err(io)?;
    let win32 = platform == "win32";
    let mut manifest = DirectoryManifest::default();
    for leaf in &leaves {
        match relative_path_violation(&leaf.relative, win32) {
            Some(ManifestViolation::PathEscape) => return Err(HashError::Invalid("path-escape")),
            Some(ManifestViolation::UnsafeName) => return Err(HashError::Invalid("unsafe-name")),
            None => {}
        }
        let canonical = fs
            .real_path(&join_relative(&canonical_root, &leaf.relative))
            .map_err(io)?;
        if !canonical.starts_with(&canonical_root) {
            return Err(HashError::Invalid("path-escape"));
        }
        let bytes = fs
            .read_file(
                Some(&canonical_root),
                &canonical,
                MAX_LIBRARY_INSTANCE_BYTES,
            )
            .map_err(|failure| match failure {
                ReadFailure::Outside => HashError::Invalid("path-escape"),
                ReadFailure::TooLarge => HashError::TooLarge,
                ReadFailure::Unreadable(message) => HashError::Io(message),
            })?;
        manifest.push(&leaf.relative, hash_file_bytes(&bytes), bytes.len() as u64);
    }
    Ok(manifest.finish().0)
}

fn walk_error(error: WalkError) -> HashError {
    match error {
        WalkError::PathEscape => HashError::Escape,
        WalkError::TooLarge => HashError::TooLarge,
        WalkError::UnsafeName => HashError::Invalid("unsafe-name"),
        WalkError::Unreadable(message) => HashError::Io(message),
        WalkError::Cancelled => HashError::Io("The hash was cancelled.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_streamed_file_hash_matches_the_scan_digest() {
        let scratch = crate::test_support::scratch_dir("library-hash-file");
        let file = scratch.join("a.md");
        let bytes: Vec<u8> = (0..200_000u32).map(|index| (index % 251) as u8).collect();
        std::fs::write(&file, &bytes).unwrap();
        assert_eq!(
            hash_resource_at(&file.to_string_lossy(), ResourceKind::File, "linux").unwrap(),
            hash_file_bytes(&bytes),
            "expected the streamed digest to equal the one-shot digest"
        );
    }

    #[test]
    fn a_directory_hash_is_the_v2_manifest_over_every_leaf() {
        let scratch = crate::test_support::scratch_dir("library-hash-dir");
        std::fs::create_dir_all(scratch.join("refs")).unwrap();
        std::fs::write(scratch.join("SKILL.md"), "skill").unwrap();
        std::fs::write(scratch.join("refs").join("b.md"), "b").unwrap();
        let mut expected = DirectoryManifest::default();
        expected.push("SKILL.md", hash_file_bytes(b"skill"), 5);
        expected.push("refs/b.md", hash_file_bytes(b"b"), 1);
        assert_eq!(
            hash_resource_at(
                &scratch.to_string_lossy(),
                ResourceKind::Directory,
                crate::health::node_platform()
            )
            .unwrap(),
            expected.finish().0
        );
    }

    /// `hash-resource-at.test.ts` "fails post-write hashing of a newline
    /// filename with unsafe-name, not a path escape".
    #[cfg(unix)]
    #[test]
    fn a_newline_filename_is_unsafe_name_not_an_escape() {
        let scratch = crate::test_support::scratch_dir("library-hash-newline");
        std::fs::write(scratch.join("a\nb"), "x").unwrap();
        assert_eq!(
            hash_resource_at(&scratch.to_string_lossy(), ResourceKind::Directory, "linux"),
            Err(HashError::Invalid("unsafe-name"))
        );
    }

    /// `hash-resource-at.test.ts` "still throws PathEscapeError when a
    /// directory symlink leaves the tree".
    #[cfg(unix)]
    #[test]
    fn a_directory_symlink_leaving_the_tree_is_a_walk_escape() {
        let scratch = crate::test_support::scratch_dir("library-hash-escape");
        let root = scratch.join("root");
        let outside = scratch.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("x.md"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        assert_eq!(
            hash_resource_at(&root.to_string_lossy(), ResourceKind::Directory, "linux"),
            Err(HashError::Escape)
        );
    }

    /// Backslashes are separators only on win32, as `pathStyle` decides:
    /// on POSIX a name like `x\..\y` is an ordinary file that hashes.
    #[cfg(unix)]
    #[test]
    fn a_backslash_name_is_an_ordinary_file_off_windows() {
        let scratch = crate::test_support::scratch_dir("library-hash-backslash");
        std::fs::write(scratch.join("x\\..\\y"), "x").unwrap();
        let hashed = hash_resource_at(&scratch.to_string_lossy(), ResourceKind::Directory, "linux");
        assert!(
            hashed.is_ok(),
            "expected a POSIX backslash name to hash | received {hashed:?}"
        );
    }

    #[test]
    fn hash_errors_describe_themselves() {
        assert_eq!(
            HashError::Invalid("unsafe-name").to_string(),
            "Library directory hash invalid: unsafe-name"
        );
        assert_eq!(HashError::Io("EIO".into()).to_string(), "EIO");
        assert!(HashError::Escape.to_string().contains("outside its root"));
        assert!(HashError::TooLarge.to_string().contains("hashing limits"));
    }

    #[test]
    fn a_missing_resource_is_an_io_failure() {
        let scratch = crate::test_support::scratch_dir("library-hash-missing");
        let missing = scratch.join("absent");
        assert!(matches!(
            hash_resource_at(&missing.to_string_lossy(), ResourceKind::File, "linux"),
            Err(HashError::Io(_))
        ));
    }
}
