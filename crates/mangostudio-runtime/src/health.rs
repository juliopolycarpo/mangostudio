//! `runtime.health`: one machine truth, mirroring
//! `apps/runtime/src/health.ts`'s `collectRuntimeHealth` — narrowed on
//! purpose. See this module's own doc comments for exactly what is built
//! and what is skipped, and why.
//!
//! # Scope cut from the TypeScript report
//!
//! Built: `schemaVersion`, `slot`, `version`, `digest`, `sourceSha`,
//! `profile`, `allow`, `setup`, `audit` (from [`crate::consent::config`]),
//! `source`, `binaryPath`, `runtimeVersion`, `platform`, `arch`, `homeDir`,
//! `shells`, `git`, `gh`, `terminal`, `lastError`, and, on a host that serves
//! external agents, `externalAgents` (added by `register` from the
//! supervisor, with the attestation omitted when the hub withdrew it).
//!
//! Deliberately skipped, optional on the wire:
//! - `auditError` — this crate has no "read the audit log's last write
//!   error" port yet, and building one is out of scope for this change.
//!
//! # Two deliberate divergences from the TypeScript report
//!
//! - **`source` never reports `"source-checkout"`.** The TypeScript value
//!   existed because `apps/runtime` could run either as a compiled binary or
//!   as a workspace entry executed through `bun run` — detected by
//!   checking whether the running executable's own basename is `bun`. This
//!   crate is always a compiled binary; there is no "run from source
//!   without compiling" mode for it to detect. `resolve_source` answers
//!   `"provisioned"` when [`crate::runtime_home::slot_for_path`] places the
//!   current executable inside a slot directory, `"bundled"` otherwise.
//! - **`platform`/`arch` are mapped to Node's own naming**, not Rust's:
//!   this field has always meant `process.platform`/`process.arch` on the
//!   wire, and a hub or UI reading it should not have to special-case which
//!   language produced the report. `node_platform` and `node_arch` do
//!   that mapping; anything neither table recognises passes through
//!   unchanged, noted at each call site.

use std::path::{Path, PathBuf};

use mango_protocol::error::{RemoteError, codes};
use mango_protocol::session::CallContext;
use mangostudio_runtime_contract::manifest::{
    GitAvailability, ManifestProfile, PathStyle, RuntimeCapabilityAllow, RuntimeCapabilityManifest,
    RuntimeShellKind,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::blocking::run_blocking;
use crate::consent::config::{ResolvedRuntimeSlotConfig, resolve_runtime_slot_config};
use crate::consent::presets::consent_preset;
use crate::diagnostics::{DiagnosticSink, StderrDiagnostics, diagnostic_line};
use mangostudio_runtime_core::executable_path::{shell_path_candidates, which_in};

use crate::file_identity::fingerprint;
use crate::probe_cache::ProbeCache;
use crate::registry::Registry;
use crate::runtime_home::{
    RuntimeSlot, SlotFileState, home_dir, read_runtime_slot_config, slot_for_path,
};
use crate::subprocess::{ChildBudget, ChildRunError, run_bounded_child};

/// Bound on the `git --version` probe. Matches `apps/runtime/src/manifest.ts`'s
/// `VERSION_PROBE_TIMEOUT_MS`: a `--version` that cannot answer in two
/// seconds is not a git this machine can use.
const GIT_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Registers `runtime.health` on `registry`.
///
/// Threaded through [`crate::transport::build_host_with_restart`] rather than built
/// there directly, so this module owns every fact its own handler needs —
/// `slot`, `mango_home`, and the running `runtime_version` — behind one
/// seam this crate's three transports all share identically.
pub(crate) fn register(
    registry: Registry,
    slot: RuntimeSlot,
    mango_home: PathBuf,
    runtime_version: String,
    external_agents: Option<std::sync::Arc<crate::external_agents::supervisor::Supervisor>>,
) -> Registry {
    registry.implement(
        "runtime.health",
        move |_params: Value, context: CallContext| {
            let mango_home = mango_home.clone();
            let runtime_version = runtime_version.clone();
            let external_agents = external_agents.clone();
            async move {
                let mut report = build_health_report(
                    slot,
                    &mango_home,
                    &runtime_version,
                    context.cancel(),
                    None,
                )
                .await?;
                if let Some(supervisor) = external_agents {
                    let withdrawn = crate::external_agents::hub_withdrew_isolation(
                        &context.remote().capabilities,
                    );
                    report["externalAgents"] = supervisor.health(withdrawn).await;
                }
                Ok(report)
            }
        },
    )
}

/// Builds the `runtime.health` result for `slot`, racing the `git` probe
/// against `cancel`.
///
/// `path_override` stands in for `PATH` in tests only; production callers
/// always pass `None`, which reads the real environment.
pub(crate) async fn build_health_report(
    slot: RuntimeSlot,
    mango_home: &Path,
    runtime_version: &str,
    cancel: &CancellationToken,
    path_override: Option<&std::ffi::OsStr>,
) -> Result<Value, RemoteError> {
    let CapabilitySnapshot {
        state,
        fallback_source,
        resolved,
        shells,
        git: git_probe,
        gh: gh_probe,
    } = collect_capability_snapshot(
        slot,
        mango_home,
        path_override,
        GhProbeTiming::Await,
        cancel,
    )
    .await;
    let gh = gh_probe.map_err(|_| {
        RemoteError::new(
            codes::CANCELLED,
            "runtime.health was cancelled while probing gh",
        )
    })?;
    let git = match git_probe {
        Ok(availability) => availability,
        Err(GitProbeCancelled) => {
            return Err(RemoteError::new(
                codes::CANCELLED,
                "runtime.health was cancelled while probing git",
            ));
        }
    };

    let binary_path = std::env::current_exe()
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
        .or_else(|| resolved.binary_path.clone());

    let resolved_home_dir = home_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let terminal = resolved.allow.shell && !shells.is_empty() && cfg!(any(unix, windows));

    let mut report = json!({
        "schemaVersion": resolved.schema_version,
        "slot": resolved.slot,
        // The live executable's own source, never `resolved.source` (a
        // stored label from whenever `runtime.json` was last written) —
        // mirrors `collectRuntimeHealth`'s own `resolveRuntimeSource(env)`
        // call, which independently recomputes this rather than trusting
        // `config.source`. A binary replaced out from under a stale config
        // must describe itself, not the install that is no longer running.
        "source": fallback_source,
        "runtimeVersion": runtime_version,
        "version": resolved.version,
        "binaryPath": binary_path,
        "digest": resolved.digest,
        "sourceSha": resolved.source_sha,
        "profile": resolved.profile,
        "allow": resolved.allow,
        "setup": resolved.setup,
        "platform": node_platform(),
        "arch": node_arch(),
        "homeDir": resolved_home_dir,
        "shells": shells,
        "git": git,
        "gh": gh,
        "terminal": terminal,
        "audit": resolved.audit,
        "lastError": state.error.as_ref().map(ToString::to_string),
    });
    if let Some(platform_id) =
        release_platform_id(node_platform(), node_arch(), cfg!(target_env = "musl"))
    {
        report["platformId"] = json!(platform_id);
    }
    Ok(report)
}

/// Identifies the release binary built for this process's exact target.
/// Rust's target environment distinguishes Linux musl from glibc without
/// probing the host, and unknown OS/architecture combinations stay absent.
fn release_platform_id(platform: &str, arch: &str, musl: bool) -> Option<&'static str> {
    match (platform, arch, musl) {
        ("linux", "x64", false) => Some("linux-x64"),
        ("linux", "arm64", false) => Some("linux-arm64"),
        ("linux", "x64", true) => Some("linux-x64-musl"),
        ("linux", "arm64", true) => Some("linux-arm64-musl"),
        ("darwin", "x64", _) => Some("darwin-x64"),
        ("darwin", "arm64", _) => Some("darwin-arm64"),
        ("win32", "x64", _) => Some("windows-x64"),
        ("win32", "arm64", _) => Some("windows-arm64"),
        _ => None,
    }
}

/// Builds this session's `hello.capabilities`, from the exact platform,
/// shell, and git facts [`build_health_report`] itself reports for `slot` —
/// gated the same way, plus [`crate::manifest::build_features`]'s
/// implementation-aware narrowing on top of what the owner granted.
///
/// Called once per connection, before `hello` is sent — never per-request,
/// the way `runtime.health` is. A caller with no request-scoped
/// cancellation of its own (every transport's connection setup, which has
/// no in-flight RPC to cancel this against) passes a token that never
/// fires; [`GIT_PROBE_TIMEOUT`] still bounds the probe itself.
///
/// `gh` is the exception: `hello` answers it from the `PATH` walk and does
/// not wait for `gh --version` (see [`gh_without_waiting`]).
pub(crate) async fn build_capability_manifest(
    slot: RuntimeSlot,
    mango_home: &Path,
    registry: &Registry,
    cancel: &CancellationToken,
) -> RuntimeCapabilityManifest {
    // Exhaustive on purpose: a probe added to `CapabilitySnapshot` must be
    // either gated into the manifest here or consciously ignored, not silently
    // dropped by a `..` the way `build_health_report` could never drop it.
    let CapabilitySnapshot {
        state: _,
        fallback_source: _,
        resolved,
        shells,
        git: git_probe,
        gh: gh_probe,
    } = collect_capability_snapshot(slot, mango_home, None, GhProbeTiming::Background, cancel)
        .await;
    let git = git_probe.unwrap_or_else(|GitProbeCancelled| unavailable_git());

    // Mirrors `build_health_report`'s own `unwrap_or_default()`: a `HOME`
    // this process cannot resolve is already reported as an empty
    // `homeDir` by `runtime.health` today, and this reuses that same
    // fallback rather than inventing a second, stricter behaviour for the
    // identical fact reached through a different call site.
    let home_dir_value = home_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let platform = node_platform();
    let path_style = if platform == "win32" {
        PathStyle::Win32
    } else {
        PathStyle::Posix
    };
    let allow = wire_allow(resolved.allow);

    let mut manifest = RuntimeCapabilityManifest::new(
        platform,
        node_arch(),
        path_style,
        home_dir_value,
        shells,
        git.clone(),
    );
    manifest.features = crate::manifest::build_features(registry, &allow, git.available);
    if cfg!(windows) {
        manifest.publishes_windows_slot = Some(true);
    }
    // `terminal::register` installs these methods together with the consent watcher. Its
    // close handler remains callable after shell consent is revoked. Attest that invariant
    // independently of current consent or shell discovery, which can change after hello.
    let terminal_implementation = cfg!(any(unix, windows))
        && crate::terminal::TERMINAL_METHODS.iter().all(|method| {
            registry.classify(method) == crate::registry::Classification::Implemented
        });
    manifest.terminal_close_after_revocation = terminal_implementation.then_some(true);
    manifest.terminal_login_argv = terminal_implementation.then_some(true);
    manifest.terminal = Some(allow.shell && !manifest.shells.is_empty() && terminal_implementation);
    manifest.gh = Some(gh_probe.unwrap_or_else(|_| unavailable_git()));
    manifest.profile = Some(resolved.profile);
    manifest.allow = Some(allow);
    // What this build implements, independent of the consent read above.
    manifest.implementation = Some(crate::discovery::discovery_of(registry).implementation());
    manifest.enforces_path_policy = Some(true);
    // Said outright, never left to the hub's "absent means v2" default: that
    // default is pinned to the domain that shipped before this field, not to
    // whatever this binary hashes with.
    manifest.directory_hash_domain = Some(crate::library::DIRECTORY_HASH_DOMAIN_VERSION);
    // Sent before the peer's hello, so a hub withdrawal cannot shape it; the
    // hub strips a withdrawn attestation on its side (`applyHubIsolationClaim`).
    manifest.identity_isolation =
        run_blocking(crate::external_agents::isolation::detect_external_agent_isolation).await;
    manifest
}

/// Everything `runtime.health` and `hello.capabilities` both derive from:
/// `slot`'s stored config (resolved fail-closed) and the shell, git, and gh
/// probes it gates. Each probe keeps its own outcome so the two callers can
/// apply their different cancellation policies.
struct CapabilitySnapshot {
    state: SlotFileState,
    fallback_source: &'static str,
    resolved: ResolvedRuntimeSlotConfig,
    shells: Vec<RuntimeShellKind>,
    git: Result<GitAvailability, GitProbeCancelled>,
    gh: Result<GitAvailability, GitProbeCancelled>,
}

/// Reads and resolves `slot`'s config, then runs every probe it allows
/// concurrently — the shared setup of [`build_health_report`] and
/// [`build_capability_manifest`].
///
/// # Example
///
/// ```ignore
/// let snapshot = collect_capability_snapshot(slot, &mango_home, None, &cancel).await;
/// let git = snapshot.git.unwrap_or_else(|GitProbeCancelled| unavailable_git());
/// ```
async fn collect_capability_snapshot(
    slot: RuntimeSlot,
    mango_home: &Path,
    path_override: Option<&std::ffi::OsStr>,
    gh_timing: GhProbeTiming,
    cancel: &CancellationToken,
) -> CapabilitySnapshot {
    let (state, fallback_source) = read_slot_state_and_source(slot, mango_home).await;
    let resolved = resolve_slot_config_fail_closed(slot, &state, fallback_source);
    let gh = async {
        match gh_timing {
            GhProbeTiming::Await => probe_gh(resolved.allow.git, path_override, cancel).await,
            GhProbeTiming::Background => {
                Ok(gh_without_waiting(resolved.allow.git, path_override).await)
            }
        }
    };
    let ((shells, git), gh) = tokio::join!(
        collect_capability_probes(
            resolved.allow.shell,
            resolved.allow.git,
            path_override,
            cancel
        ),
        gh,
    );
    CapabilitySnapshot {
        state,
        fallback_source,
        resolved,
        shells,
        git,
        gh,
    }
}

/// Collects the independent shell and git machine facts behind one shared
/// seam for both `runtime.health` and `hello.capabilities`.
///
/// When both capabilities are granted their probes start together: both walk
/// the same potentially slow `PATH`, but neither result depends on the
/// other. Their outcomes remain separate so `runtime.health` can report a
/// cancelled git child as `CANCELLED` while `hello.capabilities` retains its
/// established degraded-git answer.
async fn collect_capability_probes(
    allow_shell: bool,
    allow_git: bool,
    path_override: Option<&std::ffi::OsStr>,
    cancel: &CancellationToken,
) -> (
    Vec<RuntimeShellKind>,
    Result<GitAvailability, GitProbeCancelled>,
) {
    let shells = async {
        if allow_shell {
            detect_shells(path_override).await
        } else {
            Vec::new()
        }
    };
    let git = async {
        if allow_git {
            probe_git(path_override, cancel).await
        } else {
            Ok(unavailable_git())
        }
    };
    run_independent_probes(shells, git).await
}

/// Runs two independent probe futures concurrently, keeping each result so
/// callers can preserve their distinct cancellation policies.
async fn run_independent_probes<S, G>(
    shell_probe: S,
    git_probe: G,
) -> (
    Vec<RuntimeShellKind>,
    Result<GitAvailability, GitProbeCancelled>,
)
where
    S: std::future::Future<Output = Vec<RuntimeShellKind>>,
    G: std::future::Future<Output = Result<GitAvailability, GitProbeCancelled>>,
{
    tokio::join!(shell_probe, git_probe)
}

fn unavailable_git() -> GitAvailability {
    GitAvailability {
        available: false,
        version: None,
    }
}

/// [`crate::consent::presets::ResolvedCapabilityAllow`] (a fully-resolved,
/// slot-specific decision) as the wire shape `hello.capabilities.allow` and
/// [`crate::manifest::build_features`] both expect. The one field that
/// differs is `external_agents`: a plain `bool` on the resolved side,
/// `Option<bool>` on the wire — see [`RuntimeCapabilityAllow`]'s own doc
/// comment for why absence there means an on-disk file predating the key,
/// which a freshly resolved decision can never be.
fn wire_allow(
    resolved: crate::consent::presets::ResolvedCapabilityAllow,
) -> RuntimeCapabilityAllow {
    RuntimeCapabilityAllow {
        fs_read: resolved.fs_read,
        fs_write: resolved.fs_write,
        shell: resolved.shell,
        git: resolved.git,
        probing: resolved.probing,
        mcp: resolved.mcp,
        library: resolved.library,
        checkpoints: resolved.checkpoints,
        update: resolved.update,
        external_agents: Some(resolved.external_agents),
    }
}

/// Reads `slot`'s stored `runtime.json` and resolves this executable's own
/// `source` fallback, off the executor thread.
///
/// Both [`build_health_report`] and [`build_capability_manifest`] used to
/// call [`read_runtime_slot_config`] and [`resolve_source`] bare — a
/// synchronous `std::fs::read_to_string`, a JSON parse, and a full schema
/// validation, followed by `std::env::current_exe()` — directly on the
/// async task calling them, which is exactly the "synchronous filesystem
/// call sitting on a Tokio executor thread" [`crate::blocking`]'s own
/// module docs forbid: this crate introduced that bounded-blocking-pool
/// module and then left its own first module bypassing it. One slow `stat`
/// (a wedged config directory, a loaded disk) here stalls every other task
/// this process is mid-way through, including the heartbeat loop.
async fn read_slot_state_and_source(
    slot: RuntimeSlot,
    mango_home: &Path,
) -> (SlotFileState, &'static str) {
    let mango_home = mango_home.to_path_buf();
    run_blocking(move || {
        let state = read_runtime_slot_config(slot, &mango_home);
        let source = resolve_source(&mango_home);
        (state, source)
    })
    .await
}

/// [`resolve_runtime_slot_config`], with one further rule the generic
/// resolver does not — and, mirroring `resolveRuntimeSlotConfig`'s own
/// TypeScript twin, must not — apply itself: an unreadable, malformed, or
/// schema-invalid `runtime.json` denies every capability, the same `none`
/// preset [`crate::consent::source::ConsentSource::refresh`] already
/// applies to the exact same read failure for the exact same file.
///
/// Mirrors `apps/runtime/src/health.ts`'s `collectRuntimeHealth`
/// (`denyEverything`): "an unreadable config is an unknown answer, and an
/// unknown answer is never yes. Reporting the [slot] default here would
/// advertise capabilities every gated call refuses." Before this, a
/// corrupted `host`/`wsl` config (whose slot default is `full`) made this
/// crate's own `runtime.health` report — and `hello.capabilities`, since
/// both callers share this resolution — claim capabilities the real
/// authorization gate was already refusing, and let `detect_shells`/
/// `probe_git` run for a slot the config layer could not actually vouch
/// for.
fn resolve_slot_config_fail_closed(
    slot: RuntimeSlot,
    state: &SlotFileState,
    fallback_source: &str,
) -> ResolvedRuntimeSlotConfig {
    let resolved = resolve_runtime_slot_config(slot, state.stored.as_ref(), fallback_source);
    if state.error.is_none() {
        return resolved;
    }
    ResolvedRuntimeSlotConfig {
        allow: consent_preset(ManifestProfile::None),
        profile: ManifestProfile::None,
        ..resolved
    }
}

/// `"provisioned"` when the running executable sits inside `mango_home`'s
/// slot layout, `"bundled"` otherwise. See the module docs for why
/// `"source-checkout"` is never produced here.
fn resolve_source(mango_home: &Path) -> &'static str {
    let current_exe = std::env::current_exe().ok();
    match current_exe
        .as_deref()
        .and_then(|exe| slot_for_path(exe, mango_home))
    {
        Some(_) => "provisioned",
        None => "bundled",
    }
}

// `process.platform`'s spelling lives in `mangostudio_runtime_core::platform`, below `probing`,
// which builds its `PathEnv` from the same mapping. See the module docs for why this crate
// reports Node's naming rather than Rust's.
pub(crate) use mangostudio_runtime_core::platform::node_platform;

/// Maps [`std::env::consts::ARCH`] to `process.arch`'s own spelling. See
/// `node_platform`.
fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

/// Bound on the `which_in` `PATH` walk both [`detect_shells`] and
/// [`probe_git`] perform. Named separately from [`GIT_PROBE_TIMEOUT`]: this
/// is `stat` calls, not a spawned child, but the failure mode is the
/// identical shape — a wedged `PATH` entry (a stale NFS mount, an
/// unresponsive `/mnt/c` share when Windows itself is unresponsive, autofs)
/// blocks a bare `std::fs::metadata` call indefinitely.
///
/// One constant, not two: both callers walk the identical `PATH` value
/// through the identical `which_in` function on the identical hot path
/// (`build_capability_manifest`, called once per connection before
/// `hello` is ever sent) — a `PATH` entry wedged for one caller is wedged
/// for the other, so there is no case where they would need to disagree
/// on how long is too long. `detect_shells` was the first of the two
/// bounded (measured on a 54-entry `PATH` with three misses — `zsh`,
/// `pwsh`, `powershell` — this walk alone cost ~210ms of every
/// connection's `hello.capabilities`, next to ~25ms for the (cached,
/// timed) `git` child, dwarfing it, not the other way around);
/// [`probe_git`]'s own identical `which_in("git", ..)` walk went unbounded
/// for a whole further wave before this constant's rename made the gap
/// obvious enough to close — see that function's own doc comment.
const PATH_WALK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Races `walk` against [`PATH_WALK_TIMEOUT`], collapsing an elapsed
/// timeout into `None` — the identical "found nothing within the bound"
/// answer a walk that genuinely found nothing already produces, so
/// [`probe_git`] never has to tell the two apart. [`detect_shells`] inlines
/// this same composition itself, for its own batched, three-shell walk,
/// rather than going through this generic helper — see that function's own
/// call site.
///
/// A free function taking any `Future<Output = Option<T>>`, not a method
/// on [`probe_git`] itself or a closure inline there, specifically so this
/// module's own tests can race it against [`std::future::pending`]
/// directly: proving the timeout composition fires is then a fully
/// virtual-time, `#[tokio::test(start_paused = true)]` proof with no real
/// filesystem, no real subprocess, and — unlike an earlier draft of this
/// fix — no need to saturate this crate's real, process-wide blocking pool
/// for the length of the whole timeout, which would have starved any
/// other concurrently-running test's own, unrelated `run_blocking` calls
/// for the same real seconds.
async fn bounded_path_walk<T>(walk: impl std::future::Future<Output = Option<T>>) -> Option<T> {
    tokio::time::timeout(PATH_WALK_TIMEOUT, walk)
        .await
        .ok()
        .flatten()
}

/// Serializes tests that clear the process-wide Git probe cache.
#[cfg(all(test, unix))]
fn git_probe_test_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Every shell kind actually found on `PATH`, in [`RuntimeShellKind`]'s own
/// declared order. A single [`run_blocking`] call walks `PATH` for all
/// three at once — this is a handful of `stat` calls, not the kind of work
/// worth three separate blocking-pool round trips.
///
/// `path_override` mirrors [`probe_git`]'s own parameter: `None` reads the
/// real environment, and tests point this at a synthetic `PATH` instead of
/// mutating the real, process-wide one every test in this binary shares.
///
/// Availability is checked afresh: a PATH string cannot identify the files
/// currently installed behind it. The bounded walk keeps slow mounts from
/// blocking a handshake indefinitely.
async fn detect_shells(path_override: Option<&std::ffi::OsStr>) -> Vec<RuntimeShellKind> {
    let path_var = match path_override {
        Some(value) => value.to_os_string(),
        None => match std::env::var_os("PATH") {
            Some(value) => value,
            None => return Vec::new(),
        },
    };

    let walk = run_blocking({
        let path_var = path_var.clone();
        move || {
            [
                RuntimeShellKind::Bash,
                RuntimeShellKind::Zsh,
                RuntimeShellKind::Powershell,
            ]
            .into_iter()
            .filter(|kind| {
                shell_path_candidates(*kind, cfg!(windows))
                    .iter()
                    .any(|name| which_in(name, &path_var).is_some())
            })
            .collect::<Vec<_>>()
        }
    });

    // A wedged entry degrades the manifest to no detected shells, keeping hello bounded.
    tokio::time::timeout(PATH_WALK_TIMEOUT, walk)
        .await
        .unwrap_or_default()
}

/// A cancelled `git` probe — distinct from "git is not available", which
/// [`probe_git`] answers as `Ok` (see its own docs).
#[derive(Debug)]
struct GitProbeCancelled;

/// Every cached `git --version` answer, keyed on the resolved executable
/// path — never on the bare name `"git"`, so a `PATH` that starts
/// resolving to a different binary is re-probed rather than serving a
/// stale answer for the old one. Reuses
/// [`crate::file_identity::fingerprint`]'s object identity and high-resolution metadata fingerprint
/// format rather than inventing a second one, keyed alongside the path so
/// a rebuilt binary at the same path also re-probes.
static GIT_PROBE_CACHE: ProbeCache<GitAvailability> = ProbeCache::new();

/// Clears every cached `git` probe result. Test-only: every caller lives in
/// this module's `#[cfg(unix)]` git-probe tests, each of which wants a clean
/// cache before it runs its own fake `git`. Not a production "the operator
/// changed `PATH`" hook — this function never compiles into a release
/// build, so it cannot be one; a real hook for that would need its own,
/// non-`#[cfg(test)]` entry point.
#[cfg(all(test, unix))]
fn invalidate_git_probe_cache() {
    GIT_PROBE_CACHE.clear();
}

/// Probes `git --version`, memoised by resolved path and fingerprint.
///
/// Only a *successful* probe is cached: a probe that timed out or failed to
/// spawn says nothing about whether `git` is actually usable, and caching
/// it would announce git as permanently absent over one transient hang —
/// mirrors `apps/runtime/src/manifest.ts`'s own `versionProbeCache` comment
/// making exactly this choice.
///
/// # Errors
/// [`GitProbeCancelled`] only when `cancel` fired before the probe
/// finished — every other failure (not found, timed out, failed to spawn)
/// is reported as `Ok(GitAvailability { available: false, .. })`, matching
/// `runtime.health`'s own "an absent tool is not an error" contract.
async fn probe_git(
    path_override: Option<&std::ffi::OsStr>,
    cancel: &CancellationToken,
) -> Result<GitAvailability, GitProbeCancelled> {
    probe_cli("git", path_override, cancel, ProbeDiagnostics::process()).await
}

async fn probe_gh(
    allowed: bool,
    path_override: Option<&std::ffi::OsStr>,
    cancel: &CancellationToken,
) -> Result<GitAvailability, GitProbeCancelled> {
    if !allowed {
        return Ok(unavailable_git());
    }
    probe_cli("gh", path_override, cancel, ProbeDiagnostics::process()).await
}

/// When [`collect_capability_snapshot`] learns `gh`'s version.
#[derive(Clone, Copy)]
enum GhProbeTiming {
    /// Run `gh --version` (or reuse its cached answer) before answering:
    /// `runtime.health` and the CLI's `health`, which print the version.
    Await,
    /// Answer from the `PATH` walk and let `--version` run behind `hello`:
    /// `gh` takes about 50 ms to start on Linux, which `hello` used to wait for.
    Background,
}

/// `gh` as `hello` reports it: available when an executable `gh` is on `PATH`
/// and git is consented to, with the version only when this process already
/// learned it for that executable. [`probe_gh`] says the same thing after
/// running `gh --version`, so `hello` and `runtime.health` differ for a `gh`
/// that is on `PATH` but cannot start: the first `hello` for that file says
/// available until the background probe finishes and the hub's next
/// `runtime.health` read says otherwise. Later ones say unavailable, because
/// this process remembers the failure for that exact file.
///
/// A cache miss starts that probe without waiting for it, and a
/// `runtime.health` that arrives meanwhile waits for it rather than starting
/// a second child (see [`BACKGROUND_PROBES`]).
async fn gh_without_waiting(
    allowed: bool,
    path_override: Option<&std::ffi::OsStr>,
) -> GitAvailability {
    if !allowed {
        return unavailable_git();
    }
    let Some(path_var) = probe_path_var(path_override) else {
        return unavailable_git();
    };
    let Some(gh_path) = locate_on_path("gh", &path_var).await else {
        return unavailable_git();
    };
    let fingerprint = fingerprint_of(&gh_path).await;
    if let Some(cached) = fingerprint
        .as_deref()
        .and_then(|key| GIT_PROBE_CACHE.get(&gh_path, key))
    {
        return cached;
    }
    // The last probe of this very file failed: say so instead of repeating
    // the stale "available" on every connection. The probe still runs again,
    // so a gh that was only briefly unwell is reported well by the next
    // `hello`, and `runtime.health` clears the failure when it succeeds.
    let known_broken = PROBE_FAILURES.last_failed(&gh_path, fingerprint.as_deref());
    start_background_version_probe("gh", gh_path, fingerprint);
    GitAvailability {
        available: !known_broken,
        version: None,
    }
}

/// The channel a background `--version` run reports its outcome on.
type ProbeOutcome = tokio::sync::watch::Receiver<Option<GitAvailability>>;

/// One `--version` run started without anyone waiting for it.
struct InFlightProbe {
    executable: PathBuf,
    /// What the executable looked like when the run started. A run joins only
    /// a caller that saw the same file: a binary replaced mid-run would
    /// otherwise hand the old version to the new one.
    fingerprint: Option<String>,
    outcome: ProbeOutcome,
    /// Callers blocked on `outcome` right now.
    waiting: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl InFlightProbe {
    fn is_for(&self, executable: &Path, fingerprint: Option<&str>) -> bool {
        self.executable == executable && self.fingerprint.as_deref() == fingerprint
    }
}

/// Counts one caller as waiting on a run for as long as it lives.
struct Waiting(std::sync::Arc<std::sync::atomic::AtomicUsize>);

impl Waiting {
    fn begin(counter: std::sync::Arc<std::sync::atomic::AtomicUsize>) -> Self {
        counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Self(counter)
    }
}

impl Drop for Waiting {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// The `--version` runs `hello` started in the background, by resolved
/// executable and fingerprint.
///
/// [`probe_cli`] joins a run instead of starting its own, and receives the
/// run's outcome whether it succeeded or failed. Failures are not cached, so
/// without this a `runtime.health` read right after `hello` would run a
/// second child against a `gh` that hangs, and wait out the probe timeout
/// twice.
struct BackgroundProbes(std::sync::Mutex<Vec<InFlightProbe>>);

impl BackgroundProbes {
    const fn new() -> Self {
        Self(std::sync::Mutex::new(Vec::new()))
    }

    fn entries(&self) -> std::sync::MutexGuard<'_, Vec<InFlightProbe>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Registers a run for this executable file, unless one is already in
    /// flight for it.
    fn register(
        &self,
        executable: &Path,
        fingerprint: Option<&str>,
    ) -> Option<tokio::sync::watch::Sender<Option<GitAvailability>>> {
        let mut entries = self.entries();
        if entries
            .iter()
            .any(|probe| probe.is_for(executable, fingerprint))
        {
            return None;
        }
        let (sender, outcome) = tokio::sync::watch::channel(None);
        entries.push(InFlightProbe {
            executable: executable.to_path_buf(),
            fingerprint: fingerprint.map(str::to_owned),
            outcome,
            waiting: std::sync::Arc::default(),
        });
        Some(sender)
    }

    fn remove(&self, executable: &Path, fingerprint: Option<&str>) {
        self.entries()
            .retain(|probe| !probe.is_for(executable, fingerprint));
    }

    /// The outcome of the run in flight for this executable file; `None`
    /// when there is none, or when it ended without reporting (its task was
    /// dropped), so the caller probes for itself.
    ///
    /// # Errors
    /// [`GitProbeCancelled`] when `cancel` fired while waiting. The run keeps
    /// going: nothing here owns it.
    async fn outcome(
        &self,
        executable: &Path,
        fingerprint: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<Option<GitAvailability>, GitProbeCancelled> {
        let joined = self
            .entries()
            .iter()
            .find(|probe| probe.is_for(executable, fingerprint))
            .map(|probe| {
                (
                    probe.outcome.clone(),
                    Waiting::begin(std::sync::Arc::clone(&probe.waiting)),
                )
            });
        let Some((mut outcome, _waiting)) = joined else {
            return Ok(None);
        };
        tokio::select! {
            () = cancel.cancelled() => Err(GitProbeCancelled),
            reported = outcome.wait_for(Option::is_some) => {
                Ok(reported.ok().and_then(|reported| reported.clone()))
            }
        }
    }

    /// How many callers are waiting on the run in flight for this file, or
    /// `None` when none is in flight. Lets a test release a fake `gh` only
    /// once `runtime.health` is known to be waiting on it, without a sleep.
    #[cfg(all(test, unix))]
    fn waiters(&self, executable: &Path, fingerprint: Option<&str>) -> Option<usize> {
        self.entries()
            .iter()
            .find(|probe| probe.is_for(executable, fingerprint))
            .map(|probe| probe.waiting.load(std::sync::atomic::Ordering::SeqCst))
    }
}

/// Every `--version` run `hello` started in the background.
static BACKGROUND_PROBES: BackgroundProbes = BackgroundProbes::new();

/// Removes a background run's entry when its task ends, including when the
/// task is dropped at shutdown or panics.
struct BackgroundProbeEntry(PathBuf, Option<String>);

impl Drop for BackgroundProbeEntry {
    fn drop(&mut self) {
        BACKGROUND_PROBES.remove(&self.0, self.1.as_deref());
    }
}

/// Starts `<executable> --version` on its own task and returns at once.
///
/// Uncancellable on purpose: no request owns this probe, and
/// `GIT_PROBE_TIMEOUT` still bounds the child. A success lands in
/// [`GIT_PROBE_CACHE`] like any other probe's, so the next `hello` in this
/// process carries the version.
fn start_background_version_probe(
    program: &'static str,
    executable: PathBuf,
    fingerprint: Option<String>,
) {
    let Some(outcome) = BACKGROUND_PROBES.register(&executable, fingerprint.as_deref()) else {
        return;
    };
    // Created before the task, so a task dropped before its first poll (the
    // runtime shutting down) still removes the entry instead of leaving
    // `register` refusing this file for the life of the process.
    let entry = BackgroundProbeEntry(executable.clone(), fingerprint.clone());
    tokio::spawn(async move {
        let _entry = entry;
        let availability = run_version_probe(
            program,
            executable,
            fingerprint,
            &CancellationToken::new(),
            ProbeDiagnostics::process(),
        )
        .await
        .unwrap_or_else(|GitProbeCancelled| unavailable_git());
        outcome.send_replace(Some(availability));
    });
}

/// How a started or refused `--version` probe failed, as the
/// `version_probe_failed` diagnostic reports it. The manifest reports every
/// one of these as `available: false`, so this is where a machine with no
/// usable CLI and a machine whose CLI is merely broken or slow differ.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ProbeFailure {
    /// The child could not be started: a broken shebang, a binary removed
    /// after the `PATH` walk, a directory where a file was expected.
    SpawnFailed { spawn_error: String },
    /// Still running at [`GIT_PROBE_TIMEOUT`], and killed.
    TimedOut,
    /// Exited unsuccessfully on its own, with a code or a signal.
    Exited {
        exit_code: Option<i32>,
        signal: Option<&'static str>,
    },
}

impl ProbeFailure {
    /// The spawn error's errno name when it has a well-known one, the same
    /// vocabulary the TypeScript runtime reported (`ENOENT`, `EACCES`).
    fn spawn_failed(error: &std::io::Error) -> Self {
        let spawn_error = match error.kind() {
            std::io::ErrorKind::NotFound => "ENOENT".to_owned(),
            std::io::ErrorKind::PermissionDenied => "EACCES".to_owned(),
            _ => error
                .raw_os_error()
                .map_or_else(|| "unknown".to_owned(), |code| format!("errno {code}")),
        };
        Self::SpawnFailed { spawn_error }
    }

    /// `{ killed, exitCode | signal | spawnError }`, the TypeScript detail
    /// shape without its `executable`.
    fn detail(&self) -> serde_json::Map<String, Value> {
        let mut detail = serde_json::Map::new();
        detail.insert(
            "killed".to_owned(),
            Value::Bool(matches!(self, Self::TimedOut)),
        );
        match self {
            Self::SpawnFailed { spawn_error } => {
                detail.insert("spawnError".to_owned(), json!(spawn_error));
            }
            Self::TimedOut => {}
            Self::Exited {
                signal: Some(signal),
                ..
            } => {
                detail.insert("signal".to_owned(), json!(signal));
            }
            Self::Exited {
                exit_code,
                signal: None,
            } => {
                detail.insert("exitCode".to_owned(), json!(exit_code));
            }
        }
        detail
    }
}

/// The most failures remembered at once. Probes are keyed by resolved
/// executable path and there are two CLIs, so this is only a backstop
/// against a `PATH` that keeps changing under a long-lived process.
const MAX_ANNOUNCED_PROBE_FAILURES: usize = 128;

/// The last failure announced per executable, so a broken CLI says so once.
///
/// Failures are re-probed by design (see [`probe_cli`]), once per handshake
/// and once per `runtime.health`, which the hub issues on every environment
/// card refresh. The hub keeps only a bounded tail of this process's stderr,
/// so repeating the same line would evict the lines that tail exists for.
/// Keyed on the failure's shape, not only its path: a CLI that starts timing
/// out after exiting non-zero is a new fact and is announced again, and so is
/// the same failure from a replaced file.
///
/// It is also what `hello` consults before calling a `gh` available:
/// [`ProbeFailureLog::last_failed`].
struct ProbeFailureLog(std::sync::Mutex<std::collections::VecDeque<LoggedFailure>>);

/// The last probe failure of one executable, and the file it came from.
struct LoggedFailure {
    executable: PathBuf,
    fingerprint: Option<String>,
    failure: ProbeFailure,
}

impl ProbeFailureLog {
    const fn new() -> Self {
        Self(std::sync::Mutex::new(std::collections::VecDeque::new()))
    }

    fn entries(&self) -> std::sync::MutexGuard<'_, std::collections::VecDeque<LoggedFailure>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Records `failure` for `executable` (the file `fingerprint` describes)
    /// and reports whether it differs from the last one announced for that
    /// path.
    fn is_new(&self, executable: &Path, fingerprint: Option<&str>, failure: &ProbeFailure) -> bool {
        let mut entries = self.entries();
        if let Some(index) = entries
            .iter()
            .position(|logged| logged.executable == executable)
        {
            if entries[index].fingerprint.as_deref() == fingerprint
                && entries[index].failure == *failure
            {
                return false;
            }
            entries.remove(index);
        }
        if entries.len() >= MAX_ANNOUNCED_PROBE_FAILURES {
            entries.pop_front();
        }
        entries.push_back(LoggedFailure {
            executable: executable.to_path_buf(),
            fingerprint: fingerprint.map(str::to_owned),
            failure: failure.clone(),
        });
        true
    }

    /// Whether the latest completed probe of `executable` failed and the file
    /// is still the one that failed: a repaired or replaced binary has a new
    /// fingerprint, and a later success has forgotten the entry.
    fn last_failed(&self, executable: &Path, fingerprint: Option<&str>) -> bool {
        fingerprint.is_some()
            && self.entries().iter().any(|logged| {
                logged.executable == executable && logged.fingerprint.as_deref() == fingerprint
            })
    }

    /// Drops `executable`'s entry once it answers. A success is cached and
    /// short-circuits every later probe of the same binary; forgetting also
    /// stops `hello` from reporting the earlier failure.
    fn forget(&self, executable: &Path) {
        self.entries()
            .retain(|logged| logged.executable != executable);
    }
}

/// Every announced probe failure in this process.
static PROBE_FAILURES: ProbeFailureLog = ProbeFailureLog::new();

/// Where [`probe_cli`] reports a failed probe: the dedup log and the sink.
#[derive(Clone, Copy)]
struct ProbeDiagnostics<'a> {
    failures: &'a ProbeFailureLog,
    sink: &'a dyn DiagnosticSink,
}

impl ProbeDiagnostics<'static> {
    /// The process-wide log, writing to stderr.
    fn process() -> Self {
        Self {
            failures: &PROBE_FAILURES,
            sink: &StderrDiagnostics,
        }
    }
}

impl ProbeDiagnostics<'_> {
    /// Writes one `version_probe_failed` line, unless the same failure was
    /// already announced for `executable`. The executable is named; the
    /// `PATH` that found it is not.
    fn announce(self, executable: &Path, fingerprint: Option<&str>, failure: &ProbeFailure) {
        if !self.failures.is_new(executable, fingerprint, failure) {
            return;
        }
        let mut detail = serde_json::Map::new();
        detail.insert("executable".to_owned(), json!(executable.to_string_lossy()));
        detail.extend(failure.detail());
        self.sink.write_line(&diagnostic_line(
            "version_probe_failed",
            &Value::Object(detail),
        ));
    }
}

/// The `PATH` a CLI probe walks: the test's synthetic value, or the real
/// environment's. The one read site for [`probe_cli`] and
/// [`gh_without_waiting`], so both resolve the same executable.
fn probe_path_var(path_override: Option<&std::ffi::OsStr>) -> Option<std::ffi::OsString> {
    match path_override {
        Some(value) => Some(value.to_os_string()),
        None => std::env::var_os("PATH"),
    }
}

/// `program`'s executable on `path_var`, or `None` when it is not there or the
/// walk could not finish in time.
///
/// Bounded by `PATH_WALK_TIMEOUT` via `bounded_path_walk`, matching
/// `detect_shells`'s own identical `which_in` walk exactly — see that
/// constant's own doc comment for why this walk went unbounded for a whole
/// prior wave. A wedged `PATH` entry here used to mean a handshake that never
/// starts at all, repeated on every redial, not a degraded
/// `git.available: false`.
///
/// Not found and a walk that timed out collapse to the same "not available"
/// answer, mirroring `detect_shells`'s own "an absent tool is not an error"
/// contract: a wedged `PATH` entry must degrade a probe, never surface as a
/// distinct "probe failed" shape, and never be cached (see
/// `GIT_PROBE_CACHE`'s own doc comment on caching only a definite, successful
/// answer).
async fn locate_on_path(program: &'static str, path_var: &std::ffi::OsStr) -> Option<PathBuf> {
    bounded_path_walk(run_blocking({
        let path_var = path_var.to_os_string();
        move || which_in(program, &path_var)
    }))
    .await
}

/// `executable`'s object identity and metadata fingerprint, the key
/// [`GIT_PROBE_CACHE`] pairs with its path.
async fn fingerprint_of(executable: &Path) -> Option<String> {
    run_blocking({
        let executable = executable.to_path_buf();
        move || fingerprint(&executable)
    })
    .await
}

async fn probe_cli(
    program: &'static str,
    path_override: Option<&std::ffi::OsStr>,
    cancel: &CancellationToken,
    diagnostics: ProbeDiagnostics<'_>,
) -> Result<GitAvailability, GitProbeCancelled> {
    let Some(path_var) = probe_path_var(path_override) else {
        return Ok(unavailable_git());
    };
    let Some(git_path) = locate_on_path(program, &path_var).await else {
        return Ok(unavailable_git());
    };
    let fingerprint = fingerprint_of(&git_path).await;

    if let Some(cached) = fingerprint
        .as_deref()
        .and_then(|key| GIT_PROBE_CACHE.get(&git_path, key))
    {
        return Ok(cached);
    }

    // `hello` may already be running this very probe in the background: take
    // its outcome, failure included, instead of starting a second child that
    // would cost the same wait again.
    if let Some(shared) = BACKGROUND_PROBES
        .outcome(&git_path, fingerprint.as_deref(), cancel)
        .await?
    {
        return Ok(shared);
    }

    run_version_probe(program, git_path, fingerprint, cancel, diagnostics).await
}

/// Runs `<git_path> --version` once, caching a success under `fingerprint`.
async fn run_version_probe(
    program: &'static str,
    git_path: PathBuf,
    fingerprint: Option<String>,
    cancel: &CancellationToken,
    diagnostics: ProbeDiagnostics<'_>,
) -> Result<GitAvailability, GitProbeCancelled> {
    let budget = ChildBudget {
        deadline: version_probe_timeout(),
        max_stdout_bytes: 4_096,
        max_stderr_bytes: 1_024,
    };
    match run_bounded_child(&git_path, &["--version"], None, budget, cancel).await {
        Ok(outcome) if outcome.status_success => {
            let output = String::from_utf8_lossy(&outcome.stdout);
            let version = if program == "git" {
                parse_git_version(&output)
            } else {
                parse_gh_version(&output)
            };
            let availability = GitAvailability {
                available: true,
                version,
            };
            diagnostics.failures.forget(&git_path);
            if let Some(fingerprint) = fingerprint {
                GIT_PROBE_CACHE.insert(git_path, fingerprint, availability.clone());
            }
            Ok(availability)
        }
        Err(ChildRunError::Cancelled) => Err(GitProbeCancelled),
        // A non-zero exit, a timeout and a failed spawn all say only "not
        // usable right now": never cached, never an error, but said once on
        // stderr so an operator can tell a broken CLI from a missing one.
        Ok(outcome) => {
            let failure = ProbeFailure::Exited {
                exit_code: outcome.exit_code,
                signal: outcome.signal,
            };
            diagnostics.announce(&git_path, fingerprint.as_deref(), &failure);
            Ok(unavailable_git())
        }
        Err(ChildRunError::TimedOut) => {
            diagnostics.announce(&git_path, fingerprint.as_deref(), &ProbeFailure::TimedOut);
            Ok(unavailable_git())
        }
        Err(ChildRunError::SpawnFailed(error)) => {
            diagnostics.announce(
                &git_path,
                fingerprint.as_deref(),
                &ProbeFailure::spawn_failed(&error),
            );
            Ok(unavailable_git())
        }
    }
}

/// The bound on one `--version` run: [`GIT_PROBE_TIMEOUT`], except in a test
/// that shortened it to exercise a hang without waiting two seconds.
fn version_probe_timeout() -> std::time::Duration {
    #[cfg(test)]
    if let Some(shortened) = *VERSION_PROBE_TIMEOUT_OVERRIDE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
    {
        return shortened;
    }
    GIT_PROBE_TIMEOUT
}

/// A test's shortened [`version_probe_timeout`]. Process-wide, so only a test
/// holding `git_probe_test_lock` may set it.
#[cfg(test)]
static VERSION_PROBE_TIMEOUT_OVERRIDE: std::sync::Mutex<Option<std::time::Duration>> =
    std::sync::Mutex::new(None);

/// `git version 2.51.0` becomes `Some("2.51.0")`. Mirrors
/// `apps/runtime/src/manifest.ts`'s `parseGitVersion`: only the first line
/// is read (a `git` on `PATH` is often a wrapper that prints more after the
/// version), and the fixed prefix is stripped case-insensitively.
fn parse_git_version(output: &str) -> Option<String> {
    let first_line = output.lines().next().unwrap_or("").trim();
    let stripped = first_line
        .strip_prefix("git version ")
        .or_else(|| first_line.strip_prefix("Git version "))
        .unwrap_or(first_line)
        .trim();
    (!stripped.is_empty()).then(|| stripped.to_string())
}

fn parse_gh_version(output: &str) -> Option<String> {
    let first = output.lines().next().unwrap_or("").trim();
    let version = if first
        .get(..10)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("gh version"))
        && first[10..].starts_with(char::is_whitespace)
    {
        &first[10..]
    } else {
        first
    };
    let version = version.split('(').next().unwrap_or("").trim();
    (!version.is_empty()).then(|| version.to_owned())
}

#[cfg(test)]
mod tests {
    #[test]
    fn release_identity_matches_supported_native_targets() {
        for (platform, arch, musl, expected) in [
            ("linux", "x64", false, Some("linux-x64")),
            ("linux", "arm64", true, Some("linux-arm64-musl")),
            ("darwin", "arm64", false, Some("darwin-arm64")),
            ("win32", "x64", false, Some("windows-x64")),
            ("win32", "arm64", false, Some("windows-arm64")),
            ("win32", "x86", false, None),
        ] {
            assert_eq!(super::release_platform_id(platform, arch, musl), expected);
        }
    }

    #[test]
    fn gh_version_omits_release_date_and_url() {
        assert_eq!(
            super::parse_gh_version("gh version 2.88.0 (2026-01-01)\nhttps://release"),
            Some("2.88.0".into())
        );
        assert_eq!(
            super::parse_gh_version("GH VERSION\t2.88.0"),
            Some("2.88.0".into())
        );
        assert_eq!(super::parse_gh_version(""), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gh_probe_uses_git_consent_and_reports_a_real_cli() {
        let (dir, path) = fake_git(
            "gh-health",
            "echo 'gh version 2.88.0 (2026-01-01)'\necho 'https://release'",
        );
        std::fs::rename(dir.join("git"), dir.join("gh")).unwrap();
        let cancel = CancellationToken::new();
        let denied = super::probe_gh(false, Some(&path), &cancel).await.unwrap();
        assert!(!denied.available);
        let allowed = super::probe_gh(true, Some(&path), &cancel).await.unwrap();
        assert!(allowed.available);
        assert_eq!(allowed.version.as_deref(), Some("2.88.0"));
    }
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use tokio_util::sync::CancellationToken;

    use super::{
        bounded_path_walk, build_capability_manifest, build_health_report, node_platform,
        parse_git_version, read_slot_state_and_source, run_independent_probes, unavailable_git,
    };
    use crate::blocking::{MAX_CONCURRENT_BLOCKING_TASKS, pool_saturation_test_lock, run_blocking};
    use crate::registry::Registry;
    use crate::runtime_home::RuntimeSlot;
    use crate::serve::runtime_contract;
    // Every caller of these lives behind `#[cfg(unix)]` below (the `git`
    // probe tests write and run a real Unix shell script) — gating the
    // imports the same way keeps a Windows build from reporting them (and,
    // fail-closed, `invalidate_git_probe_cache` itself) unused, which
    // `-D warnings` turns into a hard build failure rather than a lint note.
    #[cfg(unix)]
    use super::{detect_shells, git_probe_test_lock, invalidate_git_probe_cache, probe_git};
    #[cfg(unix)]
    use crate::runtime_home::write_runtime_slot_config;
    #[cfg(unix)]
    use mango_protocol::error::codes;
    use mangostudio_runtime_contract::manifest::RuntimeShellKind;
    #[cfg(unix)]
    use std::path::Path;

    #[cfg(unix)]
    use crate::test_support::ScratchDir;
    use crate::test_support::scratch_dir as scratch_home;

    /// A directory usable as a synthetic `PATH` entry, containing one
    /// executable script named `git`.
    #[cfg(unix)]
    fn fake_git(name: &str, body: &str) -> (ScratchDir, std::ffi::OsString) {
        use std::os::unix::fs::PermissionsExt;

        let dir = scratch_home(name);
        let path = dir.join("git");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path_var = dir.as_os_str().to_os_string();
        (dir, path_var)
    }

    /// A directory usable as a synthetic `PATH` entry, containing one
    /// executable, empty script per name given — `detect_shells` never
    /// runs it, only checks that it exists and is executable.
    #[cfg(unix)]
    fn fake_shells_on_path(dir_name: &str, names: &[&str]) -> (ScratchDir, std::ffi::OsString) {
        use std::os::unix::fs::PermissionsExt;

        let dir = scratch_home(dir_name);
        for name in names {
            let path = dir.join(name);
            std::fs::write(&path, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let path_var = dir.as_os_str().to_os_string();
        (dir, path_var)
    }

    #[test]
    fn parses_the_first_line_and_strips_the_fixed_prefix() {
        assert_eq!(
            parse_git_version("git version 2.51.0\n"),
            Some("2.51.0".to_string())
        );
        assert_eq!(
            parse_git_version("git version 2.30.1\nsome trailer\n"),
            Some("2.30.1".to_string())
        );
    }

    #[tokio::test]
    async fn no_stored_config_on_host_reports_the_expected_shape() {
        let home = scratch_home("shape-host");
        let cancel = CancellationToken::new();
        let result = build_health_report(RuntimeSlot::Host, &home, "9.9.9", &cancel, None)
            .await
            .expect("a fresh host slot must answer");

        assert_eq!(result["schemaVersion"], 1);
        assert_eq!(result["slot"], "host");
        assert_eq!(result["runtimeVersion"], "9.9.9");
        assert_eq!(
            result["platformId"].as_str(),
            super::release_platform_id(
                super::node_platform(),
                super::node_arch(),
                cfg!(target_env = "musl")
            )
        );
        assert_eq!(result["profile"], "full");
        assert!(result["allow"]["shell"].as_bool().unwrap());
        assert_eq!(result["setup"]["state"], "configured");
        assert!(result["git"].get("available").is_some());
        assert!(result["lastError"].is_null());
    }

    /// Regression test: an unreadable, malformed `runtime.json` used to
    /// leave `allow`/`profile` at the slot's own default (`full`, for a
    /// `host` slot) rather than denying everything, even though the report
    /// also carries `lastError` naming the read failure right next to it.
    /// Mirrors `apps/runtime/src/health.ts`'s `collectRuntimeHealth`
    /// (`denyEverything`), and the fail-closed rule
    /// `crate::consent::source::ConsentSource::refresh` already applies to
    /// the identical read failure on the identical file — reporting the
    /// slot default here advertised capabilities the real authorization
    /// gate was already refusing.
    #[tokio::test]
    async fn a_malformed_config_denies_everything_even_on_a_slot_that_defaults_to_full() {
        let home = scratch_home("malformed-fail-closed");
        let dir = crate::runtime_home::slot_dir(RuntimeSlot::Host, &home);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("runtime.json"), b"{ not json").unwrap();
        let cancel = CancellationToken::new();

        let result = build_health_report(RuntimeSlot::Host, &home, "9.9.9", &cancel, None)
            .await
            .expect("an unreadable config must still answer, not fail the whole call");

        assert!(
            result["lastError"].is_string(),
            "the read failure must still be named"
        );
        assert_eq!(result["profile"], "none");
        assert!(!result["allow"]["shell"].as_bool().unwrap());
        assert!(!result["allow"]["git"].as_bool().unwrap());
        assert!(
            result["shells"].as_array().unwrap().is_empty(),
            "a denied shell capability must not even be probed for"
        );
    }

    /// Regression test: `source` used to report whatever `runtime.json`
    /// last recorded, even when the executable actually answering is not
    /// the one that wrote it. Mirrors `collectRuntimeHealth`'s own
    /// `resolveRuntimeSource(env)` call, which never reads `config.source`
    /// for this field either.
    #[tokio::test]
    async fn source_reports_the_running_binary_not_a_stale_stored_label() {
        let home = scratch_home("source-freshness");
        crate::runtime_home::write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[("source", Some(serde_json::json!("provisioned")))],
        )
        .unwrap();
        let cancel = CancellationToken::new();

        let result = build_health_report(RuntimeSlot::Host, &home, "9.9.9", &cancel, None)
            .await
            .expect("a stored source label must not fail the call");

        // The test binary running this assertion is never inside `home`'s
        // slot layout, so the live answer is "bundled" — the opposite of
        // the stale "provisioned" label just stored above.
        assert_eq!(result["source"], "bundled");
    }

    /// Regression test for blocker 3: `read_slot_state_and_source` used to
    /// call `read_runtime_slot_config` (a synchronous `read_to_string`, a
    /// JSON parse, and a full schema validation) and `resolve_source` (a
    /// `std::env::current_exe()` call) bare, directly on whatever task
    /// called it — exactly the "synchronous filesystem call on a Tokio
    /// executor thread" `crate::blocking`'s own module docs forbid, in the
    /// very module that introduced the bounded blocking pool.
    ///
    /// Proven the same way `crate::blocking`'s own tests prove the pool's
    /// bound: saturate every permit with ordinary `run_blocking` calls,
    /// then show `read_slot_state_and_source` cannot proceed until one
    /// frees. Bare synchronous code reaches no `.await` point at all and
    /// would complete instantly regardless of how many permits are held —
    /// only a call that genuinely routes through the same bounded pool can
    /// queue behind it.
    #[tokio::test]
    async fn read_slot_state_and_source_queues_behind_a_saturated_blocking_pool() {
        let _exclusive = pool_saturation_test_lock().lock().await;
        let home = scratch_home("blocking-pool-routing");

        let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel::<usize>();
        let mut held = Vec::new();
        for i in 0..MAX_CONCURRENT_BLOCKING_TASKS {
            let started_tx = started_tx.clone();
            let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
            let handle = tokio::spawn(run_blocking(move || {
                started_tx
                    .send(i)
                    .expect("the test still holds the receiver");
                let _ = release_rx.recv();
            }));
            held.push((handle, release_tx));
        }
        drop(started_tx);
        for _ in 0..MAX_CONCURRENT_BLOCKING_TASKS {
            started_rx
                .recv()
                .await
                .expect("every held task must signal that it started");
        }

        let target_ran = Arc::new(AtomicBool::new(false));
        let target_ran_flag = Arc::clone(&target_ran);
        let target = tokio::spawn(async move {
            let _ = read_slot_state_and_source(RuntimeSlot::Host, &home).await;
            target_ran_flag.store(true, Ordering::SeqCst);
        });

        for _ in 0..64 {
            tokio::task::yield_now().await;
        }
        assert!(
            !target_ran.load(Ordering::SeqCst),
            "read_slot_state_and_source must queue behind a fully saturated blocking pool, \
             which only holds if its filesystem read genuinely routes through run_blocking \
             rather than running bare on the calling executor"
        );

        let (released_handle, released_tx) = held.remove(0);
        released_tx
            .send(())
            .expect("the held closure is still waiting on this channel");
        released_handle
            .await
            .expect("the released held task must complete cleanly");
        target
            .await
            .expect("the target task must complete once a permit frees");
        assert!(
            target_ran.load(Ordering::SeqCst),
            "read_slot_state_and_source must have actually run once a permit was available"
        );

        for (handle, release_tx) in held {
            let _ = release_tx.send(());
            handle.await.expect("every held task must complete cleanly");
        }
    }

    /// Regression test for the handshake this manifest exists to unblock: a
    /// hub refuses `hello.capabilities` unless it validates as a complete
    /// `RuntimeCapabilityManifest` (`RuntimeCapabilityManifestSchema` in
    /// `apps/shared/src/runtime-contract/manifest.ts`), and `SessionOptions`
    /// defaults `capabilities` to an empty map — every transport that never
    /// called this function announced `{}` and every real hub closed the
    /// connection with `PROTOCOL_ERROR` before a single method could be
    /// called. Confirmed against a real, compiled binary: see
    /// `apps/api/tests/integration/services/rust-runtime-qualification.integration.test.ts`.
    /// The hello manifest carries this process's own attestation, and a
    /// runtime process never claims the hub-only `single-user-host`.
    #[tokio::test]
    async fn the_manifest_advertises_this_processs_identity_isolation() {
        use mangostudio_runtime_contract::manifest::IdentityIsolationMethod;

        let home = scratch_home("capabilities-isolation");
        let manifest = build_capability_manifest(
            RuntimeSlot::Host,
            &home,
            &Registry::new(),
            &CancellationToken::new(),
        )
        .await;

        let expected = crate::external_agents::isolation::detect_external_agent_isolation();
        assert_eq!(manifest.identity_isolation, expected);
        let method = manifest
            .identity_isolation
            .map(|isolation| isolation.method);
        assert_ne!(
            method,
            Some(IdentityIsolationMethod::SingleUserHost),
            "a runtime process must never claim single-user-host"
        );
    }

    #[tokio::test]
    async fn a_never_before_seen_host_slot_builds_a_schema_valid_manifest() {
        let home = scratch_home("capabilities-host");
        let cancel = CancellationToken::new();
        let registry = Registry::new();

        let manifest =
            build_capability_manifest(RuntimeSlot::Host, &home, &registry, &cancel).await;

        assert_eq!(manifest.platform, node_platform());
        assert_eq!(
            manifest.publishes_windows_slot,
            cfg!(windows).then_some(true)
        );
        assert!(!manifest.home_dir.is_empty());
        assert_eq!(
            manifest.profile,
            Some(mangostudio_runtime_contract::manifest::ManifestProfile::Full)
        );
        assert!(
            manifest.allow.as_ref().is_some_and(|allow| allow.shell),
            "a pre-consented host slot grants shell"
        );
        // An empty registry backs nothing, so every capability-gated feature
        // must report false even though `allow` granted it — the same
        // fail-closed contract `crate::manifest::build_features` already has
        // its own tests for.
        assert!(!manifest.features.fs_read);
        assert!(!manifest.features.tools);
        assert_eq!(manifest.terminal, Some(false));
        assert!(manifest.features.toolchain, "toolchain is unconditional");

        let wire = serde_json::to_value(&manifest).expect("serialises");
        assert!(wire.get("terminalCloseAfterRevocation").is_none());
        // Absent means v2 only by the hub's current default; a runtime that
        // stays silent breaks the day that default moves.
        assert_eq!(
            wire.get("directoryHashDomain"),
            Some(&serde_json::json!(2)),
            "expected directoryHashDomain: 2 (the domain library::hash computes) | received: {:?}",
            wire.get("directoryHashDomain")
        );
        assert!(
            mangostudio_runtime_contract::schemas::validate_manifest(&wire).is_ok(),
            "a manifest this crate builds for `hello` must validate against the same schema the \
             hub checks it with: {wire}"
        );
    }

    #[tokio::test]
    async fn a_preconsented_host_with_terminal_handlers_announces_pty_support() {
        let home = scratch_home("terminal-capabilities-host");
        let host = crate::transport::build_host(RuntimeSlot::Host, &home, "0.1.0");
        let manifest = build_capability_manifest(
            RuntimeSlot::Host,
            &home,
            &host.registry,
            &CancellationToken::new(),
        )
        .await;
        assert!(!manifest.shells.is_empty());
        assert_eq!(manifest.terminal, Some(true));
        let wire = serde_json::to_value(&manifest).expect("serialises");
        assert_eq!(
            wire["terminalCloseAfterRevocation"], true,
            "terminal support must attest close remains usable after revocation"
        );
    }

    #[tokio::test]
    async fn denied_shell_keeps_the_terminal_cleanup_attestation() {
        let home = scratch_home("terminal-revocation-capabilities-host");
        crate::runtime_home::write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[("allow", Some(serde_json::json!({ "shell": false })))],
        )
        .expect("deny shell consent");
        let host = crate::transport::build_host(RuntimeSlot::Host, &home, "0.1.0");
        let manifest = build_capability_manifest(
            RuntimeSlot::Host,
            &home,
            &host.registry,
            &CancellationToken::new(),
        )
        .await;

        assert_eq!(manifest.terminal, Some(false));
        assert_eq!(manifest.terminal_close_after_revocation, Some(true));
        assert!(manifest.shells.is_empty());
    }

    /// Shell discovery and `git --version` do not depend on one another, but
    /// both sit before `hello` during connection setup. Keeping them
    /// concurrent is what bounds the cold path by the slower probe rather
    /// than their sum.
    ///
    /// The paused clock makes the expected shape exact: two two-second
    /// probes must settle after two seconds. A sequential composition leaves
    /// the second probe unstarted then and fails the `is_finished` assertion.
    #[tokio::test(start_paused = true)]
    async fn independent_shell_and_git_probes_overlap() {
        let probes = tokio::spawn(run_independent_probes(
            async {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                vec![RuntimeShellKind::Bash]
            },
            async {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                Ok(unavailable_git())
            },
        ));

        tokio::task::yield_now().await;
        tokio::time::advance(std::time::Duration::from_secs(1)).await;
        assert!(
            !probes.is_finished(),
            "the two-second probes must not settle after one second"
        );

        tokio::time::advance(std::time::Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        assert!(
            probes.is_finished(),
            "both probes must be in flight together, not take four seconds in sequence"
        );

        let (shells, git) = probes.await.expect("the probe task must not panic");
        assert_eq!(shells, vec![RuntimeShellKind::Bash]);
        assert!(!git.expect("the git probe must complete").available);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probe_git_reports_a_working_fake_git() {
        let _exclusive = git_probe_test_lock().lock().await;
        invalidate_git_probe_cache();
        let (_dir, path_var) = fake_git("probe-ok", "echo 'git version 9.9.9'");
        let cancel = CancellationToken::new();

        let availability = probe_git(Some(&path_var), &cancel)
            .await
            .expect("a fast fake git must not be cancelled");
        assert!(availability.available);
        assert_eq!(availability.version.as_deref(), Some("9.9.9"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn replaced_git_with_preserved_size_and_timestamp_is_reprobed() {
        let _exclusive = git_probe_test_lock().lock().await;
        let (dir, path_var) = fake_git("probe-replaced-identity", "echo 'git version 9.9.9'");
        let cancel = CancellationToken::new();
        assert_eq!(
            probe_git(Some(&path_var), &cancel)
                .await
                .unwrap()
                .version
                .as_deref(),
            Some("9.9.9")
        );
        let path = dir.join("git");
        let metadata = std::fs::metadata(&path).unwrap();
        let original = std::fs::read_to_string(&path).unwrap();
        let replacement = dir.join("replacement");
        std::fs::write(&replacement, original.replace("9.9.9", "8.8.8")).unwrap();
        std::fs::set_permissions(&replacement, metadata.permissions()).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_modified(metadata.modified().unwrap())
            .unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        assert_eq!(
            probe_git(Some(&path_var), &cancel)
                .await
                .unwrap()
                .version
                .as_deref(),
            Some("8.8.8")
        );
    }

    /// An unchanged executable fingerprint avoids a second version invocation.
    ///
    /// The `tr -d '[:space:]'` after `wc -l` is load-bearing: BSD `wc`
    /// (macOS) right-justifies its count with leading spaces even when
    /// reading from stdin via redirection, unlike GNU `wc` (Linux), which
    /// prints a bare digit there — left unstripped, this fixture spliced
    /// that padding straight into the reported version. `parse_git_version`'s
    /// own `.trim()` only trims the outside of the string, exactly as it
    /// must, so an embedded space this fixture baked in would survive
    /// untouched; this is the fixture being tightened, never the parser
    /// being loosened.
    #[cfg(unix)]
    #[tokio::test]
    async fn probe_git_cache_hit_never_invokes_the_binary_a_second_time() {
        let _exclusive = git_probe_test_lock().lock().await;
        invalidate_git_probe_cache();
        let dir = scratch_home("probe-cache-hit");
        let invocations = dir.join("invocations");
        let (_git_dir, path_var) = fake_git(
            "probe-cache-hit-git",
            &format!(
                "echo run >> {inv}\ncount=$(wc -l < {inv} | tr -d '[:space:]')\necho \"git version 9.9.$count\"",
                inv = invocations.display()
            ),
        );
        let cancel = CancellationToken::new();

        let first = probe_git(Some(&path_var), &cancel)
            .await
            .expect("a fast fake git must not be cancelled");
        assert_eq!(first.version.as_deref(), Some("9.9.1"));

        let second = probe_git(Some(&path_var), &cancel)
            .await
            .expect("a fast fake git must not be cancelled");
        assert_eq!(
            second.version.as_deref(),
            Some("9.9.1"),
            "a repeated resolved path and unchanged fingerprint must be served from cache, not \
             re-probed"
        );
        let invocation_count = std::fs::read_to_string(&invocations)
            .unwrap()
            .lines()
            .count();
        assert_eq!(
            invocation_count, 1,
            "the fake git binary must have run exactly once across both probes"
        );
    }

    /// A named fake for the stderr diagnostic channel: every line it was
    /// given, in order.
    #[cfg(unix)]
    #[derive(Default)]
    struct RecordingDiagnostics(std::sync::Mutex<Vec<String>>);

    #[cfg(unix)]
    impl crate::diagnostics::DiagnosticSink for RecordingDiagnostics {
        fn write_line(&self, line: &str) {
            self.0.lock().unwrap().push(line.to_owned());
        }
    }

    #[cfg(unix)]
    impl RecordingDiagnostics {
        fn lines(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }
    }

    /// Probes `program` on `path_var` through a fresh failure log, so a
    /// test sees exactly the diagnostics its own probes produced.
    #[cfg(unix)]
    async fn probe_recorded(
        program: &'static str,
        path_var: &std::ffi::OsStr,
        failures: &super::ProbeFailureLog,
        sink: &RecordingDiagnostics,
    ) -> mangostudio_runtime_contract::manifest::GitAvailability {
        super::probe_cli(
            program,
            Some(path_var),
            &CancellationToken::new(),
            super::ProbeDiagnostics { failures, sink },
        )
        .await
        .expect("an uncancelled probe must answer")
    }

    /// A fake `git` whose `--version` exits with the code stored in
    /// `code_file`, so a test can change the failure without replacing the
    /// binary (and so without changing its fingerprint).
    #[cfg(unix)]
    fn git_exiting_with(name: &str, code_file: &Path) -> (ScratchDir, std::ffi::OsString) {
        fake_git(name, &format!("exit \"$(cat {})\"", code_file.display()))
    }

    /// A failed `--version` says why on stderr, once per failure shape: the
    /// same exit code twice is one line, a different exit code is a new one.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_version_probe_says_why_once_per_failure_shape() {
        let _exclusive = git_probe_test_lock().lock().await;
        let state = scratch_home("probe-failed-diagnostic-state");
        let code_file = state.join("code");
        std::fs::write(&code_file, "1").unwrap();
        let (dir, path_var) = git_exiting_with("probe-failed-diagnostic", &code_file);
        let executable = dir.join("git");
        let failures = super::ProbeFailureLog::new();
        let sink = RecordingDiagnostics::default();

        for _ in 0..2 {
            let git = probe_recorded("git", &path_var, &failures, &sink).await;
            assert!(!git.available, "a git whose --version exits 1 is absent");
        }
        let expected = format!(
            "mangostudio-runtime: version_probe_failed {}",
            serde_json::json!({ "executable": executable, "killed": false, "exitCode": 1 })
        );
        assert_eq!(
            sink.lines(),
            vec![expected.clone()],
            "expected one version_probe_failed line for two identical failures"
        );

        std::fs::write(&code_file, "2").unwrap();
        probe_recorded("git", &path_var, &failures, &sink).await;
        probe_recorded("git", &path_var, &failures, &sink).await;
        let lines = sink.lines();
        assert_eq!(
            lines.len(),
            2,
            "expected a second line once the failure changed shape | received: {lines:?}"
        );
        assert!(
            lines[1].contains(r#""exitCode":2"#),
            "expected the new line to report exitCode 2 | received: {}",
            lines[1]
        );
    }

    /// A probe that fails is re-probed next time rather than memoised as
    /// absent. The binary is untouched between the two probes, so only a
    /// cache that stored the failure could answer the second one.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_probe_is_not_memoised() {
        let _exclusive = git_probe_test_lock().lock().await;
        let state = scratch_home("probe-not-memoised-state");
        let ready = state.join("ready");
        let (_dir, path_var) = fake_git(
            "probe-not-memoised",
            &format!(
                "[ -f {} ] || exit 1\necho 'git version 9.9.9'",
                ready.display()
            ),
        );
        let failures = super::ProbeFailureLog::new();
        let sink = RecordingDiagnostics::default();

        let first = probe_recorded("git", &path_var, &failures, &sink).await;
        assert!(!first.available, "the first probe exits 1 and is absent");

        std::fs::write(&ready, "").unwrap();
        let second = probe_recorded("git", &path_var, &failures, &sink).await;
        assert!(
            second.available,
            "expected the failed probe to be re-run and find git | received: {second:?}"
        );
        assert_eq!(second.version.as_deref(), Some("9.9.9"));
    }

    /// A `gh` whose interpreter does not exist cannot start at all. It is
    /// absent, not an error, and the diagnostic names the spawn failure.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_gh_that_cannot_start_is_absent() {
        use std::os::unix::fs::PermissionsExt;

        let _exclusive = git_probe_test_lock().lock().await;
        let dir = scratch_home("probe-gh-broken-shebang");
        let gh = dir.join("gh");
        std::fs::write(&gh, "#!/nonexistent/mango-interpreter\n").unwrap();
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path_var = dir.as_os_str().to_os_string();

        let allowed = super::probe_gh(true, Some(&path_var), &CancellationToken::new())
            .await
            .expect("a gh that cannot start must not fail the probe");
        assert!(
            !allowed.available,
            "expected gh absent | received: {allowed:?}"
        );

        let failures = super::ProbeFailureLog::new();
        let sink = RecordingDiagnostics::default();
        probe_recorded("gh", &path_var, &failures, &sink).await;
        let lines = sink.lines();
        assert_eq!(
            lines.len(),
            1,
            "expected one diagnostic | received: {lines:?}"
        );
        assert!(
            lines[0].contains(r#""spawnError":"ENOENT""#) && lines[0].contains(r#""killed":false"#),
            "expected a spawnError ENOENT diagnostic | received: {}",
            lines[0]
        );
    }

    /// A `gh` on a synthetic `PATH` that appends one line to `log` per
    /// invocation, then runs `body`.
    #[cfg(unix)]
    fn recording_gh(name: &str, log: &Path, body: &str) -> (ScratchDir, std::ffi::OsString) {
        let (dir, path_var) = fake_git(name, &format!("echo run >> {}\n{body}", log.display()));
        std::fs::rename(dir.join("git"), dir.join("gh")).unwrap();
        (dir, path_var)
    }

    #[cfg(unix)]
    fn invocation_count(log: &Path) -> usize {
        std::fs::read_to_string(log).map_or(0, |text| text.lines().count())
    }

    /// What `hello` carries for `path_var`, as `build_capability_manifest`
    /// builds it: the snapshot taken without waiting for `gh --version`.
    #[cfg(unix)]
    async fn hello_gh(
        home: &Path,
        path_var: &std::ffi::OsStr,
    ) -> mangostudio_runtime_contract::manifest::GitAvailability {
        super::collect_capability_snapshot(
            RuntimeSlot::Host,
            home,
            Some(path_var),
            super::GhProbeTiming::Background,
            &CancellationToken::new(),
        )
        .await
        .gh
        .expect("an uncancelled snapshot must carry gh")
    }

    /// `runtime.health`'s answer for `gh`: the version is awaited.
    #[cfg(unix)]
    async fn health_gh(home: &Path, path_var: &std::ffi::OsStr) -> serde_json::Value {
        let report = build_health_report(
            RuntimeSlot::Host,
            home,
            "9.9.9",
            &CancellationToken::new(),
            Some(path_var),
        )
        .await
        .expect("an uncancelled health report must answer");
        report["gh"].clone()
    }

    /// Shell that blocks until `release` exists, for a fake `gh` whose
    /// `--version` the test decides when to finish.
    #[cfg(unix)]
    fn wait_for_release(release: &Path) -> String {
        format!("while [ ! -f {} ]; do sleep 0.02; done", release.display())
    }

    /// The fingerprint [`GIT_PROBE_CACHE`] and the in-flight registry key
    /// `executable` by.
    #[cfg(unix)]
    fn fingerprint_now(executable: &Path) -> Option<String> {
        crate::file_identity::fingerprint(executable)
    }

    /// Waits until `waiting` callers are blocked on the background probe of
    /// `executable`. The state the tests release a fake `gh` on, so no test
    /// depends on how long a probe takes.
    #[cfg(unix)]
    async fn wait_for_waiters(executable: &Path, waiting: usize) {
        let fingerprint = fingerprint_now(executable);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let seen = super::BACKGROUND_PROBES.waiters(executable, fingerprint.as_deref());
            if seen == Some(waiting) {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "expected {waiting} caller(s) waiting on the background probe of {} | received: {seen:?}",
                executable.display()
            );
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    /// Waits until no background probe of `executable` is in flight.
    #[cfg(unix)]
    async fn wait_until_probe_ends(executable: &Path) {
        let fingerprint = fingerprint_now(executable);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while super::BACKGROUND_PROBES
            .waiters(executable, fingerprint.as_deref())
            .is_some()
        {
            assert!(
                std::time::Instant::now() < deadline,
                "expected the background probe of {} to end | received: still in flight",
                executable.display()
            );
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    /// Runs `runtime.health` on its own task, so a test can look at what it
    /// is waiting for before it finishes.
    #[cfg(unix)]
    fn spawn_health_gh(
        home: &Path,
        path_var: &std::ffi::OsStr,
    ) -> tokio::task::JoinHandle<serde_json::Value> {
        let home = home.to_path_buf();
        let path_var = path_var.to_os_string();
        tokio::spawn(async move { health_gh(&home, &path_var).await })
    }

    /// Shortens [`super::version_probe_timeout`] until dropped. The caller
    /// holds `git_probe_test_lock`, which is what makes a process-wide value
    /// safe to set.
    #[cfg(unix)]
    struct ShortenedProbeTimeout;

    #[cfg(unix)]
    impl ShortenedProbeTimeout {
        fn to(timeout: std::time::Duration) -> Self {
            *super::VERSION_PROBE_TIMEOUT_OVERRIDE
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(timeout);
            Self
        }
    }

    #[cfg(unix)]
    impl Drop for ShortenedProbeTimeout {
        fn drop(&mut self) {
            *super::VERSION_PROBE_TIMEOUT_OVERRIDE
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        }
    }

    /// `hello` must not wait for `gh --version`. This `gh` does not answer
    /// until the test releases it, and only once `runtime.health` is waiting
    /// on that very run, so the answer can only come from the run `hello`
    /// started: a `hello` that waited would stall until the probe timeout,
    /// and a `health` that ran its own `gh` would never join it.
    #[cfg(unix)]
    #[tokio::test]
    async fn hello_reports_gh_without_waiting_for_its_version_and_health_supplies_it() {
        let _exclusive = git_probe_test_lock().lock().await;
        invalidate_git_probe_cache();
        let state = scratch_home("hello-gh-state");
        let log = state.join("runs");
        let release = state.join("release");
        let (dir, path_var) = recording_gh(
            "hello-gh-slow",
            &log,
            &format!(
                "{}\necho 'gh version 2.89.0 (2026-01-01)'",
                wait_for_release(&release)
            ),
        );
        let gh = dir.join("gh");

        let hello = hello_gh(&state, &path_var).await;
        assert!(
            hello.available && hello.version.is_none(),
            "expected hello to report gh available without a version while --version runs | received: {hello:?}"
        );

        let health = spawn_health_gh(&state, &path_var);
        wait_for_waiters(&gh, 1).await;
        std::fs::write(&release, "").unwrap();
        assert_eq!(
            health.await.expect("the health task must not panic"),
            serde_json::json!({ "available": true, "version": "2.89.0" }),
            "expected runtime.health to carry the probed version"
        );
        assert_eq!(
            invocation_count(&log),
            1,
            "expected health to take the in-flight probe instead of running gh again"
        );

        // The success is cached, so the next hello in this process has it.
        let next_hello = hello_gh(&state, &path_var).await;
        assert_eq!(next_hello.version.as_deref(), Some("2.89.0"));
        assert_eq!(invocation_count(&log), 1, "a cached version runs nothing");
    }

    /// A `gh` that never answers: `hello` does not wait for it, and a
    /// `runtime.health` after it waits for the one run's timeout, not for that
    /// run's and then another of its own. The timeout is shortened through
    /// [`ShortenedProbeTimeout`] so the hang costs a fraction of a second.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_hung_gh_costs_hello_and_health_one_probe_timeout_together() {
        let _exclusive = git_probe_test_lock().lock().await;
        invalidate_git_probe_cache();
        let _short = ShortenedProbeTimeout::to(std::time::Duration::from_millis(300));
        let state = scratch_home("hello-gh-hung-state");
        let log = state.join("runs");
        let (dir, path_var) = recording_gh("hello-gh-hung", &log, "exec sleep 30");
        let gh = dir.join("gh");

        let hello = hello_gh(&state, &path_var).await;
        assert!(
            hello.available && hello.version.is_none(),
            "expected hello to answer without waiting for a hung gh | received: {hello:?}"
        );

        let health = spawn_health_gh(&state, &path_var);
        wait_for_waiters(&gh, 1).await;
        assert_eq!(
            health.await.expect("the health task must not panic"),
            serde_json::json!({ "available": false }),
            "a hung gh is unavailable in runtime.health"
        );
        assert_eq!(
            invocation_count(&log),
            1,
            "expected one gh run, so one timeout, for hello and health together"
        );
    }

    /// A background probe that fails is not cached, so health must receive
    /// its outcome rather than run `gh` again. The run only ends once the test
    /// releases it, after `runtime.health` is waiting on it: the outcome health
    /// reports is the one `hello`'s run produced.
    #[cfg(unix)]
    #[tokio::test]
    async fn health_takes_the_failure_of_the_background_probe_without_a_second_run() {
        let _exclusive = git_probe_test_lock().lock().await;
        invalidate_git_probe_cache();
        let state = scratch_home("hello-gh-failing-state");
        let log = state.join("runs");
        let release = state.join("release");
        let (dir, path_var) = recording_gh(
            "hello-gh-failing",
            &log,
            &format!("{}\nexit 1", wait_for_release(&release)),
        );
        let gh = dir.join("gh");

        let hello = hello_gh(&state, &path_var).await;
        assert!(hello.available, "hello answers from the PATH walk");

        let health = spawn_health_gh(&state, &path_var);
        wait_for_waiters(&gh, 1).await;
        std::fs::write(&release, "").unwrap();
        assert_eq!(
            health.await.expect("the health task must not panic"),
            serde_json::json!({ "available": false }),
            "expected a gh that exits 1 to be unavailable in runtime.health"
        );
        assert_eq!(
            invocation_count(&log),
            1,
            "expected one gh run for hello and health together"
        );
    }

    /// Health joins a run only for the file the run started on. A `gh`
    /// replaced while the earlier one is still running is a different binary,
    /// and the old run's version is not its version.
    #[cfg(unix)]
    #[tokio::test]
    async fn health_does_not_join_a_probe_of_a_gh_that_was_replaced_mid_run() {
        use std::os::unix::fs::PermissionsExt;

        let _exclusive = git_probe_test_lock().lock().await;
        invalidate_git_probe_cache();
        let state = scratch_home("hello-gh-replaced-state");
        let log = state.join("runs");
        let release = state.join("release");
        let (dir, path_var) = recording_gh(
            "hello-gh-replaced",
            &log,
            &format!("{}\necho 'gh version 1.0.0'", wait_for_release(&release)),
        );
        let gh = dir.join("gh");

        let hello = hello_gh(&state, &path_var).await;
        assert!(hello.available);
        // The run `hello` started, with nobody waiting on it yet, and its gh
        // actually executing: a replacement before that would be the file the
        // run executes.
        wait_for_waiters(&gh, 0).await;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while invocation_count(&log) == 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "expected the first gh to start within 20 seconds | received: no invocation"
            );
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }

        // A new file renamed over the old one: the running script keeps its
        // own inode, and the path now names a different binary.
        let replacement = dir.join("gh.new");
        std::fs::write(
            &replacement,
            "#!/bin/sh\necho 'gh version 2.0.0 (replaced)'\n",
        )
        .unwrap();
        std::fs::set_permissions(&replacement, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::rename(&replacement, &gh).unwrap();

        let health = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            health_gh(&state, &path_var),
        )
        .await
        .expect("expected health not to wait on the run of the replaced binary");
        assert_eq!(
            health,
            serde_json::json!({ "available": true, "version": "2.0.0" }),
            "expected the replacement's version, not the version of the run that started earlier"
        );

        // Let the first run finish so no fake gh outlives the test.
        std::fs::write(&release, "").unwrap();
    }

    /// The price of not waiting: the first `hello` for a `gh` that is on
    /// `PATH` but cannot start reads available, and `runtime.health` corrects
    /// it. Every later `hello` for that file says what this process learned,
    /// and a repaired `gh` (a new file) is believed again.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_gh_that_cannot_start_reads_available_once_and_then_unavailable_until_repaired() {
        use std::os::unix::fs::PermissionsExt;

        let _exclusive = git_probe_test_lock().lock().await;
        invalidate_git_probe_cache();
        let dir = scratch_home("hello-gh-broken-shebang");
        let gh = dir.join("gh");
        std::fs::write(&gh, "#!/nonexistent/mango-interpreter\n").unwrap();
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path_var = dir.as_os_str().to_os_string();

        let first = hello_gh(&dir, &path_var).await;
        assert!(
            first.available,
            "expected the first hello to report the gh found on PATH | received: {first:?}"
        );
        assert_eq!(
            health_gh(&dir, &path_var).await,
            serde_json::json!({ "available": false })
        );

        wait_until_probe_ends(&gh).await;
        let later = hello_gh(&dir, &path_var).await;
        assert!(
            !later.available,
            "expected a later hello to report the gh this process saw fail | received: {later:?}"
        );

        // Replaced by a working one: a new file, so the failure no longer applies.
        wait_until_probe_ends(&gh).await;
        let repaired = dir.join("gh.new");
        std::fs::write(&repaired, "#!/bin/sh\necho 'gh version 3.0.0'\n").unwrap();
        std::fs::set_permissions(&repaired, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::rename(&repaired, &gh).unwrap();
        let after_repair = hello_gh(&dir, &path_var).await;
        assert!(
            after_repair.available,
            "expected a repaired gh to be believed again | received: {after_repair:?}"
        );
    }

    /// A failure is not held against the same file forever: the probe `hello`
    /// starts runs again, and a `runtime.health` that finds `gh` answering
    /// clears what `hello` remembered.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_gh_that_answers_again_is_reported_available_by_the_next_hello() {
        let _exclusive = git_probe_test_lock().lock().await;
        invalidate_git_probe_cache();
        let state = scratch_home("hello-gh-recovers-state");
        let log = state.join("runs");
        let code = state.join("exit-code");
        std::fs::write(&code, "1").unwrap();
        let (dir, path_var) = recording_gh(
            "hello-gh-recovers",
            &log,
            &format!("exit \"$(cat {})\"", code.display()),
        );
        let gh = dir.join("gh");

        // The first probe fails; from then on `hello` reports it.
        assert!(hello_gh(&state, &path_var).await.available);
        wait_until_probe_ends(&gh).await;
        assert!(
            !hello_gh(&state, &path_var).await.available,
            "expected hello to report the failed gh as unavailable"
        );
        wait_until_probe_ends(&gh).await;

        // The same file now answers.
        std::fs::write(&code, "0").unwrap();
        assert_eq!(
            health_gh(&state, &path_var).await,
            serde_json::json!({ "available": true }),
            "expected health to find the gh answering"
        );
        let recovered = hello_gh(&state, &path_var).await;
        assert!(
            recovered.available,
            "expected hello to stop reporting a failure that has passed | received: {recovered:?}"
        );
    }

    /// `hello` starts nothing when there is nothing to start: no `gh` on
    /// `PATH`, or git (which gates `gh`) not consented to.
    #[cfg(unix)]
    #[tokio::test]
    async fn hello_runs_no_gh_when_it_is_missing_or_not_consented_to() {
        let _exclusive = git_probe_test_lock().lock().await;
        invalidate_git_probe_cache();
        let state = scratch_home("hello-gh-absent-state");
        let log = state.join("runs");
        let empty = scratch_home("hello-gh-empty-path");
        let empty_path = empty.as_os_str().to_os_string();
        assert!(
            !hello_gh(&state, &empty_path).await.available,
            "a PATH without gh reports it unavailable"
        );

        let (_dir, path_var) =
            recording_gh("hello-gh-unconsented", &log, "echo 'gh version 2.89.0'");
        let denied = super::gh_without_waiting(false, Some(&path_var)).await;
        assert!(!denied.available, "git not consented to: gh unavailable");
        // `gh_without_waiting` would have started the probe by now; give a
        // wrongly-started one the time to leave a line in the log.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(invocation_count(&log), 0, "no gh run without consent");
    }

    /// A `git --version` that never answers is killed at the two-second
    /// bound (`VERSION_PROBE_TIMEOUT_MS` in the TypeScript runtime) and
    /// reported absent.
    ///
    /// The clock is paused and advanced by hand: the child reaper runs on the
    /// blocking pool, which inhibits Tokio's auto-advance, so nothing here
    /// waits two real seconds. The supervisor anchors its deadline to a
    /// `std` instant taken as the probe starts, and a paused clock maps that
    /// instant onto virtual time by the real time elapsed since it paused.
    /// The test brackets that offset (before spawning the probe, and once
    /// the child is running), then requires the probe to be running 1.9 s
    /// after the earliest possible start and settled 2.1 s after the latest.
    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn a_hung_git_is_absent_at_the_two_second_bound() {
        use std::time::Duration;

        let _exclusive = git_probe_test_lock().lock().await;
        let state = scratch_home("probe-hung-state");
        let started_marker = state.join("started");
        let (_dir, path_var) = fake_git(
            "probe-hung",
            &format!("echo > {}\nexec sleep 30", started_marker.display()),
        );
        let failures = Arc::new(super::ProbeFailureLog::new());
        let sink = Arc::new(RecordingDiagnostics::default());

        let virtual_zero = tokio::time::Instant::now().into_std();
        let earliest_start = std::time::Instant::now().saturating_duration_since(virtual_zero);
        let probe = tokio::spawn({
            let failures = Arc::clone(&failures);
            let sink = Arc::clone(&sink);
            async move { probe_recorded("git", &path_var, &failures, &sink).await }
        });
        let real_deadline = std::time::Instant::now() + Duration::from_secs(20);
        while !started_marker.exists() {
            assert!(
                std::time::Instant::now() < real_deadline,
                "expected the fake git to start within 20 real seconds"
            );
            tokio::task::yield_now().await;
        }
        let latest_start = std::time::Instant::now().saturating_duration_since(virtual_zero);

        let before_bound = earliest_start + Duration::from_millis(1_900);
        tokio::time::advance(before_bound).await;
        // A bound that had already fired would finish the kill and reap
        // well inside this real-time window; one that has not cannot finish
        // at all, so the window only adds sensitivity, never flakiness.
        let window = std::time::Instant::now() + Duration::from_millis(250);
        while std::time::Instant::now() < window && !probe.is_finished() {
            tokio::task::yield_now().await;
        }
        assert!(
            !probe.is_finished(),
            "expected the probe still running 1.9s after it started | received: finished"
        );

        // Past the bound, then no further: from here the kill and the reap
        // run in real time.
        let past_bound = latest_start + Duration::from_millis(2_100);
        tokio::time::advance(past_bound.saturating_sub(before_bound)).await;
        while !probe.is_finished() {
            assert!(
                std::time::Instant::now() < real_deadline,
                "expected the probe to settle 2.1s after it started | received: still running"
            );
            tokio::task::yield_now().await;
        }

        let git = probe.await.expect("the probe task must not panic");
        assert!(!git.available, "a hung git is absent | received: {git:?}");
        let lines = sink.lines();
        assert!(
            lines.len() == 1 && lines[0].contains(r#""killed":true"#),
            "expected one killed diagnostic | received: {lines:?}"
        );
    }

    /// Regression test for the `PATH_WALK_TIMEOUT` gap `probe_git` used to
    /// have: `which_in("git", ..)` ran through `run_blocking` with no
    /// timeout around it at all — `bounded_path_walk` is the fix, and this
    /// races it against a walk that never resolves at all, the shape a
    /// wedged `PATH` entry (a stale NFS mount, an unresponsive `/mnt/c`
    /// share) produces in production.
    ///
    /// `start_paused = true`, not a saturated blocking pool: an earlier
    /// draft of this test held every permit in this crate's real,
    /// process-wide blocking pool for the full length of the timeout to
    /// prove the same point, which — now that `probe_git`'s own walk
    /// genuinely has a deadline — starved *other*, unrelated,
    /// concurrently-running tests' ordinary `run_blocking` calls for those
    /// same real seconds and made them spuriously report a timeout of
    /// their own. `bounded_path_walk` takes any future, so this races it
    /// against `std::future::pending()` directly instead: no real
    /// filesystem, no real thread, no shared resource any other test could
    /// contend on, and — under a paused clock — no real time elapsed at
    /// all.
    #[tokio::test(start_paused = true)]
    async fn bounded_path_walk_reports_none_when_the_walk_never_resolves() {
        let result: Option<()> = bounded_path_walk(std::future::pending()).await;
        assert!(result.is_none());
    }

    /// The other half of the same composition: a walk that finishes well
    /// within the bound must report exactly what it found, untouched.
    #[tokio::test]
    async fn bounded_path_walk_returns_the_walks_own_result_when_it_finishes_in_time() {
        let result = bounded_path_walk(async { Some(42) }).await;
        assert_eq!(result, Some(42));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn detect_shells_finds_a_shell_present_on_a_synthetic_path() {
        let (_dir, path_var) = fake_shells_on_path("shells-found", &["bash"]);

        let shells = detect_shells(Some(&path_var)).await;

        assert_eq!(shells, vec![RuntimeShellKind::Bash]);
    }

    /// PowerShell is Windows-only for `shell.run`, so an off-Windows host
    /// must not advertise it even when `pwsh`/`powershell` sit on `PATH`.
    #[cfg(unix)]
    #[tokio::test]
    async fn detect_shells_never_advertises_powershell_off_windows() {
        let (_dir, path_var) =
            fake_shells_on_path("shells-no-pwsh", &["bash", "pwsh", "powershell"]);

        let shells = detect_shells(Some(&path_var)).await;

        assert_eq!(
            shells,
            vec![RuntimeShellKind::Bash],
            "expected shells: [Bash] (powershell is Windows-only) | received: {shells:?}"
        );
    }

    /// A removed shell must disappear even if the PATH string stays identical.
    #[cfg(unix)]
    #[tokio::test]
    async fn detect_shells_refreshes_after_removal_at_the_same_path() {
        let (dir, path_var) = fake_shells_on_path("shells-cache", &["bash"]);

        let first = detect_shells(Some(&path_var)).await;
        assert_eq!(first, vec![RuntimeShellKind::Bash]);

        std::fs::remove_file(dir.join("bash")).unwrap();

        let second = detect_shells(Some(&path_var)).await;
        assert!(
            second.is_empty(),
            "a removed executable must not stay available at an unchanged PATH"
        );
    }

    /// `allow.git = false` must never even resolve `git` on `PATH`: proven
    /// by pointing a fake `git` that would leave a marker file if it ran,
    /// then asserting the marker was never created.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_denied_git_capability_never_spawns_a_subprocess() {
        let home = scratch_home("gate-denied");
        let marker_dir = scratch_home("gate-denied-marker");
        let marker = marker_dir.join("invoked");
        let (_dir, path_var) = fake_git(
            "gate-denied-git",
            &format!("touch {}\nsleep 5\n", marker.display()),
        );
        write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[(
                "allow",
                Some(serde_json::json!({ "shell": false, "git": false })),
            )],
        )
        .unwrap();
        let cancel = CancellationToken::new();

        let result =
            build_health_report(RuntimeSlot::Host, &home, "9.9.9", &cancel, Some(&path_var))
                .await
                .expect("a denied capability must still answer, not fail the call");
        assert!(!result["git"]["available"].as_bool().unwrap());
        assert!(
            !marker.exists(),
            "git must never be invoked when allow.git is false"
        );
    }

    /// A `git` probe cancelled mid-flight is reported as `CANCELLED`, and
    /// the underlying child is confirmed reaped, not leaked.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_cancelled_probe_returns_promptly_and_reaps_its_child() {
        let _exclusive = git_probe_test_lock().lock().await;
        invalidate_git_probe_cache();
        let home = scratch_home("cancel-home");
        let pid_dir = scratch_home("cancel-pid");
        let pid_file = pid_dir.join("pid");
        let (_dir, path_var) = fake_git(
            "cancel-git",
            &format!("echo $$ > {}\nsleep 5\n", pid_file.display()),
        );
        write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[("allow", Some(serde_json::json!({ "git": true })))],
        )
        .unwrap();

        let cancel = CancellationToken::new();
        let cancel_after = cancel.clone();
        let pid_file_for_wait = pid_file.clone();
        tokio::spawn(async move {
            wait_for_file(&pid_file_for_wait).await;
            cancel_after.cancel();
        });

        let error =
            build_health_report(RuntimeSlot::Host, &home, "9.9.9", &cancel, Some(&path_var))
                .await
                .expect_err("a cancelled probe must fail the whole call");
        assert_eq!(error.code, codes::CANCELLED);

        let pid_text = std::fs::read_to_string(&pid_file).unwrap();
        let pid: i32 = pid_text.trim().parse().unwrap();
        let alive = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None);
        assert!(
            matches!(alive, Err(nix::errno::Errno::ESRCH)),
            "the probed child must be reaped, not left running"
        );
    }

    #[cfg(unix)]
    async fn wait_for_file(path: &Path) {
        for _ in 0..500 {
            if path.exists() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("{} was never created", path.display());
    }

    #[tokio::test]
    async fn the_whole_result_validates_against_its_own_catalog_schema() {
        let home = scratch_home("schema-valid");
        let cancel = CancellationToken::new();
        let result = build_health_report(RuntimeSlot::Host, &home, "9.9.9", &cancel, None)
            .await
            .expect("a fresh host slot must answer");

        runtime_contract()
            .check_result("runtime.health", &result)
            .expect("the real handler output must validate against its own schema");

        // A result missing a required field must be caught, not silently
        // accepted — proving `check_result` runs at the layer this test
        // claims to cover, not merely that the happy path exists.
        let mut corrupted = result.clone();
        corrupted.as_object_mut().unwrap().remove("allow");
        let error = runtime_contract()
            .check_result("runtime.health", &corrupted)
            .expect_err("dropping a required field must fail validation");
        assert!(error.message.contains("allow"));
    }
}
