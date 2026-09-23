//! The five `library.*` read handlers and their registration — the read
//! half of `apps/runtime/src/services/library/service.ts`.
//!
//! Every handler re-reads consent before touching the filesystem (the
//! registry's guard already refused a denied call; this keeps a mid-call
//! consent change honest, as the filesystem methods do), resolves this
//! host's own [`PathEnv`] through the one seam
//! [`crate::probing::host::build_runtime_path_env`], and runs its blocking
//! work on the library's bounded workers.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use mango_protocol::error::{RemoteError, codes};
use mango_protocol::session::CallContext;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::cache::{LibraryCache, cancelled, check_cancelled};
use super::discovery::{LocationSettings, ScanDeps, resolve_scan_targets, scan_library};
use super::fs::{LibraryFs, NativeLibraryFs};
use super::read::{library_location_root, read_library_content};
use super::settings_sources::read_settings_sources;
use super::tree::{TreeError, read_library_tree};
use super::types::{ReadResult, ReadTreeResult, ScanResult};
use super::workers::run_library_blocking;
use crate::blocking::run_blocking;
use crate::consent::source::ConsentSource;
use crate::ports::authorization::consent_denial;
use crate::probing::detection::path_env::PathEnv;
use crate::probing::host::{RealLocationFsProbe, build_runtime_path_env};
use crate::probing::locations::{LOCATION_DEFINITIONS, describe_location};
use crate::registry::Registry;

/// `RuntimeLibraryPathEnvParams`: variables merged over this host's own
/// environment. `workspaceRoot` is accepted and unused — no registered
/// location is workspace-scoped yet, exactly as in TypeScript.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PathEnvParams {
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    #[allow(dead_code)]
    pub workspace_root: Option<String>,
}

/// `RuntimeLibraryScanParams`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanParams {
    pub location_settings: LocationSettings,
    #[serde(default)]
    pub force: Option<bool>,
    #[serde(default)]
    pub kinds: Option<Vec<String>>,
    #[serde(default)]
    pub location_path_overrides: Option<HashMap<String, String>>,
    #[serde(default)]
    pub path_env: Option<PathEnvParams>,
}

/// `RuntimeLibraryReadParams`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadParams {
    pub path: String,
    pub location_id: String,
    #[serde(default)]
    pub path_env: Option<PathEnvParams>,
    #[serde(default)]
    pub max_bytes: Option<f64>,
    #[serde(default)]
    pub truncate_oversize: Option<bool>,
}

/// `RuntimeLibraryReadTreeParams`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadTreeParams {
    pub path: String,
    pub location_id: String,
    #[serde(default)]
    pub path_env: Option<PathEnvParams>,
}

/// `RuntimeLibraryLocationsParams` and `RuntimeLibrarySettingsSourcesParams`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PathEnvOnlyParams {
    #[serde(default)]
    pub path_env: Option<PathEnvParams>,
}

/// Builds a [`PathEnv`] from the request's `pathEnv.env` overrides.
pub(crate) type PathEnvFactory =
    Arc<dyn Fn(Option<&HashMap<String, String>>) -> PathEnv + Send + Sync>;

/// The handlers' shared state; see the module docs.
pub(crate) struct LibraryService {
    pub consent: Arc<ConsentSource>,
    pub path_env: PathEnvFactory,
    pub scan: ScanDeps,
}

fn tool_argument(message: String) -> RemoteError {
    RemoteError::new(codes::INTERNAL, message).with_detail("kind", "tool_argument")
}

fn unresolved(location_id: &str) -> String {
    format!("Library location \"{location_id}\" does not resolve on this machine.")
}

/// Re-reads this slot's consent — a `runtime.json` read, so every caller
/// runs it on a blocking worker — and refuses `method` when a capability it
/// needs is no longer granted.
fn authorize(consent: &ConsentSource, method: &str) -> Result<(), RemoteError> {
    let allow = consent.refresh();
    let missing: Vec<String> = mangostudio_runtime_contract::catalog::capabilities_of(method)
        .expect("library handlers belong to the catalog")
        .iter()
        .filter(|capability| !allow.is_granted(capability))
        .cloned()
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    Err(consent_denial(method, &missing, consent.slot().as_str()))
}

impl LibraryService {
    /// The production service: this machine's filesystem, clock, stderr
    /// diagnostics, and the process-wide memo every session shares.
    pub(crate) fn native(consent: ConsentSource) -> Self {
        static CACHE: OnceLock<Arc<LibraryCache>> = OnceLock::new();
        let fs: Arc<dyn LibraryFs> = Arc::new(NativeLibraryFs);
        Self {
            consent: Arc::new(consent),
            path_env: Arc::new(build_runtime_path_env),
            scan: ScanDeps {
                cache: Arc::clone(CACHE.get_or_init(|| Arc::new(LibraryCache::default()))),
                fs,
                platform: crate::health::node_platform().to_string(),
                now_ms: Arc::new(epoch_ms),
                warn: Arc::new(|message: &str| eprintln!("{message}")),
            },
        }
    }

    fn env(&self, params: Option<&PathEnvParams>) -> PathEnv {
        (self.path_env)(params.and_then(|params| params.env.as_ref()))
    }

    /// `library.scan`.
    pub(crate) async fn scan(
        &self,
        params: ScanParams,
        cancel: CancellationToken,
    ) -> Result<ScanResult, RemoteError> {
        check_cancelled(&cancel)?;
        // The shared pool rather than a library permit: a consent re-read
        // must never queue behind other scans' walks.
        let consent = Arc::clone(&self.consent);
        run_blocking(move || authorize(&consent, "library.scan")).await?;
        let env = self.env(params.path_env.as_ref());
        let targets = resolve_scan_targets(
            &params.location_settings,
            &env,
            params.kinds.as_deref(),
            params.location_path_overrides.as_ref(),
        );
        scan_library(&self.scan, targets, params.force == Some(true), &cancel).await
    }

    /// `library.read`.
    pub(crate) async fn read(
        &self,
        params: ReadParams,
        cancel: CancellationToken,
    ) -> Result<ReadResult, RemoteError> {
        check_cancelled(&cancel)?;
        let env = self.env(params.path_env.as_ref());
        let consent = Arc::clone(&self.consent);
        run_library_blocking(move || {
            authorize(&consent, "library.read")?;
            let Some(root) = library_location_root(&params.location_id, &env) else {
                return Ok(ReadResult::denied(unresolved(&params.location_id)));
            };
            let truncate = params.truncate_oversize == Some(true);
            read_library_content(&params.path, &root, params.max_bytes, truncate)
                .map_err(|error| tool_argument(error.0))
        })
        .await
    }

    /// `library.read-tree`.
    pub(crate) async fn read_tree(
        &self,
        params: ReadTreeParams,
        cancel: CancellationToken,
    ) -> Result<ReadTreeResult, RemoteError> {
        check_cancelled(&cancel)?;
        let env = self.env(params.path_env.as_ref());
        let consent = Arc::clone(&self.consent);
        let fs = Arc::clone(&self.scan.fs);
        let platform = self.scan.platform.clone();
        let walk_cancel = cancel.clone();
        let outcome = run_library_blocking(move || {
            authorize(&consent, "library.read-tree").map_err(TreeError::Refused)?;
            let Some(root) = library_location_root(&params.location_id, &env) else {
                return Err(TreeError::Denied(unresolved(&params.location_id)));
            };
            read_library_tree(fs.as_ref(), &params.path, &root, &platform, &walk_cancel)
        })
        .await;
        match outcome {
            Ok(result) => {
                check_cancelled(&cancel)?;
                Ok(result)
            }
            Err(TreeError::Denied(reason)) => Ok(ReadTreeResult::denied(reason)),
            Err(TreeError::Cancelled) => Err(cancelled()),
            Err(TreeError::Failed(message)) => Err(RemoteError::new(codes::INTERNAL, message)),
            Err(TreeError::Refused(error)) => Err(error),
        }
    }

    /// `library.locations`: every registered location, described on this
    /// machine, in registry order.
    pub(crate) async fn locations(
        &self,
        params: PathEnvOnlyParams,
        cancel: CancellationToken,
    ) -> Result<Value, RemoteError> {
        check_cancelled(&cancel)?;
        let env = self.env(params.path_env.as_ref());
        let consent = Arc::clone(&self.consent);
        let locations = run_library_blocking(move || {
            authorize(&consent, "library.locations")?;
            Ok::<_, RemoteError>(
                LOCATION_DEFINITIONS
                    .iter()
                    .map(|location| describe_location(location, &env, &RealLocationFsProbe))
                    .collect::<Vec<_>>(),
            )
        })
        .await?;
        Ok(json!({ "locations": locations }))
    }

    /// `library.settings-sources`.
    pub(crate) async fn settings_sources(
        &self,
        params: PathEnvOnlyParams,
        cancel: CancellationToken,
    ) -> Result<Value, RemoteError> {
        check_cancelled(&cancel)?;
        let env = self.env(params.path_env.as_ref());
        let consent = Arc::clone(&self.consent);
        let sources = run_library_blocking(move || {
            authorize(&consent, "library.settings-sources")?;
            Ok::<_, RemoteError>(read_settings_sources(&env))
        })
        .await?;
        serde_json::to_value(sources).map_err(|error| {
            RemoteError::new(
                codes::INTERNAL,
                format!("Cannot encode settings sources: {error}."),
            )
        })
    }
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// Registers the five read methods this build implements. The other five
/// `library.*` methods stay unregistered, which keeps `features.library`
/// false (see `crate::library`'s module docs).
pub(crate) fn register(registry: Registry, consent: ConsentSource) -> Registry {
    register_service(registry, Arc::new(LibraryService::native(consent)))
}

pub(crate) fn register_service(registry: Registry, service: Arc<LibraryService>) -> Registry {
    let scan = Arc::clone(&service);
    let read = Arc::clone(&service);
    let tree = Arc::clone(&service);
    let locations = Arc::clone(&service);
    registry
        .implement(
            "library.scan",
            move |params: ScanParams, context: CallContext| {
                let service = Arc::clone(&scan);
                async move { service.scan(params, context.cancel().clone()).await }
            },
        )
        .implement(
            "library.read",
            move |params: ReadParams, context: CallContext| {
                let service = Arc::clone(&read);
                async move { service.read(params, context.cancel().clone()).await }
            },
        )
        .implement(
            "library.read-tree",
            move |params: ReadTreeParams, context: CallContext| {
                let service = Arc::clone(&tree);
                async move { service.read_tree(params, context.cancel().clone()).await }
            },
        )
        .implement(
            "library.locations",
            move |params: PathEnvOnlyParams, context: CallContext| {
                let service = Arc::clone(&locations);
                async move { service.locations(params, context.cancel().clone()).await }
            },
        )
        .implement(
            "library.settings-sources",
            move |params: PathEnvOnlyParams, context: CallContext| {
                let service = Arc::clone(&service);
                async move {
                    service
                        .settings_sources(params, context.cancel().clone())
                        .await
                }
            },
        )
}
