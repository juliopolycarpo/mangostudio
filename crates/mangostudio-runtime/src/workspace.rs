//! One place a path is decided to be inside a workspace root or not —
//! shared by whichever later lane adds filesystem, process, or terminal
//! methods, so none of them ever supplies a second authorization policy.
//!
//! Mirrors `apps/runtime/src/services/workspace.ts` and
//! `apps/runtime/src/services/fs-path-policy.ts`. The hub's own containment
//! check (against a chat's working directory) is necessarily lexical: it
//! reasons about the path string, not the filesystem it runs on top of.
//! This module is the runtime-side half, which *is* on that filesystem and
//! can resolve what a symlink or junction actually points at — a hub can
//! never widen a runtime's authority by naming a path whose lexical shape
//! looks contained but whose real target is not, because nothing here ever
//! trusts the lexical shape at all.
//!
//! # Two checks, not one
//!
//! [`resolve_contained_workspace_path`] answers "is this path inside the
//! root, right now". [`guard_mutation`] is the second, *later* check every
//! mutating operation needs on top of it: a request-time answer can go
//! stale by the time a write actually happens (a symlink swapped in
//! between the two), so a caller that mutates re-runs the same
//! containment decision immediately before the mutation, never relying on
//! an earlier answer alone. Both draw on the same
//! [`resolve_contained_workspace_path`] — there is no second policy to
//! keep in sync, only two different moments to apply the one policy at.

use std::path::{Path, PathBuf};

/// No listing answers with more than this many entries at once. Mirrors
/// `MAX_WORKSPACE_DIRECTORY_ENTRIES`.
pub const MAX_WORKSPACE_DIRECTORY_ENTRIES: usize = 5_000;

/// A requested path resolved outside the workspace root it was asked to
/// stay inside — a symlink or junction escape, most often. Carries the
/// path exactly as requested, never the resolved target (which is exactly
/// the value that must not be handed back to whoever asked for it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceContainmentError {
    requested_path: String,
}

impl std::fmt::Display for WorkspaceContainmentError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{:?} resolves outside the workspace root it was asked to stay inside",
            self.requested_path
        )
    }
}

impl std::error::Error for WorkspaceContainmentError {}

/// Resolves `requested` against `root`, both taken to their real, symlink-
/// free identity, and checks the result is still inside `root`.
///
/// `Ok(None)` when `requested` does not resolve at all (most often: it does
/// not exist yet, which is an ordinary state for a path about to be
/// created, not a containment failure). `Err` when it *does* resolve, but
/// outside `root` — the one outcome that must never be treated as "not
/// found" and quietly retried against a default.
///
/// # Errors
/// [`WorkspaceContainmentError`] when `requested` resolves to a real path
/// outside `root`.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::workspace::resolve_contained_workspace_path;
///
/// let root = std::env::temp_dir().join("mango-workspace-doctest");
/// std::fs::create_dir_all(root.join("src")).unwrap();
/// std::fs::write(root.join("src/main.rs"), b"fn main() {}").unwrap();
///
/// let inside = resolve_contained_workspace_path(&root, "src/main.rs").unwrap();
/// assert_eq!(inside, Some(std::path::PathBuf::from("src/main.rs")));
///
/// let outside = resolve_contained_workspace_path(&root, "../../etc/passwd");
/// assert!(outside.is_err());
/// ```
pub fn resolve_contained_workspace_path(
    root: &Path,
    requested: &str,
) -> Result<Option<PathBuf>, WorkspaceContainmentError> {
    // A root that does not itself resolve is a caller error (a workspace
    // whose directory has vanished), not a containment question about the
    // path it was asked to check — bubble it as "not found" rather than
    // silently substituting a default, so a caller notices its own root is
    // gone rather than every request against it quietly reading as "outside".
    let Ok(real_root) = std::fs::canonicalize(root) else {
        return Ok(None);
    };
    let normalized = requested.replace('\\', "/");
    let candidate = real_root.join(normalized);
    let Ok(real_path) = std::fs::canonicalize(&candidate) else {
        return Ok(None);
    };

    match real_path.strip_prefix(&real_root) {
        Ok(relative) if !relative.as_os_str().is_empty() => Ok(Some(relative.to_path_buf())),
        _ => Err(WorkspaceContainmentError {
            requested_path: requested.to_string(),
        }),
    }
}

/// Re-runs [`resolve_contained_workspace_path`] for every path `targets`
/// names, immediately before calling `execute` — the re-check every
/// mutating operation needs on top of whatever containment check already
/// passed at request time. See the module docs for why this is the same
/// policy applied a second time, not a second policy.
///
/// # Errors
/// The first [`WorkspaceContainmentError`] any of `targets` produces;
/// `execute` never runs in that case. `targets` that do not yet exist
/// (`resolve_contained_workspace_path` returning `Ok(None)`) do not block a
/// mutation that is about to create them — inherited from that function,
/// which cannot resolve, and so cannot judge, a path with nothing at the
/// end of it yet. A target that both escapes `root` *and* does not exist is
/// a gap this shares with `resolveContainedWorkspacePath`, not one this
/// crate introduces; closing it needs a resolvable-*parent* check this
/// module does not build; a later lane that actually creates files should
/// resolve the *parent directory* it writes into (which does exist) rather
/// than the not-yet-created leaf.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::workspace::guard_mutation;
///
/// let root = std::env::temp_dir().join("mango-guard-mutation-doctest");
/// std::fs::create_dir_all(&root).unwrap();
/// std::fs::write(root.join("notes.txt"), b"before").unwrap();
///
/// let wrote = guard_mutation(&root, &["notes.txt"], || {
///     std::fs::write(root.join("notes.txt"), b"after").unwrap();
/// });
/// assert!(wrote.is_ok());
///
/// // `..` resolves to something real (root's own parent), so this
/// // exercises the escape check rather than the "does not exist yet" path.
/// let refused = guard_mutation(&root, &[".."], || {
///     panic!("must never run: the target is outside the root");
/// });
/// assert!(refused.is_err());
/// ```
pub fn guard_mutation<T>(
    root: &Path,
    targets: &[&str],
    execute: impl FnOnce() -> T,
) -> Result<T, WorkspaceContainmentError> {
    for target in targets {
        resolve_contained_workspace_path(root, target)?;
    }
    Ok(execute())
}

/// One directory entry's bare name, and whether it is itself a directory —
/// exactly what a bounded listing needs to answer, nothing a later method's
/// own richer shape (size, mtime, symlink target) should be guessed at here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryEntry {
    /// The entry's file name, not a full path.
    pub name: String,
    /// Whether this entry is itself a directory.
    pub is_directory: bool,
}

/// A directory's entries, capped at [`MAX_WORKSPACE_DIRECTORY_ENTRIES`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundedListing {
    /// At most [`MAX_WORKSPACE_DIRECTORY_ENTRIES`] entries.
    pub entries: Vec<DirectoryEntry>,
    /// Whether `dir` actually held more entries than [`BoundedListing::entries`] carries.
    pub truncated: bool,
}

/// Lists `dir`'s entries, capped at [`MAX_WORKSPACE_DIRECTORY_ENTRIES`] —
/// the containment-agnostic half of `browseWorkspace`; a caller that must
/// stay inside a workspace root calls
/// [`resolve_contained_workspace_path`] on `dir` itself first.
///
/// # Errors
/// Whatever [`std::fs::read_dir`] itself reports (`dir` missing, not a
/// directory, unreadable).
///
/// # Example
///
/// ```
/// use mangostudio_runtime::workspace::list_directory_bounded;
///
/// let dir = std::env::temp_dir().join("mango-list-directory-doctest");
/// std::fs::create_dir_all(dir.join("sub")).unwrap();
/// std::fs::write(dir.join("file.txt"), b"").unwrap();
///
/// let listing = list_directory_bounded(&dir).unwrap();
/// assert!(!listing.truncated);
/// assert_eq!(listing.entries.len(), 2);
/// ```
pub fn list_directory_bounded(dir: &Path) -> std::io::Result<BoundedListing> {
    let mut entries = Vec::new();
    let mut truncated = false;
    for item in std::fs::read_dir(dir)? {
        let item = item?;
        if entries.len() >= MAX_WORKSPACE_DIRECTORY_ENTRIES {
            truncated = true;
            break;
        }
        let is_directory = item.file_type().is_ok_and(|kind| kind.is_dir());
        entries.push(DirectoryEntry {
            name: item.file_name().to_string_lossy().into_owned(),
            is_directory,
        });
    }
    Ok(BoundedListing { entries, truncated })
}

#[cfg(test)]
mod tests {
    use super::{
        WorkspaceContainmentError, guard_mutation, list_directory_bounded,
        resolve_contained_workspace_path,
    };

    fn scratch_root(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mango-workspace-test-{name}-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_path_inside_the_root_resolves_to_its_relative_form() {
        let root = scratch_root("inside");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.rs"), b"fn main() {}").unwrap();
        let resolved = resolve_contained_workspace_path(&root, "src/main.rs").unwrap();
        assert_eq!(resolved, Some(std::path::PathBuf::from("src/main.rs")));
    }

    #[test]
    fn a_path_that_does_not_exist_yet_is_none_not_an_error() {
        let root = scratch_root("not-yet");
        let resolved = resolve_contained_workspace_path(&root, "not-yet-created.txt").unwrap();
        assert_eq!(resolved, None);
    }

    #[test]
    fn a_lexical_escape_via_dot_dot_is_refused() {
        let root = scratch_root("dotdot");
        // The parent of `root` certainly exists (it is `scratch_root`'s own
        // parent, the system temp directory), so this resolves to something
        // real and must be caught as an escape, not silently answered `None`.
        let error = resolve_contained_workspace_path(&root, "..").unwrap_err();
        assert!(matches!(error, WorkspaceContainmentError { .. }));
    }

    #[test]
    fn the_root_itself_is_not_a_valid_contained_target() {
        let root = scratch_root("root-itself");
        // An empty relative path resolves to the root exactly — refused,
        // matching `relativePath.length === 0` in the TypeScript source.
        assert!(resolve_contained_workspace_path(&root, ".").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_escaping_the_root_is_refused_even_though_it_lexically_looks_contained() {
        let root = scratch_root("symlink-escape");
        let outside = scratch_root("symlink-escape-target");
        std::fs::write(outside.join("secret.txt"), b"outside").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("looks-inside")).unwrap();

        // Lexically, "looks-inside/secret.txt" reads as a path under root —
        // exactly the case the module docs describe as a hub's own check
        // being unable to see.
        let error = resolve_contained_workspace_path(&root, "looks-inside/secret.txt").unwrap_err();
        assert!(matches!(error, WorkspaceContainmentError { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_that_stays_inside_the_root_is_still_allowed() {
        let root = scratch_root("symlink-inside");
        std::fs::create_dir_all(root.join("real")).unwrap();
        std::fs::write(root.join("real/file.txt"), b"ok").unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("alias")).unwrap();

        let resolved = resolve_contained_workspace_path(&root, "alias/file.txt").unwrap();
        assert_eq!(resolved, Some(std::path::PathBuf::from("real/file.txt")));
    }

    #[test]
    fn guard_mutation_runs_execute_when_every_target_is_contained() {
        let root = scratch_root("guard-ok");
        std::fs::write(root.join("a.txt"), b"").unwrap();
        let ran = guard_mutation(&root, &["a.txt"], || true).unwrap();
        assert!(ran);
    }

    #[test]
    fn guard_mutation_never_calls_execute_when_a_target_escapes() {
        let root = scratch_root("guard-refuse");
        // The target must actually resolve to something real for this to
        // exercise the escape check rather than the "does not exist yet"
        // path — `..` always resolves, to `root`'s own parent.
        let result = guard_mutation(&root, &[".."], || {
            panic!("execute must never run for an escaping target")
        });
        assert!(result.is_err());
    }

    #[test]
    fn guard_mutation_allows_a_target_that_does_not_exist_yet() {
        let root = scratch_root("guard-create");
        let ran = guard_mutation(&root, &["brand-new.txt"], || true).unwrap();
        assert!(
            ran,
            "a not-yet-existing target must not block its own creation"
        );
    }

    #[test]
    fn a_directory_listing_reports_every_entry_when_under_the_cap() {
        let dir = scratch_root("listing-small");
        std::fs::write(dir.join("one.txt"), b"").unwrap();
        std::fs::create_dir(dir.join("two")).unwrap();
        let listing = list_directory_bounded(&dir).unwrap();
        assert!(!listing.truncated);
        assert_eq!(listing.entries.len(), 2);
        assert!(
            listing
                .entries
                .iter()
                .any(|entry| entry.name == "two" && entry.is_directory)
        );
    }

    #[test]
    fn a_directory_listing_truncates_past_the_cap() {
        let dir = scratch_root("listing-large");
        // One more than the cap, so exactly one entry must be omitted.
        for index in 0..(super::MAX_WORKSPACE_DIRECTORY_ENTRIES + 1) {
            std::fs::write(dir.join(format!("file-{index}.txt")), b"").unwrap();
        }
        let listing = list_directory_bounded(&dir).unwrap();
        assert!(listing.truncated);
        assert_eq!(
            listing.entries.len(),
            super::MAX_WORKSPACE_DIRECTORY_ENTRIES
        );
    }
}
