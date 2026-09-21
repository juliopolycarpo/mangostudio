//! The core binary scan every runtime definition shares, mirroring
//! `apps/shared/src/environments/detection/binary-scan.ts`'s `scanRuntime`:
//! generate binary candidates (`PATH` entries, well-known directories, a
//! configured path, optionally bare names), probe each with a caller-
//! supplied version probe, bounded by a per-candidate and a total deadline
//! and a concurrency limit, resolve symlink aliases, and attribute each
//! installation to a version manager or `bun`/`system` by path pattern.
//!
//! # Why concurrency here means real tasks, not cooperative polling
//!
//! The TypeScript original interleaves promises on a single-threaded event
//! loop — no real parallelism, just bounded fan-out. Rust has no such loop
//! to interleave `Future`s on without one; matching the bound (`N`
//! candidates in flight at once) means spawning real
//! [`tokio::task::JoinSet`] tasks, and a spawned task must own `'static`
//! data. [`BinaryScanDeps`] is therefore `Send + Sync + 'static` and always
//! passed in behind an [`std::sync::Arc`] — the same shape this crate's
//! other ports already use (see the module docs on
//! [`crate::probing::detection`]).
//!
//! # Deadline clock
//!
//! This module measures its total deadline with [`tokio::time::Instant`],
//! not a wall clock — unlike the TypeScript original, which uses
//! `Date.now()`. `tokio::time::Instant` advances with `tokio::time::pause`
//! in a test, so a fake probe that never resolves can prove the deadline
//! fires without a real multi-second sleep; see this module's own
//! `start_paused` test.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use tokio::time::Instant as TokioInstant;

use super::BoxFuture;
use super::path_env::{PathEnv, join_path};
use super::types::{
    PathSource, RuntimeFindingCode, RuntimeInstallation, RuntimeOrigin, SemVer, VersionManagerId,
};

/// One runtime's discovery recipe: which binary names to look for, how to
/// read its version output, and where to look beyond `PATH`.
///
/// All fields are `'static` data or function pointers, so every concrete
/// definition (see
/// [`crate::probing::detection::runtime_definitions`]) is a `const`, and
/// this whole struct is `Copy` — cheap to hand into a spawned task without
/// an `Arc`.
#[derive(Debug, Clone, Copy)]
pub struct RuntimeDefinition {
    /// Which runtime this definition is about.
    pub id: super::types::RuntimeId,
    /// The binary names to search for, in preference order.
    pub binary_names: &'static [&'static str],
    /// The argv appended to a candidate to ask for its version.
    pub version_args: &'static [&'static str],
    /// Parses a probe's raw stdout into a [`SemVer`], or `None` when it does
    /// not look like this runtime's version output at all.
    pub parse_version: fn(&str) -> Option<SemVer>,
    /// Whether a binary that ran but whose version output did not parse
    /// still counts as installed.
    ///
    /// Off by default, which drops the candidate exactly as a probe that
    /// never ran does. On, it survives as an installation with a `None`
    /// version — for a vendor CLI whose `--version` output drifts on its
    /// own release cadence, "ran but unreadable" is not "not installed".
    /// The finding that explains the `None` is
    /// [`crate::probing::detection::duplicate_analysis`]'s to raise, not
    /// this scan's.
    pub keep_unparsed_version: bool,
    /// Directories to search beyond `PATH`, given this scan's platform
    /// inputs.
    pub well_known_dirs: fn(&PathEnv) -> Vec<String>,
    /// Also probes the bare binary name, as a final OS-resolved fallback.
    pub include_bare_binary_names: bool,
}

/// A candidate that failed to become an installation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeScanFailure {
    /// Why this candidate failed. Reuses [`RuntimeFindingCode`] directly —
    /// [`crate::probing::detection::duplicate_analysis::analyze_runtime_scan`]
    /// copies it onto a [`super::types::RuntimeFinding`] verbatim, the same
    /// identity mapping the TypeScript original relies on
    /// (`{ code: failure.code, params: { path: failure.path } }`).
    pub code: RuntimeFindingCode,
    /// The candidate path that failed.
    pub path: String,
}

/// The outcome of one [`scan_runtime`] call.
#[derive(Debug, Clone, Default)]
pub struct RuntimeScanResult {
    /// Every installation the scan found.
    pub installations: Vec<RuntimeInstallation>,
    /// Every candidate that existed but did not become an installation.
    pub failures: Vec<RuntimeScanFailure>,
}

/// A candidate binary path, before it has been probed.
#[derive(Debug, Clone)]
struct BinaryCandidate {
    path: String,
    origin: RuntimeOrigin,
    path_index: Option<u32>,
    /// Whether [`BinaryScanDeps::path_exists`] must confirm this candidate
    /// before it is probed at all. `false` for a configured path (probed
    /// unconditionally, on the theory that a caller who names one means
    /// it) and for a bare binary name (left for the OS's own `PATH`
    /// resolution inside the probe itself).
    requires_existence_check: bool,
}

/// One probed candidate's outcome. The TypeScript original also has a
/// third, `null` outcome — "ran, but produced nothing worth keeping" (an
/// unreadable version on a definition that does not opt into
/// [`RuntimeDefinition::keep_unparsed_version`], or a bare-name/configured
/// candidate that never ran at all) — which this port keeps as `None` at
/// every call site rather than as a third enum variant, so the type itself
/// cannot represent "the value the caller must remember is not
/// there twice" (`None` vs. a lookalike `Dropped` variant that also skips
/// downstream processing).
#[derive(Debug, Clone)]
enum CandidateProbeResult {
    /// The candidate is a real installation.
    Installation {
        candidate: BinaryCandidate,
        path: String,
        /// `None` when the binary ran but its output did not parse, and
        /// [`RuntimeDefinition::keep_unparsed_version`] kept it anyway.
        version: Option<String>,
    },
    /// The candidate failed outright.
    Failure(RuntimeScanFailure),
}

/// A version-probing failure, opaque by design: the TypeScript original
/// discards a rejected probe's reason (`.then(ok, () => resolve({
/// timedOut: false, version: null }))`) and this port preserves that —
/// a probe that could not run for any reason reads exactly like one that
/// ran and produced nothing.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProbeError;

/// The filesystem/subprocess seams [`scan_runtime`] needs, mirroring
/// `binary-scan.ts`'s `BinaryScanDeps` interface. The optional TypeScript
/// fields (`maxConcurrency`, `probeTimeoutMs`, `totalTimeoutMs`,
/// `configuredPath`, `configuredOnly`, `stopWhen`) are not trait methods
/// here — they carry no I/O, so they live in [`BinaryScanOptions`] instead,
/// as plain data a caller constructs directly.
pub trait BinaryScanDeps: Send + Sync + 'static {
    /// This scan's platform, home directory and environment variables.
    fn path_env(&self) -> &PathEnv;
    /// Whether `path` exists on disk.
    fn path_exists(&self, path: &str) -> bool;
    /// Runs `binary` with `args`, waiting at most `timeout_ms`, and returns
    /// its version string, or `None` when it ran but produced nothing
    /// readable. See [`ProbeError`] for why a failure to even start counts
    /// the same as "ran, produced nothing".
    fn probe_version<'a>(
        &'a self,
        binary: &'a str,
        args: &'a [String],
        timeout_ms: u64,
    ) -> BoxFuture<'a, Result<Option<String>, ProbeError>>;
    /// Resolves `path` through any symlinks. A failure here is not fatal —
    /// [`scan_runtime`] falls back to the original path, mirroring
    /// `binary-scan.ts`'s own `resolveRealpath`.
    fn realpath<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<String, ()>>;
}

/// The scan-shaping knobs `binary-scan.ts` carries as optional fields on
/// `BinaryScanDeps` itself. Split out here because none of them are I/O —
/// see [`BinaryScanDeps`]'s own docs.
pub struct BinaryScanOptions {
    /// How many candidates may be probed at once.
    pub max_concurrency: usize,
    /// How long one candidate's probe may take, in milliseconds. `None`
    /// picks the platform default (`5_000` on `win32`, `2_000` elsewhere —
    /// see [`default_probe_timeout_ms`]'s docs for why Windows gets more).
    pub probe_timeout_ms: Option<u64>,
    /// How long the whole scan may take, in milliseconds, before every
    /// candidate still waiting is reported as [`RuntimeFindingCode::ProbeTimeout`]
    /// without ever being probed.
    pub total_timeout_ms: u64,
    /// A caller-supplied authoritative path, probed regardless of whether
    /// it exists.
    pub configured_path: Option<String>,
    /// When set alongside [`BinaryScanOptions::configured_path`], no other
    /// candidate is generated at all.
    pub configured_only: bool,
    /// Stops the scan once a probed version satisfies this predicate.
    /// Candidates are handed out in `PATH` order, so every candidate ahead
    /// of the match has already started and is still awaited — only
    /// strictly later ones are skipped.
    pub stop_when: Option<StopWhenPredicate>,
}

impl Default for BinaryScanOptions {
    fn default() -> Self {
        Self {
            max_concurrency: 4,
            probe_timeout_ms: None,
            total_timeout_ms: 5_000,
            configured_path: None,
            configured_only: false,
            stop_when: None,
        }
    }
}

/// A `stop_when` predicate: stops the scan once a probed version
/// satisfies it. A type alias rather than the raw trait-object type so
/// clippy's `type_complexity` lint has one name to point at instead of
/// spelling the bound out at every use site.
pub type StopWhenPredicate = Arc<dyn Fn(&str) -> bool + Send + Sync>;

const WINDOWS_EXECUTABLE_EXTENSIONS: [&str; 4] = [".exe", ".cmd", ".bat", ".com"];
const WINDOWS_PATHEXT_FALLBACK: &str = ".EXE;.CMD;.BAT;.COM";

/// How long one `--version` call may take before the candidate is
/// discarded.
///
/// Windows gets longer because what sits on `PATH` there is usually not
/// the program. Vendor CLIs install as a `.cmd` shim that starts a runtime
/// that loads a bundled script: `cursor-agent --version` measured **~2.1s**
/// on Windows against well under a second for the same version on Linux,
/// where the binary is native. At the POSIX budget the shim was killed
/// mid-answer and the CLI was reported as not installed — a real install,
/// on `PATH`, signed in.
#[must_use]
pub fn default_probe_timeout_ms(platform: &str) -> u64 {
    if platform == "win32" { 5_000 } else { 2_000 }
}

/// The binary names [`scan_runtime`] searches for, including every
/// win32 `PATHEXT` extension a definition's bare names could carry.
#[must_use]
pub fn binary_candidate_names(
    definition: &RuntimeDefinition,
    platform: &str,
    env: &HashMap<String, String>,
) -> Vec<String> {
    if platform != "win32" {
        return definition
            .binary_names
            .iter()
            .map(|name| (*name).to_string())
            .collect();
    }

    let pathext_owned;
    let pathext = match env.get("PATHEXT").map(|value| value.trim()) {
        Some(value) if !value.is_empty() => value,
        _ => {
            pathext_owned = WINDOWS_PATHEXT_FALLBACK.to_string();
            pathext_owned.as_str()
        }
    };

    let mut names = Vec::new();
    for binary_name in definition.binary_names {
        for raw_extension in pathext.split(';') {
            let extension = raw_extension.trim().to_lowercase();
            if !WINDOWS_EXECUTABLE_EXTENSIONS.contains(&extension.as_str()) {
                continue;
            }
            let candidate_name = format!("{binary_name}{extension}");
            if !names.contains(&candidate_name) {
                names.push(candidate_name);
            }
        }
        names.push((*binary_name).to_string());
    }
    names
}

/// Appends one candidate per name under `directory`, skipping any path
/// already seen (case-insensitively on `win32`).
fn append_directory(
    candidates: &mut Vec<BinaryCandidate>,
    seen: &mut HashSet<String>,
    names: &[String],
    platform: &str,
    directory: &str,
    origin: RuntimeOrigin,
    path_index: Option<u32>,
) {
    for name in names {
        let joined = join_path(platform, &[directory, name]);
        let key = if platform == "win32" {
            joined.to_lowercase()
        } else {
            joined.clone()
        };
        if !seen.insert(key) {
            continue;
        }
        candidates.push(BinaryCandidate {
            path: joined,
            origin,
            path_index,
            requires_existence_check: true,
        });
    }
}

/// Generates every candidate [`scan_runtime`] will consider, in the order
/// they should be probed: the configured path first, then `PATH` in shell
/// resolution order, then well-known directories, then bare names.
///
/// `PATH`'s index counts *every* segment split from the raw string,
/// including an empty one from a doubled separator (`/a::/b` gives `/b`
/// index `2`) — the index is a position in the shell's own list, not a
/// count of the directories that survived filtering, mirroring
/// `binary-scan.ts`'s `pathEntries.entries()` running before its `if
/// (!directory) continue`.
fn iterate_binary_candidates(
    definition: &RuntimeDefinition,
    path_env: &PathEnv,
    options: &BinaryScanOptions,
) -> Vec<BinaryCandidate> {
    let mut candidates = Vec::new();

    let configured_path = options
        .configured_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty());
    if let Some(configured) = configured_path {
        candidates.push(BinaryCandidate {
            path: configured.to_string(),
            origin: RuntimeOrigin::Configured,
            path_index: None,
            requires_existence_check: false,
        });
        if options.configured_only {
            return candidates;
        }
    }

    let names = binary_candidate_names(definition, &path_env.platform, &path_env.env);
    let list_separator = if path_env.is_windows() { ';' } else { ':' };
    let path_value = path_env.env_var("PATH").unwrap_or("");
    let mut seen = HashSet::new();

    for (index, directory) in path_value.split(list_separator).map(str::trim).enumerate() {
        if directory.is_empty() {
            continue;
        }
        append_directory(
            &mut candidates,
            &mut seen,
            &names,
            &path_env.platform,
            directory,
            RuntimeOrigin::Path,
            Some(index as u32),
        );
    }
    for directory in (definition.well_known_dirs)(path_env) {
        append_directory(
            &mut candidates,
            &mut seen,
            &names,
            &path_env.platform,
            &directory,
            RuntimeOrigin::WellKnown,
            None,
        );
    }
    if definition.include_bare_binary_names {
        for name in &names {
            candidates.push(BinaryCandidate {
                path: name.clone(),
                origin: RuntimeOrigin::Path,
                path_index: None,
                requires_existence_check: false,
            });
        }
    }

    candidates
}

async fn resolve_realpath(path: &str, deps: &dyn BinaryScanDeps) -> String {
    match deps.realpath(path).await {
        Ok(resolved) => resolved,
        Err(()) => path.to_string(),
    }
}

/// Lowercases and forward-slashes `path` — the form every path-pattern
/// comparison in this module runs against.
#[must_use]
pub fn normalized_path(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

/// [`normalized_path`], with any trailing separators removed — version-
/// manager roots are compared as prefixes, so a trailing separator would
/// make an exact-root match miss.
fn normalized_root(path: &str) -> String {
    normalized_path(path.trim())
        .trim_end_matches('/')
        .to_string()
}

/// fnm's root on Windows when `FNM_DIR` is unset, mirroring the POSIX
/// `~/.local/share/fnm` fallback: fnm's own Windows installer sets neither
/// an environment variable nor a registry key for its default,
/// `%APPDATA%\fnm`, so an install left at that default would read as
/// `system` without this.
#[must_use]
pub fn windows_default_fnm_dir(path_env: &PathEnv) -> Option<String> {
    if !path_env.is_windows() {
        return None;
    }
    let appdata = path_env.env_var("APPDATA")?.trim();
    if appdata.is_empty() {
        return None;
    }
    Some(join_path("win32", &[appdata, "fnm"]))
}

fn detect_version_manager(
    raw_path: &str,
    realpath: &str,
    path_env: &PathEnv,
) -> Option<VersionManagerId> {
    let paths = [normalized_path(raw_path), normalized_path(realpath)];
    let fnm_default = windows_default_fnm_dir(path_env);

    let configured_roots: [(VersionManagerId, Vec<Option<String>>); 3] = [
        (
            VersionManagerId::Nvm,
            vec![
                path_env.env_var("NVM_DIR").map(str::to_string),
                path_env.env_var("NVM_HOME").map(str::to_string),
                path_env.env_var("NVM_SYMLINK").map(str::to_string),
            ],
        ),
        (
            VersionManagerId::Fnm,
            vec![path_env.env_var("FNM_DIR").map(str::to_string), fnm_default],
        ),
        (
            VersionManagerId::Volta,
            vec![path_env.env_var("VOLTA_HOME").map(str::to_string)],
        ),
    ];

    for (manager, roots) in configured_roots {
        let normalized_roots: Vec<String> = roots
            .into_iter()
            .flatten()
            .map(|root| root.trim().to_string())
            .filter(|root| !root.is_empty())
            .map(|root| normalized_root(&root))
            .filter(|root| !root.is_empty())
            .collect();
        if normalized_roots.iter().any(|root| {
            paths
                .iter()
                .any(|path| path.starts_with(&format!("{root}/")))
        }) {
            return Some(manager);
        }
    }

    if paths
        .iter()
        .any(|path| path.contains("/.nvm/") || path.contains("/nvm/versions/"))
    {
        return Some(VersionManagerId::Nvm);
    }
    if paths.iter().any(|path| {
        path.contains("/.fnm/")
            || path.contains("/.local/share/fnm/")
            // macOS default root; `normalized_path` lowercases but keeps spaces.
            || path.contains("/library/application support/fnm/")
            || path.contains("/fnm_multishells/")
    }) {
        return Some(VersionManagerId::Fnm);
    }
    if paths.iter().any(|path| path.contains("/.volta/")) {
        return Some(VersionManagerId::Volta);
    }
    None
}

/// Whether `path` resolves under `BUN_INSTALL`, or Bun's own `~/.bun`
/// default.
fn is_bun_managed_path(path: &str, path_env: &PathEnv) -> bool {
    let normalized_target = normalized_path(path);
    let mut roots = Vec::new();
    if let Some(bun_install) = path_env.env_var("BUN_INSTALL")
        && !bun_install.trim().is_empty()
    {
        roots.push(normalized_root(bun_install));
    }
    roots.push(normalized_root(&format!("{}/.bun", path_env.home_dir)));
    roots
        .iter()
        .any(|root| normalized_target.starts_with(&format!("{root}/")))
}

/// Who put an installation where it is, as far as the scanner can tell.
/// `winget` is never assigned here — see
/// [`crate::probing::detection::winget_ownership`], which attributes it
/// after the scan, from a live probe.
fn resolve_path_source(
    raw_path: &str,
    resolved_path: &str,
    managed_by: Option<VersionManagerId>,
    path_env: &PathEnv,
) -> PathSource {
    if let Some(managed_by) = managed_by {
        return match managed_by {
            VersionManagerId::Nvm => PathSource::Nvm,
            VersionManagerId::Fnm => PathSource::Fnm,
            VersionManagerId::Volta => PathSource::Volta,
        };
    }
    if is_bun_managed_path(raw_path, path_env) || is_bun_managed_path(resolved_path, path_env) {
        return PathSource::Bun;
    }
    PathSource::System
}

/// Probes one candidate, honoring both the per-candidate and the total
/// scan deadline. Returns `None` for a candidate that ran but produced
/// nothing worth keeping and was never required to exist in the first
/// place (a bare name or a configured path) — see [`CandidateProbeResult`]'s
/// docs.
async fn probe_one_candidate(
    candidate: &BinaryCandidate,
    definition: &RuntimeDefinition,
    deps: &dyn BinaryScanDeps,
    options: &BinaryScanOptions,
    deadline: TokioInstant,
    platform: &str,
) -> Option<CandidateProbeResult> {
    let now = TokioInstant::now();
    // A candidate discovered after the scan's own total budget has run out
    // is reported as timed out without ever being probed — this is the
    // deadline this module's mutation test guards.
    if now >= deadline {
        return Some(CandidateProbeResult::Failure(RuntimeScanFailure {
            code: RuntimeFindingCode::ProbeTimeout,
            path: candidate.path.clone(),
        }));
    }
    let remaining = deadline.saturating_duration_since(now);
    let configured_timeout = Duration::from_millis(
        options
            .probe_timeout_ms
            .unwrap_or_else(|| default_probe_timeout_ms(platform)),
    );
    let timeout_duration = remaining.min(configured_timeout);

    let args: Vec<String> = definition
        .version_args
        .iter()
        .map(|arg| (*arg).to_string())
        .collect();
    let probe = deps.probe_version(&candidate.path, &args, timeout_duration.as_millis() as u64);
    let probed = tokio::time::timeout(timeout_duration, probe).await;

    let version = match probed {
        Err(_elapsed) => {
            return Some(CandidateProbeResult::Failure(RuntimeScanFailure {
                code: RuntimeFindingCode::ProbeTimeout,
                path: candidate.path.clone(),
            }));
        }
        // A probe that could not even run reads the same as one that ran
        // and produced nothing — see `ProbeError`'s docs.
        Ok(Err(ProbeError)) => None,
        Ok(Ok(version)) => version,
    };
    let version = version
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let Some(version) = version else {
        return if candidate.requires_existence_check {
            Some(CandidateProbeResult::Failure(RuntimeScanFailure {
                code: RuntimeFindingCode::NotExecutable,
                path: candidate.path.clone(),
            }))
        } else {
            None
        };
    };

    if (definition.parse_version)(&version).is_none() {
        // A definition that opts in trades the raw failure for a known
        // installation with an unreadable version: the binary answered, so
        // "not installed" would be the wrong story. One that does not opt
        // in keeps the old failure/drop split.
        if definition.keep_unparsed_version {
            let resolved = resolve_realpath(&candidate.path, deps).await;
            return Some(CandidateProbeResult::Installation {
                candidate: candidate.clone(),
                path: resolved,
                version: None,
            });
        }
        return if candidate.requires_existence_check {
            Some(CandidateProbeResult::Failure(RuntimeScanFailure {
                code: RuntimeFindingCode::NotExecutable,
                path: candidate.path.clone(),
            }))
        } else {
            None
        };
    }

    let resolved = resolve_realpath(&candidate.path, deps).await;
    Some(CandidateProbeResult::Installation {
        candidate: candidate.clone(),
        path: resolved,
        version: Some(version),
    })
}

/// Probes `candidates` with at most `options.max_concurrency` in flight at
/// once, stopping every candidate strictly after the first one
/// `options.stop_when` accepts. `results[i]` is `None` for a skipped or
/// dropped candidate, mirroring `mapWithConcurrency`'s own array of holes.
async fn probe_candidates_bounded(
    candidates: Arc<Vec<BinaryCandidate>>,
    definition: RuntimeDefinition,
    deps: Arc<dyn BinaryScanDeps>,
    options: Arc<BinaryScanOptions>,
    deadline: TokioInstant,
    platform: String,
) -> Vec<Option<CandidateProbeResult>> {
    let len = candidates.len();
    let results = Arc::new(std::sync::Mutex::new(
        (0..len)
            .map(|_| None)
            .collect::<Vec<Option<CandidateProbeResult>>>(),
    ));
    let next_index = Arc::new(AtomicUsize::new(0));
    let terminal_index = Arc::new(AtomicUsize::new(usize::MAX));
    let worker_count = len.min(options.max_concurrency.max(1));

    let mut workers = tokio::task::JoinSet::new();
    for _ in 0..worker_count {
        let candidates = Arc::clone(&candidates);
        let deps = Arc::clone(&deps);
        let options = Arc::clone(&options);
        let results = Arc::clone(&results);
        let next_index = Arc::clone(&next_index);
        let terminal_index = Arc::clone(&terminal_index);
        let platform = platform.clone();
        workers.spawn(async move {
            loop {
                let index = next_index.fetch_add(1, Ordering::SeqCst);
                if index >= candidates.len() || index > terminal_index.load(Ordering::SeqCst) {
                    break;
                }
                let candidate = candidates[index].clone();
                let result = probe_one_candidate(
                    &candidate,
                    &definition,
                    deps.as_ref(),
                    options.as_ref(),
                    deadline,
                    &platform,
                )
                .await;
                let is_terminal = matches!(
                    &result,
                    Some(CandidateProbeResult::Installation { version: Some(version), .. })
                        if options.stop_when.as_ref().is_some_and(|predicate| predicate(version))
                );
                results
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)[index] = result;
                if is_terminal {
                    terminal_index.fetch_min(index, Ordering::SeqCst);
                }
            }
        });
    }
    while workers.join_next().await.is_some() {}

    Arc::try_unwrap(results)
        .map(|mutex| {
            mutex
                .into_inner()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
        })
        .unwrap_or_default()
}

/// Scans for every installation of `definition`, mirroring
/// `binary-scan.ts`'s `scanRuntime` exactly — same candidate order, same
/// alias/version-manager attribution, same deadline behavior. See the
/// module docs for why concurrency is real tasks here rather than
/// cooperative polling.
pub async fn scan_runtime(
    definition: &RuntimeDefinition,
    deps: Arc<dyn BinaryScanDeps>,
    options: BinaryScanOptions,
) -> RuntimeScanResult {
    let path_env = deps.path_env().clone();
    let mut candidates = iterate_binary_candidates(definition, &path_env, &options);
    candidates.retain(|candidate| {
        !candidate.requires_existence_check || deps.path_exists(&candidate.path)
    });

    let deadline = TokioInstant::now() + Duration::from_millis(options.total_timeout_ms);
    let candidates = Arc::new(candidates);
    let options = Arc::new(options);
    let probe_results = probe_candidates_bounded(
        candidates,
        *definition,
        Arc::clone(&deps),
        options,
        deadline,
        path_env.platform.clone(),
    )
    .await;

    let mut installations = Vec::new();
    let mut failures = Vec::new();
    let mut first_path_by_realpath: HashMap<String, String> = HashMap::new();
    let mut has_effective_installation = false;

    for probe_result in probe_results.into_iter().flatten() {
        match probe_result {
            CandidateProbeResult::Failure(failure) => failures.push(failure),
            CandidateProbeResult::Installation {
                candidate,
                path,
                version,
            } => {
                let realpath_key = if path_env.is_windows() {
                    path.to_lowercase()
                } else {
                    path.clone()
                };
                let alias_of = first_path_by_realpath.get(&realpath_key).cloned();
                first_path_by_realpath
                    .entry(realpath_key)
                    .or_insert_with(|| candidate.path.clone());

                let managed_by = detect_version_manager(&candidate.path, &path, &path_env);
                // Only candidates discovered through `PATH` can win normal
                // shell lookup. Version-manager binaries retain that
                // provenance through `path_index`.
                let origin = if candidate.origin == RuntimeOrigin::Configured {
                    RuntimeOrigin::Configured
                } else if managed_by.is_some() {
                    RuntimeOrigin::VersionManager
                } else {
                    candidate.origin
                };
                let effective =
                    candidate.origin == RuntimeOrigin::Path && !has_effective_installation;
                has_effective_installation |= effective;
                let path_source =
                    resolve_path_source(&candidate.path, &path, managed_by, &path_env);

                installations.push(RuntimeInstallation {
                    path,
                    raw_path: candidate.path,
                    version,
                    origin,
                    path_index: candidate.path_index,
                    effective,
                    alias_of,
                    managed_by,
                    path_source: Some(path_source),
                });
            }
        }
    }

    RuntimeScanResult {
        installations,
        failures,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex as StdMutex;

    use super::*;
    use crate::probing::detection::types::RuntimeId;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    fn node_definition() -> RuntimeDefinition {
        RuntimeDefinition {
            id: RuntimeId::Node,
            binary_names: &["node"],
            version_args: &["--version"],
            parse_version: |raw| {
                let trimmed = raw.trim().strip_prefix('v').unwrap_or(raw.trim());
                let mut parts = trimmed.splitn(3, '.');
                Some(SemVer {
                    major: parts.next()?.parse().ok()?,
                    minor: parts.next()?.parse().ok()?,
                    patch: parts.next()?.parse().ok()?,
                })
            },
            keep_unparsed_version: false,
            well_known_dirs: |_| Vec::new(),
            include_bare_binary_names: false,
        }
    }

    /// A named fake standing in for the real PATH/subprocess adapter wave
    /// two builds. Configurable per test through its public fields rather
    /// than an ad hoc inline closure, per this repository's fake-object
    /// convention.
    #[derive(Default)]
    struct FakeBinaryScanDeps {
        path_env: PathEnv,
        existing: HashSet<String>,
        /// Canned `probe_version` responses, keyed by candidate path.
        /// Absent means "ran, produced nothing".
        responses: HashMap<String, String>,
        /// Paths whose probe never resolves — for deadline tests.
        pending: HashSet<String>,
        realpath_map: HashMap<String, String>,
        /// Every path `probe_version` was actually invoked for, in call
        /// order — what the deadline mutation test inspects.
        calls: Arc<StdMutex<Vec<String>>>,
        /// Every `timeout_ms` this fake actually received, in call order —
        /// what the probe-budget-by-platform tests inspect.
        timeouts_seen: Arc<StdMutex<Vec<u64>>>,
    }

    impl BinaryScanDeps for FakeBinaryScanDeps {
        fn path_env(&self) -> &PathEnv {
            &self.path_env
        }

        fn path_exists(&self, path: &str) -> bool {
            self.existing.contains(path)
        }

        fn probe_version<'a>(
            &'a self,
            binary: &'a str,
            _args: &'a [String],
            timeout_ms: u64,
        ) -> BoxFuture<'a, Result<Option<String>, ProbeError>> {
            self.calls
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(binary.to_string());
            self.timeouts_seen
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(timeout_ms);
            let pending = self.pending.contains(binary);
            let response = self.responses.get(binary).cloned();
            Box::pin(async move {
                if pending {
                    std::future::pending::<()>().await;
                }
                Ok(response)
            })
        }

        fn realpath<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<String, ()>> {
            let resolved = self
                .realpath_map
                .get(path)
                .cloned()
                .unwrap_or_else(|| path.to_string());
            Box::pin(async move { Ok(resolved) })
        }
    }

    fn linux_env(path: &str) -> PathEnv {
        PathEnv {
            platform: "linux".to_string(),
            home_dir: "/home/tester".to_string(),
            env: env(&[("PATH", path)]),
        }
    }

    #[tokio::test]
    async fn returns_every_working_path_installation_in_shell_resolution_order() {
        let deps = Arc::new(FakeBinaryScanDeps {
            path_env: linux_env("/first/bin:/second/bin"),
            existing: HashSet::from([
                "/first/bin/node".to_string(),
                "/second/bin/node".to_string(),
            ]),
            responses: HashMap::from([
                ("/first/bin/node".to_string(), "v20.11.0".to_string()),
                ("/second/bin/node".to_string(), "v22.13.0".to_string()),
            ]),
            ..Default::default()
        });

        let result = scan_runtime(&node_definition(), deps, BinaryScanOptions::default()).await;

        assert_eq!(result.installations.len(), 2);
        assert_eq!(result.installations[0].raw_path, "/first/bin/node");
        assert_eq!(result.installations[0].path_index, Some(0));
        assert!(result.installations[0].effective);
        assert_eq!(
            result.installations[0].path_source,
            Some(PathSource::System)
        );
        assert_eq!(result.installations[1].raw_path, "/second/bin/node");
        assert_eq!(result.installations[1].path_index, Some(1));
        assert!(!result.installations[1].effective);
    }

    #[tokio::test]
    async fn marks_a_later_path_resolving_to_the_same_binary_as_an_alias() {
        let deps = Arc::new(FakeBinaryScanDeps {
            path_env: linux_env("/usr/local/bin:/home/tester/.nvm/current/bin"),
            existing: HashSet::from([
                "/usr/local/bin/node".to_string(),
                "/home/tester/.nvm/current/bin/node".to_string(),
            ]),
            responses: HashMap::from([
                ("/usr/local/bin/node".to_string(), "v22.13.0".to_string()),
                (
                    "/home/tester/.nvm/current/bin/node".to_string(),
                    "v22.13.0".to_string(),
                ),
            ]),
            realpath_map: HashMap::from([
                (
                    "/usr/local/bin/node".to_string(),
                    "/home/tester/.nvm/versions/node/v22.13.0/bin/node".to_string(),
                ),
                (
                    "/home/tester/.nvm/current/bin/node".to_string(),
                    "/home/tester/.nvm/versions/node/v22.13.0/bin/node".to_string(),
                ),
            ]),
            ..Default::default()
        });

        let result = scan_runtime(&node_definition(), deps, BinaryScanOptions::default()).await;

        assert_eq!(result.installations.len(), 2);
        assert!(result.installations[0].alias_of.is_none());
        assert_eq!(
            result.installations[1].alias_of.as_deref(),
            Some("/usr/local/bin/node")
        );
        assert!(!result.installations[1].effective);
    }

    #[tokio::test]
    async fn returns_partial_results_with_a_timeout_failure_instead_of_hanging() {
        let deps = Arc::new(FakeBinaryScanDeps {
            path_env: linux_env("/fast/bin:/stalled/bin"),
            existing: HashSet::from([
                "/fast/bin/node".to_string(),
                "/stalled/bin/node".to_string(),
            ]),
            responses: HashMap::from([("/fast/bin/node".to_string(), "v22.13.0".to_string())]),
            pending: HashSet::from(["/stalled/bin/node".to_string()]),
            ..Default::default()
        });

        let options = BinaryScanOptions {
            total_timeout_ms: 20,
            ..Default::default()
        };
        let result = scan_runtime(&node_definition(), deps, options).await;

        assert_eq!(result.installations.len(), 1);
        assert_eq!(result.installations[0].raw_path, "/fast/bin/node");
        assert!(
            result
                .failures
                .iter()
                .any(|failure| failure.code == RuntimeFindingCode::ProbeTimeout
                    && failure.path == "/stalled/bin/node")
        );
    }

    #[tokio::test]
    async fn identifies_a_path_installation_owned_by_a_version_manager() {
        let node_path = "/home/tester/.volta/bin/node";
        let deps = Arc::new(FakeBinaryScanDeps {
            path_env: linux_env("/home/tester/.volta/bin"),
            existing: HashSet::from([node_path.to_string()]),
            responses: HashMap::from([(node_path.to_string(), "v22.13.0".to_string())]),
            ..Default::default()
        });

        let result = scan_runtime(&node_definition(), deps, BinaryScanOptions::default()).await;

        assert_eq!(
            result.installations[0].origin,
            RuntimeOrigin::VersionManager
        );
        assert_eq!(
            result.installations[0].managed_by,
            Some(VersionManagerId::Volta)
        );
        assert_eq!(result.installations[0].path_source, Some(PathSource::Volta));
    }

    #[tokio::test]
    async fn classifies_a_win32_fnm_node_under_the_default_appdata_alias_with_no_fnm_dir_set() {
        // `node_definition()` here carries no well-known directories of its
        // own (that ladder belongs to
        // `crate::probing::detection::runtime_definitions`, ported and
        // tested separately) — the alias directory is put on `PATH`
        // directly, which is enough to prove `detect_version_manager`'s
        // path-pattern attribution without depending on that other module.
        let node_path = "C:\\Users\\x\\AppData\\Roaming\\fnm\\aliases\\default\\node.exe";
        let deps = Arc::new(FakeBinaryScanDeps {
            path_env: PathEnv {
                platform: "win32".to_string(),
                home_dir: "C:\\Users\\x".to_string(),
                env: env(&[
                    (
                        "PATH",
                        "C:\\Users\\x\\AppData\\Roaming\\fnm\\aliases\\default",
                    ),
                    ("APPDATA", "C:\\Users\\x\\AppData\\Roaming"),
                ]),
            },
            existing: HashSet::from([node_path.to_string()]),
            responses: HashMap::from([(node_path.to_string(), "v24.9.0".to_string())]),
            ..Default::default()
        });

        let result = scan_runtime(&node_definition(), deps, BinaryScanOptions::default()).await;

        assert_eq!(
            result.installations[0].managed_by,
            Some(VersionManagerId::Fnm)
        );
        assert_eq!(result.installations[0].path_source, Some(PathSource::Fnm));
    }

    #[tokio::test]
    async fn attributes_a_plain_system_install_to_nothing() {
        let deps = Arc::new(FakeBinaryScanDeps {
            path_env: linux_env("/usr/bin"),
            existing: HashSet::from(["/usr/bin/node".to_string()]),
            responses: HashMap::from([("/usr/bin/node".to_string(), "v22.13.0".to_string())]),
            ..Default::default()
        });

        let result = scan_runtime(&node_definition(), deps, BinaryScanOptions::default()).await;

        assert_eq!(
            result.installations[0].path_source,
            Some(PathSource::System)
        );
        assert!(result.installations[0].managed_by.is_none());
    }

    #[tokio::test]
    async fn treats_an_authoritative_configured_binary_as_the_only_candidate() {
        let deps = Arc::new(FakeBinaryScanDeps {
            path_env: linux_env("/path/bin"),
            responses: HashMap::from([("/opt/custom/node".to_string(), "v22.13.0".to_string())]),
            ..Default::default()
        });
        let options = BinaryScanOptions {
            configured_path: Some("/opt/custom/node".to_string()),
            configured_only: true,
            ..Default::default()
        };

        let result = scan_runtime(&node_definition(), deps, options).await;

        assert_eq!(result.installations.len(), 1);
        assert_eq!(result.installations[0].origin, RuntimeOrigin::Configured);
        assert!(!result.installations[0].effective);
    }

    #[tokio::test]
    async fn reports_an_existing_binary_that_cannot_return_a_valid_version() {
        let deps = Arc::new(FakeBinaryScanDeps {
            path_env: linux_env("/broken/bin"),
            existing: HashSet::from(["/broken/bin/node".to_string()]),
            ..Default::default()
        });

        let result = scan_runtime(&node_definition(), deps, BinaryScanOptions::default()).await;

        assert!(result.installations.is_empty());
        assert!(
            result
                .failures
                .iter()
                .any(|failure| failure.code == RuntimeFindingCode::NotExecutable
                    && failure.path == "/broken/bin/node")
        );
    }

    #[tokio::test]
    async fn honors_windows_pathext_order_when_locating_command_shims() {
        let deps = Arc::new(FakeBinaryScanDeps {
            path_env: PathEnv {
                platform: "win32".to_string(),
                home_dir: "C:\\Users\\tester".to_string(),
                env: env(&[("PATH", "C:\\tools"), ("PATHEXT", ".COM;.EXE;.BAT;.CMD")]),
            },
            existing: HashSet::from(["C:\\tools\\node.cmd".to_string()]),
            responses: HashMap::from([("C:\\tools\\node.cmd".to_string(), "v22.13.0".to_string())]),
            ..Default::default()
        });

        let result = scan_runtime(&node_definition(), deps, BinaryScanOptions::default()).await;

        assert_eq!(result.installations[0].raw_path, "C:\\tools\\node.cmd");
    }

    #[tokio::test]
    async fn stops_probing_once_stop_when_accepts_a_candidate() {
        let deps = Arc::new(FakeBinaryScanDeps {
            path_env: linux_env("/a/bin:/b/bin:/c/bin"),
            existing: HashSet::from([
                "/a/bin/node".to_string(),
                "/b/bin/node".to_string(),
                "/c/bin/node".to_string(),
            ]),
            responses: HashMap::from([
                ("/a/bin/node".to_string(), "v20.11.0".to_string()),
                ("/b/bin/node".to_string(), "v22.13.0".to_string()),
                ("/c/bin/node".to_string(), "v24.0.0".to_string()),
            ]),
            ..Default::default()
        });
        let options = BinaryScanOptions {
            max_concurrency: 1,
            stop_when: Some(Arc::new(|version: &str| version == "v22.13.0")),
            ..Default::default()
        };

        let result = scan_runtime(&node_definition(), deps, options).await;

        let probed: Vec<String> = result
            .installations
            .iter()
            .map(|installation| installation.raw_path.clone())
            .collect();
        assert_eq!(
            probed,
            vec!["/a/bin/node".to_string(), "/b/bin/node".to_string()]
        );
    }

    #[tokio::test]
    async fn keeps_scanning_every_candidate_when_stop_when_is_absent() {
        let deps = Arc::new(FakeBinaryScanDeps {
            path_env: linux_env("/a/bin:/b/bin:/c/bin"),
            existing: HashSet::from([
                "/a/bin/node".to_string(),
                "/b/bin/node".to_string(),
                "/c/bin/node".to_string(),
            ]),
            responses: HashMap::from([
                ("/a/bin/node".to_string(), "v20.11.0".to_string()),
                ("/b/bin/node".to_string(), "v22.13.0".to_string()),
                ("/c/bin/node".to_string(), "v24.0.0".to_string()),
            ]),
            ..Default::default()
        });
        let options = BinaryScanOptions {
            max_concurrency: 1,
            ..Default::default()
        };

        let result = scan_runtime(&node_definition(), deps, options).await;

        assert_eq!(result.installations.len(), 3);
    }

    /// Mutation test 4: delete the `now >= deadline` early return inside
    /// `probe_one_candidate` and this goes red on **call count**, not
    /// duration — the pre-fix failure, pasted verbatim from a local run
    /// with that guard removed:
    ///
    /// ```text
    /// thread 'probing::detection::binary_scan::tests::never_probes_a_candidate_past_the_total_deadline' panicked at crates/mangostudio-runtime/src/probing/detection/binary_scan.rs:1216:9:
    /// assertion `left == right` failed: candidates after the deadline must never be probed at all
    ///   left: 3
    ///  right: 1
    /// ```
    #[tokio::test(start_paused = true)]
    async fn never_probes_a_candidate_past_the_total_deadline() {
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let deps = Arc::new(FakeBinaryScanDeps {
            path_env: linux_env("/a/bin:/b/bin:/c/bin"),
            existing: HashSet::from([
                "/a/bin/node".to_string(),
                "/b/bin/node".to_string(),
                "/c/bin/node".to_string(),
            ]),
            pending: HashSet::from([
                "/a/bin/node".to_string(),
                "/b/bin/node".to_string(),
                "/c/bin/node".to_string(),
            ]),
            calls: Arc::clone(&calls),
            ..Default::default()
        });
        let options = BinaryScanOptions {
            max_concurrency: 1,
            total_timeout_ms: 100,
            probe_timeout_ms: Some(100),
            ..Default::default()
        };

        let result = scan_runtime(&node_definition(), deps, options).await;

        assert_eq!(
            calls.lock().unwrap().len(),
            1,
            "candidates after the deadline must never be probed at all"
        );
        assert_eq!(result.failures.len(), 3);
        assert!(
            result
                .failures
                .iter()
                .all(|failure| failure.code == RuntimeFindingCode::ProbeTimeout)
        );
    }

    // `start_paused` keeps the clock still between computing the deadline
    // and calling the probe, so `remaining` never ticks down by a real
    // millisecond and these exact-value assertions stay deterministic.
    #[tokio::test(start_paused = true)]
    async fn gives_a_windows_shim_the_larger_platform_default_timeout() {
        let deps = Arc::new(FakeBinaryScanDeps {
            path_env: PathEnv {
                platform: "win32".to_string(),
                home_dir: "C:\\Users\\tester".to_string(),
                env: env(&[("PATH", "C:\\tools"), ("PATHEXT", ".CMD")]),
            },
            existing: HashSet::from(["C:\\tools\\node.cmd".to_string()]),
            responses: HashMap::from([("C:\\tools\\node.cmd".to_string(), "v22.13.0".to_string())]),
            ..Default::default()
        });
        let timeouts = Arc::clone(&deps.timeouts_seen);

        scan_runtime(&node_definition(), deps, BinaryScanOptions::default()).await;

        assert_eq!(*timeouts.lock().unwrap(), vec![5_000]);
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_the_tighter_linux_default_timeout() {
        let deps = Arc::new(FakeBinaryScanDeps {
            path_env: linux_env("/usr/bin"),
            existing: HashSet::from(["/usr/bin/node".to_string()]),
            responses: HashMap::from([("/usr/bin/node".to_string(), "v22.13.0".to_string())]),
            ..Default::default()
        });
        let timeouts = Arc::clone(&deps.timeouts_seen);

        scan_runtime(&node_definition(), deps, BinaryScanOptions::default()).await;

        assert_eq!(*timeouts.lock().unwrap(), vec![2_000]);
    }

    #[tokio::test(start_paused = true)]
    async fn an_explicit_probe_timeout_overrides_the_platform_default() {
        let deps = Arc::new(FakeBinaryScanDeps {
            path_env: PathEnv {
                platform: "win32".to_string(),
                home_dir: "C:\\Users\\tester".to_string(),
                env: env(&[("PATH", "C:\\tools"), ("PATHEXT", ".CMD")]),
            },
            existing: HashSet::from(["C:\\tools\\node.cmd".to_string()]),
            responses: HashMap::from([("C:\\tools\\node.cmd".to_string(), "v22.13.0".to_string())]),
            ..Default::default()
        });
        let timeouts = Arc::clone(&deps.timeouts_seen);
        let options = BinaryScanOptions {
            probe_timeout_ms: Some(750),
            ..Default::default()
        };

        scan_runtime(&node_definition(), deps, options).await;

        assert_eq!(*timeouts.lock().unwrap(), vec![750]);
    }

    #[tokio::test]
    async fn a_definition_that_keeps_unparsed_versions_still_reports_an_installation() {
        let mut definition = node_definition();
        definition.keep_unparsed_version = true;
        let deps = Arc::new(FakeBinaryScanDeps {
            path_env: linux_env("/usr/bin"),
            existing: HashSet::from(["/usr/bin/node".to_string()]),
            responses: HashMap::from([("/usr/bin/node".to_string(), "not-a-version".to_string())]),
            ..Default::default()
        });

        let result = scan_runtime(&definition, deps, BinaryScanOptions::default()).await;

        assert_eq!(result.installations.len(), 1);
        assert_eq!(result.installations[0].version, None);
        assert!(result.failures.is_empty());
    }

    #[tokio::test]
    async fn without_keep_unparsed_version_an_unreadable_output_is_a_failure_not_an_installation() {
        let deps = Arc::new(FakeBinaryScanDeps {
            path_env: linux_env("/usr/bin"),
            existing: HashSet::from(["/usr/bin/node".to_string()]),
            responses: HashMap::from([("/usr/bin/node".to_string(), "not-a-version".to_string())]),
            ..Default::default()
        });

        let result = scan_runtime(&node_definition(), deps, BinaryScanOptions::default()).await;

        assert!(result.installations.is_empty());
        assert!(
            result
                .failures
                .iter()
                .any(|failure| failure.code == RuntimeFindingCode::NotExecutable)
        );
    }

    /// Proves `max_concurrency` actually bounds *how many* candidates are
    /// in flight at once, not just the deadline math: with two pending
    /// (never-resolving) candidates and `max_concurrency: 2`, both must
    /// have been probed — a concurrency of `1` would leave the second one
    /// unprobed until the first timed out.
    #[tokio::test(start_paused = true)]
    async fn max_concurrency_of_two_probes_two_candidates_before_either_can_time_out() {
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let deps = Arc::new(FakeBinaryScanDeps {
            path_env: linux_env("/a/bin:/b/bin"),
            existing: HashSet::from(["/a/bin/node".to_string(), "/b/bin/node".to_string()]),
            pending: HashSet::from(["/a/bin/node".to_string(), "/b/bin/node".to_string()]),
            calls: Arc::clone(&calls),
            ..Default::default()
        });
        let options = BinaryScanOptions {
            max_concurrency: 2,
            total_timeout_ms: 100,
            probe_timeout_ms: Some(100),
            ..Default::default()
        };

        scan_runtime(&node_definition(), deps, options).await;

        let mut probed = calls.lock().unwrap().clone();
        probed.sort();
        assert_eq!(
            probed,
            vec!["/a/bin/node".to_string(), "/b/bin/node".to_string()]
        );
    }
}
