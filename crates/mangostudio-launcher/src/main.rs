//! Thin launcher for MangoStudio, published to crates.io.
//!
//! The product is a Bun-compiled binary distributed via GitHub Releases with
//! the frontend embedded in the executable; this crate is not the app source. On first run the launcher downloads the platform archive matching
//! the crate version into `~/.mango/dist/<version>/` (checksum-verified, the
//! same layout the shell installer uses), then hands over to the real binary
//! with arguments and environment untouched, except for two markers —
//! `MANGOSTUDIO_LAUNCHER` and `MANGOSTUDIO_LAUNCHER_PATH` — that announce this
//! shim to the binary it spawns, the way the npm wrapper announces itself too.
//!
//! A release never changes under its version, so a complete install starts
//! with no network request. Everything else here is about getting that install
//! on disk safely: one lock per version, bounded requests, a swap that keeps
//! the previous tree until the new one is in place, and recovery from a
//! crash that interrupted the swap.

use std::env;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const REPO_URL: &str = "https://github.com/juliopolycarpo/mangostudio";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const BINARY_NAME: &str = if cfg!(windows) {
    "mangostudio.exe"
} else {
    "mangostudio"
};
const ARCHIVE_EXTENSION: &str = if cfg!(windows) { "zip" } else { "tar.gz" };
const DOWNLOAD_ATTEMPTS: u32 = 3;
const DOWNLOAD_RETRY_DELAY: Duration = Duration::from_secs(2);
/// Hard cap for downloads; the largest platform archive is well under this.
const MAX_DOWNLOAD_BYTES: u64 = 1024 * 1024 * 1024;
/// `SHA256SUMS` lists a few dozen assets; anything near this is not one.
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
/// Whole-request deadlines (connect, headers and body). ureq's default agent
/// has none, so a stalled connection would hang a start forever. The archive
/// budget is generous: it is a single ~60 MB transfer over whatever link the
/// user has.
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(30);
const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(600);
/// How long a start waits for another launcher that is installing the same
/// version, and how often it looks. Longer than the archive deadline times the
/// retries a healthy installer could spend would only hide a dead lock holder.
const LOCK_WAIT: Duration = Duration::from_secs(900);
const LOCK_POLL: Duration = Duration::from_millis(100);
/// Written last into a freshly unpacked tree, inside the staging directory, so
/// it reaches the version directory with the same rename as the files it
/// describes. One `<bytes>\t<name>` line per top-level file.
const INSTALL_RECORD: &str = ".launcher-record";

fn main() {
    if let Err(message) = run() {
        eprintln!("mangostudio launcher: {message}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let install_dir = install_root()?.join(VERSION);
    let binary_path = install_dir.join(BINARY_NAME);
    // Checked here as well as inside `ensure_install` so a start that needs
    // nothing never builds a `Release`, which fails on an unsupported platform.
    if !install_is_complete(&install_dir) {
        match ensure_install(&Release::for_this_build()?, &install_dir)? {
            InstallStart::Complete | InstallStart::Installed => {}
            InstallStart::KeptInstalled { reason } => {
                eprintln!("mangostudio launcher: warning: {reason}; starting the installed build");
            }
        }
    }
    run_binary(&binary_path)
}

/// Map the compile-time target onto the release platform ids frozen by the
/// asset contract (scripts/lib/release-targets.ts). musl is a compile-time
/// property: a glibc-built launcher running on Alpine still picks the glibc
/// archive; such hosts should use the shell installer instead.
fn platform_id() -> Result<&'static str, String> {
    let id = match (
        env::consts::OS,
        env::consts::ARCH,
        cfg!(target_env = "musl"),
    ) {
        ("linux", "x86_64", false) => "linux-x64",
        ("linux", "x86_64", true) => "linux-x64-musl",
        ("linux", "aarch64", false) => "linux-arm64",
        ("linux", "aarch64", true) => "linux-arm64-musl",
        ("macos", "x86_64", _) => "darwin-x64",
        ("macos", "aarch64", _) => "darwin-arm64",
        ("windows", "x86_64", _) => "windows-x64",
        ("windows", "aarch64", _) => "windows-arm64",
        (os, arch, _) => {
            return Err(format!(
                "no prebuilt MangoStudio binary for {os}-{arch}; see {REPO_URL}#install for other install options"
            ));
        }
    };
    Ok(id)
}

fn install_root() -> Result<PathBuf, String> {
    if let Some(dir) = env::var_os("MANGOSTUDIO_INSTALL_DIR").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    Ok(home_dir()?.join(".mango").join("dist"))
}

fn home_dir() -> Result<PathBuf, String> {
    let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    env::var_os(variable)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| {
            format!(
                "{variable} is not set; set MANGOSTUDIO_INSTALL_DIR to pick an install directory"
            )
        })
}

/// Base URL of the directory holding the release assets. MANGOSTUDIO_DIST_URL
/// overrides it so the download path is testable against a local server
/// without a published GitHub release.
fn dist_base_url() -> String {
    match env::var("MANGOSTUDIO_DIST_URL") {
        Ok(base) if !base.trim().is_empty() => base.trim().trim_end_matches('/').to_string(),
        _ => format!("{REPO_URL}/releases/download/v{VERSION}"),
    }
}

/// One release to install: the version it was published as, where its assets
/// live, and the platform archive to pick. Everything an install does that
/// could differ between production and a test is a field here, so tests can aim
/// it at a fake server with short deadlines.
struct Release<'a> {
    version: &'a str,
    platform: &'a str,
    base_url: String,
    /// Names the scratch directories of this launcher run
    /// (`.launcher-staging-<version>.<tag>`, `.launcher-rollback-<version>.<tag>`).
    /// Unique per run: process ids alone repeat across containers that share
    /// one install root (each sees itself as pid 1).
    scratch_tag: String,
    retry_delay: Duration,
    manifest_timeout: Duration,
    archive_timeout: Duration,
    lock_wait: Duration,
    /// Production honors `HTTPS_PROXY` and friends like any other client; tests
    /// talking to a loopback fake must not be routed through the developer's
    /// proxy.
    honor_proxy_env: bool,
}

impl Release<'static> {
    fn for_this_build() -> Result<Self, String> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        Ok(Self {
            version: VERSION,
            platform: platform_id()?,
            base_url: dist_base_url(),
            scratch_tag: format!("{}-{nanos}", std::process::id()),
            retry_delay: DOWNLOAD_RETRY_DELAY,
            manifest_timeout: MANIFEST_TIMEOUT,
            archive_timeout: ARCHIVE_TIMEOUT,
            lock_wait: LOCK_WAIT,
            honor_proxy_env: true,
        })
    }
}

impl Release<'_> {
    fn asset(&self) -> String {
        asset_name(self.version, self.platform)
    }

    fn manifest_url(&self) -> String {
        format!("{}/SHA256SUMS", self.base_url)
    }

    fn archive_url(&self) -> String {
        format!("{}/{}", self.base_url, self.asset())
    }

    fn lock_path(&self, install_root: &Path) -> PathBuf {
        install_root.join(format!(".launcher-{}.lock", self.version))
    }

    fn staging_path(&self, install_root: &Path) -> PathBuf {
        install_root.join(format!(
            "{}{}",
            scratch_prefix("staging", self.version),
            self.scratch_tag
        ))
    }

    fn rollback_path(&self, install_root: &Path) -> PathBuf {
        install_root.join(format!(
            "{}{}",
            scratch_prefix("rollback", self.version),
            self.scratch_tag
        ))
    }
}

fn asset_name(version: &str, platform: &str) -> String {
    format!("mangostudio-{version}-{platform}.{ARCHIVE_EXTENSION}")
}

/// Prefix of every scratch directory of one kind for one version. The
/// launcher keeps its own `.launcher-` family apart from the hub's
/// `.staging-*` and the install scripts' `.install-*`: those tools take no
/// launcher lock, so sweeping their names could delete a live install.
fn scratch_prefix(kind: &str, version: &str) -> String {
    format!(".launcher-{kind}-{version}.")
}

/// What `ensure_install` found or did.
#[derive(Debug, PartialEq, Eq)]
enum InstallStart {
    /// A complete install was already there; nothing was touched.
    Complete,
    /// A verified archive was unpacked into place.
    Installed,
    /// An install with a binary exists but could not be repaired or replaced.
    /// The caller starts it and says why.
    KeptInstalled { reason: String },
}

/// Why an install attempt stopped, as far as the previous tree is concerned.
#[derive(Debug)]
enum InstallError {
    Failed(String),
    /// The previous install is exactly where it was.
    PreviousKept(String),
    /// The swap moved the previous install aside and could not put it back;
    /// the message names where it is.
    PreviousStranded(String),
}

impl From<String> for InstallError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

/// Make sure `install_dir` holds a complete install, downloading one only when
/// it does not. A complete install costs two `stat` calls and nothing else.
fn ensure_install(release: &Release<'_>, install_dir: &Path) -> Result<InstallStart, String> {
    if install_is_complete(install_dir) {
        return Ok(InstallStart::Complete);
    }
    let install_root = install_root_of(install_dir)?;
    fs::create_dir_all(install_root)
        .map_err(|error| format!("cannot create {}: {error}", install_root.display()))?;

    let lock = acquire_install_lock(release, install_root);
    match &lock {
        InstallLock::Held { .. } => {}
        InstallLock::TimedOut(reason) => return kept_or_error(install_dir, reason.clone()),
        InstallLock::Unavailable(reason) => {
            if has_working_binary(install_dir) {
                return Ok(InstallStart::KeptInstalled {
                    reason: format!("cannot repair the install without its lock ({reason})"),
                });
            }
            // Locks are advisory and some file systems refuse them. With
            // nothing to start, installing unlocked beats not starting.
            eprintln!("mangostudio launcher: warning: {reason}; installing without a lock");
        }
    }

    if matches!(lock, InstallLock::Held { .. }) {
        // Leftovers are only safe to touch while holding the lock: every
        // launcher that creates, swaps or removes these directories holds it,
        // so under it nothing here belongs to a live install. Without the
        // lock a sweep could delete another launcher's staging mid-unpack.
        restore_interrupted_swap(release, install_root, install_dir);
        sweep_scratch_dirs(release, install_root);
        // Another launcher may have finished while this one waited, or the
        // restore above may have brought a complete tree back.
        if install_is_complete(install_dir) {
            return Ok(InstallStart::Complete);
        }
    }

    // Find out cheaply, before downloading ~60 MB, whether the existing tree
    // can be replaced at all. On Windows a running hub holds its files and
    // the directory cannot move.
    if install_dir.exists()
        && let Err(error) = probe_replaceable(release, install_root, install_dir)
    {
        return install_error_to_start(install_dir, error);
    }

    eprintln!(
        "Downloading MangoStudio {} for {}...",
        release.version, release.platform
    );
    let manifest = download_manifest(release)?;
    match install_archive(release, install_root, install_dir, &manifest) {
        Ok(()) => Ok(InstallStart::Installed),
        Err(error) => install_error_to_start(install_dir, error),
    }
}

/// A failure that left the previous install in place is not fatal when that
/// install has a binary to run; anything else is.
fn install_error_to_start(install_dir: &Path, error: InstallError) -> Result<InstallStart, String> {
    match error {
        InstallError::Failed(message) | InstallError::PreviousStranded(message) => Err(message),
        InstallError::PreviousKept(message) => kept_or_error(install_dir, message),
    }
}

fn kept_or_error(install_dir: &Path, reason: String) -> Result<InstallStart, String> {
    if has_working_binary(install_dir) {
        Ok(InstallStart::KeptInstalled { reason })
    } else {
        Err(reason)
    }
}

fn install_root_of(install_dir: &Path) -> Result<&Path, String> {
    install_dir
        .parent()
        .ok_or_else(|| format!("install dir {} has no parent", install_dir.display()))
}

/// The install is complete when its binary is there and, if the launcher left a
/// record, every file the record lists still has the recorded size.
///
/// The record exists because a rename makes a directory appear atomically but
/// says nothing about its file data: after a power loss the tree can be there
/// with a zero-length or short binary. Comparing sizes catches that at every
/// start for the price of a `stat` each, where the alternative (fsync every
/// unpacked file and the parent directory before the rename) costs
/// milliseconds per file on every install and has no portable directory sync
/// on Windows.
///
/// A tree with no record was laid down by the install scripts or an older
/// launcher. Nothing is known about it beyond the binary, so a non-empty
/// binary counts: a good install must not be downloaded again.
fn install_is_complete(install_dir: &Path) -> bool {
    if !has_working_binary(install_dir) {
        return false;
    }
    match fs::read_to_string(install_dir.join(INSTALL_RECORD)) {
        Ok(record) => record_matches(install_dir, &record),
        Err(error) => error.kind() == io::ErrorKind::NotFound,
    }
}

fn has_working_binary(install_dir: &Path) -> bool {
    fs::metadata(install_dir.join(BINARY_NAME))
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
}

/// The `<bytes>\t<name>` lines for the top-level files of a freshly unpacked
/// tree, in name order.
fn completion_record(directory: &Path) -> io::Result<String> {
    let mut files = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        files.push((name, entry.metadata()?.len()));
    }
    files.sort();
    Ok(files
        .iter()
        .map(|(name, bytes)| format!("{bytes}\t{name}\n"))
        .collect())
}

/// True when every line of `record` names a file in `directory` of exactly the
/// recorded size and the binary is among them. An empty, truncated or
/// otherwise unreadable record never matches.
fn record_matches(directory: &Path, record: &str) -> bool {
    let mut lists_binary = false;
    for line in record.lines() {
        let Some((bytes, name)) = line.split_once('\t') else {
            return false;
        };
        let Ok(bytes) = bytes.parse::<u64>() else {
            return false;
        };
        if Path::new(name).file_name() != Some(OsStr::new(name)) {
            return false;
        }
        match fs::metadata(directory.join(name)) {
            Ok(metadata) if metadata.is_file() && metadata.len() == bytes => {}
            _ => return false,
        }
        lists_binary |= name == BINARY_NAME;
    }
    lists_binary
}

/// The lock that serializes installs of one version in one install root.
enum InstallLock {
    /// Held until the file drops or the process dies; the field exists only to
    /// keep the file open.
    Held { _file: fs::File },
    /// The wait ran out while another launcher kept the lock.
    TimedOut(String),
    /// The file system refused to open or lock it (`ENOLCK` on some network
    /// mounts, `Unsupported` elsewhere).
    Unavailable(String),
}

/// Take the exclusive advisory lock on `.launcher-<version>.lock` beside the
/// version directories. It is polled rather than awaited so a dead holder costs
/// a bounded wait and a one-line message, not a silent hang. It lives outside
/// the version directory because the swap moves that directory.
fn acquire_install_lock(release: &Release<'_>, install_root: &Path) -> InstallLock {
    let path = release.lock_path(install_root);
    let file = match fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) => {
            return InstallLock::Unavailable(format!("cannot open {}: {error}", path.display()));
        }
    };
    let deadline = Instant::now() + release.lock_wait;
    let mut announced = false;
    loop {
        match file.try_lock() {
            Ok(()) => return InstallLock::Held { _file: file },
            Err(fs::TryLockError::WouldBlock) => {}
            Err(fs::TryLockError::Error(error)) => {
                return InstallLock::Unavailable(format!(
                    "cannot lock {}: {error}",
                    path.display()
                ));
            }
        }
        if Instant::now() >= deadline {
            return InstallLock::TimedOut(format!(
                "timed out after {}s waiting for another launcher to finish installing {} (lock {})",
                release.lock_wait.as_secs(),
                release.version,
                path.display()
            ));
        }
        if !announced {
            eprintln!(
                "Waiting for another mangostudio launcher to finish installing {}...",
                release.version
            );
            announced = true;
        }
        thread::sleep(LOCK_POLL);
    }
}

/// The directory names in `install_root` that start with `prefix` and are
/// directories, in name order.
fn scratch_dirs(install_root: &Path, prefix: &str) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(install_root) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(prefix))
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect();
    found.sort();
    found
}

/// A swap that died between moving the old tree aside and moving the new one
/// in leaves no version directory but a complete rollback tree. Put it back so
/// the start finds what it had before the crash. Call only under the lock.
fn restore_interrupted_swap(release: &Release<'_>, install_root: &Path, install_dir: &Path) {
    if install_dir.exists() {
        return;
    }
    for rollback in scratch_dirs(install_root, &scratch_prefix("rollback", release.version)) {
        if install_is_complete(&rollback) && fs::rename(&rollback, install_dir).is_ok() {
            eprintln!(
                "Restored the previous MangoStudio {} install left by an interrupted update.",
                release.version
            );
            return;
        }
    }
}

/// Remove this version's staging and rollback directories left by launchers
/// that died. Call only under the lock.
fn sweep_scratch_dirs(release: &Release<'_>, install_root: &Path) {
    for kind in ["staging", "rollback"] {
        for leftover in scratch_dirs(install_root, &scratch_prefix(kind, release.version)) {
            let _ = fs::remove_dir_all(leftover);
        }
    }
}

/// Move `install_dir` aside and straight back. It is the same move the swap
/// does later, so it fails exactly when the swap would, and it fails before
/// the archive is downloaded.
fn probe_replaceable(
    release: &Release<'_>,
    install_root: &Path,
    install_dir: &Path,
) -> Result<(), InstallError> {
    let aside = release.rollback_path(install_root);
    fs::rename(install_dir, &aside).map_err(|error| {
        InstallError::PreviousKept(format!(
            "cannot replace the install at {}: {error}",
            install_dir.display()
        ))
    })?;
    fs::rename(&aside, install_dir).map_err(|error| {
        InstallError::PreviousStranded(format!(
            "cannot restore the install to {} after checking it can be replaced: {error}; it is still at {}",
            install_dir.display(),
            aside.display()
        ))
    })
}

fn download_manifest(release: &Release<'_>) -> Result<String, String> {
    let bytes = download(
        release,
        &release.manifest_url(),
        release.manifest_timeout,
        MAX_MANIFEST_BYTES,
    )?;
    String::from_utf8(bytes).map_err(|_| "SHA256SUMS is not valid UTF-8".to_string())
}

/// Download the archive named by `manifest`, check it against the manifest's
/// digest, unpack it into a staging directory and swap that into `install_dir`.
fn install_archive(
    release: &Release<'_>,
    install_root: &Path,
    install_dir: &Path,
    manifest: &str,
) -> Result<(), InstallError> {
    let asset = release.asset();
    let expected = expected_checksum(manifest, &asset)?;
    let archive = download(
        release,
        &release.archive_url(),
        release.archive_timeout,
        MAX_DOWNLOAD_BYTES,
    )?;

    let actual = sha256_hex(&archive);
    if expected != actual {
        return Err(InstallError::Failed(format!(
            "checksum mismatch for {asset}: expected {expected}, got {actual}"
        )));
    }
    eprintln!("Checksum verified: {asset}");

    // Unpack into a staging dir and rename into place so a crash mid-unpack
    // never leaves a half-written version directory that later runs trust. The
    // guard removes the staging dir on every exit that did not rename it away.
    let staging = ScratchDir::new(release.staging_path(install_root));
    unpack(&archive, staging.path())?;

    let staged_binary = staging.path().join(BINARY_NAME);
    if !staged_binary.is_file() {
        return Err(InstallError::Failed(format!(
            "archive is missing {BINARY_NAME}"
        )));
    }
    make_executable(&staged_binary)?;
    let record = completion_record(staging.path())
        .map_err(|error| format!("cannot record the unpacked files: {error}"))?;
    fs::write(staging.path().join(INSTALL_RECORD), record)
        .map_err(|error| format!("cannot record the unpacked files: {error}"))?;

    swap_into_place(release, install_root, staging.path(), install_dir)?;
    eprintln!(
        "Installed MangoStudio {} to {}",
        release.version,
        install_dir.display()
    );
    Ok(())
}

/// A directory removed when dropped. After a successful rename the path no
/// longer exists and the removal is a no-op.
struct ScratchDir(PathBuf);

impl ScratchDir {
    fn new(path: PathBuf) -> Self {
        let _ = fs::remove_dir_all(&path);
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Put the staged tree at `install_dir`. An existing install is moved aside
/// first and deleted only once the new one is in place: a Unix hub keeps
/// running from its unlinked files either way, and on Windows the move fails
/// cleanly while the hub holds its files, where a recursive delete would
/// half-empty the directory the hub is running from.
fn swap_into_place(
    release: &Release<'_>,
    install_root: &Path,
    staging: &Path,
    install_dir: &Path,
) -> Result<(), InstallError> {
    let aside = release.rollback_path(install_root);
    let had_previous = install_dir.exists();
    if had_previous {
        fs::rename(install_dir, &aside).map_err(|error| {
            InstallError::PreviousKept(format!(
                "cannot replace the install at {}: {error}",
                install_dir.display()
            ))
        })?;
    }

    let Err(error) = fs::rename(staging, install_dir) else {
        if had_previous {
            let _ = fs::remove_dir_all(&aside);
        }
        return Ok(());
    };
    // A launcher that could not lock may have completed the same install first.
    if install_is_complete(install_dir) {
        if had_previous {
            let _ = fs::remove_dir_all(&aside);
        }
        return Ok(());
    }
    if !had_previous {
        return Err(InstallError::Failed(format!(
            "cannot move install into {}: {error}",
            install_dir.display()
        )));
    }
    match fs::rename(&aside, install_dir) {
        Ok(()) => Err(InstallError::PreviousKept(format!(
            "cannot move the new install into {}: {error}",
            install_dir.display()
        ))),
        Err(restore_error) => Err(InstallError::PreviousStranded(format!(
            "cannot move the new install into {}: {error}; restoring the previous install failed too ({restore_error}); it is still at {}",
            install_dir.display(),
            aside.display()
        ))),
    }
}

fn http_agent(release: &Release<'_>, timeout: Duration) -> ureq::Agent {
    let builder = ureq::Agent::config_builder().timeout_global(Some(timeout));
    let builder = if release.honor_proxy_env {
        builder
    } else {
        builder.proxy(None)
    };
    builder.build().into()
}

fn download(
    release: &Release<'_>,
    url: &str,
    timeout: Duration,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    let agent = http_agent(release, timeout);
    let mut delay = release.retry_delay;
    let mut last_error = String::new();
    for attempt in 1..=DOWNLOAD_ATTEMPTS {
        match fetch(&agent, url, max_bytes) {
            Ok(bytes) => return Ok(bytes),
            Err(error) => last_error = error,
        }
        if attempt < DOWNLOAD_ATTEMPTS {
            eprintln!(
                "Download failed (attempt {attempt}/{DOWNLOAD_ATTEMPTS}); retrying in {}s",
                delay.as_secs()
            );
            thread::sleep(delay);
            delay *= 2;
        }
    }
    Err(format!("cannot download {url}: {last_error}"))
}

fn fetch(agent: &ureq::Agent, url: &str, max_bytes: u64) -> Result<Vec<u8>, String> {
    let mut response = agent.get(url).call().map_err(|error| error.to_string())?;
    response
        .body_mut()
        .with_config()
        .limit(max_bytes)
        .read_to_vec()
        .map_err(|error| error.to_string())
}

/// Find the sha256 for `asset` in a `sha256sum`-style manifest. The format is
/// produced by archive-assets.ts and pinned by
/// scripts/tests/support/SHA256SUMS.sample alongside verify-checksum.ts,
/// install.sh, and install.ps1. A `*` before the name marks binary mode and is
/// equivalent.
fn expected_checksum(manifest: &str, asset: &str) -> Result<String, String> {
    for line in manifest.lines() {
        let mut fields = line.split_whitespace();
        let (Some(checksum), Some(name)) = (fields.next(), fields.next()) else {
            continue;
        };
        if name.strip_prefix('*').unwrap_or(name) == asset {
            return Ok(checksum.to_ascii_lowercase());
        }
    }
    Err(format!("SHA256SUMS does not list {asset}"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write;

    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

#[cfg(unix)]
fn unpack(archive: &[u8], destination: &Path) -> Result<(), String> {
    let decoder = flate2::read::GzDecoder::new(archive);
    tar::Archive::new(decoder)
        .unpack(destination)
        .map_err(|error| format!("cannot unpack archive: {error}"))
}

#[cfg(windows)]
fn unpack(archive: &[u8], destination: &Path) -> Result<(), String> {
    let cursor = std::io::Cursor::new(archive);
    let mut zip_archive =
        zip::ZipArchive::new(cursor).map_err(|error| format!("cannot unpack archive: {error}"))?;
    zip_archive
        .extract(destination)
        .map_err(|error| format!("cannot unpack archive: {error}"))
}

#[cfg(unix)]
fn make_executable(binary: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(binary, fs::Permissions::from_mode(0o755))
        .map_err(|error| format!("cannot mark {} executable: {error}", binary.display()))
}

#[cfg(windows)]
fn make_executable(_binary: &Path) -> Result<(), String> {
    Ok(())
}

/// The `Command` that runs the real binary, with the two launcher markers set
/// and everything else — arguments aside, added by each caller — left to
/// std's default of inheriting the current environment untouched.
/// `detectInstallOrigin` on the hub side reads these to tell a cargo install
/// apart from a self-managed one sitting at a similar-looking path, the same
/// way the npm wrapper announces itself. `current_exe()` can fail under some
/// sandboxes; the path marker is simply omitted then rather than failing the
/// whole launch over a diagnostic value.
fn launcher_command(binary: &Path) -> Command {
    let mut command = Command::new(binary);
    command.env("MANGOSTUDIO_LAUNCHER", "cargo");
    if let Ok(exe) = env::current_exe() {
        command.env("MANGOSTUDIO_LAUNCHER_PATH", exe);
    }
    command
}

/// Replace this process with the real binary (Unix) or spawn it and forward
/// the exit code (Windows).
#[cfg(unix)]
fn run_binary(binary: &Path) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let error = launcher_command(binary).args(env::args_os().skip(1)).exec();
    Err(format!("cannot exec {}: {error}", binary.display()))
}

#[cfg(windows)]
fn run_binary(binary: &Path) -> Result<(), String> {
    let status = launcher_command(binary)
        .args(env::args_os().skip(1))
        .status()
        .map_err(|error| format!("cannot run {}: {error}", binary.display()))?;
    std::process::exit(status.code().unwrap_or(1));
}

// Fakes shared with the process-level tests in `tests/`. Declared here rather
// than inside `mod tests` because `#[path]` inside an inline module resolves
// against `src/tests/`.
#[cfg(test)]
#[path = "../tests/support/fake_release_server.rs"]
#[allow(dead_code)]
mod fake_release_server;
#[cfg(test)]
#[path = "../tests/support/release_archive.rs"]
#[allow(dead_code)]
mod release_archive;

#[cfg(test)]
mod tests {
    use super::*;

    const CHECKSUM_FIXTURE: &str = include_str!("../../../scripts/tests/support/SHA256SUMS.sample");

    #[test]
    fn platform_id_maps_the_test_host_to_a_release_asset() {
        let id = platform_id().expect("test host is a supported release platform");
        assert!(asset_name(VERSION, id).starts_with(&format!("mangostudio-{VERSION}-")));
    }

    #[test]
    fn expected_checksum_reads_shared_fixture_line_shapes() {
        assert_eq!(
            expected_checksum(CHECKSUM_FIXTURE, "mangostudio-0.1.0-linux-x64.tar.gz").as_deref(),
            Ok("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        );
        assert_eq!(
            expected_checksum(CHECKSUM_FIXTURE, "mangostudio-0.1.0-darwin-arm64.tar.gz").as_deref(),
            Ok("fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210")
        );
        assert_eq!(
            expected_checksum(CHECKSUM_FIXTURE, "mangostudio-0.1.0-windows-x64.zip").as_deref(),
            Ok("abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789")
        );
    }

    #[test]
    fn expected_checksum_rejects_unlisted_assets() {
        assert!(
            expected_checksum(CHECKSUM_FIXTURE, "mangostudio-0.1.0-linux-arm64.tar.gz").is_err()
        );
    }

    #[test]
    fn sha256_hex_matches_the_known_test_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    /// RUSTSEC-2026-0368: zip 8.x created a symlink entry whose target left
    /// the destination. The release archive is checksummed, but the manifest
    /// comes from the same release, so extraction itself must stay contained.
    #[cfg(windows)]
    #[test]
    fn unpack_refuses_a_symlink_that_escapes_the_destination() {
        use std::io::Write;
        use zip::write::{SimpleFileOptions, ZipWriter};

        let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer
            .start_file("mangostudio.exe", SimpleFileOptions::default())
            .and_then(|()| writer.write_all(b"binary").map_err(Into::into))
            .expect("expected the fixture binary entry to be written");
        writer
            .add_symlink("escape", "../outside", SimpleFileOptions::default())
            .expect("expected the fixture symlink entry to be written");
        let archive = writer
            .finish()
            .expect("expected the fixture archive to finish")
            .into_inner();
        let destination = env::temp_dir().join(format!(
            "mangostudio-launcher-unpack-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&destination);
        fs::create_dir_all(&destination).expect("expected a fresh destination");

        let result = unpack(&archive, &destination);
        let escape_exists = fs::symlink_metadata(destination.join("escape")).is_ok();
        fs::remove_dir_all(&destination).ok();

        assert!(
            matches!(&result, Err(message) if message.contains("escapes the destination")),
            "expected unpack to refuse the escaping symlink | received {result:?}"
        );
        assert!(
            !escape_exists,
            "expected no `escape` entry in the destination | received one"
        );
    }

    #[test]
    fn unpack_reports_bytes_that_are_not_an_archive_as_one_message_on_every_platform() {
        let destination = env::temp_dir().join(format!(
            "mangostudio-launcher-not-an-archive-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&destination);

        let result = unpack(b"not an archive", &destination);
        let _ = fs::remove_dir_all(&destination);

        assert!(
            matches!(&result, Err(message) if message.starts_with("cannot unpack archive:")),
            "expected `cannot unpack archive: ...` | received {result:?}"
        );
    }

    #[test]
    fn launcher_command_sets_both_markers() {
        let command = launcher_command(Path::new("/tmp/mangostudio"));
        let envs: std::collections::HashMap<_, _> = command.get_envs().collect();

        assert_eq!(
            envs.get(std::ffi::OsStr::new("MANGOSTUDIO_LAUNCHER")),
            Some(&Some(std::ffi::OsStr::new("cargo")))
        );
        // current_exe() succeeds in a normal test process, so the path marker
        // is set too — the omission path only fires under sandboxes this test
        // does not run in.
        let launcher_path = envs
            .get(std::ffi::OsStr::new("MANGOSTUDIO_LAUNCHER_PATH"))
            .expect("current_exe() should succeed in the test process");
        assert!(launcher_path.is_some());
    }

    // --- install safety: a named fake release host, real files on disk ---

    use crate::fake_release_server::{ClosedConnectionServer, FakeReleaseServer};
    use crate::release_archive::{archive_with_binary, manifest_listing};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const TEST_VERSION: &str = "0.0.0";
    const TEST_PLATFORM: &str = "test-platform";
    const TEST_TAG: &str = "test-owner";

    /// A scratch install root removed on drop.
    struct ScratchRoot(PathBuf);

    impl ScratchRoot {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = env::temp_dir().join(format!(
                "mangostudio-launcher-install-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("expected a fresh scratch install root");
            Self(path)
        }
    }

    impl Drop for ScratchRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A release published on a fake host, installed under a scratch root.
    struct InstallFixture {
        server: FakeReleaseServer,
        root: ScratchRoot,
        version: &'static str,
    }

    impl InstallFixture {
        fn new() -> Self {
            Self::with_version(TEST_VERSION)
        }

        fn with_version(version: &'static str) -> Self {
            Self {
                server: FakeReleaseServer::start(),
                root: ScratchRoot::new(),
                version,
            }
        }

        fn install_dir(&self) -> PathBuf {
            self.root.0.join(self.version)
        }

        fn release_at(&self, base_url: String) -> Release<'static> {
            Release {
                version: self.version,
                platform: TEST_PLATFORM,
                base_url,
                scratch_tag: TEST_TAG.to_string(),
                retry_delay: Duration::ZERO,
                manifest_timeout: Duration::from_secs(5),
                archive_timeout: Duration::from_secs(5),
                lock_wait: Duration::from_secs(5),
                honor_proxy_env: false,
            }
        }

        fn release(&self) -> Release<'static> {
            self.release_at(self.server.base_url())
        }

        fn asset(&self) -> String {
            asset_name(self.version, TEST_PLATFORM)
        }

        fn publish(&self, binary_body: &str) {
            let archive = archive_with_binary(binary_body);
            self.server.serve(
                "/SHA256SUMS",
                manifest_listing(&self.asset(), &archive).into_bytes(),
            );
            self.server.serve(&format!("/{}", self.asset()), archive);
        }

        fn start(&self) -> Result<InstallStart, String> {
            ensure_install(&self.release(), &self.install_dir())
        }

        fn binary_path(&self) -> PathBuf {
            self.install_dir().join(BINARY_NAME)
        }

        fn installed_binary_body(&self) -> String {
            fs::read_to_string(self.binary_path()).expect("expected an installed binary")
        }

        fn record(&self) -> Option<String> {
            fs::read_to_string(self.install_dir().join(INSTALL_RECORD)).ok()
        }

        fn archive_requests(&self) -> usize {
            self.server.request_count(&format!("/{}", self.asset()))
        }

        /// Names of everything in the install root but the version directory
        /// and the lock file: scratch directories a start must not leave.
        fn leftover_scratch(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(&self.root.0)
                .expect("expected a readable install root")
                .map(|entry| {
                    entry
                        .expect("readable entry")
                        .file_name()
                        .to_string_lossy()
                        .into_owned()
                })
                .filter(|name| name.starts_with(".launcher-") && !name.ends_with(".lock"))
                .collect();
            names.sort();
            names
        }

        /// A tree that passes `install_is_complete`: the binary, a sibling file
        /// and a record of both.
        fn lay_down_complete_install(&self, binary_body: &str) {
            let directory = self.install_dir();
            fs::create_dir_all(&directory).expect("expected the install dir");
            fs::write(directory.join(BINARY_NAME), binary_body).expect("expected the binary");
            fs::write(directory.join("README.md"), "readme").expect("expected the readme");
            #[cfg(unix)]
            make_executable(&directory.join(BINARY_NAME)).expect("expected an executable");
            let record = completion_record(&directory).expect("expected a record");
            fs::write(directory.join(INSTALL_RECORD), record).expect("expected the record file");
        }
    }

    #[test]
    fn install_without_an_existing_tree_downloads_and_records_the_unpacked_sizes() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");

        let outcome = fixture.start();

        assert_eq!(outcome, Ok(InstallStart::Installed));
        assert_eq!(fixture.installed_binary_body(), "binary one");
        let record = fixture.record().expect("expected an install record");
        assert!(
            record.contains(&format!("{}\t{BINARY_NAME}\n", "binary one".len())),
            "expected the record to list the binary with its size | received {record:?}"
        );
        assert!(install_is_complete(&fixture.install_dir()));
        assert_eq!(fixture.leftover_scratch(), Vec::<String>::new());
    }

    #[test]
    fn a_complete_install_starts_with_no_request() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        assert_eq!(fixture.start(), Ok(InstallStart::Installed));
        fixture.server.forget_requests();

        let outcome = fixture.start();

        assert_eq!(outcome, Ok(InstallStart::Complete));
        assert_eq!(
            fixture.server.requests(),
            Vec::<String>::new(),
            "expected no request for a complete install"
        );
    }

    #[test]
    fn a_canary_version_with_a_complete_install_starts_like_any_other_with_no_request() {
        let fixture = InstallFixture::with_version("0.0.0-canary.abc1234");
        fixture.publish("binary one");
        assert_eq!(fixture.start(), Ok(InstallStart::Installed));
        fixture.server.forget_requests();

        assert_eq!(fixture.start(), Ok(InstallStart::Complete));
        assert_eq!(fixture.server.requests(), Vec::<String>::new());
    }

    #[test]
    fn an_install_without_a_record_still_starts_and_is_not_downloaded_again() {
        let fixture = InstallFixture::new();
        // What the install scripts and older launchers leave: the files, no record.
        fs::create_dir_all(fixture.install_dir()).expect("expected the install dir");
        fs::write(fixture.binary_path(), "script-installed binary").expect("expected a binary");

        let outcome = fixture.start();

        assert_eq!(outcome, Ok(InstallStart::Complete));
        assert_eq!(fixture.server.requests(), Vec::<String>::new());
        assert_eq!(fixture.record(), None);
    }

    #[test]
    fn an_empty_binary_without_a_record_is_reinstalled() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        fs::create_dir_all(fixture.install_dir()).expect("expected the install dir");
        fs::write(fixture.binary_path(), "").expect("expected an empty binary");

        assert_eq!(fixture.start(), Ok(InstallStart::Installed));
        assert_eq!(fixture.installed_binary_body(), "binary one");
    }

    #[test]
    fn a_binary_shorter_than_its_record_is_reinstalled() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        assert_eq!(fixture.start(), Ok(InstallStart::Installed));
        // What a power loss can leave: the tree and its record, a short binary.
        fs::write(fixture.binary_path(), "bin").expect("expected a truncated binary");
        assert!(!install_is_complete(&fixture.install_dir()));

        let outcome = fixture.start();

        assert_eq!(outcome, Ok(InstallStart::Installed));
        assert_eq!(fixture.installed_binary_body(), "binary one");
        assert!(install_is_complete(&fixture.install_dir()));
    }

    #[test]
    fn an_unreadable_record_does_not_count_as_a_complete_install() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        assert_eq!(fixture.start(), Ok(InstallStart::Installed));
        for record in [
            "",
            "not a record\n",
            "10\n",
            "x\tmangostudio\n",
            "10\tother-file\n",
        ] {
            fs::write(fixture.install_dir().join(INSTALL_RECORD), record)
                .expect("expected the record to be overwritten");

            assert!(
                !install_is_complete(&fixture.install_dir()),
                "expected record {record:?} not to describe a complete install"
            );
        }
    }

    #[test]
    fn offline_without_an_install_fails_naming_the_download_and_leaves_nothing() {
        let fixture = InstallFixture::new();
        let offline = ClosedConnectionServer::start();

        let outcome = ensure_install(
            &fixture.release_at(offline.base_url()),
            &fixture.install_dir(),
        );

        assert!(
            matches!(&outcome, Err(message) if message.contains("cannot download")),
            "expected a download failure | received {outcome:?}"
        );
        assert!(!fixture.install_dir().exists());
        assert_eq!(fixture.leftover_scratch(), Vec::<String>::new());
    }

    #[test]
    fn a_missing_release_fails_the_first_install() {
        let fixture = InstallFixture::new();
        fixture.server.serve_status("/SHA256SUMS", 404);

        let outcome = fixture.start();

        assert!(
            matches!(&outcome, Err(message) if message.contains("404")),
            "expected a failure citing the 404 | received {outcome:?}"
        );
    }

    #[test]
    fn a_stalled_archive_download_ends_at_its_deadline_instead_of_hanging() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        fixture
            .server
            .serve_hanging(&format!("/{}", fixture.asset()));
        let mut release = fixture.release();
        release.archive_timeout = Duration::from_millis(300);
        let started = Instant::now();

        let outcome = ensure_install(&release, &fixture.install_dir());

        assert!(
            matches!(&outcome, Err(message) if message.contains("cannot download") && message.contains("timeout")),
            "expected a timeout failure | received {outcome:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "expected three attempts at 300 ms each to end quickly | took {:?}",
            started.elapsed()
        );
        assert_eq!(fixture.leftover_scratch(), Vec::<String>::new());
    }

    #[test]
    fn a_stalled_manifest_request_ends_at_its_deadline_instead_of_hanging() {
        let fixture = InstallFixture::new();
        fixture.server.serve_hanging("/SHA256SUMS");
        let mut release = fixture.release();
        release.manifest_timeout = Duration::from_millis(300);

        let outcome = ensure_install(&release, &fixture.install_dir());

        assert!(
            matches!(&outcome, Err(message) if message.contains("timeout")),
            "expected a timeout failure | received {outcome:?}"
        );
    }

    #[test]
    fn an_archive_that_fails_its_checksum_fails_and_leaves_no_scratch_directory() {
        let fixture = InstallFixture::new();
        let announced = archive_with_binary("binary two");
        fixture.server.serve(
            "/SHA256SUMS",
            manifest_listing(&fixture.asset(), &announced).into_bytes(),
        );
        fixture.server.serve(
            &format!("/{}", fixture.asset()),
            archive_with_binary("tampered"),
        );

        let outcome = fixture.start();

        assert!(
            matches!(&outcome, Err(message) if message.contains("checksum mismatch")),
            "expected a checksum mismatch failure | received {outcome:?}"
        );
        assert!(!fixture.install_dir().exists());
        assert_eq!(fixture.leftover_scratch(), Vec::<String>::new());
    }

    #[test]
    fn a_failed_unpack_leaves_no_install_record_or_staging_directory() {
        let fixture = InstallFixture::new();
        // Verified bytes that are not an archive: the checksum passes and the
        // unpack fails, the failure that used to leak its staging directory.
        let not_an_archive = b"not an archive".to_vec();
        fixture.server.serve(
            "/SHA256SUMS",
            manifest_listing(&fixture.asset(), &not_an_archive).into_bytes(),
        );
        fixture
            .server
            .serve(&format!("/{}", fixture.asset()), not_an_archive);

        let outcome = fixture.start();

        assert!(
            matches!(&outcome, Err(message) if message.starts_with("cannot unpack archive:")),
            "expected `cannot unpack archive: ...` | received {outcome:?}"
        );
        assert!(!fixture.install_dir().exists());
        assert_eq!(fixture.record(), None);
        assert_eq!(
            fixture.leftover_scratch(),
            Vec::<String>::new(),
            "expected the failed unpack to remove its staging directory"
        );
    }

    #[test]
    fn an_archive_without_the_binary_fails_and_leaves_nothing() {
        let fixture = InstallFixture::new();
        let archive = crate::release_archive::archive_without_binary();
        fixture.server.serve(
            "/SHA256SUMS",
            manifest_listing(&fixture.asset(), &archive).into_bytes(),
        );
        fixture
            .server
            .serve(&format!("/{}", fixture.asset()), archive);

        let outcome = fixture.start();

        assert!(
            matches!(&outcome, Err(message) if message.contains("archive is missing")),
            "expected a missing-binary failure | received {outcome:?}"
        );
        assert!(!fixture.install_dir().exists());
        assert_eq!(fixture.leftover_scratch(), Vec::<String>::new());
    }

    #[test]
    fn two_starts_racing_an_empty_install_download_the_archive_once() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        // Hold the archive back so both starts are inside the install at once.
        fixture.server.serve_slowly(
            &format!("/{}", fixture.asset()),
            archive_with_binary("binary one"),
            Duration::from_millis(400),
        );

        let outcomes: Vec<_> = thread::scope(|scope| {
            let starts: Vec<_> = (0..2).map(|_| scope.spawn(|| fixture.start())).collect();
            starts
                .into_iter()
                .map(|start| start.join().expect("expected the start thread to finish"))
                .collect()
        });

        assert_eq!(
            fixture.archive_requests(),
            1,
            "expected one archive download for two racing starts | received {} (outcomes {outcomes:?})",
            fixture.archive_requests()
        );
        assert!(
            outcomes.contains(&Ok(InstallStart::Installed)),
            "{outcomes:?}"
        );
        assert!(
            outcomes.contains(&Ok(InstallStart::Complete)),
            "{outcomes:?}"
        );
    }

    #[test]
    fn a_start_that_waits_longer_than_the_lock_budget_fails_naming_the_lock() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        let other_launcher = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(fixture.release().lock_path(&fixture.root.0))
            .expect("expected the lock file");
        other_launcher.lock().expect("expected to hold the lock");
        let mut release = fixture.release();
        release.lock_wait = Duration::from_millis(300);

        let outcome = ensure_install(&release, &fixture.install_dir());

        assert!(
            matches!(&outcome, Err(message) if message.contains("timed out") && message.contains(".launcher-0.0.0.lock")),
            "expected a lock timeout naming the lock file | received {outcome:?}"
        );
        assert_eq!(fixture.server.requests(), Vec::<String>::new());
    }

    #[test]
    fn a_lock_wait_timeout_still_starts_an_install_that_has_a_binary() {
        let fixture = InstallFixture::new();
        fixture.lay_down_complete_install("binary one");
        fs::write(fixture.binary_path(), "bin").expect("expected a short binary");
        let other_launcher = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(fixture.release().lock_path(&fixture.root.0))
            .expect("expected the lock file");
        other_launcher.lock().expect("expected to hold the lock");
        let mut release = fixture.release();
        release.lock_wait = Duration::from_millis(300);

        let outcome = ensure_install(&release, &fixture.install_dir());

        assert!(
            matches!(&outcome, Ok(InstallStart::KeptInstalled { reason }) if reason.contains("timed out")),
            "expected the installed build to be kept | received {outcome:?}"
        );
    }

    /// A directory where the lock file should be: opening it for writing fails
    /// on every platform, which is how a file system that refuses locks looks
    /// to the launcher.
    fn make_lock_unavailable(fixture: &InstallFixture) {
        fs::create_dir_all(fixture.release().lock_path(&fixture.root.0))
            .expect("expected a directory in place of the lock file");
    }

    #[test]
    fn a_lock_the_file_system_refuses_does_not_stop_a_first_install() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        make_lock_unavailable(&fixture);

        let outcome = fixture.start();

        assert_eq!(outcome, Ok(InstallStart::Installed));
        assert_eq!(fixture.installed_binary_body(), "binary one");
    }

    #[test]
    fn a_lock_the_file_system_refuses_starts_an_install_that_has_a_binary() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        fixture.lay_down_complete_install("old binary");
        fs::write(fixture.binary_path(), "bin").expect("expected a short binary");
        make_lock_unavailable(&fixture);

        let outcome = fixture.start();

        assert!(
            matches!(&outcome, Ok(InstallStart::KeptInstalled { reason }) if reason.contains("without its lock")),
            "expected the installed build to be kept | received {outcome:?}"
        );
        assert_eq!(fixture.server.requests(), Vec::<String>::new());
        assert_eq!(fixture.installed_binary_body(), "bin");
    }

    #[test]
    fn an_interrupted_swap_is_restored_from_its_rollback_tree_without_a_download() {
        let fixture = InstallFixture::new();
        // A launcher died after moving the install aside and before moving the
        // new one in: no version directory, a complete tree under a rollback name.
        fixture.lay_down_complete_install("previous binary");
        let rollback = fixture.root.0.join(format!(
            "{}other-owner",
            scratch_prefix("rollback", TEST_VERSION)
        ));
        fs::rename(fixture.install_dir(), &rollback).expect("expected to move the tree aside");

        let outcome = fixture.start();

        assert_eq!(outcome, Ok(InstallStart::Complete));
        assert_eq!(fixture.installed_binary_body(), "previous binary");
        assert!(!rollback.exists());
        assert_eq!(fixture.server.requests(), Vec::<String>::new());
    }

    #[test]
    fn scratch_left_by_other_launchers_is_swept_before_an_install() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        let staging = fixture.root.0.join(format!(
            "{}999999-1",
            scratch_prefix("staging", TEST_VERSION)
        ));
        let rollback = fixture.root.0.join(format!(
            "{}999999-2",
            scratch_prefix("rollback", TEST_VERSION)
        ));
        // Directories that are not this launcher's must survive the sweep:
        // the install scripts' and the hub's scratch names, and another version's.
        let foreign = [
            fixture.root.0.join(format!(".install-{TEST_VERSION}.4242")),
            fixture.root.0.join(format!(".staging-{TEST_VERSION}-4242")),
            fixture.root.0.join(".launcher-staging-9.9.9.other"),
        ];
        for directory in [&staging, &rollback].into_iter().chain(foreign.iter()) {
            fs::create_dir_all(directory).expect("expected a scratch directory");
            // An empty binary: a rollback tree with a real one would be restored.
            fs::write(directory.join(BINARY_NAME), "").expect("expected a file");
        }

        assert_eq!(fixture.start(), Ok(InstallStart::Installed));

        assert!(
            !staging.exists(),
            "expected the other launcher's staging dir to be swept"
        );
        assert!(
            !rollback.exists(),
            "expected the other launcher's rollback dir to be swept"
        );
        for directory in &foreign {
            assert!(
                directory.exists(),
                "expected {} to survive the sweep",
                directory.display()
            );
        }
        assert_eq!(fixture.installed_binary_body(), "binary one");
    }

    /// Puts the install in a state where moving its directory aside fails.
    /// On Windows that is what a running hub does, simulated with an exclusive
    /// handle on the binary: renaming a directory with an open file inside
    /// fails there, and Windows renames a directory over a plain file happily,
    /// so a file in the way would not block anything. Elsewhere a regular
    /// file at the move-aside path blocks it (a directory cannot replace a
    /// non-directory) with no dependence on the user id.
    struct ReplaceBlocker {
        #[cfg(windows)]
        _exclusive_handle: fs::File,
        #[cfg(not(windows))]
        file_in_the_way: PathBuf,
    }

    impl Drop for ReplaceBlocker {
        fn drop(&mut self) {
            #[cfg(not(windows))]
            let _ = fs::remove_file(&self.file_in_the_way);
        }
    }

    fn block_replace(fixture: &InstallFixture) -> ReplaceBlocker {
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            ReplaceBlocker {
                _exclusive_handle: fs::OpenOptions::new()
                    .read(true)
                    .share_mode(0)
                    .open(fixture.binary_path())
                    .expect("expected an exclusive handle on the installed binary"),
            }
        }
        #[cfg(not(windows))]
        {
            let file_in_the_way = fixture.release().rollback_path(&fixture.root.0);
            fs::write(&file_in_the_way, "in the way").expect("expected the blocking file");
            ReplaceBlocker { file_in_the_way }
        }
    }

    #[test]
    fn a_blocked_replace_keeps_the_installed_build_and_downloads_nothing() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        fixture.lay_down_complete_install("old binary");
        fs::write(fixture.binary_path(), "bin").expect("expected a short binary");
        let blocker = block_replace(&fixture);

        let outcome = fixture.start();
        // Release the block before reading the binary: an exclusive handle
        // would refuse that read on Windows.
        drop(blocker);

        assert!(
            matches!(&outcome, Ok(InstallStart::KeptInstalled { reason }) if reason.contains("cannot replace the install")),
            "expected the installed build to be kept with the move error | received {outcome:?}"
        );
        assert_eq!(
            fixture.server.requests(),
            Vec::<String>::new(),
            "expected the replace check to run before any download"
        );
        assert_eq!(fixture.installed_binary_body(), "bin");
    }

    #[test]
    fn a_blocked_replace_with_no_working_binary_is_an_error_not_a_start() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        fs::create_dir_all(fixture.install_dir()).expect("expected the install dir");
        fs::write(fixture.binary_path(), "").expect("expected an empty binary");
        let blocker = block_replace(&fixture);

        let outcome = fixture.start();
        drop(blocker);

        assert!(
            matches!(&outcome, Err(message) if message.contains("cannot replace the install")),
            "expected a replace failure | received {outcome:?}"
        );
    }

    #[test]
    fn a_failed_move_of_the_new_tree_restores_the_previous_install() {
        let fixture = InstallFixture::new();
        fixture.lay_down_complete_install("previous binary");
        let release = fixture.release();
        // The staged tree is missing, so moving it in fails after the previous
        // install has already been moved aside.
        let missing_staging = fixture.root.0.join("no-such-staging");

        let outcome = swap_into_place(
            &release,
            &fixture.root.0,
            &missing_staging,
            &fixture.install_dir(),
        );

        assert!(
            matches!(&outcome, Err(InstallError::PreviousKept(message)) if message.contains("cannot move the new install")),
            "expected PreviousKept carrying the move error | received {outcome:?}"
        );
        assert_eq!(fixture.installed_binary_body(), "previous binary");
        assert!(install_is_complete(&fixture.install_dir()));
        assert!(!release.rollback_path(&fixture.root.0).exists());
    }

    #[test]
    fn replacing_an_incomplete_install_swaps_in_the_new_tree_and_drops_the_old_one() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        fixture.lay_down_complete_install("old binary");
        fs::write(fixture.binary_path(), "bin").expect("expected a short binary");

        assert_eq!(fixture.start(), Ok(InstallStart::Installed));

        assert_eq!(fixture.installed_binary_body(), "binary one");
        assert_eq!(fixture.leftover_scratch(), Vec::<String>::new());
    }

    #[cfg(unix)]
    #[test]
    fn a_reinstall_leaves_a_running_hub_process_alive() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = InstallFixture::new();
        fixture.publish("#!/bin/sh\necho second build\n");
        // The "hub" is the installed binary itself, a script run from inside
        // the install directory. It blocks reading its stdin (a shell builtin,
        // so no child process outlives the test) and the shell keeps the
        // script file open meanwhile.
        fixture.lay_down_complete_install("#!/bin/sh\nread _\n");
        let mut running_hub = Command::new(fixture.binary_path())
            .stdin(std::process::Stdio::piped())
            .spawn()
            .expect("expected the installed binary to start");
        // Damage a sibling file so the record no longer matches and the
        // install is replaced while the hub runs.
        fs::write(
            fixture.install_dir().join("README.md"),
            "truncated by a crash",
        )
        .expect("expected the sibling to change");
        assert!(!install_is_complete(&fixture.install_dir()));

        let outcome = fixture.start();
        let still_running = running_hub
            .try_wait()
            .expect("expected to poll the running hub")
            .is_none();
        let _ = running_hub.kill();
        let _ = running_hub.wait();

        assert_eq!(outcome, Ok(InstallStart::Installed));
        assert!(
            still_running,
            "expected the hub started from the old tree to survive the reinstall | received an exit"
        );
        assert_eq!(
            fixture.installed_binary_body(),
            "#!/bin/sh\necho second build\n"
        );
        let mode = fs::metadata(fixture.binary_path())
            .expect("expected the new binary")
            .permissions()
            .mode();
        assert_eq!(
            mode & 0o111,
            0o111,
            "expected the new binary to be executable"
        );
    }
}
