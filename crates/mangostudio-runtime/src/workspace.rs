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

/// Why a requested path could not be trusted as contained in a workspace
/// root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceContainmentError {
    /// `requested` resolved to a real path outside `root` — a symlink or
    /// junction escape, most often. Carries the path exactly as requested,
    /// never the resolved target (which is exactly the value that must
    /// never be handed back to whoever asked for it).
    Escaped {
        /// The path as the caller requested it, before resolution.
        requested_path: String,
    },
    /// `root` itself does not resolve — a workspace whose directory has
    /// vanished out from under it. Distinct from an ordinary "not yet
    /// created" leaf: nothing about *this* is a question over `requested`
    /// at all, and a mutation must refuse rather than treat a missing root
    /// as "safe to create into".
    RootUnavailable {
        /// The root that could not be resolved.
        root: PathBuf,
    },
    /// `requested` names a real filesystem entry this crate could not
    /// verify at all — a symlink cycle, or a chain past the symlink-hop
    /// cap — mirroring `path-containment.ts` throwing `PathAccessError`
    /// for the same shape rather than treating it as absent. An entry that
    /// exists but cannot be resolved is exactly as untrustworthy as one
    /// that resolves outside `root`: neither may ever be read as "not
    /// found yet, safe to create".
    Unresolvable {
        /// The path as the caller requested it, before resolution.
        requested_path: String,
    },
}

impl std::fmt::Display for WorkspaceContainmentError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkspaceContainmentError::Escaped { requested_path } => write!(
                formatter,
                "{requested_path:?} resolves outside the workspace root it was asked to stay inside"
            ),
            WorkspaceContainmentError::RootUnavailable { root } => write!(
                formatter,
                "the workspace root {} could not be resolved",
                root.display()
            ),
            WorkspaceContainmentError::Unresolvable { requested_path } => write!(
                formatter,
                "{requested_path:?} could not be resolved (a symlink cycle, or too long a chain)"
            ),
        }
    }
}

impl std::error::Error for WorkspaceContainmentError {}

/// Resolves `requested` against `root`, both taken to their real, symlink-
/// free identity, and checks the result is still inside `root`.
///
/// `Ok(None)` when `requested` does not exist yet, which is an ordinary
/// state for a path about to be created, not a containment failure. `Err`
/// for every other way this could fail to answer "yes, safely inside" —
/// `root` itself does not resolve, `requested` *does* resolve but outside
/// `root`, or `requested` names something that exists but this crate could
/// not verify at all (a symlink cycle, most often) — none of which may ever
/// be treated as "not found" and quietly retried against a default.
///
/// # Errors
/// [`WorkspaceContainmentError::RootUnavailable`] when `root` does not
/// resolve. [`WorkspaceContainmentError::Escaped`] when `requested` resolves
/// to a real path outside `root`. [`WorkspaceContainmentError::Unresolvable`]
/// when `requested` exists but could not be resolved at all.
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
    // A root that does not itself resolve means the workspace directory has
    // vanished out from under this call — not a containment question about
    // `requested` at all, and never safe to read as "not found yet, so
    // proceed": `guard_mutation` treats `Ok(None)` as "target absent, create
    // is fine", which for a vanished *root* would let every mutation through
    // instead of refusing.
    let Ok(real_root) = std::fs::canonicalize(root) else {
        return Err(WorkspaceContainmentError::RootUnavailable {
            root: root.to_path_buf(),
        });
    };
    let normalized = requested.replace('\\', "/");
    let candidate = real_root.join(normalized);
    // Whether the exact candidate exists is tracked separately from whether
    // it *resolves* (below): a not-yet-existing leaf inside the root must
    // still answer `Ok(None)`, but a not-yet-existing leaf reached through a
    // symlink that escapes the root must still be caught as an escape —
    // conflating the two (a bare `canonicalize(candidate)`, which fails
    // identically for both) is exactly the gap this function used to have.
    let exists = std::fs::canonicalize(&candidate).is_ok();
    // `resolve_through_existing_ancestor` only ever answers `None` when it
    // could not verify `candidate` at all (a symlink cycle, a chain past
    // `MAX_SYMLINK_HOPS`, or a transient I/O error) — an ordinary
    // not-yet-created leaf always resolves to `Some`, through its nearest
    // existing ancestor. `None` is therefore never "safe, does not exist
    // yet": mirrors `path-containment.ts` throwing `PathAccessError` for
    // the same shape instead of treating it as absent.
    let Some(real_path) = resolve_through_existing_ancestor(&candidate) else {
        return Err(WorkspaceContainmentError::Unresolvable {
            requested_path: requested.to_string(),
        });
    };

    match real_path.strip_prefix(&real_root) {
        Ok(relative) if !relative.as_os_str().is_empty() => {
            if exists {
                Ok(Some(relative.to_path_buf()))
            } else {
                Ok(None)
            }
        }
        _ => Err(WorkspaceContainmentError::Escaped {
            requested_path: requested.to_string(),
        }),
    }
}

/// Bounds symlink traversal in [`resolve_through_existing_ancestor`],
/// including a chain whose final target exists — mirrors `MAX_SYMLINK_HOPS`
/// in `path-containment.ts` exactly (32), so neither side follows a cycle
/// further than the other before giving up on it.
const MAX_SYMLINK_HOPS: u32 = 32;

/// Resolves `candidate` to its real, symlink-free identity, following it
/// through the *nearest existing ancestor* when `candidate` itself does not
/// exist yet — a faithful port of `resolvePathThroughExistingAncestor` in
/// `path-containment.ts`, walking one path segment at a time from the root
/// rather than shrinking a prefix from the leaf end.
///
/// Every segment is `symlink_metadata`-ed — never a bare `canonicalize`,
/// which cannot tell "this segment does not exist" apart from "this
/// segment exists, but is a symlink whose target does not fully resolve".
/// The two answers must never be conflated: an ordinary not-yet-created
/// leaf is safe to treat as "not found yet, this write may create it", but
/// a symlink *leaf* whose target is absent or outside `root` is a real,
/// already-existing filesystem entry that a write would follow straight
/// through to wherever it points — including a leaf reached by no further
/// segments at all, which a prefix-shrinking walk that starts one segment
/// short of the full path can never even inspect.
///
/// A segment that turns out to be a symlink splices its target's own
/// segments in at the front of what is left to walk, so a chain of
/// symlinks resolves the same way one at a time, capped at
/// [`MAX_SYMLINK_HOPS`] — past it, this returns `None`, the same "cannot
/// verify" answer a real filesystem loop's `ELOOP` gives, and never `Some`
/// of a guess.
///
/// `None` also when not even the empty prefix can be canonicalized (a
/// transient I/O error, most often) — never `Some` of a path this function
/// could not actually verify against the filesystem.
fn resolve_through_existing_ancestor(candidate: &Path) -> Option<PathBuf> {
    let (mut resolved, mut pending) = split_into_root_and_segments(&lexically_normalize(candidate));
    let mut hops: u32 = 0;

    while let Some(segment) = pending.pop_front() {
        let step = resolved.join(&segment);
        let Ok(metadata) = std::fs::symlink_metadata(&step) else {
            // `step` does not exist at all: everything resolved so far is
            // real, and the rest — this segment plus whatever is still
            // pending — is the not-yet-created tail, reattached lexically
            // rather than through the filesystem.
            let real = std::fs::canonicalize(&resolved).ok()?;
            let mut tail = real;
            tail.push(&segment);
            for remaining in &pending {
                tail.push(remaining);
            }
            return Some(tail);
        };

        if !metadata.is_symlink() {
            resolved = step;
            continue;
        }

        if hops >= MAX_SYMLINK_HOPS {
            return None;
        }
        hops += 1;

        let raw_target = std::fs::read_link(&step).ok()?;
        // A relative target is relative to the link's own directory —
        // `resolved`, since `step` is `resolved` plus the link's own name
        // — not to whatever directory this walk started from.
        let target = if raw_target.is_absolute() {
            raw_target
        } else {
            resolved.join(&raw_target)
        };
        let (target_root, target_segments) =
            split_into_root_and_segments(&lexically_normalize(&target));
        resolved = target_root;
        for segment in target_segments.into_iter().rev() {
            pending.push_front(segment);
        }
    }

    // Every segment resolved as a real, non-symlink entry.
    std::fs::canonicalize(&resolved).ok()
}

/// Splits an already lexically-normalized, absolute path into its root
/// (whatever [`std::path::Component::Prefix`]/[`std::path::Component::RootDir`]
/// contribute — platform-specific, opaque to the walk) and the ordinary
/// name segments after it, in order.
fn split_into_root_and_segments(
    path: &Path,
) -> (PathBuf, std::collections::VecDeque<std::ffi::OsString>) {
    let mut root = PathBuf::new();
    let mut segments = std::collections::VecDeque::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                root.push(component.as_os_str());
            }
            other => segments.push_back(other.as_os_str().to_os_string()),
        }
    }
    (root, segments)
}

/// Collapses `.` and `..` components in `path` without touching the
/// filesystem. Only ever called on a path whose existing prefix is already
/// canonical (see [`resolve_through_existing_ancestor`]) — a `..` that pops
/// past that prefix is not a bug to guard against, it is exactly the escape
/// [`resolve_contained_workspace_path`] exists to catch, so this function
/// lets it pop freely rather than clamping at some artificial floor.
fn lexically_normalize(path: &Path) -> PathBuf {
    let mut stack: Vec<std::path::Component<'_>> = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if matches!(stack.last(), Some(std::path::Component::Normal(_))) {
                    stack.pop();
                }
                // Past the root prefix, `..` has nowhere further to go and
                // is simply dropped — `/..` normalizes to `/`, the same
                // floor a real filesystem enforces.
            }
            other => stack.push(other),
        }
    }
    stack.into_iter().collect()
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
/// mutation that is about to create them. A target that both escapes `root`
/// *and* does not exist yet is still refused, not silently answered `None`
/// — `resolve_contained_workspace_path` resolves through the nearest
/// existing ancestor precisely so a symlinked directory (or a literal `..`
/// past a component that was never created) cannot hide an escape behind
/// "nothing there to judge".
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
    for item in std::fs::read_dir(dir)? {
        let item = item?;
        let is_directory = item.file_type().is_ok_and(|kind| kind.is_dir());
        entries.push(DirectoryEntry {
            name: item.file_name().to_string_lossy().into_owned(),
            is_directory,
        });
    }
    // Sorted before truncating, so the cap drops a stable, name-ordered tail
    // rather than an arbitrary subset of whatever order `read_dir` happened
    // to yield — mirrors `browseWorkspace`'s own case-insensitive-then-
    // case-sensitive sort, though with a plain lowercase fold rather than
    // `Intl.Collator`'s locale-aware one: this crate has no ICU collation
    // dependency to reach for, so the two orderings can diverge on
    // locale-specific rules (e.g. some accented letters), while still
    // agreeing on plain ASCII and case-only differences.
    entries.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
    });
    let truncated = entries.len() > MAX_WORKSPACE_DIRECTORY_ENTRIES;
    entries.truncate(MAX_WORKSPACE_DIRECTORY_ENTRIES);
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
        assert!(matches!(error, WorkspaceContainmentError::Escaped { .. }));
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
        assert!(matches!(error, WorkspaceContainmentError::Escaped { .. }));
    }

    /// The gap a bare `canonicalize(candidate)` has: a symlinked directory
    /// escaping the root, requesting a leaf *inside it that does not exist
    /// yet*. `canonicalize` fails on the whole path (the leaf is missing)
    /// the same way it would for an ordinary not-yet-created file, so
    /// without resolving through the symlinked ancestor first, this would
    /// wrongly answer `Ok(None)` — "safe to create" — for a write that
    /// actually lands outside the root entirely.
    #[cfg(unix)]
    #[test]
    fn a_symlink_escape_is_refused_even_for_a_leaf_that_does_not_exist_yet() {
        let root = scratch_root("symlink-escape-not-yet");
        let outside = scratch_root("symlink-escape-not-yet-target");
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

        let error = resolve_contained_workspace_path(&root, "link/new.txt").unwrap_err();
        assert!(matches!(error, WorkspaceContainmentError::Escaped { .. }));
    }

    /// The gap the walk above cannot reach: the escaping symlink is not a
    /// *directory* extended by a not-yet-existing leaf, it is the leaf
    /// itself, dangling (its own target does not exist). A walk that starts
    /// one segment short of the full path — testing only `root`, never
    /// `root/link` — would canonicalize `root` on its very first try and
    /// reattach `link` lexically without ever asking whether `link` itself
    /// is a symlink, answering `Ok(None)` exactly as it would for an
    /// ordinary not-yet-created file. `canonicalize(root/link)` cannot
    /// distinguish that from "does not exist" either, since it follows the
    /// link and fails on the absent target — only `symlink_metadata`, which
    /// never follows the final component, can tell the two apart.
    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_leaf_escaping_the_root_is_refused_not_answered_not_found() {
        let root = scratch_root("dangling-leaf");
        let outside = scratch_root("dangling-leaf-target");
        // Deliberately never created: the link's own target is absent.
        let victim = outside.join("victim.txt");
        std::os::unix::fs::symlink(&victim, root.join("link")).unwrap();

        let error = resolve_contained_workspace_path(&root, "link").unwrap_err();
        assert!(matches!(error, WorkspaceContainmentError::Escaped { .. }));
    }

    /// The exploit itself, at the layer a caller actually goes through: a
    /// mutation naming a dangling symlink leaf that escapes the root must
    /// never run, and must never have written through the link to wherever
    /// it points.
    #[cfg(unix)]
    #[test]
    fn guard_mutation_never_writes_through_a_dangling_symlink_leaf_escaping_the_root() {
        let root = scratch_root("dangling-leaf-guard");
        let outside = scratch_root("dangling-leaf-guard-target");
        let victim = outside.join("victim.txt");
        std::os::unix::fs::symlink(&victim, root.join("link")).unwrap();

        let result = guard_mutation(&root, &["link"], || {
            panic!("execute must never run for a dangling symlink leaf that escapes the root")
        });

        assert!(result.is_err());
        assert!(
            !victim.exists(),
            "the mutation must never have written through the dangling link"
        );
    }

    /// A symlink cycle exists as real filesystem entries on both ends, so
    /// it must never be read the same way a genuinely absent path is — and
    /// the hop cap this guards must actually terminate the walk rather than
    /// spinning forever chasing `a -> b -> a`. This test finishing at all
    /// is half the proof; the returned `Err` (never `Ok(None)`) is the
    /// other half, matching `path-containment.ts` throwing `PathAccessError`
    /// for the same shape instead of treating it as "not found".
    #[cfg(unix)]
    #[test]
    fn a_symlink_cycle_terminates_and_is_never_read_as_absent() {
        let root = scratch_root("symlink-cycle");
        std::os::unix::fs::symlink(root.join("b"), root.join("a")).unwrap();
        std::os::unix::fs::symlink(root.join("a"), root.join("b")).unwrap();

        let result = resolve_contained_workspace_path(&root, "a");
        assert!(
            matches!(result, Err(WorkspaceContainmentError::Unresolvable { .. })),
            "a symlink cycle must refuse, not answer Ok(None): got {result:?}"
        );
    }

    /// The same gap, reached through a literal `..` inside a not-yet-existing
    /// component rather than a symlink: `nope` never exists on disk, so a
    /// plain `canonicalize` of the whole candidate fails the same way a
    /// harmless not-yet-created file would, and the escape hides behind
    /// that unless the `..`s are folded against a canonical prefix first.
    #[test]
    fn a_dot_dot_escape_through_a_nonexistent_component_is_refused() {
        let root = scratch_root("dotdot-through-nonexistent");
        let error = resolve_contained_workspace_path(&root, "nope/../../etc/passwd").unwrap_err();
        assert!(matches!(error, WorkspaceContainmentError::Escaped { .. }));
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
    fn guard_mutation_never_calls_execute_when_the_root_itself_has_vanished() {
        // The containment bypass this guards: `Ok(None)` from
        // `resolve_contained_workspace_path` is the same signal as "target
        // does not exist yet, creating it is fine" — correct for a leaf
        // under a live root, wrong for the root itself. A workspace whose
        // directory was removed out from under it must refuse every
        // mutation, not silently allow one against a root that is no
        // longer there to contain anything.
        let root = scratch_root("guard-vanished-root");
        std::fs::remove_dir_all(&root).unwrap();

        let result = guard_mutation(&root, &["brand-new.txt"], || {
            panic!("execute must never run once the root itself has vanished")
        });

        assert!(matches!(
            result,
            Err(WorkspaceContainmentError::RootUnavailable { .. })
        ));
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

    /// A cap that truncates an unsorted listing drops an arbitrary tail
    /// (whatever order `read_dir` happened to yield), which is not even
    /// stable across two calls on the same directory. Sorting first makes
    /// "which entries survive the cap" a name-ordered, reproducible answer.
    #[test]
    fn a_directory_listing_is_sorted_case_insensitively_before_being_bounded() {
        let dir = scratch_root("listing-sorted");
        for name in ["banana", "Apple", "cherry", "apple2"] {
            std::fs::write(dir.join(name), b"").unwrap();
        }
        let listing = list_directory_bounded(&dir).unwrap();
        let names: Vec<&str> = listing
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, vec!["Apple", "apple2", "banana", "cherry"]);
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
