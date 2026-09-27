//! `library.read`: one file's text for the detail view, contained to a
//! location root this runtime resolves itself — a port of
//! `apps/shared/src/library/machine/read.ts`.
//!
//! The hub names *which* location; the root comes from this host's
//! [`PathEnv`], never from the request. A `single-file` location is checked
//! against the agent home around it, because a file cannot contain anything
//! and a symlinked `CLAUDE.md` checked against itself would admit whatever
//! it points at.

use std::io::Read;
use std::path::Path;

use super::fs::canonicalize;
use super::js::text_decoder_decode;
use super::types::ReadResult;
use crate::filesystem::{ContainedOpenError, open_contained_file};
use crate::probing::detection::path_env::{PathEnv, dirname_path};
use crate::probing::locations::{LocationLayout, location_by_id};

/// `MAX_LIBRARY_CONTENT_BYTES`: the detail-view ceiling, and the cap on any
/// caller-supplied `maxBytes`.
pub(crate) const MAX_LIBRARY_CONTENT_BYTES: u64 = 512 * 1024;

/// `libraryLocationRoot`: the directory a read for `location_id` may not
/// leave, or `None` when the location cannot exist on this host.
///
/// # Example
///
/// ```ignore
/// // A single-file location is bounded by the directory around it.
/// assert_eq!(library_location_root("claude-instructions", &env).as_deref(), Some("/home/u/.claude"));
/// ```
#[must_use]
pub(crate) fn library_location_root(location_id: &str, env: &PathEnv) -> Option<String> {
    let location = location_by_id(location_id)?;
    let path = (location.resolve_path)(env)?;
    Some(if location.layout == LocationLayout::SingleFile {
        dirname_path(&env.platform, &path)
    } else {
        path
    })
}

/// A caller mistake the TypeScript host throws as `RuntimeToolArgumentError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReadArgumentError(pub String);

/// `readLibraryContent`, answering a refusal as a denied result rather than
/// an error (the service's `LibraryReadDeniedError` catch), and a malformed
/// argument as [`ReadArgumentError`].
///
/// The read opens the canonical path once through the filesystem
/// primitive's contained open, so a symlink swapped after the containment
/// check below is still refused rather than followed.
///
/// # Example
///
/// ```ignore
/// let result = read_library_content("/home/u/.claude/CLAUDE.md", "/home/u/.claude", None, false)?;
/// ```
pub(crate) fn read_library_content(
    path: &str,
    root: &str,
    max_bytes: Option<f64>,
    truncate_oversize: bool,
) -> Result<ReadResult, ReadArgumentError> {
    if path.is_empty() {
        return Err(ReadArgumentError(
            "library.read requires a non-empty path.".into(),
        ));
    }
    if root.is_empty() {
        return Err(ReadArgumentError(
            "library.read requires a location root.".into(),
        ));
    }
    let max_bytes = max_bytes.unwrap_or(MAX_LIBRARY_CONTENT_BYTES as f64);
    if !is_positive_safe_integer(max_bytes) {
        return Err(ReadArgumentError(
            "library.read requires a positive integer maxBytes.".into(),
        ));
    }
    let capped = (max_bytes as u64).min(MAX_LIBRARY_CONTENT_BYTES);
    let outside = || {
        ReadResult::denied(format!(
            "Library path \"{path}\" is outside its registered location."
        ))
    };
    let unreadable = || ReadResult::denied(format!("Library path \"{path}\" is not readable."));

    let Ok(canonical_path) = canonicalize(Path::new(path)) else {
        return Ok(unreadable());
    };
    let Ok(canonical_root) = canonicalize(Path::new(root)) else {
        return Ok(outside());
    };
    if !canonical_path.starts_with(&canonical_root) {
        return Ok(outside());
    }
    let display_name = Path::new(path).file_name().map_or_else(
        || path.to_string(),
        |name| name.to_string_lossy().into_owned(),
    );
    Ok(read_bounded(
        &canonical_root,
        &canonical_path,
        capped,
        truncate_oversize,
        &display_name,
    )
    .unwrap_or_else(|denial| match denial {
        Denial::Outside => outside(),
        Denial::Unreadable => unreadable(),
        Denial::Reason(reason) => ReadResult::denied(reason),
    }))
}

#[derive(Debug)]
enum Denial {
    Outside,
    Unreadable,
    Reason(String),
}

fn read_bounded(
    root: &Path,
    canonical: &Path,
    max_bytes: u64,
    truncate: bool,
    display_name: &str,
) -> Result<ReadResult, Denial> {
    let file = open_contained_file(root, canonical).map_err(|error| match error {
        ContainedOpenError::Outside => Denial::Outside,
        ContainedOpenError::Unopenable(_) => Denial::Unreadable,
    })?;
    let metadata = file.metadata().map_err(|_| Denial::Unreadable)?;
    if !metadata.is_file() {
        return Err(Denial::Reason(format!(
            "Library path \"{display_name}\" is not a regular file."
        )));
    }
    let size_bytes = metadata.len();
    let over = size_bytes > max_bytes;
    if over && !truncate {
        return Err(Denial::Reason(format!(
            "Library file \"{display_name}\" exceeds the {max_bytes} byte cap."
        )));
    }
    // At most `limit` bytes from the already-open handle: an oversize file
    // is never loaded only to be cut afterwards.
    let limit = if over { max_bytes } else { size_bytes };
    let mut bytes = Vec::with_capacity(usize::try_from(limit).unwrap_or(0));
    file.take(limit)
        .read_to_end(&mut bytes)
        .map_err(|_| Denial::Unreadable)?;
    Ok(ReadResult {
        content: text_decoder_decode(&bytes),
        truncated: over,
        size_bytes,
        denied: None,
        reason: None,
    })
}

/// `Number.isSafeInteger(value) && value > 0`.
fn is_positive_safe_integer(value: f64) -> bool {
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
    value.is_finite() && value.fract() == 0.0 && value > 0.0 && value <= MAX_SAFE_INTEGER
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_bytes_must_be_a_positive_safe_integer() {
        for invalid in [0.0, -1.0, 1.5, f64::NAN, 9_007_199_254_740_992.0] {
            assert_eq!(
                read_library_content("/x", "/", Some(invalid), false),
                Err(ReadArgumentError(
                    "library.read requires a positive integer maxBytes.".into()
                )),
                "maxBytes {invalid} must be refused as an argument error"
            );
        }
        assert_eq!(
            read_library_content("", "/", None, false),
            Err(ReadArgumentError(
                "library.read requires a non-empty path.".into()
            ))
        );
    }

    /// A path that passed the containment check and is then swapped for a
    /// symlink pointing outside the root before the open must be refused at
    /// the open itself — the read never returns the outside bytes.
    #[cfg(unix)]
    #[test]
    fn a_swap_between_check_and_open_is_refused_at_the_open() {
        let scratch = crate::test_support::scratch_dir("library-read-swap");
        let root = scratch.join("root");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(scratch.join("secret"), "outside bytes").unwrap();
        let checked = root.join("note.md");
        std::fs::write(&checked, "inside").unwrap();
        let canonical_root = std::fs::canonicalize(&root).unwrap();
        let canonical = std::fs::canonicalize(&checked).unwrap();
        assert!(
            canonical.starts_with(&canonical_root),
            "the check passes before the swap"
        );

        std::fs::remove_file(&checked).unwrap();
        std::os::unix::fs::symlink(scratch.join("secret"), &checked).unwrap();

        let outcome = read_bounded(&canonical_root, &canonical, 1024, false, "note.md");
        assert!(
            matches!(outcome, Err(Denial::Outside)),
            "expected the swapped path to be refused as outside | received {:?}",
            outcome.map(|result| result.content)
        );
    }

    /// `library-service.test.ts` "refuses oversize content when truncation
    /// is not requested".
    #[test]
    fn oversize_content_is_refused_unless_truncation_is_requested() {
        let root = crate::test_support::scratch_dir("library-read-oversize");
        let file = root.join("big.md");
        std::fs::write(&file, "abcdefghij").unwrap();
        let path = file.to_string_lossy();
        let root = root.to_string_lossy();
        let refused = read_library_content(&path, &root, Some(4.0), false).unwrap();
        assert_eq!(
            refused.reason.as_deref(),
            Some("Library file \"big.md\" exceeds the 4 byte cap."),
            "received {refused:?}"
        );
        let truncated = read_library_content(&path, &root, Some(4.0), true).unwrap();
        assert_eq!(
            (
                truncated.content.as_str(),
                truncated.truncated,
                truncated.size_bytes
            ),
            ("abcd", true, 10)
        );
        let capped = read_library_content(&path, &root, Some(1e9), false).unwrap();
        assert_eq!(
            capped.content, "abcdefghij",
            "a maxBytes above the ceiling is capped, not refused"
        );
    }

    #[test]
    fn a_single_file_location_is_rooted_at_its_directory() {
        let env = PathEnv {
            platform: "linux".into(),
            home_dir: "/home/u".into(),
            env: Default::default(),
        };
        assert_eq!(
            library_location_root("claude-instructions", &env).as_deref(),
            Some("/home/u/.claude")
        );
        assert_eq!(
            library_location_root("claude-skills", &env).as_deref(),
            Some("/home/u/.claude/skills")
        );
        assert_eq!(library_location_root("unknown", &env), None);
    }
}
