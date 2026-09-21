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
//! `shells`, `git`, `lastError`.
//!
//! Deliberately skipped, all optional on the wire:
//! - `gh` — a vendor CLI probe, out of this plan's "no vendor discovery"
//!   scope.
//! - `terminal` — PTY support; no terminal method group exists yet to
//!   report on.
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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

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
use crate::consent::source::fingerprint_of;
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
    let (state, fallback_source) = read_slot_state_and_source(slot, mango_home).await;
    let resolved = resolve_slot_config_fail_closed(slot, &state, fallback_source);

    let shells: Vec<RuntimeShellKind> = if resolved.allow.shell {
        detect_shells(path_override).await
    } else {
        Vec::new()
    };

    let git = if resolved.allow.git {
        match probe_git(path_override, cancel).await {
            Ok(availability) => availability,
            Err(GitProbeCancelled) => {
                return Err(RemoteError::new(
                    codes::CANCELLED,
                    "runtime.health was cancelled while probing git",
                ));
            }
        }
    } else {
        GitAvailability {
            available: false,
            version: None,
        }
    };

    let binary_path = std::env::current_exe()
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
        .or_else(|| resolved.binary_path.clone());

    let resolved_home_dir = home_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();

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
    let (state, fallback_source) = read_slot_state_and_source(slot, mango_home).await;
    let resolved = resolve_slot_config_fail_closed(slot, &state, fallback_source);

    let shells: Vec<RuntimeShellKind> = if resolved.allow.shell {
        detect_shells(None).await
    } else {
        Vec::new()
    };

    let git = if resolved.allow.git {
        match probe_git(None, cancel).await {
            Ok(availability) => availability,
            Err(GitProbeCancelled) => GitAvailability {
                available: false,
                version: None,
            },
        }
    } else {
        GitAvailability {
            available: false,
            version: None,
        }
    };

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
    manifest.profile = Some(resolved.profile);
    manifest.allow = Some(allow);
    manifest
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

/// Every cached shell-detection answer, keyed on the exact `PATH` value it
/// was computed against. A whole-string key, not a per-entry fingerprint
/// the way [`git_probe_cache`] keys on one resolved binary's `mtime:size`:
/// this walk only ever asks "does a name matching this shell exist
/// somewhere on `PATH`", so a version-manager shim swapped in at an
/// existing entry does not change the answer this cache holds, and does
/// not need to invalidate it. A `PATH` that actually changes (an operator
/// editing it, a new shell session) gets a fresh key and so a fresh walk.
fn shell_detection_cache() -> &'static Mutex<HashMap<std::ffi::OsString, Vec<RuntimeShellKind>>> {
    static CACHE: OnceLock<Mutex<HashMap<std::ffi::OsString, Vec<RuntimeShellKind>>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Clears every cached shell-detection answer. Test-only, mirroring
/// [`invalidate_git_probe_cache`]'s own doc comment on why a hook that only
/// ever compiles under `#[cfg(test)]` cannot be a production "the operator
/// changed `PATH`" one — and, like that function, gated on `unix` too:
/// every caller is one of this module's `#[cfg(unix)]` shell-detection
/// tests, so an unqualified `#[cfg(test)]` here reproduces the exact
/// Windows dead-code failure `invalidate_git_probe_cache` itself once had.
#[cfg(all(test, unix))]
fn invalidate_shell_detection_cache() {
    shell_detection_cache()
        .lock()
        .expect("the shell detection cache mutex is never poisoned")
        .clear();
}

/// Serializes tests that call [`invalidate_shell_detection_cache`]: that
/// function clears the *whole*, process-wide [`shell_detection_cache`]
/// regardless of key, so two such tests running concurrently under Rust's
/// default parallel test harness can wipe each other's cache entry
/// between their own two `detect_shells` calls — a real, observed,
/// non-deterministic failure
/// (`detect_shells_caches_by_the_exact_path_value` reporting `[]` instead
/// of its own cached `[Bash]`), not a flake in the production code either
/// test exercises. Mirrors [`crate::blocking::pool_saturation_test_lock`]'s
/// own pattern for the identical class of problem on a different shared
/// resource.
#[cfg(all(test, unix))]
fn shell_detection_test_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// The identical serialization [`shell_detection_test_lock`] gives shell-
/// detection tests, for tests that call [`invalidate_git_probe_cache`]
/// instead.
#[cfg(all(test, unix))]
fn git_probe_test_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
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
/// Only a *completed* walk is cached — mirrors [`probe_git`]'s own choice
/// (see that function's doc comment): a walk this function gave up on at
/// [`PATH_WALK_TIMEOUT`] says nothing about what a clean walk would
/// have found, and caching it would announce every shell permanently
/// absent over one transient stall.
async fn detect_shells(path_override: Option<&std::ffi::OsStr>) -> Vec<RuntimeShellKind> {
    let path_var = match path_override {
        Some(value) => value.to_os_string(),
        None => match std::env::var_os("PATH") {
            Some(value) => value,
            None => return Vec::new(),
        },
    };

    if let Some(cached) = shell_detection_cache()
        .lock()
        .expect("the shell detection cache mutex is never poisoned")
        .get(&path_var)
    {
        return cached.clone();
    }

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

    match tokio::time::timeout(PATH_WALK_TIMEOUT, walk).await {
        Ok(detected) => {
            shell_detection_cache()
                .lock()
                .expect("the shell detection cache mutex is never poisoned")
                .insert(path_var, detected.clone());
            detected
        }
        // A wedged entry degrades this connection's manifest to "no shells
        // detected" rather than never sending `hello` at all — matching
        // `probe_git`'s own "an absent tool is not an error" contract, one
        // level up: a `PATH` this function cannot finish walking in time is
        // reported the same way a `PATH` with nothing on it would be.
        Err(_elapsed) => Vec::new(),
    }
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
/// different [`git_probe_cache`] keys for what is, on disk, one binary. A
/// changed `PATH` ordering that starts naming the same binary through its
/// other spelling re-probes rather than reusing an already-cached answer —
/// wasted work, not a correctness bug (the fresh probe still reports the
/// truth), and one `PATH` layouts that reorder such entries are rare
/// enough in practice that resolving every candidate has not been worth
/// its own `std::fs::canonicalize` call on this walk's hot path.
fn which_in(name: &str, path_var: &std::ffi::OsStr) -> Option<PathBuf> {
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
/// [`crate::consent::source::fingerprint_of`]'s `mtime:size` fingerprint
/// format rather than inventing a second one, keyed alongside the path so
/// a rebuilt binary at the same path also re-probes.
fn git_probe_cache() -> &'static Mutex<HashMap<PathBuf, (String, GitAvailability)>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (String, GitAvailability)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Clears every cached `git` probe result. Test-only: every caller lives in
/// this module's `#[cfg(unix)]` git-probe tests, each of which wants a clean
/// cache before it runs its own fake `git`. Not a production "the operator
/// changed `PATH`" hook — this function never compiles into a release
/// build, so it cannot be one; a real hook for that would need its own,
/// non-`#[cfg(test)]` entry point.
#[cfg(all(test, unix))]
fn invalidate_git_probe_cache() {
    git_probe_cache()
        .lock()
        .expect("the git probe cache mutex is never poisoned")
        .clear();
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
    let path_var = match path_override {
        Some(value) => Some(value.to_os_string()),
        None => std::env::var_os("PATH"),
    };
    let Some(path_var) = path_var else {
        return Ok(GitAvailability {
            available: false,
            version: None,
        });
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
        move || which_in("git", &path_var)
    }))
    .await
    else {
        // Not found, or the walk itself could not finish in time — both
        // collapse to the identical "git not available" answer, mirroring
        // `detect_shells`'s own "an absent tool is not an error" contract:
        // a wedged `PATH` entry must degrade this probe, never surface as
        // a distinct "probe failed" shape, and never be cached (see
        // `git_probe_cache`'s own doc comment on caching only a definite,
        // successful answer).
        return Ok(GitAvailability {
            available: false,
            version: None,
        });
    };

    let fingerprint = match run_blocking({
        let git_path = git_path.clone();
        move || std::fs::metadata(&git_path)
    })
    .await
    {
        Ok(metadata) => fingerprint_of(&metadata),
        Err(_) => {
            return Ok(GitAvailability {
                available: false,
                version: None,
            });
        }
    };

    if let Some(cached) = lookup_git_cache(&git_path, &fingerprint) {
        return Ok(cached);
    }

    let budget = ChildBudget {
        deadline: GIT_PROBE_TIMEOUT,
        max_stdout_bytes: 4_096,
        max_stderr_bytes: 1_024,
    };
    match run_bounded_child(&git_path, &["--version"], None, budget, cancel).await {
        Ok(outcome) if outcome.status_success => {
            let version = parse_git_version(&String::from_utf8_lossy(&outcome.stdout));
            let availability = GitAvailability {
                available: true,
                version,
            };
            cache_git_result(git_path, fingerprint, availability.clone());
            Ok(availability)
        }
        Ok(_) => Ok(GitAvailability {
            available: false,
            version: None,
        }),
        Err(ChildRunError::Cancelled) => Err(GitProbeCancelled),
        Err(ChildRunError::TimedOut | ChildRunError::SpawnFailed(_)) => Ok(GitAvailability {
            available: false,
            version: None,
        }),
    }
}

fn lookup_git_cache(path: &Path, fingerprint: &str) -> Option<GitAvailability> {
    let cache = git_probe_cache()
        .lock()
        .expect("the git probe cache mutex is never poisoned");
    let (cached_fingerprint, availability) = cache.get(path)?;
    (cached_fingerprint == fingerprint).then(|| availability.clone())
}

fn cache_git_result(path: PathBuf, fingerprint: String, availability: GitAvailability) {
    let mut cache = git_probe_cache()
        .lock()
        .expect("the git probe cache mutex is never poisoned");
    cache.insert(path, (fingerprint, availability));
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

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use mangostudio_runtime_contract::catalog::method;
    use tokio_util::sync::CancellationToken;

    use super::{
        bounded_path_walk, build_capability_manifest, build_health_report, node_platform,
        parse_git_version, read_slot_state_and_source,
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
    use super::{
        detect_shells, git_probe_test_lock, invalidate_git_probe_cache,
        invalidate_shell_detection_cache, probe_git, shell_detection_test_lock,
    };
    #[cfg(unix)]
    use crate::runtime_home::write_runtime_slot_config;
    #[cfg(unix)]
    use mango_protocol::error::codes;
    #[cfg(unix)]
    use mangostudio_runtime_contract::manifest::RuntimeShellKind;
    #[cfg(unix)]
    use std::path::Path;

    fn scratch_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mango-health-test-{name}-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A directory usable as a synthetic `PATH` entry, containing one
    /// executable script named `git`.
    #[cfg(unix)]
    fn fake_git(name: &str, body: &str) -> (PathBuf, std::ffi::OsString) {
        use std::os::unix::fs::PermissionsExt;

        let dir = scratch_home(name);
        let path = dir.join("git");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        (dir.clone(), dir.into_os_string())
    }

    /// A directory usable as a synthetic `PATH` entry, containing one
    /// executable, empty script per name given — `detect_shells` never
    /// runs it, only checks that it exists and is executable.
    #[cfg(unix)]
    fn fake_shells_on_path(dir_name: &str, names: &[&str]) -> (PathBuf, std::ffi::OsString) {
        use std::os::unix::fs::PermissionsExt;

        let dir = scratch_home(dir_name);
        for name in names {
            let path = dir.join(name);
            std::fs::write(&path, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        (dir.clone(), dir.into_os_string())
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
        assert!(manifest.features.toolchain, "toolchain is unconditional");

        let wire = serde_json::to_value(&manifest).expect("serialises");
        assert!(
            mangostudio_runtime_contract::schemas::validate_manifest(&wire).is_ok(),
            "a manifest this crate builds for `hello` must validate against the same schema the \
             hub checks it with: {wire}"
        );
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

    /// [`git_probe_cache`]'s doc comment on [`detect_shells_caches_by_the_exact_path_value`]
    /// claims `probe_git` has "its own cache tests" proven the same way; no
    /// such test actually existed. This is that test: the fake `git` here
    /// appends to a counter file on every real invocation and reports a
    /// version derived from that count, while its own script file (and so
    /// its `mtime:size` fingerprint) never changes between the two probes
    /// below — a served-from-cache second call cannot observe a changed
    /// count or a bumped version; a second *live* run of the script would
    /// show both.
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
        let _exclusive = shell_detection_test_lock().lock().await;
        invalidate_shell_detection_cache();
        let (_dir, path_var) = fake_shells_on_path("shells-found", &["bash"]);

        let shells = detect_shells(Some(&path_var)).await;

        assert_eq!(shells, vec![RuntimeShellKind::Bash]);
    }

    /// Regression test for the amplification blocker 2 exists to close:
    /// `detect_shells` used to re-walk every `PATH` entry on every single
    /// call (`build_health_report` per RPC, `build_capability_manifest`
    /// per connection) with no cache at all — measured on a 54-entry `PATH`
    /// with three misses, ~210ms of every connection's own handshake, more
    /// than the (already cached, already timed) `git` child probe next to
    /// it. Proven here the same way `probe_git`'s own cache tests are:
    /// removing the fake shell after the first call, then asserting the
    /// second call for the *same* `PATH` value still reports it present —
    /// which only a served-from-cache answer could do, since a fresh walk
    /// of this `PATH` would now find nothing.
    #[cfg(unix)]
    #[tokio::test]
    async fn detect_shells_caches_by_the_exact_path_value() {
        let _exclusive = shell_detection_test_lock().lock().await;
        invalidate_shell_detection_cache();
        let (dir, path_var) = fake_shells_on_path("shells-cache", &["bash"]);

        let first = detect_shells(Some(&path_var)).await;
        assert_eq!(first, vec![RuntimeShellKind::Bash]);

        std::fs::remove_file(dir.join("bash")).unwrap();

        let second = detect_shells(Some(&path_var)).await;
        assert_eq!(
            second,
            vec![RuntimeShellKind::Bash],
            "a repeated PATH value must be served from cache, not re-walked"
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
