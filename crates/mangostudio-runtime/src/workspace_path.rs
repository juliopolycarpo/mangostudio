//! Deciding what a workspace path *input string* means, before either
//! [`crate::workspace::resolve_contained_workspace_path`] (containment) or a
//! plain filesystem check ever sees it.
//!
//! Mirrors `apps/shared/src/workspaces/path.ts`'s `resolveWorkspacePath`:
//! reject an empty (or all-whitespace) input, expand a leading `~` against
//! this account's home directory, reject a relative result when the caller
//! requires an absolute one, then lexically resolve the remainder against
//! the current working directory. This is *not* a second containment
//! policy — it never resolves a symlink or reasons about a workspace root;
//! see [`crate::workspace`]'s module docs for that half, which every one of
//! this module's outputs still has to pass through afterwards.

use std::path::PathBuf;

use crate::runtime_home::home_dir;
use crate::workspace::lexically_normalize;

/// Why a workspace path input could not be resolved to a usable path.
#[derive(Debug)]
pub enum WorkspacePathError {
    /// The input was empty, or entirely whitespace.
    Empty,
    /// The caller required an absolute path but, after `~` expansion, the
    /// input was not one.
    NotAbsolute,
    /// This account's home directory (needed to expand `~`, or to resolve a
    /// relative input against the current working directory) could not be
    /// determined or read — an OS-level failure, not a question of the
    /// input's own shape. `apps/shared/src/workspaces/path.ts` has no
    /// equivalent case: Node's `os.homedir()` and `path.resolve()` do not
    /// fail this way in practice, so its reference behaviour has nothing to
    /// mirror here.
    Unavailable(std::io::Error),
}

impl std::fmt::Display for WorkspacePathError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkspacePathError::Empty => write!(formatter, "A directory path is required."),
            WorkspacePathError::NotAbsolute => write!(formatter, "An absolute path is required."),
            WorkspacePathError::Unavailable(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for WorkspacePathError {}

/// Expands a leading `~` (bare, or followed by `/` or `\`) against this
/// account's home directory; every other input passes through unchanged.
/// Mirrors `expandHome` in `path.ts` exactly, including accepting either
/// separator after the tilde.
fn expand_home(path: &str) -> Result<PathBuf, WorkspacePathError> {
    if path == "~" {
        return home_dir().map_err(WorkspacePathError::Unavailable);
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        let home = home_dir().map_err(WorkspacePathError::Unavailable)?;
        return Ok(home.join(rest));
    }
    Ok(PathBuf::from(path))
}

/// Resolves `path` to a usable, absolute path.
///
/// Trims only to test for emptiness — the returned path is built from the
/// untrimmed input, matching `path.ts` exactly, so leading or trailing
/// whitespace that is genuinely part of a path is never silently stripped
/// (Windows is the one exception: `GetFullPathNameW`, which
/// `std::path::absolute` calls there, strips trailing whitespace itself,
/// same as Node's own `path.resolve` on that platform). Expands a leading
/// `~`, rejects a relative result when `require_absolute` is set, then
/// lexically resolves the remainder against the current working directory:
/// on Unix, `std::path::absolute` alone only folds `.` and empty
/// components, never `..`, so `lexically_normalize` (this crate's own
/// escape-detection helper, reused here for the unrelated job of plain
/// lexical resolution) runs on top of it to match Node's `path.resolve()`
/// there; on Windows, `GetFullPathNameW` already folds `..` itself, so the
/// second pass is a no-op rather than a second, disagreeing normalisation.
///
/// `require_absolute` is checked with [`std::path::Path::has_root`], not
/// [`std::path::Path::is_absolute`]: a Windows path rooted with no drive
/// prefix (like `\Users\ada`) has a root, and is what Node's own
/// `path.isAbsolute` calls absolute, but `Path::is_absolute` calls it
/// relative — the same trap `crate::workspace`'s own symlink-target split
/// documents.
///
/// # Errors
/// [`WorkspacePathError::Empty`] for an empty or all-whitespace input.
/// [`WorkspacePathError::NotAbsolute`] when `require_absolute` is set and the
/// (possibly `~`-expanded) input is not absolute.
/// [`WorkspacePathError::Unavailable`] when this account's home directory
/// could not be determined.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::workspace_path::resolve_workspace_path;
///
/// // Built from `std::env::temp_dir()` rather than a hard-coded `/tmp/...`
/// // so this example is meaningful on Windows too.
/// let base = std::env::temp_dir();
/// let input = base.join("a").join("..").join("b");
/// let resolved = resolve_workspace_path(&input.to_string_lossy(), true).unwrap();
/// assert_eq!(resolved, base.join("b"));
///
/// assert!(resolve_workspace_path("   ", true).is_err());
/// assert!(resolve_workspace_path("relative/path", true).is_err());
/// ```
pub fn resolve_workspace_path(
    path: &str,
    require_absolute: bool,
) -> Result<PathBuf, WorkspacePathError> {
    if path.trim().is_empty() {
        return Err(WorkspacePathError::Empty);
    }
    let expanded = expand_home(path)?;
    if require_absolute && !expanded.has_root() {
        return Err(WorkspacePathError::NotAbsolute);
    }
    let absolute = std::path::absolute(&expanded).map_err(WorkspacePathError::Unavailable)?;
    Ok(lexically_normalize(&absolute))
}

#[cfg(test)]
mod tests {
    use super::{WorkspacePathError, resolve_workspace_path};

    #[test]
    fn an_empty_input_is_refused() {
        assert!(matches!(
            resolve_workspace_path("", true),
            Err(WorkspacePathError::Empty)
        ));
        assert!(matches!(
            resolve_workspace_path("   ", false),
            Err(WorkspacePathError::Empty)
        ));
    }

    #[test]
    fn a_relative_input_is_refused_only_when_absolute_is_required() {
        assert!(matches!(
            resolve_workspace_path("relative/path", true),
            Err(WorkspacePathError::NotAbsolute)
        ));
        assert!(resolve_workspace_path("relative/path", false).is_ok());
    }

    #[test]
    fn a_dot_dot_is_lexically_folded_against_an_absolute_input() {
        let base = std::env::temp_dir();
        let input = base.join("a").join("..").join("b");
        let resolved = resolve_workspace_path(&input.to_string_lossy(), true).unwrap();
        assert_eq!(resolved, base.join("b"));
    }

    #[test]
    fn a_bare_tilde_expands_to_the_home_directory() {
        let resolved = resolve_workspace_path("~", true).unwrap();
        assert_eq!(resolved, crate::runtime_home::home_dir().unwrap());
    }

    #[test]
    fn a_tilde_slash_prefix_expands_and_joins_the_remainder() {
        let resolved = resolve_workspace_path("~/projects", true).unwrap();
        assert_eq!(
            resolved,
            crate::runtime_home::home_dir().unwrap().join("projects")
        );
    }

    /// The exact regression this module's docs call out: whitespace that is
    /// genuinely part of the path must survive, not be trimmed away — only
    /// the emptiness *test* trims. Trailing (not leading) whitespace is used
    /// here so the input stays absolute and this is not also exercising
    /// `require_absolute`'s own check. Unix only: `GetFullPathNameW` (which
    /// `std::path::absolute` calls on Windows) strips trailing whitespace
    /// itself, so this property does not hold there — see this module's
    /// own doc comment on [`resolve_workspace_path`].
    #[cfg(unix)]
    #[test]
    fn surrounding_whitespace_that_is_not_the_whole_input_is_preserved() {
        let resolved = resolve_workspace_path("/tmp/padded ", true).unwrap();
        assert_eq!(resolved, std::path::PathBuf::from("/tmp/padded "));
    }
}
