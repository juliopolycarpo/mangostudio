//! `library.apply`'s engine: write, verify, record the manifest, and
//! compensate on failure — a port of `executePropagationWrites` in
//! `apps/shared/src/library/machine/apply-writes.ts`.
//!
//! Every operation is one bounded effect (one file, or one directory swap)
//! followed by a re-hash of what actually landed. The loop stops at the
//! first failure — including an interruption (cancellation or withdrawn
//! consent) observed at the boundary *between* operations — and rolls back
//! what it wrote, newest first. `partial` is true only when that rollback
//! itself failed, and then the backup set is kept and named.
//!
//! One documented correction: when every write landed but recording the
//! manifest (or the retention pass that follows it) failed and the rollback
//! succeeded, TypeScript answers an empty success (`applied: []`,
//! `failed: []`). This engine adds the `write-failed` row saying so.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{Map, Value};

use super::backup_store::{BackupEntry, BackupManifest, BackupStore, SetOperation};
use super::disk::ResourceHasher;
use super::hashing::HashError;
use super::interrupt::Interrupt;
use super::paths::{ResourceKind, fs_path, node_resolve, require_writable_location};
use super::writer::{
    DirectorySource, WriteResult, WriteTarget, WriterError, write_directory, write_file,
};
use crate::probing::detection::path_env::PathEnv;

/// `LOCAL_ENVIRONMENT_ID`: every row names the environment the hub sent,
/// and an absent one means Local.
pub(crate) const LOCAL_ENVIRONMENT_ID: &str = "local";

/// `PreparedPropagationOperation`, payload decoded.
#[derive(Debug, Clone)]
pub(crate) struct ApplyOperation {
    pub resource_key: String,
    pub location_id: String,
    pub slug: String,
    pub operation: String,
    pub kind: ResourceKind,
    pub expected_content_hash: String,
    pub destination_root: String,
    pub directory: Option<DirectorySource>,
    pub contents: Option<Arc<Vec<u8>>>,
    pub adaptation: Option<Value>,
}

/// `PropagationApplied`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Applied {
    pub resource_key: String,
    pub environment_id: String,
    pub location_id: String,
    pub operation: String,
    pub destination_path: String,
    pub content_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adaptation: Option<Value>,
}

/// `PropagationFailure` and `RemovalFailure`: the same row shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Failure {
    pub resource_key: String,
    pub environment_id: String,
    pub location_id: String,
    pub reason: &'static str,
    pub message: String,
}

/// `PropagationBackupHandle`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupHandle {
    pub environment_id: String,
    pub backup_id: String,
}

/// `PropagationApply`. `skipped` is always empty: the hub decided what to
/// skip while planning and merges its own list.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApplyResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_id: Option<String>,
    pub backups: Vec<BackupHandle>,
    pub partial: bool,
    pub applied: Vec<Applied>,
    pub skipped: Vec<Value>,
    pub failed: Vec<Failure>,
}

impl ApplyResult {
    fn settled(applied: Vec<Applied>, failed: Vec<Failure>) -> Self {
        Self {
            backup_id: None,
            backups: Vec::new(),
            partial: false,
            applied,
            skipped: Vec::new(),
            failed,
        }
    }

    fn with_set(mut self, environment_id: &str, backup_id: &str) -> Self {
        self.backup_id = Some(backup_id.to_string());
        self.backups = vec![BackupHandle {
            environment_id: environment_id.to_string(),
            backup_id: backup_id.to_string(),
        }];
        self
    }
}

/// Everything one apply needs besides its operations.
pub(crate) struct ApplyContext<'a> {
    pub store: &'a BackupStore,
    pub hasher: &'a dyn ResourceHasher,
    pub env: &'a PathEnv,
    /// As the request carried it: stamped into the manifest only if sent.
    pub environment_id: Option<&'a str>,
    pub backup_id: Option<&'a str>,
    /// Checked at every boundary between operations.
    pub interrupted: &'a dyn Fn() -> Option<Interrupt>,
}

/// Why one operation failed, classified the way `describeFailure` does.
#[derive(Debug, Clone)]
enum OpError {
    /// `GuardError` or `LibraryWriteError`: `guard-rejected`.
    Guard(String),
    /// `VerificationError`: `verification-failed`, with the digest it saw.
    Verification { message: String, observed: String },
    /// Anything else: `write-failed`.
    Failed(String),
}

impl OpError {
    fn reason(&self) -> &'static str {
        match self {
            Self::Guard(_) => "guard-rejected",
            Self::Verification { .. } => "verification-failed",
            Self::Failed(_) => "write-failed",
        }
    }

    fn message(&self) -> String {
        match self {
            Self::Guard(message) | Self::Failed(message) => message.clone(),
            Self::Verification { message, .. } => message.clone(),
        }
    }
}

impl From<WriterError> for OpError {
    fn from(error: WriterError) -> Self {
        match error {
            WriterError::Policy(error) => Self::Guard(error.message),
            WriterError::Failed(message) => Self::Failed(message),
        }
    }
}

/// A failed operation, with the entry to keep when its own compensation
/// failed too (`UncompensatedWriteError`).
struct OpFailure {
    error: OpError,
    uncompensated: Option<Box<BackupEntry>>,
}

/// `executePropagationWrites`.
///
/// # Example
///
/// ```ignore
/// let result = execute_apply(&operations, &context);
/// assert!(!result.partial);
/// ```
pub(crate) fn execute_apply(
    operations: &[ApplyOperation],
    context: &ApplyContext<'_>,
) -> ApplyResult {
    let environment_id = context.environment_id.unwrap_or(LOCAL_ENVIRONMENT_ID);
    let backup_id = context
        .backup_id
        .map_or_else(|| context.store.create_backup_id(), str::to_string);
    let mut written: Vec<BackupEntry> = Vec::new();
    let mut applied: Vec<Applied> = Vec::new();
    let mut failed: Vec<Failure> = Vec::new();

    for operation in operations {
        let outcome = match (context.interrupted)() {
            Some(interrupt) => Err(OpFailure {
                error: OpError::Failed(interrupt.message().to_string()),
                uncompensated: None,
            }),
            None => execute_operation(operation, &backup_id, environment_id, context),
        };
        match outcome {
            Ok((entry, row)) => {
                written.push(entry);
                applied.push(row);
            }
            Err(failure) => {
                written.extend(failure.uncompensated.map(|entry| *entry));
                failed.push(describe(operation, environment_id, &failure.error));
                break;
            }
        }
    }

    if !failed.is_empty() {
        if rollback(&written, context.store) {
            let _ = context.store.discard_set(&backup_id);
            return ApplyResult::settled(Vec::new(), failed);
        }
        if let Err(message) = persist(&backup_id, &written, context) {
            failed.push(manifest_failure(
                operations,
                environment_id,
                &backup_id,
                &message,
            ));
        }
        let mut result = ApplyResult::settled(applied, failed).with_set(environment_id, &backup_id);
        result.partial = true;
        return result;
    }
    if written.is_empty() {
        return ApplyResult::settled(applied, failed);
    }
    let Err(message) = persist(&backup_id, &written, context) else {
        return ApplyResult::settled(applied, failed).with_set(environment_id, &backup_id);
    };
    if rollback(&written, context.store) {
        let _ = context.store.discard_set(&backup_id);
        let row = Failure {
            message: format!(
                "Could not record the backup manifest, so the apply was rolled back: {message}"
            ),
            ..manifest_failure(operations, environment_id, &backup_id, &message)
        };
        return ApplyResult::settled(Vec::new(), vec![row]);
    }
    failed.push(manifest_failure(
        operations,
        environment_id,
        &backup_id,
        &message,
    ));
    let mut result = ApplyResult::settled(applied, failed).with_set(environment_id, &backup_id);
    result.partial = true;
    result
}

fn manifest_failure(
    operations: &[ApplyOperation],
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
        reason: "write-failed",
        message: format!(
            "Could not record the backup manifest, so this apply cannot be undone automatically; the previous copies are under backup set \"{backup_id}\": {message}"
        ),
    }
}

/// `persistBackupManifest`: the manifest, then retention (keeping this set).
fn persist(
    backup_id: &str,
    written: &[BackupEntry],
    context: &ApplyContext<'_>,
) -> Result<(), String> {
    let manifest = BackupManifest {
        version: 3,
        backup_id: backup_id.to_string(),
        created_at_ms: (context.store.now_ms)(),
        entries: written.to_vec(),
        operation: Some(SetOperation::Propagation),
        environment_id: context.environment_id.map(str::to_string),
        pinned: None,
        last_copy_resource_keys: None,
    };
    context
        .store
        .write_manifest(&manifest)
        .and_then(|()| context.store.prune(Some(backup_id)))
        .map_err(|error| error.to_string())
}

fn execute_operation(
    operation: &ApplyOperation,
    backup_id: &str,
    environment_id: &str,
    context: &ApplyContext<'_>,
) -> Result<(BackupEntry, Applied), OpFailure> {
    let fail = |error: OpError| OpFailure {
        error,
        uncompensated: None,
    };
    assert_previewed_root(operation, context.env).map_err(fail)?;
    let result = perform_write(operation, backup_id, context).map_err(fail)?;
    match verify(operation, &result, context.hasher) {
        Ok(content_hash) => {
            let entry = entry_from(operation, &result, content_hash.clone());
            let row = Applied {
                resource_key: operation.resource_key.clone(),
                environment_id: environment_id.to_string(),
                location_id: operation.location_id.clone(),
                operation: operation.operation.clone(),
                destination_path: result.destination_path.clone(),
                content_hash,
                adaptation: operation.adaptation.as_ref().map(adaptation_row),
            };
            Ok((entry, row))
        }
        Err(error) => {
            // The bytes are already on disk: compensate this one write here,
            // and keep its entry when that fails so the set is retained.
            let observed = match &error {
                OpError::Verification { observed, .. } if !observed.is_empty() => observed.clone(),
                _ => context
                    .hasher
                    .hash_at(&result.resolved_destination_path, operation.kind)
                    .unwrap_or_default(),
            };
            let entry = entry_from(operation, &result, observed);
            let rolled_back = rollback(std::slice::from_ref(&entry), context.store);
            Err(OpFailure {
                error,
                uncompensated: (!rolled_back).then(|| Box::new(entry)),
            })
        }
    }
}

/// The adaptation echoed onto an applied row, member by member as the
/// TypeScript engine rebuilds it.
fn adaptation_row(adaptation: &Value) -> Value {
    let mut out = Map::new();
    for key in ["strategy", "lossy", "requiresReview", "notes", "provenance"] {
        if let Some(value) = adaptation.get(key) {
            out.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(out)
}

fn perform_write(
    operation: &ApplyOperation,
    backup_id: &str,
    context: &ApplyContext<'_>,
) -> Result<WriteResult, OpError> {
    let target = WriteTarget {
        location_id: &operation.location_id,
        slug: &operation.slug,
        env: context.env,
        backup_id,
    };
    let verification = |message: String| OpError::Verification {
        message,
        observed: String::new(),
    };
    match operation.kind {
        ResourceKind::Directory => {
            let Some(source) = &operation.directory else {
                return Err(verification(format!(
                    "\"{}\" is a directory write without a source directory or its files.",
                    operation.resource_key
                )));
            };
            Ok(write_directory(&target, source, context.store)?)
        }
        ResourceKind::File => {
            let Some(contents) = &operation.contents else {
                return Err(verification(format!(
                    "\"{}\" is a file write without contents.",
                    operation.resource_key
                )));
            };
            Ok(write_file(&target, contents, context.store)?)
        }
    }
}

/// `hashWrittenContent`.
fn verify(
    operation: &ApplyOperation,
    result: &WriteResult,
    hasher: &dyn ResourceHasher,
) -> Result<String, OpError> {
    let digest = match hasher.hash_at(&result.resolved_destination_path, operation.kind) {
        Ok(digest) => digest,
        Err(HashError::Invalid(reason)) => {
            return Err(OpError::Verification {
                message: format!(
                    "Wrote \"{}\" but hashing it failed ({reason}).",
                    result.destination_path
                ),
                observed: String::new(),
            });
        }
        Err(error) => return Err(OpError::Failed(error.to_string())),
    };
    if digest != operation.expected_content_hash {
        return Err(OpError::Verification {
            message: format!(
                "Wrote \"{}\" but its content hashed to {digest}, not {}.",
                result.destination_path, operation.expected_content_hash
            ),
            observed: digest,
        });
    }
    Ok(digest)
}

fn entry_from(
    operation: &ApplyOperation,
    result: &WriteResult,
    written_content_hash: String,
) -> BackupEntry {
    BackupEntry {
        location_id: operation.location_id.clone(),
        slug: operation.slug.clone(),
        kind: operation.kind,
        destination_path: result.destination_path.clone(),
        resolved_path: result.resolved_destination_path.clone(),
        backup_path: result.backup_path.clone(),
        written_content_hash,
        resource_key: Some(operation.resource_key.clone()),
    }
}

/// Restores every backed-up entry and removes every created one, newest
/// first; `false` when any of them could not be compensated.
pub(crate) fn rollback(written: &[BackupEntry], store: &BackupStore) -> bool {
    let mut complete = true;
    for entry in written.iter().rev() {
        let outcome = match &entry.backup_path {
            Some(_) => store
                .restore_entry(entry)
                .map_err(|error| error.to_string()),
            None => store
                .fs
                .remove_all(&fs_path(&entry.resolved_path))
                .map_err(|error| error.to_string()),
        };
        if let Err(message) = outcome {
            complete = false;
            eprintln!(
                "[library] Could not roll back \"{}\": {message}",
                entry.destination_path
            );
        }
    }
    complete
}

/// `assertPreviewedRoot`: the location must resolve, on this machine, to
/// the root the preview showed the user — otherwise the bytes would land
/// somewhere nobody consented to.
fn assert_previewed_root(operation: &ApplyOperation, env: &PathEnv) -> Result<(), OpError> {
    let location = require_writable_location(&operation.location_id, operation.kind)
        .map_err(|error| OpError::Guard(error.message))?;
    let root = (location.resolve_path)(env);
    if let Some(root) = &root
        && node_resolve(&env.platform, root)
            == node_resolve(&env.platform, &operation.destination_root)
    {
        return Ok(());
    }
    Err(OpError::Guard(format!(
        "\"{}\" resolves to \"{}\" on this machine, not the previewed \"{}\".",
        location.id,
        root.as_deref().unwrap_or("nothing"),
        operation.destination_root
    )))
}

fn describe(operation: &ApplyOperation, environment_id: &str, error: &OpError) -> Failure {
    Failure {
        resource_key: operation.resource_key.clone(),
        environment_id: environment_id.to_string(),
        location_id: operation.location_id.clone(),
        reason: error.reason(),
        message: error.message(),
    }
}

#[cfg(test)]
#[path = "apply_tests.rs"]
mod tests;
