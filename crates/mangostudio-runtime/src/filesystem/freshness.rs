//! Per-chat file freshness snapshots and cancellation-aware path locks.
//!
//! The ledger does not read the filesystem. Filesystem handlers supply the
//! bytes and metadata obtained from one descriptor-backed observation, then use
//! [`Ledger::assert_content`] before changing those bytes.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
};

use mango_protocol::error::{RemoteError, codes};
use serde_json::json;
use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio_util::sync::CancellationToken;

use crate::blocking::run_blocking;

const MAX_ENTRIES_PER_CHAT: usize = 256;
const MAX_ENTRIES_GLOBAL: usize = 10_000;
pub(super) const ALL_LINES_VALID: u64 = 9_007_199_254_740_991;

/// A numbered slice shown to the caller.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ObservedLineRange {
    /// The one-based first line in the view.
    pub start_line: u64,
    /// The one-based last line in the view.
    pub end_line: u64,
    /// The number of lines in the complete file.
    pub total_lines: u64,
}

/// The part of a file one read made visible.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReadObservation {
    /// The caller observed every byte as numbered text.
    WholeFile,
    /// The caller observed one numbered text window.
    Window(ObservedLineRange),
    /// The caller observed every byte without assigning line numbers.
    ByteView,
}

/// How far a previous text view's numbering still addresses the current bytes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LineNumbers {
    /// A byte view supplied no numbered text.
    Unobserved,
    /// Lines one through this one remain valid.
    ValidThrough(u64),
}

/// The identity of observed bytes: their SHA-256 digest and length.
///
/// Callers hash content once, outside the ledger lock, and pass the digest to
/// the `*_digest` methods.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContentDigest {
    /// Hex-encoded SHA-256 digest of the content.
    pub sha256: String,
    /// Content length in bytes.
    pub size: u64,
}

impl ContentDigest {
    /// Hashes `content` into its ledger identity.
    ///
    /// ```
    /// use mangostudio_runtime::filesystem::freshness::ContentDigest;
    ///
    /// let digest = ContentDigest::of(b"hello");
    /// assert_eq!((digest.sha256.len(), digest.size), (64, 5));
    /// ```
    #[must_use]
    pub fn of(content: &[u8]) -> Self {
        Self {
            sha256: super::io::sha256_hex(content),
            size: content.len() as u64,
        }
    }
}

/// A recorded immutable file snapshot.
#[derive(Clone, Debug, PartialEq)]
pub struct FreshnessEntry {
    /// Hex-encoded SHA-256 digest of the full observed file.
    pub sha256: String,
    /// File length for callers that can avoid loading a larger stale file.
    pub size: u64,
    /// Descriptor-backed modification time in milliseconds, or `NaN` when unavailable.
    pub mtime_ms: f64,
    /// The highest contiguous line observed from line one.
    pub covered_through_line: u64,
    /// Whether the caller saw the complete content and may overwrite it.
    pub complete: bool,
    /// The current validity of the caller's numbered text view.
    pub line_numbers: LineNumbers,
    lru_tick: u64,
}

/// A bounded collection of per-chat freshness snapshots.
///
/// Paths are used exactly as supplied. Callers must resolve and apply their
/// containment policy before recording an observation.
#[derive(Debug, Default)]
pub struct Ledger {
    entries_by_chat: HashMap<String, HashMap<PathBuf, FreshnessEntry>>,
    next_lru_tick: u64,
}

impl Ledger {
    /// Builds an empty ledger.
    ///
    /// ```
    /// use mangostudio_runtime::filesystem::freshness::Ledger;
    ///
    /// assert_eq!(Ledger::new().len(), 0);
    /// ```
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns the number of snapshots across every chat.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries_by_chat.values().map(HashMap::len).sum()
    }

    /// Returns whether the ledger contains no snapshots.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries_by_chat.is_empty()
    }

    /// Records bytes shown to a chat and returns their SHA-256 digest.
    ///
    /// ```
    /// use std::path::Path;
    /// use mangostudio_runtime::filesystem::freshness::{Ledger, ReadObservation};
    ///
    /// let mut ledger = Ledger::new();
    /// let hash = ledger.record_read("chat", Path::new("/tmp/a"), b"hello", f64::NAN, ReadObservation::WholeFile);
    /// assert_eq!(hash.len(), 64);
    /// ```
    pub fn record_read(
        &mut self,
        chat_id: &str,
        path: &Path,
        content: &[u8],
        observed_mtime_ms: f64,
        observation: ReadObservation,
    ) -> String {
        let digest = ContentDigest::of(content);
        self.record_read_digest(chat_id, path, &digest, observed_mtime_ms, observation);
        digest.sha256
    }

    /// Records a read whose digest the caller computed outside the ledger lock.
    ///
    /// ```
    /// use std::path::Path;
    /// use mangostudio_runtime::filesystem::freshness::{ContentDigest, Ledger, ReadObservation};
    ///
    /// let digest = ContentDigest::of(b"hello");
    /// let mut ledger = Ledger::new();
    /// ledger.record_read_digest("chat", Path::new("/tmp/a"), &digest, f64::NAN, ReadObservation::WholeFile);
    /// ledger.assert_digest("chat", Path::new("/tmp/a"), &digest).unwrap();
    /// ```
    pub fn record_read_digest(
        &mut self,
        chat_id: &str,
        path: &Path,
        digest: &ContentDigest,
        observed_mtime_ms: f64,
        observation: ReadObservation,
    ) {
        let sha256 = &digest.sha256;
        let covered_through_line = match observation {
            ReadObservation::Window(range) => self.extend_coverage(chat_id, path, sha256, range),
            ReadObservation::WholeFile | ReadObservation::ByteView => ALL_LINES_VALID,
        };
        let line_numbers = self.line_numbers_for_observation(chat_id, path, sha256, observation);
        let complete = match observation {
            ReadObservation::Window(range) => covered_through_line >= range.total_lines,
            ReadObservation::WholeFile | ReadObservation::ByteView => true,
        };
        self.store(
            chat_id,
            path.to_path_buf(),
            FreshnessEntry {
                sha256: sha256.clone(),
                size: digest.size,
                mtime_ms: observed_mtime_ms,
                covered_through_line,
                complete,
                line_numbers,
                lru_tick: 0,
            },
        );
    }

    /// Records bytes written by an edit and the numbered prefix that survived it.
    ///
    /// ```
    /// use std::path::Path;
    /// use mangostudio_runtime::filesystem::freshness::Ledger;
    ///
    /// let mut ledger = Ledger::new();
    /// ledger.record_edit("chat", Path::new("/tmp/a"), b"one\ntwo", f64::NAN, 1);
    /// ledger.assert_line_numbers("chat", Path::new("/tmp/a"), 1).unwrap();
    /// ```
    pub fn record_edit(
        &mut self,
        chat_id: &str,
        path: &Path,
        content: &[u8],
        observed_mtime_ms: f64,
        line_numbers_valid_through_line: u64,
    ) -> String {
        let digest = ContentDigest::of(content);
        self.record_edit_digest(
            chat_id,
            path,
            &digest,
            observed_mtime_ms,
            line_numbers_valid_through_line,
        );
        digest.sha256
    }

    /// Records an edit whose digest the caller computed outside the ledger lock.
    ///
    /// ```
    /// use std::path::Path;
    /// use mangostudio_runtime::filesystem::freshness::{ContentDigest, Ledger};
    ///
    /// let mut ledger = Ledger::new();
    /// let digest = ContentDigest::of(b"one\ntwo");
    /// ledger.record_edit_digest("chat", Path::new("/tmp/a"), &digest, f64::NAN, 1);
    /// ledger.assert_line_numbers("chat", Path::new("/tmp/a"), 1).unwrap();
    /// ```
    pub fn record_edit_digest(
        &mut self,
        chat_id: &str,
        path: &Path,
        digest: &ContentDigest,
        observed_mtime_ms: f64,
        line_numbers_valid_through_line: u64,
    ) {
        let previous = self.entry(chat_id, path);
        let previous_valid_through = match previous.map(|entry| entry.line_numbers) {
            Some(LineNumbers::ValidThrough(through_line)) => through_line,
            Some(LineNumbers::Unobserved) | None => ALL_LINES_VALID,
        };
        self.store(
            chat_id,
            path.to_path_buf(),
            FreshnessEntry {
                sha256: digest.sha256.clone(),
                size: digest.size,
                mtime_ms: observed_mtime_ms,
                covered_through_line: ALL_LINES_VALID,
                complete: true,
                line_numbers: LineNumbers::ValidThrough(
                    previous_valid_through.min(line_numbers_valid_through_line),
                ),
                lru_tick: 0,
            },
        );
    }

    /// Returns a complete snapshot, or the wire error a mutation must report.
    pub fn complete_entry(
        &self,
        chat_id: &str,
        path: &Path,
    ) -> Result<FreshnessEntry, RemoteError> {
        let Some(entry) = self.entry(chat_id, path) else {
            return Err(file_not_read_error(path));
        };
        if !entry.complete {
            return Err(partial_read_error(path, entry.covered_through_line));
        }
        Ok(entry.clone())
    }

    /// Verifies bytes against a chat's most recent complete snapshot.
    ///
    /// ```
    /// use std::path::Path;
    /// use mangostudio_runtime::filesystem::freshness::{Ledger, ReadObservation};
    ///
    /// let mut ledger = Ledger::new();
    /// ledger.record_read("chat", Path::new("/tmp/a"), b"hello", f64::NAN, ReadObservation::WholeFile);
    /// ledger.assert_content("chat", Path::new("/tmp/a"), b"hello").unwrap();
    /// ```
    pub fn assert_content(
        &mut self,
        chat_id: &str,
        path: &Path,
        content: &[u8],
    ) -> Result<(), RemoteError> {
        self.assert_digest(chat_id, path, &ContentDigest::of(content))
    }

    /// Verifies a digest computed outside the ledger lock against a chat's
    /// most recent complete snapshot.
    ///
    /// ```
    /// use std::path::Path;
    /// use mangostudio_runtime::filesystem::freshness::{ContentDigest, Ledger, ReadObservation};
    ///
    /// let mut ledger = Ledger::new();
    /// ledger.record_read("chat", Path::new("/tmp/a"), b"hello", f64::NAN, ReadObservation::WholeFile);
    /// assert!(ledger.assert_digest("chat", Path::new("/tmp/a"), &ContentDigest::of(b"hullo")).is_err());
    /// ```
    pub fn assert_digest(
        &mut self,
        chat_id: &str,
        path: &Path,
        digest: &ContentDigest,
    ) -> Result<(), RemoteError> {
        let entry = self.complete_entry(chat_id, path)?;
        if entry.size != digest.size || entry.sha256 != digest.sha256 {
            return Err(stale_file_error(path));
        }
        self.touch(chat_id, path);
        Ok(())
    }

    /// Checks a current metadata observation against a complete snapshot.
    ///
    /// A match avoids a content re-read and refreshes the entry's LRU position.
    /// `NaN` never matches, mirroring the TypeScript ledger's unavailable-mtime
    /// fallback to hashing.
    pub fn matches_metadata(
        &mut self,
        chat_id: &str,
        path: &Path,
        size: u64,
        mtime_ms: f64,
    ) -> Result<bool, RemoteError> {
        let entry = self.complete_entry(chat_id, path)?;
        if entry.size != size || entry.mtime_ms != mtime_ms {
            return Ok(false);
        }
        self.touch(chat_id, path);
        Ok(true)
    }

    /// Verifies that an inclusive one-based range still has the shown numbering.
    ///
    /// Call this after [`Self::assert_content`]. A missing snapshot deliberately
    /// passes here because the content assertion owns the read-before-write gate.
    pub fn assert_line_numbers(
        &self,
        chat_id: &str,
        path: &Path,
        end_line: u64,
    ) -> Result<(), RemoteError> {
        let Some(entry) = self.entry(chat_id, path) else {
            return Ok(());
        };
        match entry.line_numbers {
            LineNumbers::Unobserved => Err(unobserved_line_numbers_error(path)),
            LineNumbers::ValidThrough(valid_through_line) if end_line > valid_through_line => {
                Err(stale_line_numbers_error(path, valid_through_line))
            }
            LineNumbers::ValidThrough(_) => Ok(()),
        }
    }

    /// Removes a chat's snapshot after its path was deleted or replaced.
    pub fn forget(&mut self, chat_id: &str, path: &Path) {
        let remove_chat = self
            .entries_by_chat
            .get_mut(chat_id)
            .is_some_and(|entries| {
                entries.remove(path);
                entries.is_empty()
            });
        if remove_chat {
            self.entries_by_chat.remove(chat_id);
        }
    }

    /// Moves a snapshot after a successful rename.
    pub fn rekey(&mut self, chat_id: &str, from: &Path, to: &Path) {
        if from == to {
            self.touch(chat_id, from);
            return;
        }
        let entry = self.entry(chat_id, from).cloned();
        self.forget(chat_id, to);
        let Some(entry) = entry else {
            return;
        };
        self.forget(chat_id, from);
        self.store(chat_id, to.to_path_buf(), entry);
    }

    fn entry(&self, chat_id: &str, path: &Path) -> Option<&FreshnessEntry> {
        self.entries_by_chat.get(chat_id)?.get(path)
    }

    fn extend_coverage(
        &self,
        chat_id: &str,
        path: &Path,
        sha256: &str,
        observed: ObservedLineRange,
    ) -> u64 {
        let carried = self
            .entry(chat_id, path)
            .filter(|entry| entry.sha256 == sha256)
            .map_or(0, |entry| entry.covered_through_line);
        if observed.start_line > carried.saturating_add(1) {
            carried
        } else {
            carried.max(observed.end_line)
        }
    }

    fn line_numbers_for_observation(
        &self,
        chat_id: &str,
        path: &Path,
        sha256: &str,
        observation: ReadObservation,
    ) -> LineNumbers {
        match observation {
            ReadObservation::ByteView => LineNumbers::Unobserved,
            ReadObservation::WholeFile => LineNumbers::ValidThrough(ALL_LINES_VALID),
            ReadObservation::Window(range) => {
                let previous = self.entry(chat_id, path);
                let same_bytes = previous.is_some_and(|entry| entry.sha256 == sha256);
                let carried = previous
                    .filter(|_| same_bytes)
                    .and_then(|entry| match entry.line_numbers {
                        LineNumbers::ValidThrough(through_line) => Some(through_line),
                        LineNumbers::Unobserved => None,
                    })
                    .unwrap_or(0);
                if range.start_line > carried.saturating_add(1) {
                    return match previous.map(|entry| entry.line_numbers) {
                        Some(LineNumbers::Unobserved) if same_bytes => LineNumbers::Unobserved,
                        _ => LineNumbers::ValidThrough(carried),
                    };
                }
                let through_line = carried.max(range.end_line);
                if through_line >= range.total_lines {
                    LineNumbers::ValidThrough(ALL_LINES_VALID)
                } else {
                    LineNumbers::ValidThrough(through_line)
                }
            }
        }
    }

    fn store(&mut self, chat_id: &str, path: PathBuf, mut entry: FreshnessEntry) {
        entry.lru_tick = self.next_tick();
        let entries = self.entries_by_chat.entry(chat_id.to_owned()).or_default();
        entries.insert(path, entry);
        self.evict_chat(chat_id);
        self.evict_global();
    }

    fn touch(&mut self, chat_id: &str, path: &Path) {
        let tick = self.next_tick();
        if let Some(entry) = self
            .entries_by_chat
            .get_mut(chat_id)
            .and_then(|entries| entries.get_mut(path))
        {
            entry.lru_tick = tick;
        }
    }

    fn next_tick(&mut self) -> u64 {
        if self.next_lru_tick == u64::MAX {
            self.renumber_lru();
        }
        self.next_lru_tick += 1;
        self.next_lru_tick
    }

    fn renumber_lru(&mut self) {
        let mut locations = self
            .entries_by_chat
            .iter()
            .flat_map(|(chat, entries)| {
                entries
                    .iter()
                    .map(move |(path, entry)| (chat.clone(), path.clone(), entry.lru_tick))
            })
            .collect::<Vec<_>>();
        locations.sort_by_key(|(_, _, tick)| *tick);
        for (index, (chat, path, _)) in locations.into_iter().enumerate() {
            if let Some(entry) = self
                .entries_by_chat
                .get_mut(&chat)
                .and_then(|entries| entries.get_mut(&path))
            {
                entry.lru_tick = (index + 1) as u64;
            }
        }
        self.next_lru_tick = self.len() as u64;
    }

    fn evict_chat(&mut self, chat_id: &str) {
        while self
            .entries_by_chat
            .get(chat_id)
            .is_some_and(|entries| entries.len() > MAX_ENTRIES_PER_CHAT)
        {
            let oldest = self.entries_by_chat.get(chat_id).and_then(|entries| {
                entries
                    .iter()
                    .min_by_key(|(_, entry)| entry.lru_tick)
                    .map(|(path, _)| path.clone())
            });
            if let Some(path) = oldest {
                self.forget(chat_id, &path);
            } else {
                break;
            }
        }
    }

    fn evict_global(&mut self) {
        while self.len() > MAX_ENTRIES_GLOBAL {
            let oldest = self
                .entries_by_chat
                .iter()
                .flat_map(|(chat, entries)| {
                    entries
                        .iter()
                        .map(move |(path, entry)| (chat, path, entry.lru_tick))
                })
                .min_by_key(|(_, _, tick)| *tick)
                .map(|(chat, path, _)| (chat.clone(), path.clone()));
            if let Some((chat, path)) = oldest {
                self.forget(&chat, &path);
            } else {
                break;
            }
        }
    }
}

fn service_error(kind: &'static str, message: String, path: &Path) -> RemoteError {
    RemoteError::new(codes::INTERNAL, message)
        .with_detail("kind", kind)
        .with_detail("resolvedPath", path.display().to_string())
}

pub(super) fn file_not_read_error(path: &Path) -> RemoteError {
    service_error(
        "file_not_read",
        format!(
            "You must read \"{}\" with read_file before modifying it.",
            path.display()
        ),
        path,
    )
}

fn partial_read_error(path: &Path, covered_through_line: u64) -> RemoteError {
    let observed = if covered_through_line > 0 {
        format!("only lines 1-{covered_through_line} have been read")
    } else {
        "it has not been read from line 1".to_owned()
    };
    service_error(
        "partial_read",
        format!(
            "Cannot modify \"{}\": {observed} in this chat. A safe mutation requires a complete view of the current file, so read the remaining lines with read_file (startLine/maxLines) first.",
            path.display()
        ),
        path,
    )
    .with_detail("coveredThroughLine", json!(covered_through_line))
}

pub(super) fn stale_file_error(path: &Path) -> RemoteError {
    service_error(
        "stale_file",
        format!(
            "\"{}\" changed on disk since it was last read (content hash mismatch). Re-read the file and retry with the current content.",
            path.display()
        ),
        path,
    )
}

fn stale_line_numbers_error(path: &Path, valid_through_line: u64) -> RemoteError {
    let remaining = if valid_through_line > 0 {
        format!("only lines 1-{valid_through_line} still match the last read")
    } else {
        "no line numbers still match the last read".to_owned()
    };
    service_error(
        "stale_line_numbers",
        format!(
            "Line numbers for \"{}\" are stale: an earlier edit in this chat changed the file's line count, so {remaining}. Re-read the file with read_file to get the current numbering before replacing this range.",
            path.display()
        ),
        path,
    )
    .with_detail("validThroughLine", json!(valid_through_line))
}

fn unobserved_line_numbers_error(path: &Path) -> RemoteError {
    service_error(
        "unobserved_line_numbers",
        format!(
            "Line numbers for \"{}\" were never observed: the last read was a byte view (hex or base64), which does not assign line numbers. Re-read the file as text with read_file first, then retry replacing this range.",
            path.display()
        ),
        path,
    )
}

/// A lock set acquired for sorted, unique paths.
///
/// Its guards are owned, so callers can move this value into a blocking
/// closure. The locks then remain held even if the async task awaiting that
/// closure is dropped.
#[derive(Debug)]
pub struct PathLockGuards {
    owner: Arc<PathLockTable>,
    held: Vec<(PathBuf, Arc<Mutex<()>>, OwnedMutexGuard<()>)>,
}

impl Drop for PathLockGuards {
    fn drop(&mut self) {
        let held = std::mem::take(&mut self.held);
        let released = held
            .iter()
            .map(|(path, lock, _)| (path.clone(), Arc::clone(lock)))
            .collect::<Vec<_>>();
        drop(held);
        let mut locks = self
            .owner
            .locks
            .lock()
            .expect("path lock table mutex is not poisoned");
        for (path, released_lock) in released {
            if locks
                .get(&path)
                .is_some_and(|current| Arc::ptr_eq(current, &released_lock))
                // The table and `released_lock` itself are the only two
                // references once no guard or waiter can still use it.
                && Arc::strong_count(&released_lock) == 2
            {
                locks.remove(&path);
            }
        }
    }
}

#[derive(Debug, Default)]
struct PathLockTable {
    locks: StdMutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
}

/// A process-shared table of asynchronous path locks.
#[derive(Clone, Debug, Default)]
pub struct PathLocks {
    owner: Arc<PathLockTable>,
}

/// Why path-lock acquisition stopped before all locks were held.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PathLockError {
    /// The supplied cancellation token fired while waiting for a lock.
    Cancelled,
}

impl PathLocks {
    /// Builds an empty shared lock table.
    ///
    /// ```
    /// use mangostudio_runtime::filesystem::freshness::PathLocks;
    ///
    /// let locks = PathLocks::new();
    /// assert_eq!(locks.active_paths(), 0);
    /// ```
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Acquires every distinct path in lexical `PathBuf` order.
    ///
    /// ```
    /// use std::path::PathBuf;
    /// use mangostudio_runtime::filesystem::freshness::PathLocks;
    /// use tokio_util::sync::CancellationToken;
    ///
    /// # #[tokio::main(flavor = "current_thread")]
    /// # async fn main() {
    /// let locks = PathLocks::new();
    /// let _held = locks.acquire(vec![PathBuf::from("/tmp/a")], &CancellationToken::new()).await.unwrap();
    /// # }
    /// ```
    pub async fn acquire<I>(
        &self,
        paths: I,
        cancel: &CancellationToken,
    ) -> Result<PathLockGuards, PathLockError>
    where
        I: IntoIterator<Item = PathBuf>,
    {
        let mut ordered = paths.into_iter().collect::<Vec<_>>();
        ordered.sort();
        ordered.dedup();
        let mut acquired = PathLockGuards {
            owner: Arc::clone(&self.owner),
            held: Vec::with_capacity(ordered.len()),
        };
        for path in ordered {
            if cancel.is_cancelled() {
                return Err(PathLockError::Cancelled);
            }
            let lock = self.lock_for(&path);
            let guard = tokio::select! {
                _ = cancel.cancelled() => {
                    self.remove_idle(&path, &lock);
                    return Err(PathLockError::Cancelled);
                }
                guard = Arc::clone(&lock).lock_owned() => guard,
            };
            acquired.held.push((path, lock, guard));
        }
        Ok(acquired)
    }

    /// Acquires paths, then runs synchronous work with those guards owned by its worker.
    ///
    /// Moving the guards into [`run_blocking`] keeps them alive until `work`
    /// finishes if the outer task is cancelled or dropped.
    pub async fn with_blocking_locks<I, F, T>(
        &self,
        paths: I,
        cancel: &CancellationToken,
        work: F,
    ) -> Result<T, PathLockError>
    where
        I: IntoIterator<Item = PathBuf>,
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        let guards = self.acquire(paths, cancel).await?;
        Ok(run_blocking(move || {
            let _guards = guards;
            work()
        })
        .await)
    }

    /// Returns paths that still have a live lock or waiter.
    #[must_use]
    pub fn active_paths(&self) -> usize {
        self.owner
            .locks
            .lock()
            .expect("path lock table mutex is not poisoned")
            .len()
    }

    fn lock_for(&self, path: &Path) -> Arc<Mutex<()>> {
        let mut locks = self
            .owner
            .locks
            .lock()
            .expect("path lock table mutex is not poisoned");
        Arc::clone(
            locks
                .entry(path.to_path_buf())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    }

    fn remove_idle(&self, path: &Path, lock: &Arc<Mutex<()>>) {
        let mut locks = self
            .owner
            .locks
            .lock()
            .expect("path lock table mutex is not poisoned");
        if locks
            .get(path)
            .is_some_and(|current| Arc::ptr_eq(current, lock))
            // The table and this local reference are all that remain.
            && Arc::strong_count(lock) == 2
        {
            locks.remove(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        path::{Path, PathBuf},
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        time::Duration,
    };

    use serde_json::json;
    use tokio::sync::Barrier;
    use tokio_util::sync::CancellationToken;

    use super::{
        ContentDigest, Ledger, ObservedLineRange, PathLockError, PathLocks, ReadObservation,
    };

    fn path(name: &str) -> PathBuf {
        PathBuf::from(format!("/workspace/{name}"))
    }

    #[test]
    fn digest_methods_record_the_same_entries_as_the_byte_methods() {
        let window = ReadObservation::Window(ObservedLineRange {
            start_line: 1,
            end_line: 1,
            total_lines: 2,
        });
        let digest = ContentDigest::of(b"one\ntwo\n");
        let mut by_bytes = Ledger::new();
        let mut by_digest = Ledger::new();
        let file = path("digest.txt");

        let hash = by_bytes.record_read("chat", &file, b"one\ntwo\n", 1.0, window);
        by_digest.record_read_digest("chat", &file, &digest, 1.0, window);
        assert_eq!(hash, digest.sha256);
        assert_eq!(
            by_bytes.entry("chat", &file),
            by_digest.entry("chat", &file)
        );

        let edited = ContentDigest::of(b"one\n");
        by_bytes.record_edit("chat", &file, b"one\n", 2.0, 1);
        by_digest.record_edit_digest("chat", &file, &edited, 2.0, 1);
        assert_eq!(
            by_bytes.entry("chat", &file),
            by_digest.entry("chat", &file)
        );

        by_digest.assert_digest("chat", &file, &edited).unwrap();
        let stale = by_digest
            .assert_digest("chat", &file, &ContentDigest::of(b"two\n"))
            .unwrap_err();
        assert_eq!(kind(&stale), "stale_file");
    }

    fn kind(error: &mango_protocol::error::RemoteError) -> &serde_json::Value {
        &error.details.as_ref().expect("details")["kind"]
    }

    #[test]
    fn whole_and_sequential_window_reads_control_content_completeness() {
        let mut ledger = Ledger::new();
        let file = path("window.txt");
        let window = |start_line, end_line| {
            ReadObservation::Window(ObservedLineRange {
                start_line,
                end_line,
                total_lines: 4,
            })
        };
        ledger.record_read("chat", &file, b"a\nb\nc\nd", f64::NAN, window(1, 2));
        let error = ledger.complete_entry("chat", &file).unwrap_err();
        assert_eq!(kind(&error), &json!("partial_read"));
        assert_eq!(
            error.details.expect("details")["coveredThroughLine"],
            json!(2)
        );
        ledger.record_read("chat", &file, b"a\nb\nc\nd", f64::NAN, window(3, 4));
        assert!(ledger.complete_entry("chat", &file).unwrap().complete);
        ledger.assert_content("chat", &file, b"a\nb\nc\nd").unwrap();
    }

    #[test]
    fn a_window_with_a_hole_stays_partial_and_new_bytes_reset_it() {
        let mut ledger = Ledger::new();
        let file = path("holes.txt");
        let window = |start_line, end_line| {
            ReadObservation::Window(ObservedLineRange {
                start_line,
                end_line,
                total_lines: 3,
            })
        };
        ledger.record_read("chat", &file, b"a\nb\nc", f64::NAN, window(2, 3));
        assert_eq!(
            ledger
                .complete_entry("chat", &file)
                .unwrap_err()
                .details
                .expect("details")["coveredThroughLine"],
            json!(0)
        );
        ledger.record_read("chat", &file, b"x\ny\nz", f64::NAN, window(2, 3));
        assert_eq!(
            ledger
                .complete_entry("chat", &file)
                .unwrap_err()
                .details
                .expect("details")["coveredThroughLine"],
            json!(0)
        );
    }

    #[test]
    fn byte_views_allow_content_writes_but_not_line_addressed_edits() {
        let mut ledger = Ledger::new();
        let file = path("bytes.bin");
        ledger.record_read(
            "chat",
            &file,
            b"\0bytes",
            f64::NAN,
            ReadObservation::ByteView,
        );
        ledger.assert_content("chat", &file, b"\0bytes").unwrap();
        assert_eq!(
            kind(&ledger.assert_line_numbers("chat", &file, 1).unwrap_err()),
            &json!("unobserved_line_numbers")
        );

        ledger.record_read(
            "chat",
            &file,
            b"\0bytes",
            f64::NAN,
            ReadObservation::Window(ObservedLineRange {
                start_line: 1,
                end_line: 1,
                total_lines: 2,
            }),
        );
        ledger.assert_line_numbers("chat", &file, 1).unwrap();
        assert_eq!(
            kind(&ledger.assert_line_numbers("chat", &file, 2).unwrap_err()),
            &json!("stale_line_numbers")
        );
    }

    #[test]
    fn edits_preserve_only_the_smallest_numbered_prefix_until_a_fresh_read() {
        let mut ledger = Ledger::new();
        let file = path("edit.txt");
        ledger.record_read(
            "chat",
            &file,
            b"a\nb\nc",
            f64::NAN,
            ReadObservation::WholeFile,
        );
        ledger.record_edit("chat", &file, b"a\ninsert\nb\nc", f64::NAN, 1);
        ledger.assert_line_numbers("chat", &file, 1).unwrap();
        let stale = ledger.assert_line_numbers("chat", &file, 2).unwrap_err();
        assert_eq!(kind(&stale), &json!("stale_line_numbers"));
        assert_eq!(
            stale.details.expect("details")["validThroughLine"],
            json!(1)
        );
        ledger.record_read(
            "chat",
            &file,
            b"a\ninsert\nb\nc",
            f64::NAN,
            ReadObservation::WholeFile,
        );
        ledger.assert_line_numbers("chat", &file, 4).unwrap();
    }

    #[test]
    fn missing_partial_and_stale_content_have_the_contract_errors() {
        let mut ledger = Ledger::new();
        let file = path("stale.txt");
        assert_eq!(
            kind(&ledger.assert_content("chat", &file, b"no").unwrap_err()),
            &json!("file_not_read")
        );
        ledger.record_read(
            "chat",
            &file,
            b"one\ntwo",
            f64::NAN,
            ReadObservation::Window(ObservedLineRange {
                start_line: 1,
                end_line: 1,
                total_lines: 2,
            }),
        );
        assert_eq!(
            kind(
                &ledger
                    .assert_content("chat", &file, b"one\ntwo")
                    .unwrap_err()
            ),
            &json!("partial_read")
        );
        ledger.record_read(
            "chat",
            &file,
            b"one\ntwo",
            f64::NAN,
            ReadObservation::WholeFile,
        );
        assert_eq!(
            kind(
                &ledger
                    .assert_content("chat", &file, b"changed")
                    .unwrap_err()
            ),
            &json!("stale_file")
        );
    }

    #[test]
    fn matching_metadata_touches_without_treating_nan_as_current() {
        let mut ledger = Ledger::new();
        let file = path("metadata.txt");
        ledger.record_read("chat", &file, b"same", 42.0, ReadObservation::WholeFile);
        assert!(ledger.matches_metadata("chat", &file, 4, 42.0).unwrap());
        assert!(!ledger.matches_metadata("chat", &file, 4, f64::NAN).unwrap());
        assert!(!ledger.matches_metadata("chat", &file, 5, 42.0).unwrap());
    }

    #[test]
    fn forget_and_rekey_preserve_path_identity_without_normalising() {
        let mut ledger = Ledger::new();
        let source = Path::new("/workspace/dir/../source.txt");
        let destination = Path::new("/workspace/destination.txt");
        ledger.record_read(
            "chat",
            source,
            b"source",
            f64::NAN,
            ReadObservation::WholeFile,
        );
        ledger.rekey("chat", source, destination);
        assert_eq!(
            kind(&ledger.complete_entry("chat", source).unwrap_err()),
            &json!("file_not_read")
        );
        ledger
            .assert_content("chat", destination, b"source")
            .unwrap();
        ledger.forget("chat", destination);
        assert!(ledger.is_empty());
    }

    #[test]
    fn per_chat_and_global_limits_evict_the_least_recent_entries() {
        let mut ledger = Ledger::new();
        for index in 0..257 {
            let file = path(&format!("per-chat-{index}"));
            ledger.record_read("one", &file, b"x", f64::NAN, ReadObservation::WholeFile);
        }
        assert_eq!(ledger.len(), 256);
        assert_eq!(
            kind(
                &ledger
                    .complete_entry("one", &path("per-chat-0"))
                    .unwrap_err()
            ),
            &json!("file_not_read")
        );
        ledger
            .assert_content("one", &path("per-chat-1"), b"x")
            .unwrap();
        ledger.record_read(
            "one",
            &path("per-chat-new"),
            b"x",
            f64::NAN,
            ReadObservation::WholeFile,
        );
        assert_eq!(
            kind(
                &ledger
                    .complete_entry("one", &path("per-chat-2"))
                    .unwrap_err()
            ),
            &json!("file_not_read")
        );

        for index in 0..10_000 {
            let file = path(&format!("global-{index}"));
            ledger.record_read(
                &format!("chat-{index}"),
                &file,
                b"x",
                f64::NAN,
                ReadObservation::WholeFile,
            );
        }
        assert_eq!(ledger.len(), 10_000);
        assert_eq!(
            kind(
                &ledger
                    .complete_entry("one", &path("per-chat-1"))
                    .unwrap_err()
            ),
            &json!("file_not_read")
        );
    }

    #[tokio::test]
    async fn cancelled_waiter_releases_its_partial_acquisition() {
        let locks = PathLocks::new();
        let cancel = CancellationToken::new();
        let blocked = locks
            .acquire(vec![path("b")], &CancellationToken::new())
            .await
            .unwrap();
        let waiting_locks = locks.clone();
        let waiting_cancel = cancel.clone();
        let waiter = tokio::spawn(async move {
            waiting_locks
                .acquire(vec![path("a"), path("b")], &waiting_cancel)
                .await
        });
        tokio::task::yield_now().await;
        cancel.cancel();
        assert!(matches!(
            waiter.await.unwrap(),
            Err(PathLockError::Cancelled)
        ));
        // The cancelled waiter first owned `a` and then waited on `b`, so
        // only the explicitly held `b` remains in the table.
        assert_eq!(locks.active_paths(), 1);
        drop(blocked);
        let acquired = locks
            .acquire(vec![path("a"), path("b")], &CancellationToken::new())
            .await
            .unwrap();
        drop(acquired);
        assert_eq!(locks.active_paths(), 0);
    }

    #[test]
    fn cancellation_race_cleanup_removes_an_unacquired_path() {
        let locks = PathLocks::new();
        let file = path("racing-cancel");
        let pending = locks.lock_for(&file);
        assert_eq!(locks.active_paths(), 1);
        locks.remove_idle(&file, &pending);
        assert_eq!(locks.active_paths(), 0);
    }

    #[tokio::test]
    async fn sorted_acquisition_prevents_opposite_path_orders_from_deadlocking() {
        let locks = PathLocks::new();
        let start = Arc::new(Barrier::new(2));
        let left_locks = locks.clone();
        let left_start = Arc::clone(&start);
        let left = tokio::spawn(async move {
            left_start.wait().await;
            let guards = left_locks
                .acquire(vec![path("b"), path("a")], &CancellationToken::new())
                .await
                .unwrap();
            drop(guards);
        });
        let right_locks = locks.clone();
        let right_start = Arc::clone(&start);
        let right = tokio::spawn(async move {
            right_start.wait().await;
            let guards = right_locks
                .acquire(
                    vec![path("a"), path("b"), path("a")],
                    &CancellationToken::new(),
                )
                .await
                .unwrap();
            drop(guards);
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            left.await.unwrap();
            right.await.unwrap();
        })
        .await
        .expect("ordered lock acquisition must settle");
    }

    #[tokio::test]
    async fn blocking_work_retains_guards_after_the_outer_task_is_dropped() {
        let locks = PathLocks::new();
        let started = Arc::new(AtomicBool::new(false));
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let task_locks = locks.clone();
        let task_started = Arc::clone(&started);
        let task = tokio::spawn(async move {
            task_locks
                .with_blocking_locks(vec![path("held")], &CancellationToken::new(), move || {
                    task_started.store(true, Ordering::SeqCst);
                    release_rx
                        .recv()
                        .expect("test release sender remains alive");
                })
                .await
        });
        while !started.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
        task.abort();
        assert_eq!(locks.active_paths(), 1);
        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if locks.active_paths() == 0 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("blocking worker releases the path lock");
    }

    fn window(start_line: u64, end_line: u64, total_lines: u64) -> ReadObservation {
        ReadObservation::Window(ObservedLineRange {
            start_line,
            end_line,
            total_lines,
        })
    }

    /// The ledger is keyed by chat: chat A's complete read grants chat A,
    /// and chat B still has to establish its own snapshot before it writes.
    #[test]
    fn one_chats_read_does_not_count_for_another_chat() {
        let mut ledger = Ledger::new();
        let file = path("shared.txt");
        ledger.record_read(
            "chat-a",
            &file,
            b"hello",
            f64::NAN,
            ReadObservation::WholeFile,
        );

        let own = ledger.assert_content("chat-a", &file, b"hello");
        let other = ledger
            .assert_content("chat-b", &file, b"hello")
            .map_err(|error| kind(&error).clone());
        assert_eq!(
            (own.is_ok(), other),
            (true, Err(json!("file_not_read"))),
            "expected (chat-a fresh, chat-b file_not_read) | received: ({:?}, {:?})",
            own.map_err(|error| error.message),
            ledger
                .assert_content("chat-b", &file, b"hello")
                .map_err(|error| error.message)
        );
    }

    /// A text window that skips the prefix after a byte view leaves the line
    /// numbers unobserved (nothing numbered line one), though the byte view
    /// still vouches for the content.
    #[test]
    fn a_prefix_skipping_window_after_a_byte_view_keeps_numbers_unobserved() {
        let mut ledger = Ledger::new();
        let file = path("bytes-then-window.txt");
        let content = b"a\nb\nc\n";
        ledger.record_read("chat", &file, content, f64::NAN, ReadObservation::ByteView);
        ledger.record_read("chat", &file, content, f64::NAN, window(2, 2, 3));

        let fresh = ledger.assert_content("chat", &file, content);
        let numbers = ledger
            .assert_line_numbers("chat", &file, 1)
            .map_err(|error| kind(&error).clone());
        assert_eq!(
            (fresh.is_ok(), numbers),
            (true, Err(json!("unobserved_line_numbers"))),
            "expected (content fresh, line 1 unobserved_line_numbers) | received: ({:?}, {:?})",
            fresh.map_err(|error| error.message),
            ledger
                .assert_line_numbers("chat", &file, 1)
                .map_err(|error| error.message)
        );
    }

    /// A byte view's "no numbers yet" state is not a frontier of zero: an
    /// edit that keeps every line where it was leaves the whole numbering
    /// valid, instead of being floored by the earlier byte view.
    #[test]
    fn a_byte_view_never_floors_a_later_edit_frontier() {
        let mut ledger = Ledger::new();
        let file = path("bytes-then-edit.txt");
        ledger.record_read(
            "chat",
            &file,
            b"a\nb\nc\n",
            f64::NAN,
            ReadObservation::ByteView,
        );
        ledger.record_edit(
            "chat",
            &file,
            b"A\nb\nc\n",
            f64::NAN,
            super::ALL_LINES_VALID,
        );

        let numbers = ledger.assert_line_numbers("chat", &file, 3);
        assert!(
            numbers.is_ok(),
            "expected line 3 still addressable after a same-height edit | received: {:?}",
            numbers.map_err(|error| error.message)
        );
    }

    /// Reading an empty file yields the window 1..0 of 0 lines; that is a
    /// numbered view (of nothing), not a byte view, so it is complete and a
    /// line-addressed edit at line one is not refused as unobserved.
    #[test]
    fn an_empty_text_window_counts_as_numbered() {
        let mut ledger = Ledger::new();
        let file = path("empty.txt");
        ledger.record_read("chat", &file, b"", f64::NAN, window(1, 0, 0));

        let fresh = ledger.assert_content("chat", &file, b"");
        let numbers = ledger.assert_line_numbers("chat", &file, 1);
        assert!(
            fresh.is_ok() && numbers.is_ok(),
            "expected (content fresh, line 1 numbered) for an empty window | received: ({:?}, {:?})",
            fresh.map_err(|error| error.message),
            numbers.map_err(|error| error.message)
        );
    }

    /// Waiters queued on one path are admitted in the order they arrived.
    /// Each waiter is known to be queued (its lock clone is visible in the
    /// table) before the next one starts, so the order is the arrival order
    /// and not scheduler luck.
    #[tokio::test]
    async fn same_path_waiters_are_admitted_in_arrival_order() {
        let locks = PathLocks::new();
        let file = path("fifo");
        let held = locks
            .acquire(vec![file.clone()], &CancellationToken::new())
            .await
            .unwrap();
        let admitted = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut waiters = Vec::new();
        for label in ["first", "second", "third"] {
            let queued_before = strong_count(&locks, &file);
            let waiter_locks = locks.clone();
            let waiter_path = file.clone();
            let waiter_admitted = Arc::clone(&admitted);
            waiters.push(tokio::spawn(async move {
                let guard = waiter_locks
                    .acquire(vec![waiter_path], &CancellationToken::new())
                    .await
                    .unwrap();
                waiter_admitted.lock().unwrap().push(label);
                drop(guard);
            }));
            tokio::time::timeout(Duration::from_secs(5), async {
                while strong_count(&locks, &file) == queued_before {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap_or_else(|_| {
                panic!("expected the {label} waiter to queue | received: no lock clone")
            });
        }
        drop(held);
        for waiter in waiters {
            waiter.await.unwrap();
        }
        let order = admitted.lock().unwrap().clone();
        assert_eq!(
            order,
            ["first", "second", "third"],
            "expected same-path waiters admitted FIFO | received: {order:?}"
        );
    }

    /// References to `path`'s lock: the table's, the holder's, and one per
    /// waiter that has reached the lock queue.
    fn strong_count(locks: &PathLocks, path: &Path) -> usize {
        locks
            .owner
            .locks
            .lock()
            .unwrap()
            .get(path)
            .map_or(0, Arc::strong_count)
    }
}
