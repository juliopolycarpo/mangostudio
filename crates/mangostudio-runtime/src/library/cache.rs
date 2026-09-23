//! The two memo levels `apps/shared/src/library/machine/cache.ts`'s
//! `LibraryCache` keeps, with the same identity, bounds and invalidation.
//!
//! - **Instance hashes**, keyed by the path a scan read and guarded by a
//!   fingerprint (`path\0size\0mtime` for a file, the whole leaf listing for
//!   a directory): an unchanged fingerprint never reopens the bytes, a size
//!   or mtime change always does, and a failed recompute evicts the entry.
//! - **Scans**, keyed by the sorted `scope\0location\0path` signature and
//!   served for [`LIBRARY_SCAN_CACHE_TTL_MS`] from the moment the call that
//!   started them arrived. A `force` rescan clears every scan memo, not just
//!   its own signature, so a rescan stays globally authoritative.
//!
//! A scan's walk is owned by the cache entry, not by whichever caller
//! started it: callers that coalesce onto it each race only their own
//! cancellation, so one caller cancelling never fails the others (the
//! TypeScript host's `settleUnlessAborted`). Both levels are bounded and
//! evict in insertion order.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::hash::Hash;
use std::sync::{Arc, Mutex};

use mango_protocol::error::{RemoteError, codes};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::types::{InvalidReason, ScanResult};
use crate::ports::audit::lock;

/// `LIBRARY_SCAN_CACHE_TTL_MS`.
pub(crate) const LIBRARY_SCAN_CACHE_TTL_MS: u64 = 2_000;
const MAX_INSTANCE_HASH_ENTRIES: usize = 4_096;
const MAX_SCAN_ENTRIES: usize = 32;

/// Display metadata derived from an instance's entrypoint text.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Display {
    pub title: Option<String>,
    pub description: Option<String>,
    pub invalid_reason: Option<InvalidReason>,
}

/// `CachedInstanceHash`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CachedInstanceHash {
    pub content_hash: String,
    pub size_bytes: u64,
    pub whitespace_hash: String,
    pub display: Display,
}

/// A map that evicts its oldest insertion once it grows past `max`, and
/// treats a re-insert as the newest entry (`setBounded`).
struct BoundedMap<K, V> {
    entries: HashMap<K, (u64, V)>,
    order: BTreeMap<u64, K>,
    next: u64,
    max: usize,
}

impl<K: Eq + Hash + Clone, V> BoundedMap<K, V> {
    fn new(max: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: BTreeMap::new(),
            next: 0,
            max,
        }
    }

    fn get(&self, key: &K) -> Option<&V> {
        self.entries.get(key).map(|(_, value)| value)
    }

    fn insert(&mut self, key: K, value: V) {
        self.remove(&key);
        self.next += 1;
        self.order.insert(self.next, key.clone());
        self.entries.insert(key, (self.next, value));
        while self.entries.len() > self.max {
            let Some((_, oldest)) = self.order.pop_first() else {
                break;
            };
            self.entries.remove(&oldest);
        }
    }

    fn remove(&mut self, key: &K) -> Option<V> {
        let (sequence, value) = self.entries.remove(key)?;
        self.order.remove(&sequence);
        Some(value)
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

type SharedScan = Arc<Result<ScanResult, RemoteError>>;

struct ScanEntry {
    scanned_at_ms: u64,
    generation: u64,
    result: watch::Receiver<Option<SharedScan>>,
}

struct ScanMemo {
    entries: BoundedMap<String, ScanEntry>,
    generation: u64,
}

/// Process-wide library memo; see the module docs.
pub(crate) struct LibraryCache {
    instance_hashes: Mutex<BoundedMap<String, (String, Arc<CachedInstanceHash>)>>,
    scans: Mutex<ScanMemo>,
}

impl Default for LibraryCache {
    fn default() -> Self {
        Self {
            instance_hashes: Mutex::new(BoundedMap::new(MAX_INSTANCE_HASH_ENTRIES)),
            scans: Mutex::new(ScanMemo {
                entries: BoundedMap::new(MAX_SCAN_ENTRIES),
                generation: 0,
            }),
        }
    }
}

impl LibraryCache {
    /// `getOrComputeInstanceHash`: returns the memo for `path` when its
    /// fingerprint still matches and `force` is off, otherwise runs
    /// `compute` and stores its answer. A failed compute leaves no entry
    /// behind for `path` at all.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let hashed = cache.instance_hash("/skills/a", "fp", false, || hash_directory(...))?;
    /// ```
    pub(crate) fn instance_hash<E>(
        &self,
        path: &str,
        fingerprint: &str,
        force: bool,
        compute: impl FnOnce() -> Result<CachedInstanceHash, E>,
    ) -> Result<Arc<CachedInstanceHash>, E> {
        if !force
            && let Some((cached_fingerprint, value)) =
                lock(&self.instance_hashes).get(&path.to_string())
            && cached_fingerprint == fingerprint
        {
            return Ok(Arc::clone(value));
        }
        match compute() {
            Ok(value) => {
                let value = Arc::new(value);
                lock(&self.instance_hashes).insert(
                    path.to_string(),
                    (fingerprint.to_string(), Arc::clone(&value)),
                );
                Ok(value)
            }
            Err(error) => {
                lock(&self.instance_hashes).remove(&path.to_string());
                Err(error)
            }
        }
    }

    /// `getOrComputeScan` plus `settleUnlessAborted`: joins a live memo for
    /// `signature` (younger than the TTL at `now_ms`) or starts `compute` as
    /// a task the memo owns, then waits for it while honouring only this
    /// caller's `cancel`.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let result = cache.scan(signature, clock(), force, &cancel, move || walk(targets)).await?;
    /// ```
    pub(crate) async fn scan<F, Fut>(
        self: &Arc<Self>,
        signature: String,
        now_ms: u64,
        force: bool,
        cancel: &CancellationToken,
        compute: F,
    ) -> Result<SharedScan, RemoteError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<ScanResult, RemoteError>> + Send + 'static,
    {
        check_cancelled(cancel)?;
        let mut receiver = self.join_or_start(signature, now_ms, force, compute);
        let settled = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(cancelled()),
            settled = receiver.wait_for(Option::is_some) => settled,
        };
        let shared = settled
            .map_err(|_| {
                RemoteError::new(
                    codes::INTERNAL,
                    "The library scan task ended without an answer.",
                )
            })?
            .clone()
            .expect("wait_for returned only once the value was Some");
        // The walk may settle in the same instant this caller cancels; the
        // cancel still wins, exactly as the TypeScript `then` re-check does.
        check_cancelled(cancel)?;
        Ok(shared)
    }

    fn join_or_start<F, Fut>(
        self: &Arc<Self>,
        signature: String,
        now_ms: u64,
        force: bool,
        compute: F,
    ) -> watch::Receiver<Option<SharedScan>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<ScanResult, RemoteError>> + Send + 'static,
    {
        let mut memo = lock(&self.scans);
        if !force
            && let Some(entry) = memo.entries.get(&signature)
            && now_ms.saturating_sub(entry.scanned_at_ms) < LIBRARY_SCAN_CACHE_TTL_MS
        {
            return entry.result.clone();
        }
        if force {
            memo.entries.clear();
        }
        memo.generation += 1;
        let generation = memo.generation;
        let (sender, receiver) = watch::channel(None);
        memo.entries.insert(
            signature.clone(),
            ScanEntry {
                scanned_at_ms: now_ms,
                generation,
                result: receiver.clone(),
            },
        );
        drop(memo);

        let work = compute();
        let cache = Arc::clone(self);
        tokio::spawn(async move {
            let result = work.await;
            if result.is_err() {
                let mut memo = lock(&cache.scans);
                if memo
                    .entries
                    .get(&signature)
                    .is_some_and(|entry| entry.generation == generation)
                {
                    memo.entries.remove(&signature);
                }
            }
            // No receiver left is fine: every caller cancelled, and the memo
            // entry (when it survived) still serves the next one.
            let _ = sender.send(Some(Arc::new(result)));
        });
        receiver
    }

    #[cfg(test)]
    pub(crate) fn scan_entry_count(&self) -> usize {
        lock(&self.scans).entries.len()
    }
}

pub(crate) fn cancelled() -> RemoteError {
    RemoteError::new(codes::CANCELLED, "The library operation was cancelled.")
}

pub(crate) fn check_cancelled(cancel: &CancellationToken) -> Result<(), RemoteError> {
    if cancel.is_cancelled() {
        return Err(cancelled());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    fn hashed(tag: &str) -> CachedInstanceHash {
        CachedInstanceHash {
            content_hash: tag.to_string(),
            size_bytes: 1,
            whitespace_hash: tag.to_string(),
            display: Display::default(),
        }
    }

    /// `library-cache.test.ts` "does not recompute an unchanged path, size,
    /// and mtime fingerprint" and "rehashes a size change even when mtime is
    /// identical".
    #[test]
    fn instance_hashes_recompute_only_when_the_fingerprint_moves() {
        let cache = LibraryCache::default();
        let computed = AtomicUsize::new(0);
        let compute = |tag: &'static str| {
            computed.fetch_add(1, Ordering::SeqCst);
            Ok::<_, ()>(hashed(tag))
        };
        cache
            .instance_hash("/a", "/a|1|10", false, || compute("first"))
            .unwrap();
        let again = cache
            .instance_hash("/a", "/a|1|10", false, || compute("second"))
            .unwrap();
        assert_eq!(
            again.content_hash, "first",
            "an unchanged fingerprint must be served from memo"
        );
        let resized = cache
            .instance_hash("/a", "/a|2|10", false, || compute("third"))
            .unwrap();
        assert_eq!(resized.content_hash, "third", "a size change must rehash");
        let forced = cache
            .instance_hash("/a", "/a|2|10", true, || compute("fourth"))
            .unwrap();
        assert_eq!(forced.content_hash, "fourth", "force must bypass the memo");
        assert_eq!(computed.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn a_failed_instance_compute_evicts_the_previous_memo() {
        let cache = LibraryCache::default();
        cache
            .instance_hash("/a", "fp", false, || Ok::<_, ()>(hashed("old")))
            .unwrap();
        assert!(
            cache
                .instance_hash("/a", "fp2", false, || Err::<CachedInstanceHash, _>(()))
                .is_err()
        );
        let recomputed = cache
            .instance_hash("/a", "fp", false, || Ok::<_, ()>(hashed("new")))
            .unwrap();
        assert_eq!(
            recomputed.content_hash, "new",
            "expected the failure to evict the old memo | received {}",
            recomputed.content_hash
        );
    }

    #[test]
    fn the_instance_memo_is_bounded_and_evicts_the_oldest_path() {
        let mut map = BoundedMap::new(2);
        map.insert("a", 1);
        map.insert("b", 2);
        map.insert("a", 3);
        map.insert("c", 4);
        assert_eq!(
            map.get(&"b"),
            None,
            "b was the oldest insertion once a was refreshed"
        );
        assert_eq!(map.get(&"a"), Some(&3));
        assert_eq!(map.len(), 2);
    }

    fn scan_of(slug: &str) -> ScanResult {
        ScanResult {
            entries: Vec::new(),
            unreadable_entries: vec![super::super::types::UnreadableEntry {
                location_id: "mango-skills",
                name: slug.to_string(),
                reason: "invalid-name",
            }],
        }
    }

    /// `library-cache.test.ts` "force bypasses both the instance cache and
    /// scan memo", plus the TTL measured from the call that started the scan.
    #[tokio::test]
    async fn scan_memos_honour_ttl_and_force_clears_every_signature() {
        let cache = Arc::new(LibraryCache::default());
        let cancel = CancellationToken::new();
        let first = cache
            .scan("a".into(), 0, false, &cancel, || async {
                Ok(scan_of("one"))
            })
            .await
            .unwrap();
        let _other = cache
            .scan("b".into(), 0, false, &cancel, || async { Ok(scan_of("b")) })
            .await
            .unwrap();
        let served = cache
            .scan("a".into(), 1_999, false, &cancel, || async {
                Ok(scan_of("two"))
            })
            .await
            .unwrap();
        assert_eq!(served, first, "a memo younger than the TTL must be served");
        let expired = cache
            .scan("a".into(), 2_000, false, &cancel, || async {
                Ok(scan_of("three"))
            })
            .await
            .unwrap();
        assert_eq!(
            expired.as_ref().as_ref().unwrap().unreadable_entries[0].name,
            "three",
            "a memo exactly TTL old must be recomputed"
        );
        cache
            .scan("a".into(), 2_001, true, &cancel, || async {
                Ok(scan_of("four"))
            })
            .await
            .unwrap();
        assert_eq!(
            cache.scan_entry_count(),
            1,
            "force must clear every other signature's memo, not only its own"
        );
    }

    /// A slow walk that fails after a forced rescan replaced its memo must
    /// evict only its own entry, never the newer one (the TypeScript
    /// `value.catch` identity check).
    #[tokio::test]
    async fn a_late_failure_never_evicts_a_newer_memo() {
        let cache = Arc::new(LibraryCache::default());
        let cancel = CancellationToken::new();
        let (fail, gate) = tokio::sync::oneshot::channel::<()>();
        let slow = {
            let cache = Arc::clone(&cache);
            let cancel = cancel.clone();
            tokio::spawn(async move {
                cache
                    .scan("a".into(), 0, false, &cancel, move || async move {
                        let _ = gate.await;
                        Err(RemoteError::new(codes::INTERNAL, "late failure"))
                    })
                    .await
            })
        };
        tokio::task::yield_now().await;
        cache
            .scan("a".into(), 1, true, &cancel, || async {
                Ok(scan_of("newer"))
            })
            .await
            .unwrap();
        fail.send(()).unwrap();
        assert!(slow.await.unwrap().unwrap().is_err());
        tokio::task::yield_now().await;
        let served = cache
            .scan("a".into(), 2, false, &cancel, || async {
                Ok(scan_of("recomputed"))
            })
            .await
            .unwrap();
        assert_eq!(
            served.as_ref().as_ref().unwrap().unreadable_entries[0].name,
            "newer",
            "expected the newer memo to survive the older walk's failure"
        );
    }

    #[tokio::test]
    async fn a_failed_scan_is_not_memoized() {
        let cache = Arc::new(LibraryCache::default());
        let cancel = CancellationToken::new();
        let failed = cache
            .scan("a".into(), 0, false, &cancel, || async {
                Err(RemoteError::new(codes::INTERNAL, "boom"))
            })
            .await
            .unwrap();
        assert!(failed.is_err());
        tokio::task::yield_now().await;
        let retried = cache
            .scan("a".into(), 1, false, &cancel, || async {
                Ok(scan_of("ok"))
            })
            .await
            .unwrap();
        assert!(
            retried.is_ok(),
            "expected a retry after failure | received {retried:?}"
        );
    }

    /// `library-service.test.ts` "does not cancel a coalesced scan when a
    /// different caller aborts".
    #[tokio::test]
    async fn one_caller_cancelling_never_fails_a_coalesced_caller() {
        let cache = Arc::new(LibraryCache::default());
        let (release, gate) = tokio::sync::oneshot::channel::<()>();
        let first_cancel = CancellationToken::new();
        let second_cancel = CancellationToken::new();
        let first = {
            let cache = Arc::clone(&cache);
            let cancel = first_cancel.clone();
            tokio::spawn(async move {
                cache
                    .scan("a".into(), 0, false, &cancel, move || async move {
                        let _ = gate.await;
                        Ok(scan_of("alpha"))
                    })
                    .await
            })
        };
        tokio::task::yield_now().await;
        let second = {
            let cache = Arc::clone(&cache);
            let cancel = second_cancel.clone();
            tokio::spawn(async move {
                cache
                    .scan("a".into(), 0, false, &cancel, || async {
                        Ok(scan_of("never"))
                    })
                    .await
            })
        };
        tokio::task::yield_now().await;
        first_cancel.cancel();
        let first = first.await.unwrap();
        assert_eq!(
            first
                .as_ref()
                .map_err(|error| error.code.clone())
                .err()
                .as_deref(),
            Some(codes::CANCELLED),
            "expected the cancelling caller to see CANCELLED | received {first:?}"
        );
        release.send(()).unwrap();
        let second = second.await.unwrap().unwrap();
        assert_eq!(
            second.as_ref().as_ref().unwrap().unreadable_entries[0].name,
            "alpha",
            "expected the coalesced caller to receive the shared walk's answer"
        );
    }
}
