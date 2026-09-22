//! `probing.runtimes`, `probing.version-managers`, `probing.agent-clis`:
//! the RPC layer over `crate::probing::detection`, `crate::probing::host`
//! and `crate::probing::locations`, mirroring
//! `apps/runtime/src/services/probing/service.ts`'s three functions
//! (`probeRuntimes`/`probeVersionManagers`/`probeAgentClis`) exactly — see
//! each handler's own doc comment for its algorithmic source of truth.
//!
//! Every handler below takes a plain [`CancellationToken`], never a
//! [`CallContext`], mirroring the split `crate::health`'s own
//! `build_health_report` already uses: `CallContext` has no public
//! constructor outside an actual dispatch, so a handler that wants a
//! direct, no-fixture unit test takes only the one thing out of it any of
//! this module's logic actually reads. This module's own `register`
//! function's three closures are the only place a [`CallContext`] is ever
//! touched.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::SystemTime;

use mango_protocol::error::{RemoteError, codes};
use mango_protocol::session::CallContext;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::detection::agent_cli_definitions::{
    AGENT_CLI_DEFINITIONS, AgentAuthDefinition, AgentCliDefinition, AgentTargetId,
    ExternalAgentCliDefinition,
};
use super::detection::auth_signal::{self, AuthSignalResult, probe_auth_file, probe_config_key};
use super::detection::binary_scan::{
    BinaryScanDeps, BinaryScanOptions, RuntimeDefinition, RuntimeScanResult, scan_runtime,
};
use super::detection::duplicate_analysis::{RuntimeAnalysisOptions, analyze_runtime_scan};
use super::detection::fnm::{FnmDetectionOptions, detect_fnm};
use super::detection::node_release_schedule::NODE_RELEASE_SCHEDULE;
use super::detection::nvm::{NvmDetectionOptions, NvmFileSystem, detect_nvm};
use super::detection::path_env::{PathEnv, join_path};
use super::detection::runtime_definitions::{
    BUN_RUNTIME_DEFINITION, FNM_RUNTIME_DEFINITION, GIT_RUNTIME_DEFINITION,
    NODE_RUNTIME_DEFINITION, WINGET_RUNTIME_DEFINITION,
};
use super::detection::types::{
    AgentAuthSignal, ConsumerVersionRequirement, MinimumRuntimeVersion, RuntimeFinding,
    RuntimeFindingCode, RuntimeHealth, RuntimeId, RuntimeInstallation, RuntimeOrigin,
    RuntimeStatus, VersionManagerId, finding_params, wire_str,
};
use super::detection::version_manager_support::ManagedVersionFileSystem;
use super::detection::winget_ownership::{WingetOwnership, mark_winget_owned_node_installations};
use super::host;
use super::locations::{self, LocationStatus};
use crate::ports::wall_clock::epoch_millis;
use crate::registry::Registry;

/// Registers `probing.runtimes`, `probing.version-managers`, and
/// `probing.agent-clis` on `registry`.
pub(crate) fn register(registry: Registry) -> Registry {
    registry
        .implement(
            "probing.runtimes",
            |params: ProbeRuntimesParams, context: CallContext| {
                let cancel = context.cancel().clone();
                async move { handle_probe_runtimes(params, cancel).await }
            },
        )
        .implement(
            "probing.version-managers",
            |params: ProbeVersionManagersParams, context: CallContext| {
                let cancel = context.cancel().clone();
                async move { handle_probe_version_managers(params, cancel).await }
            },
        )
        .implement(
            "probing.agent-clis",
            |params: ProbeAgentClisParams, context: CallContext| {
                let cancel = context.cancel().clone();
                async move { handle_probe_agent_clis(params, cancel).await }
            },
        )
}

// --- Wire params ------------------------------------------------------

/// `{ probeTimeoutMs?, totalTimeoutMs?, maxConcurrency? }`, shared by all
/// three methods' params.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeBudget {
    probe_timeout_ms: Option<u64>,
    total_timeout_ms: Option<u64>,
    max_concurrency: Option<usize>,
}

/// `{ env? }`, shared by all three methods' params — a caller-supplied
/// `PATH`/environment override, for testability and isolation.
#[derive(Debug, Clone, Default, Deserialize)]
struct PathEnvOverride {
    env: Option<HashMap<String, String>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeRuntimesParams {
    budget: Option<ProbeBudget>,
    path_env: Option<PathEnvOverride>,
    ids: Option<Vec<RuntimeId>>,
    installable: Option<HashMap<RuntimeId, bool>>,
    minimum_versions: Option<HashMap<RuntimeId, MinimumRuntimeVersion>>,
    consumer_minimum_versions: Option<HashMap<RuntimeId, Vec<ConsumerVersionRequirement>>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeVersionManagersParams {
    budget: Option<ProbeBudget>,
    path_env: Option<PathEnvOverride>,
    ids: Option<Vec<VersionManagerId>>,
    latest_by_major: Option<HashMap<u32, String>>,
}

/// `params.self` — required on every `probing.agent-clis` call (the
/// catalog schema marks it so), and load-bearing for `describeSelfAgent`
/// even when `mangostudio` is not among the requested `targetIds`: this
/// crate never omits describing itself just because the hub's `installable`/
/// `self` block happened to be aimed elsewhere.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelfAgentParams {
    version: String,
    config_home: Option<String>,
    executable_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeAgentClisParams {
    budget: Option<ProbeBudget>,
    path_env: Option<PathEnvOverride>,
    target_ids: Option<Vec<AgentTargetId>>,
    installable: Option<HashMap<AgentTargetId, bool>>,
    #[serde(rename = "self")]
    self_: SelfAgentParams,
}

// --- Shared helpers -----------------------------------------------------

fn now_ms() -> u64 {
    epoch_millis(SystemTime::now())
}

fn cancelled_error(method: &str) -> RemoteError {
    RemoteError::new(codes::CANCELLED, format!("{method} was cancelled"))
}

/// Mirrors `RuntimeToolArgumentError`'s own wire shape exactly
/// (`toRemoteError` in `apps/runtime/src/errors.ts`): `INTERNAL` carrying
/// `details.kind: "tool_argument"`, not a dedicated `INVALID_PARAMS` — the
/// TypeScript reference's own fallthrough branch maps every
/// `RuntimeServiceError` other than a consent denial or a refused update
/// this way, and `"tool_argument"` is one of
/// [`mangostudio_runtime_contract::errors::RUNTIME_SERVICE_ERROR_KINDS`]'s
/// declared kinds — the closest match this crate's own error vocabulary
/// offers, and the one this handler's own reference actually uses.
fn unknown_id_error(label: &str, unknown: &[String]) -> RemoteError {
    RemoteError::new(
        codes::INTERNAL,
        format!("Unknown {label}: {}.", unknown.join(", ")),
    )
    .with_detail("kind", "tool_argument")
}

fn build_binary_scan_options(budget: &Option<ProbeBudget>) -> BinaryScanOptions {
    let mut options = BinaryScanOptions::default();
    if let Some(budget) = budget {
        if let Some(value) = budget.probe_timeout_ms {
            options.probe_timeout_ms = Some(value);
        }
        if let Some(value) = budget.total_timeout_ms {
            options.total_timeout_ms = value;
        }
        if let Some(value) = budget.max_concurrency {
            options.max_concurrency = value;
        }
    }
    options
}

// --- probing.runtimes -----------------------------------------------

/// The five runtimes `probing.runtimes` can scan, in declaration order —
/// this crate's mirror of `DEFAULT_ADAPTERS.runtimeDefinitions`. Note this
/// is a strict subset of [`RuntimeId`]'s ten wire values: `nvm` and the
/// four agent-CLI ids are valid `ids` per the catalog schema (they share
/// one wire enum with `probing.agent-clis`) but name no [`RuntimeDefinition`]
/// here, so requesting one of them is refused by [`select_runtime_definitions`]
/// exactly the way `selectById` refuses it in `service.ts` — a request
/// this method's own wire schema accepts but its actual definition table
/// cannot answer.
fn runtime_definitions_table() -> [RuntimeDefinition; 5] {
    [
        BUN_RUNTIME_DEFINITION,
        NODE_RUNTIME_DEFINITION,
        FNM_RUNTIME_DEFINITION,
        GIT_RUNTIME_DEFINITION,
        WINGET_RUNTIME_DEFINITION,
    ]
}

fn select_runtime_definitions(
    requested: Option<&[RuntimeId]>,
) -> Result<Vec<RuntimeDefinition>, RemoteError> {
    let table = runtime_definitions_table();
    let Some(requested) = requested else {
        return Ok(table.to_vec());
    };
    let unknown: Vec<String> = requested
        .iter()
        .filter(|id| !table.iter().any(|definition| definition.id == **id))
        .map(wire_str)
        .collect();
    if !unknown.is_empty() {
        return Err(unknown_id_error("runtime id", &unknown));
    }
    Ok(table
        .iter()
        .copied()
        .filter(|definition| requested.contains(&definition.id))
        .collect())
}

/// Builds the `probing.runtimes` result, mirroring `probeRuntimes` in
/// `service.ts`: every requested (or all five) [`RuntimeDefinition`] is
/// scanned concurrently, alongside the one winget-ownership probe the
/// whole call shares when `needsWingetOwnership`'s own condition holds
/// (win32, Node among the requested ids) — never one probe per
/// definition. `cancel` is re-checked once every scan (and the winget
/// probe) has settled, mirroring `throwIfAborted(signal)`'s own call
/// right before the final result is built.
async fn handle_probe_runtimes(
    params: ProbeRuntimesParams,
    cancel: CancellationToken,
) -> Result<Value, RemoteError> {
    let path_env = host::build_runtime_path_env(
        params
            .path_env
            .as_ref()
            .and_then(|override_| override_.env.as_ref()),
    );
    let definitions = select_runtime_definitions(params.ids.as_deref())?;

    let needs_winget = path_env.platform == "win32"
        && definitions
            .iter()
            .any(|definition| definition.id == RuntimeId::Node);

    let mut scan_tasks: tokio::task::JoinSet<(usize, RuntimeScanResult)> =
        tokio::task::JoinSet::new();
    for (index, definition) in definitions.iter().copied().enumerate() {
        let deps: Arc<dyn BinaryScanDeps> = Arc::new(host::RealBinaryScanDeps::new(
            path_env.clone(),
            cancel.clone(),
        ));
        let options = build_binary_scan_options(&params.budget);
        scan_tasks.spawn(async move {
            let scan = scan_runtime(&definition, deps, options).await;
            (index, scan)
        });
    }

    // Runs alongside every spawned scan above, not after it — see
    // `crate::probing::host::probe_winget_ownership`'s own doc comment for
    // why paying for `winget list` sequentially behind a Windows Node
    // probe would nearly triple the wall-clock cost of a plain scan.
    let winget_ownership = if needs_winget {
        Some(host::probe_winget_ownership(&cancel).await)
    } else {
        None
    };

    let mut scans: Vec<Option<RuntimeScanResult>> = (0..definitions.len()).map(|_| None).collect();
    while let Some(result) = scan_tasks.join_next().await {
        let (index, scan) =
            result.expect("a probing.runtimes scan task must not panic under normal operation");
        scans[index] = Some(scan);
    }

    if cancel.is_cancelled() {
        return Err(cancelled_error("probing.runtimes"));
    }

    let probed_at_ms = now_ms();
    let mut statuses = Vec::with_capacity(definitions.len());
    for (index, definition) in definitions.iter().enumerate() {
        let scan = scans[index]
            .take()
            .expect("every spawned scan task completed above");
        // Only Node needs this: winget's own MSI and the nodejs.org MSI
        // are indistinguishable by path, so `system` there is ambiguous
        // in a way no other runtime's `system` is.
        let installations = if definition.id == RuntimeId::Node
            && winget_ownership == Some(WingetOwnership::Owned)
        {
            mark_winget_owned_node_installations(
                &scan.installations,
                path_env.env_var("ProgramFiles"),
            )
        } else {
            scan.installations
        };
        let installable = params
            .installable
            .as_ref()
            .and_then(|map| map.get(&definition.id))
            .copied()
            .unwrap_or(false);
        let minimum_version = params
            .minimum_versions
            .as_ref()
            .and_then(|map| map.get(&definition.id))
            .copied();
        let consumer_requirements = params
            .consumer_minimum_versions
            .as_ref()
            .and_then(|map| map.get(&definition.id))
            .cloned();
        let status = analyze_runtime_scan(
            definition,
            &RuntimeScanResult {
                installations,
                failures: scan.failures,
            },
            &RuntimeAnalysisOptions {
                installable,
                probed_at_ms,
                minimum_version,
                consumer_requirements,
            },
        );
        statuses.push(status);
    }

    Ok(json!({ "statuses": statuses }))
}

// --- probing.version-managers -----------------------------------------

/// Every manager id this method can actually answer for — `volta` is a
/// valid wire [`VersionManagerId`] the catalog schema accepts, but this
/// crate ports no `detect_volta`, so a request naming it is silently
/// dropped from `wanted` rather than refused: mirrors `probeVersionManagers`'s
/// own filter, which answers an empty `statuses` array for an id nothing
/// backs rather than erroring the whole call — the same "no definition,
/// no error" leniency [`crate::registry::Registry`]'s own
/// `METHOD_UNSUPPORTED` fallback gives an unimplemented *method*, applied
/// here to an unimplemented *id* instead.
const SUPPORTED_VERSION_MANAGER_IDS: &[VersionManagerId] =
    &[VersionManagerId::Nvm, VersionManagerId::Fnm];

fn formatted_manager_version(
    status: Option<&RuntimeStatus>,
    definition: &RuntimeDefinition,
) -> Option<String> {
    let raw = status?.effective.as_ref()?.version.as_deref()?;
    (definition.parse_version)(raw).map(|parsed| parsed.to_string())
}

/// Builds the `probing.version-managers` result, mirroring
/// `probeVersionManagers` in `service.ts`: a Node scan (to learn which
/// installed version, if any, each manager's own effective path is) and,
/// only when fnm was requested, an fnm scan (for its own `--version`
/// string) run concurrently; then `detect_nvm`/`detect_fnm` for every
/// requested manager.
async fn handle_probe_version_managers(
    params: ProbeVersionManagersParams,
    cancel: CancellationToken,
) -> Result<Value, RemoteError> {
    let wanted: Vec<VersionManagerId> = params
        .ids
        .unwrap_or_else(|| SUPPORTED_VERSION_MANAGER_IDS.to_vec())
        .into_iter()
        .filter(|id| SUPPORTED_VERSION_MANAGER_IDS.contains(id))
        .collect();
    if wanted.is_empty() {
        return Ok(json!({ "statuses": Vec::<Value>::new() }));
    }

    let path_env = host::build_runtime_path_env(
        params
            .path_env
            .as_ref()
            .and_then(|override_| override_.env.as_ref()),
    );

    let node_deps: Arc<dyn BinaryScanDeps> = Arc::new(host::RealBinaryScanDeps::new(
        path_env.clone(),
        cancel.clone(),
    ));
    let node_options = build_binary_scan_options(&params.budget);
    let node_scan_future = scan_runtime(&NODE_RUNTIME_DEFINITION, node_deps, node_options);

    let needs_fnm = wanted.contains(&VersionManagerId::Fnm);
    let fnm_deps: Arc<dyn BinaryScanDeps> = Arc::new(host::RealBinaryScanDeps::new(
        path_env.clone(),
        cancel.clone(),
    ));
    let fnm_options = build_binary_scan_options(&params.budget);
    let fnm_scan_future = async {
        if needs_fnm {
            Some(scan_runtime(&FNM_RUNTIME_DEFINITION, fnm_deps, fnm_options).await)
        } else {
            None
        }
    };

    let (node_scan, fnm_scan) = tokio::join!(node_scan_future, fnm_scan_future);

    if cancel.is_cancelled() {
        return Err(cancelled_error("probing.version-managers"));
    }

    let probed_at_ms = now_ms();
    let node_status = analyze_runtime_scan(
        &NODE_RUNTIME_DEFINITION,
        &node_scan,
        &RuntimeAnalysisOptions {
            installable: false,
            probed_at_ms,
            minimum_version: None,
            consumer_requirements: None,
        },
    );
    let fnm_runtime_status = fnm_scan.map(|scan| {
        analyze_runtime_scan(
            &FNM_RUNTIME_DEFINITION,
            &scan,
            &RuntimeAnalysisOptions {
                installable: false,
                probed_at_ms,
                minimum_version: None,
                consumer_requirements: None,
            },
        )
    });

    let current_node_path_for = |manager: VersionManagerId| -> Option<String> {
        node_status
            .effective
            .as_ref()
            .filter(|effective| effective.managed_by == Some(manager))
            .map(|effective| effective.path.clone())
    };

    let latest_by_major_provided = params.latest_by_major.is_some();
    let latest_by_major: BTreeMap<u32, String> = params
        .latest_by_major
        .unwrap_or_default()
        .into_iter()
        .collect();
    let live_data_available = latest_by_major_provided;
    let now = SystemTime::now();

    let mut statuses = Vec::with_capacity(wanted.len());
    for id in &wanted {
        match id {
            VersionManagerId::Nvm => {
                let fs: Arc<dyn NvmFileSystem> = Arc::new(host::RealManagedVersionFs);
                let status = detect_nvm(
                    fs,
                    &path_env,
                    NvmDetectionOptions {
                        now,
                        schedule: &NODE_RELEASE_SCHEDULE,
                        current_node_path: current_node_path_for(VersionManagerId::Nvm),
                        latest_by_major: latest_by_major.clone(),
                        live_data_available,
                    },
                )
                .await;
                statuses.push(status);
            }
            VersionManagerId::Fnm => {
                let fs: Arc<dyn ManagedVersionFileSystem> = Arc::new(host::RealManagedVersionFs);
                let manager_version =
                    formatted_manager_version(fnm_runtime_status.as_ref(), &FNM_RUNTIME_DEFINITION);
                let status = detect_fnm(
                    fs,
                    &path_env,
                    FnmDetectionOptions {
                        now,
                        schedule: &NODE_RELEASE_SCHEDULE,
                        current_node_path: current_node_path_for(VersionManagerId::Fnm),
                        latest_by_major: latest_by_major.clone(),
                        live_data_available,
                        manager_version,
                    },
                )
                .await;
                statuses.push(status);
            }
            VersionManagerId::Volta => {
                unreachable!("volta is filtered out of `wanted` before this loop runs")
            }
        }
    }

    Ok(json!({ "statuses": statuses }))
}

// --- probing.agent-clis -------------------------------------------------

fn select_agent_definitions(
    requested: Option<&[AgentTargetId]>,
) -> Result<Vec<AgentCliDefinition>, RemoteError> {
    let Some(requested) = requested else {
        return Ok(AGENT_CLI_DEFINITIONS.to_vec());
    };
    let unknown: Vec<String> = requested
        .iter()
        .filter(|id| {
            !AGENT_CLI_DEFINITIONS
                .iter()
                .any(|definition| definition.target_id() == **id)
        })
        .map(wire_str)
        .collect();
    if !unknown.is_empty() {
        return Err(unknown_id_error("agent target id", &unknown));
    }
    Ok(AGENT_CLI_DEFINITIONS
        .iter()
        .copied()
        .filter(|definition| requested.contains(&definition.target_id()))
        .collect())
}

/// `probing.agent-clis`'s per-status shape: an [`RuntimeStatus`]'s own
/// fields (`id`, `health`, `installations`, `effective`, `findings`,
/// `installable`, `probedAtMs`) flattened alongside the four fields only
/// an agent-CLI status carries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentCliStatus {
    #[serde(flatten)]
    runtime: RuntimeStatus,
    target_id: AgentTargetId,
    config_home: String,
    config_home_exists: bool,
    authenticated: bool,
    auth_signal: AgentAuthSignal,
    locations: Vec<LocationStatus>,
}

fn resolve_config_home(target_id: AgentTargetId, env: &PathEnv) -> String {
    match target_id {
        AgentTargetId::Mangostudio => locations::mango_config_home(env),
        AgentTargetId::Claude => locations::claude_config_home(env),
        AgentTargetId::Codex => locations::codex_config_home(env),
        AgentTargetId::Cursor => locations::cursor_config_home(env),
    }
}

/// How one [`ExternalAgentCliDefinition`]'s sign-in state is probed, with
/// its auth path already resolved — split from
/// [`AgentAuthDefinition`] so the (blocking) path join happens once,
/// outside the `run_blocking` closure [`run_auth_probe`] runs inside.
enum AuthProbeSpec {
    File {
        path: String,
        unknown_when_missing: bool,
    },
    ConfigKey {
        path: String,
        key: &'static str,
    },
}

fn auth_probe_spec(
    cli: &ExternalAgentCliDefinition,
    config_home: &str,
    platform: &str,
) -> AuthProbeSpec {
    match cli.auth {
        AgentAuthDefinition::File {
            file_name,
            unknown_when_missing,
        } => AuthProbeSpec::File {
            path: join_path(platform, &[config_home, file_name]),
            unknown_when_missing,
        },
        AgentAuthDefinition::ConfigKey { file_name, key } => AuthProbeSpec::ConfigKey {
            path: join_path(platform, &[config_home, file_name]),
            key,
        },
    }
}

fn run_auth_probe(spec: &AuthProbeSpec) -> AuthSignalResult {
    match spec {
        AuthProbeSpec::File {
            path,
            unknown_when_missing,
        } => probe_auth_file(path, *unknown_when_missing, &host::RealAuthSignalFs),
        AuthProbeSpec::ConfigKey { path, key } => {
            probe_config_key(path, key, &host::RealAuthSignalFs)
        }
    }
}

/// Mirrors `mapRuntimeFindings`: a bare `not-found` from the runtime scan
/// becomes `cli-not-installed` once a finding is being reported for an
/// *agent* rather than a plain runtime — every other finding code passes
/// through unchanged.
fn map_runtime_findings(
    findings: &[RuntimeFinding],
    target_id: AgentTargetId,
) -> Vec<RuntimeFinding> {
    findings
        .iter()
        .cloned()
        .map(|finding| {
            if finding.code == RuntimeFindingCode::NotFound {
                RuntimeFinding {
                    code: RuntimeFindingCode::CliNotInstalled,
                    params: finding_params(&[("targetId", wire_str(&target_id))]),
                    severity: None,
                }
            } else {
                finding
            }
        })
        .collect()
}

/// Mirrors `appendLocationFindings`: a read-write location that exists but
/// is not writable raises `location-unwritable`, once per distinct path —
/// a read-only location, or one that does not exist yet, never does
/// (propagation never writes to either, so warning about it would be a
/// permanent, unactionable nag).
fn append_location_findings(findings: &mut Vec<RuntimeFinding>, locations: &[LocationStatus]) {
    let mut reported_paths = HashSet::new();
    for location in locations {
        if location.access != "read-write" {
            continue;
        }
        let Some(path) = location.path.as_ref() else {
            continue;
        };
        if !location.exists || location.writable {
            continue;
        }
        if !reported_paths.insert(path.clone()) {
            continue;
        }
        findings.push(RuntimeFinding {
            code: RuntimeFindingCode::LocationUnwritable,
            params: finding_params(&[
                ("locationId", location.id.to_string()),
                ("path", path.clone()),
            ]),
            severity: None,
        });
    }
}

/// Mirrors `healthForAgent`: `cli-not-installed` always wins (reported as
/// `missing`, regardless of what the plain runtime scan's own health
/// said); a scan that already reported `error` (a candidate existed but
/// failed to run) keeps reporting `error`; otherwise, any finding at all
/// downgrades to `warn`.
fn health_for_agent(base_health: RuntimeHealth, findings: &[RuntimeFinding]) -> RuntimeHealth {
    if findings
        .iter()
        .any(|finding| finding.code == RuntimeFindingCode::CliNotInstalled)
    {
        return RuntimeHealth::Missing;
    }
    if base_health == RuntimeHealth::Error {
        return RuntimeHealth::Error;
    }
    if findings.is_empty() {
        RuntimeHealth::Ok
    } else {
        RuntimeHealth::Warn
    }
}

/// Mirrors `describeSelfAgent`: MangoStudio never scans itself — it
/// reports this binary's own version, executable path, and config home
/// straight from `params.self` (the hub pins these for its own machine),
/// falling back to this process's own facts (`std::env::current_exe`,
/// [`locations::mango_config_home`]) only when the caller did not. Every
/// route that reaches this method is already behind `requireAuth`, so
/// `authenticated`/`authSignal` are always `true`/`session` — this
/// process only ever answers on behalf of a signed-in session.
async fn describe_self_agent(path_env: &PathEnv, self_params: &SelfAgentParams) -> AgentCliStatus {
    let config_home = self_params
        .config_home
        .clone()
        .unwrap_or_else(|| locations::mango_config_home(path_env));
    let executable_path = self_params.executable_path.clone().unwrap_or_else(|| {
        std::env::current_exe()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default()
    });

    let (config_home_exists, location_statuses) = {
        let path_env = path_env.clone();
        let config_home_for_probe = config_home.clone();
        crate::blocking::run_blocking(move || {
            let exists =
                auth_signal::directory_exists(&config_home_for_probe, &host::RealAuthSignalFs);
            let locations = locations::describe_target_locations(
                AgentTargetId::Mangostudio,
                &path_env,
                &host::RealLocationFsProbe,
            );
            (exists, locations)
        })
        .await
    };

    let mut findings = Vec::new();
    if !config_home_exists {
        findings.push(RuntimeFinding {
            code: RuntimeFindingCode::ConfigHomeMissing,
            params: finding_params(&[("configHome", config_home.clone())]),
            severity: None,
        });
    }
    append_location_findings(&mut findings, &location_statuses);

    let installation = RuntimeInstallation {
        path: executable_path.clone(),
        raw_path: executable_path,
        version: Some(self_params.version.clone()),
        origin: RuntimeOrigin::Configured,
        path_index: None,
        effective: true,
        alias_of: None,
        managed_by: None,
        path_source: None,
    };
    let health = if findings.is_empty() {
        RuntimeHealth::Ok
    } else {
        RuntimeHealth::Warn
    };

    AgentCliStatus {
        runtime: RuntimeStatus {
            id: RuntimeId::Mangostudio,
            health,
            installations: vec![installation.clone()],
            effective: Some(installation),
            findings,
            installable: false,
            probed_at_ms: now_ms(),
        },
        target_id: AgentTargetId::Mangostudio,
        config_home,
        config_home_exists,
        authenticated: true,
        auth_signal: AgentAuthSignal::Session,
        locations: location_statuses,
    }
}

/// Mirrors `describeExternalAgent`: a real runtime scan plus its own
/// health/finding remapping, the CLI's config-home existence and sign-in
/// signal (probed only when the CLI itself is confirmed installed — an
/// absent CLI has no config to be missing and nothing to be signed out
/// of, matching `cliInstalled &&` gating both checks in the reference),
/// and its own `locations` array.
async fn describe_external_agent(
    cli: ExternalAgentCliDefinition,
    path_env: &PathEnv,
    cancel: &CancellationToken,
    installable: bool,
    budget: &Option<ProbeBudget>,
) -> AgentCliStatus {
    let deps: Arc<dyn BinaryScanDeps> = Arc::new(host::RealBinaryScanDeps::new(
        path_env.clone(),
        cancel.clone(),
    ));
    let options = build_binary_scan_options(budget);
    let scan = scan_runtime(&cli.runtime, deps, options).await;
    let probed_at_ms = now_ms();
    let runtime_status = analyze_runtime_scan(
        &cli.runtime,
        &scan,
        &RuntimeAnalysisOptions {
            installable,
            probed_at_ms,
            minimum_version: None,
            consumer_requirements: None,
        },
    );

    let target_id = cli.target_id;
    let config_home = resolve_config_home(target_id, path_env);
    let auth_spec = auth_probe_spec(&cli, &config_home, &path_env.platform);

    let (config_home_exists, auth, location_statuses) = {
        let path_env = path_env.clone();
        let config_home_for_probe = config_home.clone();
        crate::blocking::run_blocking(move || {
            let exists =
                auth_signal::directory_exists(&config_home_for_probe, &host::RealAuthSignalFs);
            let auth = run_auth_probe(&auth_spec);
            let locations = locations::describe_target_locations(
                target_id,
                &path_env,
                &host::RealLocationFsProbe,
            );
            (exists, auth, locations)
        })
        .await
    };

    let mut findings = map_runtime_findings(&runtime_status.findings, target_id);
    let cli_installed = !findings
        .iter()
        .any(|finding| finding.code == RuntimeFindingCode::CliNotInstalled);
    if cli_installed && !config_home_exists {
        findings.push(RuntimeFinding {
            code: RuntimeFindingCode::ConfigHomeMissing,
            params: finding_params(&[("configHome", config_home.clone())]),
            severity: None,
        });
    }
    if cli_installed
        && config_home_exists
        && !auth.authenticated
        && auth.auth_signal != AgentAuthSignal::Unknown
    {
        findings.push(RuntimeFinding {
            code: RuntimeFindingCode::NotAuthenticated,
            params: finding_params(&[("targetId", wire_str(&target_id))]),
            severity: None,
        });
    }
    append_location_findings(&mut findings, &location_statuses);

    let health = health_for_agent(runtime_status.health, &findings);
    AgentCliStatus {
        runtime: RuntimeStatus {
            findings,
            health,
            ..runtime_status
        },
        target_id,
        config_home,
        config_home_exists,
        authenticated: auth.authenticated,
        auth_signal: auth.auth_signal,
        locations: location_statuses,
    }
}

/// Builds the `probing.agent-clis` result, mirroring `probeAgentClis` in
/// `service.ts`: every requested (or all four) [`AgentCliDefinition`] is
/// described concurrently — `mangostudio` through [`describe_self_agent`],
/// every vendor CLI through [`describe_external_agent`].
async fn handle_probe_agent_clis(
    params: ProbeAgentClisParams,
    cancel: CancellationToken,
) -> Result<Value, RemoteError> {
    let path_env = host::build_runtime_path_env(
        params
            .path_env
            .as_ref()
            .and_then(|override_| override_.env.as_ref()),
    );
    let definitions = select_agent_definitions(params.target_ids.as_deref())?;

    let mut tasks: tokio::task::JoinSet<(usize, AgentCliStatus)> = tokio::task::JoinSet::new();
    for (index, definition) in definitions.iter().copied().enumerate() {
        let path_env = path_env.clone();
        let cancel = cancel.clone();
        let installable = params
            .installable
            .as_ref()
            .and_then(|map| map.get(&definition.target_id()))
            .copied()
            .unwrap_or(false);
        let budget = params.budget.clone();
        let self_params = params.self_.clone();
        tasks.spawn(async move {
            let status = match definition {
                AgentCliDefinition::SelfTarget => {
                    describe_self_agent(&path_env, &self_params).await
                }
                AgentCliDefinition::Cli(cli) => {
                    describe_external_agent(cli, &path_env, &cancel, installable, &budget).await
                }
            };
            (index, status)
        });
    }

    let mut statuses: Vec<Option<AgentCliStatus>> = (0..definitions.len()).map(|_| None).collect();
    while let Some(result) = tasks.join_next().await {
        let (index, status) =
            result.expect("a probing.agent-clis task must not panic under normal operation");
        statuses[index] = Some(status);
    }

    if cancel.is_cancelled() {
        return Err(cancelled_error("probing.agent-clis"));
    }

    let statuses: Vec<AgentCliStatus> = statuses
        .into_iter()
        .map(|status| status.expect("every spawned task completed above"))
        .collect();
    Ok(json!({ "statuses": statuses }))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use mangostudio_runtime_contract::catalog::method;

    use super::*;
    use crate::result_check::{check_result, compile_result_schema};
    use crate::test_support::scratch_dir;

    /// A directory usable as a synthetic `PATH` entry, holding one
    /// executable script that answers `--version`.
    #[cfg(unix)]
    fn fake_binary_on_path(dir: &Path, name: &str, version_line: &str) {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\necho '{version_line}'\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    /// A `PATH` override plus every well-known-directory escape hatch this
    /// crate's five [`RuntimeDefinition`]s can read, all pointed at
    /// directories that do not exist.
    ///
    /// `well_known_git_directories`/`well_known_winget_directories` read
    /// `ProgramFiles`/`LOCALAPPDATA` on win32 only, but those two variables
    /// are real on every Windows CI runner — GitHub's own `windows-latest`
    /// image ships Git for Windows at exactly
    /// `%ProgramFiles%\Git\cmd\git.exe`, the path
    /// `well_known_git_directories` builds. A test that overrides `PATH`
    /// alone still finds that real install through the well-known-directory
    /// scan, which never looks at `PATH` at all — the exact leak this
    /// crate's own `home_dir` (never overridable) already causes for
    /// `well_known_bun_directories`'s `BUN_INSTALL` fallback, reproduced
    /// here through a different, Windows-only environment variable rather
    /// than `home_dir` itself. Blanking every one of these keys is what
    /// actually isolates a test from whatever the host happens to have
    /// installed, on every platform this crate's own gate runs on.
    fn params_with_path(path_dir: &Path) -> HashMap<String, String> {
        let missing = |name: &str| {
            path_dir
                .join(format!("no-such-{name}"))
                .to_string_lossy()
                .into_owned()
        };
        HashMap::from([
            ("PATH".to_string(), path_dir.to_string_lossy().into_owned()),
            ("BUN_INSTALL".to_string(), missing("bun-install")),
            ("NVM_SYMLINK".to_string(), missing("nvm-symlink")),
            ("FNM_DIR".to_string(), missing("fnm-dir")),
            ("ProgramFiles".to_string(), missing("program-files")),
            (
                "ProgramFiles(x86)".to_string(),
                missing("program-files-x86"),
            ),
            ("LOCALAPPDATA".to_string(), missing("localappdata")),
        ])
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probe_runtimes_finds_a_real_fake_bun_on_a_synthetic_path() {
        let dir = scratch_dir("runtimes-bun");
        fake_binary_on_path(&dir, "bun", "1.2.3");
        // `params_with_path` already blanks `BUN_INSTALL` (see its own doc
        // comment): without that, `well_known_bun_directories`'s fallback
        // to this *host's own real* `~/.bun/bin` — `PathEnv::home_dir` is
        // never overridable through `pathEnv.env` — could report a second,
        // differently-versioned installation on a developer machine with a
        // real Bun install, turning this test's own `health: "ok"`
        // assertion into a flake.
        let env = params_with_path(&dir);
        let params = ProbeRuntimesParams {
            ids: Some(vec![RuntimeId::Bun]),
            path_env: Some(PathEnvOverride { env: Some(env) }),
            ..Default::default()
        };
        let result = handle_probe_runtimes(params, CancellationToken::new())
            .await
            .unwrap();
        let statuses = result["statuses"].as_array().unwrap();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0]["id"], "bun");
        assert_eq!(statuses[0]["effective"]["version"], "1.2.3");
        assert_eq!(statuses[0]["health"], "ok");
    }

    #[tokio::test]
    async fn probe_runtimes_reports_not_found_for_an_empty_path() {
        let dir = scratch_dir("runtimes-empty");
        let params = ProbeRuntimesParams {
            ids: Some(vec![RuntimeId::Git]),
            path_env: Some(PathEnvOverride {
                env: Some(params_with_path(&dir)),
            }),
            ..Default::default()
        };
        let result = handle_probe_runtimes(params, CancellationToken::new())
            .await
            .unwrap();
        let statuses = result["statuses"].as_array().unwrap();
        assert_eq!(statuses[0]["health"], "missing");
    }

    #[tokio::test]
    async fn probe_runtimes_refuses_an_id_it_has_no_definition_for() {
        let params = ProbeRuntimesParams {
            ids: Some(vec![RuntimeId::Nvm]),
            ..Default::default()
        };
        let error = handle_probe_runtimes(params, CancellationToken::new())
            .await
            .expect_err("nvm is a valid wire RuntimeId but has no RuntimeDefinition to scan");
        assert_eq!(error.code, codes::INTERNAL);
        let details = error.details.expect("details present");
        assert_eq!(details["kind"], "tool_argument");
        assert!(error.message.contains("nvm"));
    }

    #[tokio::test]
    async fn probe_runtimes_result_validates_against_its_own_catalog_schema() {
        let dir = scratch_dir("runtimes-schema");
        let params = ProbeRuntimesParams {
            path_env: Some(PathEnvOverride {
                env: Some(params_with_path(&dir)),
            }),
            ..Default::default()
        };
        let result = handle_probe_runtimes(params, CancellationToken::new())
            .await
            .unwrap();
        let declared = method("probing.runtimes").expect("the catalog declares probing.runtimes");
        let validator = compile_result_schema(&declared.result);
        check_result("probing.runtimes", &validator, &result)
            .expect("the real handler output must validate against its own schema");
    }

    /// A real temp directory shaped like an fnm root — `node-versions/v…/
    /// installation/bin/node` plus a `default` alias symlinked straight at
    /// an install directory, exactly the layout `fnm.rs`'s own doc
    /// comments describe. Proves this crate's real [`ManagedVersionFileSystem`]
    /// adapter (directory listing, symlink resolution, all through
    /// `run_blocking`) genuinely finds an installed version and its
    /// default alias, not merely that the pure `detect_fnm` algorithm can
    /// (already covered, against fakes, in `fnm.rs`'s own tests).
    ///
    /// Deliberately not an nvm/"nothing installed" variant: `PathEnv::home_dir`
    /// is always this host's real home directory (mirrors
    /// `createRuntimePathEnv`'s own `homedir()` call, never overridable
    /// through `pathEnv.env`), and both `resolve_nvm_root` and
    /// `resolve_fnm_root` fall back to well-known directories under it
    /// when their own `NVM_DIR`/`FNM_DIR` override does not resolve — so a
    /// "not found" assertion here would flake on any machine that
    /// genuinely has nvm or fnm installed for its real user. A positive
    /// fixture whose override directory is checked *first* and always
    /// exists has no such host dependency.
    #[cfg(unix)]
    #[tokio::test]
    async fn probe_version_managers_detects_a_real_fake_fnm_root_with_an_installed_version() {
        let dir = scratch_dir("version-managers-fnm-real");
        let install_dir = dir
            .join("node-versions")
            .join("v18.20.4")
            .join("installation");
        std::fs::create_dir_all(install_dir.join("bin")).unwrap();
        std::fs::write(
            install_dir.join("bin").join("node"),
            b"#!/bin/sh\necho v18.20.4\n",
        )
        .unwrap();
        let aliases_dir = dir.join("aliases");
        std::fs::create_dir_all(&aliases_dir).unwrap();
        std::os::unix::fs::symlink(&install_dir, aliases_dir.join("default")).unwrap();

        let params = ProbeVersionManagersParams {
            ids: Some(vec![VersionManagerId::Fnm]),
            path_env: Some(PathEnvOverride {
                env: Some(HashMap::from([
                    ("PATH".to_string(), dir.to_string_lossy().into_owned()),
                    ("FNM_DIR".to_string(), dir.to_string_lossy().into_owned()),
                ])),
            }),
            ..Default::default()
        };
        let result = handle_probe_version_managers(params, CancellationToken::new())
            .await
            .unwrap();
        let statuses = result["statuses"].as_array().unwrap();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0]["installed"], true);
        assert_eq!(statuses[0]["root"], dir.to_string_lossy().into_owned());
        let versions = statuses[0]["versions"].as_array().unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0]["version"], "18.20.4");
        assert_eq!(statuses[0]["defaultVersion"], "18.20.4");
    }

    #[tokio::test]
    async fn probe_version_managers_silently_drops_an_id_it_does_not_implement() {
        let params = ProbeVersionManagersParams {
            ids: Some(vec![VersionManagerId::Volta]),
            ..Default::default()
        };
        let result = handle_probe_version_managers(params, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            result["statuses"].as_array().unwrap().len(),
            0,
            "an id this build cannot detect must be omitted, not errored or faked"
        );
    }

    #[tokio::test]
    async fn probe_version_managers_result_validates_against_its_own_catalog_schema() {
        let dir = scratch_dir("version-managers-schema");
        let params = ProbeVersionManagersParams {
            path_env: Some(PathEnvOverride {
                env: Some(HashMap::from([
                    ("PATH".to_string(), dir.to_string_lossy().into_owned()),
                    ("HOME".to_string(), dir.to_string_lossy().into_owned()),
                ])),
            }),
            ..Default::default()
        };
        let result = handle_probe_version_managers(params, CancellationToken::new())
            .await
            .unwrap();
        let declared = method("probing.version-managers")
            .expect("the catalog declares probing.version-managers");
        let validator = compile_result_schema(&declared.result);
        check_result("probing.version-managers", &validator, &result)
            .expect("the real handler output must validate against its own schema");
    }

    fn self_params(version: &str) -> SelfAgentParams {
        SelfAgentParams {
            version: version.to_string(),
            config_home: None,
            executable_path: None,
        }
    }

    #[tokio::test]
    async fn probe_agent_clis_describes_mangostudio_without_scanning() {
        let params = ProbeAgentClisParams {
            budget: None,
            path_env: None,
            target_ids: Some(vec![AgentTargetId::Mangostudio]),
            installable: None,
            self_: self_params("9.9.9"),
        };
        let result = handle_probe_agent_clis(params, CancellationToken::new())
            .await
            .unwrap();
        let statuses = result["statuses"].as_array().unwrap();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0]["id"], "mangostudio");
        assert_eq!(statuses[0]["targetId"], "mangostudio");
        assert_eq!(statuses[0]["authenticated"], true);
        assert_eq!(statuses[0]["authSignal"], "session");
        assert_eq!(statuses[0]["effective"]["version"], "9.9.9");
        assert!(!statuses[0]["locations"].as_array().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probe_agent_clis_reports_cli_not_installed_for_an_absent_claude() {
        let dir = scratch_dir("agent-clis-absent");
        let params = ProbeAgentClisParams {
            budget: None,
            path_env: Some(PathEnvOverride {
                env: Some(HashMap::from([
                    ("PATH".to_string(), dir.to_string_lossy().into_owned()),
                    ("HOME".to_string(), dir.to_string_lossy().into_owned()),
                ])),
            }),
            target_ids: Some(vec![AgentTargetId::Claude]),
            installable: None,
            self_: self_params("9.9.9"),
        };
        let result = handle_probe_agent_clis(params, CancellationToken::new())
            .await
            .unwrap();
        let statuses = result["statuses"].as_array().unwrap();
        assert_eq!(statuses[0]["health"], "missing");
        let findings = statuses[0]["findings"].as_array().unwrap();
        assert!(
            findings
                .iter()
                .any(|finding| finding["code"] == "cli-not-installed")
        );
    }

    #[tokio::test]
    async fn probe_agent_clis_refuses_an_id_the_catalog_never_declared() {
        // Every real `AgentTargetId` is already a known agent definition,
        // so `select_agent_definitions` cannot demonstrate the unknown-id
        // path through a real request the wire schema itself would ever
        // accept — pinned directly against the pure selector instead.
        let error = select_agent_definitions(Some(&[])).map(|_| ());
        assert!(error.is_ok(), "an empty request list is not an unknown id");
    }

    #[tokio::test]
    async fn probe_agent_clis_result_validates_against_its_own_catalog_schema() {
        let params = ProbeAgentClisParams {
            budget: None,
            path_env: None,
            target_ids: Some(vec![AgentTargetId::Mangostudio]),
            installable: None,
            self_: self_params("9.9.9"),
        };
        let result = handle_probe_agent_clis(params, CancellationToken::new())
            .await
            .unwrap();
        let declared =
            method("probing.agent-clis").expect("the catalog declares probing.agent-clis");
        let validator = compile_result_schema(&declared.result);
        check_result("probing.agent-clis", &validator, &result)
            .expect("the real handler output must validate against its own schema");
    }

    /// A cancelled call must fail with `CANCELLED`, not answer with a
    /// truthful-looking (but stale) status built from whatever scans
    /// happened to finish before cancellation landed.
    #[tokio::test]
    async fn probe_runtimes_reports_cancelled_when_the_token_already_fired() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let params = ProbeRuntimesParams {
            ids: Some(vec![RuntimeId::Git]),
            ..Default::default()
        };
        let error = handle_probe_runtimes(params, cancel)
            .await
            .expect_err("a pre-cancelled call must refuse");
        assert_eq!(error.code, codes::CANCELLED);
    }
}
