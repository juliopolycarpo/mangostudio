//! `library.remove`'s engine: back up, stage aside, verify gone, record the
//! manifest, then commit — a port of `executeRemovalWrites` in
//! `apps/shared/src/library/machine/remove-writes.ts` and
//! `stageResourceRemoval` in `tree-removal.ts`.
//!
//! A removal never walks a tree deleting as it goes. It renames the whole
//! destination to a dot-prefixed sibling (one atomic step the scanner
//! skips), proves the destination is gone, and deletes the staged tree only
//! once the manifest that can restore it is on disk; any failure before
//! that renames every staged tree home. Two documented corrections to the
//! TypeScript engine: a manifest that cannot be written on the failure path
//! becomes a failure row (TypeScript rejects the whole call and loses the
//! report), and a retention failure after a committed removal is logged
//! rather than turned into an error for a removal that did happen.

use serde::Serialize;

use super::apply::{BackupHandle, Failure, LOCAL_ENVIRONMENT_ID};
use super::backup_store::{BackupEntry, BackupManifest, BackupStore, SetOperation};
use super::disk::{MutationFs, ResourceHasher};
use super::interrupt::Interrupt;
use super::paths::{
    ResourceKind, WriteError, assert_expected_resource_entry, fs_path, node_basename, node_dirname,
    node_join, node_resolve, require_writable_location, resolve_resource_destination,
};
use crate::probing::detection::path_env::PathEnv;

/// `PreparedRemovalOperation`.
#[derive(Debug, Clone)]
pub(crate) struct RemovalOperation {
    pub resource_key: String,
    pub location_id: String,
    pub slug: String,
    pub kind: ResourceKind,
    pub expected_path: String,
    pub expected_content_hash: String,
    pub last_copy: bool,
}

/// `RemovalRemoved`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Removed {
    pub resource_key: String,
    pub environment_id: String,
    pub location_id: String,
    pub path: String,
    pub content_hash: String,
    pub last_copy: bool,
}

/// `RemovalKept`, restricted to the reasons this engine produces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Kept {
    pub resource_key: String,
    pub environment_id: String,
    pub location_id: String,
    pub reason: &'static str,
}

/// `RemovalApply`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemovalResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_id: Option<String>,
    pub backups: Vec<BackupHandle>,
    pub partial: bool,
    pub removed: Vec<Removed>,
    pub kept: Vec<Kept>,
    pub failed: Vec<Failure>,
}

/// Everything one removal needs besides its operations.
pub(crate) struct RemovalContext<'a> {
    pub store: &'a BackupStore,
    pub hasher: &'a dyn ResourceHasher,
    pub env: &'a PathEnv,
    pub environment_id: Option<&'a str>,
    pub backup_id: Option<&'a str>,
    pub last_copy_resource_keys: &'a [String],
    pub interrupted: &'a dyn Fn() -> Option<Interrupt>,
}

#[derive(Debug, Clone)]
enum StageError {
    Guard(String),
    Backup(String),
    Verification(String),
    Failed(String),
}

impl StageError {
    fn reason(&self) -> &'static str {
        match self {
            Self::Guard(_) => "guard-rejected",
            Self::Backup(_) => "backup-failed",
            Self::Verification(_) => "verification-failed",
            Self::Failed(_) => "remove-failed",
        }
    }

    fn message(&self) -> &str {
        match self {
            Self::Guard(message)
            | Self::Backup(message)
            | Self::Verification(message)
            | Self::Failed(message) => message,
        }
    }
}

impl From<WriteError> for StageError {
    fn from(error: WriteError) -> Self {
        Self::Guard(error.message)
    }
}

/// A destination moved aside, restorable by renaming it home.
#[derive(Debug, Clone)]
pub(crate) struct StagedRemoval {
    pub resolved_path: String,
    pub stage_path: String,
}

impl StagedRemoval {
    fn commit(&self, fs: &dyn MutationFs) -> std::io::Result<()> {
        fs.remove_all(&fs_path(&self.stage_path))
    }

    fn rollback(&self, fs: &dyn MutationFs) -> std::io::Result<()> {
        fs.rename(&fs_path(&self.stage_path), &fs_path(&self.resolved_path))
    }
}

struct Staged {
    staged: StagedRemoval,
    entry: BackupEntry,
    removed: Removed,
}

/// `stageResourceRemoval`: moves the destination aside and proves it is
/// gone — a rename that "succeeded" while the destination still resolves
/// (a case-insensitive collision, a stale handle) is put back and refused
/// as a verification failure; a rename that fails is a plain failure.
fn stage_removal(
    fs: &dyn MutationFs,
    platform: &str,
    resolved_path: &str,
    suffix: &str,
) -> Result<StagedRemoval, StageError> {
    let stage_path = node_join(
        platform,
        &[
            &node_dirname(platform, resolved_path),
            &format!(".{}.{suffix}.removing", node_basename(resolved_path)),
        ],
    );
    let io = |error: std::io::Error| StageError::Failed(error.to_string());
    if fs.exists(&fs_path(&stage_path)).map_err(io)? {
        return Err(StageError::Verification(format!(
            "A staged removal already exists at \"{stage_path}\"; refusing to overwrite it."
        )));
    }
    fs.rename(&fs_path(resolved_path), &fs_path(&stage_path))
        .map_err(io)?;
    if fs.exists(&fs_path(resolved_path)).map_err(io)? {
        let _ = fs.rename(&fs_path(&stage_path), &fs_path(resolved_path));
        return Err(StageError::Verification(format!(
            "\"{resolved_path}\" still exists after being removed."
        )));
    }
    Ok(StagedRemoval {
        resolved_path: resolved_path.to_string(),
        stage_path,
    })
}

/// `executeRemovalWrites`.
///
/// # Example
///
/// ```ignore
/// let result = execute_removal(&operations, &context);
/// ```
pub(crate) fn execute_removal(
    operations: &[RemovalOperation],
    context: &RemovalContext<'_>,
) -> RemovalResult {
    let environment_id = context.environment_id.unwrap_or(LOCAL_ENVIRONMENT_ID);
    let backup_id = context
        .backup_id
        .map_or_else(|| context.store.create_backup_id(), str::to_string);
    let mut results: Vec<Staged> = Vec::new();
    let mut failed: Vec<Failure> = Vec::new();

    for operation in operations {
        let outcome = match (context.interrupted)() {
            Some(interrupt) => Err(StageError::Failed(interrupt.message().to_string())),
            None => stage_operation(operation, &backup_id, environment_id, context),
        };
        match outcome {
            Ok(staged) => results.push(staged),
            Err(error) => {
                failed.push(Failure {
                    resource_key: operation.resource_key.clone(),
                    environment_id: environment_id.to_string(),
                    location_id: operation.location_id.clone(),
                    reason: error.reason(),
                    message: error.message().to_string(),
                });
                break;
            }
        }
    }

    let handles = vec![BackupHandle {
        environment_id: environment_id.to_string(),
        backup_id: backup_id.clone(),
    }];
    let fs = context.store.fs.as_ref();
    let entries: Vec<BackupEntry> = results.iter().map(|result| result.entry.clone()).collect();

    if !failed.is_empty() {
        let unattempted = not_attempted(operations, environment_id, results.len());
        let unrestored = rollback(&results, fs);
        let mut kept = rolled_back(&results, &unrestored);
        kept.extend(unattempted);
        if unrestored.is_empty() {
            let _ = context.store.discard_set(&backup_id);
            return settled(Vec::new(), kept, failed, None);
        }
        let mut backups = handles;
        let mut backup_handle = Some(backup_id.clone());
        if let Err(message) = persist(&backup_id, &entries, context) {
            failed.push(manifest_failure(
                operations,
                environment_id,
                &backup_id,
                &message,
            ));
            backups = Vec::new();
            backup_handle = None;
        }
        return RemovalResult {
            backup_id: backup_handle,
            backups,
            partial: true,
            removed: still_removed(&results, &unrestored),
            kept,
            failed,
        };
    }
    if entries.is_empty() {
        return settled(Vec::new(), Vec::new(), failed, None);
    }
    if let Err(message) = persist(&backup_id, &entries, context) {
        let unrestored = rollback(&results, fs);
        if unrestored.is_empty() {
            let _ = context.store.discard_set(&backup_id);
        }
        failed.push(manifest_failure(
            operations,
            environment_id,
            &backup_id,
            &message,
        ));
        let kept = rolled_back(&results, &unrestored);
        // No handle either way: the manifest is what undo resolves, and it is
        // exactly what failed to be written. The message names the set.
        if unrestored.is_empty() {
            return settled(Vec::new(), kept, failed, None);
        }
        let mut result = settled(still_removed(&results, &unrestored), kept, failed, None);
        result.partial = true;
        return result;
    }
    for result in &results {
        if let Err(error) = result.staged.commit(fs) {
            eprintln!(
                "[library] Could not clean up \"{}\": {error}",
                result.staged.stage_path
            );
        }
    }
    if let Err(error) = context.store.prune(Some(&backup_id)) {
        eprintln!("[library] Backup retention after removal \"{backup_id}\" failed: {error}");
    }
    RemovalResult {
        backup_id: Some(backup_id),
        backups: handles,
        partial: false,
        removed: results.into_iter().map(|result| result.removed).collect(),
        kept: Vec::new(),
        failed,
    }
}

fn settled(
    removed: Vec<Removed>,
    kept: Vec<Kept>,
    failed: Vec<Failure>,
    backup_id: Option<String>,
) -> RemovalResult {
    RemovalResult {
        backup_id,
        backups: Vec::new(),
        partial: false,
        removed,
        kept,
        failed,
    }
}

fn manifest_failure(
    operations: &[RemovalOperation],
    environment_id: &str,
    backup_id: &str,
    message: &str,
) -> Failure {
    let first = operations.first();
    Failure {
        resource_key: first
            .map(|operation| operation.resource_key.clone())
            .unwrap_or_default(),
        environment_id: environment_id.to_string(),
        location_id: first
            .map(|operation| operation.location_id.clone())
            .unwrap_or_default(),
        reason: "remove-failed",
        message: format!(
            "Could not record the backup manifest, so this removal cannot be undone automatically; the copies are under backup set \"{backup_id}\": {message}"
        ),
    }
}

fn persist(
    backup_id: &str,
    entries: &[BackupEntry],
    context: &RemovalContext<'_>,
) -> Result<(), String> {
    let pinned = !context.last_copy_resource_keys.is_empty();
    let manifest = BackupManifest {
        version: 3,
        backup_id: backup_id.to_string(),
        created_at_ms: (context.store.now_ms)(),
        entries: entries.to_vec(),
        operation: Some(SetOperation::Removal),
        environment_id: context.environment_id.map(str::to_string),
        pinned: pinned.then_some(true),
        last_copy_resource_keys: pinned.then(|| context.last_copy_resource_keys.to_vec()),
    };
    context
        .store
        .write_manifest(&manifest)
        .map_err(|error| error.to_string())
}

fn stage_operation(
    operation: &RemovalOperation,
    backup_id: &str,
    environment_id: &str,
    context: &RemovalContext<'_>,
) -> Result<Staged, StageError> {
    let location = require_writable_location(&operation.location_id, operation.kind)?;
    let destination = resolve_resource_destination(location, &operation.slug, context.env)?;
    let platform = &context.env.platform;
    if node_resolve(platform, &destination.logical_path)
        != node_resolve(platform, &operation.expected_path)
    {
        return Err(StageError::Guard(format!(
            "\"{}\" resolves to \"{}\" at \"{}\", not the previewed \"{}\".",
            operation.resource_key, destination.logical_path, location.id, operation.expected_path
        )));
    }
    assert_expected_resource_entry(&destination.resolved_path, operation.kind)?;
    let content_hash = context
        .hasher
        .hash_at(&destination.resolved_path, operation.kind)
        .map_err(|error| StageError::Failed(error.to_string()))?;
    if content_hash != operation.expected_content_hash {
        return Err(StageError::Guard(format!(
            "\"{}\" hashed to {content_hash}, not the {} the preview described.",
            destination.logical_path, operation.expected_content_hash
        )));
    }
    let backup_path = context
        .store
        .backup_existing(
            &destination.resolved_path,
            location.id,
            &operation.slug,
            backup_id,
        )
        .map_err(|error| {
            StageError::Backup(format!(
                "Could not back up \"{}\": {error}",
                destination.logical_path
            ))
        })?;
    let staged = stage_removal(
        context.store.fs.as_ref(),
        &context.store.platform,
        &destination.resolved_path,
        &(context.store.random_suffix)(),
    )?;
    Ok(Staged {
        staged,
        entry: BackupEntry {
            location_id: location.id.to_string(),
            slug: operation.slug.clone(),
            kind: operation.kind,
            destination_path: destination.logical_path.clone(),
            resolved_path: destination.resolved_path.clone(),
            backup_path: Some(backup_path),
            written_content_hash: content_hash.clone(),
            resource_key: Some(operation.resource_key.clone()),
        },
        removed: Removed {
            resource_key: operation.resource_key.clone(),
            environment_id: environment_id.to_string(),
            location_id: location.id.to_string(),
            path: destination.logical_path,
            content_hash,
            last_copy: operation.last_copy,
        },
    })
}

/// Renames every staged tree home, newest first; answers the stage paths
/// that could not be put back.
fn rollback(results: &[Staged], fs: &dyn MutationFs) -> Vec<String> {
    let mut unrestored = Vec::new();
    for result in results.iter().rev() {
        if let Err(error) = result.staged.rollback(fs) {
            eprintln!(
                "[library] Could not restore \"{}\": {error}",
                result.staged.resolved_path
            );
            unrestored.push(result.staged.stage_path.clone());
        }
    }
    unrestored
}

fn still_removed(results: &[Staged], unrestored: &[String]) -> Vec<Removed> {
    results
        .iter()
        .filter(|result| unrestored.contains(&result.staged.stage_path))
        .map(|result| result.removed.clone())
        .collect()
}

fn rolled_back(results: &[Staged], unrestored: &[String]) -> Vec<Kept> {
    results
        .iter()
        .filter(|result| !unrestored.contains(&result.staged.stage_path))
        .map(|result| Kept {
            resource_key: result.removed.resource_key.clone(),
            environment_id: result.removed.environment_id.clone(),
            location_id: result.removed.location_id.clone(),
            reason: "rolled-back",
        })
        .collect()
}

fn not_attempted(
    operations: &[RemovalOperation],
    environment_id: &str,
    staged: usize,
) -> Vec<Kept> {
    operations
        .iter()
        .skip(staged + 1)
        .map(|operation| Kept {
            resource_key: operation.resource_key.clone(),
            environment_id: environment_id.to_string(),
            location_id: operation.location_id.clone(),
            reason: "not-attempted",
        })
        .collect()
}

#[cfg(test)]
#[path = "removal_tests.rs"]
mod tests;
