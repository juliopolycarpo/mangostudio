//! Bounded successful binary-probe results, keyed by path and current object identity.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

const MAX_ENTRIES: usize = 128;

struct Entry<T> {
    path: PathBuf,
    fingerprint: String,
    value: T,
}

pub(crate) struct ProbeCache<T>(VecDeque<Entry<T>>);

impl<T> Default for ProbeCache<T> {
    fn default() -> Self {
        Self(VecDeque::new())
    }
}

impl<T: Clone> ProbeCache<T> {
    pub(crate) fn get(&self, path: &Path, fingerprint: &str) -> Option<T> {
        self.0
            .iter()
            .find(|entry| entry.path == path && entry.fingerprint == fingerprint)
            .map(|entry| entry.value.clone())
    }

    pub(crate) fn insert(&mut self, path: PathBuf, fingerprint: String, value: T) {
        self.0.retain(|entry| entry.path != path);
        if self.0.len() == MAX_ENTRIES {
            self.0.pop_front();
        }
        self.0.push_back(Entry {
            path,
            fingerprint,
            value,
        });
    }

    #[cfg(test)]
    pub(crate) fn clear(&mut self) {
        self.0.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_successful_probe_results_and_preserves_the_newest() {
        let mut cache = ProbeCache::default();
        for index in 0..MAX_ENTRIES + 1 {
            cache.insert(
                PathBuf::from(format!("binary-{index}")),
                "identity".into(),
                index,
            );
        }
        assert_eq!(cache.0.len(), MAX_ENTRIES);
        assert_eq!(cache.get(Path::new("binary-0"), "identity"), None);
        assert_eq!(
            cache.get(&PathBuf::from(format!("binary-{MAX_ENTRIES}")), "identity"),
            Some(MAX_ENTRIES)
        );
    }

    #[test]
    fn changed_identity_refuses_stale_results_and_replaces_one_entry() {
        let mut cache = ProbeCache::default();
        cache.insert("binary".into(), "old-object".into(), "old-version");
        assert_eq!(cache.get(Path::new("binary"), "new-object"), None);
        cache.insert("binary".into(), "new-object".into(), "new-version");
        assert_eq!(cache.0.len(), 1);
        assert_eq!(
            cache.get(Path::new("binary"), "new-object"),
            Some("new-version")
        );
        cache.clear();
        assert_eq!(cache.get(Path::new("binary"), "new-object"), None);
    }
}
