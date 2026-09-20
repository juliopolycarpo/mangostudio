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
    GitAvailability, PathStyle, RuntimeCapabilityAllow, RuntimeCapabilityManifest, RuntimeShellKind,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::blocking::run_blocking;
use crate::consent::config::resolve_runtime_slot_config;
use crate::consent::source::fingerprint_of;
use crate::registry::Registry;
use crate::runtime_home::{RuntimeSlot, home_dir, read_runtime_slot_config, slot_for_path};
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
    let state = read_runtime_slot_config(slot, mango_home);
    let fallback_source = resolve_source(mango_home);
    let resolved = resolve_runtime_slot_config(slot, state.stored.as_ref(), fallback_source);

    let shells: Vec<RuntimeShellKind> = if resolved.allow.shell {
        detect_shells().await
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
        "source": resolved.source,
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
    let state = read_runtime_slot_config(slot, mango_home);
    let fallback_source = resolve_source(mango_home);
    let resolved = resolve_runtime_slot_config(slot, state.stored.as_ref(), fallback_source);

    let shells: Vec<RuntimeShellKind> = if resolved.allow.shell {
        detect_shells().await
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
fn node_platform() -> &'static str {
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

/// Every shell kind actually found on `PATH`, in [`RuntimeShellKind`]'s own
/// declared order. A single [`run_blocking`] call walks `PATH` for all
/// three at once — this is a handful of `stat` calls, not the kind of work
/// worth three separate blocking-pool round trips.
async fn detect_shells() -> Vec<RuntimeShellKind> {
    run_blocking(|| {
        [
            RuntimeShellKind::Bash,
            RuntimeShellKind::Zsh,
            RuntimeShellKind::Powershell,
        ]
        .into_iter()
        .filter(|kind| {
            shell_path_candidates(*kind)
                .iter()
                .any(|name| which(name).is_some())
        })
        .collect()
    })
    .await
}

/// Resolves `name` against `PATH`, checking (on Unix) that it is actually
/// executable rather than merely present — mirrors `Bun.which`'s own check.
/// On Windows, `<name>.exe` is tried alongside the bare name.
fn which(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    which_in(name, &path_var)
}

/// [`which`], against an explicit `PATH` value rather than the real
/// environment — the seam [`probe_git`]'s tests use to point this crate's
/// own PATH walk at a temporary directory instead of mutating the real,
/// process-wide `PATH` (which every test in this binary shares).
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

    let Some(git_path) = run_blocking({
        let path_var = path_var.clone();
        move || which_in("git", &path_var)
    })
    .await
    else {
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

    use mangostudio_runtime_contract::catalog::method;
    use tokio_util::sync::CancellationToken;

    use super::{build_capability_manifest, build_health_report, node_platform, parse_git_version};
    use crate::registry::Registry;
    use crate::result_check::{check_result, compile_result_schema};
    use crate::runtime_home::RuntimeSlot;
    // Every caller of these lives behind `#[cfg(unix)]` below (the `git`
    // probe tests write and run a real Unix shell script) — gating the
    // imports the same way keeps a Windows build from reporting them (and,
    // fail-closed, `invalidate_git_probe_cache` itself) unused, which
    // `-D warnings` turns into a hard build failure rather than a lint note.
    #[cfg(unix)]
    use super::{invalidate_git_probe_cache, probe_git};
    #[cfg(unix)]
    use crate::runtime_home::write_runtime_slot_config;
    #[cfg(unix)]
    use mango_protocol::error::codes;
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
        invalidate_git_probe_cache();
        let (_dir, path_var) = fake_git("probe-ok", "echo 'git version 9.9.9'");
        let cancel = CancellationToken::new();

        let availability = probe_git(Some(&path_var), &cancel)
            .await
            .expect("a fast fake git must not be cancelled");
        assert!(availability.available);
        assert_eq!(availability.version.as_deref(), Some("9.9.9"));
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
