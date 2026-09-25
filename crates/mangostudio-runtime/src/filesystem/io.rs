//! Synchronous bounded file operations, called only from the blocking pool.

use std::ffi::OsString;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[cfg(all(test, target_os = "linux"))]
use cap_fs_ext::MetadataExt as _;
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt as _};
use cap_std::fs::{OpenOptions as CapOpenOptions, Permissions as CapPermissions};
use mango_protocol::error::{RemoteError, codes};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::capability::{self, VerifiedParent};
use super::policy::CompiledPolicy;
use super::service::{BYTE_VIEW_MAX_BYTES, READ_MAX_BYTES};
use crate::file_identity::{ObjectIdentity, object_identity};

#[derive(Debug)]
pub(super) struct Observed {
    pub bytes: Vec<u8>,
    pub mtime_ms: f64,
}

/// Metadata needed by filesystem operations after a regular-file check.
#[derive(Debug)]
pub(super) struct FileInfo {
    pub(super) len: u64,
}

struct PathMetadata {
    is_file: bool,
    len: u64,
}

struct ExpectedDestination<'a> {
    bytes: &'a [u8],
    identity: ObjectIdentity,
}

pub(super) fn path_error(message: impl Into<String>) -> RemoteError {
    RemoteError::new(codes::INTERNAL, message).with_detail("kind", "path_access")
}

/// Refuses a target whose existing `ancestor` is not a directory, carrying
/// the blocker in `notDirectoryParent` so a caller can name it in its own
/// words.
///
/// # Example
///
/// ```ignore
/// return Err(not_directory_parent_error(target, Path::new("/work/notes.txt")));
/// ```
pub(super) fn not_directory_parent_error(target: &Path, ancestor: &Path) -> RemoteError {
    path_error(format!(
        "Cannot create \"{}\": parent \"{}\" is not a directory.",
        target.display(),
        ancestor.display()
    ))
    .with_detail("notDirectoryParent", ancestor.to_string_lossy().as_ref())
}

/// Maps a failed parent creation for `target`, naming the nearest existing
/// ancestor when it is not a directory instead of surfacing the raw OS error.
fn parent_creation_error(target: &Path, parent: &Path, error: std::io::Error) -> RemoteError {
    let blocker = parent
        .ancestors()
        .find_map(|ancestor| fs::metadata(ancestor).ok().map(|found| (ancestor, found)));
    match blocker {
        Some((ancestor, metadata)) if !metadata.is_dir() => {
            not_directory_parent_error(target, ancestor)
        }
        _ => io_error(error),
    }
}

pub(super) fn io_error(error: std::io::Error) -> RemoteError {
    RemoteError::new(codes::INTERNAL, error.to_string())
}

fn file_not_found(path: &Path) -> RemoteError {
    path_error(format!("File not found: \"{}\"", path.display()))
}

fn is_missing_path_error(error: &RemoteError) -> bool {
    error.message.starts_with("File not found:")
        || error.message.starts_with("Filesystem object not found:")
}

/// Whether an I/O helper found no filesystem object at its requested path.
pub(super) fn is_not_found(error: &RemoteError) -> bool {
    error.details.as_ref().is_some_and(|details| {
        details.get("notFound").and_then(serde_json::Value::as_bool) == Some(true)
    }) || is_missing_path_error(error)
}

/// Gives actionable read-before-write guidance only for an unread file.
pub(super) fn explain_unread(
    policy: &CompiledPolicy,
    path: &Path,
    action: &str,
    error: RemoteError,
) -> RemoteError {
    if !error.details.as_ref().is_some_and(|details| {
        details.get("kind").and_then(serde_json::Value::as_str) == Some("file_not_read")
    }) {
        return error;
    }
    let Ok(metadata) = metadata_for_diagnostic(policy, path) else {
        return error;
    };
    if !metadata.is_file {
        return error;
    }
    let size = metadata.len;
    if size > READ_MAX_BYTES as u64 {
        return path_error(format!(
            "Cannot {action} \"{}\": it is {size} bytes, past the {READ_MAX_BYTES}-byte read_file limit, so the read-before-{action} guard cannot be satisfied for this path.",
            path.display()
        ));
    }
    let mut prefix = Vec::with_capacity(8192);
    if open_read_scoped(policy, path)
        .and_then(|file| file.take(8192).read_to_end(&mut prefix).map_err(io_error))
        .is_err()
        || !super::text::looks_binary(&prefix)
    {
        return error;
    }
    if size > BYTE_VIEW_MAX_BYTES as u64 {
        return path_error(format!(
            "Cannot {action} \"{}\": it is a binary file of {size} bytes, past the {BYTE_VIEW_MAX_BYTES}-byte read_file byte-view limit, so the read-before-{action} guard cannot be satisfied for this path.",
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
    policy: &CompiledPolicy,
    path: &Path,
    max_bytes: usize,
    cancel: &CancellationToken,
) -> Result<Observed, RemoteError> {
    check_cancel(cancel)?;
    let mut file = open_read_scoped(policy, path).map_err(|error| {
        if is_missing_path_error(&error) {
            file_not_found(path)
        } else {
            error
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

/// Opens a path for reading without blocking on a FIFO, before its handle
/// and type are checked by the caller.
///
/// # Example
///
/// ```ignore
/// let file = open_read(path).map_err(io_error)?;
/// ```
pub(super) fn open_read(path: &Path) -> std::io::Result<File> {
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

fn open_read_scoped(policy: &CompiledPolicy, path: &Path) -> Result<File, RemoteError> {
    if policy.is_unrestricted() {
        return open_read(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                file_not_found(path)
            } else {
                io_error(error)
            }
        });
    }
    capability::open_existing_file(policy, path)
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

pub(super) fn current_metadata(
    policy: &CompiledPolicy,
    path: &Path,
) -> Result<(u64, f64), RemoteError> {
    let metadata = open_read_scoped(policy, path)
        .map_err(|error| {
            if is_missing_path_error(&error) {
                file_not_found(path)
            } else {
                error
            }
        })?
        .metadata()
        .map_err(io_error)?;
    Ok((metadata.len(), mtime(&metadata)))
}

/// Checks for a regular file through a verified parent without following a link.
///
/// # Example
///
/// ```ignore
/// if path_is_file(&policy, destination)? { /* preserve existing content */ }
/// ```
pub(super) fn path_is_file(policy: &CompiledPolicy, path: &Path) -> Result<bool, RemoteError> {
    if policy.is_unrestricted() {
        return Ok(path.is_file());
    }
    let Some(parent) = capability::verified_parent_if_present(policy, path)? else {
        return Ok(false);
    };
    parent.with_parent(|dir, leaf| match dir.symlink_metadata(leaf) {
        Ok(metadata) => Ok(metadata.is_file()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(error)),
    })
}

/// Checks whether a path resolves to a regular file without opening it.
///
/// Callers still open through the capability after this classification, so the
/// metadata result cannot authorize a later operation by itself.
fn resolved_path_is_file(policy: &CompiledPolicy, path: &Path) -> Result<bool, RemoteError> {
    policy.check(path)?;
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.is_file()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(error)),
    }
}

/// Hashes a committed file with fixed memory; callers must finish after mutation begins.
pub(super) fn hash_file(policy: &CompiledPolicy, path: &Path) -> Result<String, RemoteError> {
    let Some(mut file) = open_hash_file_if_present(policy, path)? else {
        return Err(file_not_found(path));
    };
    if !file.metadata().map_err(io_error)?.is_file() {
        return Err(path_error(format!(
            "Cannot hash \"{}\": it is not a regular file.",
            path.display()
        )));
    }
    hash_open_file(&mut file)
}

/// Hashes a present regular file in fixed memory, observing cancellation between chunks.
pub(super) fn hash_file_if_present_cancellable(
    policy: &CompiledPolicy,
    path: &Path,
    cancel: &CancellationToken,
) -> Result<Option<String>, RemoteError> {
    check_cancel(cancel)?;
    // On Windows, opening a directory as a regular file can fail before we can
    // inspect its metadata. Classify it first so snapshot.hash matches
    // Bun.file(path).exists(), which treats directories as absent.
    if !resolved_path_is_file(policy, path)? {
        check_cancel(cancel)?;
        return Ok(None);
    }
    let Some(mut file) = open_hash_file_if_present(policy, path)? else {
        check_cancel(cancel)?;
        return Ok(None);
    };
    if !file.metadata().map_err(io_error)?.is_file() {
        check_cancel(cancel)?;
        return Ok(None);
    }
    hash_reader_cancellable(&mut file, cancel).map(Some)
}

fn open_hash_file_if_present(
    policy: &CompiledPolicy,
    path: &Path,
) -> Result<Option<File>, RemoteError> {
    match open_read_scoped(policy, path) {
        Ok(file) => Ok(Some(file)),
        Err(error) if is_not_found(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

fn hash_open_file(file: &mut File) -> Result<String, RemoteError> {
    hash_reader(file, None)
}

fn hash_reader_cancellable(
    reader: &mut impl Read,
    cancel: &CancellationToken,
) -> Result<String, RemoteError> {
    hash_reader(reader, Some(cancel))
}

/// Hashes a reader in fixed memory, checking `cancel` around every read.
fn hash_reader(
    reader: &mut impl Read,
    cancel: Option<&CancellationToken>,
) -> Result<String, RemoteError> {
    let check = || cancel.map_or(Ok(()), check_cancel);
    let mut hasher = Sha256::new();
    let mut chunk = [0; 64 * 1024];
    loop {
        check()?;
        let count = reader.read(&mut chunk).map_err(io_error)?;
        check()?;
        if count == 0 {
            break;
        }
        hasher.update(&chunk[..count]);
    }
    Ok(hex(&hasher.finalize()))
}

/// Returns the lowercase hex SHA-256 digest every filesystem result and
/// freshness entry uses to name file content.
///
/// # Example
///
/// ```ignore
/// assert_eq!(sha256_hex(b"").len(), 64);
/// ```
pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// Encodes bytes as lowercase hexadecimal, two digits per byte.
///
/// # Example
///
/// ```ignore
/// assert_eq!(hex(&[0x00, 0xab, 0xff]), "00abff");
/// ```
pub(super) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(char::from(DIGITS[usize::from(byte >> 4)]));
        encoded.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    encoded
}

pub(super) fn assert_regular(
    policy: &CompiledPolicy,
    path: &Path,
    action: &str,
) -> Result<FileInfo, RemoteError> {
    let metadata = metadata_for_diagnostic(policy, path).map_err(|error| {
        if is_missing_path_error(&error) {
            file_not_found(path)
        } else {
            error
        }
    })?;
    if !metadata.is_file {
        return Err(path_error(format!(
            "Cannot {action} \"{}\": it is not a regular file. Directories and symbolic links are not supported.",
            path.display()
        )));
    }
    let len = if policy.is_unrestricted() {
        metadata.len
    } else {
        capability::open_existing_file(policy, path)?
            .metadata()
            .map_err(io_error)?
            .len()
    };
    Ok(FileInfo { len })
}

fn metadata_for_diagnostic(
    policy: &CompiledPolicy,
    path: &Path,
) -> Result<PathMetadata, RemoteError> {
    if policy.is_unrestricted() {
        return match fs::symlink_metadata(path) {
            Ok(metadata) => Ok(PathMetadata {
                is_file: metadata.is_file(),
                len: metadata.len(),
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(file_not_found(path)),
            Err(error) => Err(io_error(error)),
        };
    }
    let parent = capability::verified_parent(policy, path, false)?;
    parent.with_parent(|dir, leaf| match dir.symlink_metadata(leaf) {
        Ok(metadata) => Ok(PathMetadata {
            is_file: metadata.is_file(),
            len: metadata.len(),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(file_not_found(path)),
        Err(error) => Err(io_error(error)),
    })
}

/// Writes without fsync, matching the TS durability contract. The caller holds path locks.
pub(super) fn write_atomic(
    policy: &CompiledPolicy,
    path: &Path,
    bytes: &[u8],
    exclusive: bool,
) -> Result<f64, RemoteError> {
    if policy.is_unrestricted() {
        return write_atomic_unrestricted(path, bytes, exclusive);
    }
    let parent = capability::verified_parent(policy, path, true)?;
    if exclusive {
        return write_exclusive_bound(&parent, path, bytes, io_error);
    }
    parent.with_parent(|dir, leaf| {
        let mode = inspect_destination_in(dir, leaf, path, || {})?;
        let temp = temporary_name()?;
        write_replacement_in(dir, leaf, path, &temp, bytes, mode)
    })
}

/// Replaces a file only while its current bytes still match an observed state.
///
/// The caller must hold every Mango path lock for `path`. The final identity
/// and byte check rejects changes observed after preparation, although no
/// portable filesystem primitive can exclude a separate writer after that
/// final check and before publication.
///
/// # Example
///
/// ```ignore
/// write_atomic_if_unchanged(&policy, path, before, after)?;
/// ```
pub(super) fn write_atomic_if_unchanged(
    policy: &CompiledPolicy,
    path: &Path,
    expected: &[u8],
    bytes: &[u8],
) -> Result<f64, RemoteError> {
    let parent = capability::verified_parent(policy, path, false)?;
    parent.with_parent(|dir, leaf| {
        let Some(identity) = matching_destination_identity_in(dir, leaf, expected)? else {
            return Err(destination_changed_error(path));
        };
        let mode = inspect_destination_in(dir, leaf, path, || {})?;
        let temp = temporary_name()?;
        write_replacement_in_with_hook(
            dir,
            leaf,
            path,
            &temp,
            Replacement {
                bytes,
                mode,
                expected: Some(ExpectedDestination {
                    bytes: expected,
                    identity,
                }),
            },
            |_, _| {},
        )
    })
}

fn write_atomic_unrestricted(
    path: &Path,
    bytes: &[u8],
    exclusive: bool,
) -> Result<f64, RemoteError> {
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
pub(super) fn create_new(
    policy: &CompiledPolicy,
    path: &Path,
    bytes: &[u8],
) -> Result<f64, RemoteError> {
    if !policy.is_unrestricted() {
        let parent = capability::verified_parent(policy, path, true)?;
        return write_exclusive_bound(&parent, path, bytes, create_error);
    }
    let parent = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(parent).map_err(|error| parent_creation_error(path, parent, error))?;
    write_exclusive(path, bytes).map_err(create_error)
}

fn create_error(error: std::io::Error) -> RemoteError {
    let already_exists = error.kind() == std::io::ErrorKind::AlreadyExists;
    io_error(error).with_detail("alreadyExists", already_exists)
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
    Ok(path.with_file_name(temporary_name()?))
}

fn temporary_name() -> Result<OsString, RemoteError> {
    let mut random = [0; 8];
    getrandom::fill(&mut random)
        .map_err(|error| RemoteError::new(codes::INTERNAL, error.to_string()))?;
    let suffix = hex(&random);
    Ok(OsString::from(format!(".mango-{suffix}.tmp")))
}

fn write_replacement(
    temp: &Path,
    path: &Path,
    bytes: &[u8],
    mode: Option<fs::Permissions>,
) -> Result<f64, RemoteError> {
    write_replacement_with_hook(temp, path, bytes, mode, |_| {})
}

fn write_replacement_with_hook(
    temp: &Path,
    path: &Path,
    bytes: &[u8],
    mode: Option<fs::Permissions>,
    mut before_write: impl FnMut(&Path),
) -> Result<f64, RemoteError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if mode.is_some() {
        use std::os::unix::fs::OpenOptionsExt as _;

        options.mode(0o600);
    }
    let mut file = options.open(temp).map_err(io_error)?;
    let prepared = (|| {
        before_write(temp);
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

/// Creates `path` through its verified parent, mapping a failed open with
/// `open_error` so callers choose how an existing name is reported.
fn write_exclusive_bound(
    parent: &VerifiedParent,
    path: &Path,
    bytes: &[u8],
    open_error: fn(std::io::Error) -> RemoteError,
) -> Result<f64, RemoteError> {
    parent.with_parent(|dir, leaf| {
        let mut file = dir
            .open_with(leaf, CapOpenOptions::new().write(true).create_new(true))
            .map_err(open_error)?;
        file.write_all(bytes)
            .and_then(|()| file.into_std().metadata())
            .map(|metadata| mtime(&metadata))
            .map_err(|cause| exclusive_create_uncertain_error(path, cause))
    })
}

#[cfg(all(test, unix))]
fn inspect_destination_bound_after_metadata(
    parent: &VerifiedParent,
    path: &Path,
    after_metadata: impl FnOnce(),
) -> Result<Option<CapPermissions>, RemoteError> {
    parent.with_parent(|dir, leaf| inspect_destination_in(dir, leaf, path, after_metadata))
}

fn inspect_destination_in(
    dir: &cap_std::fs::Dir,
    leaf: &Path,
    path: &Path,
    after_metadata: impl FnOnce(),
) -> Result<Option<CapPermissions>, RemoteError> {
    let metadata = match dir.symlink_metadata(leaf) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
        Ok(metadata) => metadata,
    };
    if metadata.is_symlink() {
        return Err(path_error(format!(
            "Cannot write \"{}\": it is a symbolic link. Write to the link target instead.",
            path.display()
        )));
    }
    if !metadata.is_file() {
        return Err(path_error(format!(
            "Cannot write \"{}\": the path exists and is not a regular file.",
            path.display()
        )));
    }
    after_metadata();
    let file = open_write_probe(dir, leaf, path)?;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() {
        return Err(path_error(format!(
            "Cannot write \"{}\": it is not a regular file.",
            path.display()
        )));
    }
    #[cfg(unix)]
    let writable = {
        use cap_std::fs::PermissionsExt as _;
        metadata.permissions().mode() & 0o222 != 0
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

fn open_write_probe(
    dir: &cap_std::fs::Dir,
    leaf: &Path,
    path: &Path,
) -> Result<cap_std::fs::File, RemoteError> {
    let mut options = CapOpenOptions::new();
    options.write(true);
    options.follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt as _;
        // The probe must neither follow a leaf substituted with a symlink nor
        // wait for a substituted FIFO before its type is checked.
        options.custom_flags(nix::libc::O_NONBLOCK);
    }
    dir.open_with(leaf, &options)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::TooManyLinks {
                return path_error(format!(
                    "Cannot write \"{}\": it is a symbolic link. Write to the link target instead.",
                    path.display()
                ));
            }
            path_error(format!(
                "Cannot write \"{}\": the path changed while its writable handle was being verified. Cause: {error}",
                path.display()
            ))
        })
}

fn write_replacement_in(
    dir: &cap_std::fs::Dir,
    leaf: &Path,
    path: &Path,
    temp: &OsString,
    bytes: &[u8],
    mode: Option<CapPermissions>,
) -> Result<f64, RemoteError> {
    write_replacement_in_with_hook(
        dir,
        leaf,
        path,
        temp,
        Replacement {
            bytes,
            mode,
            expected: None,
        },
        |_, _| {},
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReplacementHookPhase {
    BeforeWrite,
    Prepared,
    BeforePublish,
}

struct Replacement<'a> {
    bytes: &'a [u8],
    mode: Option<CapPermissions>,
    expected: Option<ExpectedDestination<'a>>,
}

fn write_replacement_in_with_hook(
    dir: &cap_std::fs::Dir,
    leaf: &Path,
    path: &Path,
    temp: &OsString,
    replacement: Replacement<'_>,
    mut hook: impl FnMut(ReplacementHookPhase, &Path),
) -> Result<f64, RemoteError> {
    let Replacement {
        bytes,
        mode,
        expected,
    } = replacement;
    let mut options = CapOpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if mode.is_some() {
        use cap_std::fs::OpenOptionsExt as _;

        options.mode(0o600);
    }
    let mut file = dir.open_with(temp, &options).map_err(io_error)?;
    let prepared = (|| -> std::io::Result<()> {
        hook(ReplacementHookPhase::BeforeWrite, Path::new(temp));
        file.write_all(bytes)?;
        if let Some(mode) = mode {
            file.set_permissions(mode)?;
        }
        Ok(())
    })();
    let temp_path = Path::new(temp);
    prepared.map_err(|cause| temporary_write_uncertain_error(path, temp_path, cause))?;
    let file = file.into_std();
    let metadata = file
        .metadata()
        .map_err(|cause| temporary_write_uncertain_error(path, temp_path, cause))?;
    let mtime = mtime(&metadata);
    let identity = object_identity(&file, &metadata)
        .map_err(|cause| temporary_write_uncertain_error(path, temp_path, cause))?;
    let expected_hash = sha256_hex(bytes);
    hook(ReplacementHookPhase::Prepared, temp_path);
    if !temporary_matches(dir, temp_path, identity, &expected_hash) {
        return Err(temporary_write_uncertain_error(
            path,
            temp_path,
            std::io::Error::from(std::io::ErrorKind::AlreadyExists),
        ));
    }
    hook(ReplacementHookPhase::BeforePublish, temp_path);
    if let Some(expected) = expected {
        let remove_owned_temp = || -> Result<(), RemoteError> {
            if !temporary_matches(dir, temp_path, identity, &expected_hash) {
                return Err(temporary_write_uncertain_error(
                    path,
                    temp_path,
                    std::io::Error::from(std::io::ErrorKind::AlreadyExists),
                ));
            }
            dir.remove_file(temp)
                .map_err(|cause| temporary_write_uncertain_error(path, temp_path, cause))
        };
        match matching_destination_identity_in(dir, leaf, expected.bytes) {
            Ok(Some(identity)) if identity == expected.identity => {}
            Ok(_) => {
                remove_owned_temp()?;
                return Err(destination_changed_error(path));
            }
            Err(error) => {
                remove_owned_temp()?;
                return Err(error);
            }
        }
    }
    dir.rename(temp, dir, leaf)
        .map_err(|cause| temporary_write_uncertain_error(path, temp_path, cause))?;
    if !temporary_matches(dir, leaf, identity, &expected_hash) {
        return Err(published_write_uncertain_error(
            path,
            std::io::Error::from(std::io::ErrorKind::AlreadyExists),
        ));
    }
    Ok(mtime)
}

fn matching_destination_identity_in(
    dir: &cap_std::fs::Dir,
    leaf: &Path,
    expected: &[u8],
) -> Result<Option<ObjectIdentity>, RemoteError> {
    let options = read_nofollow_options();
    let file = dir.open_with(leaf, &options).map_err(io_error)?.into_std();
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() {
        return Ok(None);
    }
    let identity = object_identity(&file, &metadata).map_err(io_error)?;
    let limit = expected.len().saturating_add(1) as u64;
    let mut current = Vec::with_capacity(expected.len());
    file.take(limit)
        .read_to_end(&mut current)
        .map_err(io_error)?;
    Ok((current == expected).then_some(identity))
}

fn destination_changed_error(path: &Path) -> RemoteError {
    path_error(format!(
        "Cannot write \"{}\": the file changed after revalidation. Re-read it and retry the write.",
        path.display()
    ))
    .with_detail("kind", "file_changed")
}

fn temporary_matches(
    dir: &cap_std::fs::Dir,
    temp: &Path,
    expected_identity: ObjectIdentity,
    expected_hash: &str,
) -> bool {
    matches!(
        named_file_match_state_in(dir, temp, expected_identity, expected_hash),
        Ok(NamedFileMatch::Matches)
    )
}

/// Read-only, no-follow options for inspecting a name the caller may not own.
/// Nonblocking open keeps a substituted FIFO from wedging the worker before
/// its type is checked.
fn read_nofollow_options() -> CapOpenOptions {
    let mut options = CapOpenOptions::new();
    options.read(true);
    options.follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt as _;

        options.custom_flags(nix::libc::O_NONBLOCK);
    }
    options
}

fn exclusive_create_uncertain_error(path: &Path, cause: std::io::Error) -> RemoteError {
    path_error(format!(
        "Could not finish creating \"{}\". The new path was left in place because cleanup cannot prove it still owns the name. Inspect it before retrying. Cause: {cause}",
        path.display()
    ))
    .with_detail("pathsMayHaveChanged", true)
}

fn temporary_write_uncertain_error(path: &Path, temp: &Path, cause: std::io::Error) -> RemoteError {
    path_error(format!(
        "Could not safely publish replacement for \"{}\". Temporary \"{}\" was left in place because ownership could not be proved. Inspect both paths before retrying. Cause: {cause}",
        path.display(),
        temp.display()
    ))
    .with_detail("pathsMayHaveChanged", true)
}

fn published_write_uncertain_error(path: &Path, cause: std::io::Error) -> RemoteError {
    path_error(format!(
        "Replacement for \"{}\" was published, but the destination no longer identifies the file that was written. Inspect it before retrying. Cause: {cause}",
        path.display()
    ))
    .with_detail("pathsMayHaveChanged", true)
}

pub(super) fn move_no_overwrite(
    policy: &CompiledPolicy,
    from: &Path,
    to: &Path,
) -> Result<(), RemoteError> {
    move_no_overwrite_bound_with_hooks(policy, from, to, || {}, || {})
}

fn move_no_overwrite_bound_with_hooks(
    policy: &CompiledPolicy,
    from: &Path,
    to: &Path,
    before_commit: impl FnOnce(),
    after_commit: impl FnOnce(),
) -> Result<(), RemoteError> {
    let from_parent = capability::verified_parent(policy, from, false)?;
    let to_parent = capability::verified_parent(policy, to, true)?;
    let mut source = inspect_move_source(policy, &from_parent, from)?;
    before_commit();
    match rename_no_replace(&from_parent, &to_parent, &source.file) {
        Ok(()) => {
            after_commit();
            let retained_hash = source
                .file
                .rewind()
                .map_err(io_error)
                .and_then(|()| hash_open_file(&mut source.file));
            let verification = match retained_hash {
                Ok(_) => verify_moved_destination(&to_parent, &source.hash, source.identity),
                Err(_) => MoveVerification::Uncertain,
            };
            match verification {
                MoveVerification::Matches => Ok(()),
                MoveVerification::OwnedMismatch => {
                    rollback_verified_move(&from_parent, &to_parent, &source.file, from, to)
                }
                MoveVerification::Uncertain => Err(move_partial_error(from, to)),
            }
        }
        Err(capability::ParentOperationError::Io(error))
            if error.kind() == std::io::ErrorKind::CrossesDevices =>
        {
            let mut hooks = NoopMoveCopyHooks;
            copy_move_no_overwrite(&from_parent, &to_parent, &mut source, from, to, &mut hooks)
        }
        Err(capability::ParentOperationError::Io(error))
            if error.kind() == std::io::ErrorKind::AlreadyExists =>
        {
            Err(path_error(format!(
                "\"{}\" already exists. Choose a different destination.",
                to.display()
            )))
        }
        Err(capability::ParentOperationError::Io(error)) => Err(move_atomic_error(from, to, error)),
        Err(capability::ParentOperationError::Access(error)) => Err(error),
    }
}

struct MoveSource {
    file: File,
    identity: ObjectIdentity,
    hash: String,
    mode: fs::Permissions,
}

fn inspect_move_source(
    policy: &CompiledPolicy,
    parent: &VerifiedParent,
    path: &Path,
) -> Result<MoveSource, RemoteError> {
    let mut file = open_move_source(policy, parent, path)?;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() {
        return Err(path_error(format!(
            "Cannot move \"{}\": it is not a regular file. Directories and symbolic links are not supported.",
            path.display()
        )));
    }
    let identity = object_identity(&file, &metadata).map_err(io_error)?;
    let hash = hash_open_file(&mut file)?;
    file.rewind().map_err(io_error)?;
    Ok(MoveSource {
        file,
        identity,
        hash,
        mode: metadata.permissions(),
    })
}

struct PreparedMoveCopy {
    file: File,
    temporary: OsString,
    identity: ObjectIdentity,
}

struct MovePaths<'a> {
    from: &'a Path,
    to: &'a Path,
}

struct PreparedCopyMove<'a> {
    from_parent: &'a VerifiedParent,
    to_parent: &'a VerifiedParent,
    source: &'a mut MoveSource,
    prepared: &'a PreparedMoveCopy,
    paths: MovePaths<'a>,
}

enum NamedFileState {
    Absent,
    Present,
    Uncertain,
}

enum NamedFileMatch {
    Matches,
    DoesNotMatch,
    Uncertain,
}

enum SourceRestoreOutcome {
    Restored,
    NotCommitted,
    CommittedUncertain,
}

trait MoveCopyHooks {
    fn destination_temporary_name(&mut self) -> Result<OsString, RemoteError> {
        temporary_name()
    }

    fn source_temporary_name(&mut self) -> Result<OsString, RemoteError> {
        temporary_name()
    }

    fn before_copy(&mut self, _: &Path) -> std::io::Result<()> {
        Ok(())
    }

    fn after_copy(&mut self, _: &Path) {}

    fn before_publish(&mut self, _: &Path) {}

    fn after_publish(&mut self, _: &Path) {}

    fn before_source_stage(&mut self, _: &Path) -> std::io::Result<()> {
        Ok(())
    }

    fn after_source_stage(&mut self, _: &Path) {}

    fn after_source_restore(&mut self, _: &Path) {}

    fn before_temporary_cleanup(&mut self, _: &Path) -> std::io::Result<()> {
        Ok(())
    }
}

struct NoopMoveCopyHooks;

impl MoveCopyHooks for NoopMoveCopyHooks {}

/// Copies a retained source across devices, publishes it without replacing a
/// destination, and removes the original only after staging and revalidating it.
///
/// The source staging name is intentionally retained when ownership cannot be
/// proved. On a filesystem without descriptor-relative unlink, that preserves a
/// concurrently replaced name instead of deleting it during cleanup.
fn copy_move_no_overwrite(
    from_parent: &VerifiedParent,
    to_parent: &VerifiedParent,
    source: &mut MoveSource,
    from: &Path,
    to: &Path,
    hooks: &mut impl MoveCopyHooks,
) -> Result<(), RemoteError> {
    if !retained_source_matches(source)
        || !named_file_matches(from_parent, source.identity, &source.hash)
    {
        return Err(copy_source_changed_error(from, to));
    }

    let prepared = copy_source_to_temporary(to_parent, source, from, to, hooks)?;
    let mut copied = PreparedCopyMove {
        from_parent,
        to_parent,
        source,
        prepared: &prepared,
        paths: MovePaths { from, to },
    };
    let temporary_path = copied.paths.to.with_file_name(&copied.prepared.temporary);
    let unavailable = match named_file_state(copied.to_parent) {
        NamedFileState::Absent => None,
        NamedFileState::Present => Some(destination_exists_error(to)),
        NamedFileState::Uncertain => Some(destination_availability_uncertain_error(from, to)),
    };
    if let Some(error) = unavailable {
        remove_owned_move_temporary(
            copied.to_parent,
            &copied.prepared.temporary,
            copied.prepared.identity,
            &copied.source.hash,
            &temporary_path,
            &copied.paths,
            hooks,
        )?;
        return Err(error);
    }
    if let Err(cause) = hooks.before_source_stage(from) {
        return Err(abort_unpublished_copy_before_source_stage(
            &mut copied,
            cause,
            hooks,
        ));
    }
    if !retained_source_matches(copied.source)
        || !named_file_matches(
            copied.from_parent,
            copied.source.identity,
            &copied.source.hash,
        )
    {
        return Err(retain_copied_temporary_after_source_stage_failure(
            from,
            to,
            &temporary_path,
            "the source no longer identifies the captured bytes",
            std::io::Error::from(std::io::ErrorKind::AlreadyExists),
        ));
    }
    let tombstone = match hooks.source_temporary_name() {
        Ok(tombstone) => tombstone,
        Err(cause) => {
            return Err(abort_unpublished_copy_before_source_stage(
                &mut copied,
                cause,
                hooks,
            ));
        }
    };
    let tombstone_path = from.with_file_name(&tombstone);
    if let Err(cause) = copied.from_parent.with_parent(|dir, leaf| {
        atomic_rename_no_replace(dir, leaf, dir, Path::new(&tombstone), &copied.source.file)
            .map_err(io_error)
    }) {
        return Err(abort_unpublished_copy_before_source_stage(
            &mut copied,
            cause,
            hooks,
        ));
    }
    hooks.after_source_stage(&tombstone_path);
    if !named_file_matches_at(
        copied.from_parent,
        &tombstone,
        copied.source.identity,
        &copied.source.hash,
    ) {
        return Err(staged_source_and_copy_uncertain_error(
            from,
            to,
            &tombstone_path,
            &temporary_path,
        ));
    }

    hooks.before_publish(&temporary_path);
    if !matches!(named_file_state(copied.from_parent), NamedFileState::Absent)
        || !named_file_matches_at(
            copied.to_parent,
            &copied.prepared.temporary,
            copied.prepared.identity,
            &copied.source.hash,
        )
    {
        return Err(recover_staged_source_after_copy_failure(
            &mut copied,
            &tombstone,
            CopiedMoveState::Temporary,
            std::io::Error::from(std::io::ErrorKind::AlreadyExists),
            hooks,
        ));
    }
    if let Err(cause) = publish_temporary_no_replace(copied.to_parent, copied.prepared) {
        return Err(recover_staged_source_after_copy_failure(
            &mut copied,
            &tombstone,
            CopiedMoveState::Temporary,
            cause,
            hooks,
        ));
    }
    hooks.after_publish(to);
    let destination_match = named_file_match_state(
        copied.to_parent,
        copied.prepared.identity,
        &copied.source.hash,
    );
    match (destination_match, named_file_state(copied.from_parent)) {
        (NamedFileMatch::Matches, NamedFileState::Absent) => {}
        (NamedFileMatch::Matches, source_state) => {
            return Err(published_destination_source_state_error(
                from,
                to,
                &tombstone_path,
                source_state,
            ));
        }
        (NamedFileMatch::DoesNotMatch, _) => {
            return Err(recover_staged_source_after_copy_failure(
                &mut copied,
                &tombstone,
                CopiedMoveState::Published,
                std::io::Error::from(std::io::ErrorKind::AlreadyExists),
                hooks,
            ));
        }
        (NamedFileMatch::Uncertain, _) => {
            return Err(published_destination_verification_uncertain_error(
                from,
                to,
                &tombstone_path,
            ));
        }
    }
    remove_owned_move_temporary(
        copied.from_parent,
        &tombstone,
        copied.source.identity,
        &copied.source.hash,
        &tombstone_path,
        &copied.paths,
        hooks,
    )
}

fn retained_source_matches(source: &mut MoveSource) -> bool {
    let Ok(metadata) = source.file.metadata() else {
        return false;
    };
    if !metadata.is_file()
        || !object_identity(&source.file, &metadata)
            .is_ok_and(|identity| identity == source.identity)
        || source.file.rewind().is_err()
    {
        return false;
    }
    let matches = hash_open_file(&mut source.file).is_ok_and(|hash| hash == source.hash);
    source.file.rewind().is_ok() && matches
}

fn copy_source_to_temporary(
    to_parent: &VerifiedParent,
    source: &mut MoveSource,
    from: &Path,
    to: &Path,
    hooks: &mut impl MoveCopyHooks,
) -> Result<PreparedMoveCopy, RemoteError> {
    to_parent.with_parent(|dir, _| {
        let temporary = hooks.destination_temporary_name()?;
        let temporary_path = to.with_file_name(&temporary);
        let mut file = open_move_temporary(dir, &temporary)
            .map_err(|cause| copy_temporary_create_error(from, to, &temporary_path, cause))?;
        hooks
            .before_copy(&temporary_path)
            .map_err(|cause| copy_temporary_uncertain_error(from, to, &temporary_path, cause))?;
        source
            .file
            .rewind()
            .and_then(|()| copy_retained_source(&mut source.file, &mut file))
            .map_err(|cause| copy_temporary_uncertain_error(from, to, &temporary_path, cause))?;
        file.set_permissions(source.mode.clone())
            .map_err(|cause| copy_temporary_uncertain_error(from, to, &temporary_path, cause))?;
        let metadata = file
            .metadata()
            .map_err(|cause| copy_temporary_uncertain_error(from, to, &temporary_path, cause))?;
        let identity = object_identity(&file, &metadata)
            .map_err(|cause| copy_temporary_uncertain_error(from, to, &temporary_path, cause))?;
        if !temporary_matches(dir, Path::new(&temporary), identity, &source.hash) {
            return Err(copy_temporary_uncertain_error(
                from,
                to,
                &temporary_path,
                std::io::Error::from(std::io::ErrorKind::AlreadyExists),
            ));
        }
        hooks.after_copy(&temporary_path);
        if !temporary_matches(dir, Path::new(&temporary), identity, &source.hash) {
            return Err(copy_temporary_uncertain_error(
                from,
                to,
                &temporary_path,
                std::io::Error::from(std::io::ErrorKind::AlreadyExists),
            ));
        }
        Ok(PreparedMoveCopy {
            file,
            temporary,
            identity,
        })
    })
}

fn open_move_temporary(dir: &cap_std::fs::Dir, temporary: &OsString) -> std::io::Result<File> {
    let mut options = CapOpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt as _;

        // The copied bytes must never be exposed through the temporary name
        // before the source mode is applied after the stream completes.
        options.mode(0o600);
    }
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Storage::FileSystem::{
            DELETE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
        };

        options.access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE);
    }
    dir.open_with(temporary, &options)
        .map(|file| file.into_std())
}

fn copy_retained_source(source: &mut File, destination: &mut File) -> std::io::Result<()> {
    let mut chunk = [0; 64 * 1024];
    loop {
        let count = source.read(&mut chunk)?;
        if count == 0 {
            return Ok(());
        }
        destination.write_all(&chunk[..count])?;
    }
}

fn publish_temporary_no_replace(
    parent: &VerifiedParent,
    prepared: &PreparedMoveCopy,
) -> std::io::Result<()> {
    parent
        .with_parent(|dir, leaf| {
            Ok(atomic_rename_no_replace(
                dir,
                Path::new(&prepared.temporary),
                dir,
                leaf,
                &prepared.file,
            ))
        })
        .map_err(|error| std::io::Error::other(error.message))?
}

fn named_file_matches(parent: &VerifiedParent, identity: ObjectIdentity, hash: &str) -> bool {
    parent
        .with_parent(|dir, leaf| Ok(temporary_matches(dir, leaf, identity, hash)))
        .unwrap_or(false)
}

fn named_file_match_state(
    parent: &VerifiedParent,
    identity: ObjectIdentity,
    hash: &str,
) -> NamedFileMatch {
    parent
        .with_parent(|dir, leaf| named_file_match_state_in(dir, leaf, identity, hash))
        .unwrap_or(NamedFileMatch::Uncertain)
}

fn named_file_match_state_in(
    dir: &cap_std::fs::Dir,
    leaf: &Path,
    expected_identity: ObjectIdentity,
    expected_hash: &str,
) -> Result<NamedFileMatch, RemoteError> {
    let options = read_nofollow_options();
    let file = match dir.open_with(leaf, &options) {
        Ok(file) => file.into_std(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(NamedFileMatch::DoesNotMatch);
        }
        Err(_) => return Ok(NamedFileMatch::Uncertain),
    };
    let metadata = match file.metadata() {
        Ok(metadata) => metadata,
        Err(_) => return Ok(NamedFileMatch::Uncertain),
    };
    if !metadata.is_file() {
        return Ok(NamedFileMatch::DoesNotMatch);
    }
    let current_identity = match object_identity(&file, &metadata) {
        Ok(identity) => identity,
        Err(_) => return Ok(NamedFileMatch::Uncertain),
    };
    if current_identity != expected_identity {
        return Ok(NamedFileMatch::DoesNotMatch);
    }
    let mut file = file;
    match hash_open_file(&mut file) {
        Ok(hash) if hash == expected_hash => Ok(NamedFileMatch::Matches),
        Ok(_) => Ok(NamedFileMatch::DoesNotMatch),
        Err(_) => Ok(NamedFileMatch::Uncertain),
    }
}

fn named_file_state(parent: &VerifiedParent) -> NamedFileState {
    parent
        .with_parent(|dir, leaf| match dir.symlink_metadata(leaf) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(NamedFileState::Absent)
            }
            Ok(_) => Ok(NamedFileState::Present),
            Err(_) => Ok(NamedFileState::Uncertain),
        })
        .unwrap_or(NamedFileState::Uncertain)
}

fn named_file_matches_at(
    parent: &VerifiedParent,
    leaf: &OsString,
    identity: ObjectIdentity,
    hash: &str,
) -> bool {
    parent
        .with_parent(|dir, _| Ok(temporary_matches(dir, Path::new(leaf), identity, hash)))
        .unwrap_or(false)
}

fn remove_owned_move_temporary(
    parent: &VerifiedParent,
    temporary: &OsString,
    identity: ObjectIdentity,
    hash: &str,
    temporary_path: &Path,
    paths: &MovePaths<'_>,
    hooks: &mut impl MoveCopyHooks,
) -> Result<(), RemoteError> {
    hooks
        .before_temporary_cleanup(temporary_path)
        .map_err(|cause| {
            copy_temporary_uncertain_error(paths.from, paths.to, temporary_path, cause)
        })?;
    parent.with_parent(|dir, _| {
        if !temporary_matches(dir, Path::new(temporary), identity, hash) {
            return Err(copy_temporary_uncertain_error(
                paths.from,
                paths.to,
                temporary_path,
                std::io::Error::from(std::io::ErrorKind::AlreadyExists),
            ));
        }
        dir.remove_file(temporary).map_err(|cause| {
            copy_temporary_uncertain_error(paths.from, paths.to, temporary_path, cause)
        })
    })
}

fn abort_unpublished_copy_before_source_stage(
    copied: &mut PreparedCopyMove<'_>,
    cause: impl std::fmt::Display,
    hooks: &mut impl MoveCopyHooks,
) -> RemoteError {
    let temporary_path = copied.paths.to.with_file_name(&copied.prepared.temporary);
    if !retained_source_matches(copied.source)
        || !named_file_matches(
            copied.from_parent,
            copied.source.identity,
            &copied.source.hash,
        )
    {
        return retain_copied_temporary_after_source_stage_failure(
            copied.paths.from,
            copied.paths.to,
            &temporary_path,
            "the source no longer identifies the captured bytes",
            cause,
        );
    }

    if let Err(cleanup) = remove_owned_move_temporary(
        copied.to_parent,
        &copied.prepared.temporary,
        copied.prepared.identity,
        &copied.source.hash,
        &temporary_path,
        &copied.paths,
        hooks,
    ) {
        return retain_copied_temporary_after_source_stage_failure(
            copied.paths.from,
            copied.paths.to,
            &temporary_path,
            "the verified temporary copy could not be removed",
            format!("{cause}; cleanup: {}", cleanup.message),
        );
    }

    path_error(format!(
        "Copied move from \"{}\" to \"{}\" could not stage the source before publishing a destination. The source was retained and the verified temporary copy was removed. Cause: {cause}",
        copied.paths.from.display(),
        copied.paths.to.display(),
    ))
    .with_detail("pathsMayHaveChanged", true)
}

fn retain_copied_temporary_after_source_stage_failure(
    from: &Path,
    to: &Path,
    temporary: &Path,
    reason: &str,
    cause: impl std::fmt::Display,
) -> RemoteError {
    path_error(format!(
        "Copied move from \"{}\" to \"{}\" could not stage the source before publishing a destination. Temporary \"{}\" was retained because {reason}. Inspect it before retrying. Cause: {cause}",
        from.display(),
        to.display(),
        temporary.display(),
    ))
    .with_detail("pathsMayHaveChanged", true)
}

enum CopiedMoveState {
    Temporary,
    Published,
}

fn recover_staged_source_after_copy_failure(
    copied: &mut PreparedCopyMove<'_>,
    tombstone: &OsString,
    state: CopiedMoveState,
    cause: impl std::fmt::Display,
    hooks: &mut impl MoveCopyHooks,
) -> RemoteError {
    let tombstone_path = copied.paths.from.with_file_name(tombstone);
    let temporary_path = copied.paths.to.with_file_name(&copied.prepared.temporary);
    match restore_staged_source_no_replace(
        copied.from_parent,
        copied.source,
        tombstone,
        copied.paths.from,
        hooks,
    ) {
        SourceRestoreOutcome::Restored => {}
        SourceRestoreOutcome::NotCommitted => {
            return staged_source_and_copy_recovery_error(
                copied.paths.from,
                copied.paths.to,
                &tombstone_path,
                &temporary_path,
                state,
                cause,
            );
        }
        SourceRestoreOutcome::CommittedUncertain => {
            return committed_source_restore_uncertain_error(
                copied.paths.from,
                copied.paths.to,
                &temporary_path,
                state,
                cause,
            );
        }
    }

    if matches!(state, CopiedMoveState::Temporary)
        && let Err(cleanup) = remove_owned_move_temporary(
            copied.to_parent,
            &copied.prepared.temporary,
            copied.prepared.identity,
            &copied.source.hash,
            &temporary_path,
            &copied.paths,
            hooks,
        )
    {
        return path_error(format!(
            "Copied move from \"{}\" to \"{}\" restored the staged source, but temporary \"{}\" was retained because cleanup could not prove ownership. Inspect all paths before retrying. Cause: {cause}; cleanup: {}",
            copied.paths.from.display(),
            copied.paths.to.display(),
            temporary_path.display(),
            cleanup.message,
        ))
        .with_detail("pathsMayHaveChanged", true);
    }

    let publication = match state {
        CopiedMoveState::Temporary => "The destination was not published",
        CopiedMoveState::Published => "The destination changed after publication",
    };
    path_error(format!(
        "Copied move from \"{}\" to \"{}\" could not complete. {publication}; the staged source was restored without replacing a recreated source. Inspect both paths before retrying. Cause: {cause}",
        copied.paths.from.display(),
        copied.paths.to.display(),
    ))
    .with_detail("pathsMayHaveChanged", true)
}

/// Restores a staged source only while the retained descriptor and tombstone
/// still identify the captured bytes. The no-replace rename preserves a source
/// recreated by another writer.
fn restore_staged_source_no_replace(
    parent: &VerifiedParent,
    source: &mut MoveSource,
    tombstone: &OsString,
    restored_path: &Path,
    hooks: &mut impl MoveCopyHooks,
) -> SourceRestoreOutcome {
    if !retained_source_matches(source) {
        return SourceRestoreOutcome::NotCommitted;
    }
    parent
        .with_parent(|dir, leaf| {
            if !temporary_matches(dir, Path::new(tombstone), source.identity, &source.hash) {
                return Ok(SourceRestoreOutcome::NotCommitted);
            }
            if atomic_rename_no_replace(dir, Path::new(tombstone), dir, leaf, &source.file).is_err()
            {
                return Ok(SourceRestoreOutcome::NotCommitted);
            }
            hooks.after_source_restore(restored_path);
            if temporary_matches(dir, leaf, source.identity, &source.hash) {
                Ok(SourceRestoreOutcome::Restored)
            } else {
                Ok(SourceRestoreOutcome::CommittedUncertain)
            }
        })
        .unwrap_or(SourceRestoreOutcome::NotCommitted)
}

fn staged_source_and_copy_uncertain_error(
    from: &Path,
    to: &Path,
    tombstone: &Path,
    temporary: &Path,
) -> RemoteError {
    path_error(format!(
        "Copied move from \"{}\" to \"{}\" staged source recovery at \"{}\", but that path no longer identifies the captured source. Destination publication was skipped and temporary \"{}\" was retained. Inspect all recovery paths before retrying.",
        from.display(),
        to.display(),
        tombstone.display(),
        temporary.display(),
    ))
    .with_detail("pathsMayHaveChanged", true)
}

fn staged_source_and_copy_recovery_error(
    from: &Path,
    to: &Path,
    tombstone: &Path,
    temporary: &Path,
    state: CopiedMoveState,
    cause: impl std::fmt::Display,
) -> RemoteError {
    let copy_path = copied_move_location(&state, temporary);
    path_error(format!(
        "Copied move from \"{}\" to \"{}\" could not restore staged source recovery at \"{}\" without replacing a recreated source. {copy_path} Inspect all paths before retrying. Cause: {cause}",
        from.display(),
        to.display(),
        tombstone.display(),
    ))
    .with_detail("pathsMayHaveChanged", true)
}

fn committed_source_restore_uncertain_error(
    from: &Path,
    to: &Path,
    temporary: &Path,
    state: CopiedMoveState,
    cause: impl std::fmt::Display,
) -> RemoteError {
    let copy_path = copied_move_location(&state, temporary);
    path_error(format!(
        "Copied move from \"{}\" to \"{}\" committed source restoration, but the source no longer identifies the captured bytes. {copy_path} Inspect both paths before retrying. Cause: {cause}",
        from.display(),
        to.display(),
    ))
    .with_detail("pathsMayHaveChanged", true)
}

/// Describes where the copied bytes remain after a failed copied move.
fn copied_move_location(state: &CopiedMoveState, temporary: &Path) -> String {
    match state {
        CopiedMoveState::Temporary => {
            format!(
                "Temporary \"{}\" was retained for recovery.",
                temporary.display()
            )
        }
        CopiedMoveState::Published => {
            "The destination may contain the copied bytes or a replacement.".to_owned()
        }
    }
}

fn destination_exists_error(destination: &Path) -> RemoteError {
    path_error(format!(
        "\"{}\" already exists. Choose a different destination.",
        destination.display()
    ))
}

fn destination_availability_uncertain_error(from: &Path, to: &Path) -> RemoteError {
    path_error(format!(
        "Could not confirm that destination \"{}\" is absent before staging source \"{}\". The source was retained and no copied destination was published.",
        to.display(),
        from.display(),
    ))
    .with_detail("pathsMayHaveChanged", true)
}

fn published_destination_source_state_error(
    from: &Path,
    to: &Path,
    tombstone: &Path,
    state: NamedFileState,
) -> RemoteError {
    let recovery_state = match state {
        NamedFileState::Present => format!(
            "the source was recreated, so recovery path \"{}\" was left untouched",
            tombstone.display()
        ),
        NamedFileState::Uncertain => format!(
            "the source and recovery path \"{}\" could not be checked",
            tombstone.display()
        ),
        NamedFileState::Absent => unreachable!("the caller handles an absent source"),
    };
    path_error(format!(
        "Copied move from \"{}\" to \"{}\" published a destination that still identifies the copied bytes, but {recovery_state}. Inspect source, destination, and recovery paths before retrying.",
        from.display(),
        to.display(),
    ))
    .with_detail("pathsMayHaveChanged", true)
}

fn published_destination_verification_uncertain_error(
    from: &Path,
    to: &Path,
    tombstone: &Path,
) -> RemoteError {
    path_error(format!(
        "Copied move from \"{}\" to \"{}\" published a destination, but it could not be verified to identify the copied bytes. Source recovery path \"{}\" was left untouched. Inspect source, destination, and recovery paths before retrying.",
        from.display(),
        to.display(),
        tombstone.display(),
    ))
    .with_detail("pathsMayHaveChanged", true)
}

fn copy_source_changed_error(from: &Path, to: &Path) -> RemoteError {
    path_error(format!(
        "Could not copy \"{}\" to \"{}\": the retained source changed before the cross-device move began. Both paths were left in place.",
        from.display(),
        to.display()
    ))
    .with_detail("pathsMayHaveChanged", true)
}

fn copy_temporary_uncertain_error(
    from: &Path,
    to: &Path,
    temporary: &Path,
    cause: std::io::Error,
) -> RemoteError {
    path_error(format!(
        "Could not copy \"{}\" to \"{}\" across filesystems. Temporary \"{}\" was left in place because ownership could not be proved. Inspect it before retrying. Cause: {cause}",
        from.display(),
        to.display(),
        temporary.display()
    ))
    .with_detail("pathsMayHaveChanged", true)
}

fn copy_temporary_create_error(
    from: &Path,
    to: &Path,
    temporary: &Path,
    cause: std::io::Error,
) -> RemoteError {
    path_error(format!(
        "Could not create temporary destination \"{}\" while copying \"{}\" to \"{}\" across filesystems. No temporary copy was created. Cause: {cause}",
        temporary.display(),
        from.display(),
        to.display(),
    ))
}

#[cfg(test)]
fn copy_move_no_overwrite_bound_with_hooks(
    policy: &CompiledPolicy,
    from: &Path,
    to: &Path,
    hooks: &mut impl MoveCopyHooks,
) -> Result<(), RemoteError> {
    let from_parent = capability::verified_parent(policy, from, false)?;
    let to_parent = capability::verified_parent(policy, to, true)?;
    let mut source = inspect_move_source(policy, &from_parent, from)?;
    copy_move_no_overwrite(&from_parent, &to_parent, &mut source, from, to, hooks)
}

#[cfg(not(windows))]
fn open_move_source(
    policy: &CompiledPolicy,
    _: &VerifiedParent,
    path: &Path,
) -> Result<File, RemoteError> {
    capability::open_existing_file(policy, path)
}

#[cfg(windows)]
fn open_move_source(
    _: &CompiledPolicy,
    parent: &VerifiedParent,
    path: &Path,
) -> Result<File, RemoteError> {
    use cap_std::fs::OpenOptionsExt as _;
    use windows_sys::Win32::Storage::FileSystem::{DELETE, FILE_GENERIC_READ};

    parent.with_parent(|dir, leaf| {
        let mut options = CapOpenOptions::new();
        options.read(true);
        options.access_mode(FILE_GENERIC_READ | DELETE);
        options.follow(FollowSymlinks::No);
        dir.open_with(leaf, &options)
            .map(|file| file.into_std())
            .map_err(|cause| {
                path_error(format!(
                    "Cannot atomically move \"{}\": its no-follow DELETE-capable handle could not be opened. Cause: {cause}",
                    path.display()
                ))
            })
    })
}

enum MoveVerification {
    Matches,
    OwnedMismatch,
    Uncertain,
}

fn verify_moved_destination(
    parent: &VerifiedParent,
    expected_hash: &str,
    expected_identity: ObjectIdentity,
) -> MoveVerification {
    let options = read_nofollow_options();
    let Ok(mut file) = parent.with_parent(|dir, leaf| {
        dir.open_with(leaf, &options)
            .map(|file| file.into_std())
            .map_err(io_error)
    }) else {
        return MoveVerification::Uncertain;
    };
    let Ok(metadata) = file.metadata() else {
        return MoveVerification::Uncertain;
    };
    if !metadata.is_file()
        || !object_identity(&file, &metadata).is_ok_and(|identity| identity == expected_identity)
    {
        return MoveVerification::Uncertain;
    }
    let Ok(hash) = hash_open_file(&mut file) else {
        return MoveVerification::Uncertain;
    };
    if hash == expected_hash {
        MoveVerification::Matches
    } else {
        MoveVerification::OwnedMismatch
    }
}

fn rollback_verified_move(
    source: &VerifiedParent,
    destination: &VerifiedParent,
    moved: &File,
    from: &Path,
    to: &Path,
) -> Result<(), RemoteError> {
    #[cfg(not(windows))]
    {
        // POSIX rename binds its source by name, not by `moved`. A concurrent
        // replacement after verification could otherwise be relocated into
        // `from`. Leave both names untouched and report the partial state.
        let _ = (source, destination, moved);
        Err(move_partial_error(from, to))
    }
    #[cfg(windows)]
    match rename_no_replace(destination, source, moved) {
        Ok(()) => Err(path_error(format!(
            "Move from \"{}\" to \"{}\" changed during verification; the verified destination was moved back. Inspect the source before retrying.",
            from.display(),
            to.display()
        ))
        .with_detail("pathsMayHaveChanged", true)),
        Err(_) => Err(move_partial_error(from, to)),
    }
}

fn move_partial_error(from: &Path, to: &Path) -> RemoteError {
    path_error(format!(
        "Move from \"{}\" to \"{}\" committed, but the destination could not be verified or safely rolled back. Both paths may have changed; inspect the destination before retrying.",
        from.display(),
        to.display()
    ))
    .with_detail("pathsMayHaveChanged", true)
}

fn move_atomic_error(from: &Path, to: &Path, cause: std::io::Error) -> RemoteError {
    path_error(format!(
        "Could not atomically move \"{}\" to \"{}\" without replacing an existing destination. Both paths were left unchanged. Cause: {cause}",
        from.display(),
        to.display()
    ))
    .with_detail("pathsMayHaveChanged", true)
}

fn rename_no_replace(
    from: &VerifiedParent,
    to: &VerifiedParent,
    source: &File,
) -> Result<(), capability::ParentOperationError> {
    capability::with_parents(from, to, |from_dir, from_leaf, to_dir, to_leaf| {
        atomic_rename_no_replace(from_dir, from_leaf, to_dir, to_leaf, source)
    })
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn atomic_rename_no_replace(
    from_dir: &cap_std::fs::Dir,
    from_leaf: &Path,
    to_dir: &cap_std::fs::Dir,
    to_leaf: &Path,
    _: &File,
) -> std::io::Result<()> {
    let from_dir = from_dir.try_clone()?.into_std_file();
    let to_dir = to_dir.try_clone()?.into_std_file();
    rustix::fs::renameat_with(
        &from_dir,
        from_leaf,
        &to_dir,
        to_leaf,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(std::io::Error::from)
}

#[cfg(windows)]
#[allow(
    unsafe_code,
    reason = "Windows exposes handle-relative rename only through NtSetInformationFile"
)]
fn atomic_rename_no_replace(
    _: &cap_std::fs::Dir,
    _: &Path,
    to_dir: &cap_std::fs::Dir,
    to_leaf: &Path,
    source: &File,
) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::{
        Wdk::Storage::FileSystem::{FileRenameInformation, NtSetInformationFile},
        Win32::{Foundation::RtlNtStatusToDosError, System::IO::IO_STATUS_BLOCK},
    };

    let destination_dir = to_dir.try_clone()?.into_std_file();
    let mut rename = windows_rename_info(destination_dir.as_raw_handle(), to_leaf)?;
    let mut io_status = IO_STATUS_BLOCK::default();
    // SAFETY: the live source handle has DELETE access; `rename` contains a
    // valid, one-component relative target and its live destination directory
    // handle; `io_status` is writable for the duration of this synchronous call.
    let status = unsafe {
        NtSetInformationFile(
            source.as_raw_handle(),
            &mut io_status,
            rename.as_mut_ptr(),
            rename.len(),
            FileRenameInformation,
        )
    };
    if status < 0 {
        // SAFETY: RtlNtStatusToDosError is a pure conversion of the NTSTATUS
        // returned by the call above.
        let code = unsafe { RtlNtStatusToDosError(status) };
        return Err(std::io::Error::from_raw_os_error(code as i32));
    }
    Ok(())
}

#[cfg(windows)]
struct WindowsRenameInfo {
    storage: Vec<u64>,
    len: u32,
}

#[cfg(windows)]
impl WindowsRenameInfo {
    fn as_mut_ptr(&mut self) -> *const core::ffi::c_void {
        self.storage.as_mut_ptr().cast()
    }

    fn len(&self) -> u32 {
        self.len
    }
}

#[cfg(windows)]
#[allow(
    unsafe_code,
    reason = "FILE_RENAME_INFO is a variable-length Win32 buffer"
)]
fn windows_rename_info(
    root_directory: windows_sys::Win32::Foundation::HANDLE,
    leaf: &Path,
) -> std::io::Result<WindowsRenameInfo> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Storage::FileSystem::FILE_RENAME_INFO;

    let filename: Vec<u16> = leaf.as_os_str().encode_wide().collect();
    if filename.is_empty() || leaf.components().count() != 1 {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
    }
    let filename_bytes = filename
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // NtSetInformationFile requires the fixed FILE_RENAME_INFO size plus the
    // complete FileNameLength payload. Its one-element trailing array is part
    // of Rust's `size_of`, so do not subtract that element here.
    let size = std::mem::size_of::<FILE_RENAME_INFO>()
        .checked_add(filename_bytes)
        .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let len =
        u32::try_from(size).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let mut storage = vec![0_u64; size.div_ceil(std::mem::size_of::<u64>())];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // SAFETY: `storage` is aligned and sized for the fixed FILE_RENAME_INFO
    // header plus every UTF-16 code unit copied into its trailing filename.
    unsafe {
        (*info).Anonymous.ReplaceIfExists = false;
        (*info).RootDirectory = root_directory;
        (*info).FileNameLength = u32::try_from(filename_bytes)
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        std::ptr::copy_nonoverlapping(
            filename.as_ptr(),
            (*info).FileName.as_mut_ptr(),
            filename.len(),
        );
    }
    Ok(WindowsRenameInfo { storage, len })
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn atomic_rename_no_replace(
    _: &cap_std::fs::Dir,
    _: &Path,
    _: &cap_std::fs::Dir,
    _: &Path,
    _: &File,
) -> std::io::Result<()> {
    Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
}

/// Removes a checked leaf through its verified parent directory.
///
/// # Example
///
/// ```ignore
/// delete_file(&policy, path)?;
/// ```
pub(super) fn delete_file(policy: &CompiledPolicy, path: &Path) -> Result<(), RemoteError> {
    if policy.is_unrestricted() {
        return fs::remove_file(path).map_err(delete_error);
    }
    let parent = capability::verified_parent(policy, path, false)?;
    parent.with_parent(|dir, leaf| dir.remove_file(leaf).map_err(delete_error))
}

fn delete_error(error: std::io::Error) -> RemoteError {
    let not_found = error.kind() == std::io::ErrorKind::NotFound;
    io_error(error).with_detail("notFound", not_found)
}

/// Ensures a patch destination is absent without creating missing parents.
///
/// # Example
///
/// ```ignore
/// assert_destination_available(&policy, destination, input_path)?;
/// ```
pub(super) fn assert_destination_available(
    policy: &CompiledPolicy,
    path: &Path,
    input_path: &str,
) -> Result<(), RemoteError> {
    if policy.is_unrestricted() {
        return assert_destination_available_unrestricted(path, input_path);
    }
    policy.check(path)?;
    match capability::verified_parent_if_present(policy, path)? {
        Some(parent) => parent.with_parent(|dir, leaf| match dir.symlink_metadata(leaf) {
            Ok(_) => Err(path_error(format!(
                "\"{input_path}\" already exists and cannot be overwritten."
            ))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(io_error(error)),
        }),
        None => Ok(()),
    }
}

/// Builds the create-file conflict diagnostic through the verified parent.
///
/// # Example
///
/// ```ignore
/// return Err(create_conflict_error(&policy, path, input_path));
/// ```
pub(super) fn create_conflict_error(
    policy: &CompiledPolicy,
    path: &Path,
    input_path: &str,
) -> RemoteError {
    if let Some(target) = symlink_target(policy, path) {
        let target = target.map_or_else(String::new, |target| {
            format!(" to \"{}\"", target.display())
        });
        return path_error(format!(
            "Cannot create \"{input_path}\": it is a symbolic link{target}. Write to the link target instead."
        ));
    }
    if assert_regular(policy, path, "create").is_err() {
        return path_error(format!(
            "Cannot create \"{input_path}\": the path exists and is not a regular file."
        ));
    }
    path_error(format!(
        "\"{input_path}\" already exists. Read it with read_file, then use edit_file for an exact text change, replace_range for a line change, or write_file to replace all content."
    ))
}

fn symlink_target(policy: &CompiledPolicy, path: &Path) -> Option<Option<PathBuf>> {
    if policy.is_unrestricted() {
        let metadata = fs::symlink_metadata(path).ok()?;
        return metadata.is_symlink().then(|| fs::read_link(path).ok());
    }
    let parent = capability::verified_parent(policy, path, false).ok()?;
    parent
        .with_parent(|dir, leaf| {
            let Ok(metadata) = dir.symlink_metadata(leaf) else {
                return Ok(None);
            };
            Ok(metadata
                .is_symlink()
                .then(|| dir.read_link_contents(leaf).ok()))
        })
        .ok()
        .flatten()
}

fn assert_destination_available_unrestricted(
    path: &Path,
    input_path: &str,
) -> Result<(), RemoteError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(path_error(format!(
            "\"{input_path}\" already exists and cannot be overwritten."
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filesystem::policy::PathPolicy;
    use crate::test_support::scratch_dir;

    #[cfg(unix)]
    use std::cell::Cell;

    fn copy_fallback_policy(root: &Path) -> CompiledPolicy {
        PathPolicy {
            allowed_roots: vec![root.to_path_buf()],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap()
    }

    #[test]
    fn hex_encodes_every_byte_as_two_lowercase_digits() {
        assert_eq!(hex(&[]), "");
        assert_eq!(hex(&[0x00, 0x0f, 0xab, 0xff]), "000fabff");
    }

    #[test]
    fn sha256_hex_matches_known_digests() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    struct ForcedCopyFailure {
        temporary: Option<PathBuf>,
    }

    impl MoveCopyHooks for ForcedCopyFailure {
        fn before_copy(&mut self, temporary: &Path) -> std::io::Result<()> {
            self.temporary = Some(temporary.to_path_buf());
            Err(std::io::Error::other("forced copy failure"))
        }
    }

    #[cfg(unix)]
    struct PrivateTemporaryBeforeCopy {
        mode: Option<u32>,
    }

    #[cfg(unix)]
    impl MoveCopyHooks for PrivateTemporaryBeforeCopy {
        fn before_copy(&mut self, temporary: &Path) -> std::io::Result<()> {
            use std::os::unix::fs::PermissionsExt;

            self.mode = Some(fs::metadata(temporary)?.permissions().mode() & 0o777);
            Ok(())
        }
    }

    struct DestinationCollisionWithCleanupFailure {
        destination: PathBuf,
        temporary: Option<PathBuf>,
    }

    impl MoveCopyHooks for DestinationCollisionWithCleanupFailure {
        fn after_copy(&mut self, _: &Path) {
            fs::write(&self.destination, b"external destination").unwrap();
        }

        fn before_temporary_cleanup(&mut self, temporary: &Path) -> std::io::Result<()> {
            self.temporary = Some(temporary.to_path_buf());
            Err(std::io::Error::other("forced cleanup failure"))
        }
    }

    struct TemporarySwapBeforePublish {
        temporary: Option<PathBuf>,
    }

    impl MoveCopyHooks for TemporarySwapBeforePublish {
        fn before_publish(&mut self, temporary: &Path) {
            self.temporary = Some(temporary.to_path_buf());
            fs::remove_file(temporary).unwrap();
            fs::write(temporary, b"external temporary").unwrap();
        }
    }

    struct PublishedDestinationSwap;

    impl MoveCopyHooks for PublishedDestinationSwap {
        fn after_publish(&mut self, destination: &Path) {
            fs::remove_file(destination).unwrap();
            fs::write(destination, b"external destination").unwrap();
        }
    }

    struct SourceRecreatedAfterPublication {
        source: PathBuf,
        tombstone: Option<PathBuf>,
    }

    impl MoveCopyHooks for SourceRecreatedAfterPublication {
        fn after_source_stage(&mut self, tombstone: &Path) {
            self.tombstone = Some(tombstone.to_path_buf());
        }

        fn after_publish(&mut self, _: &Path) {
            fs::write(&self.source, b"external source").unwrap();
        }

        fn after_source_restore(&mut self, _: &Path) {
            panic!("a verified destination with a recreated source must not be restored");
        }
    }

    #[cfg(not(windows))]
    struct SourceParentRenamedAfterPublication {
        source_parent: PathBuf,
        relocated_parent: PathBuf,
        tombstone: Option<PathBuf>,
    }

    #[cfg(not(windows))]
    impl MoveCopyHooks for SourceParentRenamedAfterPublication {
        fn after_source_stage(&mut self, tombstone: &Path) {
            self.tombstone = Some(tombstone.to_path_buf());
        }

        fn after_publish(&mut self, _: &Path) {
            fs::rename(&self.source_parent, &self.relocated_parent).unwrap();
        }

        fn after_source_restore(&mut self, _: &Path) {
            panic!("a verified destination with an uncheckable source must not be restored");
        }
    }

    #[cfg(not(windows))]
    struct DestinationParentRenamedAfterPublication {
        destination_parent: PathBuf,
        relocated_parent: PathBuf,
        tombstone: Option<PathBuf>,
    }

    #[cfg(not(windows))]
    impl MoveCopyHooks for DestinationParentRenamedAfterPublication {
        fn after_source_stage(&mut self, tombstone: &Path) {
            self.tombstone = Some(tombstone.to_path_buf());
        }

        fn after_publish(&mut self, _: &Path) {
            fs::rename(&self.destination_parent, &self.relocated_parent).unwrap();
        }

        fn after_source_restore(&mut self, _: &Path) {
            panic!("an uncheckable destination must retain source recovery");
        }
    }

    struct ForcedSourceStageFailure;

    impl MoveCopyHooks for ForcedSourceStageFailure {
        fn before_source_stage(&mut self, _: &Path) -> std::io::Result<()> {
            Err(std::io::Error::other("forced source stage failure"))
        }
    }

    struct SourceStageFailureBeforePublication {
        destination: PathBuf,
    }

    impl MoveCopyHooks for SourceStageFailureBeforePublication {
        fn before_source_stage(&mut self, _: &Path) -> std::io::Result<()> {
            assert!(
                !self.destination.exists(),
                "the destination must remain private until source staging succeeds"
            );
            Err(std::io::Error::other("forced source stage failure"))
        }
    }

    struct OccupiedDestinationBeforeSourceStage;

    impl MoveCopyHooks for OccupiedDestinationBeforeSourceStage {
        fn before_source_stage(&mut self, _: &Path) -> std::io::Result<()> {
            panic!("a known occupied destination must be rejected before source staging");
        }
    }

    struct DestinationSwapBeforeSourceStageFailure {
        destination: PathBuf,
    }

    impl MoveCopyHooks for DestinationSwapBeforeSourceStageFailure {
        fn before_source_stage(&mut self, _: &Path) -> std::io::Result<()> {
            fs::write(&self.destination, b"external destination").unwrap();
            Err(std::io::Error::other("forced source stage failure"))
        }
    }

    struct SourceStageNameFailure;

    impl MoveCopyHooks for SourceStageNameFailure {
        fn source_temporary_name(&mut self) -> Result<OsString, RemoteError> {
            Err(RemoteError::new(
                codes::INTERNAL,
                "forced source tombstone name failure",
            ))
        }
    }

    struct OccupiedDestinationTemporary {
        temporary: OsString,
    }

    impl MoveCopyHooks for OccupiedDestinationTemporary {
        fn destination_temporary_name(&mut self) -> Result<OsString, RemoteError> {
            Ok(self.temporary.clone())
        }
    }

    #[cfg(not(windows))]
    struct SourceParentRenamedBeforeSourceStage {
        source_parent: PathBuf,
        relocated_parent: PathBuf,
    }

    #[cfg(not(windows))]
    impl MoveCopyHooks for SourceParentRenamedBeforeSourceStage {
        fn before_source_stage(&mut self, _: &Path) -> std::io::Result<()> {
            fs::rename(&self.source_parent, &self.relocated_parent)
        }
    }

    struct DestinationSwapDuringSourceStage {
        destination: PathBuf,
        tombstone: Option<PathBuf>,
    }

    impl MoveCopyHooks for DestinationSwapDuringSourceStage {
        fn after_source_stage(&mut self, tombstone: &Path) {
            self.tombstone = Some(tombstone.to_path_buf());
            fs::write(&self.destination, b"external destination").unwrap();
        }
    }

    struct BeforePublishAfterSourceStage {
        source: PathBuf,
        tombstone: Option<PathBuf>,
    }

    impl MoveCopyHooks for BeforePublishAfterSourceStage {
        fn after_source_stage(&mut self, tombstone: &Path) {
            self.tombstone = Some(tombstone.to_path_buf());
        }

        fn before_publish(&mut self, _: &Path) {
            assert!(
                !self.source.exists(),
                "source must be staged before publish"
            );
            assert!(
                self.tombstone.as_ref().is_some_and(|path| path.exists()),
                "staged source must be recoverable before publish"
            );
        }
    }

    struct SourceRecreatedBeforeRestore {
        source: PathBuf,
        destination: PathBuf,
        temporary: Option<PathBuf>,
        tombstone: Option<PathBuf>,
    }

    impl MoveCopyHooks for SourceRecreatedBeforeRestore {
        fn after_copy(&mut self, temporary: &Path) {
            self.temporary = Some(temporary.to_path_buf());
        }

        fn after_source_stage(&mut self, tombstone: &Path) {
            self.tombstone = Some(tombstone.to_path_buf());
            fs::write(&self.source, b"external source").unwrap();
            fs::write(&self.destination, b"external destination").unwrap();
        }
    }

    struct SourceSwapAfterRestore {
        destination: PathBuf,
        temporary: Option<PathBuf>,
        tombstone: Option<PathBuf>,
    }

    impl MoveCopyHooks for SourceSwapAfterRestore {
        fn after_copy(&mut self, temporary: &Path) {
            self.temporary = Some(temporary.to_path_buf());
        }

        fn after_source_stage(&mut self, tombstone: &Path) {
            self.tombstone = Some(tombstone.to_path_buf());
            fs::write(&self.destination, b"external destination").unwrap();
        }

        fn after_source_restore(&mut self, source: &Path) {
            fs::remove_file(source).unwrap();
            fs::write(source, b"external source").unwrap();
        }
    }

    #[cfg(not(windows))]
    struct SourceSwapBeforeStage {
        temporary: Option<PathBuf>,
    }

    #[cfg(not(windows))]
    impl MoveCopyHooks for SourceSwapBeforeStage {
        fn after_copy(&mut self, temporary: &Path) {
            self.temporary = Some(temporary.to_path_buf());
        }

        fn before_source_stage(&mut self, source: &Path) -> std::io::Result<()> {
            fs::remove_file(source).unwrap();
            fs::write(source, b"external source").unwrap();
            Ok(())
        }
    }

    #[cfg(unix)]
    struct BeforeWriteModeCapture {
        root: PathBuf,
        mode: Cell<Option<u32>>,
    }

    #[cfg(unix)]
    impl BeforeWriteModeCapture {
        fn new(root: &Path) -> Self {
            Self {
                root: root.to_path_buf(),
                mode: Cell::new(None),
            }
        }

        fn record(&self, temporary: &Path) {
            use std::os::unix::fs::PermissionsExt;

            self.mode.set(Some(
                fs::metadata(self.root.join(temporary))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
            ));
        }

        fn mode(&self) -> u32 {
            self.mode.get().unwrap()
        }
    }

    #[cfg(unix)]
    fn default_creation_mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;

        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap();
        let mode = file.metadata().unwrap().permissions().mode() & 0o777;
        drop(file);
        fs::remove_file(path).unwrap();
        mode
    }

    fn unrestricted() -> CompiledPolicy {
        PathPolicy::default().compile().unwrap()
    }

    #[test]
    fn unread_diagnostics_name_satisfiable_binary_views_and_impossible_size_limits() {
        let dir = scratch_dir("fs-unread-guidance");
        let path = dir.join("file");
        let policy = unrestricted();
        let unread = || super::super::freshness::file_not_read_error(&path);
        fs::write(&path, b"text").unwrap();
        assert_eq!(
            explain_unread(&policy, &path, "edit", unread()).message,
            unread().message
        );
        fs::write(&path, b"\0binary").unwrap();
        let binary = explain_unread(&policy, &path, "edit", unread());
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
        let large_binary = explain_unread(&policy, &path, "delete", unread());
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
        let large_text = explain_unread(&policy, &path, "overwrite", unread());
        assert!(
            large_text
                .message
                .contains("past the 10485760-byte read_file limit")
        );
        let stale = super::super::freshness::stale_file_error(&path);
        assert_eq!(explain_unread(&policy, &path, "edit", stale.clone()), stale);
    }

    #[test]
    fn descriptor_read_bounds_observed_bytes_and_checks_cancellation() {
        let dir = scratch_dir("fs-io-read");
        let path = dir.join("file");
        let policy = unrestricted();
        fs::write(&path, b"abc").unwrap();
        let token = CancellationToken::new();
        let observed = read(&policy, &path, 3, &token).unwrap();
        assert_eq!(observed.bytes, b"abc");
        assert!(observed.mtime_ms.is_finite());
        assert_eq!(
            current_metadata(&policy, &path).unwrap(),
            (3, observed.mtime_ms)
        );
        assert!(
            read(&policy, &path, 2, &token)
                .unwrap_err()
                .message
                .contains("limit is 2")
        );
        token.cancel();
        assert_eq!(
            read(&policy, &path, 3, &token).unwrap_err().code,
            codes::CANCELLED
        );
    }

    /// `/proc/self/status` stats as zero bytes, so the pre-read size check
    /// passes trivially: the ceiling must bind the bytes actually streamed,
    /// while a ceiling it fits under still reads the entry in full.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_stat_less_procfs_file_is_bounded_by_the_bytes_actually_read() {
        let policy = unrestricted();
        let status = Path::new("/proc/self/status");
        let token = CancellationToken::new();

        let bounded = read(&policy, status, 64, &token).map(|observed| observed.bytes.len());
        let message = bounded.as_ref().err().map(|error| error.message.clone());
        assert!(
            message
                .as_deref()
                .is_some_and(|message| message.contains("at least 65 bytes; limit is 64")),
            "expected a 64-byte ceiling to refuse at least 65 bytes read | received: {bounded:?}"
        );

        let full = read(&policy, status, 1024 * 1024, &token).map(|observed| observed.bytes);
        let text = full
            .as_ref()
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned());
        assert!(
            text.as_deref().is_ok_and(|text| text.contains("Name:")),
            "expected the full procfs entry under a 1 MiB ceiling | received: {:?}",
            text.map_err(|error| error.message.clone())
        );
    }

    #[test]
    fn cancellable_hash_checks_after_its_final_read() {
        struct CancellingReader {
            token: CancellationToken,
            bytes: Option<Vec<u8>>,
        }

        impl std::io::Read for CancellingReader {
            fn read(&mut self, target: &mut [u8]) -> std::io::Result<usize> {
                let Some(bytes) = self.bytes.take() else {
                    return Ok(0);
                };
                target[..bytes.len()].copy_from_slice(&bytes);
                self.token.cancel();
                Ok(bytes.len())
            }
        }

        let token = CancellationToken::new();
        let mut reader = CancellingReader {
            token: token.clone(),
            bytes: Some(b"hash me".to_vec()),
        };
        let error = hash_reader_cancellable(&mut reader, &token).unwrap_err();
        assert_eq!(error.code, codes::CANCELLED);
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
            send.send(read(
                &unrestricted(),
                &read_path,
                1024,
                &CancellationToken::new(),
            ))
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
            hash_file(&unrestricted(), &path)
                .unwrap_err()
                .message
                .contains("not a regular file")
        );
        let destination = dir.join("copy");
        assert!(
            move_no_overwrite(&unrestricted(), &path, &destination)
                .unwrap_err()
                .message
                .contains("not a regular file")
        );
        assert!(!destination.exists());
    }

    #[cfg(target_os = "linux")]
    struct CrossDeviceFixture {
        source_root: crate::test_support::ScratchDir,
        destination_root: PathBuf,
    }

    #[cfg(target_os = "linux")]
    impl CrossDeviceFixture {
        fn new() -> Option<Self> {
            let source_root = scratch_dir("cross-device-move");
            let destination_root = Path::new("/dev/shm").join(source_root.file_name().unwrap());
            if let Err(error) = fs::create_dir(&destination_root) {
                eprintln!("cross-device fixture unavailable: {error}");
                return None;
            }
            let fixture = Self {
                source_root,
                destination_root,
            };
            if fs::metadata(&*fixture.source_root).unwrap().dev()
                == fs::metadata(&fixture.destination_root).unwrap().dev()
            {
                eprintln!("cross-device fixture unavailable: temp and /dev/shm share a device");
                return None;
            }
            Some(fixture)
        }
    }

    #[cfg(target_os = "linux")]
    impl Drop for CrossDeviceFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.destination_root);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn cross_device_move_preserves_bytes_mode_and_exclusive_destination() {
        use std::os::unix::fs::PermissionsExt;
        let Some(fixture) = CrossDeviceFixture::new() else {
            return;
        };
        let from = fixture.source_root.join("source");
        let to = fixture.destination_root.join("destination");
        fs::write(&from, b"cross-device bytes").unwrap();
        fs::set_permissions(&from, fs::Permissions::from_mode(0o640)).unwrap();
        let policy = PathPolicy {
            allowed_roots: vec![
                fixture.source_root.to_path_buf(),
                fixture.destination_root.clone(),
            ],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();
        move_no_overwrite(&policy, &from, &to).unwrap();
        assert!(!from.exists());
        assert_eq!(fs::read(&to).unwrap(), b"cross-device bytes");
        assert_eq!(
            fs::metadata(&to).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert_eq!(fs::read_dir(&*fixture.source_root).unwrap().count(), 0);
        fs::write(&from, b"second source").unwrap();
        assert!(move_no_overwrite(&policy, &from, &to).is_err());
        assert_eq!(fs::read(&from).unwrap(), b"second source");
        assert_eq!(fs::read(&to).unwrap(), b"cross-device bytes");
    }

    #[test]
    fn copy_move_helper_preserves_bytes_mode_and_an_exclusive_destination() {
        let root = scratch_dir("fs-io-copy-move-helper");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::write(&source, b"copied bytes").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&source, fs::Permissions::from_mode(0o640)).unwrap();
        }
        let policy = copy_fallback_policy(&root);

        copy_move_no_overwrite_bound_with_hooks(
            &policy,
            &source,
            &destination,
            &mut NoopMoveCopyHooks,
        )
        .unwrap();

        assert!(!source.exists());
        assert_eq!(fs::read(&destination).unwrap(), b"copied bytes");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
                0o640
            );
        }
        fs::write(&source, b"later source").unwrap();
        assert!(
            copy_move_no_overwrite_bound_with_hooks(
                &policy,
                &source,
                &destination,
                &mut NoopMoveCopyHooks,
            )
            .is_err()
        );
        assert_eq!(fs::read(&source).unwrap(), b"later source");
        assert_eq!(fs::read(&destination).unwrap(), b"copied bytes");
    }

    #[test]
    fn copy_move_stages_the_source_before_running_the_publish_hook() {
        let root = scratch_dir("fs-io-copy-move-stage-before-publish-hook");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::write(&source, b"captured source").unwrap();
        let policy = copy_fallback_policy(&root);
        let mut hooks = BeforePublishAfterSourceStage {
            source: source.clone(),
            tombstone: None,
        };

        copy_move_no_overwrite_bound_with_hooks(&policy, &source, &destination, &mut hooks)
            .unwrap();

        assert!(!source.exists());
        assert_eq!(fs::read(&destination).unwrap(), b"captured source");
    }

    #[cfg(not(windows))]
    #[test]
    fn copy_move_uses_bounded_temporary_names_for_a_234_byte_source_leaf() {
        let root = scratch_dir("fs-io-copy-move-long-source-leaf");
        let source = root.join("s".repeat(234));
        let destination = root.join("destination");
        fs::write(&source, b"captured source").unwrap();
        let policy = copy_fallback_policy(&root);

        copy_move_no_overwrite_bound_with_hooks(
            &policy,
            &source,
            &destination,
            &mut NoopMoveCopyHooks,
        )
        .unwrap();

        assert!(!source.exists());
        assert_eq!(fs::read(&destination).unwrap(), b"captured source");
    }

    #[cfg(not(windows))]
    #[test]
    fn copy_move_keeps_a_long_source_when_staging_fails_and_allows_a_retry() {
        let root = scratch_dir("fs-io-copy-move-long-source-stage-failure");
        let source = root.join("s".repeat(234));
        let destination = root.join("destination");
        fs::write(&source, b"captured source").unwrap();
        let policy = copy_fallback_policy(&root);

        let error = copy_move_no_overwrite_bound_with_hooks(
            &policy,
            &source,
            &destination,
            &mut ForcedSourceStageFailure,
        )
        .unwrap_err();

        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert!(error.message.contains(&source.display().to_string()));
        assert!(error.message.contains(&destination.display().to_string()));
        assert_eq!(fs::read(&source).unwrap(), b"captured source");
        assert!(!destination.exists());

        copy_move_no_overwrite_bound_with_hooks(
            &policy,
            &source,
            &destination,
            &mut NoopMoveCopyHooks,
        )
        .unwrap();
        assert!(!source.exists());
        assert_eq!(fs::read(&destination).unwrap(), b"captured source");
    }

    #[test]
    fn copy_move_keeps_the_source_when_staging_fails_before_publication() {
        let root = scratch_dir("fs-io-copy-move-source-stage-failure");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::write(&source, b"captured source").unwrap();
        let policy = copy_fallback_policy(&root);

        let error = copy_move_no_overwrite_bound_with_hooks(
            &policy,
            &source,
            &destination,
            &mut ForcedSourceStageFailure,
        )
        .unwrap_err();

        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert!(error.message.contains(&source.display().to_string()));
        assert!(error.message.contains(&destination.display().to_string()));
        assert_eq!(fs::read(&source).unwrap(), b"captured source");
        assert!(!destination.exists());
    }

    #[test]
    fn copy_move_never_publishes_a_destination_before_source_staging_succeeds() {
        let root = scratch_dir("fs-io-copy-move-stage-before-publish");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::write(&source, b"captured source").unwrap();
        let policy = copy_fallback_policy(&root);
        let mut hooks = SourceStageFailureBeforePublication {
            destination: destination.clone(),
        };

        let error =
            copy_move_no_overwrite_bound_with_hooks(&policy, &source, &destination, &mut hooks)
                .unwrap_err();

        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert_eq!(fs::read(&source).unwrap(), b"captured source");
        assert!(!destination.exists());
    }

    #[test]
    fn copy_move_rejects_an_existing_destination_before_staging_the_source() {
        let root = scratch_dir("fs-io-copy-move-existing-destination-before-stage");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::write(&source, b"captured source").unwrap();
        fs::write(&destination, b"external destination").unwrap();
        let policy = copy_fallback_policy(&root);

        let error = copy_move_no_overwrite_bound_with_hooks(
            &policy,
            &source,
            &destination,
            &mut OccupiedDestinationBeforeSourceStage,
        )
        .unwrap_err();

        assert_eq!(
            error.message,
            format!(
                "\"{}\" already exists. Choose a different destination.",
                destination.display()
            )
        );
        assert!(
            error
                .details
                .as_ref()
                .is_none_or(|details| !details.contains_key("pathsMayHaveChanged"))
        );
        assert_eq!(fs::read(&source).unwrap(), b"captured source");
        assert_eq!(fs::read(&destination).unwrap(), b"external destination");
        assert!(!fs::read_dir(&root).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".mango-")
        }));
    }

    #[test]
    fn copy_move_keeps_a_destination_replaced_before_source_stage_failure() {
        let root = scratch_dir("fs-io-copy-move-source-stage-ownership-uncertain");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::write(&source, b"captured source").unwrap();
        let policy = copy_fallback_policy(&root);
        let mut hooks = DestinationSwapBeforeSourceStageFailure {
            destination: destination.clone(),
        };

        let error =
            copy_move_no_overwrite_bound_with_hooks(&policy, &source, &destination, &mut hooks)
                .unwrap_err();

        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert!(error.message.contains(&source.display().to_string()));
        assert!(error.message.contains(&destination.display().to_string()));
        assert_eq!(fs::read(&source).unwrap(), b"captured source");
        assert_eq!(fs::read(&destination).unwrap(), b"external destination");
    }

    #[test]
    fn copy_move_keeps_the_source_when_tombstone_generation_fails_before_publication() {
        let root = scratch_dir("fs-io-copy-move-source-stage-name-failure");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::write(&source, b"captured source").unwrap();
        let policy = copy_fallback_policy(&root);

        let error = copy_move_no_overwrite_bound_with_hooks(
            &policy,
            &source,
            &destination,
            &mut SourceStageNameFailure,
        )
        .unwrap_err();

        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert!(error.message.contains(&source.display().to_string()));
        assert!(error.message.contains(&destination.display().to_string()));
        assert_eq!(fs::read(&source).unwrap(), b"captured source");
        assert!(!destination.exists());
    }

    #[cfg(not(windows))]
    #[test]
    fn copy_move_reports_both_paths_when_the_source_parent_cannot_be_reopened() {
        let root = scratch_dir("fs-io-copy-move-source-parent-reopen");
        let source_parent = root.join("source-parent");
        let relocated_parent = root.join("relocated-parent");
        fs::create_dir(&source_parent).unwrap();
        let source = source_parent.join("source");
        let destination = root.join("destination");
        fs::write(&source, b"captured source").unwrap();
        let policy = copy_fallback_policy(&root);
        let mut hooks = SourceParentRenamedBeforeSourceStage {
            source_parent,
            relocated_parent: relocated_parent.clone(),
        };

        let error =
            copy_move_no_overwrite_bound_with_hooks(&policy, &source, &destination, &mut hooks)
                .unwrap_err();

        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert!(error.message.contains(&source.display().to_string()));
        assert!(error.message.contains(&destination.display().to_string()));
        assert_eq!(
            fs::read(relocated_parent.join("source")).unwrap(),
            b"captured source"
        );
        assert!(!destination.exists());
    }

    #[test]
    fn copy_move_does_not_report_an_uncreated_temporary_as_recovery_data() {
        let root = scratch_dir("fs-io-copy-move-temporary-collision");
        let source = root.join("source");
        let destination = root.join("destination");
        let temporary = OsString::from("occupied-temporary");
        fs::write(&source, b"captured source").unwrap();
        fs::write(root.join(&temporary), b"external temporary").unwrap();
        let policy = copy_fallback_policy(&root);
        let mut hooks = OccupiedDestinationTemporary {
            temporary: temporary.clone(),
        };

        let error =
            copy_move_no_overwrite_bound_with_hooks(&policy, &source, &destination, &mut hooks)
                .unwrap_err();

        assert_eq!(error.details.unwrap()["kind"], "path_access");
        assert!(
            error
                .message
                .contains(&root.join(&temporary).display().to_string())
        );
        assert!(!error.message.contains("left in place"));
        assert_eq!(fs::read(&source).unwrap(), b"captured source");
        assert!(!destination.exists());
        assert_eq!(
            fs::read(root.join(&temporary)).unwrap(),
            b"external temporary"
        );
    }

    #[cfg(unix)]
    #[test]
    fn temporary_path_keeps_a_non_utf8_parent_and_uses_a_bounded_leaf() {
        use std::os::unix::ffi::{OsStrExt as _, OsStringExt as _};

        let parent = PathBuf::from(OsString::from_vec(b"parent-\xff".to_vec()));
        let path = parent.join("s".repeat(234));
        let temporary = temporary_path(&path).unwrap();

        assert_eq!(
            temporary.parent().unwrap().as_os_str().as_bytes(),
            parent.as_os_str().as_bytes()
        );
        assert!(temporary.file_name().unwrap().as_bytes().len() < 255);
    }

    #[cfg(unix)]
    #[test]
    fn copy_move_creates_a_private_temp_before_streaming_and_restores_source_mode() {
        use std::os::unix::fs::PermissionsExt;

        let root = scratch_dir("fs-io-copy-move-private-temp");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::write(&source, b"captured source").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o640)).unwrap();
        let policy = copy_fallback_policy(&root);
        let mut hooks = PrivateTemporaryBeforeCopy { mode: None };

        copy_move_no_overwrite_bound_with_hooks(&policy, &source, &destination, &mut hooks)
            .unwrap();

        assert_eq!(hooks.mode.unwrap() & 0o077, 0);
        assert_eq!(
            fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }

    #[cfg(unix)]
    #[test]
    fn unrestricted_replacement_temp_is_private_only_when_preserving_an_existing_mode() {
        use std::os::unix::fs::PermissionsExt;

        let root = scratch_dir("fs-io-unrestricted-replacement-private-temp");
        let destination = root.join("destination");
        let temporary = root.join("temporary");
        fs::write(&destination, b"before").unwrap();
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o640)).unwrap();
        let mode = fs::metadata(&destination).unwrap().permissions();
        let capture = BeforeWriteModeCapture::new(&root);

        write_replacement_with_hook(
            &temporary,
            &destination,
            b"after",
            Some(mode),
            |temporary| capture.record(temporary),
        )
        .unwrap();

        assert_eq!(capture.mode() & 0o077, 0);
        assert_eq!(
            fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
            0o640
        );

        let default_mode = default_creation_mode(&root.join("default"));
        let new_destination = root.join("new-destination");
        let new_temporary = root.join("new-temporary");
        let new_capture = BeforeWriteModeCapture::new(&root);
        write_replacement_with_hook(
            &new_temporary,
            &new_destination,
            b"new",
            None,
            |temporary| new_capture.record(temporary),
        )
        .unwrap();

        assert_eq!(new_capture.mode(), default_mode);
        assert_eq!(
            fs::metadata(&new_destination).unwrap().permissions().mode() & 0o777,
            default_mode
        );
    }

    #[cfg(unix)]
    #[test]
    fn bounded_replacement_temp_is_private_only_when_preserving_an_existing_mode() {
        use std::os::unix::fs::PermissionsExt;

        let root = scratch_dir("fs-io-bounded-replacement-private-temp");
        let destination = root.join("destination");
        fs::write(&destination, b"before").unwrap();
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o640)).unwrap();
        let mode = CapPermissions::from_std(fs::metadata(&destination).unwrap().permissions());
        let policy = copy_fallback_policy(&root);
        let parent = capability::verified_parent(&policy, &destination, true).unwrap();
        let capture = BeforeWriteModeCapture::new(&root);

        parent
            .with_parent(|dir, leaf| {
                let temporary = temporary_name()?;
                write_replacement_in_with_hook(
                    dir,
                    leaf,
                    &destination,
                    &temporary,
                    Replacement {
                        bytes: b"after",
                        mode: Some(mode),
                        expected: None,
                    },
                    |phase, temporary| {
                        if phase == ReplacementHookPhase::BeforeWrite {
                            capture.record(temporary);
                        }
                    },
                )
            })
            .unwrap();

        assert_eq!(capture.mode() & 0o077, 0);
        assert_eq!(
            fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
            0o640
        );

        let default_mode = default_creation_mode(&root.join("default"));
        let new_destination = root.join("new-destination");
        let new_parent = capability::verified_parent(&policy, &new_destination, true).unwrap();
        let new_capture = BeforeWriteModeCapture::new(&root);
        new_parent
            .with_parent(|dir, leaf| {
                let temporary = temporary_name()?;
                write_replacement_in_with_hook(
                    dir,
                    leaf,
                    &new_destination,
                    &temporary,
                    Replacement {
                        bytes: b"new",
                        mode: None,
                        expected: None,
                    },
                    |phase, temporary| {
                        if phase == ReplacementHookPhase::BeforeWrite {
                            new_capture.record(temporary);
                        }
                    },
                )
            })
            .unwrap();

        assert_eq!(new_capture.mode(), default_mode);
        assert_eq!(
            fs::metadata(&new_destination).unwrap().permissions().mode() & 0o777,
            default_mode
        );
    }

    #[test]
    fn copy_move_keeps_a_recovery_temp_when_copy_fails() {
        let root = scratch_dir("fs-io-copy-move-copy-failure");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::write(&source, b"captured source").unwrap();
        let policy = copy_fallback_policy(&root);
        let mut hooks = ForcedCopyFailure { temporary: None };

        let error =
            copy_move_no_overwrite_bound_with_hooks(&policy, &source, &destination, &mut hooks)
                .unwrap_err();

        let temporary = hooks.temporary.unwrap();
        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert!(error.message.contains(&temporary.display().to_string()));
        assert_eq!(fs::read(&source).unwrap(), b"captured source");
        assert!(!destination.exists());
        assert!(temporary.exists());
    }

    #[test]
    fn copy_move_keeps_a_recovery_temp_when_destination_cleanup_fails() {
        let root = scratch_dir("fs-io-copy-move-cleanup-failure");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::write(&source, b"captured source").unwrap();
        let policy = copy_fallback_policy(&root);
        let mut hooks = DestinationCollisionWithCleanupFailure {
            destination: destination.clone(),
            temporary: None,
        };

        let error =
            copy_move_no_overwrite_bound_with_hooks(&policy, &source, &destination, &mut hooks)
                .unwrap_err();

        let temporary = hooks.temporary.unwrap();
        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert!(error.message.contains(&temporary.display().to_string()));
        assert_eq!(fs::read(&source).unwrap(), b"captured source");
        assert_eq!(fs::read(&destination).unwrap(), b"external destination");
        assert!(temporary.exists());
    }

    #[test]
    fn copy_move_does_not_publish_a_temporary_replaced_before_commit() {
        let root = scratch_dir("fs-io-copy-move-temporary-swap");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::write(&source, b"captured source").unwrap();
        let policy = copy_fallback_policy(&root);
        let mut hooks = TemporarySwapBeforePublish { temporary: None };

        let error =
            copy_move_no_overwrite_bound_with_hooks(&policy, &source, &destination, &mut hooks)
                .unwrap_err();

        let temporary = hooks.temporary.unwrap();
        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert!(error.message.contains(&temporary.display().to_string()));
        assert_eq!(fs::read(&source).unwrap(), b"captured source");
        assert!(!destination.exists());
        assert_eq!(fs::read(&temporary).unwrap(), b"external temporary");
    }

    #[test]
    fn copy_move_restores_the_source_when_destination_changes_after_publication() {
        let root = scratch_dir("fs-io-copy-move-destination-swap");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::write(&source, b"captured source").unwrap();
        let policy = copy_fallback_policy(&root);

        let error = copy_move_no_overwrite_bound_with_hooks(
            &policy,
            &source,
            &destination,
            &mut PublishedDestinationSwap,
        )
        .unwrap_err();

        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert_eq!(fs::read(&source).unwrap(), b"captured source");
        assert_eq!(fs::read(&destination).unwrap(), b"external destination");
    }

    #[test]
    fn copy_move_keeps_verified_destination_and_tombstone_when_source_reappears() {
        let root = scratch_dir("fs-io-copy-move-source-recreated-after-publication");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::write(&source, b"captured source").unwrap();
        let policy = copy_fallback_policy(&root);
        let mut hooks = SourceRecreatedAfterPublication {
            source: source.clone(),
            tombstone: None,
        };

        let error =
            copy_move_no_overwrite_bound_with_hooks(&policy, &source, &destination, &mut hooks)
                .unwrap_err();

        let tombstone = hooks.tombstone.unwrap();
        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert!(error.message.contains("source was recreated"));
        assert!(error.message.contains(&source.display().to_string()));
        assert!(error.message.contains(&destination.display().to_string()));
        assert!(error.message.contains(&tombstone.display().to_string()));
        assert_eq!(fs::read(&source).unwrap(), b"external source");
        assert_eq!(fs::read(&destination).unwrap(), b"captured source");
        assert_eq!(fs::read(&tombstone).unwrap(), b"captured source");
    }

    #[cfg(not(windows))]
    #[test]
    fn copy_move_retains_recovery_when_the_source_cannot_be_rechecked_after_publish() {
        let root = scratch_dir("fs-io-copy-move-source-parent-after-publish");
        let source_parent = root.join("source-parent");
        let relocated_parent = root.join("relocated-source-parent");
        fs::create_dir(&source_parent).unwrap();
        let source = source_parent.join("source");
        let destination = root.join("destination");
        fs::write(&source, b"captured source").unwrap();
        let policy = copy_fallback_policy(&root);
        let mut hooks = SourceParentRenamedAfterPublication {
            source_parent,
            relocated_parent: relocated_parent.clone(),
            tombstone: None,
        };

        let error =
            copy_move_no_overwrite_bound_with_hooks(&policy, &source, &destination, &mut hooks)
                .unwrap_err();

        let tombstone = hooks.tombstone.unwrap();
        let relocated_tombstone = relocated_parent.join(tombstone.file_name().unwrap());
        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert!(error.message.contains("could not be checked"));
        assert!(error.message.contains(&source.display().to_string()));
        assert!(error.message.contains(&destination.display().to_string()));
        assert!(error.message.contains(&tombstone.display().to_string()));
        assert!(!source.exists());
        assert_eq!(fs::read(&destination).unwrap(), b"captured source");
        assert_eq!(fs::read(&relocated_tombstone).unwrap(), b"captured source");
    }

    #[cfg(not(windows))]
    #[test]
    fn copy_move_retains_recovery_when_the_published_destination_cannot_be_verified() {
        let root = scratch_dir("fs-io-copy-move-destination-parent-after-publish");
        let destination_parent = root.join("destination-parent");
        let relocated_parent = root.join("relocated-destination-parent");
        fs::create_dir(&destination_parent).unwrap();
        let source = root.join("source");
        let destination = destination_parent.join("destination");
        fs::write(&source, b"captured source").unwrap();
        let policy = copy_fallback_policy(&root);
        let mut hooks = DestinationParentRenamedAfterPublication {
            destination_parent,
            relocated_parent: relocated_parent.clone(),
            tombstone: None,
        };

        let error =
            copy_move_no_overwrite_bound_with_hooks(&policy, &source, &destination, &mut hooks)
                .unwrap_err();

        let tombstone = hooks.tombstone.unwrap();
        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert!(
            error
                .message
                .contains("could not be verified to identify the copied bytes")
        );
        assert!(error.message.contains(&source.display().to_string()));
        assert!(error.message.contains(&destination.display().to_string()));
        assert!(error.message.contains(&tombstone.display().to_string()));
        assert!(!source.exists());
        assert_eq!(
            fs::read(relocated_parent.join("destination")).unwrap(),
            b"captured source"
        );
        assert_eq!(fs::read(&tombstone).unwrap(), b"captured source");
    }

    #[test]
    fn copy_move_restores_the_staged_source_when_destination_collides_before_publish() {
        let root = scratch_dir("fs-io-copy-move-source-stage-destination-swap");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::write(&source, b"captured source").unwrap();
        let policy = copy_fallback_policy(&root);
        let mut hooks = DestinationSwapDuringSourceStage {
            destination: destination.clone(),
            tombstone: None,
        };

        let error =
            copy_move_no_overwrite_bound_with_hooks(&policy, &source, &destination, &mut hooks)
                .unwrap_err();

        let tombstone = hooks.tombstone.unwrap();
        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert_eq!(fs::read(&source).unwrap(), b"captured source");
        assert_eq!(fs::read(&destination).unwrap(), b"external destination");
        assert!(!tombstone.exists());
    }

    #[test]
    fn copy_move_preserves_staged_and_copied_recovery_when_source_is_recreated() {
        let root = scratch_dir("fs-io-copy-move-source-recreated-before-restore");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::write(&source, b"captured source").unwrap();
        let policy = copy_fallback_policy(&root);
        let mut hooks = SourceRecreatedBeforeRestore {
            source: source.clone(),
            destination: destination.clone(),
            temporary: None,
            tombstone: None,
        };

        let error =
            copy_move_no_overwrite_bound_with_hooks(&policy, &source, &destination, &mut hooks)
                .unwrap_err();

        let temporary = hooks.temporary.unwrap();
        let tombstone = hooks.tombstone.unwrap();
        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert!(error.message.contains(&temporary.display().to_string()));
        assert!(error.message.contains(&tombstone.display().to_string()));
        assert_eq!(fs::read(&source).unwrap(), b"external source");
        assert_eq!(fs::read(&destination).unwrap(), b"external destination");
        assert_eq!(fs::read(&temporary).unwrap(), b"captured source");
        assert_eq!(fs::read(&tombstone).unwrap(), b"captured source");
    }

    #[test]
    fn copy_move_reports_a_source_swap_after_restore_without_claiming_a_tombstone() {
        let root = scratch_dir("fs-io-copy-move-source-swap-after-restore");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::write(&source, b"captured source").unwrap();
        let policy = copy_fallback_policy(&root);
        let mut hooks = SourceSwapAfterRestore {
            destination: destination.clone(),
            temporary: None,
            tombstone: None,
        };

        let error =
            copy_move_no_overwrite_bound_with_hooks(&policy, &source, &destination, &mut hooks)
                .unwrap_err();

        let temporary = hooks.temporary.unwrap();
        let tombstone = hooks.tombstone.unwrap();
        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert!(error.message.contains("committed source restoration"));
        assert!(error.message.contains(&source.display().to_string()));
        assert!(error.message.contains(&destination.display().to_string()));
        assert!(error.message.contains(&temporary.display().to_string()));
        assert!(!error.message.contains(&tombstone.display().to_string()));
        assert_eq!(fs::read(&source).unwrap(), b"external source");
        assert_eq!(fs::read(&destination).unwrap(), b"external destination");
        assert_eq!(fs::read(&temporary).unwrap(), b"captured source");
        assert!(!tombstone.exists());
    }

    #[cfg(not(windows))]
    #[test]
    fn copy_move_retains_a_captured_temporary_when_the_source_changes_before_staging() {
        let root = scratch_dir("fs-io-copy-move-source-swap");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::write(&source, b"captured source").unwrap();
        let policy = copy_fallback_policy(&root);
        let mut hooks = SourceSwapBeforeStage { temporary: None };

        let error =
            copy_move_no_overwrite_bound_with_hooks(&policy, &source, &destination, &mut hooks)
                .unwrap_err();

        let temporary = hooks.temporary.unwrap();
        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert!(error.message.contains(&temporary.display().to_string()));
        assert_eq!(fs::read(&source).unwrap(), b"external source");
        assert!(!destination.exists());
        assert_eq!(fs::read(&temporary).unwrap(), b"captured source");
    }

    #[test]
    fn atomic_replacement_and_exclusive_creation_preserve_contents() {
        let dir = scratch_dir("fs-io-write");
        let path = dir.join("parent/file");
        let policy = unrestricted();
        assert!(
            write_atomic(&policy, &path, b"first", true)
                .unwrap()
                .is_finite()
        );
        assert!(write_atomic(&policy, &path, b"other", true).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"first");
        write_atomic(&policy, &path, b"second", false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn restricted_file_classification_excludes_directories_and_missing_paths() {
        let root = scratch_dir("fs-io-path-is-file");
        let file = root.join("file");
        let directory = root.join("directory");
        fs::write(&file, b"content").unwrap();
        fs::create_dir(&directory).unwrap();
        let policy = PathPolicy {
            allowed_roots: vec![root.to_path_buf()],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();

        assert!(path_is_file(&policy, &file).unwrap());
        assert!(!path_is_file(&policy, &directory).unwrap());
        assert!(!path_is_file(&policy, &root.join("missing")).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn restricted_overwrite_probe_refuses_a_leaf_swapped_to_a_symlink_or_fifo() {
        use std::os::unix::fs::symlink;

        let root = scratch_dir("fs-io-overwrite-probe-swap");
        let path = root.join("file");
        let outside = root.join("outside");
        std::fs::write(&path, b"inside").unwrap();
        std::fs::write(&outside, b"outside").unwrap();
        let policy = PathPolicy {
            allowed_roots: vec![root.to_path_buf()],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();

        let parent = capability::verified_parent(&policy, &path, false).unwrap();
        let error = inspect_destination_bound_after_metadata(&parent, &path, || {
            std::fs::remove_file(&path).unwrap();
            symlink(&outside, &path).unwrap();
        })
        .unwrap_err();
        assert_eq!(error.details.unwrap()["kind"], "path_access");
        assert_eq!(std::fs::read(&outside).unwrap(), b"outside");

        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, b"inside").unwrap();
        let parent = capability::verified_parent(&policy, &path, false).unwrap();
        let started = std::time::Instant::now();
        let error = inspect_destination_bound_after_metadata(&parent, &path, || {
            std::fs::remove_file(&path).unwrap();
            nix::unistd::mkfifo(
                &path,
                nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
            )
            .unwrap();
        })
        .unwrap_err();
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert_eq!(error.details.unwrap()["kind"], "path_access");
    }

    #[test]
    fn restricted_move_atomically_publishes_a_verified_destination() {
        let root = scratch_dir("fs-io-restricted-atomic-move");
        let source = root.join("source");
        let destination = root.join("destination");
        std::fs::write(&source, b"content").unwrap();
        let policy = PathPolicy {
            allowed_roots: vec![root.to_path_buf()],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();

        move_no_overwrite(&policy, &source, &destination).unwrap();

        assert!(!source.exists());
        assert_eq!(std::fs::read(&destination).unwrap(), b"content");
    }

    #[test]
    fn restricted_move_reports_an_owned_destination_that_fails_hash_verification() {
        let root = scratch_dir("fs-io-move-source-revalidation");
        let source = root.join("source");
        let destination = root.join("destination");
        std::fs::write(&source, b"before").unwrap();
        let policy = PathPolicy {
            allowed_roots: vec![root.to_path_buf()],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();
        let error = move_no_overwrite_bound_with_hooks(
            &policy,
            &source,
            &destination,
            || std::fs::write(&source, b"after").unwrap(),
            || {},
        )
        .unwrap_err();
        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        #[cfg(windows)]
        {
            assert_eq!(std::fs::read(&source).unwrap(), b"after");
            assert!(!destination.exists());
        }
        #[cfg(not(windows))]
        {
            assert!(!source.exists());
            assert_eq!(std::fs::read(&destination).unwrap(), b"after");
        }
    }

    #[test]
    fn restricted_move_reports_the_destination_when_the_source_is_swapped_before_commit() {
        let root = scratch_dir("fs-io-move-destination-replacement");
        let source = root.join("source");
        let destination = root.join("destination");
        std::fs::write(&source, b"before").unwrap();
        let policy = PathPolicy {
            allowed_roots: vec![root.to_path_buf()],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();

        let result = move_no_overwrite_bound_with_hooks(
            &policy,
            &source,
            &destination,
            || {
                std::fs::remove_file(&source).unwrap();
                std::fs::write(&source, b"external replacement").unwrap();
            },
            || {},
        );

        #[cfg(windows)]
        {
            // Windows cannot rename the unlinked source handle. It reports an
            // indeterminate failure instead of moving the external replacement.
            let error = result.unwrap_err();
            assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
            assert_eq!(std::fs::read(&source).unwrap(), b"external replacement");
            assert!(!destination.exists());
        }
        #[cfg(not(windows))]
        {
            let error = result.unwrap_err();
            assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
            assert!(!source.exists());
            assert_eq!(
                std::fs::read(&destination).unwrap(),
                b"external replacement"
            );
        }
    }

    #[test]
    fn restricted_move_leaves_a_replaced_destination_for_manual_recovery() {
        let root = scratch_dir("fs-io-move-destination-verification");
        let source = root.join("source");
        let destination = root.join("destination");
        std::fs::write(&source, b"before").unwrap();
        let policy = PathPolicy {
            allowed_roots: vec![root.to_path_buf()],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();

        let error = move_no_overwrite_bound_with_hooks(
            &policy,
            &source,
            &destination,
            || {},
            || {
                std::fs::remove_file(&destination).unwrap();
                std::fs::write(&destination, b"external replacement").unwrap();
            },
        )
        .unwrap_err();

        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert!(!source.exists());
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"external replacement"
        );
    }

    #[test]
    fn restricted_move_never_rolls_back_a_replacement_after_owned_content_changes() {
        let root = scratch_dir("fs-io-move-changed-then-replaced");
        let source = root.join("source");
        let destination = root.join("destination");
        std::fs::write(&source, b"before").unwrap();
        let policy = PathPolicy {
            allowed_roots: vec![root.to_path_buf()],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();

        let error = move_no_overwrite_bound_with_hooks(
            &policy,
            &source,
            &destination,
            || {},
            || {
                std::fs::write(&destination, b"changed owned inode").unwrap();
                std::fs::remove_file(&destination).unwrap();
                std::fs::write(&destination, b"external replacement").unwrap();
            },
        )
        .unwrap_err();

        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert!(!source.exists());
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"external replacement"
        );
    }

    #[test]
    fn restricted_replacement_refuses_a_temp_name_replaced_before_publication() {
        let root = scratch_dir("fs-io-temp-replacement");
        let path = root.join("file");
        std::fs::write(&path, b"before").unwrap();
        let policy = PathPolicy {
            allowed_roots: vec![root.to_path_buf()],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();
        let parent = capability::verified_parent(&policy, &path, true).unwrap();

        let error = parent
            .with_parent(|dir, leaf| {
                let temp = temporary_name()?;
                write_replacement_in_with_hook(
                    dir,
                    leaf,
                    &path,
                    &temp,
                    Replacement {
                        bytes: b"ours",
                        mode: None,
                        expected: None,
                    },
                    |phase, temp| {
                        if phase == ReplacementHookPhase::Prepared {
                            let temp = root.join(temp);
                            std::fs::remove_file(&temp).unwrap();
                            std::fs::write(&temp, b"external temporary").unwrap();
                        }
                    },
                )
            })
            .unwrap_err();

        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert_eq!(std::fs::read(&path).unwrap(), b"before");
        assert!(std::fs::read_dir(&root)
            .unwrap()
            .any(|entry| std::fs::read(entry.unwrap().path()).unwrap() == b"external temporary"));
    }

    #[test]
    fn restricted_replacement_reports_a_temp_modified_at_publication() {
        let root = scratch_dir("fs-io-temp-publication-mutation");
        let path = root.join("file");
        std::fs::write(&path, b"before").unwrap();
        let policy = PathPolicy {
            allowed_roots: vec![root.to_path_buf()],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();
        let parent = capability::verified_parent(&policy, &path, true).unwrap();

        let error = parent
            .with_parent(|dir, leaf| {
                let temp = temporary_name()?;
                let swapped_temp = root.join(&temp);
                write_replacement_in_with_hook(
                    dir,
                    leaf,
                    &path,
                    &temp,
                    Replacement {
                        bytes: b"ours",
                        mode: None,
                        expected: None,
                    },
                    |phase, _| {
                        if phase == ReplacementHookPhase::BeforePublish {
                            std::fs::write(&swapped_temp, b"external temporary").unwrap();
                        }
                    },
                )
            })
            .unwrap_err();

        assert_eq!(error.details.unwrap()["pathsMayHaveChanged"], true);
        assert_eq!(std::fs::read(&path).unwrap(), b"external temporary");
    }

    #[test]
    fn conditional_replacement_preserves_a_destination_changed_before_publication() {
        let root = scratch_dir("fs-io-conditional-replacement");
        let path = root.join("file");
        std::fs::write(&path, b"before").unwrap();
        let policy = PathPolicy {
            allowed_roots: vec![root.to_path_buf()],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();
        let parent = capability::verified_parent(&policy, &path, false).unwrap();

        let error = parent
            .with_parent(|dir, leaf| {
                let temp = temporary_name()?;
                write_replacement_in_with_hook(
                    dir,
                    leaf,
                    &path,
                    &temp,
                    Replacement {
                        bytes: b"ours",
                        mode: None,
                        expected: Some(ExpectedDestination {
                            bytes: b"before",
                            identity: matching_destination_identity_in(dir, leaf, b"before")?
                                .expect("fixture destination matches"),
                        }),
                    },
                    |phase, _| {
                        if phase == ReplacementHookPhase::BeforePublish {
                            std::fs::remove_file(&path).unwrap();
                            std::fs::write(&path, b"external").unwrap();
                        }
                    },
                )
            })
            .unwrap_err();

        assert_eq!(error.details.unwrap()["kind"], "file_changed");
        assert_eq!(std::fs::read(&path).unwrap(), b"external");
        let entries = std::fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(entries, [OsString::from("file")]);
    }

    #[test]
    fn conditional_replacement_removes_its_temp_when_the_destination_disappears() {
        let root = scratch_dir("fs-io-conditional-replacement-disappears");
        let path = root.join("file");
        std::fs::write(&path, b"before").unwrap();
        let policy = PathPolicy {
            allowed_roots: vec![root.to_path_buf()],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();
        let parent = capability::verified_parent(&policy, &path, false).unwrap();

        let error = parent
            .with_parent(|dir, leaf| {
                let temp = temporary_name()?;
                write_replacement_in_with_hook(
                    dir,
                    leaf,
                    &path,
                    &temp,
                    Replacement {
                        bytes: b"ours",
                        mode: None,
                        expected: Some(ExpectedDestination {
                            bytes: b"before",
                            identity: matching_destination_identity_in(dir, leaf, b"before")?
                                .expect("fixture destination matches"),
                        }),
                    },
                    |phase, _| {
                        if phase == ReplacementHookPhase::BeforePublish {
                            std::fs::remove_file(&path).unwrap();
                        }
                    },
                )
            })
            .unwrap_err();

        assert_eq!(error.code, codes::INTERNAL);
        assert!(!path.exists());
        assert!(std::fs::read_dir(&root).unwrap().next().is_none());
    }

    #[cfg(windows)]
    #[test]
    #[allow(
        unsafe_code,
        reason = "the test inspects the variable-length FILE_RENAME_INFO buffer"
    )]
    fn windows_rename_buffer_uses_a_relative_no_replace_target() {
        use std::os::windows::ffi::OsStrExt as _;
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::Storage::FileSystem::FILE_RENAME_INFO;

        let root = 42_usize as HANDLE;
        let mut buffer = windows_rename_info(root, Path::new("target.txt")).unwrap();
        let info = buffer.storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        let expected: Vec<u16> = std::ffi::OsStr::new("target.txt").encode_wide().collect();
        // SAFETY: `windows_rename_info` returned initialized, aligned storage;
        // the expected slice length is the exact FileNameLength it encoded.
        unsafe {
            assert!(!(*info).Anonymous.ReplaceIfExists);
            assert_eq!((*info).RootDirectory, root);
            assert_eq!((*info).FileNameLength, (expected.len() * 2) as u32);
            assert_eq!(
                std::slice::from_raw_parts((*info).FileName.as_ptr(), expected.len()),
                expected
            );
        }
        assert_eq!(
            buffer.len() as usize,
            std::mem::size_of::<FILE_RENAME_INFO>() + expected.len() * 2
        );
        assert!(windows_rename_info(root, Path::new("nested/target.txt")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn restricted_create_conflict_reports_the_symlink_target() {
        use std::os::unix::fs::symlink;

        let root = scratch_dir("fs-io-create-symlink-diagnostic");
        let target = root.join("target");
        let link = root.join("link");
        std::fs::write(&target, b"target").unwrap();
        symlink(&target, &link).unwrap();
        let policy = PathPolicy {
            allowed_roots: vec![root.to_path_buf()],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();

        let error = create_conflict_error(&policy, &link, "link");
        assert!(
            error
                .message
                .contains(&format!("to \"{}\"", target.display()))
        );
        assert_eq!(error.details.unwrap()["kind"], "path_access");
    }

    #[test]
    fn missing_files_keep_path_access_errors_for_restricted_and_unrestricted_policies() {
        let root = scratch_dir("fs-io-missing-path-access");
        let missing = root.join("missing");
        let restricted = PathPolicy {
            allowed_roots: vec![root.to_path_buf()],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();

        for (scope, policy) in [("restricted", restricted), ("unrestricted", unrestricted())] {
            for (operation, error) in [
                (
                    "read",
                    read(&policy, &missing, 1024, &CancellationToken::new()).unwrap_err(),
                ),
                ("hash", hash_file(&policy, &missing).unwrap_err()),
                (
                    "regular",
                    assert_regular(&policy, &missing, "delete").unwrap_err(),
                ),
            ] {
                assert_eq!(
                    error
                        .details
                        .as_ref()
                        .and_then(|details| details.get("kind")),
                    Some(&serde_json::json!("path_access")),
                    "{scope} {operation}: {error:?}"
                );
                assert!(
                    error.message.starts_with("File not found:"),
                    "{scope} {operation}: {error:?}"
                );
            }
        }
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
    fn atomic_move_never_replaces_an_existing_destination() {
        let dir = scratch_dir("fs-io-move");
        let from = dir.join("from");
        let to = dir.join("nested/to");
        let policy = unrestricted();
        fs::write(&from, b"bytes").unwrap();
        move_no_overwrite(&policy, &from, &to).unwrap();
        assert!(!from.exists());
        fs::write(&from, b"keep").unwrap();
        assert!(move_no_overwrite(&policy, &from, &to).is_err());
        assert_eq!(fs::read(&to).unwrap(), b"bytes");
        assert_eq!(fs::read(&from).unwrap(), b"keep");
        assert_eq!(
            hash_file(&policy, &to).unwrap(),
            "277089d91c0bdf4f2e6862ba7e4a07605119431f5d13f726dd352b06f1b206a9"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_and_readonly_writes_and_preserves_modes() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = scratch_dir("fs-io-mode");
        let path = dir.join("file");
        let policy = unrestricted();
        fs::write(&path, b"before").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        write_atomic(&policy, &path, b"after", false).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        let link = dir.join("link");
        symlink(&path, &link).unwrap();
        assert!(assert_regular(&policy, &link, "delete").is_err());
        assert!(write_atomic(&policy, &link, b"wrong", false).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
        assert!(write_atomic(&policy, &path, b"wrong", false).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"after");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    }
}
