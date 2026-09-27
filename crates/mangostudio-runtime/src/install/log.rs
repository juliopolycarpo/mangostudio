//! Where an install run's raw log lives on this machine, and the port that writes it.
//!
//! The log holds exactly the captured child bytes, in arrival order. It is the durable record of
//! a run whose hub session went away, so it keeps growing after the output stream goes silent.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Resolves the hub-supplied `log_path` on this machine.
///
/// Mirrors `resolveInstallLogPath` in `apps/runtime/src/services/install.ts`: an absolute path is
/// used as is; `.mango/…` (the hub's remote default) lands under the user's home; anything else
/// lands under the runtime home, so a remote never writes beside whatever cwd the process had.
///
/// # Example
///
/// ```ignore
/// let path = resolve_log_path("logs/install-1.log", Path::new("/m/runtime"), Path::new("/h"));
/// assert_eq!(path, Path::new("/m/runtime/logs/install-1.log"));
/// ```
pub(crate) fn resolve_log_path(log_path: &str, runtime_home: &Path, home: &Path) -> PathBuf {
    if Path::new(log_path).is_absolute() {
        return PathBuf::from(log_path);
    }
    if log_path.starts_with(".mango/") || log_path.starts_with(".mango\\") {
        return home.join(log_path);
    }
    runtime_home.join(log_path)
}

/// Blocking log-file effects, injected so tests can stage a disk that refuses bytes.
pub(crate) trait InstallLog: Send + Sync {
    /// Creates the parent directory and an empty log, truncating an old one.
    fn prepare(&self, path: &Path) -> io::Result<()>;
    /// Appends captured bytes to the log.
    fn append(&self, path: &Path, bytes: &[u8]) -> io::Result<()>;
}

/// The production [`InstallLog`]: real files, called only on the blocking pool.
pub(crate) struct FileInstallLog;

impl InstallLog for FileInstallLog {
    fn prepare(&self, path: &Path) -> io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::File::create(path).map(drop)
    }

    fn append(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)?
            .write_all(bytes)
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{FileInstallLog, InstallLog, resolve_log_path};
    use crate::test_support::ScratchDir;

    #[test]
    fn an_absolute_log_path_is_used_as_is() {
        let absolute = std::env::temp_dir().join("install-abs.log");
        let resolved = resolve_log_path(
            absolute.to_str().unwrap(),
            Path::new("runtime-home"),
            Path::new("home"),
        );
        assert_eq!(resolved, absolute, "expected the absolute path unchanged");
    }

    #[test]
    fn a_dot_mango_path_lands_under_the_home_directory() {
        for relative in [
            ".mango/runtime/logs/install-1.log",
            ".mango\\runtime\\logs\\install-1.log",
        ] {
            let resolved = resolve_log_path(relative, Path::new("runtime-home"), Path::new("home"));
            assert_eq!(
                resolved,
                Path::new("home").join(relative),
                "expected {relative:?} under the home directory | received {resolved:?}"
            );
        }
    }

    #[test]
    fn any_other_relative_path_lands_under_the_runtime_home() {
        let resolved = resolve_log_path(
            "logs/install-1.log",
            Path::new("runtime-home"),
            Path::new("home"),
        );
        assert_eq!(
            resolved,
            Path::new("runtime-home").join("logs/install-1.log"),
            "expected the runtime home, never the process cwd | received {resolved:?}"
        );
    }

    #[test]
    fn the_file_log_truncates_on_prepare_and_appends_in_order() {
        let scratch = ScratchDir::created("install-file-log");
        let path = scratch.join("nested").join("install.log");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"stale").unwrap();

        FileInstallLog.prepare(&path).unwrap();
        FileInstallLog.append(&path, b"one\n").unwrap();
        FileInstallLog.append(&path, b"two\n").unwrap();

        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"one\ntwo\n",
            "expected a truncated log holding the appended bytes in order"
        );
    }

    #[test]
    fn prepare_creates_missing_parent_directories() {
        let scratch = ScratchDir::created("install-file-log-parents");
        let path = scratch.join("a").join("b").join("install.log");

        FileInstallLog.prepare(&path).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"", "expected an empty log");
    }
}
