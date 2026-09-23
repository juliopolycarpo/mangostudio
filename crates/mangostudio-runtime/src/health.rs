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
//! `shells`, `git`, `gh`, `terminal`, `lastError`.
//!
//! Deliberately skipped, all optional on the wire:
//! - `externalAgents` — out of scope; a later plan owns it.
//! - `platformId` — needs glibc-version detection on Linux, which this
//!   crate has no port for yet. A real gap, not a "never"; left for a later
//!   change.
//! - `auditError` — this crate has no "read the audit log's last write
//!   error" port yet, and building one is out of scope for this change.
//!
//! # Two deliberate divergences from the TypeScript report
//!
//! - **`source` never reports `"source-checkout"`.** The TypeScript value
//!   exists because `apps/runtime` can run either as a compiled binary or
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
/// Threaded through [`crate::transport::build_host`] rather than built
/// there directly, so this module owns every fact its own handler needs —
/// `slot`, `mango_home`, and the running `runtime_version` — behind one
/// seam this crate's three transports all share identically.
pub(crate) fn register(
    registry: Registry,
    slot: RuntimeSlot,
    mango_home: PathBuf,
    runtime_version: String,
) -> Registry {
    registry.implement(
        "runtime.health",
        move |_params: Value, context: CallContext| {
            let mango_home = mango_home.clone();
            let runtime_version = runtime_version.clone();
            async move {
                build_health_report(slot, &mango_home, &runtime_version, context.cancel(), None)
                    .await
            }
        },
    )
}

/// Builds the `runtime.health` result for `slot`, racing the `git` probe
/// against `cancel`.
///
/// `path_override` stands in for `PATH` in tests only; production callers
/// always pass `None`, which reads the real environment.
async fn build_health_report(
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
    } = collect_capability_snapshot(slot, mango_home, path_override, cancel).await;
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

    Ok(json!({
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
    }))
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
pub(crate) async fn build_capability_manifest(
    slot: RuntimeSlot,
    mango_home: &Path,
    registry: &Registry,
    cancel: &CancellationToken,
) -> RuntimeCapabilityManifest {
    let CapabilitySnapshot {
        resolved,
        shells,
        git: git_probe,
        gh: gh_probe,
        ..
    } = collect_capability_snapshot(slot, mango_home, None, cancel).await;
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
    // `terminal::register` installs these methods together with the consent watcher. Its
    // close handler remains callable after shell consent is revoked. Attest that invariant
    // independently of current consent or shell discovery, which can change after hello.
    let terminal_implementation = cfg!(any(unix, windows))
        && [
            "terminal.open",
            "terminal.attach",
            "terminal.detach",
            "terminal.write",
            "terminal.resize",
            "terminal.ack",
            "terminal.close",
            "terminal.list",
        ]
        .iter()
        .all(|method| registry.classify(method) == crate::registry::Classification::Implemented);
    manifest.terminal_close_after_revocation = terminal_implementation.then_some(true);
    manifest.terminal = Some(allow.shell && !manifest.shells.is_empty() && terminal_implementation);
    manifest.gh = Some(gh_probe.unwrap_or_else(|_| unavailable_git()));
    manifest.profile = Some(resolved.profile);
    manifest.allow = Some(allow);
    manifest.enforces_path_policy = Some(true);
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
    cancel: &CancellationToken,
) -> CapabilitySnapshot {
    let (state, fallback_source) = read_slot_state_and_source(slot, mango_home).await;
    let resolved = resolve_slot_config_fail_closed(slot, &state, fallback_source);
    let ((shells, git), gh) = tokio::join!(
        collect_capability_probes(
            resolved.allow.shell,
            resolved.allow.git,
            path_override,
            cancel
        ),
        probe_gh(resolved.allow.git, path_override, cancel),
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

/// Maps [`std::env::consts::OS`] to `process.platform`'s own spelling. See
/// the module docs for why this crate reports Node's naming rather than
/// Rust's.
///
/// `pub(crate)`: [`crate::probing::host`]'s real `PathEnv` builder reuses
/// this exact mapping rather than a second one — the two subsystems must
/// never disagree about what this host calls itself.
pub(crate) fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "linux" => "linux",
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// Maps [`std::env::consts::ARCH`] to `process.arch`'s own spelling. See
/// `node_platform`.
fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

/// PATH candidates for a shell kind, mirroring
/// `apps/shared/src/process/host.ts`'s `findShellExecutable`: `bash`/`zsh`
/// resolve their own name; `powershell` tries `pwsh` first, then
/// `powershell`, the same fallback the TypeScript side uses.
fn shell_path_candidates(kind: RuntimeShellKind) -> &'static [&'static str] {
    match kind {
        RuntimeShellKind::Bash => &["bash"],
        RuntimeShellKind::Zsh => &["zsh"],
        RuntimeShellKind::Powershell => &["pwsh", "powershell"],
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
                shell_path_candidates(*kind)
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

/// Resolves `name` against an explicit `PATH` value, checking (on Unix)
/// that it is actually executable rather than merely present — mirrors
/// `Bun.which`'s own check. On Windows, `<name>.exe` is tried alongside the
/// bare name. Never reads the real environment itself — both callers
/// ([`detect_shells`] and [`probe_git`]) resolve `PATH` (or a test's
/// override) once themselves, which is the seam their own tests use to
/// point this walk at a temporary directory instead of mutating the real,
/// process-wide `PATH` every test in this binary shares.
///
/// Returns `dir.join(name)` as found, never canonicalised: two `PATH`
/// entries that reach the same real file through a symlink or a `..`
/// segment resolve to two different [`PathBuf`]s here, and so to two
/// different [`GIT_PROBE_CACHE`] keys for what is, on disk, one binary. A
/// changed `PATH` ordering that starts naming the same binary through its
/// other spelling re-probes rather than reusing an already-cached answer —
/// wasted work, not a correctness bug (the fresh probe still reports the
/// truth), and one `PATH` layouts that reorder such entries are rare
/// enough in practice that resolving every candidate has not been worth
/// its own `std::fs::canonicalize` call on this walk's hot path.
pub(crate) fn which_in(name: &str, path_var: &std::ffi::OsStr) -> Option<PathBuf> {
    for dir in std::env::split_paths(path_var) {
        let candidate = dir.join(name);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
        if cfg!(windows) {
            let with_exe = dir.join(format!("{name}.exe"));
            if is_executable_file(&with_exe) {
                return Some(with_exe);
            }
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
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
    probe_cli("git", path_override, cancel).await
}

async fn probe_gh(
    allowed: bool,
    path_override: Option<&std::ffi::OsStr>,
    cancel: &CancellationToken,
) -> Result<GitAvailability, GitProbeCancelled> {
    if !allowed {
        return Ok(unavailable_git());
    }
    probe_cli("gh", path_override, cancel).await
}

async fn probe_cli(
    program: &'static str,
    path_override: Option<&std::ffi::OsStr>,
    cancel: &CancellationToken,
) -> Result<GitAvailability, GitProbeCancelled> {
    let path_var = match path_override {
        Some(value) => Some(value.to_os_string()),
        None => std::env::var_os("PATH"),
    };
    let Some(path_var) = path_var else {
        return Ok(unavailable_git());
    };

    // Bounded by `PATH_WALK_TIMEOUT` via `bounded_path_walk`, matching
    // `detect_shells`'s own identical `which_in` walk exactly — see that
    // constant's own doc comment for why this walk went unbounded for a
    // whole prior wave. Both `build_health_report` and
    // `build_capability_manifest` await this before `hello` is ever sent;
    // a wedged `PATH` entry here used to mean a handshake that never
    // starts at all, repeated on every redial, not a degraded
    // `git.available: false`.
    let Some(git_path) = bounded_path_walk(run_blocking({
        let path_var = path_var.clone();
        move || which_in(program, &path_var)
    }))
    .await
    else {
        // Not found, or the walk itself could not finish in time — both
        // collapse to the identical "git not available" answer, mirroring
        // `detect_shells`'s own "an absent tool is not an error" contract:
        // a wedged `PATH` entry must degrade this probe, never surface as
        // a distinct "probe failed" shape, and never be cached (see
        // `GIT_PROBE_CACHE`'s own doc comment on caching only a definite,
        // successful answer).
        return Ok(unavailable_git());
    };

    let fingerprint = run_blocking({
        let git_path = git_path.clone();
        move || fingerprint(&git_path)
    })
    .await;

    if let Some(cached) = fingerprint
        .as_deref()
        .and_then(|key| GIT_PROBE_CACHE.get(&git_path, key))
    {
        return Ok(cached);
    }

    let budget = ChildBudget {
        deadline: GIT_PROBE_TIMEOUT,
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
            if let Some(fingerprint) = fingerprint {
                GIT_PROBE_CACHE.insert(git_path, fingerprint, availability.clone());
            }
            Ok(availability)
        }
        Err(ChildRunError::Cancelled) => Err(GitProbeCancelled),
        // A non-zero exit, a timeout and a failed spawn all say only "not
        // usable right now" — never cached, never an error.
        Ok(_) | Err(ChildRunError::TimedOut | ChildRunError::SpawnFailed(_)) => {
            Ok(unavailable_git())
        }
    }
}

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

    use mangostudio_runtime_contract::catalog::method;
    use tokio_util::sync::CancellationToken;

    use super::{
        bounded_path_walk, build_capability_manifest, build_health_report, node_platform,
        parse_git_version, read_slot_state_and_source, run_independent_probes, unavailable_git,
    };
    use crate::blocking::{MAX_CONCURRENT_BLOCKING_TASKS, pool_saturation_test_lock, run_blocking};
    use crate::registry::Registry;
    use crate::result_check::{check_result, compile_result_schema};
    use crate::runtime_home::RuntimeSlot;
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
    #[tokio::test]
    async fn a_never_before_seen_host_slot_builds_a_schema_valid_manifest() {
        let home = scratch_home("capabilities-host");
        let cancel = CancellationToken::new();
        let registry = Registry::new();

        let manifest =
            build_capability_manifest(RuntimeSlot::Host, &home, &registry, &cancel).await;

        assert_eq!(manifest.platform, node_platform());
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

        let declared = method("runtime.health").expect("the catalog declares runtime.health");
        let validator = compile_result_schema(&declared.result);
        check_result("runtime.health", &validator, &result)
            .expect("the real handler output must validate against its own schema");

        // A result missing a required field must be caught, not silently
        // accepted — proving `check_result` runs at the layer this test
        // claims to cover, not merely that the happy path exists.
        let mut corrupted = result.clone();
        corrupted.as_object_mut().unwrap().remove("allow");
        let error = check_result("runtime.health", &validator, &corrupted)
            .expect_err("dropping a required field must fail validation");
        assert!(error.message.contains("allow"));
    }
}
