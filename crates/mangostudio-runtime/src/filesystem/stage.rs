//! Runtime-private staging area for snapshot bytes that do not fit in one frame.
//!
//! A checkpoint of a large file never rides inside a response or a request.
//! Capture copies the file into a staged file while hashing it and returns a
//! reference; the hub pulls it in bounded chunks and releases it. Revert goes
//! the other way: the hub uploads chunks, then names the staged file in the
//! revert operation. Neither direction holds more than one chunk in memory.
//!
//! Staged files are runtime state, not user data, and hold user file contents,
//! so the area is private to the account running the runtime:
//!
//! - It lives under a per-user directory (the runtime home's `stage`
//!   directory) when that can be created, and under the OS temp directory
//!   otherwise.
//! - Each store directory has a fresh random name, is created in one call that
//!   fails when the name exists (never adopted), and is owner-only: mode `0700`
//!   on Unix, an owner-only DACL on Windows. It exists only while something is
//!   staged, so an idle runtime leaves nothing behind and the next staging
//!   picks a new name.
//! - Staged files are created exclusively with mode `0600` and reopened
//!   without following symlinks.
//! - Files expire when untouched for [`STAGE_TTL`]; every call into the store
//!   sweeps the expired ones, reads included. A directory abandoned by a
//!   crashed runtime is swept the next time a store picks a name.
//!
//! The store also bounds what it holds: [`STAGE_TOTAL_MAX_BYTES`] across all
//! files and [`STAGE_MAX_FILES`] files at once. A capture reserves its size
//! before copying a byte, so a stage that cannot fit is refused up front and a
//! failed copy gives its reservation back.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use mango_protocol::error::{RemoteError, codes};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::io::{check_cancel, hex, io_error};
use crate::ports::audit::lock;

/// Hard ceiling on one checkpointed file, whatever limit the hub asks for.
pub(super) const SNAPSHOT_HARD_MAX_BYTES: u64 = 1024 * 1024 * 1024;
/// Limit applied when a call does not carry its own `snapshotMaxBytes`.
pub(super) const SNAPSHOT_DEFAULT_MAX_BYTES: u64 = 128 * 1024 * 1024;
/// Largest file a capture still returns inline. Anything bigger is staged and
/// pulled in chunks, so a frame never carries more than one chunk.
pub(super) const SNAPSHOT_INLINE_MAX_BYTES: u64 = 1024 * 1024;
/// Most bytes one `snapshot.read-chunk` returns or `snapshot.stage-chunk`
/// accepts, so a frame carries a bounded slice of a file whatever its size.
pub(super) const SNAPSHOT_CHUNK_MAX_BYTES: u64 = 1024 * 1024;
/// Total bytes the store holds across all staged files. Twice what the hub lets
/// one message's checkpoints hold (`SNAPSHOT_MESSAGE_STAGED_MAX_BYTES` in
/// `limits.ts`), so one revert fits with room for another call beside it.
const STAGE_TOTAL_MAX_BYTES: u64 = 2 * SNAPSHOT_HARD_MAX_BYTES;
/// Most staged files at once: twice what the hub lets one message's revert
/// upload (`SNAPSHOT_MESSAGE_STAGED_MAX_BLOBS` in `limits.ts`).
const STAGE_MAX_FILES: usize = 256;
/// How long an untouched staged file survives.
pub(super) const STAGE_TTL: Duration = Duration::from_secs(15 * 60);
/// An abandoned store directory older than this belongs to a dead runtime.
const ABANDONED_STORE_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const STORE_DIR_PREFIX: &str = "mangostudio-stage-";
/// Fresh names tried before giving up on creating a store directory.
const STORE_DIR_ATTEMPTS: usize = 8;
const COPY_BUFFER_BYTES: usize = 256 * 1024;
const MAX_ID_BYTES: usize = 64;

/// A staged copy of one file's bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Staged {
    pub id: String,
    pub size: u64,
    pub sha256: String,
}

struct Entry {
    len: u64,
    touched: Instant,
    /// A capture still copying: `len` is the size it reserved, not yet the
    /// size it staged, and the sweep leaves it alone.
    pending: bool,
}

#[derive(Default)]
struct Entries {
    files: HashMap<String, Entry>,
    /// Bytes held by staged files plus those reserved by captures in flight.
    total_bytes: u64,
    /// The store directory while anything is staged; a new random name each
    /// time it is created.
    dir: Option<PathBuf>,
}

pub(super) struct StageStore {
    /// Where store directories are created; `None` means the OS temp directory.
    parent: Option<PathBuf>,
    entries: Mutex<Entries>,
    ttl: Duration,
    total_max_bytes: u64,
    max_files: usize,
}

impl Default for StageStore {
    /// A store under the OS temp directory.
    fn default() -> Self {
        Self::new(None, STAGE_TTL)
    }
}

impl StageStore {
    /// A store that creates its directories under `parent` (the per-user
    /// runtime directory), falling back to the OS temp directory when `parent`
    /// cannot be created or secured.
    pub(super) fn under(parent: PathBuf) -> Self {
        Self::new(Some(parent), STAGE_TTL)
    }

    fn new(parent: Option<PathBuf>, ttl: Duration) -> Self {
        Self {
            parent,
            entries: Mutex::new(Entries::default()),
            ttl,
            total_max_bytes: STAGE_TOTAL_MAX_BYTES,
            max_files: STAGE_MAX_FILES,
        }
    }

    /// Copies `source` into a new staged file in fixed memory, hashing as it
    /// goes.
    ///
    /// `size` is the length the caller observed. It is reserved against the
    /// store's budget before the first byte is copied, so a stage that cannot
    /// fit is refused without reading, and the reservation is given back when
    /// the copy fails. The copy never exceeds `size` or `max_bytes`: a source
    /// that grows past what was reserved is refused instead of staged.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let staged = store.stage_stream(&mut file, size, limit, &cancel)?;
    /// ```
    pub(super) fn stage_stream(
        &self,
        source: &mut impl Read,
        size: u64,
        max_bytes: u64,
        cancel: &CancellationToken,
    ) -> Result<Staged, RemoteError> {
        let id = random_id()?;
        let path = {
            let mut entries = lock(&self.entries);
            self.sweep_locked(&mut entries, Instant::now());
            self.reserve_locked(&mut entries, &id, size)?;
            match self.dir_locked(&mut entries) {
                Ok(dir) => dir.join(&id),
                Err(error) => {
                    release_locked(&mut entries, &id);
                    drop_dir_if_idle(&mut entries);
                    return Err(error);
                }
            }
        };
        // The lock is not held while copying, so other calls proceed; the
        // reservation is what keeps them from over-committing the budget.
        let copied = open_new_private(&path)
            .map_err(io_error)
            .and_then(|mut file| copy_hashing(source, &mut file, size.min(max_bytes), cancel));

        let mut entries = lock(&self.entries);
        match copied {
            Ok((copied, sha256)) => {
                if let Some(entry) = entries.files.get_mut(&id) {
                    entry.pending = false;
                    entry.len = copied;
                    entry.touched = Instant::now();
                }
                // The copy never exceeds the reservation; hand back the rest.
                entries.total_bytes = entries.total_bytes.saturating_sub(size - copied);
                Ok(Staged {
                    id,
                    size: copied,
                    sha256,
                })
            }
            Err(error) => {
                let _ = fs::remove_file(&path);
                release_locked(&mut entries, &id);
                drop_dir_if_idle(&mut entries);
                Err(error)
            }
        }
    }

    /// Appends one uploaded chunk. `offset` must equal the bytes staged so
    /// far, so a lost or repeated chunk is refused instead of corrupting the
    /// file. Returns the new staged length.
    pub(super) fn append_chunk(
        &self,
        id: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<u64, RemoteError> {
        validate_id(id)?;
        let mut entries = lock(&self.entries);
        self.sweep_locked(&mut entries, Instant::now());
        let known = entries.files.get(id).map(|entry| entry.len);
        let staged = known.unwrap_or(0);
        if offset != staged {
            return Err(invalid_params(format!(
                "Cannot append to staged snapshot \"{id}\" at offset {offset}: expected offset {staged}."
            )));
        }
        let new_len = staged + bytes.len() as u64;
        if known.is_none() && entries.files.len() >= self.max_files {
            return Err(stage_busy(self.max_files));
        }
        if new_len > SNAPSHOT_HARD_MAX_BYTES
            || entries.total_bytes + bytes.len() as u64 > self.total_max_bytes
        {
            return Err(stage_full(new_len, self.total_max_bytes));
        }
        let dir = self.dir_locked(&mut entries)?;
        let path = dir.join(id);
        let written = if known.is_none() {
            open_new_private(&path)
        } else {
            open_existing(&path, true)
        }
        .and_then(|mut file| file.write_all(bytes));
        if let Err(error) = written {
            // A first chunk that failed midway must not leave its file behind
            // to block a retry under the same id.
            if known.is_none() {
                let _ = fs::remove_file(&path);
                drop_dir_if_idle(&mut entries);
            }
            return Err(io_error(error));
        }
        entries.total_bytes += bytes.len() as u64;
        entries.files.insert(
            id.to_owned(),
            Entry {
                len: new_len,
                touched: Instant::now(),
                pending: false,
            },
        );
        Ok(new_len)
    }

    /// Reads up to `length` bytes at `offset`; shorter only at the end of the
    /// staged file.
    pub(super) fn read_chunk(
        &self,
        id: &str,
        offset: u64,
        length: u64,
    ) -> Result<Vec<u8>, RemoteError> {
        validate_id(id)?;
        let mut entries = lock(&self.entries);
        self.sweep_locked(&mut entries, Instant::now());
        let path = staged_path(&entries, id)?;
        let entry = entries.files.get_mut(id).ok_or_else(|| missing(id))?;
        if offset > entry.len {
            return Err(invalid_params(format!(
                "Cannot read staged snapshot \"{id}\" at offset {offset}: it holds {} bytes.",
                entry.len
            )));
        }
        entry.touched = Instant::now();
        let wanted = length.min(entry.len - offset) as usize;
        let mut file = open_existing(&path, false).map_err(io_error)?;
        file.seek(SeekFrom::Start(offset)).map_err(io_error)?;
        let mut chunk = vec![0; wanted];
        file.read_exact(&mut chunk).map_err(io_error)?;
        Ok(chunk)
    }

    /// Opens a staged file without re-hashing it, for a caller that verifies
    /// the bytes as it consumes them. Returns the handle and the length.
    pub(super) fn open(&self, id: &str) -> Result<(File, u64), RemoteError> {
        validate_id(id)?;
        let (path, len) = {
            let mut entries = lock(&self.entries);
            self.sweep_locked(&mut entries, Instant::now());
            let path = staged_path(&entries, id)?;
            let entry = entries.files.get_mut(id).ok_or_else(|| missing(id))?;
            entry.touched = Instant::now();
            (path, entry.len)
        };
        let file = open_existing(&path, false).map_err(io_error)?;
        Ok((file, len))
    }

    /// Opens a staged file after proving it hashes to `expected_sha256`, so a
    /// revert learns about a corrupt or partial upload before it mutates
    /// anything. Returns the handle rewound to the start, and the length.
    pub(super) fn open_verified(
        &self,
        id: &str,
        expected_sha256: &str,
        cancel: &CancellationToken,
    ) -> Result<(File, u64), RemoteError> {
        let (mut file, len) = self.open(id)?;
        let (copied, observed) = copy_hashing(
            &mut file,
            &mut std::io::sink(),
            SNAPSHOT_HARD_MAX_BYTES,
            cancel,
        )?;
        if copied != len || observed != expected_sha256 {
            return Err(RemoteError::new(
                codes::INTERNAL,
                format!(
                    "Staged snapshot \"{id}\" holds {copied} bytes hashing to {observed}; expected {len} bytes hashing to {expected_sha256}. Upload it again."
                ),
            )
            .with_detail("kind", "snapshot_stage_corrupt")
            .with_detail("stagedId", id));
        }
        file.seek(SeekFrom::Start(0)).map_err(io_error)?;
        Ok((file, len))
    }

    /// Drops a staged file. Releasing an unknown id succeeds: a retry after a
    /// lost response must not fail.
    pub(super) fn release(&self, id: &str) -> Result<(), RemoteError> {
        validate_id(id)?;
        let mut entries = lock(&self.entries);
        self.sweep_locked(&mut entries, Instant::now());
        if let Some(dir) = entries.dir.clone() {
            let _ = fs::remove_file(dir.join(id));
        }
        release_locked(&mut entries, id);
        drop_dir_if_idle(&mut entries);
        Ok(())
    }

    /// Drops staged files nobody has touched for the store's TTL as of `now`;
    /// for tests, which choose the instant. Every call into the store sweeps
    /// as of the real clock.
    #[cfg(test)]
    pub(super) fn sweep(&self, now: Instant) {
        let mut entries = lock(&self.entries);
        self.sweep_locked(&mut entries, now);
    }

    fn sweep_locked(&self, entries: &mut Entries, now: Instant) {
        let expired: Vec<String> = entries
            .files
            .iter()
            .filter(|(_, entry)| {
                !entry.pending && now.saturating_duration_since(entry.touched) >= self.ttl
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            if let Some(dir) = &entries.dir {
                let _ = fs::remove_file(dir.join(&id));
            }
            release_locked(entries, &id);
        }
        drop_dir_if_idle(entries);
    }

    /// Reserves `len` bytes and a file slot for a capture about to copy.
    fn reserve_locked(&self, entries: &mut Entries, id: &str, len: u64) -> Result<(), RemoteError> {
        if entries.files.len() >= self.max_files {
            return Err(stage_busy(self.max_files));
        }
        if len > SNAPSHOT_HARD_MAX_BYTES || entries.total_bytes + len > self.total_max_bytes {
            return Err(stage_full(len, self.total_max_bytes));
        }
        entries.total_bytes += len;
        entries.files.insert(
            id.to_owned(),
            Entry {
                len,
                touched: Instant::now(),
                pending: true,
            },
        );
        Ok(())
    }

    /// The store directory, created under a fresh random name when none exists.
    fn dir_locked(&self, entries: &mut Entries) -> Result<PathBuf, RemoteError> {
        if let Some(dir) = &entries.dir {
            return Ok(dir.clone());
        }
        let dir = create_store_dir(self.parent.as_deref()).map_err(|error| {
            RemoteError::new(
                codes::INTERNAL,
                format!("Cannot create the snapshot staging directory: {error}"),
            )
        })?;
        entries.dir = Some(dir.clone());
        Ok(dir)
    }

    /// Whether the store's directory currently exists; for tests.
    #[cfg(test)]
    pub(super) fn store_dir_exists(&self) -> bool {
        lock(&self.entries)
            .dir
            .as_ref()
            .is_some_and(|dir| dir.exists())
    }

    /// The current store directory; for tests.
    #[cfg(test)]
    fn store_dir(&self) -> Option<PathBuf> {
        lock(&self.entries).dir.clone()
    }

    /// Staged files currently held; for tests and diagnostics.
    #[cfg(test)]
    pub(super) fn staged_count(&self) -> usize {
        lock(&self.entries).files.len()
    }
}

impl Drop for StageStore {
    fn drop(&mut self) {
        if let Some(dir) = lock(&self.entries).dir.take() {
            let _ = fs::remove_dir_all(dir);
        }
    }
}

/// Where a registered staged file lives. An entry always has a directory: it
/// is created with the first file and removed only when no entry remains.
fn staged_path(entries: &Entries, id: &str) -> Result<PathBuf, RemoteError> {
    match (&entries.dir, entries.files.contains_key(id)) {
        (Some(dir), true) => Ok(dir.join(id)),
        _ => Err(missing(id)),
    }
}

/// Forgets a staged file and returns its bytes to the budget.
fn release_locked(entries: &mut Entries, id: &str) {
    if let Some(entry) = entries.files.remove(id) {
        entries.total_bytes = entries.total_bytes.saturating_sub(entry.len);
    }
}

/// Removes the store directory once nothing is staged, so an idle runtime
/// leaves nothing behind and the next staging picks a new name. The caller
/// holds the entries lock, so it cannot race a stage creating the directory.
fn drop_dir_if_idle(entries: &mut Entries) {
    if entries.files.is_empty()
        && let Some(dir) = entries.dir.take()
    {
        let _ = fs::remove_dir_all(dir);
    }
}

/// Creates a store directory under `preferred` (a per-user directory), or under
/// the OS temp directory when that cannot be created and secured.
fn create_store_dir(preferred: Option<&Path>) -> std::io::Result<PathBuf> {
    if let Some(parent) = preferred
        && let Ok(dir) = prepare_private_dir(parent).and_then(|()| create_fresh_dir(parent))
    {
        return Ok(dir);
    }
    create_fresh_dir(&std::env::temp_dir())
}

/// Creates `<parent>/mangostudio-stage-<random>` as a directory only this
/// account can enter. `create_dir` fails when the name exists, so a name is
/// never adopted: a directory someone else planted is skipped, not used.
fn create_fresh_dir(parent: &Path) -> std::io::Result<PathBuf> {
    sweep_abandoned_stores(parent);
    for _ in 0..STORE_DIR_ATTEMPTS {
        let mut random = [0; 8];
        getrandom::fill(&mut random).map_err(|error| std::io::Error::other(error.to_string()))?;
        let candidate = parent.join(format!("{STORE_DIR_PREFIX}{}", hex(&random)));
        match create_private_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        format!(
            "no unused staging directory name under {} after {STORE_DIR_ATTEMPTS} attempts",
            parent.display()
        ),
    ))
}

/// Creates one directory only this account can enter: mode `0700` from the
/// creating call on Unix, an owner-only DACL on Windows (removed again when it
/// cannot be applied).
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        fs::DirBuilder::new().mode(0o700).create(path)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir(path)?;
        restrict_or_remove(path, true)
    }
}

/// Makes the per-user directory that holds store directories, creating any
/// missing ancestor private, and re-restricts it when it already exists. On
/// Unix `chmod` fails for a directory this account does not own, which sends
/// the caller to the temp directory instead of staging under someone else's.
fn prepare_private_dir(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(path)?;
        if crate::runtime_home::owner_only::restrict_to_owner(path) {
            Ok(())
        } else {
            Err(not_restricted(path))
        }
    }
}

/// Applies the owner-only DACL to a path this call just created, removing the
/// path again when that fails so nothing readable by others is left behind.
#[cfg(not(unix))]
fn restrict_or_remove(path: &Path, is_dir: bool) -> std::io::Result<()> {
    if crate::runtime_home::owner_only::restrict_to_owner(path) {
        return Ok(());
    }
    let _ = if is_dir {
        fs::remove_dir(path)
    } else {
        fs::remove_file(path)
    };
    Err(not_restricted(path))
}

#[cfg(not(unix))]
fn not_restricted(path: &Path) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        format!(
            "{} could not be restricted to its owner; expected an owner-only staging path",
            path.display()
        ),
    )
}

/// Creates a staged file that must not exist yet, readable by this account
/// only. `create_new` refuses an existing name, including a symlink planted
/// there.
fn open_new_private(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    // Windows has no mode bits: the file takes an owner-only DACL, and is
    // removed again when that cannot be applied.
    #[cfg(not(unix))]
    restrict_or_remove(path, false)?;
    Ok(file)
}

/// Reopens a staged file for reading, or for appending, without following a
/// symlink at its path.
fn open_existing(path: &Path, append: bool) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    if append {
        options.append(true);
    } else {
        options.read(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}

/// Removes store directories a crashed runtime left behind. Age, not
/// ownership, decides: a live store's directory only exists while it holds a
/// staged file, and every file expires within [`STAGE_TTL`], far below
/// [`ABANDONED_STORE_AGE`].
fn sweep_abandoned_stores(parent: &Path) {
    let Ok(listing) = fs::read_dir(parent) else {
        return;
    };
    for entry in listing.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(STORE_DIR_PREFIX) {
            continue;
        }
        let abandoned = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age >= ABANDONED_STORE_AGE);
        if abandoned {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// Copies `source` to `sink` in fixed memory, returning the byte count and the
/// SHA-256 of what was copied. Fails once more than `max_bytes` have arrived.
fn copy_hashing(
    source: &mut impl Read,
    sink: &mut impl Write,
    max_bytes: u64,
    cancel: &CancellationToken,
) -> Result<(u64, String), RemoteError> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; COPY_BUFFER_BYTES];
    let mut total = 0_u64;
    loop {
        check_cancel(cancel)?;
        let count = source.read(&mut buffer).map_err(io_error)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > max_bytes {
            return Err(stage_full(total, SNAPSHOT_HARD_MAX_BYTES));
        }
        hasher.update(&buffer[..count]);
        sink.write_all(&buffer[..count]).map_err(io_error)?;
    }
    Ok((total, hex(&hasher.finalize())))
}

/// Ids are an allowlist, never a path: the hub chooses upload ids, so one
/// containing a separator must not reach the filesystem.
fn validate_id(id: &str) -> Result<(), RemoteError> {
    let valid = !id.is_empty()
        && id.len() <= MAX_ID_BYTES
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if valid {
        return Ok(());
    }
    Err(invalid_params(format!(
        "Invalid staged snapshot id {id:?}: expected 1 to {MAX_ID_BYTES} characters from [A-Za-z0-9_-]."
    )))
}

fn random_id() -> Result<String, RemoteError> {
    let mut random = [0; 16];
    getrandom::fill(&mut random)
        .map_err(|error| RemoteError::new(codes::INTERNAL, error.to_string()))?;
    Ok(hex(&random))
}

fn invalid_params(message: String) -> RemoteError {
    RemoteError::new(codes::INVALID_PARAMS, message)
}

fn missing(id: &str) -> RemoteError {
    RemoteError::new(
        codes::INTERNAL,
        format!("Staged snapshot \"{id}\" does not exist or has expired."),
    )
    .with_detail("kind", "snapshot_stage_missing")
    .with_detail("stagedId", id)
}

fn stage_full(size: u64, total_max_bytes: u64) -> RemoteError {
    RemoteError::new(
        codes::INTERNAL,
        format!(
            "Cannot stage {size} bytes of snapshot content: the staging area allows {SNAPSHOT_HARD_MAX_BYTES} bytes per file and {total_max_bytes} in total."
        ),
    )
    .with_detail("kind", "snapshot_too_large")
    .with_detail("sizeBytes", size)
}

fn stage_busy(max_files: usize) -> RemoteError {
    RemoteError::new(
        codes::INTERNAL,
        format!(
            "Cannot stage another snapshot: the staging area already holds its limit of {max_files} files. Retry once earlier snapshots are released or expire."
        ),
    )
    .with_detail("kind", "snapshot_too_large")
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    fn store() -> StageStore {
        StageStore::default()
    }

    fn pattern(len: usize) -> Vec<u8> {
        (0..len).map(|index| (index % 251) as u8).collect()
    }

    fn kind_of(error: &RemoteError) -> Option<&str> {
        error
            .details
            .as_ref()
            .and_then(|details| details.get("kind"))
            .and_then(serde_json::Value::as_str)
    }

    #[test]
    fn stage_stream_then_read_chunks_reassembles_the_source_bytes() {
        let store = store();
        let bytes = pattern(3 * 1024 * 1024 + 17);
        let staged = store
            .stage_stream(
                &mut Cursor::new(&bytes),
                bytes.len() as u64,
                u64::MAX,
                &CancellationToken::new(),
            )
            .unwrap();
        assert_eq!(staged.size, bytes.len() as u64);
        assert_eq!(staged.sha256, super::super::io::sha256_hex(&bytes));

        let mut reassembled = Vec::new();
        loop {
            let chunk = store
                .read_chunk(&staged.id, reassembled.len() as u64, 1024 * 1024)
                .unwrap();
            if chunk.is_empty() {
                break;
            }
            reassembled.extend_from_slice(&chunk);
        }
        assert_eq!(
            reassembled.len(),
            bytes.len(),
            "(stage read-chunk): expected {} reassembled bytes",
            bytes.len()
        );
        assert!(reassembled == bytes, "(stage read-chunk): bytes differ");
    }

    #[test]
    fn stage_stream_refuses_a_source_that_outgrows_the_limit_and_leaves_nothing_staged() {
        let store = store();
        let error = store
            .stage_stream(
                &mut Cursor::new(pattern(2048)),
                2048,
                1024,
                &CancellationToken::new(),
            )
            .unwrap_err();
        assert_eq!(
            kind_of(&error),
            Some("snapshot_too_large"),
            "(stage_stream): expected a snapshot_too_large refusal, received {error:?}"
        );
        assert_eq!(store.staged_count(), 0);
    }

    #[test]
    fn stage_stream_refuses_a_source_that_grew_past_the_size_it_reserved() {
        let store = store();
        let error = store
            .stage_stream(
                &mut Cursor::new(pattern(2048)),
                1024,
                u64::MAX,
                &CancellationToken::new(),
            )
            .unwrap_err();
        assert_eq!(
            kind_of(&error),
            Some("snapshot_too_large"),
            "(stage_stream of 2048 bytes against a 1024-byte reservation): expected a snapshot_too_large refusal, received {error:?}"
        );
        assert_eq!(store.staged_count(), 0);
    }

    #[test]
    fn stage_stream_stops_when_cancelled() {
        let store = store();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let error = store
            .stage_stream(&mut Cursor::new(pattern(2048)), 2048, u64::MAX, &cancel)
            .unwrap_err();
        assert_eq!(error.code, codes::CANCELLED);
        assert_eq!(store.staged_count(), 0);
    }

    /// A source that must never be read: proves a refusal came before any copy.
    struct UnreadableSource;

    impl Read for UnreadableSource {
        fn read(&mut self, _buffer: &mut [u8]) -> std::io::Result<usize> {
            panic!("(stage_stream): the source was read although its reservation does not fit");
        }
    }

    #[test]
    fn stage_stream_reserves_its_size_before_it_copies_a_byte() {
        let mut store = store();
        store.total_max_bytes = 100;
        let error = store
            .stage_stream(
                &mut UnreadableSource,
                200,
                u64::MAX,
                &CancellationToken::new(),
            )
            .unwrap_err();
        assert_eq!(
            kind_of(&error),
            Some("snapshot_too_large"),
            "(stage_stream of 200 bytes into a 100-byte budget): expected an up-front refusal, received {error:?}"
        );
        assert_eq!(store.staged_count(), 0);
    }

    /// Runs `during` the first time it is read, then yields `bytes`: a second
    /// caller arriving while the first one is mid-copy.
    struct InterleavedSource<'a> {
        bytes: Cursor<Vec<u8>>,
        during: Option<Box<dyn FnOnce() + 'a>>,
    }

    impl Read for InterleavedSource<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if let Some(during) = self.during.take() {
                during();
            }
            self.bytes.read(buffer)
        }
    }

    #[test]
    fn a_stage_in_flight_holds_its_reservation_against_a_concurrent_one() {
        let mut store = store();
        store.total_max_bytes = 100;
        let rival_outcome = Mutex::new(None);
        let mut source = InterleavedSource {
            bytes: Cursor::new(pattern(80)),
            during: Some(Box::new(|| {
                let rival = store.stage_stream(
                    &mut UnreadableSource,
                    80,
                    u64::MAX,
                    &CancellationToken::new(),
                );
                *lock(&rival_outcome) = Some(rival.map(|staged| staged.id));
            })),
        };

        let first = store.stage_stream(&mut source, 80, u64::MAX, &CancellationToken::new());

        assert!(
            first.is_ok(),
            "(first stage): expected success, received {first:?}"
        );
        let rival = lock(&rival_outcome).take().expect("the rival call ran");
        let error = rival.expect_err(
            "(second stage of 80 bytes while 80 of 100 are reserved): expected a refusal",
        );
        assert_eq!(
            kind_of(&error),
            Some("snapshot_too_large"),
            "received {error:?}"
        );
    }

    #[test]
    fn a_failed_stage_gives_its_reservation_back() {
        let mut store = store();
        store.total_max_bytes = 100;
        let failed = store.stage_stream(
            &mut Cursor::new(pattern(100)),
            100,
            10,
            &CancellationToken::new(),
        );
        assert!(
            failed.is_err(),
            "(stage over its limit): expected a refusal"
        );

        let retried = store.stage_stream(
            &mut Cursor::new(pattern(100)),
            100,
            u64::MAX,
            &CancellationToken::new(),
        );
        assert!(
            retried.is_ok(),
            "(stage of 100 bytes after a failed one released its 100): expected success, received {retried:?}"
        );
    }

    #[test]
    fn a_stage_that_ends_short_returns_the_unused_part_of_its_reservation() {
        let mut store = store();
        store.total_max_bytes = 100;
        // Reserved 100, but the file shrank to 10 bytes while it was copied.
        store
            .stage_stream(
                &mut Cursor::new(pattern(10)),
                100,
                u64::MAX,
                &CancellationToken::new(),
            )
            .unwrap();
        let second = store.stage_stream(
            &mut Cursor::new(pattern(90)),
            90,
            u64::MAX,
            &CancellationToken::new(),
        );
        assert!(
            second.is_ok(),
            "(second stage of 90 bytes beside a 10-byte one in a 100-byte budget): expected success, received {second:?}"
        );
    }

    #[test]
    fn the_store_holds_at_most_its_file_limit() {
        let mut store = store();
        store.max_files = 2;
        store.append_chunk("one", 0, b"a").unwrap();
        store.append_chunk("two", 0, b"b").unwrap();

        let upload = store.append_chunk("three", 0, b"c").unwrap_err();
        assert_eq!(
            kind_of(&upload),
            Some("snapshot_too_large"),
            "(third upload with a 2-file limit): expected a refusal, received {upload:?}"
        );
        let capture = store
            .stage_stream(
                &mut UnreadableSource,
                1,
                u64::MAX,
                &CancellationToken::new(),
            )
            .unwrap_err();
        assert_eq!(
            kind_of(&capture),
            Some("snapshot_too_large"),
            "(capture with a 2-file limit): expected a refusal, received {capture:?}"
        );
        // An upload already in progress is not a new file.
        assert_eq!(store.append_chunk("one", 1, b"z").unwrap(), 2);
        store.release("two").unwrap();
        assert_eq!(store.append_chunk("three", 0, b"c").unwrap(), 1);
    }

    #[test]
    fn append_chunk_requires_sequential_offsets() {
        let store = store();
        assert_eq!(store.append_chunk("upload-1", 0, b"abc").unwrap(), 3);
        assert_eq!(store.append_chunk("upload-1", 3, b"def").unwrap(), 6);
        let error = store.append_chunk("upload-1", 3, b"zzz").unwrap_err();
        assert_eq!(
            error.code,
            codes::INVALID_PARAMS,
            "(append_chunk): expected an INVALID_PARAMS refusal of a repeated offset, received {error:?}"
        );
        assert_eq!(store.read_chunk("upload-1", 0, 100).unwrap(), b"abcdef");
    }

    #[test]
    fn append_chunk_rejects_ids_that_could_leave_the_store_directory() {
        let store = store();
        for id in [
            "",
            "../escape",
            "a/b",
            "a\\b",
            "with space",
            &"x".repeat(65),
        ] {
            let error = store.append_chunk(id, 0, b"x").unwrap_err();
            assert_eq!(
                error.code,
                codes::INVALID_PARAMS,
                "(append_chunk id {id:?}): expected INVALID_PARAMS, received {error:?}"
            );
        }
    }

    #[test]
    fn open_verified_accepts_a_matching_digest_and_rejects_a_mismatch() {
        let store = store();
        store.append_chunk("up", 0, b"hello").unwrap();
        let digest = super::super::io::sha256_hex(b"hello");
        let (mut file, len) = store
            .open_verified("up", &digest, &CancellationToken::new())
            .unwrap();
        let mut content = String::new();
        file.read_to_string(&mut content).unwrap();
        assert_eq!((len, content.as_str()), (5, "hello"));

        let error = store
            .open_verified("up", &"0".repeat(64), &CancellationToken::new())
            .unwrap_err();
        assert_eq!(
            kind_of(&error),
            Some("snapshot_stage_corrupt"),
            "(open_verified): expected snapshot_stage_corrupt, received {error:?}"
        );
    }

    #[test]
    fn unknown_staged_id_reports_a_missing_stage() {
        let store = store();
        let error = store.read_chunk("nope", 0, 10).unwrap_err();
        assert_eq!(
            kind_of(&error),
            Some("snapshot_stage_missing"),
            "(read_chunk): expected snapshot_stage_missing, received {error:?}"
        );
    }

    #[test]
    fn release_is_idempotent_and_frees_the_file() {
        let store = store();
        store.append_chunk("up", 0, b"abc").unwrap();
        store.release("up").unwrap();
        store.release("up").unwrap();
        assert_eq!(store.staged_count(), 0);
        assert!(store.read_chunk("up", 0, 1).is_err());
    }

    #[test]
    fn sweep_drops_only_files_past_the_ttl() {
        let store = StageStore::new(None, Duration::from_secs(60));
        store.append_chunk("old", 0, b"x").unwrap();
        store.sweep(Instant::now() + Duration::from_secs(30));
        assert_eq!(
            store.staged_count(),
            1,
            "(sweep): a fresh file must survive"
        );
        store.sweep(Instant::now() + Duration::from_secs(61));
        assert_eq!(store.staged_count(), 0, "(sweep): an expired file must go");
        assert!(store.read_chunk("old", 0, 1).is_err());
    }

    #[test]
    fn a_read_sweeps_the_files_that_expired() {
        // A zero TTL expires every file by the next call into the store.
        let store = StageStore::new(None, Duration::ZERO);
        store.append_chunk("old", 0, b"x").unwrap();
        assert_eq!(store.staged_count(), 1);

        let error = store.read_chunk("someone-else", 0, 1).unwrap_err();

        assert_eq!(
            kind_of(&error),
            Some("snapshot_stage_missing"),
            "(read_chunk of an unknown id): expected snapshot_stage_missing, received {error:?}"
        );
        assert_eq!(
            store.staged_count(),
            0,
            "(read_chunk): expected the expired file to be swept by a read"
        );
        assert!(
            !store.store_dir_exists(),
            "(read_chunk): expected the idle directory to go with it"
        );
    }

    #[test]
    fn the_directory_exists_only_while_something_is_staged() {
        let store = store();
        assert!(
            !store.store_dir_exists(),
            "(idle store): expected no directory before the first stage"
        );
        store.append_chunk("first", 0, b"a").unwrap();
        store.append_chunk("second", 0, b"b").unwrap();
        assert!(store.store_dir_exists());

        store.release("first").unwrap();
        assert!(
            store.store_dir_exists(),
            "(release): a store still holding a file keeps its directory"
        );
        store.release("second").unwrap();
        assert!(
            !store.store_dir_exists(),
            "(release): expected the directory to go with the last staged file"
        );

        // A later stage recreates it.
        store.append_chunk("third", 0, b"c").unwrap();
        assert_eq!(store.read_chunk("third", 0, 1).unwrap(), b"c");
    }

    #[test]
    fn an_expired_sweep_and_a_refused_stage_leave_no_directory() {
        let store = StageStore::new(None, Duration::from_secs(60));
        store.append_chunk("old", 0, b"x").unwrap();
        store.sweep(Instant::now() + Duration::from_secs(61));
        assert!(
            !store.store_dir_exists(),
            "(sweep): expected the directory to go with the expired file"
        );

        let error = store
            .stage_stream(
                &mut Cursor::new(vec![0; 64]),
                64,
                8,
                &CancellationToken::new(),
            )
            .unwrap_err();
        assert_eq!(
            kind_of(&error),
            Some("snapshot_too_large"),
            "(stage_stream): expected an over-limit refusal | received: {error:?}"
        );
        assert!(
            !store.store_dir_exists(),
            "(stage_stream): a refused stage must not leave its directory behind"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_directory_and_every_staged_file_are_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;

        let store = store();
        store.append_chunk("up", 0, b"x").unwrap();
        let root = store.store_dir().unwrap();
        let mode_of = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode_of(&root),
            0o700,
            "(staging directory {}): expected mode 0700",
            root.display()
        );
        assert_eq!(
            mode_of(&root.join("up")),
            0o600,
            "(staged file in {}): expected mode 0600",
            root.display()
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_planted_at_a_staged_path_is_refused_and_never_written_through() {
        let store = store();
        store.append_chunk("seed", 0, b"x").unwrap();
        let root = store.store_dir().unwrap();
        let victims = crate::test_support::scratch_dir("stage-symlink-victim");
        let victim = victims.join("victim.txt");
        fs::write(&victim, b"untouched").unwrap();
        std::os::unix::fs::symlink(&victim, root.join("planted")).unwrap();

        let result = store.append_chunk("planted", 0, b"overwritten");

        assert!(
            result.is_err(),
            "(append_chunk onto a planted symlink): expected a refusal | received: {result:?}"
        );
        assert_eq!(
            fs::read(&victim).unwrap(),
            b"untouched",
            "(symlink target {}): the stage wrote through the planted link",
            victim.display()
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_swapped_in_for_a_staged_file_is_not_read_through() {
        let store = store();
        store.append_chunk("up", 0, b"secret").unwrap();
        let root = store.store_dir().unwrap();
        let outside = crate::test_support::scratch_dir("stage-symlink-outside");
        let target = outside.join("other.txt");
        fs::write(&target, b"not staged").unwrap();
        fs::remove_file(root.join("up")).unwrap();
        std::os::unix::fs::symlink(&target, root.join("up")).unwrap();

        let result = store.read_chunk("up", 0, 100);

        assert!(
            result.is_err(),
            "(read_chunk of a swapped symlink): expected a refusal | received: {result:?}"
        );
    }

    #[test]
    fn a_recreated_directory_takes_a_fresh_random_name() {
        let store = store();
        store.append_chunk("first", 0, b"a").unwrap();
        let first = store.store_dir().unwrap();
        store.release("first").unwrap();
        assert!(
            !first.exists(),
            "(release): expected the idle directory gone"
        );

        store.append_chunk("second", 0, b"b").unwrap();
        let second = store.store_dir().unwrap();
        assert_ne!(
            first, second,
            "(recreated staging directory): expected a new random name, not the earlier path"
        );
    }

    #[test]
    fn a_store_with_a_parent_stages_beneath_it() {
        let home = crate::test_support::scratch_dir("stage-parent");
        let parent = home.join("runtime").join("stage");
        let store = StageStore::under(parent.clone());
        store.append_chunk("up", 0, b"x").unwrap();

        let dir = store.store_dir().unwrap();
        assert_eq!(
            dir.parent(),
            Some(parent.as_path()),
            "(staging directory {}): expected it under {}",
            dir.display(),
            parent.display()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = fs::metadata(&parent).unwrap().permissions().mode() & 0o777;
            assert_eq!(
                mode,
                0o700,
                "(parent {}): expected mode 0700",
                parent.display()
            );
        }
    }

    #[test]
    fn a_parent_that_cannot_be_created_falls_back_to_the_temp_directory() {
        let home = crate::test_support::scratch_dir("stage-parent-blocked");
        let blocker = home.join("a-file");
        fs::write(&blocker, b"not a directory").unwrap();
        let store = StageStore::under(blocker.join("stage"));
        store.append_chunk("up", 0, b"x").unwrap();

        let dir = store.store_dir().unwrap();
        assert_eq!(
            dir.parent(),
            Some(std::env::temp_dir().as_path()),
            "(staging directory {}): expected the temp directory as parent",
            dir.display()
        );
    }

    #[test]
    fn dropping_the_store_removes_its_directory() {
        let store = store();
        store.append_chunk("up", 0, b"x").unwrap();
        let root = store.store_dir().unwrap();
        assert!(root.exists());
        drop(store);
        assert!(
            !root.exists(),
            "(drop): expected {} to be removed",
            root.display()
        );
    }
}
