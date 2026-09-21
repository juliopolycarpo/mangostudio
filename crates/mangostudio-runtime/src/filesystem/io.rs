//! Synchronous bounded file operations, called only from the blocking pool.

use std::ffi::OsString;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[cfg(not(windows))]
use cap_fs_ext::MetadataExt as _;
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt as _};
use cap_std::fs::{OpenOptions as CapOpenOptions, Permissions as CapPermissions};
use mango_protocol::error::{RemoteError, codes};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::capability::{self, VerifiedParent};
use super::policy::CompiledPolicy;

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

#[derive(Clone, Copy, PartialEq, Eq)]
struct ObjectIdentity {
    device: u64,
    inode: u64,
}

struct ExpectedDestination<'a> {
    bytes: &'a [u8],
    identity: ObjectIdentity,
}

pub(super) fn path_error(message: impl Into<String>) -> RemoteError {
    RemoteError::new(codes::INTERNAL, message).with_detail("kind", "path_access")
}

pub(super) fn io_error(error: std::io::Error) -> RemoteError {
    RemoteError::new(codes::INTERNAL, error.to_string())
}

fn file_not_found(path: &Path) -> RemoteError {
    path_error(format!("File not found: \"{}\"", path.display()))
}

fn is_missing_path_error(error: &RemoteError) -> bool {
    error.message.starts_with("Filesystem object not found:")
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
    const TEXT_LIMIT: u64 = 10 * 1024 * 1024;
    const BYTE_LIMIT: u64 = 256 * 1024;
    if size > TEXT_LIMIT {
        return path_error(format!(
            "Cannot {action} \"{}\": it is {size} bytes, past the {TEXT_LIMIT}-byte read_file limit, so the read-before-{action} guard cannot be satisfied for this path.",
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

/// Hashes a committed file with fixed memory; callers must finish after mutation begins.
pub(super) fn hash_file(policy: &CompiledPolicy, path: &Path) -> Result<String, RemoteError> {
    let mut file = open_read_scoped(policy, path).map_err(|error| {
        if is_missing_path_error(&error) {
            file_not_found(path)
        } else {
            error
        }
    })?;
    if !file.metadata().map_err(io_error)?.is_file() {
        return Err(path_error(format!(
            "Cannot hash \"{}\": it is not a regular file.",
            path.display()
        )));
    }
    hash_open_file(&mut file)
}

fn hash_open_file(file: &mut File) -> Result<String, RemoteError> {
    let mut hasher = Sha256::new();
    let mut chunk = [0; 64 * 1024];
    loop {
        let count = file.read(&mut chunk).map_err(io_error)?;
        if count == 0 {
            break;
        }
        hasher.update(&chunk[..count]);
    }
    Ok(hash_hex(&hasher.finalize()))
}

fn hash_bytes(bytes: &[u8]) -> String {
    hash_hex(&Sha256::digest(bytes))
}

fn hash_hex(hash: &[u8]) -> String {
    hash.iter().map(|byte| format!("{byte:02x}")).collect()
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
        return write_exclusive_bound(&parent, path, bytes);
    }
    parent.with_parent(|dir, leaf| {
        let mode = inspect_destination_in(dir, leaf, path, || {})?;
        let temp = temporary_leaf(leaf)?;
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
        let temp = temporary_leaf(leaf)?;
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
        return parent.with_parent(|dir, leaf| {
            let mut file = dir
                .open_with(leaf, CapOpenOptions::new().write(true).create_new(true))
                .map_err(create_error)?;
            file.write_all(bytes)
                .and_then(|()| file.into_std().metadata())
                .map(|metadata| mtime(&metadata))
                .map_err(|cause| exclusive_create_uncertain_error(path, cause))
        });
    }
    fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).map_err(io_error)?;
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
    let mut random = [0; 8];
    getrandom::fill(&mut random)
        .map_err(|error| RemoteError::new(codes::INTERNAL, error.to_string()))?;
    let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let mut name = std::ffi::OsString::from(".");
    name.push(path.file_name().unwrap_or_default());
    name.push(format!(".{suffix}.tmp"));
    Ok(path.with_file_name(name))
}

fn temporary_leaf(leaf: &Path) -> Result<OsString, RemoteError> {
    let mut random = [0; 8];
    getrandom::fill(&mut random)
        .map_err(|error| RemoteError::new(codes::INTERNAL, error.to_string()))?;
    let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let mut name = OsString::from(".");
    name.push(leaf.as_os_str());
    name.push(format!(".{suffix}.tmp"));
    Ok(name)
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

fn write_exclusive_bound(
    parent: &VerifiedParent,
    path: &Path,
    bytes: &[u8],
) -> Result<f64, RemoteError> {
    parent.with_parent(|dir, leaf| {
        let mut file = dir
            .open_with(leaf, CapOpenOptions::new().write(true).create_new(true))
            .map_err(io_error)?;
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
    let mut file = dir
        .open_with(temp, CapOpenOptions::new().write(true).create_new(true))
        .map_err(io_error)?;
    let prepared = (|| -> std::io::Result<()> {
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
    let expected_hash = hash_bytes(bytes);
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
        let Some(identity) = matching_destination_identity_in(dir, leaf, expected.bytes)? else {
            remove_owned_temp()?;
            return Err(destination_changed_error(path));
        };
        if identity != expected.identity {
            remove_owned_temp()?;
            return Err(destination_changed_error(path));
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
    let mut options = CapOpenOptions::new();
    options.read(true);
    options.follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt as _;
        options.custom_flags(nix::libc::O_NONBLOCK);
    }
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
    let mut options = CapOpenOptions::new();
    options.read(true);
    options.follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt as _;
        options.custom_flags(nix::libc::O_NONBLOCK);
    }
    let Ok(file) = dir.open_with(temp, &options) else {
        return false;
    };
    let mut file = file.into_std();
    let Ok(metadata) = file.metadata() else {
        return false;
    };
    metadata.is_file()
        && object_identity(&file, &metadata).is_ok_and(|identity| identity == expected_identity)
        && hash_open_file(&mut file).is_ok_and(|hash| hash == expected_hash)
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
    let mut source = open_move_source(policy, &from_parent, from)?;
    let metadata = source.metadata().map_err(io_error)?;
    if !metadata.is_file() {
        return Err(path_error(format!(
            "Cannot move \"{}\": it is not a regular file. Directories and symbolic links are not supported.",
            from.display()
        )));
    }
    let source_identity = object_identity(&source, &metadata).map_err(io_error)?;
    let source_hash = hash_open_file(&mut source)?;
    source.rewind().map_err(io_error)?;
    before_commit();
    match rename_no_replace(&from_parent, &to_parent, &source) {
        Ok(()) => {
            after_commit();
            let retained_hash = source
                .rewind()
                .map_err(io_error)
                .and_then(|()| hash_open_file(&mut source));
            let verification = match retained_hash {
                Ok(_) => verify_moved_destination(&to_parent, &source_hash, source_identity),
                Err(_) => MoveVerification::Uncertain,
            };
            match verification {
                MoveVerification::Matches => Ok(()),
                MoveVerification::OwnedMismatch => {
                    rollback_verified_move(&from_parent, &to_parent, &source, from, to)
                }
                MoveVerification::Uncertain => Err(move_partial_error(from, to)),
            }
        }
        Err(capability::ParentOperationError::Io(error))
            if error.kind() == std::io::ErrorKind::CrossesDevices =>
        {
            Err(cross_device_move_error(from, to))
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
    let mut options = CapOpenOptions::new();
    options.read(true);
    options.follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt as _;
        options.custom_flags(nix::libc::O_NONBLOCK);
    }
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

fn cross_device_move_error(from: &Path, to: &Path) -> RemoteError {
    path_error(format!(
        "Move from \"{}\" to \"{}\" crossed filesystems. No destination was created because the source cannot be moved with an atomic identity guarantee. Inspect both paths before retrying.",
        from.display(),
        to.display()
    ))
    .with_detail("pathsMayHaveChanged", true)
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

#[cfg(not(windows))]
fn object_identity(_: &File, metadata: &Metadata) -> std::io::Result<ObjectIdentity> {
    Ok(ObjectIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(windows)]
#[allow(
    unsafe_code,
    reason = "stable Rust does not expose Windows file identity from Metadata"
)]
fn object_identity(file: &File, _: &Metadata) -> std::io::Result<ObjectIdentity> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    // SAFETY: `file` owns a live handle and `information` points to writable,
    // correctly aligned storage for the structure populated by the API.
    let success =
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
    if success == 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: a successful call initialized every field in the structure.
    let information = unsafe { information.assume_init() };
    Ok(ObjectIdentity {
        device: u64::from(information.dwVolumeSerialNumber),
        inode: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    })
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
                let temp = temporary_leaf(leaf)?;
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
                let temp = temporary_leaf(leaf)?;
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
                let temp = temporary_leaf(leaf)?;
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
