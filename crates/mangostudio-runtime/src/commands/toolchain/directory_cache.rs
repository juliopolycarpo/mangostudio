//! Caches successful version-directory scans, never alias bytes or launch authority.

use std::collections::VecDeque;
use std::sync::Mutex;

const MAX_ENTRIES: usize = 32;
const MAX_BYTES: usize = 1024 * 1024;

pub(super) trait DirectoryReader {
    fn identity(&self, path: &str) -> Option<String>;
    fn read(&self, path: &str) -> Option<Vec<String>>;
}

struct Entry {
    path: String,
    identity: String,
    names: Vec<String>,
    bytes: usize,
}

#[derive(Default)]
pub(super) struct DirectoryCache(Mutex<VecDeque<Entry>>);

impl DirectoryCache {
    pub(super) fn read(&self, path: &str, reader: &dyn DirectoryReader) -> Vec<String> {
        let identity = reader.identity(path);
        if let Some(identity) = &identity {
            let entries = self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(entry) = entries
                .iter()
                .find(|entry| entry.path == path && &entry.identity == identity)
            {
                return entry.names.clone();
            }
        }
        let Some(names) = reader.read(path) else {
            return Vec::new();
        };
        let Some(identity) = identity else {
            return names;
        };
        let bytes = path.len()
            + identity.len()
            + names
                .iter()
                .map(|name| name.len() + std::mem::size_of::<String>())
                .sum::<usize>();
        if names.is_empty()
            || bytes > MAX_BYTES
            || reader.identity(path).as_ref() != Some(&identity)
        {
            return names;
        }
        let mut entries = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        entries.retain(|entry| entry.path != path);
        while entries.len() >= MAX_ENTRIES
            || entries.iter().map(|entry| entry.bytes).sum::<usize>() + bytes > MAX_BYTES
        {
            entries.pop_front();
        }
        entries.push_back(Entry {
            path: path.into(),
            identity,
            names: names.clone(),
            bytes,
        });
        names
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    struct FakeDirectory {
        identity: RefCell<Option<String>>,
        names: RefCell<Option<Vec<String>>>,
        reads: Cell<usize>,
    }

    impl FakeDirectory {
        fn populated() -> Self {
            Self {
                identity: RefCell::new(Some("object-one".into())),
                names: RefCell::new(Some(vec!["v22.0.0".into()])),
                reads: Cell::new(0),
            }
        }
    }

    impl DirectoryReader for FakeDirectory {
        fn identity(&self, _: &str) -> Option<String> {
            self.identity.borrow().clone()
        }
        fn read(&self, _: &str) -> Option<Vec<String>> {
            self.reads.set(self.reads.get() + 1);
            self.names.borrow().clone()
        }
    }

    #[test]
    fn unchanged_identity_reuses_only_the_expensive_scan() {
        let cache = DirectoryCache::default();
        let reader = FakeDirectory::populated();
        assert_eq!(cache.read("/versions", &reader), ["v22.0.0"]);
        assert_eq!(cache.read("/versions", &reader), ["v22.0.0"]);
        assert_eq!(reader.reads.get(), 1);
        *reader.identity.borrow_mut() = Some("object-two".into());
        *reader.names.borrow_mut() = Some(vec!["v24.0.0".into()]);
        assert_eq!(cache.read("/versions", &reader), ["v24.0.0"]);
        assert_eq!(reader.reads.get(), 2);
    }

    #[test]
    fn missing_identity_and_failed_or_empty_scans_are_not_cached() {
        for unavailable in [None, Some(Vec::new())] {
            let cache = DirectoryCache::default();
            let reader = FakeDirectory::populated();
            *reader.names.borrow_mut() = unavailable;
            assert!(cache.read("/versions", &reader).is_empty());
            *reader.names.borrow_mut() = Some(vec!["v24.0.0".into()]);
            assert_eq!(cache.read("/versions", &reader), ["v24.0.0"]);
            assert_eq!(reader.reads.get(), 2);
        }
        let cache = DirectoryCache::default();
        let reader = FakeDirectory::populated();
        *reader.identity.borrow_mut() = None;
        cache.read("/versions", &reader);
        cache.read("/versions", &reader);
        assert_eq!(reader.reads.get(), 2);
    }

    #[test]
    fn cache_bounds_retained_entry_count_and_bytes() {
        let cache = DirectoryCache::default();
        let reader = FakeDirectory::populated();
        for index in 0..MAX_ENTRIES + 1 {
            cache.read(&format!("/versions/{index}"), &reader);
        }
        assert_eq!(cache.0.lock().unwrap().len(), MAX_ENTRIES);
        assert!(
            cache
                .0
                .lock()
                .unwrap()
                .iter()
                .all(|entry| entry.path != "/versions/0")
        );
        *reader.names.borrow_mut() = Some(vec!["x".repeat(MAX_BYTES / 2)]);
        cache.read("/large-one", &reader);
        cache.read("/large-two", &reader);
        assert!(
            cache
                .0
                .lock()
                .unwrap()
                .iter()
                .map(|entry| entry.bytes)
                .sum::<usize>()
                <= MAX_BYTES
        );
    }
}
