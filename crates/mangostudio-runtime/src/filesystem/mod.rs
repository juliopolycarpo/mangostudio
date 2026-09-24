//! Filesystem operations and their byte-preserving helpers.

mod capability;
pub mod freshness;
mod io;
mod params;
mod patch;
mod patch_apply;
mod policy;
mod search;
mod service;
mod snapshot;
mod text;

/// The Win32 spelling of a canonical Windows path, shared with external-agent
/// workspace admission so both surfaces compare the same form.
#[cfg(windows)]
pub(crate) use policy::normalize_windows_final_path;
pub(crate) use service::register;

/// Why [`open_contained_file`] refused a path.
#[derive(Debug)]
pub(crate) enum ContainedOpenError {
    /// The path, or the object its opened handle actually names, resolves
    /// outside the containment root — including a symlink swapped in
    /// between the caller's check and this open.
    Outside,
    /// The path could not be opened for another reason (missing,
    /// permission, not openable); the message names it.
    Unopenable(String),
}

/// Opens `path` for reading exactly once and returns the handle only when
/// the handle's final host path lies inside `containment_root`.
///
/// This is the filesystem methods' own contained-open primitive (policy
/// check, non-blocking open, final-handle-path check) exposed for another
/// method group: `library.*` reads user agent homes through it so a path
/// swapped between its containment check and the read cannot escape, which
/// a realpath-then-open sequence cannot promise.
///
/// # Example
///
/// ```ignore
/// let file = open_contained_file(Path::new("/home/u/.claude"), Path::new("/home/u/.claude/CLAUDE.md"))?;
/// ```
pub(crate) fn open_contained_file(
    containment_root: &std::path::Path,
    path: &std::path::Path,
) -> Result<std::fs::File, ContainedOpenError> {
    let policy = policy::PathPolicy {
        allowed_roots: Vec::new(),
        denied_roots: Vec::new(),
        containment_root: Some(containment_root.to_path_buf()),
    };
    let classify = |error: mango_protocol::RemoteError| {
        let outside = error
            .details
            .as_ref()
            .and_then(|details| details.get("kind"))
            .and_then(serde_json::Value::as_str)
            == Some("path_access");
        if outside {
            ContainedOpenError::Outside
        } else {
            ContainedOpenError::Unopenable(error.message)
        }
    };
    let compiled = policy.compile().map_err(classify)?;
    capability::open_existing_file(&compiled, path).map_err(classify)
}
