//! Runtime-private staging area for snapshot bytes that do not fit in one frame.
//!
//! A checkpoint of a large file never rides inside a response or a request.
//! Capture copies the file into a staged file while hashing it and returns a
//! reference; the hub pulls it in bounded chunks and releases it. Revert goes
//! the other way: the hub uploads chunks, then names the staged file in the
//! revert operation. Neither direction holds more than one chunk in memory.
//!
//! Staged files are runtime state, not user data. They live in a per-store
//! directory under the OS temp directory that exists only while something is
//! staged, expire when untouched for [`STAGE_TTL`], and a directory abandoned
//! by a crashed runtime is swept the next time a store picks its own.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
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
/// Total bytes the store holds across all staged files.
const STAGE_TOTAL_MAX_BYTES: u64 = 2 * SNAPSHOT_HARD_MAX_BYTES;
/// How long an untouched staged file survives.
pub(super) const STAGE_TTL: Duration = Duration::from_secs(15 * 60);
/// An abandoned store directory older than this belongs to a dead runtime.
const ABANDONED_STORE_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const STORE_DIR_PREFIX: &str = "mangostudio-stage-";
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
}

#[derive(Default)]
struct Entries {
    files: HashMap<String, Entry>,
    total_bytes: u64,
}

pub(super) struct StageStore {
    root: OnceLock<Result<PathBuf, String>>,
    entries: Mutex<Entries>,
    ttl: Duration,
}

impl Default for StageStore {
    fn default() -> Self {
        Self::with_ttl(STAGE_TTL)
    }
}

impl StageStore {
    pub(super) fn with_ttl(ttl: Duration) -> Self {
        Self {
            root: OnceLock::new(),
            entries: Mutex::new(Entries::default()),
            ttl,
        }
    }

    /// Copies `source` into a new staged file in fixed memory, hashing as it
    /// goes. Refuses a source that grows past `max_bytes` while being read.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let staged = store.stage_stream(&mut file, limit, &cancel)?;
    /// ```
    pub(super) fn stage_stream(
        &self,
        source: &mut impl Read,
        max_bytes: u64,
        cancel: &CancellationToken,
    ) -> Result<Staged, RemoteError> {
        let root = self.root()?;
        self.sweep(Instant::now());
        let id = random_id()?;
        let path = root.join(&id);
        let mut file = {
            // Under the entries lock so an idle-directory removal cannot land
            // between creating the directory and creating the file in it.
            let _entries = lock(&self.entries);
            ensure_store_dir(root).map_err(io_error)?;
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(io_error)?
        };
        let copied = copy_hashing(source, &mut file, max_bytes, cancel);
        drop(file);
        let staged = copied.and_then(|(size, sha256)| {
            self.register(&id, size)?;
            Ok(Staged { id, size, sha256 })
        });
        if staged.is_err() {
            let _ = fs::remove_file(&path);
            remove_store_dir_if_idle(&lock(&self.entries), root);
        }
        staged
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
        let root = self.root()?;
        self.sweep(Instant::now());
        let mut entries = lock(&self.entries);
        let staged = entries.files.get(id).map_or(0, |entry| entry.len);
        if offset != staged {
            return Err(invalid_params(format!(
                "Cannot append to staged snapshot \"{id}\" at offset {offset}: expected offset {staged}."
            )));
        }
        let new_len = staged + bytes.len() as u64;
        if new_len > SNAPSHOT_HARD_MAX_BYTES
            || entries.total_bytes + bytes.len() as u64 > STAGE_TOTAL_MAX_BYTES
        {
            return Err(stage_full(new_len));
        }
        ensure_store_dir(root).map_err(io_error)?;
        let path = root.join(id);
        let mut options = OpenOptions::new();
        if staged == 0 {
            options.write(true).create(true).truncate(true);
        } else {
            options.append(true);
        }
        let mut file = options.open(&path).map_err(io_error)?;
        file.write_all(bytes).map_err(io_error)?;
        drop(file);
        entries.total_bytes += bytes.len() as u64;
        entries.files.insert(
            id.to_owned(),
            Entry {
                len: new_len,
                touched: Instant::now(),
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
        let root = self.root()?;
        let mut entries = lock(&self.entries);
        let entry = entries.files.get_mut(id).ok_or_else(|| missing(id))?;
        if offset > entry.len {
            return Err(invalid_params(format!(
                "Cannot read staged snapshot \"{id}\" at offset {offset}: it holds {} bytes.",
                entry.len
            )));
        }
        entry.touched = Instant::now();
        let wanted = length.min(entry.len - offset) as usize;
        let mut file = File::open(root.join(id)).map_err(io_error)?;
        file.seek(SeekFrom::Start(offset)).map_err(io_error)?;
        let mut chunk = vec![0; wanted];
        file.read_exact(&mut chunk).map_err(io_error)?;
        Ok(chunk)
    }

    /// Opens a staged file without re-hashing it, for a caller that verifies
    /// the bytes as it consumes them. Returns the handle and the length.
    pub(super) fn open(&self, id: &str) -> Result<(File, u64), RemoteError> {
        validate_id(id)?;
        let root = self.root()?;
        let len = {
            let mut entries = lock(&self.entries);
            let entry = entries.files.get_mut(id).ok_or_else(|| missing(id))?;
            entry.touched = Instant::now();
            entry.len
        };
        let file = File::open(root.join(id)).map_err(io_error)?;
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
        let root = self.root()?;
        let mut entries = lock(&self.entries);
        if let Some(entry) = entries.files.remove(id) {
            entries.total_bytes = entries.total_bytes.saturating_sub(entry.len);
        }
        let _ = fs::remove_file(root.join(id));
        remove_store_dir_if_idle(&entries, root);
        Ok(())
    }

    /// Drops staged files nobody has touched for the store's TTL.
    pub(super) fn sweep(&self, now: Instant) {
        let Some(Ok(root)) = self.root.get() else {
            return;
        };
        let mut entries = lock(&self.entries);
        let ttl = self.ttl;
        let expired: Vec<String> = entries
            .files
            .iter()
            .filter(|(_, entry)| now.saturating_duration_since(entry.touched) >= ttl)
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            if let Some(entry) = entries.files.remove(&id) {
                entries.total_bytes = entries.total_bytes.saturating_sub(entry.len);
            }
            let _ = fs::remove_file(root.join(&id));
        }
        remove_store_dir_if_idle(&entries, root);
    }

    /// Whether the store's directory currently exists; for tests.
    #[cfg(test)]
    pub(super) fn store_dir_exists(&self) -> bool {
        matches!(self.root.get(), Some(Ok(root)) if root.exists())
    }

    /// Staged files currently held; for tests and diagnostics.
    #[cfg(test)]
    pub(super) fn staged_count(&self) -> usize {
        lock(&self.entries).files.len()
    }

    fn register(&self, id: &str, len: u64) -> Result<(), RemoteError> {
        let mut entries = lock(&self.entries);
        if entries.total_bytes + len > STAGE_TOTAL_MAX_BYTES {
            return Err(stage_full(len));
        }
        entries.total_bytes += len;
        entries.files.insert(
            id.to_owned(),
            Entry {
                len,
                touched: Instant::now(),
            },
        );
        Ok(())
    }

    /// The store's private directory path, chosen on first use so a runtime
    /// that never checkpoints a large file never touches the temp directory.
    /// The directory itself is created per staging and removed when idle.
    fn root(&self) -> Result<&Path, RemoteError> {
        self.root
            .get_or_init(|| choose_store_dir().map_err(|error| error.to_string()))
            .as_deref()
            .map_err(|message| {
                RemoteError::new(
                    codes::INTERNAL,
                    format!("Cannot create the snapshot staging directory: {message}"),
                )
            })
    }
}

impl Drop for StageStore {
    fn drop(&mut self) {
        if let Some(Ok(root)) = self.root.get() {
            let _ = fs::remove_dir_all(root);
        }
    }
}

fn choose_store_dir() -> std::io::Result<PathBuf> {
    let parent = std::env::temp_dir();
    sweep_abandoned_stores(&parent);
    let mut random = [0; 8];
    getrandom::fill(&mut random).map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(parent.join(format!("{STORE_DIR_PREFIX}{}", hex(&random))))
}

/// Creates the private store directory when it is missing.
fn ensure_store_dir(root: &Path) -> std::io::Result<()> {
    match fs::create_dir(root) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(error),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Removes the store directory once nothing is staged, so an idle runtime
/// leaves nothing in the temp directory. `remove_dir` refuses a directory that
/// still holds a file, which covers a stage still copying; the caller holds the
/// entries lock, so it cannot race a stage creating the directory.
fn remove_store_dir_if_idle(entries: &Entries, root: &Path) {
    if entries.files.is_empty() {
        let _ = fs::remove_dir(root);
    }
}

/// Removes store directories a crashed runtime left behind. Age, not
/// ownership, decides: a live store touches its directory whenever it stages.
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
            return Err(stage_full(total));
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

fn stage_full(size: u64) -> RemoteError {
    RemoteError::new(
        codes::INTERNAL,
        format!(
            "Cannot stage {size} bytes of snapshot content: the staging area allows {SNAPSHOT_HARD_MAX_BYTES} bytes per file and {STAGE_TOTAL_MAX_BYTES} in total."
        ),
    )
    .with_detail("kind", "snapshot_too_large")
    .with_detail("sizeBytes", size)
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

    #[test]
    fn stage_stream_then_read_chunks_reassembles_the_source_bytes() {
        let store = store();
        let bytes = pattern(3 * 1024 * 1024 + 17);
        let staged = store
            .stage_stream(
                &mut Cursor::new(&bytes),
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
                1024,
                &CancellationToken::new(),
            )
            .unwrap_err();
        assert_eq!(
            error.details.as_ref().unwrap()["kind"],
            "snapshot_too_large",
            "(stage_stream): expected a snapshot_too_large refusal, received {error:?}"
        );
        assert_eq!(store.staged_count(), 0);
    }

    #[test]
    fn stage_stream_stops_when_cancelled() {
        let store = store();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let error = store
            .stage_stream(&mut Cursor::new(pattern(2048)), u64::MAX, &cancel)
            .unwrap_err();
        assert_eq!(error.code, codes::CANCELLED);
        assert_eq!(store.staged_count(), 0);
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
            error.details.as_ref().unwrap()["kind"],
            "snapshot_stage_corrupt",
            "(open_verified): expected snapshot_stage_corrupt, received {error:?}"
        );
    }

    #[test]
    fn unknown_staged_id_reports_a_missing_stage() {
        let store = store();
        let error = store.read_chunk("nope", 0, 10).unwrap_err();
        assert_eq!(
            error.details.as_ref().unwrap()["kind"],
            "snapshot_stage_missing",
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
        let store = StageStore::with_ttl(Duration::from_secs(60));
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
        let store = StageStore::with_ttl(Duration::from_secs(60));
        store.append_chunk("old", 0, b"x").unwrap();
        store.sweep(Instant::now() + Duration::from_secs(61));
        assert!(
            !store.store_dir_exists(),
            "(sweep): expected the directory to go with the expired file"
        );

        let error = store
            .stage_stream(&mut Cursor::new(vec![0; 64]), 8, &CancellationToken::new())
            .unwrap_err();
        assert_eq!(
            error.details.as_ref().unwrap()["kind"],
            "snapshot_too_large",
            "(stage_stream): expected an over-limit refusal | received: {error:?}"
        );
        assert!(
            !store.store_dir_exists(),
            "(stage_stream): a refused stage must not leave its directory behind"
        );
    }

    #[test]
    fn dropping_the_store_removes_its_directory() {
        let store = store();
        store.append_chunk("up", 0, b"x").unwrap();
        let root = store.root().unwrap().to_path_buf();
        assert!(root.exists());
        drop(store);
        assert!(
            !root.exists(),
            "(drop): expected {} to be removed",
            root.display()
        );
    }
}
