//! The filesystem seam the library readers take, mirroring
//! `LibraryInstanceReaderFs` in `instance-reader.ts` (list, resolve, stat,
//! read) so a test can count reads or fault one step without a real disk.
//!
//! The native implementation reads through
//! [`crate::filesystem::open_contained_file`] whenever the caller names a
//! containment root: the file is opened once and refused unless the opened
//! handle's own final path is inside that root, so a symlink swapped in
//! after the caller's `real_path` check still cannot redirect the read.

use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::filesystem::{ContainedOpenError, open_contained_file};

/// What a scan needs from `stat` (symlinks followed, as Node's `stat`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct FileMeta {
    pub size: u64,
    /// `mtimeMs`: milliseconds since the epoch, fractional.
    pub mtime_ms: f64,
    pub is_file: bool,
    pub is_dir: bool,
}

/// Why a bounded read produced no bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReadFailure {
    /// The opened object resolves outside the containment root.
    Outside,
    /// The object holds more than the caller's byte cap.
    TooLarge,
    /// Anything else: missing, permission, not a regular file.
    Unreadable(String),
}

/// See the module docs.
pub(crate) trait LibraryFs: Send + Sync {
    /// Entry names directly under `path`, in the order the OS lists them.
    fn read_dir(&self, path: &Path) -> std::io::Result<Vec<OsString>>;
    /// `realpath`.
    fn real_path(&self, path: &Path) -> std::io::Result<PathBuf>;
    /// `stat`, following symlinks.
    fn stat(&self, path: &Path) -> std::io::Result<FileMeta>;
    /// Reads at most `max_bytes` from the regular file at `path`, contained
    /// to `root` when one is given; more than `max_bytes` is
    /// [`ReadFailure::TooLarge`], never a silent truncation.
    fn read_file(
        &self,
        root: Option<&Path>,
        path: &Path,
        max_bytes: u64,
    ) -> Result<Vec<u8>, ReadFailure>;
}

/// The real machine.
pub(crate) struct NativeLibraryFs;

impl LibraryFs for NativeLibraryFs {
    fn read_dir(&self, path: &Path) -> std::io::Result<Vec<OsString>> {
        std::fs::read_dir(path)?
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect()
    }

    fn real_path(&self, path: &Path) -> std::io::Result<PathBuf> {
        canonicalize(path)
    }

    fn stat(&self, path: &Path) -> std::io::Result<FileMeta> {
        let metadata = std::fs::metadata(path)?;
        Ok(FileMeta {
            size: metadata.len(),
            mtime_ms: mtime_ms(&metadata),
            is_file: metadata.is_file(),
            is_dir: metadata.is_dir(),
        })
    }

    fn read_file(
        &self,
        root: Option<&Path>,
        path: &Path,
        max_bytes: u64,
    ) -> Result<Vec<u8>, ReadFailure> {
        let file = match root {
            Some(root) => open_contained_file(root, path).map_err(|error| match error {
                ContainedOpenError::Outside => ReadFailure::Outside,
                ContainedOpenError::Unopenable(message) => ReadFailure::Unreadable(message),
            })?,
            None => open_nonblocking(path)
                .map_err(|error| ReadFailure::Unreadable(format!("{}: {error}", path.display())))?,
        };
        read_regular_bounded(file, path, max_bytes)
    }
}

/// `realpath` as Node spells it: [`std::fs::canonicalize`], with a Windows
/// verbatim drive or UNC prefix (`\\?\C:\`, `\\?\UNC\`) simplified to
/// its Win32 form. Inside a verbatim path `/` is not a separator, so joining
/// a scan's posix-style relative path onto one would name nothing; the
/// simplified form also matches the paths the TypeScript host reports.
pub(crate) fn canonicalize(path: &Path) -> std::io::Result<PathBuf> {
    let canonical = std::fs::canonicalize(path)?;
    if !cfg!(windows) {
        return Ok(canonical);
    }
    Ok(canonical
        .to_str()
        .and_then(simplify_verbatim)
        .map_or(canonical.clone(), PathBuf::from))
}

/// On Windows, the Win32 spelling of an already-canonical verbatim path
/// (see [`canonicalize`]); `None` elsewhere, or when there is nothing to
/// simplify.
pub(crate) fn simplify_verbatim_path(path: &str) -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    simplify_verbatim(path)
}

/// The Win32 spelling of a verbatim drive or UNC path, or `None` for any
/// other path (including verbatim forms with no Win32 equivalent, such as a
/// volume GUID).
fn simplify_verbatim(path: &str) -> Option<String> {
    let rest = path.strip_prefix(r"\\?\")?;
    if let Some(unc) = rest.strip_prefix(r"UNC\") {
        return Some(format!(r"\\{unc}"));
    }
    let bytes = rest.as_bytes();
    let drive =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\';
    drive.then(|| rest.to_string())
}

/// Joins a posix-separated relative path one segment at a time, so it names
/// the same file under any root spelling.
pub(crate) fn join_relative(root: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(root.to_path_buf(), |path, segment| path.join(segment))
}

/// Opens without blocking on a FIFO swapped in for a regular file; the
/// caller's `fstat` check refuses anything that is not one.
pub(crate) fn open_nonblocking(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(nix::libc::O_NONBLOCK);
    }
    options.open(path)
}

/// `fstat`s the open handle, refuses a non-regular file, and reads at most
/// `max_bytes + 1` so an over-cap file is detected without loading it.
pub(crate) fn read_regular_bounded(
    file: File,
    path: &Path,
    max_bytes: u64,
) -> Result<Vec<u8>, ReadFailure> {
    let metadata = file
        .metadata()
        .map_err(|error| ReadFailure::Unreadable(format!("{}: {error}", path.display())))?;
    if !metadata.is_file() {
        return Err(ReadFailure::Unreadable(format!(
            "{} is not a regular file",
            path.display()
        )));
    }
    if metadata.len() > max_bytes {
        return Err(ReadFailure::TooLarge);
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| ReadFailure::Unreadable(format!("{}: {error}", path.display())))?;
    if bytes.len() as u64 > max_bytes {
        return Err(ReadFailure::TooLarge);
    }
    Ok(bytes)
}

/// `stats.mtimeMs`.
pub(crate) fn mtime_ms(metadata: &std::fs::Metadata) -> f64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |duration| {
            duration.as_secs() as f64 * 1000.0 + f64::from(duration.subsec_nanos()) / 1_000_000.0
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_drive_and_unc_paths_simplify_to_win32_spellings() {
        assert_eq!(
            simplify_verbatim(r"\\?\C:\Users\u").as_deref(),
            Some(r"C:\Users\u")
        );
        assert_eq!(
            simplify_verbatim(r"\\?\UNC\srv\share\x").as_deref(),
            Some(r"\\srv\share\x")
        );
        assert_eq!(simplify_verbatim(r"\\?\Volume{abc}\x"), None);
        // A verbatim path is only a drive path with a letter, a colon, and a separator.
        assert_eq!(simplify_verbatim(r"\\?\ab\c"), None);
        assert_eq!(simplify_verbatim(r"\\?\a:b"), None);
        assert_eq!(simplify_verbatim(r"C:\Users\u"), None);
        assert_eq!(simplify_verbatim("/home/u"), None);
    }

    #[test]
    fn relative_paths_join_segment_by_segment() {
        let joined = join_relative(Path::new("root"), "references/a.md");
        assert_eq!(joined, Path::new("root").join("references").join("a.md"));
    }
}
