//! Bounded successful binary-probe results, keyed by path and current object identity.
//!
//! A [`ProbeCache`] carries its own lock, so each probing site declares one
//! plain `static` and calls [`ProbeCache::get`]/[`ProbeCache::insert`]
//! directly. The lock panics if poisoned: every critical section below is a
//! short, panic-free list operation, so a poisoned cache can only mean a bug.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

const MAX_ENTRIES: usize = 128;

struct Entry<T> {
    path: PathBuf,
    fingerprint: String,
    value: T,
}

pub(crate) struct ProbeCache<T>(Mutex<VecDeque<Entry<T>>>);

impl<T> ProbeCache<T> {
    /// An empty cache, usable as a `static` initializer.
    ///
    /// # Example
    ///
    /// ```ignore
    /// static CACHE: ProbeCache<Option<String>> = ProbeCache::new();
    /// ```
    pub(crate) const fn new() -> Self {
        Self(Mutex::new(VecDeque::new()))
    }

    fn entries(&self) -> MutexGuard<'_, VecDeque<Entry<T>>> {
        self.0
            .lock()
            .expect("a probe cache mutex is never poisoned")
    }

    /// Drops every cached result.
    #[cfg(test)]
    pub(crate) fn clear(&self) {
        self.entries().clear();
    }
}

impl<T: Clone> ProbeCache<T> {
    /// The value cached for `path`, if its recorded fingerprint still equals
    /// `fingerprint`.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let cached = CACHE.get(Path::new("/usr/bin/git"), &fingerprint);
    /// ```
    pub(crate) fn get(&self, path: &Path, fingerprint: &str) -> Option<T> {
        self.entries()
            .iter()
            .find(|entry| entry.path == path && entry.fingerprint == fingerprint)
            .map(|entry| entry.value.clone())
    }

    /// Records `value` for `path` at `fingerprint`, replacing any earlier
    /// entry for the same path and evicting the oldest entry once full.
    ///
    /// # Example
    ///
    /// ```ignore
    /// CACHE.insert("/usr/bin/git".into(), fingerprint, availability);
    /// ```
    pub(crate) fn insert(&self, path: PathBuf, fingerprint: String, value: T) {
        let mut entries = self.entries();
        entries.retain(|entry| entry.path != path);
        if entries.len() == MAX_ENTRIES {
            entries.pop_front();
        }
        entries.push_back(Entry {
            path,
            fingerprint,
            value,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_successful_probe_results_and_preserves_the_newest() {
        let cache = ProbeCache::new();
        for index in 0..MAX_ENTRIES + 1 {
            cache.insert(
                PathBuf::from(format!("binary-{index}")),
                "identity".into(),
                index,
            );
        }
        assert_eq!(cache.entries().len(), MAX_ENTRIES);
        assert_eq!(cache.get(Path::new("binary-0"), "identity"), None);
        assert_eq!(
            cache.get(&PathBuf::from(format!("binary-{MAX_ENTRIES}")), "identity"),
            Some(MAX_ENTRIES)
        );
    }

    #[test]
    fn changed_identity_refuses_stale_results_and_replaces_one_entry() {
        let cache = ProbeCache::new();
        cache.insert("binary".into(), "old-object".into(), "old-version");
        assert_eq!(cache.get(Path::new("binary"), "new-object"), None);
        cache.insert("binary".into(), "new-object".into(), "new-version");
        assert_eq!(cache.entries().len(), 1);
        assert_eq!(
            cache.get(Path::new("binary"), "new-object"),
            Some("new-version")
        );
        cache.clear();
        assert_eq!(cache.get(Path::new("binary"), "new-object"), None);
    }

    #[test]
    fn a_static_cache_is_shared_across_references() {
        static CACHE: ProbeCache<u8> = ProbeCache::new();
        CACHE.insert("binary".into(), "identity".into(), 7);
        let shared: &ProbeCache<u8> = &CACHE;
        assert_eq!(shared.get(Path::new("binary"), "identity"), Some(7));
    }
}
