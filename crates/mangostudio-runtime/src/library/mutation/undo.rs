//! `library.undo`'s engine — restore is undo; there is no separate restore
//! method. A port of `executeLibraryUndo` in
//! `apps/shared/src/library/machine/undo-writes.ts`, shared by propagation
//! and removal sets: every entry that carries a backup is restored, every
//! entry that does not (a path the apply created) is removed.
//!
//! The manifest is untrusted input: a JSON file under a caller-supplied
//! root. Every destination is re-contained in the registry location it
//! names, resolved from this host's own environment. Undo stops if a
//! destination has been redirected since apply. A `backupPath` outside the
//! physical backup root is skipped as `backup-missing`. A destination that
//! changed since apply is left alone as `changed-since-apply`.

use serde::Serialize;

use super::backup_store::{BackupEntry, BackupStore, StoreError};
use super::disk::ResourceHasher;
use super::interrupt::Interrupt;
use super::paths::{
    WriteError, WriteFailure, assert_expected_resource_entry, fs_path, is_path_prefix, node_join,
    node_resolve, require_writable_location, resolve_through_existing_ancestor,
};
use crate::probing::detection::path_env::PathEnv;
use crate::probing::locations::LocationLayout;

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
    /// handled — the partial report says which — and the rest are untouched.
    Interrupted(Interrupt, UndoResult),
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
    let backup_set = node_join(platform, &[&backup_root, backup_id]);
    let physical_backup_set = resolve_through_existing_ancestor(&backup_root)
        .map(|root| node_join(platform, &[&root, backup_id]));
    let mut report = UndoResult {
        backup_id: backup_id.to_string(),
        restored: Vec::new(),
        removed: Vec::new(),
        skipped: Vec::new(),
    };
    for entry in manifest.entries.iter().rev() {
        if let Some(interrupt) = interrupted() {
            return Err(UndoError::Interrupted(interrupt, report));
        }
        let destination = resolve_contained_destination(entry, env).map_err(UndoError::Refused)?;
        assert_expected_resource_entry(&destination, entry.kind).map_err(UndoError::Refused)?;
        let location = UndoEntry {
            location_id: entry.location_id.clone(),
            destination_path: entry.destination_path.clone(),
        };
        let skip = |reason: &'static str| UndoSkipped {
            location_id: location.location_id.clone(),
            destination_path: location.destination_path.clone(),
            reason,
        };
        match hasher.hash_at(&destination, entry.kind) {
            Ok(hash) if hash != entry.written_content_hash => {
                report.skipped.push(skip("changed-since-apply"));
                continue;
            }
            Err(error) => {
                let present = store
                    .fs
                    .exists(&fs_path(&destination))
                    .map_err(|error| UndoError::Failed(error.to_string()))?;
                if present {
                    return Err(UndoError::Failed(format!(
                        r#"Could not verify library undo destination "{destination}": {error}"#
                    )));
                }
            }
            Ok(_) => {}
        }
        let Some(backup_path) = &entry.backup_path else {
            store
                .fs
                .remove_all(&fs_path(&destination))
                .map_err(|error| UndoError::Failed(error.to_string()))?;
            report.removed.push(location);
            continue;
        };
        if !is_path_prefix(platform, &backup_set, &node_resolve(platform, backup_path)) {
            report.skipped.push(skip("backup-missing"));
            continue;
        }
        let Some(physical_backup) = resolve_through_existing_ancestor(backup_path).filter(|path| {
            physical_backup_set
                .as_ref()
                .is_some_and(|root| root != path && is_path_prefix(platform, root, path))
        }) else {
            report.skipped.push(skip("backup-missing"));
            continue;
        };
        let present = store
            .fs
            .exists(&fs_path(&physical_backup))
            .map_err(|error| UndoError::Failed(error.to_string()))?;
        if !present {
            report.skipped.push(skip("backup-missing"));
            continue;
        }
        store
            .restore_entry(&BackupEntry {
                resolved_path: destination,
                backup_path: Some(physical_backup),
                ..entry.clone()
            })
            .map_err(|error| UndoError::Failed(error.to_string()))?;
        report.restored.push(location);
    }
    Ok(report)
}

/// Check the recorded destination against its current physical path. The
/// root itself is a valid destination for a single-file location.
fn resolve_contained_destination(entry: &BackupEntry, env: &PathEnv) -> Result<String, WriteError> {
    let location = require_writable_location(&entry.location_id, entry.kind)?;
    let Some(root) = (location.resolve_path)(env) else {
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
    let platform = &env.platform;
    let resolved_root = resolve_through_existing_ancestor(&root).ok_or_else(escape)?;
    let recorded = node_resolve(platform, &entry.resolved_path);
    let physical = resolve_through_existing_ancestor(&entry.resolved_path).ok_or_else(escape)?;
    if !is_path_prefix(platform, &resolved_root, &recorded)
        || !is_path_prefix(platform, &resolved_root, &physical)
    {
        return Err(escape());
    }
    if physical != recorded {
        return Err(WriteError::new(
            WriteFailure::PathEscape,
            format!(r#"Library backup destination "{recorded}" now resolves to "{physical}"."#),
        ));
    }
    if (physical == resolved_root) != (location.layout == LocationLayout::SingleFile) {
        return Err(WriteError::new(
            WriteFailure::PathEscape,
            format!(
                r#"Library backup destination "{physical}" is not a resource in location "{}"."#,
                entry.location_id
            ),
        ));
    }
    Ok(physical)
}

#[cfg(test)]
#[path = "undo_tests.rs"]
mod tests;
