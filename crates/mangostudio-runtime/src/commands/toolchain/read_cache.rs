//! Bounded identity-keyed caches for successful toolchain filesystem observations.

use std::collections::VecDeque;
use std::sync::Mutex;

const MAX_ENTRIES: usize = 32;
const MAX_BYTES: usize = 1024 * 1024;

pub(super) trait CacheValue: Clone {
    fn retained_bytes(&self) -> usize;
    fn is_empty(&self) -> bool;
}

impl CacheValue for String {
    fn retained_bytes(&self) -> usize {
        self.len()
    }
    fn is_empty(&self) -> bool {
        String::is_empty(self)
    }
}

impl CacheValue for Vec<String> {
    fn retained_bytes(&self) -> usize {
        self.iter()
            .map(|name| name.len() + std::mem::size_of::<String>())
            .sum()
    }
    fn is_empty(&self) -> bool {
        self.as_slice().is_empty()
    }
}

pub(super) trait Reader {
    type Value: CacheValue;
    fn identity(&self, path: &str) -> Option<String>;
    fn read(&self, path: &str) -> Option<Self::Value>;
}

struct Entry<T> {
    path: String,
    identity: String,
    value: T,
    bytes: usize,
}

#[derive(Default)]
pub(super) struct ReadCache<T>(Mutex<VecDeque<Entry<T>>>);

impl<T: CacheValue> ReadCache<T> {
    pub(super) fn read(&self, path: &str, reader: &dyn Reader<Value = T>) -> Option<T> {
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
                return Some(entry.value.clone());
            }
        }
        let value = reader.read(path)?;
        let Some(identity) = identity else {
            return Some(value);
        };
        let bytes = path.len() + identity.len() + value.retained_bytes();
        if value.is_empty()
            || bytes > MAX_BYTES
            || reader.identity(path).as_ref() != Some(&identity)
        {
            return Some(value);
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
            value: value.clone(),
            bytes,
        });
        Some(value)
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
        change_during_read: Cell<bool>,
    }

    impl FakeDirectory {
        fn populated() -> Self {
            Self {
                identity: RefCell::new(Some("object-one".into())),
                names: RefCell::new(Some(vec!["v22.0.0".into()])),
                reads: Cell::new(0),
                change_during_read: Cell::new(false),
            }
        }
    }

    impl Reader for FakeDirectory {
        type Value = Vec<String>;
        fn identity(&self, _: &str) -> Option<String> {
            self.identity.borrow().clone()
        }
        fn read(&self, _: &str) -> Option<Vec<String>> {
            self.reads.set(self.reads.get() + 1);
            if self.change_during_read.get() {
                *self.identity.borrow_mut() = Some("changed-during-read".into());
            }
            self.names.borrow().clone()
        }
    }

    #[test]
    fn unchanged_identity_reuses_only_the_expensive_scan() {
        let cache = ReadCache::default();
        let reader = FakeDirectory::populated();
        assert_eq!(cache.read("/versions", &reader).unwrap(), ["v22.0.0"]);
        assert_eq!(cache.read("/versions", &reader).unwrap(), ["v22.0.0"]);
        assert_eq!(reader.reads.get(), 1);
        *reader.identity.borrow_mut() = Some("object-two".into());
        *reader.names.borrow_mut() = Some(vec!["v24.0.0".into()]);
        assert_eq!(cache.read("/versions", &reader).unwrap(), ["v24.0.0"]);
        assert_eq!(reader.reads.get(), 2);
    }

    #[test]
    fn missing_identity_and_failed_or_empty_scans_are_not_cached() {
        for unavailable in [None, Some(Vec::new())] {
            let cache = ReadCache::default();
            let reader = FakeDirectory::populated();
            *reader.names.borrow_mut() = unavailable;
            assert!(
                cache
                    .read("/versions", &reader)
                    .unwrap_or_default()
                    .is_empty()
            );
            *reader.names.borrow_mut() = Some(vec!["v24.0.0".into()]);
            assert_eq!(cache.read("/versions", &reader).unwrap(), ["v24.0.0"]);
            assert_eq!(reader.reads.get(), 2);
        }
        let cache = ReadCache::default();
        let reader = FakeDirectory::populated();
        *reader.identity.borrow_mut() = None;
        cache.read("/versions", &reader);
        cache.read("/versions", &reader);
        assert_eq!(reader.reads.get(), 2);
    }

    #[test]
    fn observations_that_change_during_read_are_not_published() {
        let cache = ReadCache::default();
        let reader = FakeDirectory::populated();
        reader.change_during_read.set(true);
        assert_eq!(cache.read("/versions", &reader).unwrap(), ["v22.0.0"]);
        assert!(cache.0.lock().unwrap().is_empty());
        reader.change_during_read.set(false);
        cache.read("/versions", &reader);
        assert_eq!(reader.reads.get(), 2);
    }

    #[test]
    fn cache_bounds_retained_entry_count_and_bytes() {
        let cache = ReadCache::default();
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
