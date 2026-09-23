//! Where a library mutation may land, and the `node:path` string rules the
//! TypeScript engines compare with — a port of `path-safety.ts`,
//! `requireWritableLocation`/`resolveResourceDestination` in
//! `resource-writer.ts`, and the `isPathPrefix`/`resolve` comparisons
//! `apply-writes.ts`, `remove-writes.ts` and `undo-writes.ts` make.
//!
//! Manifests carry absolute path *strings* that both runtimes read, so every
//! path that is recorded or compared here is a string spelled the way
//! Node's `realpath` and `path.resolve` spell it: a Windows verbatim prefix
//! (`\\?\C:\`) is simplified to its Win32 form before it reaches a manifest,
//! and prefix checks are the same case-sensitive `startsWith(root + sep)`
//! that `isPathPrefix` performs.

use std::path::{Path, PathBuf};

use super::super::fs::simplify_verbatim_path;
use super::super::names::is_valid_resource_slug;
use crate::probing::detection::path_env::{
    PathEnv, is_absolute, normalize_path, resolve_path, separator,
};

#[cfg(test)]
#[path = "paths_node_tests.rs"]
mod node_tests;
use crate::probing::locations::{
    LocationDefinition, LocationLayout, ResourceFormat, location_by_id,
};

/// `LibraryWriteFailure`: the stable reasons a write-policy check refuses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WriteFailure {
    InvalidSlug,
    PathEscape,
    UnexpectedEntryType,
    ReadOnlyLocation,
    UnsupportedLocation,
    WrongLayout,
    InvalidSource,
}

/// `LibraryWriteError`: a policy refusal, raised before or instead of an
/// effect. On the wire it is a `path_access` error, as its TypeScript base
/// class `RegularFileWriteError` is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WriteError {
    pub reason: WriteFailure,
    pub message: String,
}

impl WriteError {
    pub(crate) fn new(reason: WriteFailure, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

/// Which layout family a mutation expects of its location.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResourceKind {
    File,
    Directory,
}

impl ResourceKind {
    /// Parses the wire `'file' | 'directory'`.
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "file" => Some(Self::File),
            "directory" => Some(Self::Directory),
            _ => None,
        }
    }

    /// The wire literal.
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Directory => "directory",
        }
    }
}

/// `path.resolve(value)` for this host: absolute values are normalized with
/// any trailing separator dropped; relative ones resolve against the working
/// directory, exactly as Node resolves them.
///
/// # Example
///
/// ```ignore
/// assert_eq!(node_resolve("linux", "/a/b/../c/"), "/a/c");
/// ```
pub(crate) fn node_resolve(platform: &str, value: &str) -> String {
    if is_absolute(platform, value) {
        // Resolving "." against an absolute base is `resolve(base)`: the
        // normalized base with its trailing separator trimmed.
        return resolve_path(platform, value, ".");
    }
    let cwd = std::env::current_dir()
        .map(|dir| path_string(&dir))
        .unwrap_or_default();
    resolve_path(platform, &cwd, value)
}

/// `path.join(...parts)`: the parts joined with this platform's separator,
/// then normalized.
pub(crate) fn node_join(platform: &str, parts: &[&str]) -> String {
    let sep = separator(platform).to_string();
    let joined: Vec<&str> = parts
        .iter()
        .copied()
        .filter(|part| !part.is_empty())
        .collect();
    normalize_path(platform, &joined.join(&sep))
}

/// `path.dirname`.
pub(crate) fn node_dirname(platform: &str, path: &str) -> String {
    crate::probing::detection::path_env::dirname_path(platform, path)
}

/// `path.basename` for an already-resolved path.
pub(crate) fn node_basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map_or_else(String::new, |name| name.to_string_lossy().into_owned())
}

/// `isPathPrefix`: `candidate` is `root` itself or sits under
/// `root + sep`. Case-sensitive on every platform, as resolved identities
/// are compared in TypeScript.
///
/// # Example
///
/// ```ignore
/// assert!(is_path_prefix("linux", "/home/u", "/home/u/x"));
/// assert!(!is_path_prefix("linux", "/home/u", "/home/ux"));
/// ```
pub(crate) fn is_path_prefix(platform: &str, root: &str, candidate: &str) -> bool {
    if candidate == root {
        return true;
    }
    let sep = separator(platform);
    candidate
        .strip_prefix(root)
        .is_some_and(|rest| rest.starts_with(sep))
}

/// A path as the string a manifest records: lossy only for names that are
/// not valid Unicode, which no library slug can be.
pub(crate) fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// What one path segment is on disk, as `lstat` sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SegmentEntry {
    /// Nothing there (`ENOENT`).
    Missing,
    /// A file or directory that is not a link.
    Plain,
    /// A symlink (or Windows junction), with its raw target text.
    Link(String),
}

/// Bounds symlink hops, as `MAX_SYMLINK_HOPS` does in `path-containment.ts`.
const MAX_SYMLINK_HOPS: u32 = 32;

/// `resolvePathThroughExistingAncestor` for this host: every path a manifest
/// records, and every root it is checked against, goes through here.
///
/// It resolves the path the way TypeScript does, not the way the kernel names
/// it: symlinks are followed segment by segment, but nothing is canonicalized.
/// The difference is load-bearing on Windows. `std::fs::canonicalize`
/// expands an 8.3 short name (`C:\Users\RUNNER~1`) to its long form, while
/// Node's JavaScript `realpathSync` keeps the spelling it was given. A Rust
/// manifest recording the long form beside a TypeScript root in the short
/// form fails TypeScript's `isPathPrefix` check, and the reverse fails ours,
/// so both runtimes must spell a path the same way. `None` when the path
/// cannot be verified: a symlink loop, or a segment this process cannot
/// inspect.
pub(crate) fn resolve_through_existing_ancestor(path: &str) -> Option<String> {
    let platform = crate::health::node_platform();
    resolve_like_node(platform, path, &|candidate| native_segment(candidate))
}

fn native_segment(candidate: &str) -> std::io::Result<SegmentEntry> {
    let metadata = match std::fs::symlink_metadata(candidate) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SegmentEntry::Missing);
        }
        Err(error) => return Err(error),
    };
    if !metadata.is_symlink() {
        return Ok(SegmentEntry::Plain);
    }
    let target = path_string(&std::fs::read_link(candidate)?);
    Ok(SegmentEntry::Link(
        simplify_verbatim_path(&target).unwrap_or(target),
    ))
}

/// The pure half of [`resolve_through_existing_ancestor`], with the `lstat`
/// and `readlink` it needs injected as `probe`.
///
/// # Example
///
/// ```ignore
/// // An 8.3 name that is a plain directory keeps its spelling.
/// let resolved = resolve_like_node("win32", r"C:\Users\RUNNER~1\x", &|_| Ok(SegmentEntry::Plain));
/// assert_eq!(resolved.as_deref(), Some(r"C:\Users\RUNNER~1\x"));
/// ```
pub(crate) fn resolve_like_node(
    platform: &str,
    path: &str,
    probe: &dyn Fn(&str) -> std::io::Result<SegmentEntry>,
) -> Option<String> {
    let (root, segments) = split_absolute(platform, &node_resolve(platform, path));
    let mut resolved = root;
    let mut pending: std::collections::VecDeque<String> = segments.into();
    let mut hops = 0;
    while let Some(segment) = pending.pop_front() {
        let candidate = resolve_path(platform, &resolved, &segment);
        match probe(&candidate).ok()? {
            SegmentEntry::Missing => {
                let mut parts: Vec<&str> = vec![&resolved, &segment];
                parts.extend(pending.iter().map(String::as_str));
                return Some(node_resolve(platform, &node_join(platform, &parts)));
            }
            SegmentEntry::Plain => resolved = candidate,
            SegmentEntry::Link(target) => {
                if hops >= MAX_SYMLINK_HOPS {
                    return None;
                }
                hops += 1;
                let parent = node_dirname(platform, &candidate);
                let (target_root, target_segments) =
                    split_absolute(platform, &resolve_path(platform, &parent, &target));
                resolved = target_root;
                for segment in target_segments.into_iter().rev() {
                    pending.push_front(segment);
                }
            }
        }
    }
    Some(resolved)
}

/// `splitAbsolutePath`: an absolute, normalized path's root (`/`, `C:\`,
/// `\\server\share\`) and its remaining segments.
fn split_absolute(platform: &str, path: &str) -> (String, Vec<String>) {
    let sep = separator(platform);
    let bytes = path.as_bytes();
    let root_len = if platform == "win32" && bytes.len() >= 2 && bytes[1] == b':' {
        3.min(path.len())
    } else if platform == "win32" && path.starts_with("\\\\") {
        path.char_indices()
            .filter(|(_, c)| *c == sep)
            .nth(3)
            .map_or(path.len(), |(index, _)| index + 1)
    } else {
        1.min(path.len())
    };
    let segments = path[root_len..]
        .split(sep)
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
        .collect();
    (path[..root_len].to_string(), segments)
}

/// `ContainedResourcePath` without the root, which no caller here reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedDestination {
    /// The path beneath the registry root, as the user would name it.
    pub logical_path: String,
    /// Where writes land after following every symlinked ancestor.
    pub resolved_path: String,
}

/// `resolveContainedResourcePath`: `entry_name` resolved one segment under
/// `root`, refused unless it stays strictly inside the root after symlink
/// resolution.
pub(crate) fn resolve_contained_resource_path(
    platform: &str,
    root: &str,
    entry_name: &str,
) -> Result<ResolvedDestination, WriteError> {
    if !is_absolute(platform, root) {
        return Err(WriteError::new(
            WriteFailure::PathEscape,
            format!("Library location root must be absolute: \"{root}\"."),
        ));
    }
    if !is_valid_resource_slug(entry_name) {
        return Err(WriteError::new(
            WriteFailure::InvalidSlug,
            format!("Invalid library resource slug: \"{entry_name}\"."),
        ));
    }
    let logical_root = node_resolve(platform, root);
    let logical_path = node_join(platform, &[&logical_root, entry_name]);
    let unresolvable = || {
        WriteError::new(
            WriteFailure::PathEscape,
            format!("Cannot safely resolve library destination \"{logical_path}\"."),
        )
    };
    let resolved_root =
        resolve_through_existing_ancestor(&logical_root).ok_or_else(unresolvable)?;
    let resolved_path =
        resolve_through_existing_ancestor(&logical_path).ok_or_else(unresolvable)?;
    if !is_path_prefix(platform, &resolved_root, &resolved_path) || resolved_path == resolved_root {
        return Err(WriteError::new(
            WriteFailure::PathEscape,
            format!("Library destination \"{logical_path}\" resolves outside \"{logical_root}\"."),
        ));
    }
    Ok(ResolvedDestination {
        logical_path,
        resolved_path,
    })
}

/// `assertExpectedResourceEntry`: an absent path passes; anything that is
/// not a regular file or directory of the expected kind (after following
/// symlinks) is refused before a rename can replace it.
pub(crate) fn assert_expected_resource_entry(
    path: &str,
    expected: ResourceKind,
) -> Result<(), WriteError> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(WriteError::new(
                WriteFailure::UnexpectedEntryType,
                format!("Cannot inspect library destination \"{path}\": {error}"),
            ));
        }
    };
    let matches = match expected {
        ResourceKind::Directory => metadata.is_dir(),
        ResourceKind::File => metadata.is_file(),
    };
    if matches {
        return Ok(());
    }
    Err(WriteError::new(
        WriteFailure::UnexpectedEntryType,
        format!(
            "Cannot write \"{path}\": the path exists and is not a regular {}.",
            expected.as_str()
        ),
    ))
}

/// `requireWritableLocation`: an unknown, read-only or wrong-layout location
/// is refused before any path is resolved, so every mutation flow agrees on
/// which locations it will touch.
pub(crate) fn require_writable_location(
    location_id: &str,
    expected: ResourceKind,
) -> Result<&'static LocationDefinition, WriteError> {
    let Some(location) = location_by_id(location_id) else {
        return Err(WriteError::new(
            WriteFailure::UnsupportedLocation,
            format!("Unknown library location: \"{location_id}\"."),
        ));
    };
    if location.access != "read-write" {
        return Err(WriteError::new(
            WriteFailure::ReadOnlyLocation,
            format!("Library location \"{location_id}\" is read-only."),
        ));
    }
    let file_layout = matches!(
        location.layout,
        LocationLayout::DirectoryOfFiles | LocationLayout::SingleFile
    );
    let matches = match expected {
        ResourceKind::Directory => location.layout == LocationLayout::DirectoryOfDirs,
        ResourceKind::File => file_layout,
    };
    if !matches {
        return Err(WriteError::new(
            WriteFailure::WrongLayout,
            format!(
                "Library location \"{location_id}\" does not contain {} resources.",
                expected.as_str()
            ),
        ));
    }
    Ok(location)
}

/// `FORMAT_EXTENSIONS`: the extension a `directory-of-files` entry carries.
const fn format_extension(format: ResourceFormat) -> &'static str {
    match format {
        ResourceFormat::MarkdownPlain | ResourceFormat::MarkdownFrontmatter => ".md",
        ResourceFormat::Mdc => ".mdc",
        ResourceFormat::TomlAgent | ResourceFormat::TomlSettings => ".toml",
        ResourceFormat::JsonSettings => ".json",
        ResourceFormat::RulesDsl => ".rules",
    }
}

/// `resolveResourceDestination`: where `slug` lives inside `location` on
/// this host. A `single-file` location is its own destination and only
/// accepts the slug it declares.
pub(crate) fn resolve_resource_destination(
    location: &LocationDefinition,
    slug: &str,
    env: &PathEnv,
) -> Result<ResolvedDestination, WriteError> {
    let Some(root) = (location.resolve_path)(env) else {
        return Err(WriteError::new(
            WriteFailure::UnsupportedLocation,
            format!(
                "Library location \"{}\" is unsupported on {}.",
                location.id, env.platform
            ),
        ));
    };
    if location.layout == LocationLayout::SingleFile {
        if location.resource_slug != Some(slug) {
            return Err(WriteError::new(
                WriteFailure::InvalidSlug,
                format!(
                    "Library location \"{}\" stores \"{}\", not \"{slug}\".",
                    location.id,
                    location.resource_slug.unwrap_or_default()
                ),
            ));
        }
        let resolved_path = resolve_through_existing_ancestor(&root).ok_or_else(|| {
            WriteError::new(
                WriteFailure::PathEscape,
                format!("Cannot safely resolve library destination \"{root}\"."),
            )
        })?;
        return Ok(ResolvedDestination {
            logical_path: root,
            resolved_path,
        });
    }
    let entry_name = if location.layout == LocationLayout::DirectoryOfFiles {
        format!("{slug}{}", format_extension(location.format))
    } else {
        slug.to_string()
    };
    resolve_contained_resource_path(&env.platform, &root, &entry_name)
}

/// A string path as a filesystem path.
pub(crate) fn fs_path(path: &str) -> PathBuf {
    PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_checks_are_separator_aware_and_case_sensitive() {
        assert!(is_path_prefix("linux", "/home/u", "/home/u"));
        assert!(is_path_prefix("linux", "/home/u", "/home/u/x"));
        assert!(
            !is_path_prefix("linux", "/home/u", "/home/ux"),
            "a sibling sharing a textual prefix is not contained"
        );
        assert!(!is_path_prefix("linux", "/home/u", "/home/U/x"));
        assert!(is_path_prefix("win32", "C:\\u", "C:\\u\\x"));
        assert!(!is_path_prefix("win32", "C:\\u", "C:\\u/x"));
    }

    #[test]
    fn node_resolve_and_join_match_node_path() {
        assert_eq!(node_resolve("linux", "/a/b/../c/"), "/a/c");
        assert_eq!(node_resolve("linux", "/"), "/");
        assert_eq!(node_resolve("win32", "C:\\a\\"), "C:\\a");
        assert_eq!(node_join("linux", &["/a/", "b", "c"]), "/a/b/c");
        assert_eq!(node_join("win32", &["C:\\a", "b"]), "C:\\a\\b");
    }

    #[test]
    fn writable_location_checks_run_in_typescript_order() {
        let unknown = require_writable_location("nope", ResourceKind::File).unwrap_err();
        assert_eq!(unknown.reason, WriteFailure::UnsupportedLocation);
        let read_only = LOCATION_IDS
            .iter()
            .filter_map(|id| location_by_id(id))
            .find(|location| location.access != "read-write")
            .expect("the registry declares at least one read-only location");
        assert_eq!(
            require_writable_location(read_only.id, ResourceKind::File)
                .unwrap_err()
                .reason,
            WriteFailure::ReadOnlyLocation
        );
        assert_eq!(
            require_writable_location("mango-skills", ResourceKind::File)
                .unwrap_err()
                .reason,
            WriteFailure::WrongLayout,
            "a directory-of-dirs location refuses a file resource"
        );
        assert!(require_writable_location("mango-skills", ResourceKind::Directory).is_ok());
        assert!(require_writable_location("claude-instructions", ResourceKind::File).is_ok());
    }

    const LOCATION_IDS: &[&str] = &[
        "mango-skills",
        "claude-settings",
        "claude-hooks",
        "codex-settings",
        "codex-permission-rules",
        "cursor-settings",
    ];

    #[test]
    fn write_errors_display_their_message() {
        let error = WriteError::new(WriteFailure::InvalidSlug, "bad slug");
        assert_eq!(error.to_string(), "bad slug");
    }

    /// A `directory-of-files` entry is the slug plus its format's extension.
    #[test]
    fn directory_of_files_entries_carry_their_format_extension() {
        let scratch = crate::test_support::scratch_dir("library-file-extensions");
        let env = PathEnv {
            platform: crate::health::node_platform().to_string(),
            home_dir: path_string(&scratch),
            env: Default::default(),
        };
        for (location_id, expected) in [
            ("claude-agents", "reviewer.md"),
            ("codex-agents", "reviewer.toml"),
        ] {
            let location = location_by_id(location_id).unwrap();
            let destination = resolve_resource_destination(location, "reviewer", &env).unwrap();
            assert!(
                destination.logical_path.ends_with(expected),
                "expected {location_id} to name {expected} | received {}",
                destination.logical_path
            );
        }
    }

    /// Only "not found" is an absent destination: a path under a regular
    /// file cannot be inspected and is refused, not written through.
    #[cfg(unix)]
    #[test]
    fn a_destination_that_cannot_be_inspected_is_refused() {
        let scratch = crate::test_support::scratch_dir("library-destination-notdir");
        std::fs::write(scratch.join("file"), "x").unwrap();
        let under = path_string(&scratch.join("file").join("child"));
        let refused = assert_expected_resource_entry(&under, ResourceKind::Directory).unwrap_err();
        assert_eq!(
            refused.reason,
            WriteFailure::UnexpectedEntryType,
            "expected unexpected-entry-type | received {refused:?}"
        );
    }

    #[test]
    fn a_single_file_location_only_accepts_its_declared_slug() {
        let scratch = crate::test_support::scratch_dir("library-single-file-slug");
        let home = path_string(&scratch);
        let env = PathEnv {
            platform: crate::health::node_platform().to_string(),
            home_dir: home,
            env: Default::default(),
        };
        let location = location_by_id("claude-instructions").unwrap();
        let refused = resolve_resource_destination(location, "other", &env).unwrap_err();
        assert_eq!(
            refused.reason,
            WriteFailure::InvalidSlug,
            "expected invalid-slug | received {refused:?}"
        );
        let accepted = resolve_resource_destination(location, "global", &env).unwrap();
        assert!(
            accepted.logical_path.ends_with("CLAUDE.md"),
            "received {accepted:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_destination_symlink_escaping_the_root_is_refused() {
        let scratch = crate::test_support::scratch_dir("library-destination-escape");
        let root = scratch.join("root");
        let outside = scratch.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("gh")).unwrap();
        let refused =
            resolve_contained_resource_path("linux", &path_string(&root), "gh").unwrap_err();
        assert_eq!(
            refused.reason,
            WriteFailure::PathEscape,
            "expected path-escape | received {refused:?}"
        );
        let linked_root = scratch.join("linked-root");
        std::os::unix::fs::symlink(&root, &linked_root).unwrap();
        let through =
            resolve_contained_resource_path("linux", &path_string(&linked_root), "new").unwrap();
        assert_eq!(
            through.resolved_path,
            path_string(&std::fs::canonicalize(&root).unwrap().join("new")),
            "a symlinked location root resolves to its target"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_or_wrong_kind_destination_is_refused() {
        let scratch = crate::test_support::scratch_dir("library-destination-kind");
        let file = scratch.join("file");
        std::fs::write(&file, "x").unwrap();
        assert!(assert_expected_resource_entry(&path_string(&file), ResourceKind::File).is_ok());
        let wrong = assert_expected_resource_entry(&path_string(&file), ResourceKind::Directory)
            .unwrap_err();
        assert_eq!(wrong.reason, WriteFailure::UnexpectedEntryType);
        let fifo = scratch.join("fifo");
        nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::S_IRWXU).unwrap();
        assert_eq!(
            assert_expected_resource_entry(&path_string(&fifo), ResourceKind::File)
                .unwrap_err()
                .reason,
            WriteFailure::UnexpectedEntryType
        );
        assert!(
            assert_expected_resource_entry(
                &path_string(&scratch.join("absent")),
                ResourceKind::File
            )
            .is_ok()
        );
    }
}
