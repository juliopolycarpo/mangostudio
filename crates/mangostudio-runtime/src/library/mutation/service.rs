//! The five write-lane handlers — `library.apply`, `library.remove`,
//! `library.undo`, `library.backups` and `library.gc` — and the owner that
//! serializes them, the write half of
//! `apps/runtime/src/services/library/service.ts`.
//!
//! # Ownership and cancellation
//!
//! Every mutation of one backup root runs alone (`write-queue.ts`): the
//! hub's own queue releases when its deadline fires, while the work here
//! carries on until its compensation finishes, so a retry must wait for it
//! where the files are. The owner is a process-wide path lock on the
//! resolved backup root, acquired by the handler and then *moved into* the
//! blocking worker that performs the mutation, so it is held until the work
//! actually ends — never merely until the RPC stops waiting.
//!
//! - Cancelled before the owner is held, or once held but before the first
//!   effect: the call is refused with `CANCELLED` and nothing is written
//!   (the TypeScript host answers a failure row here instead; nothing on
//!   disk differs).
//! - Consent is re-read under the owner, immediately before the first
//!   effect, and refused with `DENIED` if it no longer grants the method.
//! - Cancelled, or consent withdrawn, while effects are running: the
//!   operation in progress finishes, and the next boundary between
//!   operations stops the loop and compensates exactly as a failure does.
//!   The owner is released only after that.
//!
//! `library.backups` is a read — library consent alone, no owner, and it
//! never prunes. `library.gc` is the explicit purge and prune, and takes the
//! owner, so it can never collect a set an apply is still filling.

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mango_protocol::error::{RemoteError, codes};
use mango_protocol::session::CallContext;
use serde::Deserialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::apply::{ApplyContext, ApplyOperation, execute_apply};
use super::backup_store::{
    BackupStore, Clock, DEFAULT_RETENTION_BYTES, DEFAULT_RETENTION_COUNT, StoreError, Suffix,
};
use super::disk::{MutationFs, NativeHasher, NativeMutationFs, ResourceHasher, random_suffix};
use super::interrupt::Interrupt;
use super::paths::{ResourceKind, node_resolve};
use super::removal::{RemovalContext, RemovalOperation, execute_removal};
use super::undo::{UndoError, execute_undo};
use super::writer::{DirectorySource, TransferredFile};
use crate::consent::source::ConsentSource;
use crate::filesystem::freshness::{PathLockError, PathLocks};
use crate::library::cache::{cancelled, check_cancelled};
use crate::library::service::{PathEnvFactory, PathEnvParams, authorize, tool_argument};
use crate::library::workers::run_library_blocking;
use crate::probing::detection::path_env::{PathEnv, is_absolute};
use crate::registry::Registry;

/// `LIBRARY_BACKUP_MISSING_KIND`: the hub answers 404 on exactly this.
pub(crate) const LIBRARY_BACKUP_MISSING_KIND: &str = "library_backup_missing";

/// `RuntimeLibraryApplyOperation`: the prepared write, payload by reference.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApplyOperationParams {
    pub resource_key: String,
    pub location_id: String,
    pub slug: String,
    pub operation: String,
    pub kind: String,
    pub expected_content_hash: String,
    pub destination_root: String,
    #[serde(default)]
    pub source_dir: Option<String>,
    #[serde(default)]
    pub adaptation: Option<Value>,
    #[serde(default)]
    pub content_ref: Option<String>,
    #[serde(default)]
    pub files: Option<Vec<FileRefParams>>,
}

/// One file of a transferred tree.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileRefParams {
    pub relative_path: String,
    pub content_ref: String,
}

/// `RuntimeLibraryApplyParams`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApplyParams {
    pub backup_root: String,
    #[serde(default)]
    pub retention_count: Option<f64>,
    #[serde(default)]
    pub retention_bytes: Option<f64>,
    #[serde(default)]
    pub path_env: Option<PathEnvParams>,
    #[serde(default)]
    pub backup_id: Option<String>,
    #[serde(default)]
    pub environment_id: Option<String>,
    pub operations: Vec<ApplyOperationParams>,
    #[serde(default)]
    pub contents: Option<HashMap<String, String>>,
}

/// `RuntimeLibraryRemoveOperation`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoveOperationParams {
    pub resource_key: String,
    pub location_id: String,
    pub slug: String,
    pub kind: String,
    pub expected_path: String,
    pub expected_content_hash: String,
    pub last_copy: bool,
}

/// `RuntimeLibraryRemoveParams`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoveParams {
    pub backup_root: String,
    #[serde(default)]
    pub retention_count: Option<f64>,
    #[serde(default)]
    pub retention_bytes: Option<f64>,
    #[serde(default)]
    pub path_env: Option<PathEnvParams>,
    #[serde(default)]
    pub backup_id: Option<String>,
    #[serde(default)]
    pub environment_id: Option<String>,
    pub operations: Vec<RemoveOperationParams>,
    #[serde(default)]
    pub last_copy_resource_keys: Option<Vec<String>>,
}

/// `RuntimeLibraryUndoParams`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UndoParams {
    pub backup_root: String,
    pub backup_id: String,
    #[serde(default)]
    pub path_env: Option<PathEnvParams>,
}

/// `RuntimeLibraryBackupsParams` and `RuntimeLibraryGcParams`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoreParams {
    pub backup_root: String,
    #[serde(default)]
    pub retention_count: Option<f64>,
    #[serde(default)]
    pub retention_bytes: Option<f64>,
    #[serde(default)]
    pub purge_backup_ids: Option<Vec<String>>,
}

/// The write lane's shared state.
pub(crate) struct MutationService {
    pub consent: Arc<ConsentSource>,
    pub path_env: PathEnvFactory,
    pub fs: Arc<dyn MutationFs>,
    pub hasher: Arc<dyn ResourceHasher>,
    pub owners: PathLocks,
    pub platform: String,
    pub now_ms: Clock,
    pub random_suffix: Suffix,
}

impl MutationService {
    /// The production lane: this machine's disk and clock, and the one
    /// process-wide owner table every session shares.
    pub(crate) fn native(consent: Arc<ConsentSource>, path_env: PathEnvFactory) -> Self {
        static OWNERS: std::sync::OnceLock<PathLocks> = std::sync::OnceLock::new();
        Self {
            consent,
            path_env,
            fs: Arc::new(NativeMutationFs),
            hasher: Arc::new(NativeHasher),
            owners: OWNERS.get_or_init(PathLocks::new).clone(),
            platform: crate::health::node_platform().to_string(),
            now_ms: Arc::new(epoch_ms),
            random_suffix: Arc::new(random_suffix),
        }
    }

    fn store(&self, root: &str, count: Option<f64>, bytes: Option<f64>) -> BackupStore {
        BackupStore {
            fs: Arc::clone(&self.fs),
            root: root.to_string(),
            platform: self.platform.clone(),
            retention_count: count.unwrap_or(DEFAULT_RETENTION_COUNT),
            retention_bytes: bytes.unwrap_or(DEFAULT_RETENTION_BYTES),
            now_ms: Arc::clone(&self.now_ms),
            random_suffix: Arc::clone(&self.random_suffix),
        }
    }

    fn env(&self, params: Option<&PathEnvParams>) -> PathEnv {
        (self.path_env)(params.and_then(|params| params.env.as_ref()))
    }

    /// `assertBackupRoot`: non-empty and absolute on this host, so it can
    /// never resolve against the runtime's working directory.
    fn assert_backup_root(&self, root: &str, method: &str) -> Result<(), RemoteError> {
        if root.is_empty() {
            return Err(tool_argument(format!(
                "{method} requires a non-empty backupRoot."
            )));
        }
        if !is_absolute(&self.platform, root) {
            return Err(tool_argument(format!(
                "{method} requires an absolute backupRoot."
            )));
        }
        Ok(())
    }

    /// Runs `work` as the owner of `root`: see the module docs.
    async fn run_owned<T, F>(
        &self,
        method: &'static str,
        root: &str,
        cancel: &CancellationToken,
        work: F,
    ) -> Result<T, RemoteError>
    where
        F: FnOnce(&dyn Fn() -> Option<Interrupt>) -> Result<T, RemoteError> + Send + 'static,
        T: Send + 'static,
    {
        let key = node_resolve(&self.platform, root).into();
        let owner = self
            .owners
            .acquire(vec![key], cancel)
            .await
            .map_err(|PathLockError::Cancelled| cancelled())?;
        let consent = Arc::clone(&self.consent);
        let cancel = cancel.clone();
        run_library_blocking(move || {
            let _owner = owner;
            check_cancelled(&cancel)?;
            authorize(&consent, method)?;
            let interrupted = || {
                if cancel.is_cancelled() {
                    return Some(Interrupt::Cancelled);
                }
                authorize(&consent, method)
                    .err()
                    .map(|_| Interrupt::ConsentWithdrawn)
            };
            work(&interrupted)
        })
        .await
    }

    /// `library.apply`.
    pub(crate) async fn apply(
        &self,
        params: ApplyParams,
        cancel: CancellationToken,
    ) -> Result<Value, RemoteError> {
        check_cancelled(&cancel)?;
        self.assert_backup_root(&params.backup_root, "library.apply")?;
        let operations = decode_apply_operations(&params)?;
        let env = self.env(params.path_env.as_ref());
        let store = self.store(
            &params.backup_root,
            params.retention_count,
            params.retention_bytes,
        );
        let hasher = Arc::clone(&self.hasher);
        let root = params.backup_root.clone();
        self.run_owned("library.apply", &root, &cancel, move |interrupted| {
            let context = ApplyContext {
                store: &store,
                hasher: hasher.as_ref(),
                env: &env,
                environment_id: params.environment_id.as_deref(),
                backup_id: params.backup_id.as_deref(),
                interrupted,
            };
            encode(&execute_apply(&operations, &context))
        })
        .await
    }

    /// `library.remove`.
    pub(crate) async fn remove(
        &self,
        params: RemoveParams,
        cancel: CancellationToken,
    ) -> Result<Value, RemoteError> {
        check_cancelled(&cancel)?;
        self.assert_backup_root(&params.backup_root, "library.remove")?;
        let operations = params
            .operations
            .iter()
            .map(|operation| {
                Ok(RemovalOperation {
                    resource_key: operation.resource_key.clone(),
                    location_id: operation.location_id.clone(),
                    slug: operation.slug.clone(),
                    kind: parse_kind(&operation.kind, "library.remove")?,
                    expected_path: operation.expected_path.clone(),
                    expected_content_hash: operation.expected_content_hash.clone(),
                    last_copy: operation.last_copy,
                })
            })
            .collect::<Result<Vec<_>, RemoteError>>()?;
        let env = self.env(params.path_env.as_ref());
        let store = self.store(
            &params.backup_root,
            params.retention_count,
            params.retention_bytes,
        );
        let hasher = Arc::clone(&self.hasher);
        let root = params.backup_root.clone();
        let last_copy = params.last_copy_resource_keys.clone().unwrap_or_default();
        self.run_owned("library.remove", &root, &cancel, move |interrupted| {
            let context = RemovalContext {
                store: &store,
                hasher: hasher.as_ref(),
                env: &env,
                environment_id: params.environment_id.as_deref(),
                backup_id: params.backup_id.as_deref(),
                last_copy_resource_keys: &last_copy,
                interrupted,
            };
            encode(&execute_removal(&operations, &context))
        })
        .await
    }

    /// `library.undo`.
    pub(crate) async fn undo(
        &self,
        params: UndoParams,
        cancel: CancellationToken,
    ) -> Result<Value, RemoteError> {
        check_cancelled(&cancel)?;
        self.assert_backup_root(&params.backup_root, "library.undo")?;
        if params.backup_id.is_empty() {
            return Err(tool_argument(
                "library.undo requires a non-empty backupId.".into(),
            ));
        }
        let env = self.env(params.path_env.as_ref());
        let store = self.store(&params.backup_root, None, None);
        let hasher = Arc::clone(&self.hasher);
        let root = params.backup_root.clone();
        let consent = Arc::clone(&self.consent);
        self.run_owned(
            "library.undo",
            &root,
            &cancel,
            move |interrupted| match execute_undo(
                &params.backup_id,
                &store,
                hasher.as_ref(),
                &env,
                interrupted,
            ) {
                Ok(report) => encode(&report),
                Err(UndoError::Missing(message)) => Err(RemoteError::new(codes::INTERNAL, message)
                    .with_detail("kind", LIBRARY_BACKUP_MISSING_KIND)),
                Err(UndoError::Refused(error)) => {
                    Err(RemoteError::new(codes::INTERNAL, error.message)
                        .with_detail("kind", "path_access"))
                }
                Err(UndoError::Interrupted(Interrupt::Cancelled)) => Err(cancelled()),
                Err(UndoError::Interrupted(Interrupt::ConsentWithdrawn)) => {
                    Err(authorize(&consent, "library.undo")
                        .err()
                        .unwrap_or_else(|| {
                            RemoteError::new(codes::DENIED, Interrupt::ConsentWithdrawn.message())
                        }))
                }
                Err(UndoError::Failed(message)) => Err(RemoteError::new(codes::INTERNAL, message)),
            },
        )
        .await
    }

    /// `library.backups`: read-only, library consent only, never prunes.
    pub(crate) async fn backups(
        &self,
        params: StoreParams,
        cancel: CancellationToken,
    ) -> Result<Value, RemoteError> {
        check_cancelled(&cancel)?;
        self.assert_backup_root(&params.backup_root, "library.backups")?;
        let store = self.store(
            &params.backup_root,
            params.retention_count,
            params.retention_bytes,
        );
        let consent = Arc::clone(&self.consent);
        run_library_blocking(move || {
            authorize(&consent, "library.backups")?;
            let sets = store.list().map_err(store_error)?;
            Ok(serde_json::json!({ "sets": sets }))
        })
        .await
    }

    /// `library.gc`: the explicit purge and prune, under the owner.
    pub(crate) async fn gc(
        &self,
        params: StoreParams,
        cancel: CancellationToken,
    ) -> Result<Value, RemoteError> {
        check_cancelled(&cancel)?;
        self.assert_backup_root(&params.backup_root, "library.gc")?;
        let store = self.store(
            &params.backup_root,
            params.retention_count,
            params.retention_bytes,
        );
        let purge = params.purge_backup_ids.clone().unwrap_or_default();
        let root = params.backup_root.clone();
        self.run_owned("library.gc", &root, &cancel, move |_| {
            encode(&store.gc(&purge).map_err(store_error)?)
        })
        .await
    }
}

fn store_error(error: StoreError) -> RemoteError {
    RemoteError::new(codes::INTERNAL, error.to_string())
}

fn encode(value: &impl serde::Serialize) -> Result<Value, RemoteError> {
    serde_json::to_value(value).map_err(|error| {
        RemoteError::new(
            codes::INTERNAL,
            format!("Cannot encode the result: {error}."),
        )
    })
}

fn parse_kind(kind: &str, method: &str) -> Result<ResourceKind, RemoteError> {
    ResourceKind::parse(kind).ok_or_else(|| {
        tool_argument(format!(
            "{method} names kind \"{kind}\"; expected \"file\" or \"directory\"."
        ))
    })
}

/// `decodeApplyOperations`: every payload decoded once however many
/// operations share it, and every missing reference refused before the
/// owner is taken — a malformed frame has no effects.
fn decode_apply_operations(params: &ApplyParams) -> Result<Vec<ApplyOperation>, RemoteError> {
    let mut decoded: HashMap<String, Arc<Vec<u8>>> = HashMap::new();
    let mut payload = |content_ref: &str, what: &str| -> Result<Arc<Vec<u8>>, RemoteError> {
        let Some(encoded) = params
            .contents
            .as_ref()
            .and_then(|contents| contents.get(content_ref))
        else {
            return Err(tool_argument(format!(
                "library.apply {what} names no content in this frame."
            )));
        };
        if let Some(bytes) = decoded.get(content_ref) {
            return Ok(Arc::clone(bytes));
        }
        let bytes = Arc::new(STANDARD.decode(encoded).map_err(|error| {
            tool_argument(format!(
                "library.apply {what} carries content that is not base64 ({error}); expected standard padded base64."
            ))
        })?);
        decoded.insert(content_ref.to_string(), Arc::clone(&bytes));
        Ok(bytes)
    };
    params
        .operations
        .iter()
        .map(|operation| {
            let kind = parse_kind(&operation.kind, "library.apply")?;
            let mut prepared = ApplyOperation {
                resource_key: operation.resource_key.clone(),
                location_id: operation.location_id.clone(),
                slug: operation.slug.clone(),
                operation: operation.operation.clone(),
                kind,
                expected_content_hash: operation.expected_content_hash.clone(),
                destination_root: operation.destination_root.clone(),
                directory: None,
                contents: None,
                adaptation: operation.adaptation.clone(),
            };
            if kind == ResourceKind::File {
                let Some(content_ref) = &operation.content_ref else {
                    return Err(tool_argument(format!(
                        "library.apply file operation \"{}\" names no content in this frame.",
                        operation.resource_key
                    )));
                };
                prepared.contents = Some(payload(
                    content_ref,
                    &format!("file operation \"{}\"", operation.resource_key),
                )?);
                return Ok(prepared);
            }
            if let Some(files) = &operation.files {
                let files = files
                    .iter()
                    .map(|file| {
                        Ok(TransferredFile {
                            relative_path: file.relative_path.clone(),
                            contents: payload(
                                &file.content_ref,
                                &format!(
                                    "directory operation \"{}\" file \"{}\"",
                                    operation.resource_key, file.relative_path
                                ),
                            )?,
                        })
                    })
                    .collect::<Result<Vec<_>, RemoteError>>()?;
                prepared.directory = Some(DirectorySource::Files(files));
                return Ok(prepared);
            }
            match &operation.source_dir {
                Some(source_dir) if !source_dir.is_empty() => {
                    prepared.directory = Some(DirectorySource::Path(source_dir.clone()));
                    Ok(prepared)
                }
                _ => Err(tool_argument(format!(
                    "library.apply directory operation \"{}\" requires sourceDir or files.",
                    operation.resource_key
                ))),
            }
        })
        .collect()
}

fn epoch_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

/// Registers the five write-lane methods on `registry`.
pub(crate) fn register(registry: Registry, service: Arc<MutationService>) -> Registry {
    let apply = Arc::clone(&service);
    let remove = Arc::clone(&service);
    let undo = Arc::clone(&service);
    let backups = Arc::clone(&service);
    registry
        .implement(
            "library.apply",
            move |params: ApplyParams, context: CallContext| {
                let service = Arc::clone(&apply);
                async move { service.apply(params, context.cancel().clone()).await }
            },
        )
        .implement(
            "library.remove",
            move |params: RemoveParams, context: CallContext| {
                let service = Arc::clone(&remove);
                async move { service.remove(params, context.cancel().clone()).await }
            },
        )
        .implement(
            "library.undo",
            move |params: UndoParams, context: CallContext| {
                let service = Arc::clone(&undo);
                async move { service.undo(params, context.cancel().clone()).await }
            },
        )
        .implement(
            "library.backups",
            move |params: StoreParams, context: CallContext| {
                let service = Arc::clone(&backups);
                async move { service.backups(params, context.cancel().clone()).await }
            },
        )
        .implement(
            "library.gc",
            move |params: StoreParams, context: CallContext| {
                let service = Arc::clone(&service);
                async move { service.gc(params, context.cancel().clone()).await }
            },
        )
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
