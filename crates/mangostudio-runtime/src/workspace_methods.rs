//! `workspace.browse`, `workspace.validate`, `workspace.resolve-contained`:
//! the JSON-shaping layer over [`crate::workspace_path`] (what an input path
//! string means) and [`crate::workspace`] (containment), plus the one
//! genuinely new policy this module owns — bounded directory listing for
//! `workspace.browse` and the read+execute directory check for
//! `workspace.validate`.
//!
//! Mirrors `apps/runtime/src/services/workspace.ts`'s `browseWorkspace`,
//! `resolveContainedWorkspacePath`, and `validateWorkdir` — see that file
//! for the algorithmic source of truth every choice below cites.

use std::path::{Path, PathBuf};

use mango_protocol::error::{RemoteError, codes};
use mango_protocol::session::CallContext;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::blocking::run_blocking;
use crate::registry::Registry;
use crate::runtime_home::home_dir;
use crate::workspace::{
    MAX_WORKSPACE_DIRECTORY_ENTRIES, WorkspaceContainmentError, compare_directory_entry_names,
    resolve_contained_workspace_path,
};
use crate::workspace_path::{WorkspacePathError, resolve_workspace_path};

/// Registers `workspace.browse`, `workspace.validate`, and
/// `workspace.resolve-contained` on `registry`. Every one of the three
/// requires the `fsRead` capability per the embedded catalog, already
/// enforced generically by [`crate::ports::authorization::AuthorizationGuard`]
/// — none of these handlers checks consent itself.
///
/// Each registered closure is a thin wrapper over a `build_*_result`
/// function that takes no [`CallContext`] — none of these three methods
/// needs one (no cancellation probe, unlike [`crate::health`]'s `git`
/// probe) — which is what lets this module's own tests call that function
/// directly, the same way [`crate::health`]'s tests call
/// `build_health_report` rather than going through a registered handler.
pub(crate) fn register(registry: Registry) -> Registry {
    registry
        .implement("workspace.browse", |params, _context: CallContext| {
            build_browse_result(params)
        })
        .implement("workspace.validate", |params, _context: CallContext| {
            build_validate_result(params)
        })
        .implement(
            "workspace.resolve-contained",
            |params, _context: CallContext| build_resolve_contained_result(params),
        )
}

#[derive(Debug, Deserialize)]
struct BrowseParams {
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidateParams {
    path: String,
    require_absolute: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct ResolveContainedParams {
    root: String,
    path: String,
}

/// `workspace.browse({ path? })`: a bounded, directories-only listing of
/// `path` (the caller's home directory when omitted), plus enough about the
/// host filesystem (`home`, `roots`, `separator`) for a caller to build a
/// picker on top of it. See [`read_workspace_directory`] for the listing
/// itself.
async fn build_browse_result(params: BrowseParams) -> Result<Value, RemoteError> {
    let input_path = match params.path {
        Some(path) => path,
        None => home_dir()
            .map_err(|error| RemoteError::new(codes::INTERNAL, error.to_string()))?
            .to_string_lossy()
            .into_owned(),
    };

    let resolved = resolve_workspace_path(&input_path, true).map_err(browse_path_shape_error)?;

    let listing_dir = resolved.clone();
    let (entries, truncated) = run_blocking(move || read_workspace_directory(&listing_dir))
        .await
        .map_err(browse_filesystem_error)?;

    let entries_json: Vec<Value> = entries
        .into_iter()
        .map(|entry| {
            let hidden = entry.name.starts_with('.');
            json!({
                "name": entry.name,
                "path": entry.path.to_string_lossy(),
                "hidden": hidden,
            })
        })
        .collect();

    let parent = resolved
        .parent()
        .map(|parent| parent.to_string_lossy().into_owned());
    let home = home_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let roots = filesystem_roots().await;

    let mut result = json!({
        "path": resolved.to_string_lossy(),
        "parent": parent,
        "entries": entries_json,
        "home": home,
        "roots": roots,
        "separator": std::path::MAIN_SEPARATOR_STR,
    });
    if truncated {
        result["truncated"] = Value::Bool(true);
    }
    Ok(result)
}

/// One `workspace.browse` result entry, before it is shaped into JSON.
#[derive(Debug)]
struct BrowseEntry {
    name: String,
    path: PathBuf,
}

/// Lists `dir`'s directory entries only — following a symlink to see what it
/// actually points at, mirroring `isDirectoryEntry` — sorted by
/// [`compare_directory_entry_names`] and capped at
/// [`MAX_WORKSPACE_DIRECTORY_ENTRIES`] *after* filtering.
///
/// Filtering must happen before the sort-and-cap, not after: capping first
/// and filtering the cap's *output* down to directories would silently
/// under-report and mis-set `truncated`. A directory holding 6000 plain
/// files and 100 subdirectories would have every one of its 100
/// subdirectories sorted after most of those files by name in the worst
/// case, so a cap-then-filter pipeline could return far fewer than 100
/// directories (or none) while still reporting `truncated: true` — wrong on
/// both counts, since the real, unfiltered directory count is only 100,
/// comfortably under the cap. Filtering first, then sorting, then capping
/// avoids that regardless of how files and directories happen to interleave
/// in `read_dir`'s own order.
///
/// This also cannot reuse an `lstat`-based `is_directory` flag: that answer
/// is `symlink`-unaware, where `browseWorkspace`'s own `isDirectoryEntry`
/// follows a symlink to see what it actually points at. This function does
/// that itself, costing an extra `stat` only for an entry that is actually a
/// symlink — an ordinary file or directory costs no more syscalls than
/// `lstat` alone.
fn read_workspace_directory(dir: &Path) -> std::io::Result<(Vec<BrowseEntry>, bool)> {
    let mut entries = Vec::new();
    for item in std::fs::read_dir(dir)? {
        let item = item?;
        let file_type = item.file_type()?;
        let is_directory = if file_type.is_dir() {
            true
        } else if file_type.is_symlink() {
            std::fs::metadata(item.path()).is_ok_and(|metadata| metadata.is_dir())
        } else {
            false
        };
        if !is_directory {
            continue;
        }
        entries.push(BrowseEntry {
            name: item.file_name().to_string_lossy().into_owned(),
            path: item.path(),
        });
    }
    entries.sort_by(|left, right| compare_directory_entry_names(&left.name, &right.name));
    let truncated = entries.len() > MAX_WORKSPACE_DIRECTORY_ENTRIES;
    entries.truncate(MAX_WORKSPACE_DIRECTORY_ENTRIES);
    Ok((entries, truncated))
}

/// The host's filesystem roots: a fixed `["/"]` everywhere but Windows,
/// where every mounted drive letter is probed once per process and cached —
/// mirrors `listFilesystemRoots`/`probeWindowsDrives`'s own `cachedRoots`
/// comment that mounted drives don't change mid-process. A
/// [`tokio::sync::OnceCell`], not a plain [`std::sync::OnceLock`], so two
/// concurrent first callers await the same probe rather than each running
/// it — the same de-duplication a shared `Promise` gives the TypeScript
/// side.
#[cfg(not(windows))]
async fn filesystem_roots() -> Vec<String> {
    vec!["/".to_string()]
}

#[cfg(windows)]
async fn filesystem_roots() -> Vec<String> {
    static ROOTS: tokio::sync::OnceCell<Vec<String>> = tokio::sync::OnceCell::const_new();
    ROOTS
        .get_or_init(|| async {
            run_blocking(|| {
                (b'A'..=b'Z')
                    .map(|letter| format!("{}:\\", letter as char))
                    .filter(|candidate| std::fs::metadata(candidate).is_ok())
                    .collect()
            })
            .await
        })
        .await
        .clone()
}

/// Every message `browseWorkspace`'s own `BROWSER_REASON_MESSAGES` table
/// declares, keyed the same way.
fn browse_reason_message(reason: &str) -> &'static str {
    match reason {
        "invalid-path" => "Directory browsing requires an absolute path.",
        "not-found" => "The requested directory does not exist.",
        "not-a-directory" => "The requested path is not a directory.",
        "permission-denied" => "The server cannot access the requested directory.",
        _ => "The requested directory could not be browsed.",
    }
}

/// Maps a [`WorkspacePathError`] from resolving `workspace.browse`'s own
/// input onto the wire shape `browseWorkspace` actually throws: every shape
/// failure becomes `kind: "workspace_browser"`, `code: "VALIDATION"`,
/// `reason: "invalid-path"` — never `kind: "workdir_validation"`, which
/// `WorkspacePathError`'s own kind on the TypeScript side never survives
/// past `browseWorkspace`'s `catch`, since it is caught there and rethrown
/// as a `WorkspaceBrowserError` instead. Only `workspace.validate` (see
/// [`build_validate_result`]) ever reports `workdir_validation` on the wire.
fn browse_path_shape_error(error: WorkspacePathError) -> RemoteError {
    match error {
        WorkspacePathError::Empty | WorkspacePathError::NotAbsolute => {
            RemoteError::new(codes::INTERNAL, browse_reason_message("invalid-path"))
                .with_detail("kind", "workspace_browser")
                .with_detail("code", "VALIDATION")
                .with_detail("reason", "invalid-path")
        }
        WorkspacePathError::Unavailable(io_error) => {
            RemoteError::new(codes::INTERNAL, io_error.to_string())
        }
    }
}

/// Maps a `std::fs::read_dir` failure onto the wire shape `browseWorkspace`
/// throws for the same failure: a recognised reason (not found, not a
/// directory, permission denied) becomes `kind: "workspace_browser"`,
/// `code: "FILESYSTEM"`; anything else is re-thrown bare, mirroring
/// `browseWorkspace`'s own `throw error` fallthrough in `filesystemReason`'s
/// caller.
fn browse_filesystem_error(io_error: std::io::Error) -> RemoteError {
    match workdir_filesystem_reason(io_error.kind()) {
        Some(reason) => RemoteError::new(codes::INTERNAL, browse_reason_message(reason))
            .with_detail("kind", "workspace_browser")
            .with_detail("code", "FILESYSTEM")
            .with_detail("reason", reason),
        None => RemoteError::new(codes::INTERNAL, io_error.to_string()),
    }
}

/// Maps an [`std::io::ErrorKind`] onto `workdir_validation`'s reason
/// vocabulary, mirroring `filesystemReason`'s `ENOENT`/`ENOTDIR`/`EACCES`/
/// `EPERM` switch. `std::io::ErrorKind::PermissionDenied` already covers
/// both `EACCES` and `EPERM` on Unix, so no `EPERM`-specific arm is needed
/// here the way `filesystemReason` needs a second `case` for it.
fn workdir_filesystem_reason(kind: std::io::ErrorKind) -> Option<&'static str> {
    match kind {
        std::io::ErrorKind::NotFound => Some("not-found"),
        std::io::ErrorKind::NotADirectory => Some("not-a-directory"),
        std::io::ErrorKind::PermissionDenied => Some("permission-denied"),
        _ => None,
    }
}

/// `workspace.validate({ path, requireAbsolute? })`: whether `path` names a
/// directory this process can read and enter, without ever throwing for an
/// ordinary "no" — only a malformed `path` itself (empty, or relative when
/// `requireAbsolute` was set) is a thrown wire error; every filesystem-level
/// "no" is a successful `{ ok: false, reason }` result.
async fn build_validate_result(params: ValidateParams) -> Result<Value, RemoteError> {
    let require_absolute = params.require_absolute.unwrap_or(false);
    let resolved =
        resolve_workspace_path(&params.path, require_absolute).map_err(workdir_validation_error)?;

    let outcome = run_blocking(move || validate_resolved_path(&resolved))
        .await
        .map_err(|io_error| RemoteError::new(codes::INTERNAL, io_error.to_string()))?;

    Ok(match outcome {
        ValidationOutcome::Ok(canonical) => json!({
            "ok": true,
            "resolvedPath": canonical.to_string_lossy(),
        }),
        ValidationOutcome::NotOk(reason) => json!({ "ok": false, "reason": reason }),
    })
}

/// Maps a [`WorkspacePathError`] from resolving `workspace.validate`'s own
/// input onto its thrown wire shape: `kind: "workdir_validation"`,
/// `code: "VALIDATION"` — `WorkspacePathError`'s own kind on the TypeScript
/// side, since `validateWorkdir` never catches it (unlike `browseWorkspace`,
/// see [`browse_path_shape_error`]).
fn workdir_validation_error(error: WorkspacePathError) -> RemoteError {
    match error {
        WorkspacePathError::Empty | WorkspacePathError::NotAbsolute => {
            RemoteError::new(codes::INTERNAL, error.to_string())
                .with_detail("kind", "workdir_validation")
                .with_detail("code", "VALIDATION")
        }
        WorkspacePathError::Unavailable(_) => RemoteError::new(codes::INTERNAL, error.to_string()),
    }
}

/// `workspace.validate`'s successful outcomes — a filesystem-level "no" is
/// one of these, never an `Err`; only an I/O failure this crate cannot
/// classify at all (see [`workdir_filesystem_reason`]) is an `Err`, which
/// [`build_validate_result`] re-throws bare.
enum ValidationOutcome {
    /// The directory's canonical form — see
    /// [`crate::workspace_path::canonical_directory`].
    Ok(PathBuf),
    NotOk(&'static str),
}

/// The blocking half of `workspace.validate`: `stat`s `path`, then — only
/// once it is confirmed to be a directory — checks read+execute access and
/// returns the directory's canonical form, the same string the external-agent
/// workspace authorization later asks the hub about.
///
/// # Platform split
/// On Unix, `access(2)` with `R_OK | X_OK` is the real check Node's own
/// `fs.access` performs. On Windows, there is no meaningful directory
/// "execute" permission bit the way Unix has one — `X_OK` there mostly
/// re-checks existence, which `stat` above has already done — so this
/// simply treats a directory `stat` already confirmed as accessible. This
/// is a narrower check than Unix gets: a directory this account cannot
/// actually list (an ACL denying list-folder-contents, say) is reported
/// `ok: true` here, where Unix's `access` call would have caught it.
fn validate_resolved_path(path: &Path) -> std::io::Result<ValidationOutcome> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            return match workdir_filesystem_reason(error.kind()) {
                Some(reason) => Ok(ValidationOutcome::NotOk(reason)),
                None => Err(error),
            };
        }
    };
    if !metadata.is_dir() {
        return Ok(ValidationOutcome::NotOk("not-a-directory"));
    }

    #[cfg(unix)]
    {
        use nix::errno::Errno;
        use nix::unistd::{AccessFlags, access};

        match access(path, AccessFlags::R_OK | AccessFlags::X_OK) {
            Ok(()) => Ok(canonical_outcome(path)),
            Err(Errno::EACCES | Errno::EPERM) => Ok(ValidationOutcome::NotOk("permission-denied")),
            Err(Errno::ENOENT) => Ok(ValidationOutcome::NotOk("not-found")),
            Err(errno) => Err(std::io::Error::from_raw_os_error(errno as i32)),
        }
    }
    #[cfg(not(unix))]
    {
        Ok(canonical_outcome(path))
    }
}

/// A directory that vanished between the access check and canonicalization
/// answers `not-found`, like one that was never there.
fn canonical_outcome(path: &Path) -> ValidationOutcome {
    crate::workspace_path::canonical_directory(path)
        .map_or(ValidationOutcome::NotOk("not-found"), ValidationOutcome::Ok)
}

/// `workspace.resolve-contained({ root, path })`: `path` resolved relative
/// to `root`, re-checked for containment after following symlinks. A thin
/// JSON-shaping layer over
/// [`crate::workspace::resolve_contained_workspace_path`] — see that
/// function's own docs for the containment policy itself, which this
/// handler never re-implements.
///
/// # The one asymmetry this handler preserves
/// [`WorkspaceContainmentError::Escaped`] is the only variant that becomes a
/// `kind: "workspace_containment"` error. [`WorkspaceContainmentError::RootUnavailable`]
/// and [`WorkspaceContainmentError::Unresolvable`] become a plain
/// `codes::INTERNAL` error with **no** `kind` detail at all — mirroring
/// `resolveContainedWorkspacePath` in `workspace.ts`, where only the
/// relative-path-escape check raises the typed `WorkspaceContainmentError`;
/// a `root` that fails to resolve is an uncaught, generic error the
/// TypeScript session never wraps at all. This is arguably an inconsistency
/// in the TypeScript reference (an unresolvable `root` and an unresolvable
/// `path` are, from a caller's point of view, both "this crate could not
/// even tell you", and it seems accidental that one gets a `kind` and the
/// other does not) — but conformance fidelity, not this handler's own
/// opinion, is what a corpus checks, so it is mirrored exactly rather than
/// "fixed" here.
///
/// Separately: `Ok(None)` and every `Unresolvable`/`RootUnavailable` case
/// here are stricter than the TypeScript reference, which answers
/// `{ relativePath: null }` for *any* `realpath` failure on the resolved
/// candidate (a symlink cycle included) rather than treating it as a thrown
/// error. That is a deliberate divergence already built into
/// [`crate::workspace::resolve_contained_workspace_path`] itself (see its
/// own module docs), not something this handler introduces or could
/// suppress without reopening the containment gap that function exists to
/// close.
async fn build_resolve_contained_result(
    params: ResolveContainedParams,
) -> Result<Value, RemoteError> {
    let root = PathBuf::from(params.root);
    let path = params.path;
    let outcome = run_blocking(move || resolve_contained_workspace_path(&root, &path)).await;

    match outcome {
        Ok(Some(relative)) => Ok(json!({ "relativePath": relative.to_string_lossy() })),
        Ok(None) => Ok(json!({ "relativePath": null })),
        Err(WorkspaceContainmentError::Escaped { requested_path }) => Err(RemoteError::new(
            codes::INTERNAL,
            format!("Invalid repository path: {requested_path}"),
        )
        .with_detail("kind", "workspace_containment")
        .with_detail("requestedPath", requested_path)),
        Err(
            error @ (WorkspaceContainmentError::RootUnavailable { .. }
            | WorkspaceContainmentError::Unresolvable { .. }),
        ) => Err(RemoteError::new(codes::INTERNAL, error.to_string())),
    }
}

// Two layers of tests: the pure logic (directory listing/filtering, the
// validate filesystem check, the error-shaping helpers) first, then the
// three `build_*_result` functions end to end (real filesystem, real JSON
// shaping, real result-schema check against the embedded catalog). Neither
// layer needs a real `CallContext` — which has no public constructor
// outside an actual dispatch (see `crate::ports::authorization`'s own test
// module for the same note) — because `register`'s closures are the only
// place one is threaded through at all, and none of the three methods
// actually uses it. `Registry::implement`'s own generic wrapper (panic
// isolation, the audit record, the exclusivity release) is proved once, for
// every registered method, by `crate::registry`'s own tests; it needs no
// second proof here.
#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use mangostudio_runtime_contract::catalog::method;

    use super::{
        BrowseParams, MAX_WORKSPACE_DIRECTORY_ENTRIES, ResolveContainedParams, ValidateParams,
        ValidationOutcome, browse_filesystem_error, browse_path_shape_error, build_browse_result,
        build_resolve_contained_result, build_validate_result, compare_directory_entry_names,
        read_workspace_directory, validate_resolved_path, workdir_validation_error,
    };
    use crate::result_check::{check_result, compile_result_schema};
    use crate::test_support::scratch_dir as scratch_root;
    use crate::workspace_path::WorkspacePathError;

    /// `compare_directory_entry_names` itself only has indirect coverage
    /// through `read_workspace_directory`'s own listing tests elsewhere in
    /// this module — this pins its own two-level ordering directly:
    /// case-insensitive first, case-sensitive as the tiebreak.
    #[test]
    fn compares_case_insensitively_then_falls_back_to_case_sensitive_order() {
        assert_eq!(
            compare_directory_entry_names("apple", "Banana"),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            compare_directory_entry_names("Apple", "apple"),
            std::cmp::Ordering::Less,
            "same name folded, so the case-sensitive tiebreak decides"
        );
        assert_eq!(
            compare_directory_entry_names("apple", "apple"),
            std::cmp::Ordering::Equal
        );
    }

    #[test]
    fn directory_listing_includes_only_directories() {
        let dir = scratch_root("dirs-only");
        std::fs::write(dir.join("file.txt"), b"").unwrap();
        std::fs::create_dir(dir.join("sub")).unwrap();

        let (entries, truncated) = read_workspace_directory(&dir).unwrap();
        assert!(!truncated);
        assert_eq!(entries.len(), 1, "a plain file must never be listed");
        assert_eq!(entries[0].name, "sub");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_to_a_directory_is_included_by_following_it() {
        let dir = scratch_root("symlink-dir");
        let real = dir.join("real");
        std::fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, dir.join("alias")).unwrap();
        // A symlink to a plain file must still be excluded — proves the
        // follow-through checks the *target's* type, not merely "is a
        // symlink, so count it".
        std::fs::write(dir.join("target.txt"), b"").unwrap();
        std::os::unix::fs::symlink(dir.join("target.txt"), dir.join("file-alias")).unwrap();

        let (entries, _truncated) = read_workspace_directory(&dir).unwrap();
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert!(
            names.contains(&"alias"),
            "a symlinked directory must be listed: {names:?}"
        );
        assert!(names.contains(&"real"));
        assert!(
            !names.contains(&"file-alias"),
            "a symlink to a plain file must not be listed: {names:?}"
        );
    }

    #[test]
    fn an_unreadable_path_is_a_plain_io_error_the_caller_maps_to_workspace_browser() {
        let missing = std::env::temp_dir().join("mango-workspace-methods-does-not-exist");
        let error = read_workspace_directory(&missing).unwrap_err();
        let mapped = browse_filesystem_error(error);
        assert_eq!(mapped.code, mango_protocol::error::codes::INTERNAL);
        let details = mapped.details.expect("details present");
        assert_eq!(details["kind"], "workspace_browser");
        assert_eq!(details["code"], "FILESYSTEM");
        assert_eq!(details["reason"], "not-found");
    }

    /// Pins the deliberate departure from a naive reading of the reference:
    /// `browseWorkspace` catches its own `WorkspacePathError` (kind
    /// `workdir_validation`) and rethrows it as a `WorkspaceBrowserError`
    /// (kind `workspace_browser`) instead — so a `workspace.browse`
    /// path-shape failure must never carry `workdir_validation` on the wire,
    /// even though the underlying [`WorkspacePathError`] variant is the
    /// exact same one `workspace.validate` reports under that other kind
    /// (see `validates_own_path_shape_failure_keeps_the_workdir_validation_kind`
    /// below).
    #[test]
    fn a_path_shape_failure_maps_to_workspace_browser_not_workdir_validation() {
        let mapped = browse_path_shape_error(WorkspacePathError::NotAbsolute);
        let details = mapped.details.expect("details present");
        assert_eq!(
            details["kind"], "workspace_browser",
            "browse must never surface workdir_validation for its own path-shape failures"
        );
        assert_eq!(details["code"], "VALIDATION");
        assert_eq!(details["reason"], "invalid-path");
        assert_eq!(
            mapped.message,
            "Directory browsing requires an absolute path."
        );
    }

    /// The distinct wire shape `workspace.validate` uses for the identical
    /// underlying [`WorkspacePathError`] — proves the two handlers really do
    /// map the same error type two different ways, not that one of them
    /// forwards to the other.
    #[test]
    fn validates_own_path_shape_failure_keeps_the_workdir_validation_kind() {
        let mapped = workdir_validation_error(WorkspacePathError::Empty);
        let details = mapped.details.expect("details present");
        assert_eq!(details["kind"], "workdir_validation");
        assert_eq!(details["code"], "VALIDATION");
        assert_eq!(mapped.message, "A directory path is required.");
    }

    #[test]
    fn validate_resolved_path_reports_ok_for_a_real_directory() {
        let dir = scratch_root("validate-ok");
        assert!(matches!(
            validate_resolved_path(&dir).unwrap(),
            ValidationOutcome::Ok(_)
        ));
    }

    #[test]
    fn validate_resolved_path_reports_not_a_directory_for_a_real_file() {
        let dir = scratch_root("validate-file");
        let file = dir.join("f.txt");
        std::fs::write(&file, b"").unwrap();
        assert!(matches!(
            validate_resolved_path(&file).unwrap(),
            ValidationOutcome::NotOk("not-a-directory")
        ));
    }

    #[test]
    fn validate_resolved_path_reports_not_found_for_a_missing_path() {
        let missing = std::env::temp_dir().join("mango-validate-missing-xyz");
        assert!(matches!(
            validate_resolved_path(&missing).unwrap(),
            ValidationOutcome::NotOk("not-found")
        ));
    }

    /// A cap that truncates an unfiltered listing (files included) would
    /// drop directories that belong well under the cap — the exact bug
    /// [`read_workspace_directory`]'s own docs describe a cap-then-filter
    /// pipeline reintroducing. More plain files than the cap, but only two
    /// real directories: both directories must still come back, untruncated.
    #[test]
    fn filtering_happens_before_the_cap_not_after() {
        let dir = scratch_root("filter-before-cap");
        // One more plain file than the cap, named so every one of them
        // sorts *before* "zz-dir": a cap-then-filter pipeline (sort, cap at
        // MAX_WORKSPACE_DIRECTORY_ENTRIES, then keep only directories) sorts
        // "zz-dir" last, the cap trims it as the one entry over the limit,
        // and the result reports `truncated: true` even though the real,
        // unfiltered directory count here is 1. Filtering to directories
        // *before* sorting and capping (what this function actually does)
        // must return "zz-dir", untruncated.
        for index in 0..=MAX_WORKSPACE_DIRECTORY_ENTRIES {
            std::fs::write(dir.join(format!("file-{index:05}.txt")), b"").unwrap();
        }
        std::fs::create_dir(dir.join("zz-dir")).unwrap();

        let (entries, truncated) = read_workspace_directory(&dir).unwrap();
        assert!(
            !truncated,
            "the real, unfiltered directory count (1) is nowhere near the cap"
        );
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, vec!["zz-dir"]);
    }

    // The remaining tests exercise the three registered handlers'
    // `build_*_result` functions end to end (real filesystem, real JSON
    // shaping, real error mapping) — the handler-level proof the pure-logic
    // tests above cannot give, since none of them build the final `Value` a
    // caller actually receives.

    #[tokio::test]
    async fn browse_defaults_to_the_home_directory_when_path_is_omitted() {
        let home = crate::runtime_home::home_dir().expect("this test host has a home directory");
        let result = build_browse_result(BrowseParams { path: None })
            .await
            .expect("this test host's home directory is browsable");
        assert_eq!(result["path"], home.to_string_lossy().into_owned());
    }

    #[tokio::test]
    async fn browse_lists_directories_only_and_flags_hidden_names() {
        let dir = scratch_root("browse-dirs");
        std::fs::write(dir.join("file.txt"), b"").unwrap();
        std::fs::create_dir(dir.join(".git")).unwrap();
        std::fs::create_dir(dir.join("src")).unwrap();

        let result = build_browse_result(BrowseParams {
            path: Some(dir.to_string_lossy().into_owned()),
        })
        .await
        .unwrap();
        let entries = result["entries"].as_array().expect("an array of entries");
        let names: Vec<&str> = entries
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            vec![".git", "src"],
            "only the two directories, never file.txt"
        );
        let git_entry = entries
            .iter()
            .find(|entry| entry["name"] == ".git")
            .unwrap();
        assert_eq!(git_entry["hidden"], true);
        let src_entry = entries.iter().find(|entry| entry["name"] == "src").unwrap();
        assert_eq!(src_entry["hidden"], false);
    }

    /// `Path::parent()` is documented to answer `None` exactly at a
    /// filesystem root — proven here against the real root rather than only
    /// through the pure-function tests above, since browsing `/` is safe and
    /// cheap (a read-only listing) and this is the one behaviour that is
    /// only meaningful at an actual root.
    #[tokio::test]
    async fn browsing_the_real_root_reports_a_null_parent() {
        let result = build_browse_result(BrowseParams {
            path: Some("/".to_string()),
        })
        .await
        .expect("the real filesystem root is browsable in this test environment");
        assert!(result["parent"].is_null());
    }

    #[tokio::test]
    async fn browse_of_a_nonexistent_path_reports_the_workspace_browser_filesystem_shape() {
        let missing = std::env::temp_dir().join("mango-browse-handler-missing-xyz");
        let error = build_browse_result(BrowseParams {
            path: Some(missing.to_string_lossy().into_owned()),
        })
        .await
        .expect_err("a nonexistent path must not browse");
        let details = error.details.expect("details present");
        assert_eq!(details["kind"], "workspace_browser");
        assert_eq!(details["code"], "FILESYSTEM");
        assert_eq!(details["reason"], "not-found");
    }

    #[tokio::test]
    async fn browse_of_a_relative_path_is_a_thrown_workspace_browser_validation_error() {
        let error = build_browse_result(BrowseParams {
            path: Some("relative/path".to_string()),
        })
        .await
        .expect_err("browse always requires an absolute path");
        let details = error.details.expect("details present");
        assert_eq!(details["kind"], "workspace_browser");
        assert_eq!(details["code"], "VALIDATION");
        assert_eq!(details["reason"], "invalid-path");
    }

    #[tokio::test]
    async fn browse_result_validates_against_its_own_catalog_schema() {
        let dir = scratch_root("browse-schema");
        let result = build_browse_result(BrowseParams {
            path: Some(dir.to_string_lossy().into_owned()),
        })
        .await
        .unwrap();
        let declared = method("workspace.browse").expect("the catalog declares workspace.browse");
        let validator = compile_result_schema(&declared.result);
        check_result("workspace.browse", &validator, &result)
            .expect("the real handler output must validate against its own schema");
    }

    #[tokio::test]
    async fn validate_reports_ok_true_for_a_real_directory() {
        let dir = scratch_root("validate-handler-ok");
        let result = build_validate_result(ValidateParams {
            path: dir.to_string_lossy().into_owned(),
            require_absolute: None,
        })
        .await
        .unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result["resolvedPath"], dir.to_string_lossy().into_owned());
    }

    #[tokio::test]
    async fn validate_reports_not_a_directory_for_a_real_file() {
        let dir = scratch_root("validate-handler-file");
        let file = dir.join("f.txt");
        std::fs::write(&file, b"").unwrap();
        let result = build_validate_result(ValidateParams {
            path: file.to_string_lossy().into_owned(),
            require_absolute: None,
        })
        .await
        .unwrap();
        assert_eq!(result["ok"], false);
        assert_eq!(result["reason"], "not-a-directory");
    }

    #[tokio::test]
    async fn validate_reports_not_found_for_a_nonexistent_path() {
        let missing = std::env::temp_dir().join("mango-validate-handler-missing-xyz");
        let result = build_validate_result(ValidateParams {
            path: missing.to_string_lossy().into_owned(),
            require_absolute: None,
        })
        .await
        .unwrap();
        assert_eq!(result["ok"], false);
        assert_eq!(result["reason"], "not-found");
    }

    /// The distinction this test exists to pin: a malformed `path` itself
    /// (relative, when `requireAbsolute` was set) is a *thrown* wire error,
    /// never the successful `{ ok: false }` shape a filesystem-level "no"
    /// uses — easy to conflate, since both are "the answer is no".
    #[tokio::test]
    async fn validate_with_require_absolute_throws_for_a_relative_path_rather_than_answering_ok_false()
     {
        let error = build_validate_result(ValidateParams {
            path: "relative/path".to_string(),
            require_absolute: Some(true),
        })
        .await
        .expect_err("a relative path with requireAbsolute must be a thrown error");
        let details = error.details.expect("details present");
        assert_eq!(details["kind"], "workdir_validation");
        assert_eq!(details["code"], "VALIDATION");
    }

    #[tokio::test]
    async fn validate_ok_true_result_validates_against_its_own_catalog_schema() {
        let dir = scratch_root("validate-schema-ok");
        let result = build_validate_result(ValidateParams {
            path: dir.to_string_lossy().into_owned(),
            require_absolute: None,
        })
        .await
        .unwrap();
        let declared =
            method("workspace.validate").expect("the catalog declares workspace.validate");
        let validator = compile_result_schema(&declared.result);
        check_result("workspace.validate", &validator, &result)
            .expect("the ok:true shape must validate against its own schema");
    }

    /// The hub stores `resolvedPath` as the chat workdir and the external-agent
    /// authority compares it byte-for-byte with the canonical directory the
    /// supervisor asks about, so a symlinked workdir must come back resolved.
    #[cfg(unix)]
    #[tokio::test]
    async fn validate_returns_the_canonical_directory_of_a_symlinked_path() {
        let dir = scratch_root("validate-symlink");
        let real = dir.join("real");
        std::fs::create_dir(&real).unwrap();
        let link = dir.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let expected = crate::workspace_path::canonical_directory(&real)
            .expect("the real directory canonicalizes");

        let result = build_validate_result(ValidateParams {
            path: link.to_string_lossy().into_owned(),
            require_absolute: Some(true),
        })
        .await
        .unwrap();

        assert_eq!(
            result["resolvedPath"],
            expected.to_string_lossy().as_ref(),
            "expected resolvedPath: canonical directory {expected:?} | received: {}",
            result["resolvedPath"]
        );
    }

    #[tokio::test]
    async fn validate_ok_false_result_validates_against_its_own_catalog_schema() {
        let missing = std::env::temp_dir().join("mango-validate-schema-missing-xyz");
        let result = build_validate_result(ValidateParams {
            path: missing.to_string_lossy().into_owned(),
            require_absolute: None,
        })
        .await
        .unwrap();
        let declared =
            method("workspace.validate").expect("the catalog declares workspace.validate");
        let validator = compile_result_schema(&declared.result);
        check_result("workspace.validate", &validator, &result)
            .expect("the ok:false shape must validate against its own schema");
    }

    // The `resolve-contained` handler-level tests below reuse the same
    // scenarios `crate::workspace`'s own tests already prove against
    // `resolve_contained_workspace_path` directly — proving here that this
    // handler's own JSON shaping and error-kind mapping are correct, which
    // those tests do not touch at all.

    #[tokio::test]
    async fn resolve_contained_reports_the_relative_path_for_a_path_inside_root() {
        let root = scratch_root("resolve-inside");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.rs"), b"fn main() {}").unwrap();

        let result = build_resolve_contained_result(ResolveContainedParams {
            root: root.to_string_lossy().into_owned(),
            path: "src/main.rs".to_string(),
        })
        .await
        .unwrap();
        // `resolve_contained_workspace_path` returns a `PathBuf` component
        // (`real_path.strip_prefix(&real_root)`), which renders with this
        // platform's own separator — mirrors `workspace.ts`'s own
        // `relative(realRoot, realPath)` (Node's `path.relative`), which
        // answers backslash-separated paths on Windows too. The catalog
        // types `relativePath` as a bare string with no separator
        // constraint, so a native-separator assertion here is the correct
        // one, not a normalized-to-forward-slash literal.
        let expected = PathBuf::from("src").join("main.rs");
        assert_eq!(
            result["relativePath"],
            expected.to_string_lossy().into_owned()
        );
    }

    #[tokio::test]
    async fn resolve_contained_reports_null_for_a_path_that_does_not_exist_yet() {
        let root = scratch_root("resolve-not-yet");
        let result = build_resolve_contained_result(ResolveContainedParams {
            root: root.to_string_lossy().into_owned(),
            path: "not-yet-created.txt".to_string(),
        })
        .await
        .unwrap();
        assert!(result["relativePath"].is_null());
    }

    #[tokio::test]
    async fn resolve_contained_throws_workspace_containment_for_a_dot_dot_escape() {
        let root = scratch_root("resolve-escape");
        let error = build_resolve_contained_result(ResolveContainedParams {
            root: root.to_string_lossy().into_owned(),
            path: "..".to_string(),
        })
        .await
        .expect_err("a `..` escape must be refused");
        let details = error.details.expect("Escaped must carry details");
        assert_eq!(details["kind"], "workspace_containment");
        assert_eq!(details["requestedPath"], "..");
        assert_eq!(error.message, "Invalid repository path: ..");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn resolve_contained_throws_workspace_containment_for_a_symlink_escape() {
        let root = scratch_root("resolve-symlink-escape");
        let outside = scratch_root("resolve-symlink-escape-target");
        std::fs::write(outside.join("secret.txt"), b"outside").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("looks-inside")).unwrap();

        let error = build_resolve_contained_result(ResolveContainedParams {
            root: root.to_string_lossy().into_owned(),
            path: "looks-inside/secret.txt".to_string(),
        })
        .await
        .expect_err("a symlink escape must be refused");
        let details = error.details.expect("Escaped must carry details");
        assert_eq!(details["kind"], "workspace_containment");
    }

    /// The asymmetry this handler must preserve: a root that fails to
    /// resolve is a bare `INTERNAL` with **no** details at all — not merely
    /// "no `kind` key", the whole `details` map is absent, matching the
    /// TypeScript reference's uncaught, unwrapped throw for the same case.
    /// This is the test the third required mutation (giving
    /// `RootUnavailable`/`Unresolvable` the same `kind` as `Escaped`) must
    /// turn red.
    #[tokio::test]
    async fn resolve_contained_root_unavailable_carries_no_details_at_all() {
        let root = scratch_root("resolve-root-vanishes");
        std::fs::remove_dir_all(&root).unwrap();

        let error = build_resolve_contained_result(ResolveContainedParams {
            root: root.to_string_lossy().into_owned(),
            path: "anything".to_string(),
        })
        .await
        .expect_err("a vanished root must refuse");
        assert!(
            error.details.is_none(),
            "a root that fails to resolve must carry no details at all, got {:?}",
            error.details
        );
    }

    #[tokio::test]
    async fn resolve_contained_result_validates_against_its_own_catalog_schema() {
        let root = scratch_root("resolve-schema");
        let result = build_resolve_contained_result(ResolveContainedParams {
            root: root.to_string_lossy().into_owned(),
            path: "not-yet-created.txt".to_string(),
        })
        .await
        .unwrap();
        let declared = method("workspace.resolve-contained")
            .expect("the catalog declares workspace.resolve-contained");
        let validator = compile_result_schema(&declared.result);
        check_result("workspace.resolve-contained", &validator, &result)
            .expect("the real handler output must validate against its own schema");
    }
}
