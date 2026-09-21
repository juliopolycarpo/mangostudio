//! The real, host-backed implementations of every trait
//! `crate::probing::detection` and `crate::probing::locations` leave
//! injected — the second and final wave for probing. Everything in
//! `detection`/`locations` is pure logic behind a trait; this module is
//! the one place that binds those traits to the machine this process
//! actually runs on, mirroring `apps/runtime/src/services/probing/host-env.ts`
//! exactly (see each item's own doc comment for its TypeScript
//! counterpart).
//!
//! # Every blocking or subprocess call here is bounded
//!
//! - A bare filesystem call ([`std::fs::metadata`], `read_dir`,
//!   `canonicalize`, `read_to_string`) never sits on an async fn's own
//!   stack: it runs inside a [`crate::blocking::run_blocking`] closure,
//!   the same rule [`crate::health`]'s `git` probe and
//!   [`crate::workspace_methods`] already follow.
//! - [`AuthSignalFs`] and [`LocationFsProbe`] are, by design,
//!   *synchronous* traits (mirroring their TypeScript originals'
//!   synchronous `statSync`/`accessSync`/`readdirSync` calls) — a real
//!   implementation here is bare `std::fs`/`nix::unistd::access`, and it
//!   is each *caller*'s job (in `crate::probing::methods`) to run the
//!   whole synchronous probe inside one [`crate::blocking::run_blocking`]
//!   closure, batching several sync checks per call the same way
//!   `crate::health`'s own `detect_shells` batches its own three `stat`
//!   walks into one blocking-pool round trip rather than three.
//! - Every subprocess ([`crate::subprocess::run_bounded_child`]) is
//!   bounded by a [`crate::subprocess::ChildBudget`] and races `cancel`
//!   exactly like `crate::health`'s own `probe_git` does.
//!
//! # Memoization
//!
//! This module's own `probe_binary_version` caches by resolved candidate
//! path plus `crate::consent::source::fingerprint_of`'s `mtime:size`
//! fingerprint — the exact pattern `crate::health`'s own `probe_git` cache
//! already established and this module deliberately does not reinvent.
//! Every one of this crate's
//! runtime and agent-CLI definitions shares one `version_args` spelling
//! (`["--version"]`), so there is no case where the *same* resolved path
//! could mean two different probe invocations — path plus fingerprint is
//! the whole key. A caller-supplied `pathEnv` override changes which
//! candidate paths are even generated upstream in
//! [`crate::probing::detection::binary_scan::scan_runtime`]; it never
//! changes what running an already-chosen path actually does, so it does
//! not belong in this cache's key either.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::detection::BoxFuture;
use super::detection::auth_signal::{AuthSignalFs, AuthSignalStat};
use super::detection::binary_scan::{BinaryScanDeps, ProbeError};
use super::detection::nvm::NvmFileSystem;
use super::detection::path_env::PathEnv;
use super::detection::version_manager_support::ManagedVersionFileSystem;
use super::detection::winget_ownership::{
    NODE_LTS_WINGET_PACKAGE_ID, WingetOwnership, parse_winget_list_output, winget_list_argv,
};
use super::locations::{LocationFsProbe, LocationLayout};
use crate::blocking::run_blocking;
use crate::consent::source::fingerprint_of;
use crate::subprocess::{ChildBudget, run_bounded_child};

/// Builds a [`PathEnv`] for this host, mirroring
/// `createRuntimePathEnv`/`withCanonicalPathKey` in `host-env.ts` exactly,
/// including the Windows case-folding fix: `overrides` (the caller's
/// `pathEnv.env`, when the `probing.*` params carried one) is merged over
/// this process's own environment *before* the canonical-`PATH`-key pass
/// runs, so an override that spells the key `Path` still ends up readable
/// under the exact-cased `PATH` key every detector in this crate's port
/// reads through [`PathEnv::env_var`].
///
/// Neither [`std::env::vars`] nor [`crate::runtime_home::home_dir`] touch
/// the filesystem — both only read this process's own in-memory
/// environment block — so, unlike every other adapter in this module,
/// this one needs no [`run_blocking`] wrapper.
pub(crate) fn build_runtime_path_env(overrides: Option<&HashMap<String, String>>) -> PathEnv {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    if let Some(overrides) = overrides {
        for (key, value) in overrides {
            env.insert(key.clone(), value.clone());
        }
    }
    PathEnv {
        platform: crate::health::node_platform().to_string(),
        home_dir: crate::runtime_home::home_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
        env: with_canonical_path_key(env),
    }
}

/// Restores a canonical `PATH` key after the override merge above, mirroring
/// `host-env.ts`'s `withCanonicalPathKey` and the real bug its own doc
/// comment describes: Windows names the variable `Path`; every detector in
/// this crate's port reads the exact key `PATH`, so a caller-supplied
/// override (or this host's own [`std::env::vars`] on Windows) that only
/// carries the differently-cased key must not leave `PATH` unset.
fn with_canonical_path_key(mut env: HashMap<String, String>) -> HashMap<String, String> {
    if env.contains_key("PATH") {
        return env;
    }
    if let Some(key) = env
        .keys()
        .find(|key| key.eq_ignore_ascii_case("path"))
        .cloned()
        && let Some(value) = env.get(&key).cloned()
    {
        env.insert("PATH".to_string(), value);
    }
    env
}

/// The real [`BinaryScanDeps`]: `PATH`/well-known-directory existence
/// checks and symlink resolution through [`run_blocking`], version probes
/// through [`crate::subprocess::run_bounded_child`], memoized by resolved
/// path and fingerprint. Mirrors `createBinaryScanDeps`.
pub(crate) struct RealBinaryScanDeps {
    path_env: PathEnv,
    cancel: CancellationToken,
}

impl RealBinaryScanDeps {
    pub(crate) fn new(path_env: PathEnv, cancel: CancellationToken) -> Self {
        Self { path_env, cancel }
    }
}

impl BinaryScanDeps for RealBinaryScanDeps {
    fn path_env(&self) -> &PathEnv {
        &self.path_env
    }

    fn path_exists<'a>(&'a self, path: &'a str) -> BoxFuture<'a, bool> {
        let path = path.to_string();
        Box::pin(async move { run_blocking(move || Path::new(&path).exists()).await })
    }

    fn probe_version<'a>(
        &'a self,
        binary: &'a str,
        args: &'a [String],
        timeout_ms: u64,
    ) -> BoxFuture<'a, Result<Option<String>, ProbeError>> {
        let binary_path = binary.to_string();
        let args = args.to_vec();
        let cancel = self.cancel.clone();
        Box::pin(async move { probe_binary_version(binary_path, args, timeout_ms, &cancel).await })
    }

    fn realpath<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<String, ()>> {
        let path = path.to_string();
        Box::pin(async move { run_blocking(move || canonicalize(&path)).await })
    }
}

fn canonicalize(path: &str) -> Result<String, ()> {
    std::fs::canonicalize(path)
        .map(|resolved| resolved.to_string_lossy().into_owned())
        .map_err(|_| ())
}

/// A `--version` line is a handful of bytes; this is generous enough for a
/// verbose vendor CLI banner ahead of it while still being a small,
/// bounded allocation regardless of what a runaway binary writes past it —
/// [`crate::subprocess::read_capped`]'s own draining guarantees the excess
/// is read and discarded, never buffered, so this cap only trims what
/// this crate keeps, not what the child is allowed to write.
const PROBE_MAX_STDOUT_BYTES: usize = 8 * 1024;
/// Stderr is never parsed for a version; this only needs to be large
/// enough that a diagnostic message does not itself trip a `SIGPIPE` on
/// the child (see [`crate::subprocess`]'s own module docs on
/// `read_capped`).
const PROBE_MAX_STDERR_BYTES: usize = 1024;

/// One cache entry: the fingerprint a probe answered against, and the
/// version string it produced (or `None`, when the binary ran but its
/// output was empty). Factored out only so [`probe_version_cache`]'s own
/// type stays under clippy's `type_complexity` threshold, not because
/// anything else in this module needs to name it.
type ProbeVersionCacheEntry = (String, Option<String>);

/// Every cached `probe_version` answer, keyed on the candidate path
/// exactly as handed to this function — never a bare binary name, and
/// never canonicalised (mirrors [`crate::health`]'s own `git_probe_cache`,
/// which keys on `which_in`'s un-canonicalised, PATH-joined path for the
/// identical reason: two `PATH` entries that alias the same real file
/// through a symlink get two cache entries, which costs one redundant
/// probe the first time each is seen and nothing after that — cheaper
/// than a second `realpath` round trip on every single probe just to
/// share a cache slot).
fn probe_version_cache() -> &'static Mutex<HashMap<PathBuf, ProbeVersionCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, ProbeVersionCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Clears every cached `probe_version` answer. Test-only, gated the same
/// way [`crate::health`]'s `invalidate_git_probe_cache` is: every caller
/// lives behind this crate's `#[cfg(unix)]` real-child tests, so an
/// unqualified `#[cfg(test)]` here would be reported dead code on a
/// Windows build under `-D warnings`.
#[cfg(all(test, unix))]
pub(crate) fn invalidate_probe_version_cache() {
    probe_version_cache()
        .lock()
        .expect("the probe-version cache mutex is never poisoned")
        .clear();
}

/// Serializes tests that call [`invalidate_probe_version_cache`]: that
/// function clears the *whole*, process-wide [`probe_version_cache`]
/// regardless of key, so two such tests running concurrently under Rust's
/// default parallel test harness can wipe each other's cache entry
/// between two probes of what each believes is its own, uniquely-named
/// fake binary. Mirrors `crate::health`'s own `git_probe_test_lock`/
/// `shell_detection_test_lock` and `crate::blocking::pool_saturation_test_lock`
/// — the identical class of problem, once per process-wide test-only
/// cache this crate has.
#[cfg(all(test, unix))]
pub(crate) fn probe_version_test_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn lookup_probe_cache(path: &Path, fingerprint: &str) -> Option<Option<String>> {
    let cache = probe_version_cache()
        .lock()
        .expect("the probe-version cache mutex is never poisoned");
    let (cached_fingerprint, value) = cache.get(path)?;
    (cached_fingerprint == fingerprint).then(|| value.clone())
}

fn cache_probe_result(path: PathBuf, fingerprint: String, value: Option<String>) {
    let mut cache = probe_version_cache()
        .lock()
        .expect("the probe-version cache mutex is never poisoned");
    cache.insert(path, (fingerprint, value));
}

/// How much *longer* than the pure layer's own `timeout_ms` this module's
/// own child-killing task is allowed to keep trying before it gives up.
///
/// Mirrors `host-env.ts`'s `VERSION_PROBE_GRACE_MS` and the exact reasoning
/// in its own doc comment. [`crate::probing::detection::binary_scan::probe_one_candidate`]
/// already races this trait's whole `probe_version` future against its own
/// `tokio::time::timeout(timeout_duration, …)`, using the *same*
/// `timeout_duration` it hands this function as `timeout_ms` — that outer
/// race, not anything internal to this module, is what must be
/// authoritative for *reporting* a timeout as `probe-timeout` rather than
/// `not-executable`. An earlier draft of this function gave
/// [`run_bounded_child`] a deadline *shorter* than `timeout_ms`
/// specifically so it would win that race — which fixed which cleanup path
/// ran, but broke reporting: a hanging `--version` that this module's own
/// (shorter) deadline caught first resolved the *outer* race as `Ok(Err(ProbeError))`,
/// not `Err(_elapsed)`, so the pure layer read it as "ran and produced
/// nothing" and reported `not-executable` — precisely the misdiagnosis
/// `VERSION_PROBE_GRACE_MS`'s own TypeScript comment exists to prevent
/// (sending anyone who reads the finding to check file permissions on a
/// binary that was merely slow).
///
/// The fix composes the two races the way TypeScript's own two independent
/// timers do: [`probe_binary_version`] spawns [`run_bounded_child`] as its
/// own detached [`tokio::spawn`] task, with a deadline *longer* than what
/// the outer race uses. The outer race is then always the one that fires
/// first when the child is genuinely too slow, and reports the timeout
/// correctly. This module's own future — awaiting the spawned task's
/// `JoinHandle` — can be dropped right there with no consequence, because
/// the spawned task is not attached to it: it keeps running, independently
/// of whether anything is still awaiting it, all the way to a real kill
/// and a real reap — the exact guarantee `crate::subprocess`'s own module
/// docs describe never relying on `tokio::process::Command::kill_on_drop`
/// for.
const PROBE_GRACE: Duration = Duration::from_millis(250);

/// Probes `binary_path -- args`, memoized by resolved path and
/// fingerprint. Only a probe that actually ran to a successful exit is
/// cached — mirrors [`crate::health::probe_git`]'s own choice not to cache
/// a timeout, a failed spawn, or even a *definite* non-zero exit: any of
/// those says nothing durable enough about the next probe to be worth
/// short-circuiting it.
///
/// # Errors
/// [`ProbeError`] for every failure mode alike (timed out, cancelled,
/// could not spawn) — see that type's own docs for why this trait has no
/// finer-grained failure to report, and why that is fine: the pure layer
/// above this function treats every [`ProbeError`] the same way a `null`
/// TypeScript probe result is treated, as "ran, produced nothing". See
/// [`PROBE_GRACE`]'s own doc comment for why this can never be reported as
/// a false `not-executable` for a candidate that was merely slow: the
/// *caller's* own outer timeout is what fires first in that case, well
/// before this function's own detached task ever gets to return an error
/// at all.
async fn probe_binary_version(
    binary_path: String,
    args: Vec<String>,
    timeout_ms: u64,
    cancel: &CancellationToken,
) -> Result<Option<String>, ProbeError> {
    let path_buf = PathBuf::from(&binary_path);
    let fingerprint = run_blocking({
        let path_buf = path_buf.clone();
        move || {
            std::fs::metadata(&path_buf)
                .ok()
                .map(|metadata| fingerprint_of(&metadata))
        }
    })
    .await;

    if let Some(cached) = fingerprint
        .as_deref()
        .and_then(|fingerprint| lookup_probe_cache(&path_buf, fingerprint))
    {
        return Ok(cached);
    }

    let budget = ChildBudget {
        deadline: Duration::from_millis(timeout_ms) + PROBE_GRACE,
        max_stdout_bytes: PROBE_MAX_STDOUT_BYTES,
        max_stderr_bytes: PROBE_MAX_STDERR_BYTES,
    };
    let cancel = cancel.clone();
    let spawned_path = path_buf.clone();
    // Detached on purpose — see `PROBE_GRACE`'s own doc comment: this
    // task's own kill-and-reap sequence must keep running to completion
    // even if the caller's own outer race gives up on the future that
    // awaits it below.
    let handle = tokio::spawn(async move {
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_bounded_child(&spawned_path, &arg_refs, None, budget, &cancel).await
    });

    match handle.await {
        Ok(Ok(outcome)) if outcome.status_success => {
            let text = String::from_utf8_lossy(&outcome.stdout).trim().to_string();
            let value = if text.is_empty() { None } else { Some(text) };
            if let Some(fingerprint) = fingerprint {
                cache_probe_result(path_buf, fingerprint, value.clone());
            }
            Ok(value)
        }
        // Ran, but exited non-zero: mirrors `probeBinaryVersion`'s own
        // `execFile` rejection path, which reads a non-zero exit the same
        // as "produced nothing" rather than a hard failure. Not cached —
        // see this function's own doc comment.
        Ok(Ok(_)) => Ok(None),
        Ok(Err(_child_run_error)) => Err(ProbeError),
        // The spawned task itself panicked, rather than `run_bounded_child`
        // reporting an ordinary failure — treated the same opaque way as
        // every other failure this trait can report; see `ProbeError`'s
        // own docs for why no caller needs to tell these apart.
        Err(_join_error) => Err(ProbeError),
    }
}

/// The real filesystem seam nvm's and fnm's detectors share, plus nvm's
/// own `read_file`. Mirrors `NODE_MANAGED_VERSION_FILE_SYSTEM`/
/// `NODE_NVM_FILE_SYSTEM`.
pub(crate) struct RealManagedVersionFs;

impl ManagedVersionFileSystem for RealManagedVersionFs {
    fn path_exists<'a>(&'a self, path: &'a str) -> BoxFuture<'a, bool> {
        let path = path.to_string();
        Box::pin(async move { run_blocking(move || Path::new(&path).exists()).await })
    }

    fn read_directory<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Vec<String>, ()>> {
        let path = path.to_string();
        Box::pin(async move { run_blocking(move || read_directory_names(&path)).await })
    }

    fn realpath<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<String, ()>> {
        let path = path.to_string();
        Box::pin(async move { run_blocking(move || canonicalize(&path)).await })
    }
}

fn read_directory_names(path: &str) -> Result<Vec<String>, ()> {
    std::fs::read_dir(path).map_err(|_| ()).map(|entries| {
        entries
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect()
    })
}

impl NvmFileSystem for RealManagedVersionFs {
    fn read_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<String, ()>> {
        let path = path.to_string();
        Box::pin(async move {
            run_blocking(move || std::fs::read_to_string(&path).map_err(|_| ())).await
        })
    }
}

/// The real, synchronous [`AuthSignalFs`]: [`std::fs::metadata`] for
/// `stat`, and a bounded, `O_RDONLY`-only regular-file read for
/// `read_file` — mirrors `NODE_AUTH_SIGNAL_FS`'s `statSync`/
/// `readBoundedUtf8`.
///
/// Left synchronous on purpose (see this module's own docs): every caller
/// in `crate::probing::methods` runs a whole auth/config-home probe (this
/// plus [`locations::LocationFsProbe`], batched) inside one
/// [`run_blocking`] closure, never this type's methods bare on an async
/// fn's stack.
pub(crate) struct RealAuthSignalFs;

impl AuthSignalFs for RealAuthSignalFs {
    fn stat(&self, path: &str) -> Result<AuthSignalStat, std::io::Error> {
        let metadata = std::fs::metadata(path)?;
        Ok(AuthSignalStat {
            is_directory: metadata.is_dir(),
            is_file: metadata.is_file(),
        })
    }

    fn read_file(&self, path: &str, max_bytes: usize) -> Result<String, std::io::Error> {
        use std::io::Read;
        // This never returns more than `max_bytes` regardless of the real
        // file's size — the privacy/size bound `probe_config_key`'s own
        // module docs require — and never exposes anything past the
        // `Result<String, io::Error>` this trait already commits to: no
        // caller of this type ever logs or forwards the string itself,
        // only the boolean `probe_config_key`/`probe_auth_file` derive
        // from it.
        //
        // `O_NOFOLLOW` on the open itself (Unix), not an `lstat` check
        // before a plain `open` — mirrors `host-env.ts`'s `readBoundedUtf8`
        // exactly: a config path whose *final* component is a symlink must
        // fail the open outright, never silently redirect this bounded
        // read to wherever it points. `fstat`-ing the resulting descriptor
        // (not the path a second time) is what keeps that check racy-swap
        // free, the same reason the TypeScript original fstats the open
        // `fd` rather than `stat`-ing the path again.
        #[cfg(unix)]
        let mut file = {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(nix::fcntl::OFlag::O_NOFOLLOW.bits())
                .open(path)?
        };
        #[cfg(not(unix))]
        let mut file = std::fs::File::open(path)?;

        if !file.metadata()?.is_file() {
            return Err(std::io::Error::other(format!("not a regular file: {path}")));
        }

        let mut limited = file.by_ref().take(max_bytes as u64);
        let mut buffer = Vec::new();
        limited.read_to_end(&mut buffer)?;
        // Lossy-decodes rather than failing closed on a UTF-8 sequence cut
        // exactly at the byte cap — matches Node's own `Buffer#toString('utf8')`
        // in `readBoundedUtf8`, which substitutes the replacement character
        // rather than throwing; `read_to_string`'s strict UTF-8 requirement
        // would refuse a config file this read only truncated mid-character,
        // not one that was ever actually malformed.
        Ok(String::from_utf8_lossy(&buffer).into_owned())
    }
}

/// The real [`LocationFsProbe`]: existence/read/write access checks
/// through `nix::unistd::access` on Unix (an ACL-aware permission check,
/// not merely "the path exists"), and a filtered `read_dir` for
/// `count_entries`. Mirrors `NODE_LOCATION_FS_PROBE`.
///
/// # Windows narrowing
/// Unix's `access(2)` answers a real, ACL-aware permission question; this
/// crate has no equivalent Windows API wired up (`crate::workspace_methods`'s
/// `validate_resolved_path` narrows the identical class of check the same
/// way, with the same caveat). `is_readable` there falls back to "the path
/// could be stat-ed at all", and `is_writable` falls back to the
/// read-only file attribute — narrower than a real access-control check,
/// but never wrong in the direction that matters most (a location an ACL
/// truly denies write to, but whose read-only attribute is unset, would
/// be reported writable when it is not; this is a known, documented gap,
/// not a silent one).
pub(crate) struct RealLocationFsProbe;

impl LocationFsProbe for RealLocationFsProbe {
    fn exists(&self, path: &str) -> bool {
        Path::new(path).exists()
    }

    fn is_writable(&self, path: &str) -> bool {
        #[cfg(unix)]
        {
            nix::unistd::access(path, nix::unistd::AccessFlags::W_OK).is_ok()
        }
        #[cfg(not(unix))]
        {
            std::fs::metadata(path)
                .map(|metadata| !metadata.permissions().readonly())
                .unwrap_or(false)
        }
    }

    fn is_readable(&self, path: &str) -> bool {
        #[cfg(unix)]
        {
            nix::unistd::access(path, nix::unistd::AccessFlags::R_OK).is_ok()
        }
        #[cfg(not(unix))]
        {
            std::fs::metadata(path).is_ok()
        }
    }

    fn count_entries(&self, path: &str, layout: LocationLayout) -> Option<usize> {
        let entries = std::fs::read_dir(path).ok()?;
        let mut count = 0usize;
        for entry in entries.filter_map(Result::ok) {
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let counted = if file_type.is_symlink() {
                true
            } else {
                match layout {
                    LocationLayout::DirectoryOfDirs => file_type.is_dir(),
                    LocationLayout::DirectoryOfFiles => file_type.is_file(),
                    LocationLayout::SingleFile => false,
                }
            };
            if counted {
                count += 1;
            }
        }
        Some(count)
    }
}

/// Above the caller's own per-candidate probe budget on purpose: `winget
/// list` is slow, this runs once per `probing.runtimes` call rather than
/// once per candidate, and a cancelled or timed-out probe answers
/// [`WingetOwnership::Unknown`] instead of failing the whole call. Mirrors
/// `host-env.ts`'s `WINGET_OWNERSHIP_TIMEOUT_MS` exactly, including its
/// own reasoning: `8_000` sits comfortably under the hub's much larger
/// overall deadline for a `probing.runtimes` request, so a slow `winget`
/// degrades one signal on the response rather than delaying everything
/// behind it.
const WINGET_OWNERSHIP_TIMEOUT_MS: u64 = 8_000;

/// A `winget list` capture is a short, fixed-width table for one exact
/// package id — a few hundred bytes in practice. This is generous enough
/// for a heavily localized header row while staying a small, bounded
/// allocation.
const WINGET_LIST_MAX_STDOUT_BYTES: usize = 16 * 1024;
const WINGET_LIST_MAX_STDERR_BYTES: usize = 4 * 1024;

/// Asks winget whether it owns [`NODE_LTS_WINGET_PACKAGE_ID`], mapping
/// every failure — the binary missing (compiles and is at least attempted
/// on every platform; only ever resolves on win32), a timeout, a
/// cancellation, an unrecognized exit code — to
/// [`WingetOwnership::Unknown`]. Mirrors `probeWingetOwnership` exactly,
/// including spawning the bare `"winget"` name rather than a resolved
/// path: `execFile('winget', …)` in the TypeScript original relies on the
/// OS's own `PATH` search using *this process's real environment*, never
/// a caller-supplied `pathEnv` override, and `tokio::process::Command`
/// with no `env_clear`/`envs` call (this call passes `env: None`) resolves
/// a bare program name through the identical OS search — so this
/// deliberately does not thread the scan's own possibly-overridden
/// `PathEnv` through this one call, matching the reference exactly.
pub(crate) async fn probe_winget_ownership(cancel: &CancellationToken) -> WingetOwnership {
    let args = winget_list_argv(NODE_LTS_WINGET_PACKAGE_ID);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let budget = ChildBudget {
        deadline: Duration::from_millis(WINGET_OWNERSHIP_TIMEOUT_MS),
        max_stdout_bytes: WINGET_LIST_MAX_STDOUT_BYTES,
        max_stderr_bytes: WINGET_LIST_MAX_STDERR_BYTES,
    };
    match run_bounded_child(Path::new("winget"), &arg_refs, None, budget, cancel).await {
        Ok(outcome) => {
            let stdout = String::from_utf8_lossy(&outcome.stdout).into_owned();
            parse_winget_list_output(
                &stdout,
                outcome.exit_code.map(i64::from),
                NODE_LTS_WINGET_PACKAGE_ID,
            )
        }
        Err(_child_run_error) => WingetOwnership::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mango-probing-host-test-{name}-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn with_canonical_path_key_folds_a_differently_cased_key() {
        let mut env = HashMap::new();
        env.insert("Path".to_string(), "C:\\Windows".to_string());
        let folded = with_canonical_path_key(env);
        assert_eq!(folded.get("PATH"), Some(&"C:\\Windows".to_string()));
        assert_eq!(
            folded.get("Path"),
            Some(&"C:\\Windows".to_string()),
            "the original key is kept alongside the canonical one, not renamed away"
        );
    }

    #[test]
    fn with_canonical_path_key_leaves_an_exact_path_key_untouched() {
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), "/usr/bin".to_string());
        let folded = with_canonical_path_key(env);
        assert_eq!(folded.get("PATH"), Some(&"/usr/bin".to_string()));
    }

    #[test]
    fn build_runtime_path_env_reports_this_hosts_real_platform() {
        let env = build_runtime_path_env(None);
        assert_eq!(env.platform, crate::health::node_platform());
    }

    #[cfg(unix)]
    fn fake_binary(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probe_binary_version_reports_a_real_scripts_output() {
        let _exclusive = probe_version_test_lock().lock().await;
        invalidate_probe_version_cache();
        let dir = scratch_dir("probe-ok");
        let script = fake_binary(&dir, "fake-version", "echo 9.9.9");
        let cancel = CancellationToken::new();

        let version = probe_binary_version(
            script.to_string_lossy().into_owned(),
            vec!["--version".to_string()],
            2_000,
            &cancel,
        )
        .await
        .expect("a fast fake binary must not fail");
        assert_eq!(version.as_deref(), Some("9.9.9"));
    }

    /// Mutation test 1: a second call for the same resolved binary must
    /// not spawn the child a second time. The fake script appends to an
    /// invocation counter file on every real run; a served-from-cache
    /// second call cannot bump it.
    ///
    /// The `tr -d '[:space:]'` after `wc -l` is load-bearing, not
    /// decorative: BSD `wc` (macOS) right-justifies its count with leading
    /// spaces even when reading from stdin via redirection, unlike GNU
    /// `wc` (Linux), which prints a bare digit there. Left unstripped,
    /// `count` held e.g. `"       1"`; splicing that into `9.9.$count`
    /// unquoted let the shell's own default word-splitting break it into
    /// two words at the embedded whitespace, which `echo` then rejoined
    /// with a single space — a real, observed `9.9. 1` on macOS CI, not a
    /// parsing bug: `probe_binary_version`'s own `.trim()` only trims the
    /// outside of a string, exactly as it must, so an embedded space
    /// baked in by this fixture survives untouched. This is the fixture
    /// being tightened, never the parser being loosened.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_cache_hit_never_invokes_the_binary_a_second_time() {
        let _exclusive = probe_version_test_lock().lock().await;
        invalidate_probe_version_cache();
        let dir = scratch_dir("probe-cache-hit");
        let invocations = dir.join("invocations");
        let script = fake_binary(
            &dir,
            "fake-version-cache",
            &format!(
                "echo run >> {inv}\ncount=$(wc -l < {inv} | tr -d '[:space:]')\necho 9.9.$count",
                inv = invocations.display()
            ),
        );
        let cancel = CancellationToken::new();

        let first = probe_binary_version(
            script.to_string_lossy().into_owned(),
            vec!["--version".to_string()],
            2_000,
            &cancel,
        )
        .await
        .unwrap();
        assert_eq!(first.as_deref(), Some("9.9.1"));

        let second = probe_binary_version(
            script.to_string_lossy().into_owned(),
            vec!["--version".to_string()],
            2_000,
            &cancel,
        )
        .await
        .unwrap();
        assert_eq!(
            second.as_deref(),
            Some("9.9.1"),
            "a repeated resolved path with an unchanged fingerprint must be served from cache"
        );
        let invocation_count = std::fs::read_to_string(&invocations)
            .unwrap()
            .lines()
            .count();
        assert_eq!(
            invocation_count, 1,
            "the fake binary must have run exactly once across both probes"
        );
    }

    /// Mutation test 2: a fake binary that never exits must not be able to
    /// keep `probe_binary_version` from returning within its own budget —
    /// proven with a hard outer bound at ten times the probe's own
    /// timeout, and by confirming the spawned child is actually gone
    /// afterward, not merely that this call returned.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_hanging_binary_is_killed_within_its_own_timeout_not_left_running() {
        let _exclusive = probe_version_test_lock().lock().await;
        invalidate_probe_version_cache();
        let dir = scratch_dir("probe-deadline");
        let pid_file = dir.join("pid");
        let script = fake_binary(
            &dir,
            "fake-hangs",
            &format!("echo $$ > {}\nsleep 5\n", pid_file.display()),
        );
        let cancel = CancellationToken::new();

        let outcome = tokio::time::timeout(
            Duration::from_millis(2_000),
            probe_binary_version(
                script.to_string_lossy().into_owned(),
                vec!["--version".to_string()],
                200,
                &cancel,
            ),
        )
        .await
        .expect(
            "probe_binary_version must return within ten times its own 200ms budget, not hang \
             on a binary that never exits",
        );
        assert!(
            outcome.is_err(),
            "a probe that never answers must be reported as ProbeError"
        );

        for _ in 0..200 {
            let pid_text = std::fs::read_to_string(&pid_file);
            if let Ok(pid_text) = pid_text
                && let Ok(pid) = pid_text.trim().parse::<i32>()
                && matches!(
                    nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
                    Err(nix::errno::Errno::ESRCH)
                )
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the hanging binary must have been killed and reaped, not left running");
    }

    #[test]
    fn real_auth_signal_fs_reports_presence_only_never_file_contents() {
        let dir = scratch_dir("auth-fs");
        let file = dir.join("secret.json");
        std::fs::write(&file, b"{\"token\":\"do-not-leak\"}").unwrap();

        let fs = RealAuthSignalFs;
        let stat = fs.stat(file.to_string_lossy().as_ref()).unwrap();
        assert!(stat.is_file);
        assert!(!stat.is_directory);
    }

    #[test]
    fn real_auth_signal_fs_read_file_is_bounded_by_max_bytes() {
        let dir = scratch_dir("auth-fs-bound");
        let file = dir.join("big.json");
        std::fs::write(&file, "x".repeat(1_000)).unwrap();
        let fs = RealAuthSignalFs;
        let text = fs.read_file(file.to_string_lossy().as_ref(), 10).unwrap();
        assert_eq!(text.len(), 10);
    }

    /// P2 regression test: mirrors `host-env.ts`'s own `readBoundedUtf8`,
    /// which opens with `O_RDONLY | O_NOFOLLOW` specifically so a config
    /// path whose *final* component is a symlink cannot redirect this
    /// bounded read to wherever it points. A plain `File::open` follows
    /// the symlink instead — no credential value ever escapes through
    /// this trait's `Result<String, io::Error>` either way (only a
    /// presence boolean derived from it does, further up the call chain),
    /// but a caller asking this probe about one exact path must not have
    /// its answer quietly computed from a different, symlinked-to file.
    #[cfg(unix)]
    #[test]
    fn real_auth_signal_fs_read_file_refuses_a_final_component_symlink() {
        let dir = scratch_dir("auth-fs-symlink");
        let real = dir.join("real-secret.json");
        std::fs::write(&real, "{\"token\":\"do-not-leak\"}").unwrap();
        let link = dir.join("config.json");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let fs = RealAuthSignalFs;
        let error = fs
            .read_file(link.to_string_lossy().as_ref(), 4096)
            .expect_err("a symlinked config path must refuse the read, not follow it");
        assert!(
            error.kind() != std::io::ErrorKind::NotFound,
            "the path genuinely exists; refusing it must not read as 'absent': {error}"
        );
    }

    /// A permission failure must never be reported as "absent" — proven by
    /// making the directory itself unreadable/unexecutable so `stat`
    /// fails with `EACCES`, then confirming `AuthSignalFs::stat` surfaces
    /// a real `io::Error` a caller can tell apart from `NotFound` (the
    /// pure `auth_signal` layer's `is_missing_path_error` is what turns
    /// that distinction into `Unknown` rather than a false "absent" — see
    /// `crate::probing::detection::auth_signal`'s own tests for that half;
    /// this test only pins that this adapter still reports a genuine
    /// `PermissionDenied`, not a swallowed `NotFound`).
    #[cfg(unix)]
    #[test]
    fn a_permission_failure_is_a_real_io_error_not_a_swallowed_not_found() {
        use std::os::unix::fs::PermissionsExt;
        // Root ignores Unix permission bits entirely, so this regression
        // guard cannot mean anything under it — skip rather than assert a
        // false pass.
        if nix::unistd::Uid::effective().is_root() {
            return;
        }
        let dir = scratch_dir("auth-fs-denied");
        let inner = dir.join("locked");
        std::fs::create_dir(&inner).unwrap();
        let file = inner.join("config.json");
        std::fs::write(&file, b"{}").unwrap();
        std::fs::set_permissions(&inner, std::fs::Permissions::from_mode(0o000)).unwrap();

        let fs = RealAuthSignalFs;
        let error = fs
            .stat(file.to_string_lossy().as_ref())
            .expect_err("a locked parent directory must refuse stat, not silently succeed");
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);

        std::fs::set_permissions(&inner, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[test]
    fn real_location_fs_probe_reflects_a_real_temp_directory() {
        let dir = scratch_dir("location-fs");
        std::fs::write(dir.join("a.md"), b"").unwrap();
        std::fs::write(dir.join(".hidden.md"), b"").unwrap();
        std::fs::create_dir(dir.join("subdir")).unwrap();

        let probe = RealLocationFsProbe;
        assert!(probe.exists(dir.to_string_lossy().as_ref()));
        assert!(probe.is_readable(dir.to_string_lossy().as_ref()));
        assert!(probe.is_writable(dir.to_string_lossy().as_ref()));

        let files_only = probe
            .count_entries(
                dir.to_string_lossy().as_ref(),
                LocationLayout::DirectoryOfFiles,
            )
            .unwrap();
        assert_eq!(
            files_only, 1,
            "only a.md counts: dotfiles and directories are excluded"
        );

        let dirs_only = probe
            .count_entries(
                dir.to_string_lossy().as_ref(),
                LocationLayout::DirectoryOfDirs,
            )
            .unwrap();
        assert_eq!(dirs_only, 1, "only subdir counts");
    }

    #[cfg(unix)]
    #[test]
    fn real_location_fs_probe_reports_false_for_a_real_read_only_directory() {
        use std::os::unix::fs::PermissionsExt;
        if nix::unistd::Uid::effective().is_root() {
            return;
        }
        let dir = scratch_dir("location-fs-readonly");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        let probe = RealLocationFsProbe;
        assert!(probe.exists(dir.to_string_lossy().as_ref()));
        assert!(probe.is_readable(dir.to_string_lossy().as_ref()));
        assert!(
            !probe.is_writable(dir.to_string_lossy().as_ref()),
            "a real read-only directory must not report writable"
        );

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[tokio::test]
    async fn probe_winget_ownership_is_attempted_through_run_bounded_child_and_never_hangs() {
        // Cross-platform proof: on any host without a real `winget` binary
        // on `PATH` (every CI runner but Windows), this exercises the
        // `SpawnFailed` branch of `run_bounded_child` and must still
        // resolve promptly to `Unknown` rather than hang — proving the
        // call is genuinely attempted through the bounded child runner,
        // not skipped. The real, positive parse path (`Owned`/`NotOwned`
        // against actual `winget list` output) already has full coverage
        // in `crate::probing::detection::winget_ownership`'s own pure
        // tests; what is unverified outside an actual Windows host is
        // only that the *subprocess* half — argv, budget, exit-code
        // plumbing — behaves the same way there, which this crate has no
        // way to exercise from this test suite.
        let cancel = CancellationToken::new();
        let outcome = tokio::time::timeout(Duration::from_secs(9), probe_winget_ownership(&cancel))
            .await
            .expect("probe_winget_ownership must resolve within its own bounded budget");
        if cfg!(not(windows)) {
            assert_eq!(outcome, WingetOwnership::Unknown);
        }
    }

    /// A cancelled winget probe must resolve promptly to `Unknown` rather
    /// than waiting out the full 8s budget.
    #[tokio::test]
    async fn probe_winget_ownership_is_cancellable() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let outcome = tokio::time::timeout(Duration::from_secs(2), probe_winget_ownership(&cancel))
            .await
            .expect("a pre-cancelled probe must resolve immediately");
        assert_eq!(outcome, WingetOwnership::Unknown);
    }

    /// Regression test for the P1 misdiagnosis [`PROBE_GRACE`] exists to
    /// close: a candidate that is merely slow — not broken — must be
    /// reported by the pure layer as a timeout, never as `not-executable`.
    /// Reproduced exactly the way
    /// `crate::probing::detection::binary_scan::probe_one_candidate`
    /// composes this trait's `probe_version`: an outer `tokio::time::timeout`
    /// using the *same* `timeout_ms` this function itself receives, racing
    /// against a real fake binary that outlasts that outer bound but still
    /// gets killed by this module's own (longer) internal deadline.
    ///
    /// Before this fix, `run_bounded_child`'s own deadline was *shorter*
    /// than `timeout_ms`, so it always won this exact race and resolved
    /// `probe_binary_version`'s future with `Err(ProbeError)` well before
    /// this test's own outer timeout could ever fire — the outer race
    /// would have observed `Ok(Err(ProbeError))`, not `Err(_elapsed)`,
    /// which `probe_one_candidate` reads as "ran and produced nothing"
    /// (`not-executable`) rather than "timed out" (`probe-timeout`).
    ///
    /// This test's own scope stops at the reporting fix — it deliberately
    /// does not also poll for the child's eventual death, the way earlier
    /// drafts did: `run_bounded_child`'s own kill-and-reap already has
    /// exhaustive coverage in `crate::subprocess`'s own test module, and
    /// [`a_hanging_binary_is_killed_within_its_own_timeout_not_left_running`]
    /// just above already proves this module's own detached task reaches
    /// a real kill and a real reap when driven to completion. Polling for
    /// that a *second* time here, under this crate's full test suite,
    /// means contending for [`crate::subprocess`]'s process-wide, capacity-4
    /// child-process semaphore against however many other tests are
    /// spawning real children at that exact moment — a real, observed
    /// source of flakiness this test does not need to accept for a
    /// property it is not the one proving.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_slow_but_eventually_killed_probe_is_reported_as_a_timeout_by_the_outer_race() {
        let _exclusive = probe_version_test_lock().lock().await;
        invalidate_probe_version_cache();
        let dir = scratch_dir("probe-slow-not-broken");
        let pid_file = dir.join("pid");
        let script = fake_binary(
            &dir,
            "fake-slow",
            &format!("echo $$ > {}\nsleep 5\n", pid_file.display()),
        );
        let cancel = CancellationToken::new();
        let timeout_ms = 200u64;

        // Mirrors `probe_one_candidate`'s own composition exactly: an outer
        // race using the identical `timeout_ms` this function receives.
        let outer = tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            probe_binary_version(
                script.to_string_lossy().into_owned(),
                vec!["--version".to_string()],
                timeout_ms,
                &cancel,
            ),
        )
        .await;

        assert!(
            outer.is_err(),
            "the outer race must be the one that times out for a merely slow candidate, not \
             resolve early with an Err this crate's own pure layer would misreport as \
             not-executable"
        );
    }
}
