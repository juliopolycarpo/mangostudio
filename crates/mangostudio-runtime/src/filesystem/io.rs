//! Synchronous bounded file operations, called only from the blocking pool.

use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use mango_protocol::error::{RemoteError, codes};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

#[derive(Debug)]
pub(super) struct Observed {
    pub bytes: Vec<u8>,
    pub mtime_ms: f64,
}

pub(super) fn path_error(message: impl Into<String>) -> RemoteError {
    RemoteError::new(codes::INTERNAL, message).with_detail("kind", "path_access")
}

pub(super) fn io_error(error: std::io::Error) -> RemoteError {
    RemoteError::new(codes::INTERNAL, error.to_string())
}

/// Gives actionable read-before-write guidance only for an unread file.
pub(super) fn explain_unread(path: &Path, action: &str, error: RemoteError) -> RemoteError {
    if !error.details.as_ref().is_some_and(|details| {
        details.get("kind").and_then(serde_json::Value::as_str) == Some("file_not_read")
    }) {
        return error;
    }
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return error;
    };
    if !metadata.is_file() {
        return error;
    }
    let size = metadata.len();
    const TEXT_LIMIT: u64 = 10 * 1024 * 1024;
    const BYTE_LIMIT: u64 = 256 * 1024;
    if size > TEXT_LIMIT {
        return path_error(format!(
            "Cannot {action} \"{}\": it is {size} bytes, past the {TEXT_LIMIT}-byte read_file limit, so the read-before-{action} guard cannot be satisfied for this path.",
            path.display()
        ));
    }
    let mut prefix = Vec::with_capacity(8192);
    if open_read(path)
        .and_then(|file| file.take(8192).read_to_end(&mut prefix))
        .is_err()
        || !super::text::looks_binary(&prefix)
    {
        return error;
    }
    if size > BYTE_LIMIT {
        return path_error(format!(
            "Cannot {action} \"{}\": it is a binary file of {size} bytes, past the {BYTE_LIMIT}-byte read_file byte-view limit, so the read-before-{action} guard cannot be satisfied for this path.",
            path.display()
        ));
    }
    path_error(format!(
        "Cannot {action} \"{}\": it is a binary file, so read_file cannot read it as text. Read it with view \"hex\" or \"base64\" first to satisfy the read-before-{action} guard.",
        path.display()
    ))
}

pub(super) fn check_cancel(cancel: &CancellationToken) -> Result<(), RemoteError> {
    if cancel.is_cancelled() {
        return Err(RemoteError::new(
            codes::CANCELLED,
            "Filesystem operation cancelled",
        ));
    }
    Ok(())
}

pub(super) fn read(
    path: &Path,
    max_bytes: usize,
    cancel: &CancellationToken,
) -> Result<Observed, RemoteError> {
    check_cancel(cancel)?;
    let mut file = open_read(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            path_error(format!("File not found: \"{}\"", path.display()))
        } else {
            io_error(error)
        }
    })?;
    let before = file.metadata().map_err(io_error)?;
    if !before.is_file() {
        return Err(path_error(format!(
            "Cannot read \"{}\": it is not a regular file.",
            path.display()
        )));
    }
    if before.len() > max_bytes as u64 {
        return Err(too_large(
            path,
            &format!("{} bytes", before.len()),
            max_bytes,
        ));
    }
    let mut bytes = Vec::with_capacity((before.len() as usize).min(max_bytes));
    let mut chunk = [0; 64 * 1024];
    loop {
        check_cancel(cancel)?;
        let remaining = (max_bytes + 1 - bytes.len()).min(chunk.len());
        if remaining == 0 {
            break;
        }
        let count = file.read(&mut chunk[..remaining]).map_err(io_error)?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    if bytes.len() > max_bytes {
        return Err(too_large(
            path,
            &format!("at least {} bytes", bytes.len()),
            max_bytes,
        ));
    }
    let after = file.metadata().map_err(io_error)?;
    let stable = before.len() == after.len() && mtime(&before) == mtime(&after);
    Ok(Observed {
        bytes,
        mtime_ms: if stable { mtime(&after) } else { f64::NAN },
    })
}

fn open_read(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Checking metadata after open binds it to the descriptor. Nonblocking
        // open prevents a FIFO replacement from wedging the worker before that check.
        options.custom_flags(nix::libc::O_NONBLOCK);
    }
    options.open(path)
}

fn too_large(path: &Path, observed: &str, max_bytes: usize) -> RemoteError {
    path_error(format!(
        "Cannot read \"{}\": file is too large ({observed}; limit is {max_bytes}).",
        path.display()
    ))
    .with_detail("limitBytes", max_bytes)
}

fn mtime(metadata: &Metadata) -> f64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(f64::NAN, |duration| duration.as_secs_f64() * 1000.0)
}

pub(super) fn current_metadata(path: &Path) -> Result<(u64, f64), RemoteError> {
    let metadata = fs::metadata(path).map_err(io_error)?;
    Ok((metadata.len(), mtime(&metadata)))
}

/// Hashes a committed file with fixed memory; callers must finish after mutation begins.
pub(super) fn hash_file(path: &Path) -> Result<String, RemoteError> {
    let mut file = open_read(path).map_err(io_error)?;
    if !file.metadata().map_err(io_error)?.is_file() {
        return Err(path_error(format!(
            "Cannot hash \"{}\": it is not a regular file.",
            path.display()
        )));
    }
    let mut hasher = Sha256::new();
    let mut chunk = [0; 64 * 1024];
    loop {
        let count = file.read(&mut chunk).map_err(io_error)?;
        if count == 0 {
            break;
        }
        hasher.update(&chunk[..count]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

pub(super) fn assert_regular(path: &Path, action: &str) -> Result<Metadata, RemoteError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            path_error(format!("File not found: \"{}\"", path.display()))
        } else {
            io_error(error)
        }
    })?;
    if !metadata.is_file() {
        return Err(path_error(format!(
            "Cannot {action} \"{}\": it is not a regular file. Directories and symbolic links are not supported.",
            path.display()
        )));
    }
    Ok(metadata)
}

/// Writes without fsync, matching the TS durability contract. The caller holds path locks.
pub(super) fn write_atomic(path: &Path, bytes: &[u8], exclusive: bool) -> Result<f64, RemoteError> {
    let parent = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(parent).map_err(io_error)?;
    if exclusive {
        return write_exclusive(path, bytes).map_err(io_error);
    }
    let mode = inspect_destination(path)?;
    let temp = temporary_path(path)?;
    write_replacement(&temp, path, bytes, mode)
}

fn write_exclusive(path: &Path, bytes: &[u8]) -> std::io::Result<f64> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let result = file
        .write_all(bytes)
        .and_then(|()| file.metadata())
        .map(|metadata| mtime(&metadata));
    drop(file);
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

/// Creates parents and publishes only to a previously absent path.
pub(super) fn create_new(path: &Path, bytes: &[u8]) -> std::io::Result<f64> {
    fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))?;
    write_exclusive(path, bytes)
}

fn inspect_destination(path: &Path) -> Result<Option<fs::Permissions>, RemoteError> {
    let metadata = match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
        Ok(metadata) => metadata,
    };
    if metadata.is_symlink() {
        let target = fs::read_link(path).ok().map_or_else(String::new, |target| {
            format!(" to \"{}\"", target.display())
        });
        return Err(path_error(format!(
            "Cannot write \"{}\": it is a symbolic link{target}. Write to the link target instead.",
            path.display()
        )));
    }
    if !metadata.is_file() {
        return Err(path_error(format!(
            "Cannot write \"{}\": the path exists and is not a regular file.",
            path.display()
        )));
    }
    #[cfg(unix)]
    let writable = {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o222 != 0
            && nix::unistd::access(path, nix::unistd::AccessFlags::W_OK).is_ok()
    };
    #[cfg(not(unix))]
    let writable = !metadata.permissions().readonly();
    if !writable {
        return Err(path_error(format!(
            "Cannot write \"{}\": the file is not writable.",
            path.display()
        )));
    }
    Ok(Some(metadata.permissions()))
}

fn temporary_path(path: &Path) -> Result<PathBuf, RemoteError> {
    let mut random = [0; 8];
    getrandom::fill(&mut random)
        .map_err(|error| RemoteError::new(codes::INTERNAL, error.to_string()))?;
    let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let mut name = std::ffi::OsString::from(".");
    name.push(path.file_name().unwrap_or_default());
    name.push(format!(".{suffix}.tmp"));
    Ok(path.with_file_name(name))
}

fn write_replacement(
    temp: &Path,
    path: &Path,
    bytes: &[u8],
    mode: Option<fs::Permissions>,
) -> Result<f64, RemoteError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temp)
        .map_err(io_error)?;
    let prepared = (|| {
        file.write_all(bytes)?;
        if let Some(mode) = mode {
            file.set_permissions(mode)?;
        }
        file.metadata().map(|metadata| mtime(&metadata))
    })();
    drop(file);
    let result = prepared.and_then(|mtime| fs::rename(temp, path).map(|()| mtime));
    if result.is_err() {
        // Only this successful create_new owns cleanup. A name collision must
        // never remove another writer's temporary file.
        let _ = fs::remove_file(temp);
    }
    result.map_err(io_error)
}

pub(super) fn move_no_overwrite(from: &Path, to: &Path) -> Result<(), RemoteError> {
    let metadata = assert_regular(from, "move")?;
    fs::create_dir_all(to.parent().unwrap_or(Path::new("."))).map_err(io_error)?;
    match fs::hard_link(from, to) {
        Ok(()) => {}
        Err(error) if link_unsupported(&error) => copy_exclusive(from, to, metadata.permissions())?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(path_error(format!(
                "\"{}\" already exists. Choose a different destination.",
                to.display()
            )));
        }
        Err(error) => return Err(io_error(error)),
    }
    if let Err(error) = fs::remove_file(from) {
        if fs::remove_file(to).is_err() {
            return Err(incomplete_move_error(from, to));
        }
        return Err(io_error(error));
    }
    Ok(())
}

fn incomplete_move_error(from: &Path, to: &Path) -> RemoteError {
    path_error(format!(
        "Could not complete the move from \"{}\" to \"{}\", and cleanup also failed. Both paths may exist.",
        from.display(),
        to.display()
    ))
    .with_detail("pathsMayHaveChanged", true)
}

fn link_unsupported(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::CrossesDevices
            | std::io::ErrorKind::PermissionDenied
            | std::io::ErrorKind::Unsupported
            | std::io::ErrorKind::TooManyLinks
    )
}

fn copy_exclusive(from: &Path, to: &Path, permissions: fs::Permissions) -> Result<(), RemoteError> {
    let mut source = open_read(from).map_err(io_error)?;
    if !source.metadata().map_err(io_error)?.is_file() {
        return Err(io_error(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "Cannot move \"{}\": expected a regular file.",
                from.display()
            ),
        )));
    }
    let mut destination = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(to)
        .map_err(io_error)?;
    let result = std::io::copy(&mut source, &mut destination)
        .and_then(|_| destination.set_permissions(permissions))
        .map(|_| ());
    drop(destination);
    finish_exclusive_copy(from, to, result, |path| fs::remove_file(path))
}

fn finish_exclusive_copy(
    from: &Path,
    to: &Path,
    result: std::io::Result<()>,
    cleanup: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<(), RemoteError> {
    let Err(error) = result else {
        return Ok(());
    };
    if cleanup(to).is_err() {
        return Err(incomplete_move_error(from, to));
    }
    Err(io_error(error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::scratch_dir;

    #[test]
    fn unread_diagnostics_name_satisfiable_binary_views_and_impossible_size_limits() {
        let dir = scratch_dir("fs-unread-guidance");
        let path = dir.join("file");
        let unread = || super::super::freshness::file_not_read_error(&path);
        fs::write(&path, b"text").unwrap();
        assert_eq!(
            explain_unread(&path, "edit", unread()).message,
            unread().message
        );
        fs::write(&path, b"\0binary").unwrap();
        let binary = explain_unread(&path, "edit", unread());
        assert!(
            binary
                .message
                .contains("Read it with view \"hex\" or \"base64\" first")
        );
        assert_eq!(binary.details.unwrap()["kind"], "path_access");
        OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(256 * 1024 + 1)
            .unwrap();
        let large_binary = explain_unread(&path, "delete", unread());
        assert!(
            large_binary
                .message
                .contains("past the 262144-byte read_file byte-view limit")
        );
        OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(10 * 1024 * 1024 + 1)
            .unwrap();
        let large_text = explain_unread(&path, "overwrite", unread());
        assert!(
            large_text
                .message
                .contains("past the 10485760-byte read_file limit")
        );
        let stale = super::super::freshness::stale_file_error(&path);
        assert_eq!(explain_unread(&path, "edit", stale.clone()), stale);
    }

    #[test]
    fn descriptor_read_bounds_observed_bytes_and_checks_cancellation() {
        let dir = scratch_dir("fs-io-read");
        let path = dir.join("file");
        fs::write(&path, b"abc").unwrap();
        let token = CancellationToken::new();
        let observed = read(&path, 3, &token).unwrap();
        assert_eq!(observed.bytes, b"abc");
        assert!(observed.mtime_ms.is_finite());
        assert_eq!(current_metadata(&path).unwrap(), (3, observed.mtime_ms));
        assert!(
            read(&path, 2, &token)
                .unwrap_err()
                .message
                .contains("limit is 2")
        );
        token.cancel();
        assert_eq!(read(&path, 3, &token).unwrap_err().code, codes::CANCELLED);
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_is_refused_without_waiting_for_a_writer() {
        let dir = scratch_dir("fs-fifo-read");
        let path = dir.join("fifo");
        nix::unistd::mkfifo(
            &path,
            nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
        )
        .unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let read_path = path.clone();
        let reader = std::thread::spawn(move || {
            send.send(read(&read_path, 1024, &CancellationToken::new()))
                .unwrap();
        });
        let result = receive.recv_timeout(std::time::Duration::from_secs(1));
        if result.is_err() {
            // Release a regressed blocking open before failing, so the test
            // never leaves an unjoinable worker in the test process.
            drop(OpenOptions::new().write(true).open(&path).unwrap());
            reader.join().unwrap();
            panic!("a non-regular file blocked the reader waiting for a writer");
        }
        reader.join().unwrap();
        assert!(
            result
                .unwrap()
                .unwrap_err()
                .message
                .contains("not a regular file")
        );
        assert!(
            hash_file(&path)
                .unwrap_err()
                .message
                .contains("not a regular file")
        );
        let destination = dir.join("copy");
        assert!(
            copy_exclusive(
                &path,
                &destination,
                fs::metadata(&path).unwrap().permissions()
            )
            .unwrap_err()
            .message
            .contains("expected a regular file")
        );
        assert!(!destination.exists());
    }

    #[test]
    fn atomic_replacement_and_exclusive_creation_preserve_contents() {
        let dir = scratch_dir("fs-io-write");
        let path = dir.join("parent/file");
        assert!(write_atomic(&path, b"first", true).unwrap().is_finite());
        assert!(write_atomic(&path, b"other", true).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"first");
        write_atomic(&path, b"second", false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn replacement_cleanup_removes_only_the_temporary_file_it_created() {
        let dir = scratch_dir("fs-replacement-cleanup");
        let temp = dir.join("temporary");
        let destination = dir.join("destination");
        fs::write(&temp, b"another writer").unwrap();
        assert!(write_replacement(&temp, &destination, b"ours", None).is_err());
        assert_eq!(fs::read(&temp).unwrap(), b"another writer");
        fs::remove_file(&temp).unwrap();
        fs::create_dir(&destination).unwrap();
        assert!(write_replacement(&temp, &destination, b"ours", None).is_err());
        assert!(!temp.exists());
        assert!(destination.is_dir());
    }

    #[test]
    fn move_and_copy_never_replace_an_existing_destination() {
        let dir = scratch_dir("fs-io-move");
        let from = dir.join("from");
        let to = dir.join("nested/to");
        fs::write(&from, b"bytes").unwrap();
        move_no_overwrite(&from, &to).unwrap();
        assert!(!from.exists());
        fs::write(&from, b"keep").unwrap();
        assert!(move_no_overwrite(&from, &to).is_err());
        assert!(copy_exclusive(&from, &to, fs::metadata(&from).unwrap().permissions()).is_err());
        assert_eq!(fs::read(&to).unwrap(), b"bytes");
        assert_eq!(
            hash_file(&to).unwrap(),
            "277089d91c0bdf4f2e6862ba7e4a07605119431f5d13f726dd352b06f1b206a9"
        );
        let copied = dir.join("copy");
        copy_exclusive(&from, &copied, fs::metadata(&from).unwrap().permissions()).unwrap();
        assert_eq!(fs::read(copied).unwrap(), b"keep");
        assert!(link_unsupported(&std::io::Error::from(
            std::io::ErrorKind::CrossesDevices
        )));
        let incomplete = incomplete_move_error(&from, &to);
        assert_eq!(incomplete.details.unwrap()["pathsMayHaveChanged"], true);

        fn cleanup_refused(_: &Path) -> std::io::Result<()> {
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        }
        let incomplete = finish_exclusive_copy(
            &from,
            &to,
            Err(std::io::Error::from(std::io::ErrorKind::WriteZero)),
            cleanup_refused,
        )
        .unwrap_err();
        assert_eq!(incomplete.details.unwrap()["pathsMayHaveChanged"], true);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_and_readonly_writes_and_preserves_modes() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = scratch_dir("fs-io-mode");
        let path = dir.join("file");
        fs::write(&path, b"before").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        write_atomic(&path, b"after", false).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        let link = dir.join("link");
        symlink(&path, &link).unwrap();
        assert!(assert_regular(&link, "delete").is_err());
        assert!(write_atomic(&link, b"wrong", false).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
        assert!(write_atomic(&path, b"wrong", false).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"after");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    }
}
