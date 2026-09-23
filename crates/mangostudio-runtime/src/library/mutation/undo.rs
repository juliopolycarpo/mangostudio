//! `library.undo`'s engine — restore is undo; there is no separate restore
//! method. A port of `executeLibraryUndo` in
//! `apps/shared/src/library/machine/undo-writes.ts`, shared by propagation
//! and removal sets: every entry that carries a backup is restored, every
//! entry that does not (a path the apply created) is removed.
//!
//! The manifest is untrusted input: a JSON file under a caller-supplied
//! root. Every destination is re-contained in the registry location it
//! names, resolved from this host's own environment, and the whole undo is
//! refused on the first entry that is not — a set this engine (or the
//! TypeScript one) wrote can never trip that check, so tripping it means a
//! corrupt or forged set. A `backupPath` outside the backup root is skipped
//! as `backup-missing`, and a destination that changed since the apply is
//! left alone as `changed-since-apply`.

use serde::Serialize;

use super::backup_store::{BackupEntry, BackupStore, StoreError};
use super::disk::ResourceHasher;
use super::interrupt::Interrupt;
use super::paths::{
    WriteError, WriteFailure, fs_path, is_path_prefix, node_resolve,
    resolve_through_existing_ancestor,
};
use crate::probing::detection::path_env::PathEnv;
use crate::probing::locations::location_by_id;

/// `PropagationUndoEntry`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UndoEntry {
    pub location_id: String,
    pub destination_path: String,
}

/// `PropagationUndoSkipped`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UndoSkipped {
    pub location_id: String,
    pub destination_path: String,
    pub reason: &'static str,
}

/// `LibraryUndoResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UndoResult {
    pub backup_id: String,
    pub restored: Vec<UndoEntry>,
    pub removed: Vec<UndoEntry>,
    pub skipped: Vec<UndoSkipped>,
}

/// Why an undo produced no report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum UndoError {
    /// `LibraryBackupMissingError`: the set is gone, was never there, or its
    /// id could not name one.
    Missing(String),
    /// An entry left its location; see the module docs.
    Refused(WriteError),
    /// Stopped at a boundary between entries. Entries already handled stay
    /// handled; the rest are untouched.
    Interrupted(Interrupt),
    /// An I/O failure, including a manifest that exists but cannot be read.
    Failed(String),
}

/// `executeLibraryUndo`.
///
/// # Example
///
/// ```ignore
/// let report = execute_undo("2026-09-23T10-15-44.087Z-0011223344556677", &store, &hasher, &env, &|| None)?;
/// ```
pub(crate) fn execute_undo(
    backup_id: &str,
    store: &BackupStore,
    hasher: &dyn ResourceHasher,
    env: &PathEnv,
    interrupted: &dyn Fn() -> Option<Interrupt>,
) -> Result<UndoResult, UndoError> {
    let manifest = match store.read_manifest(backup_id) {
        Ok(manifest) => manifest,
        Err(StoreError::InvalidId(_)) => None,
        Err(error) => return Err(UndoError::Failed(error.to_string())),
    };
    let Some(manifest) = manifest else {
        return Err(UndoError::Missing(format!(
            "No library backup \"{backup_id}\" is retained. Backups are bounded by count and size."
        )));
    };
    let platform = store.platform.as_str();
    let backup_root = node_resolve(platform, &store.root);
    let mut report = UndoResult {
        backup_id: backup_id.to_string(),
        restored: Vec::new(),
        removed: Vec::new(),
        skipped: Vec::new(),
    };
    for entry in manifest.entries.iter().rev() {
        if let Some(interrupt) = interrupted() {
            return Err(UndoError::Interrupted(interrupt));
        }
        assert_contained_in_location(entry, env).map_err(UndoError::Refused)?;
        let location = UndoEntry {
            location_id: entry.location_id.clone(),
            destination_path: entry.destination_path.clone(),
        };
        let skip = |reason: &'static str| UndoSkipped {
            location_id: location.location_id.clone(),
            destination_path: location.destination_path.clone(),
            reason,
        };
        let current = hasher.hash_at(&entry.resolved_path, entry.kind).ok();
        if current.is_some_and(|hash| hash != entry.written_content_hash) {
            report.skipped.push(skip("changed-since-apply"));
            continue;
        }
        let Some(backup_path) = &entry.backup_path else {
            store
                .fs
                .remove_all(&fs_path(&entry.resolved_path))
                .map_err(|error| UndoError::Failed(error.to_string()))?;
            report.removed.push(location);
            continue;
        };
        if !is_path_prefix(platform, &backup_root, &node_resolve(platform, backup_path)) {
            report.skipped.push(skip("backup-missing"));
            continue;
        }
        let present = store
            .fs
            .exists(&fs_path(backup_path))
            .map_err(|error| UndoError::Failed(error.to_string()))?;
        if !present {
            report.skipped.push(skip("backup-missing"));
            continue;
        }
        store
            .restore_entry(entry)
            .map_err(|error| UndoError::Failed(error.to_string()))?;
        report.restored.push(location);
    }
    Ok(report)
}

/// `assertContainedInLocation`. Equality is allowed: a `single-file`
/// location is itself the destination.
fn assert_contained_in_location(entry: &BackupEntry, env: &PathEnv) -> Result<(), WriteError> {
    let root = location_by_id(&entry.location_id).and_then(|location| (location.resolve_path)(env));
    let Some(root) = root else {
        return Err(WriteError::new(
            WriteFailure::UnsupportedLocation,
            format!(
                "Library backup entry names location \"{}\", which does not resolve on this machine.",
                entry.location_id
            ),
        ));
    };
    let escape = || {
        WriteError::new(
            WriteFailure::PathEscape,
            format!(
                "Library backup entry points at \"{}\", which is outside location \"{}\".",
                entry.resolved_path, entry.location_id
            ),
        )
    };
    let resolved_root = resolve_through_existing_ancestor(&root).ok_or_else(escape)?;
    if is_path_prefix(
        &env.platform,
        &resolved_root,
        &node_resolve(&env.platform, &entry.resolved_path),
    ) {
        return Ok(());
    }
    Err(escape())
}

#[cfg(test)]
#[path = "undo_tests.rs"]
mod tests;
