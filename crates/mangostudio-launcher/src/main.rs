//! Thin launcher for MangoStudio, published to crates.io.
//!
//! The product is a Bun-compiled binary distributed via GitHub Releases with
//! the frontend embedded in the executable; this crate is not the app source.
//! On first run the launcher downloads the platform archive matching the crate
//! version into `~/.mango/dist/<version>/` (checksum-verified, the
//! same layout the shell installer uses), then hands over to the real binary
//! with arguments and environment untouched, except for two markers —
//! `MANGOSTUDIO_LAUNCHER` and `MANGOSTUDIO_LAUNCHER_PATH` — that announce this
//! shim to the binary it spawns, the way the npm wrapper announces itself too.
//!
//! A release never changes under its version, so a complete install starts
//! with no network request. Everything else here is about getting that install
//! on disk safely: one lock per version around every install, requests that
//! cannot hang, a verified tree built beside the install and moved in, and a
//! start that finishes or discards what a crash left behind.

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
/// The runtime the hub spawns from beside itself; an install whose record lists
/// a runtime of the wrong size cannot be started any more than a short hub.
const RUNTIME_BINARY_NAME: &str = if cfg!(windows) {
    "mangostudio-runtime.exe"
} else {
    "mangostudio-runtime"
};
const ARCHIVE_EXTENSION: &str = if cfg!(windows) { "zip" } else { "tar.gz" };
const DOWNLOAD_ATTEMPTS: u32 = 3;
const DOWNLOAD_RETRY_DELAY: Duration = Duration::from_secs(2);
/// Hard cap for downloads; the largest platform archive is well under this.
const MAX_DOWNLOAD_BYTES: u64 = 1024 * 1024 * 1024;
/// `SHA256SUMS` lists a few dozen assets; anything near this is not one.
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
/// Request deadlines are about silence, not duration: name resolution and
/// connecting get 30 s each, and any single read (response headers or a piece
/// of the body) gets 60 s. A total deadline would put a floor under the link
/// speed (about 60 MB in ten minutes is 100 KB/s) below which no install could
/// ever finish, while a stalled connection must still end.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// A start waits for as long as another launcher holds the install lock and
/// says so every `LOCK_NOTICE_EVERY`; it gives up only after this ceiling. That
/// is far above a healthy installer's usual time, but not a guarantee: with no
/// total download deadline, a 60 MB archive on a link under about 17 KB/s takes
/// longer. The waiter then reports that the other launcher is still installing
/// and falls back (starts an intact install, or fails and can simply be rerun).
const LOCK_CEILING: Duration = Duration::from_secs(3600);
const LOCK_NOTICE_EVERY: Duration = Duration::from_secs(30);
const LOCK_POLL: Duration = Duration::from_millis(100);
/// Written last into a freshly unpacked tree, inside the staging directory, so
/// it reaches the version directory with the same rename as the files it
/// describes. One `<bytes>\t<name>` line per top-level file, preceded by one
/// `platform\t<id>` line naming the archive the files came from.
const INSTALL_RECORD: &str = ".launcher-record";
/// Key of the record line that names the release platform of the tree. A size
/// line starts with digits, so the two never collide.
const RECORD_PLATFORM_KEY: &str = "platform";

fn main() {
    if let Err(message) = run() {
        eprintln!("mangostudio launcher: {message}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let install_root = install_root()?;
    let install_dir = install_root.join(VERSION);
    let binary_path = install_dir.join(BINARY_NAME);
    // Inspected here as well as inside `ensure_install` so a start that needs
    // nothing never builds a `Release`, which fails on an unsupported platform.
    // On such a platform no record can name this one, so none is compared.
    let platform = platform_id().ok();
    if inspect_install(&install_dir, platform) == InstallState::Complete {
        tidy_leftovers(VERSION, platform, &install_root, &install_dir);
    } else {
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
    /// (`.launcher-staging-<version>.<tag>`, `.launcher-trash-<version>.<tag>`).
    /// Unique per run: process ids alone repeat across containers that share
    /// one install root (each sees itself as pid 1).
    scratch_tag: String,
    retry_delay: Duration,
    connect_timeout: Duration,
    read_timeout: Duration,
    lock_ceiling: Duration,
    /// Production honors `HTTPS_PROXY` and friends like any other client; tests
    /// talking to a loopback fake must not be routed through the developer's
    /// proxy.
    honor_proxy_env: bool,
    /// How a trash tree is moved back to the version directory: `fs::rename` in
    /// production, a refusing fake in the test of a restore that fails.
    restore_rename: fn(&Path, &Path) -> io::Result<()>,
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
            connect_timeout: CONNECT_TIMEOUT,
            read_timeout: READ_TIMEOUT,
            lock_ceiling: LOCK_CEILING,
            honor_proxy_env: true,
            restore_rename: |from, to| fs::rename(from, to),
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
        lock_path(self.version, install_root)
    }

    fn staging_path(&self, install_root: &Path) -> PathBuf {
        install_root.join(format!(
            "{}{}",
            scratch_prefix("staging", self.version),
            self.scratch_tag
        ))
    }

    fn trash_path(&self, install_root: &Path) -> PathBuf {
        install_root.join(format!(
            "{}{}",
            scratch_prefix("trash", self.version),
            self.scratch_tag
        ))
    }
}

fn asset_name(version: &str, platform: &str) -> String {
    format!("mangostudio-{version}-{platform}.{ARCHIVE_EXTENSION}")
}

fn lock_path(version: &str, install_root: &Path) -> PathBuf {
    install_root.join(format!(".launcher-{version}.lock"))
}

/// Prefix of every scratch directory of one kind for one version. The
/// launcher keeps its own `.launcher-` family apart from the hub's
/// `.staging-*` and the install scripts' `.install-*`: those tools take no
/// launcher lock, so sweeping their names could delete a live install.
fn scratch_prefix(kind: &str, version: &str) -> String {
    format!(".launcher-{kind}-{version}.")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScratchKind {
    Staging,
    Trash,
}

impl ScratchKind {
    fn label(self) -> &'static str {
        match self {
            Self::Staging => "staging",
            Self::Trash => "trash",
        }
    }
}

/// True for the run tag `Release::for_this_build` makes: `<pid>-<nanos>`.
/// A version string can itself contain dots (`0.2.0-canary` and
/// `0.2.0-canary.abc1234`), so a name that merely starts with this version's
/// prefix may belong to another version, which has its own lock. Only a
/// remainder of exactly this shape belongs to the version asked for.
fn is_run_tag(text: &str) -> bool {
    text.split_once('-').is_some_and(|(pid, nanos)| {
        let digits =
            |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
        digits(pid) && digits(nanos)
    })
}

/// What `ensure_install` found or did.
#[derive(Debug, PartialEq, Eq)]
enum InstallStart {
    /// A complete install was already there; nothing was changed.
    Complete,
    /// A verified tree was put in place, from a download or from one a crashed
    /// launcher had finished unpacking.
    Installed,
    /// The install could not be repaired, but its binaries are intact (or
    /// nothing says otherwise). The caller starts it and says why.
    KeptInstalled { reason: String },
}

/// How much an install on disk can be trusted to run.
#[derive(Debug, PartialEq, Eq)]
enum InstallState {
    /// The binary is there and nothing contradicts the record, if there is one.
    Complete,
    /// Something besides the binaries is off (a sibling file is the wrong
    /// size, the record is unreadable), but nothing says the binaries are
    /// damaged. Start it if it cannot be repaired.
    Startable,
    /// No binary, an empty one, or a binary or runtime whose size is not the
    /// recorded one. Never started: repair it or fail.
    Unusable,
}

/// What the install record says about a tree.
enum RecordReading {
    /// No record: the install scripts or an older launcher laid the tree down.
    Missing,
    /// There is a record file but it does not parse, or does not list the hub
    /// binary. It is treated as no knowledge, not as a verdict.
    Unreadable,
    Entries(InstallRecord),
}

/// A parsed `.launcher-record`.
#[derive(Debug, PartialEq, Eq)]
struct InstallRecord {
    /// The release platform of the archive the tree was unpacked from. A record
    /// written before launchers recorded it has none, and says nothing about
    /// which platform the tree is for.
    platform: Option<String>,
    entries: Vec<(String, u64)>,
}

/// How a tree's recorded platform relates to the platform of this build.
#[derive(Debug, PartialEq, Eq)]
enum PlatformFit {
    /// The same platform, or no evidence either way: a record from before
    /// platforms were recorded, or a build with no release platform.
    Native,
    /// Another platform that this one runs through a translation layer. The
    /// tree starts, but a native tree is better, so a repair is attempted.
    Emulated,
    /// Another platform whose binaries cannot run here.
    Foreign,
}

/// Recorded platforms that a launcher of the second platform still runs, the
/// only mismatches that are not `PlatformFit::Foreign`. A pair belongs here
/// only when both binaries of the archive (the Bun-compiled hub and the
/// runtime) execute on the second platform as shipped.
///
/// - `darwin-x64` on `darwin-arm64`: Apple silicon runs x86-64 Mach-O binaries
///   through Rosetta 2. Without Rosetta the exec fails and the OS error names
///   the binary, the same as before platforms were recorded. The reverse does
///   not hold: an Intel Mac cannot run arm64 code.
///
/// The two Linux libc variants are deliberately absent. The musl archive's
/// runtime is static, but its hub is a Bun-compiled musl executable that needs
/// the musl loader and `libstdc++`, which a glibc host lacks; the glibc
/// archive's hub needs the glibc loader, which Alpine lacks.
const RUNS_THROUGH_TRANSLATION: &[(&str, &str)] = &[("darwin-x64", "darwin-arm64")];

impl InstallRecord {
    /// Whether the tree's recorded platform can run on `platform`, the
    /// platform of this build.
    fn platform_fit(&self, platform: Option<&str>) -> PlatformFit {
        match (self.platform.as_deref(), platform) {
            (Some(recorded), Some(this_build)) if recorded != this_build => {
                if RUNS_THROUGH_TRANSLATION.contains(&(recorded, this_build)) {
                    PlatformFit::Emulated
                } else {
                    PlatformFit::Foreign
                }
            }
            _ => PlatformFit::Native,
        }
    }
}

fn read_record(directory: &Path) -> RecordReading {
    match fs::read_to_string(directory.join(INSTALL_RECORD)) {
        Ok(text) => parse_record(&text).map_or(RecordReading::Unreadable, RecordReading::Entries),
        Err(error) if error.kind() == io::ErrorKind::NotFound => RecordReading::Missing,
        Err(_) => RecordReading::Unreadable,
    }
}

fn parse_record(text: &str) -> Option<InstallRecord> {
    let mut platform = None;
    let mut entries = Vec::new();
    for line in text.lines() {
        let (bytes, name) = line.split_once('\t')?;
        if bytes == RECORD_PLATFORM_KEY {
            if name.is_empty() || platform.replace(name.to_string()).is_some() {
                return None;
            }
            continue;
        }
        if Path::new(name).file_name() != Some(OsStr::new(name)) {
            return None;
        }
        entries.push((name.to_string(), bytes.parse().ok()?));
    }
    entries
        .iter()
        .any(|(name, _)| name == BINARY_NAME)
        .then_some(InstallRecord { platform, entries })
}

fn file_size(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
}

/// Compare every recorded file with the tree. Returns whether all match and
/// whether the binaries (hub and, when listed, runtime) match.
fn compare_record(directory: &Path, entries: &[(String, u64)]) -> (bool, bool) {
    let mut all_match = true;
    let mut binaries_match = true;
    for (name, bytes) in entries {
        let matches = file_size(&directory.join(name)) == Some(*bytes);
        all_match &= matches;
        if name == BINARY_NAME || name == RUNTIME_BINARY_NAME {
            binaries_match &= matches;
        }
    }
    (all_match, binaries_match)
}

/// Judge an install by one rule everywhere: the decision to start it rests on
/// the record's line for the binaries themselves.
///
/// The record catches truncated or missing files: after a power loss a tree can
/// be there with a short binary. It does not authenticate anything, and has
/// the same trust as the binary it describes (whoever can rewrite one can
/// rewrite the other). A tree with no record was laid down by the install
/// scripts or an older launcher; nothing is known about it beyond the binary,
/// so a non-empty binary counts and a good install is never downloaded again.
///
/// `platform` is this build's release platform. A record that names another
/// one means the binaries are for a platform that shares this install root:
/// the tree is unusable here however intact it is, unless the pair is one that
/// runs through translation (`RUNS_THROUGH_TRANSLATION`). Such a tree is
/// startable at best, never complete, so the launcher still tries to replace it
/// with a native one and starts it only if that fails.
fn inspect_install(install_dir: &Path, platform: Option<&str>) -> InstallState {
    if file_size(&install_dir.join(BINARY_NAME)).is_none_or(|bytes| bytes == 0) {
        return InstallState::Unusable;
    }
    match read_record(install_dir) {
        RecordReading::Missing => InstallState::Complete,
        RecordReading::Unreadable => InstallState::Startable,
        RecordReading::Entries(record) => {
            match (
                record.platform_fit(platform),
                compare_record(install_dir, &record.entries),
            ) {
                (_, (_, false)) | (PlatformFit::Foreign, _) => InstallState::Unusable,
                (PlatformFit::Emulated, _) | (PlatformFit::Native, (false, true)) => {
                    InstallState::Startable
                }
                (PlatformFit::Native, (true, true)) => InstallState::Complete,
            }
        }
    }
}

/// True for a tree that has a record for `platform` and matches it entirely:
/// what a launcher leaves in staging once the unpack, the record and the flush
/// are done. A staged tree of a translated platform is not adopted: finishing
/// an install means a native tree, and the download makes one.
fn staging_is_verified(staging: &Path, platform: Option<&str>) -> bool {
    match read_record(staging) {
        RecordReading::Entries(record) => {
            record.platform_fit(platform) == PlatformFit::Native
                && compare_record(staging, &record.entries).0
        }
        RecordReading::Missing | RecordReading::Unreadable => false,
    }
}

/// Make sure `install_dir` holds a complete install, downloading one only when
/// it does not. Judging an install costs a `stat` of the binary, a read of the
/// record and a `stat` per recorded file (a handful); a launcher run adds one
/// `read_dir` of the install root to look for leftovers. No network, no lock.
///
/// If the install cannot be repaired (offline, lock trouble, an install in use,
/// a bad download) but its binaries are intact, it is started anyway: that is
/// what a launcher without any of this would have done. An install whose
/// binary is short or missing is never started.
fn ensure_install(release: &Release<'_>, install_dir: &Path) -> Result<InstallStart, String> {
    let platform = Some(release.platform);
    if inspect_install(install_dir, platform) == InstallState::Complete {
        return Ok(InstallStart::Complete);
    }
    repair_install(release, install_dir).or_else(|failure| {
        if inspect_install(install_dir, platform) == InstallState::Unusable {
            Err(failure)
        } else {
            Ok(InstallStart::KeptInstalled { reason: failure })
        }
    })
}

fn repair_install(release: &Release<'_>, install_dir: &Path) -> Result<InstallStart, String> {
    let install_root = install_root_of(install_dir)?;
    fs::create_dir_all(install_root)
        .map_err(|error| format!("cannot create {}: {error}", install_root.display()))?;

    // Every launcher that creates, moves or removes this version's scratch
    // directories holds this lock, so under it nothing there belongs to a live
    // launcher: the sweeps below are safe because of it, and for no other
    // reason. An install is never run without it.
    let _lock = acquire_install_lock(release, install_root)?;
    let platform = Some(release.platform);

    // Another launcher may have finished while this one waited.
    if inspect_install(install_dir, platform) == InstallState::Complete {
        sweep_scratch_dirs(release.version, platform, install_root, install_dir);
        return Ok(InstallStart::Complete);
    }

    // No version directory but a trash tree that can still run: a launcher
    // died (or a rename back failed) after moving the only good copy aside.
    // Put it back before anything is swept. If the move is refused the tree
    // stays in trash (`sweep_scratch_dirs` keeps it) and the refusal is said
    // now and again with any later failure: the start goes on to a download,
    // and if that fails nothing is started, since the intact copy is not at
    // the path the binary runs from.
    let mut restore_failure = None;
    if !install_dir.exists() {
        if let Err(failure) = restore_from_trash(release, install_root, install_dir) {
            eprintln!("mangostudio launcher: warning: {failure}");
            restore_failure = Some(failure);
        }
        if inspect_install(install_dir, platform) == InstallState::Complete {
            sweep_scratch_dirs(release.version, platform, install_root, install_dir);
            return Ok(InstallStart::Complete);
        }
    }
    let note_restore_failure = |failure: String| match &restore_failure {
        Some(restore) => format!("{failure}; nothing was started, and {restore}"),
        None => failure,
    };

    // A launcher that died after unpacking and verifying, before moving the
    // tree in, left a staging tree with its record: finish that install
    // instead of downloading again, which also works offline.
    if let Some(staged) = verified_staging_tree(release.version, platform, install_root) {
        replace_install(release, install_root, &staged, install_dir)
            .map_err(&note_restore_failure)?;
        eprintln!(
            "Completed an interrupted install of MangoStudio {}.",
            release.version
        );
        sweep_scratch_dirs(release.version, platform, install_root, install_dir);
        return Ok(InstallStart::Installed);
    }
    sweep_scratch_dirs(release.version, platform, install_root, install_dir);

    // Find out cheaply, before downloading ~60 MB, whether the existing tree
    // can be replaced at all, without moving it.
    if install_dir.exists() {
        check_replaceable(install_dir).map_err(&note_restore_failure)?;
    }

    eprintln!(
        "Downloading MangoStudio {} for {}...",
        release.version, release.platform
    );
    let manifest = download_manifest(release).map_err(&note_restore_failure)?;
    install_archive(release, install_root, install_dir, &manifest)
        .map_err(&note_restore_failure)?;
    // The new install is complete here, so the old tree in trash goes now.
    sweep_scratch_dirs(release.version, platform, install_root, install_dir);
    Ok(InstallStart::Installed)
}

fn install_root_of(install_dir: &Path) -> Result<&Path, String> {
    install_dir
        .parent()
        .ok_or_else(|| format!("install dir {} has no parent", install_dir.display()))
}

/// Take the exclusive advisory lock on `.launcher-<version>.lock` beside the
/// version directories. It lives outside the version directory because the
/// swap moves that directory.
fn acquire_install_lock(release: &Release<'_>, install_root: &Path) -> Result<fs::File, String> {
    let path = release.lock_path(install_root);
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|error| lock_failure(&path, "open", &error))?;
    wait_for_lock(release, &path, || file.try_lock())?;
    Ok(file)
}

fn lock_failure(path: &Path, action: &str, error: &io::Error) -> String {
    format!(
        "cannot {action} {}: {error}; installs hold an exclusive lock there, so check that the directory is writable and on a file system that supports file locking",
        path.display()
    )
}

/// Poll `attempt` until it takes the lock. The wait is not a fixed budget: a
/// holder that is making progress is waited for, with a line every
/// `LOCK_NOTICE_EVERY`, and only `release.lock_ceiling` ends it. An error
/// other than "held" (`ENOLCK` on some network mounts, `Unsupported`) ends it
/// at once.
fn wait_for_lock(
    release: &Release<'_>,
    path: &Path,
    mut attempt: impl FnMut() -> Result<(), fs::TryLockError>,
) -> Result<(), String> {
    let started = Instant::now();
    let mut next_notice = Duration::ZERO;
    loop {
        match attempt() {
            Ok(()) => return Ok(()),
            Err(fs::TryLockError::WouldBlock) => {}
            Err(fs::TryLockError::Error(error)) => {
                return Err(lock_failure(path, "lock", &error));
            }
        }
        let waited = started.elapsed();
        if waited >= release.lock_ceiling {
            return Err(format!(
                "another launcher is still installing {} after {}s (lock {}); not waiting longer. An installed build with intact binaries is started, otherwise run the command again once that install finishes",
                release.version,
                waited.as_secs(),
                path.display()
            ));
        }
        if waited >= next_notice {
            eprintln!(
                "Waiting for another mangostudio launcher to finish installing {} ({}s so far)...",
                release.version,
                waited.as_secs()
            );
            next_notice = waited + LOCK_NOTICE_EVERY;
        }
        thread::sleep(LOCK_POLL);
    }
}

/// This version's staging and trash directories in `install_root`, in name
/// order, from one `read_dir` pass. Names must be exactly
/// `.launcher-<kind>-<version>.<run tag>` (see `is_run_tag`).
fn scratch_dirs(version: &str, install_root: &Path) -> Vec<(ScratchKind, PathBuf)> {
    let Ok(entries) = fs::read_dir(install_root) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        for kind in [ScratchKind::Staging, ScratchKind::Trash] {
            let owned = name
                .strip_prefix(&scratch_prefix(kind.label(), version))
                .is_some_and(is_run_tag);
            if owned && entry.file_type().is_ok_and(|file_type| file_type.is_dir()) {
                found.push((kind, entry.path()));
            }
        }
    }
    found.sort_by(|left, right| left.1.cmp(&right.1));
    found
}

/// A staging tree a dead launcher finished: unpacked, recorded and flushed.
fn verified_staging_tree(
    version: &str,
    platform: Option<&str>,
    install_root: &Path,
) -> Option<PathBuf> {
    scratch_dirs(version, install_root)
        .into_iter()
        .filter(|(kind, _)| *kind == ScratchKind::Staging)
        .map(|(_, path)| path)
        .find(|staging| staging_is_verified(staging, platform))
}

/// Move the first trash tree that can still run back to `install_dir`. Only
/// called when `install_dir` is missing. The move is
/// `release.restore_rename`; a refused move (an antivirus scanner or the indexer holding a
/// handle on Windows, a permission error, a directory created at the path
/// meanwhile) is returned as a message naming both paths, and the trash tree
/// stays where it is.
fn restore_from_trash(
    release: &Release<'_>,
    install_root: &Path,
    install_dir: &Path,
) -> Result<(), String> {
    let usable = scratch_dirs(release.version, install_root)
        .into_iter()
        .filter(|(kind, _)| *kind == ScratchKind::Trash)
        .map(|(_, path)| path)
        .find(|trash| inspect_install(trash, Some(release.platform)) != InstallState::Unusable);
    let Some(trash) = usable else {
        return Ok(());
    };
    (release.restore_rename)(&trash, install_dir).map_err(|error| {
        format!(
            "cannot move {} back to {}: {error}; it holds the intact MangoStudio {} install that an interrupted update set aside and stays there",
            trash.display(),
            install_dir.display(),
            release.version
        )
    })?;
    eprintln!(
        "Restored the MangoStudio {} install that an interrupted update had set aside.",
        release.version
    );
    Ok(())
}

/// Remove this version's staging and trash directories. Call only under the
/// install lock.
///
/// Invariant: this never deletes the only startable copy. While `install_dir`
/// is missing or not complete, a trash tree that `inspect_install` does not
/// call unusable is kept, whatever the caller did or failed to do before. It
/// is swept once `install_dir` is complete.
fn sweep_scratch_dirs(
    version: &str,
    platform: Option<&str>,
    install_root: &Path,
    install_dir: &Path,
) {
    let install_is_complete = inspect_install(install_dir, platform) == InstallState::Complete;
    for (kind, leftover) in scratch_dirs(version, install_root) {
        let may_be_only_copy = kind == ScratchKind::Trash
            && !install_is_complete
            && inspect_install(&leftover, platform) != InstallState::Unusable;
        if !may_be_only_copy {
            let _ = fs::remove_dir_all(leftover);
        }
    }
}

/// On a start that needs no install, remove what a launcher that crashed after
/// the swap left behind (the old tree in a trash directory). A complete start
/// takes no lock, so the sweep happens only if the lock is free right now
/// (`try_lock`, never waiting): a held lock means a launcher is installing and
/// its scratch directories are not leftovers. If the file can't be opened or
/// locked, the sweep is skipped; the next install sweeps.
fn tidy_leftovers(version: &str, platform: Option<&str>, install_root: &Path, install_dir: &Path) {
    if scratch_dirs(version, install_root).is_empty() {
        return;
    }
    let Ok(lock) = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(lock_path(version, install_root))
    else {
        return;
    };
    if lock.try_lock().is_ok() {
        sweep_scratch_dirs(version, platform, install_root, install_dir);
    }
}

/// Tell before downloading ~60 MB whether the real swap's first move (the
/// install directory to trash) would fail, without moving anything: moving a
/// working install away just to ask would put the only good copy at risk on
/// every repair attempt.
///
/// On Windows a running hub holds its files open without delete sharing, and a
/// directory with such a file inside cannot be renamed; opening each binary
/// with no sharing at all fails the same way. The check is partial: it opens
/// only the two binaries, while a directory rename is also blocked by any
/// other open handle in the tree and by a process whose working directory is
/// inside it. Then the check passes, the archive downloads and the swap fails.
/// Nothing is lost that way: the verified staging tree is kept and the next
/// start adopts it. On Unix a rename is not blocked by a running executable,
/// so there is nothing to ask and the swap itself reports any refusal.
#[cfg(windows)]
fn check_replaceable(install_dir: &Path) -> Result<(), String> {
    use std::os::windows::fs::OpenOptionsExt;
    for name in [BINARY_NAME, RUNTIME_BINARY_NAME] {
        match fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(install_dir.join(name))
        {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "cannot replace the install at {}: {name} is in use: {error}",
                    install_dir.display()
                ));
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn check_replaceable(_install_dir: &Path) -> Result<(), String> {
    Ok(())
}

fn download_manifest(release: &Release<'_>) -> Result<String, String> {
    let bytes = download(release, &release.manifest_url(), MAX_MANIFEST_BYTES)?;
    String::from_utf8(bytes).map_err(|_| "SHA256SUMS is not valid UTF-8".to_string())
}

/// Download the archive named by `manifest`, check it against the manifest's
/// digest, unpack it into a staging directory, record and flush it, and move
/// it into `install_dir`.
fn install_archive(
    release: &Release<'_>,
    install_root: &Path,
    install_dir: &Path,
    manifest: &str,
) -> Result<(), String> {
    let asset = release.asset();
    let expected = expected_checksum(manifest, &asset)?;
    let archive = download(release, &release.archive_url(), MAX_DOWNLOAD_BYTES)?;

    let actual = sha256_hex(&archive);
    if expected != actual {
        return Err(format!(
            "checksum mismatch for {asset}: expected {expected}, got {actual}"
        ));
    }
    eprintln!("Checksum verified: {asset}");

    // Unpack into a staging dir and rename into place so a crash mid-unpack
    // never leaves a half-written version directory that later runs trust. The
    // guard removes the staging dir on every exit but a verified tree that
    // failed to move in, which the next start adopts.
    let mut staging = ScratchDir::new(release.staging_path(install_root));
    unpack(&archive, staging.path())?;

    let staged_binary = staging.path().join(BINARY_NAME);
    if !staged_binary.is_file() {
        return Err(format!("archive is missing {BINARY_NAME}"));
    }
    make_executable(&staged_binary)?;
    // The order matters to adoption: files first, then the record, so a record
    // that reached the disk never sits beside files whose blocks did not.
    persist_tree(staging.path())
        .map_err(|error| format!("cannot flush the unpacked files: {error}"))?;
    write_record(staging.path(), release.platform)
        .map_err(|error| format!("cannot record the unpacked files: {error}"))?;

    if let Err(failure) = replace_install(release, install_root, staging.path(), install_dir) {
        staging.keep();
        return Err(failure);
    }
    eprintln!(
        "Installed MangoStudio {} to {}",
        release.version,
        install_dir.display()
    );
    Ok(())
}

/// A directory removed when dropped unless kept. After a successful rename the
/// path no longer exists and the removal is a no-op.
struct ScratchDir {
    path: PathBuf,
    keep: bool,
}

impl ScratchDir {
    fn new(path: PathBuf) -> Self {
        let _ = fs::remove_dir_all(&path);
        Self { path, keep: false }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn keep(&mut self) {
        self.keep = true;
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

/// The whole record: the platform line, then the file lines.
fn record_text(directory: &Path, platform: &str) -> io::Result<String> {
    Ok(format!(
        "{RECORD_PLATFORM_KEY}\t{platform}\n{}",
        completion_record(directory)?
    ))
}

/// The `<bytes>\t<name>` lines for the top-level files of a freshly unpacked
/// tree, in name order. The release archives have a flat root; a file in a
/// subdirectory is neither recorded nor flushed.
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
        if name == INSTALL_RECORD {
            continue;
        }
        files.push((name, entry.metadata()?.len()));
    }
    files.sort();
    Ok(files
        .iter()
        .map(|(name, bytes)| format!("{bytes}\t{name}\n"))
        .collect())
}

/// Flush every top-level file of the unpacked tree, before the record exists:
/// sizes alone would not catch a right-sized file whose blocks were never
/// written (delayed allocation on XFS or ext4 `data=writeback`), so the record
/// may only be written once the bytes it describes are on disk.
fn persist_tree(directory: &Path) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            sync_file(&entry.path())?;
        }
    }
    Ok(())
}

/// Write the record of the (already flushed) tree, flush it, then flush the
/// directory that names the files. Only after this is the tree adoptable, and
/// only then is it renamed into place. On Unix the install root is flushed
/// after that rename too (`replace_install`). Windows flushes the files
/// (`FlushFileBuffers`) but std has no way to flush a directory entry there,
/// so after a power loss the rename itself may be lost; the install is then
/// simply missing and the next start repairs it.
fn write_record(directory: &Path, platform: &str) -> io::Result<()> {
    let record_path = directory.join(INSTALL_RECORD);
    fs::write(&record_path, record_text(directory, platform)?)?;
    sync_file(&record_path)?;
    sync_directory(directory);
    Ok(())
}

fn sync_file(path: &Path) -> io::Result<()> {
    // FlushFileBuffers needs write access; fsync is happy with read access.
    let mut options = fs::OpenOptions::new();
    if cfg!(windows) {
        options.write(true);
    } else {
        options.read(true);
    }
    options.open(path)?.sync_all()
}

/// Best effort: some file systems refuse to flush a directory, and a failure
/// here only narrows the durability window, it does not corrupt anything.
#[cfg(unix)]
fn sync_directory(directory: &Path) {
    if let Ok(handle) = fs::File::open(directory) {
        let _ = handle.sync_all();
    }
}

#[cfg(windows)]
fn sync_directory(_directory: &Path) {}

/// Put the verified `staging` tree at `install_dir`. The tree being replaced,
/// if any, is one this launcher judged unfit to leave in place, so it is moved
/// to a trash directory and deleted after the new one is in, rather than
/// deleted first: on Windows the move fails cleanly while a hub holds its
/// files, where a recursive delete would half-empty the directory the hub runs
/// from, and a crash between the two renames leaves a verified staging tree
/// for the next start to adopt.
fn replace_install(
    release: &Release<'_>,
    install_root: &Path,
    staging: &Path,
    install_dir: &Path,
) -> Result<(), String> {
    let trash = release.trash_path(install_root);
    let had_previous = install_dir.exists();
    if had_previous {
        fs::rename(install_dir, &trash).map_err(|error| {
            format!(
                "cannot replace the install at {}: {error}",
                install_dir.display()
            )
        })?;
    }
    if let Err(error) = fs::rename(staging, install_dir) {
        if had_previous {
            // Best effort: put back what was there so a start that can still
            // run it does.
            let _ = fs::rename(&trash, install_dir);
        }
        return Err(format!(
            "cannot move the new install into {}: {error}; the verified files stay in {} for the next start",
            install_dir.display(),
            staging.display()
        ));
    }
    sync_directory(install_root);
    if had_previous {
        let _ = fs::remove_dir_all(&trash);
    }
    Ok(())
}

fn http_agent(release: &Release<'_>) -> ureq::Agent {
    let builder = ureq::Agent::config_builder()
        .timeout_resolve(Some(release.connect_timeout))
        .timeout_connect(Some(release.connect_timeout))
        .timeout_per_read(Some(release.read_timeout));
    let builder = if release.honor_proxy_env {
        builder
    } else {
        builder.proxy(None)
    };
    builder.build().into()
}

fn download(release: &Release<'_>, url: &str, max_bytes: u64) -> Result<Vec<u8>, String> {
    let agent = http_agent(release);
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
    use crate::release_archive::{archive_with_binary, archive_without_binary, manifest_listing};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const TEST_VERSION: &str = "0.0.0";
    const TEST_PLATFORM: &str = "test-platform";
    const TEST_TAG: &str = "1-1";

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
            self.release_for_platform(TEST_PLATFORM, base_url)
        }

        fn release_for_platform(
            &self,
            platform: &'static str,
            base_url: String,
        ) -> Release<'static> {
            Release {
                version: self.version,
                platform,
                base_url,
                scratch_tag: TEST_TAG.to_string(),
                retry_delay: Duration::ZERO,
                connect_timeout: Duration::from_secs(5),
                read_timeout: Duration::from_secs(5),
                lock_ceiling: Duration::from_secs(5),
                honor_proxy_env: false,
                restore_rename: |from, to| fs::rename(from, to),
            }
        }

        fn release(&self) -> Release<'static> {
            self.release_at(self.server.base_url())
        }

        fn asset(&self) -> String {
            asset_name(self.version, TEST_PLATFORM)
        }

        fn publish(&self, binary_body: &str) {
            self.publish_for_platform(TEST_PLATFORM, binary_body);
        }

        /// Publish the archive of `platform`, as a release does for each of its
        /// platforms. `SHA256SUMS` lists the latest publication only, which is
        /// all a test that installs one platform at a time needs.
        fn publish_for_platform(&self, platform: &str, binary_body: &str) {
            let asset = asset_name(self.version, platform);
            let archive = archive_with_binary(binary_body);
            self.server.serve(
                "/SHA256SUMS",
                manifest_listing(&asset, &archive).into_bytes(),
            );
            self.server.serve(&format!("/{asset}"), archive);
        }

        /// Install `binary_body` as a launcher of `platform` would.
        fn install_as_platform(&self, platform: &'static str, binary_body: &str) {
            self.publish_for_platform(platform, binary_body);
            let outcome = ensure_install(
                &self.release_for_platform(platform, self.server.base_url()),
                &self.install_dir(),
            );
            assert_eq!(
                outcome,
                Ok(InstallStart::Installed),
                "expected a {platform} install to land"
            );
            self.server.forget_requests();
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

        fn no_requests(&self) -> bool {
            self.server.requests().is_empty()
        }

        /// This version's scratch directories (and any other `.launcher-*`
        /// entry but the lock file) left in the install root.
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

        /// A tree that `inspect_install` calls complete: the binary, a sibling
        /// file and a record of both. `directory` is the install directory or
        /// a staging directory.
        fn lay_down_tree(&self, directory: &Path, binary_body: &str) {
            self.lay_down_tree_for_platform(directory, TEST_PLATFORM, binary_body);
        }

        /// `lay_down_tree` as a launcher of `platform` would have recorded it.
        fn lay_down_tree_for_platform(&self, directory: &Path, platform: &str, binary_body: &str) {
            fs::create_dir_all(directory).expect("expected the tree directory");
            fs::write(directory.join(BINARY_NAME), binary_body).expect("expected the binary");
            fs::write(directory.join("README.md"), "readme").expect("expected the readme");
            #[cfg(unix)]
            make_executable(&directory.join(BINARY_NAME)).expect("expected an executable");
            let record = record_text(directory, platform).expect("expected a record");
            fs::write(directory.join(INSTALL_RECORD), record).expect("expected the record file");
        }

        fn lay_down_complete_install(&self, binary_body: &str) {
            self.lay_down_tree(&self.install_dir(), binary_body);
        }

        /// Make the installed binary shorter than its record says.
        fn shorten_binary(&self) {
            fs::write(self.binary_path(), "bin").expect("expected a short binary");
        }

        /// Make a sibling file the wrong size, binaries untouched.
        fn damage_sibling(&self) {
            fs::write(self.install_dir().join("README.md"), "damaged by a crash")
                .expect("expected the sibling to change");
        }

        fn staging_dir(&self, owner: &str) -> PathBuf {
            self.root.0.join(format!(
                "{}{owner}",
                scratch_prefix("staging", self.version)
            ))
        }

        fn trash_dir(&self, owner: &str) -> PathBuf {
            self.root
                .0
                .join(format!("{}{owner}", scratch_prefix("trash", self.version)))
        }

        /// Hold the version's install lock from the test, as another launcher would.
        fn hold_lock(&self) -> fs::File {
            let file = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(self.release().lock_path(&self.root.0))
                .expect("expected the lock file");
            file.lock().expect("expected to hold the lock");
            file
        }
    }

    // --- what an install on disk is worth ---

    #[test]
    fn inspect_install_tells_complete_startable_and_unusable_trees_apart() {
        let fixture = InstallFixture::new();
        let install = fixture.install_dir();

        // Nothing there.
        assert_eq!(
            inspect_install(&install, Some(TEST_PLATFORM)),
            InstallState::Unusable
        );

        // Laid down by the install scripts: no record, non-empty binary.
        fs::create_dir_all(&install).expect("expected the install dir");
        fs::write(fixture.binary_path(), "script-installed").expect("expected a binary");
        assert_eq!(
            inspect_install(&install, Some(TEST_PLATFORM)),
            InstallState::Complete
        );
        fs::write(fixture.binary_path(), "").expect("expected an empty binary");
        assert_eq!(
            inspect_install(&install, Some(TEST_PLATFORM)),
            InstallState::Unusable
        );
        fs::remove_dir_all(&install).expect("expected a clean slate");

        // Recorded and intact.
        fixture.lay_down_complete_install("binary one");
        assert_eq!(
            inspect_install(&install, Some(TEST_PLATFORM)),
            InstallState::Complete
        );

        // A sibling is off: the binaries are fine, so it can still start.
        fixture.damage_sibling();
        assert_eq!(
            inspect_install(&install, Some(TEST_PLATFORM)),
            InstallState::Startable
        );

        // The hub binary is shorter than recorded: never startable.
        fixture.lay_down_complete_install("binary one");
        fixture.shorten_binary();
        assert_eq!(
            inspect_install(&install, Some(TEST_PLATFORM)),
            InstallState::Unusable
        );

        // The runtime is listed and shorter than recorded: never startable.
        fixture.lay_down_complete_install("binary one");
        let runtime = install.join(RUNTIME_BINARY_NAME);
        fs::write(&runtime, "a runtime binary").expect("expected a runtime");
        let record = record_text(&install, TEST_PLATFORM).expect("expected a record");
        fs::write(install.join(INSTALL_RECORD), record).expect("expected the record");
        assert_eq!(
            inspect_install(&install, Some(TEST_PLATFORM)),
            InstallState::Complete
        );
        fs::write(&runtime, "rt").expect("expected a short runtime");
        assert_eq!(
            inspect_install(&install, Some(TEST_PLATFORM)),
            InstallState::Unusable
        );
    }

    #[test]
    fn inspect_install_treats_an_unreadable_record_as_no_knowledge() {
        let fixture = InstallFixture::new();
        fixture.lay_down_complete_install("binary one");
        for record in [
            "",
            "not a record\n",
            "10\n",
            "x\tmangostudio\n",
            "10\tother-file\n",
            "10\t../mangostudio\n",
        ] {
            fs::write(fixture.install_dir().join(INSTALL_RECORD), record)
                .expect("expected the record to be overwritten");

            assert_eq!(
                inspect_install(&fixture.install_dir(), Some(TEST_PLATFORM)),
                InstallState::Startable,
                "expected record {record:?} to leave a non-empty binary startable but not complete"
            );
        }
    }

    // --- a first install and a complete start ---

    #[test]
    fn install_without_an_existing_tree_downloads_records_and_leaves_no_scratch() {
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
        assert_eq!(
            inspect_install(&fixture.install_dir(), Some(TEST_PLATFORM)),
            InstallState::Complete
        );
        assert_eq!(fixture.leftover_scratch(), Vec::<String>::new());
    }

    #[test]
    fn a_complete_install_starts_with_no_request_even_for_a_canary_version() {
        for version in [TEST_VERSION, "0.0.0-canary.abc1234"] {
            let fixture = InstallFixture::with_version(version);
            fixture.publish("binary one");
            assert_eq!(fixture.start(), Ok(InstallStart::Installed));
            fixture.server.forget_requests();

            assert_eq!(fixture.start(), Ok(InstallStart::Complete), "{version}");
            assert_eq!(fixture.server.requests(), Vec::<String>::new(), "{version}");
        }
    }

    #[test]
    fn an_install_without_a_record_still_starts_and_is_not_downloaded_again() {
        let fixture = InstallFixture::new();
        // What the install scripts and older launchers leave: files, no record.
        fs::create_dir_all(fixture.install_dir()).expect("expected the install dir");
        fs::write(fixture.binary_path(), "script-installed binary").expect("expected a binary");

        assert_eq!(fixture.start(), Ok(InstallStart::Complete));
        assert!(fixture.no_requests());
        assert_eq!(fixture.record(), None);
    }

    #[test]
    fn a_binary_shorter_than_its_record_is_downloaded_again() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        assert_eq!(fixture.start(), Ok(InstallStart::Installed));
        // What a power loss can leave: the tree and its record, a short binary.
        fixture.shorten_binary();

        assert_eq!(fixture.start(), Ok(InstallStart::Installed));
        assert_eq!(fixture.installed_binary_body(), "binary one");
        assert_eq!(
            inspect_install(&fixture.install_dir(), Some(TEST_PLATFORM)),
            InstallState::Complete
        );
    }

    // --- a root shared between platforms ---

    const OTHER_PLATFORM: &str = "other-platform";

    #[test]
    fn a_tree_installed_for_another_platform_is_replaced_instead_of_started() {
        let fixture = InstallFixture::new();
        fixture.install_as_platform(OTHER_PLATFORM, "other platform binary");
        fixture.publish("this platform binary");

        let outcome = fixture.start();

        assert_eq!(
            outcome,
            Ok(InstallStart::Installed),
            "expected the {OTHER_PLATFORM} tree in {} to be replaced, not started",
            fixture.install_dir().display()
        );
        assert_eq!(fixture.installed_binary_body(), "this platform binary");
        assert_eq!(fixture.archive_requests(), 1);
        assert_eq!(fixture.leftover_scratch(), Vec::<String>::new());
    }

    #[test]
    fn a_tree_installed_for_another_platform_is_never_started_when_the_repair_fails() {
        let offline = ClosedConnectionServer::start();
        let fixture = InstallFixture::new();
        fixture.install_as_platform(OTHER_PLATFORM, "other platform binary");

        let outcome = ensure_install(
            &fixture.release_at(offline.base_url()),
            &fixture.install_dir(),
        );

        assert!(
            matches!(&outcome, Err(message) if message.contains("cannot download")),
            "expected the download failure, not a start of the {OTHER_PLATFORM} binary | received {outcome:?}"
        );
    }

    // A pair from `RUNS_THROUGH_TRANSLATION`: an Apple silicon launcher over a
    // tree an Intel launcher installed in a shared home.
    const TRANSLATED_FROM: &str = "darwin-x64";
    const TRANSLATED_ON: &str = "darwin-arm64";

    #[test]
    fn a_translated_platform_tree_is_started_when_the_repair_cannot_download() {
        let offline = ClosedConnectionServer::start();
        let fixture = InstallFixture::new();
        fixture.install_as_platform(TRANSLATED_FROM, "x64 binary");

        let outcome = ensure_install(
            &fixture.release_for_platform(TRANSLATED_ON, offline.base_url()),
            &fixture.install_dir(),
        );

        assert!(
            matches!(&outcome, Ok(InstallStart::KeptInstalled { reason }) if reason.contains("cannot download")),
            "expected the {TRANSLATED_FROM} tree to be kept after the failed repair on {TRANSLATED_ON} | received {outcome:?}"
        );
        assert_eq!(fixture.installed_binary_body(), "x64 binary");
    }

    #[test]
    fn a_translated_platform_tree_is_replaced_by_a_native_one_when_online() {
        let fixture = InstallFixture::new();
        fixture.install_as_platform(TRANSLATED_FROM, "x64 binary");
        fixture.publish_for_platform(TRANSLATED_ON, "arm64 binary");

        let outcome = ensure_install(
            &fixture.release_for_platform(TRANSLATED_ON, fixture.server.base_url()),
            &fixture.install_dir(),
        );

        assert_eq!(
            outcome,
            Ok(InstallStart::Installed),
            "expected the {TRANSLATED_FROM} tree to be replaced on {TRANSLATED_ON}"
        );
        assert_eq!(fixture.installed_binary_body(), "arm64 binary");
        assert_eq!(
            fixture
                .server
                .request_count(&format!("/{}", asset_name(fixture.version, TRANSLATED_ON))),
            1,
            "expected one download of the {TRANSLATED_ON} archive"
        );

        // Now native: the next start needs no request.
        fixture.server.forget_requests();
        let restart = ensure_install(
            &fixture.release_for_platform(TRANSLATED_ON, fixture.server.base_url()),
            &fixture.install_dir(),
        );
        assert_eq!(restart, Ok(InstallStart::Complete));
        assert!(fixture.no_requests());
    }

    #[test]
    fn a_damaged_translated_platform_tree_is_never_started() {
        let offline = ClosedConnectionServer::start();
        let fixture = InstallFixture::new();
        fixture.install_as_platform(TRANSLATED_FROM, "x64 binary");
        fixture.shorten_binary();

        let outcome = ensure_install(
            &fixture.release_for_platform(TRANSLATED_ON, offline.base_url()),
            &fixture.install_dir(),
        );

        assert!(
            matches!(&outcome, Err(message) if message.contains("cannot download")),
            "expected a short {TRANSLATED_FROM} binary to fail the start, not run | received {outcome:?}"
        );
    }

    #[test]
    fn a_staged_tree_of_a_translated_platform_is_not_adopted() {
        let fixture = InstallFixture::new();
        fixture.publish_for_platform(TRANSLATED_ON, "arm64 binary");
        let staging = fixture.staging_dir("11-1");
        fixture.lay_down_tree_for_platform(&staging, TRANSLATED_FROM, "x64 binary");

        let outcome = ensure_install(
            &fixture.release_for_platform(TRANSLATED_ON, fixture.server.base_url()),
            &fixture.install_dir(),
        );

        assert_eq!(outcome, Ok(InstallStart::Installed));
        assert_eq!(
            fixture.installed_binary_body(),
            "arm64 binary",
            "expected a download instead of adopting the {TRANSLATED_FROM} staging tree"
        );
    }

    #[test]
    fn platform_fit_accepts_only_the_listed_translated_pairs() {
        let recorded = |platform: &str| InstallRecord {
            platform: Some(platform.to_string()),
            entries: vec![(BINARY_NAME.to_string(), 1)],
        };

        for (from, on) in RUNS_THROUGH_TRANSLATION {
            assert_eq!(
                recorded(from).platform_fit(Some(on)),
                PlatformFit::Emulated,
                "expected a {from} tree to run on {on}"
            );
        }
        // Direction matters: Intel Macs cannot run arm64 binaries. The Linux
        // libc variants are not interchangeable either: the musl hub needs the
        // musl loader and the glibc hub the glibc loader.
        for (from, on) in [
            ("darwin-arm64", "darwin-x64"),
            ("linux-x64", "linux-x64-musl"),
            ("linux-x64-musl", "linux-x64"),
            ("linux-arm64", "linux-arm64-musl"),
            ("linux-arm64-musl", "linux-arm64"),
            ("linux-x64", "linux-arm64"),
            ("darwin-x64", "linux-x64"),
        ] {
            assert_eq!(
                recorded(from).platform_fit(Some(on)),
                PlatformFit::Foreign,
                "expected a {from} tree not to run on {on}"
            );
        }
        assert_eq!(
            recorded("darwin-x64").platform_fit(Some("darwin-x64")),
            PlatformFit::Native
        );
    }

    #[test]
    fn a_tree_installed_for_this_platform_starts_with_no_request() {
        let fixture = InstallFixture::new();
        fixture.install_as_platform(TEST_PLATFORM, "this platform binary");

        assert_eq!(fixture.start(), Ok(InstallStart::Complete));
        assert!(fixture.no_requests());
    }

    #[test]
    fn a_record_from_before_platforms_were_recorded_still_starts_with_no_request() {
        let fixture = InstallFixture::new();
        fixture.lay_down_complete_install("binary one");
        // The record an earlier launcher wrote: sizes only, no platform line.
        let record = completion_record(&fixture.install_dir()).expect("expected a record");
        fs::write(fixture.install_dir().join(INSTALL_RECORD), record)
            .expect("expected the record to be rewritten");

        assert_eq!(fixture.start(), Ok(InstallStart::Complete));
        assert!(fixture.no_requests());
    }

    #[test]
    fn a_staged_tree_of_another_platform_is_not_adopted() {
        let fixture = InstallFixture::new();
        fixture.publish("this platform binary");
        let staging = fixture.staging_dir("11-1");
        fixture.lay_down_tree_for_platform(&staging, OTHER_PLATFORM, "other platform binary");

        assert_eq!(fixture.start(), Ok(InstallStart::Installed));

        assert_eq!(
            fixture.installed_binary_body(),
            "this platform binary",
            "expected a download instead of adopting the {OTHER_PLATFORM} staging tree"
        );
        assert_eq!(fixture.archive_requests(), 1);
    }

    #[test]
    fn a_trash_tree_of_another_platform_is_not_put_back() {
        let offline = ClosedConnectionServer::start();
        let fixture = InstallFixture::new();
        let trash = fixture.trash_dir("11-2");
        fixture.lay_down_tree_for_platform(&trash, OTHER_PLATFORM, "other platform binary");

        let outcome = ensure_install(
            &fixture.release_at(offline.base_url()),
            &fixture.install_dir(),
        );

        assert!(
            matches!(&outcome, Err(message) if message.contains("cannot download")),
            "expected the download failure, not a restore of the {OTHER_PLATFORM} tree | received {outcome:?}"
        );
        assert!(!fixture.install_dir().exists());
    }

    #[test]
    fn parse_record_reads_the_platform_line_and_rejects_a_malformed_one() {
        let binary_line = format!("10\t{BINARY_NAME}\n");

        let recorded = parse_record(&format!("platform\tlinux-x64\n{binary_line}"));
        assert_eq!(
            recorded,
            Some(InstallRecord {
                platform: Some("linux-x64".to_string()),
                entries: vec![(BINARY_NAME.to_string(), 10)],
            })
        );
        assert_eq!(
            parse_record(&binary_line).map(|record| record.platform),
            Some(None),
            "expected a record with no platform line to parse as platform-less"
        );
        for malformed in [
            format!("platform\t\n{binary_line}"),
            format!("platform\ta\nplatform\tb\n{binary_line}"),
            "platform\tlinux-x64\n".to_string(),
        ] {
            assert_eq!(
                parse_record(&malformed),
                None,
                "expected {malformed:?} to be unreadable"
            );
        }
    }

    #[test]
    fn inspect_install_judges_a_recorded_platform_against_this_build() {
        let fixture = InstallFixture::new();
        let install = fixture.install_dir();
        fixture.lay_down_tree_for_platform(&install, OTHER_PLATFORM, "binary one");

        assert_eq!(
            inspect_install(&install, Some(TEST_PLATFORM)),
            InstallState::Unusable,
            "expected a {OTHER_PLATFORM} tree to be unusable on {TEST_PLATFORM}"
        );
        assert_eq!(
            inspect_install(&install, Some(OTHER_PLATFORM)),
            InstallState::Complete
        );
        assert_eq!(
            inspect_install(&install, None),
            InstallState::Complete,
            "expected a build with no release platform to compare nothing"
        );
    }

    // --- when repair fails: the binaries decide whether to start ---

    #[test]
    fn a_short_binary_is_never_started_when_the_repair_fails() {
        let offline = ClosedConnectionServer::start();
        let fixture = InstallFixture::new();
        fixture.lay_down_complete_install("a hub binary of some length");
        fixture.shorten_binary();

        let outcome = ensure_install(
            &fixture.release_at(offline.base_url()),
            &fixture.install_dir(),
        );

        assert!(
            matches!(&outcome, Err(message) if message.contains("cannot download")),
            "expected the download failure, not a start of the short binary | received {outcome:?}"
        );
    }

    #[test]
    fn a_damaged_sibling_with_intact_binaries_starts_when_the_download_fails() {
        let offline = ClosedConnectionServer::start();
        let fixture = InstallFixture::new();
        fixture.lay_down_complete_install("binary one");
        fixture.damage_sibling();

        let outcome = ensure_install(
            &fixture.release_at(offline.base_url()),
            &fixture.install_dir(),
        );

        assert!(
            matches!(&outcome, Ok(InstallStart::KeptInstalled { reason }) if reason.contains("cannot download")),
            "expected the installed build to be kept with the download error | received {outcome:?}"
        );
        assert_eq!(fixture.installed_binary_body(), "binary one");
    }

    #[test]
    fn a_damaged_sibling_starts_when_the_release_is_gone_or_the_archive_is_bad() {
        let fixture = InstallFixture::new();
        fixture.lay_down_complete_install("binary one");
        fixture.damage_sibling();
        fixture.server.serve_status("/SHA256SUMS", 404);

        let gone = fixture.start();

        assert!(
            matches!(&gone, Ok(InstallStart::KeptInstalled { reason }) if reason.contains("404")),
            "expected the build to be kept with the 404 | received {gone:?}"
        );

        let announced = archive_with_binary("binary two");
        fixture.server.serve(
            "/SHA256SUMS",
            manifest_listing(&fixture.asset(), &announced).into_bytes(),
        );
        fixture.server.serve(
            &format!("/{}", fixture.asset()),
            archive_with_binary("tampered"),
        );

        let tampered = fixture.start();

        assert!(
            matches!(&tampered, Ok(InstallStart::KeptInstalled { reason }) if reason.contains("checksum mismatch")),
            "expected the build to be kept with the checksum error | received {tampered:?}"
        );
        assert_eq!(fixture.installed_binary_body(), "binary one");
        assert_eq!(fixture.leftover_scratch(), Vec::<String>::new());
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

    // --- requests: silence ends them, a slow link does not ---

    #[test]
    fn a_stalled_archive_download_ends_at_the_read_deadline_instead_of_hanging() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        fixture
            .server
            .serve_hanging(&format!("/{}", fixture.asset()));
        let mut release = fixture.release();
        release.read_timeout = Duration::from_millis(300);
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
    fn a_stalled_manifest_request_ends_at_the_read_deadline_instead_of_hanging() {
        let fixture = InstallFixture::new();
        fixture.server.serve_hanging("/SHA256SUMS");
        let mut release = fixture.release();
        release.read_timeout = Duration::from_millis(300);

        let outcome = ensure_install(&release, &fixture.install_dir());

        assert!(
            matches!(&outcome, Err(message) if message.contains("timeout")),
            "expected a timeout failure | received {outcome:?}"
        );
    }

    #[test]
    fn a_slow_but_steady_download_outlasts_the_read_deadline_without_failing() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        // Twenty pieces 100 ms apart: the transfer takes about two seconds,
        // past the 1.5 s read deadline, yet no single read waits more than a
        // fifteenth of it, so a loaded host cannot trip the deadline by delay.
        fixture.server.serve_trickling(
            &format!("/{}", fixture.asset()),
            archive_with_binary("binary one"),
            20,
            Duration::from_millis(100),
        );
        let mut release = fixture.release();
        release.read_timeout = Duration::from_millis(1500);
        let started = Instant::now();

        let outcome = ensure_install(&release, &fixture.install_dir());

        assert_eq!(outcome, Ok(InstallStart::Installed));
        assert!(
            started.elapsed() > Duration::from_millis(1500),
            "expected the transfer to run longer than the read deadline | took {:?}",
            started.elapsed()
        );
        assert_eq!(fixture.archive_requests(), 1);
    }

    // --- failed installs leave nothing ---

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
        assert_eq!(fixture.leftover_scratch(), Vec::<String>::new());
    }

    #[test]
    fn an_archive_without_the_binary_fails_and_leaves_nothing() {
        let fixture = InstallFixture::new();
        let archive = archive_without_binary();
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

    // --- the lock ---

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
    fn a_start_waiting_on_the_lock_finds_the_install_a_peer_completed_and_downloads_nothing() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        let peer_lock = fixture.hold_lock();

        let outcome = thread::scope(|scope| {
            let waiting = scope.spawn(|| fixture.start());
            thread::sleep(Duration::from_millis(300));
            // The peer finishes its install, then lets go of the lock.
            fixture.lay_down_complete_install("peer binary");
            drop(peer_lock);
            waiting
                .join()
                .expect("expected the waiting start to finish")
        });

        assert_eq!(outcome, Ok(InstallStart::Complete));
        assert!(fixture.no_requests());
        assert_eq!(fixture.installed_binary_body(), "peer binary");
    }

    #[test]
    fn wait_for_lock_keeps_waiting_while_the_lock_is_held_and_takes_it_when_free() {
        let fixture = InstallFixture::new();
        let path = fixture.release().lock_path(&fixture.root.0);
        let mut attempts = 0;

        let outcome = wait_for_lock(&fixture.release(), &path, || {
            attempts += 1;
            if attempts < 4 {
                Err(fs::TryLockError::WouldBlock)
            } else {
                Ok(())
            }
        });

        assert_eq!(outcome, Ok(()));
        assert_eq!(attempts, 4);
    }

    #[test]
    fn wait_for_lock_gives_up_only_at_its_ceiling_and_names_the_lock() {
        let fixture = InstallFixture::new();
        let path = fixture.release().lock_path(&fixture.root.0);
        let mut release = fixture.release();
        release.lock_ceiling = Duration::from_millis(300);

        let outcome = wait_for_lock(&release, &path, || Err(fs::TryLockError::WouldBlock));

        assert!(
            matches!(&outcome, Err(message) if message.contains("still installing") && message.contains(".launcher-0.0.0.lock")),
            "expected a ceiling failure naming the lock file | received {outcome:?}"
        );
    }

    #[test]
    fn wait_for_lock_fails_at_once_when_the_file_system_cannot_lock() {
        let fixture = InstallFixture::new();
        let path = fixture.release().lock_path(&fixture.root.0);

        let outcome = wait_for_lock(&fixture.release(), &path, || {
            Err(fs::TryLockError::Error(io::Error::from(
                io::ErrorKind::Unsupported,
            )))
        });

        assert!(
            matches!(&outcome, Err(message) if message.contains("cannot lock") && message.contains(".launcher-0.0.0.lock") && message.contains("file locking")),
            "expected a lock failure naming the file and the likely cause | received {outcome:?}"
        );
    }

    /// A directory where the lock file should be: opening it for writing fails
    /// on every platform, which is how a read-only or foreign-owned lock looks.
    fn make_lock_unopenable(fixture: &InstallFixture) {
        fs::create_dir_all(fixture.release().lock_path(&fixture.root.0))
            .expect("expected a directory in place of the lock file");
    }

    #[test]
    fn without_a_lock_a_first_install_fails_naming_the_lock_and_never_downloads() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        make_lock_unopenable(&fixture);

        let outcome = fixture.start();

        assert!(
            matches!(&outcome, Err(message) if message.contains("cannot open") && message.contains(".launcher-0.0.0.lock") && message.contains("file locking")),
            "expected a failure naming the lock and its likely cause | received {outcome:?}"
        );
        assert!(fixture.no_requests());
        assert!(!fixture.install_dir().exists());
    }

    #[test]
    fn without_a_lock_an_install_with_intact_binaries_starts_and_a_short_one_does_not() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        fixture.lay_down_complete_install("binary one");
        fixture.damage_sibling();
        make_lock_unopenable(&fixture);

        let startable = fixture.start();

        assert!(
            matches!(&startable, Ok(InstallStart::KeptInstalled { reason }) if reason.contains("cannot open")),
            "expected the installed build to be kept | received {startable:?}"
        );

        fixture.lay_down_complete_install("binary one");
        fixture.shorten_binary();

        let short = fixture.start();

        assert!(
            matches!(&short, Err(message) if message.contains("cannot open")),
            "expected the lock failure, not a start of the short binary | received {short:?}"
        );
        assert!(fixture.no_requests());
    }

    // --- crash recovery ---

    #[test]
    fn an_install_interrupted_before_the_swap_is_finished_from_its_staging_tree_offline() {
        let offline = ClosedConnectionServer::start();
        let fixture = InstallFixture::new();
        // A launcher died after unpacking, recording and flushing, before moving
        // the tree in. The install it meant to replace is incomplete.
        fixture.lay_down_complete_install("old binary");
        fixture.shorten_binary();
        let staging = fixture.staging_dir("11-1");
        fixture.lay_down_tree(&staging, "new binary");

        let outcome = ensure_install(
            &fixture.release_at(offline.base_url()),
            &fixture.install_dir(),
        );

        assert_eq!(outcome, Ok(InstallStart::Installed));
        assert_eq!(fixture.installed_binary_body(), "new binary");
        assert!(
            !staging.exists(),
            "expected the staging tree to be moved in"
        );
        assert_eq!(fixture.leftover_scratch(), Vec::<String>::new());
    }

    #[test]
    fn an_install_interrupted_between_the_two_moves_is_finished_from_its_staging_tree() {
        let fixture = InstallFixture::new();
        // The old tree is already in trash and the version directory is gone.
        let trash = fixture.trash_dir("11-2");
        fixture.lay_down_tree(&trash, "old binary");
        fs::write(trash.join(BINARY_NAME), "bin").expect("expected the old tree to be short");
        fixture.lay_down_tree(&fixture.staging_dir("11-1"), "new binary");

        let outcome = fixture.start();

        assert_eq!(outcome, Ok(InstallStart::Installed));
        assert_eq!(fixture.installed_binary_body(), "new binary");
        assert!(fixture.no_requests());
        assert_eq!(fixture.leftover_scratch(), Vec::<String>::new());
    }

    #[test]
    fn a_staging_tree_that_is_not_verified_is_swept_and_the_archive_downloaded() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        // Partial unpack: files but no record.
        let no_record = fixture.staging_dir("12-1");
        fs::create_dir_all(&no_record).expect("expected a staging dir");
        fs::write(no_record.join(BINARY_NAME), "half").expect("expected a file");
        // A record the files do not match.
        let short = fixture.staging_dir("13-1");
        fixture.lay_down_tree(&short, "binary two");
        fs::write(short.join(BINARY_NAME), "bin").expect("expected a short file");

        let outcome = fixture.start();

        assert_eq!(outcome, Ok(InstallStart::Installed));
        assert_eq!(fixture.installed_binary_body(), "binary one");
        assert_eq!(fixture.archive_requests(), 1);
        assert_eq!(fixture.leftover_scratch(), Vec::<String>::new());
    }

    #[test]
    fn a_complete_start_removes_the_trash_a_launcher_left_after_moving_in() {
        let fixture = InstallFixture::new();
        // Killed after the move-in, before deleting the old tree.
        fixture.lay_down_complete_install("new binary");
        let trash = fixture.trash_dir("11-2");
        fixture.lay_down_tree(&trash, "old binary");
        // The killed launcher had created the lock file before it got here.
        drop(fixture.hold_lock());
        assert_eq!(fixture.start(), Ok(InstallStart::Complete));

        tidy_leftovers(
            fixture.version,
            Some(TEST_PLATFORM),
            &fixture.root.0,
            &fixture.install_dir(),
        );

        assert!(!trash.exists(), "expected the trash directory to be swept");
        assert_eq!(fixture.installed_binary_body(), "new binary");
        assert!(fixture.no_requests());
    }

    #[test]
    fn a_complete_start_leaves_scratch_alone_while_another_launcher_holds_the_lock() {
        let fixture = InstallFixture::new();
        fixture.lay_down_complete_install("binary one");
        let staging = fixture.staging_dir("14-1");
        fixture.lay_down_tree(&staging, "being unpacked");
        let installer_lock = fixture.hold_lock();

        tidy_leftovers(
            fixture.version,
            Some(TEST_PLATFORM),
            &fixture.root.0,
            &fixture.install_dir(),
        );

        assert!(
            staging.exists(),
            "expected a live installer's staging tree to survive"
        );
        drop(installer_lock);
        tidy_leftovers(
            fixture.version,
            Some(TEST_PLATFORM),
            &fixture.root.0,
            &fixture.install_dir(),
        );
        assert!(!staging.exists());
    }

    #[test]
    fn the_sweep_removes_only_this_launchers_scratch_names_for_this_version() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        let foreign = [
            fixture.root.0.join(format!(".install-{TEST_VERSION}.4242")),
            fixture.root.0.join(format!(".staging-{TEST_VERSION}-4242")),
            fixture.root.0.join(".launcher-staging-9.9.9.other"),
        ];
        let mine = [
            fixture.staging_dir("999999-1"),
            fixture.trash_dir("999999-2"),
        ];
        for directory in foreign.iter().chain(mine.iter()) {
            fs::create_dir_all(directory).expect("expected a scratch directory");
            // An empty binary and no record: nothing here is adoptable.
            fs::write(directory.join(BINARY_NAME), "").expect("expected a file");
        }

        assert_eq!(fixture.start(), Ok(InstallStart::Installed));

        for directory in &mine {
            assert!(
                !directory.exists(),
                "expected {} swept",
                directory.display()
            );
        }
        for directory in &foreign {
            assert!(
                directory.exists(),
                "expected {} to survive the sweep",
                directory.display()
            );
        }
    }

    // --- replacing a tree ---

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
            let file_in_the_way = fixture.release().trash_path(&fixture.root.0);
            fs::write(&file_in_the_way, "in the way").expect("expected the blocking file");
            ReplaceBlocker { file_in_the_way }
        }
    }

    #[test]
    fn a_blocked_replace_keeps_an_install_with_intact_binaries_and_downloads_nothing() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        fixture.lay_down_complete_install("old binary");
        fixture.damage_sibling();
        let blocker = block_replace(&fixture);

        let outcome = fixture.start();
        // Release the block before reading the binary: an exclusive handle
        // would refuse that read on Windows.
        drop(blocker);

        assert!(
            matches!(&outcome, Ok(InstallStart::KeptInstalled { reason }) if reason.contains("cannot replace the install")),
            "expected the installed build to be kept with the move error | received {outcome:?}"
        );
        // Only Windows can tell before downloading; elsewhere the swap fails.
        if cfg!(windows) {
            assert!(
                fixture.no_requests(),
                "expected the replace check to run before any download | received {:?}",
                fixture.server.requests()
            );
        }
        assert_eq!(fixture.installed_binary_body(), "old binary");
    }

    #[test]
    fn a_blocked_replace_of_a_short_binary_is_an_error_not_a_start() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        fixture.lay_down_complete_install("old binary");
        fixture.shorten_binary();
        let blocker = block_replace(&fixture);

        let outcome = fixture.start();
        drop(blocker);

        assert!(
            matches!(&outcome, Err(message) if message.contains("cannot replace the install")),
            "expected a replace failure | received {outcome:?}"
        );
        if cfg!(windows) {
            assert!(fixture.no_requests());
        }
    }

    #[test]
    fn the_replace_check_moves_nothing_and_reports_an_install_in_use() {
        let fixture = InstallFixture::new();
        fixture.lay_down_complete_install("binary one");
        let before = fs::read_dir(&fixture.root.0)
            .expect("expected a readable root")
            .count();

        assert_eq!(check_replaceable(&fixture.install_dir()), Ok(()));
        assert_eq!(
            fs::read_dir(&fixture.root.0)
                .expect("expected a readable root")
                .count(),
            before,
            "expected the check to leave the install root as it was"
        );
        assert_eq!(fixture.installed_binary_body(), "binary one");

        // Only Windows can tell in advance; elsewhere the swap reports it.
        #[cfg(windows)]
        {
            let blocker = block_replace(&fixture);
            let outcome = check_replaceable(&fixture.install_dir());
            drop(blocker);
            assert!(
                matches!(&outcome, Err(message) if message.contains("cannot replace the install") && message.contains("in use")),
                "expected an in-use failure naming the install | received {outcome:?}"
            );
        }
    }

    #[test]
    fn a_startable_install_left_in_trash_with_no_version_directory_is_put_back_and_starts_offline()
    {
        let offline = ClosedConnectionServer::start();
        let fixture = InstallFixture::new();
        // A launcher died (or a rename back failed) after moving the only good
        // copy aside: binaries intact, a sibling off.
        let trash = fixture.trash_dir("11-2");
        fixture.lay_down_tree(&trash, "the only good copy");
        fs::write(trash.join("README.md"), "damaged by a crash")
            .expect("expected a damaged sibling");
        assert!(!fixture.install_dir().exists());

        let outcome = ensure_install(
            &fixture.release_at(offline.base_url()),
            &fixture.install_dir(),
        );

        assert!(
            matches!(&outcome, Ok(InstallStart::KeptInstalled { reason }) if reason.contains("cannot download")),
            "expected the restored build to be kept with the download error | received {outcome:?}"
        );
        assert_eq!(fixture.installed_binary_body(), "the only good copy");
        assert!(!trash.exists(), "expected the trash tree to be moved back");
    }

    #[test]
    fn an_unusable_tree_left_in_trash_is_not_put_back() {
        let offline = ClosedConnectionServer::start();
        let fixture = InstallFixture::new();
        let trash = fixture.trash_dir("11-2");
        fixture.lay_down_tree(&trash, "old binary");
        fs::write(trash.join(BINARY_NAME), "bin").expect("expected a short binary");

        let outcome = ensure_install(
            &fixture.release_at(offline.base_url()),
            &fixture.install_dir(),
        );

        assert!(
            matches!(&outcome, Err(message) if message.contains("cannot download")),
            "expected the download failure | received {outcome:?}"
        );
        assert!(!fixture.install_dir().exists());
        assert!(!trash.exists());
    }

    /// A rename that is always refused, as when a scanner holds a handle on the
    /// tree (Windows) or the path is not writable.
    fn rename_refused_by_a_scanner(_from: &Path, _to: &Path) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "access denied: a scanner holds a handle",
        ))
    }

    /// A trash tree holding the only good copy (a sibling is off, binaries
    /// intact) and no version directory: what a failed restore starts from.
    fn lay_down_only_good_copy_in_trash(fixture: &InstallFixture) -> PathBuf {
        let trash = fixture.trash_dir("11-2");
        fixture.lay_down_tree(&trash, "the only good copy");
        fs::write(trash.join("README.md"), "damaged by a crash")
            .expect("expected a damaged sibling");
        assert_eq!(
            inspect_install(&trash, Some(TEST_PLATFORM)),
            InstallState::Startable
        );
        assert!(!fixture.install_dir().exists());
        trash
    }

    #[test]
    fn a_failed_restore_with_the_download_failing_keeps_the_only_good_copy_and_names_it() {
        let offline = ClosedConnectionServer::start();
        let fixture = InstallFixture::new();
        let trash = lay_down_only_good_copy_in_trash(&fixture);
        let release = Release {
            restore_rename: rename_refused_by_a_scanner,
            ..fixture.release_at(offline.base_url())
        };

        let outcome = ensure_install(&release, &fixture.install_dir());

        assert!(
            trash.join(BINARY_NAME).is_file(),
            "expected the trash tree {} to survive a failed restore and a failed download | received {:?}",
            trash.display(),
            fixture.leftover_scratch()
        );
        assert!(
            matches!(&outcome, Err(message)
                if message.contains("cannot download")
                    && message.contains("nothing was started")
                    && message.contains(&trash.display().to_string())
                    && message.contains("access denied")),
            "expected an error naming the trash tree, the refusal and that nothing started | received {outcome:?}"
        );
    }

    #[test]
    fn a_failed_restore_followed_by_a_good_download_sweeps_the_old_tree_after_the_new_install() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        let trash = lay_down_only_good_copy_in_trash(&fixture);
        let release = Release {
            restore_rename: rename_refused_by_a_scanner,
            ..fixture.release()
        };

        let outcome = ensure_install(&release, &fixture.install_dir());

        assert_eq!(outcome, Ok(InstallStart::Installed));
        assert_eq!(fixture.installed_binary_body(), "binary one");
        assert!(
            !trash.exists(),
            "expected the old tree swept once the new install is complete"
        );
        assert_eq!(fixture.leftover_scratch(), Vec::<String>::new());
    }

    #[test]
    fn the_sweep_keeps_a_startable_trash_tree_until_the_install_is_complete() {
        let fixture = InstallFixture::new();
        let startable = lay_down_only_good_copy_in_trash(&fixture);
        let unusable = fixture.trash_dir("12-3");
        fixture.lay_down_tree(&unusable, "old binary");
        fs::write(unusable.join(BINARY_NAME), "bin").expect("expected a short binary");

        // Version directory missing.
        sweep_scratch_dirs(
            fixture.version,
            Some(TEST_PLATFORM),
            &fixture.root.0,
            &fixture.install_dir(),
        );
        assert!(startable.exists(), "expected the startable tree kept");
        assert!(!unusable.exists(), "expected the unusable tree swept");

        // Version directory present but not complete.
        fixture.lay_down_complete_install("new binary");
        fixture.damage_sibling();
        sweep_scratch_dirs(
            fixture.version,
            Some(TEST_PLATFORM),
            &fixture.root.0,
            &fixture.install_dir(),
        );
        assert!(startable.exists(), "expected the startable tree kept");

        // Complete.
        fixture.lay_down_complete_install("new binary");
        sweep_scratch_dirs(
            fixture.version,
            Some(TEST_PLATFORM),
            &fixture.root.0,
            &fixture.install_dir(),
        );
        assert!(!startable.exists(), "expected the tree swept");
    }

    #[test]
    fn scratch_of_a_version_that_extends_this_one_is_neither_adopted_nor_swept() {
        let offline = ClosedConnectionServer::start();
        // `0.2.0-canary.abc1234` shares the prefix `.launcher-staging-0.2.0-canary.`
        // with `0.2.0-canary` but has its own lock and its own installs.
        let fixture = InstallFixture::with_version("0.2.0-canary");
        let other_version = "0.2.0-canary.abc1234";
        let other_staging = fixture.root.0.join(format!(
            "{}{}",
            scratch_prefix("staging", other_version),
            "11-1"
        ));
        let other_trash = fixture.root.0.join(format!(
            "{}{}",
            scratch_prefix("trash", other_version),
            "11-2"
        ));
        fixture.lay_down_tree(&other_staging, "another version's verified tree");
        fixture.lay_down_tree(&other_trash, "another version's old tree");
        let own_leftover = fixture.staging_dir("12-1");
        fs::create_dir_all(&own_leftover).expect("expected a leftover of this version");

        let outcome = ensure_install(
            &fixture.release_at(offline.base_url()),
            &fixture.install_dir(),
        );

        assert!(
            matches!(&outcome, Err(message) if message.contains("cannot download")),
            "expected no adoption of the other version's tree, only the download failure | received {outcome:?}"
        );
        assert!(!fixture.install_dir().exists());
        assert!(
            other_staging.exists(),
            "expected the other version's staging to survive"
        );
        assert!(
            other_trash.exists(),
            "expected the other version's trash to survive"
        );
        assert!(
            !own_leftover.exists(),
            "expected this version's own leftover swept"
        );
    }

    #[test]
    fn is_run_tag_accepts_only_pid_dash_nanos() {
        for accepted in ["1-1", "4242-1731800000000000000"] {
            assert!(is_run_tag(accepted), "expected {accepted:?} accepted");
        }
        for rejected in ["", "1", "-1", "1-", "abc1234.11-1", "a-1", "1-2-3", "1.2-3"] {
            assert!(!is_run_tag(rejected), "expected {rejected:?} rejected");
        }
    }

    #[test]
    fn a_failed_move_of_the_new_tree_puts_the_previous_install_back() {
        let fixture = InstallFixture::new();
        fixture.lay_down_complete_install("previous binary");
        // The staged tree is missing, so moving it in fails after the previous
        // install has already been moved to trash.
        let missing_staging = fixture.root.0.join("no-such-staging");

        let outcome = replace_install(
            &fixture.release(),
            &fixture.root.0,
            &missing_staging,
            &fixture.install_dir(),
        );

        assert!(
            matches!(&outcome, Err(message) if message.contains("cannot move the new install") && message.contains("for the next start")),
            "expected the move error naming where the verified files stay | received {outcome:?}"
        );
        assert_eq!(fixture.installed_binary_body(), "previous binary");
        assert!(!fixture.release().trash_path(&fixture.root.0).exists());
    }

    #[test]
    fn replacing_an_incomplete_install_swaps_in_the_new_tree_and_drops_the_old_one() {
        let fixture = InstallFixture::new();
        fixture.publish("binary one");
        fixture.lay_down_complete_install("old binary");
        fixture.shorten_binary();

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
        // the install directory. It creates the marker file named by its first
        // argument, then blocks reading its stdin (shell builtins, so no child
        // process outlives the test). The shell keeps the script file open
        // meanwhile.
        //
        // The marker is what makes the test deterministic. `spawn` returns once
        // the kernel has exec'd `/bin/sh`, but the shell opens the script by
        // path afterwards. A reinstall that swaps the directory in that window
        // hands the shell the new script, which exits at once (issue #2434).
        // Once the marker exists the shell holds the old file, so only then is
        // the reinstall allowed to run. The marker lives outside the install
        // root so it is not part of the tree the reinstall inspects.
        fixture.lay_down_complete_install("#!/bin/sh\n: > \"$1\"\nread _\n");
        let marker_root = ScratchRoot::new();
        let hub_started_marker = marker_root.0.join("hub-started");
        let mut running_hub = Command::new(fixture.binary_path())
            .arg(&hub_started_marker)
            .stdin(std::process::Stdio::piped())
            .spawn()
            .expect("expected the installed binary to start");
        let marker_deadline = Instant::now() + Duration::from_secs(30);
        while !hub_started_marker.exists() {
            let exited = running_hub
                .try_wait()
                .expect("expected to poll the starting hub");
            assert!(
                exited.is_none() && Instant::now() < marker_deadline,
                "expected the hub to create {} before the reinstall | received exit status {exited:?} after at most 30s",
                hub_started_marker.display()
            );
            thread::sleep(Duration::from_millis(5));
        }
        // Damage a sibling so the install is replaced while the hub runs.
        fixture.damage_sibling();
        assert_eq!(
            inspect_install(&fixture.install_dir(), Some(TEST_PLATFORM)),
            InstallState::Startable
        );

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

    // --- durability helpers ---

    #[test]
    fn persist_tree_flushes_a_real_tree_and_reports_a_missing_file_by_path() {
        let fixture = InstallFixture::new();
        fixture.lay_down_complete_install("binary one");

        assert!(persist_tree(&fixture.install_dir()).is_ok());
        assert_eq!(fixture.installed_binary_body(), "binary one");

        let missing = fixture.install_dir().join("no-such-file");
        let outcome = sync_file(&missing);
        assert!(
            matches!(&outcome, Err(error) if error.kind() == io::ErrorKind::NotFound),
            "expected NotFound for {} | received {outcome:?}",
            missing.display()
        );
    }

    #[test]
    fn completion_record_lists_top_level_files_with_their_sizes_in_name_order() {
        let fixture = InstallFixture::new();
        let directory = fixture.install_dir();
        fs::create_dir_all(directory.join("nested")).expect("expected a nested dir");
        fs::write(directory.join("b.txt"), "bb").expect("expected a file");
        fs::write(directory.join("a.txt"), "a").expect("expected a file");
        fs::write(directory.join("nested").join("c.txt"), "ccc").expect("expected a file");
        // A record from an earlier pass must not list itself.
        fs::write(directory.join(INSTALL_RECORD), "stale").expect("expected a record");

        assert_eq!(
            completion_record(&directory).as_deref().ok(),
            Some("1\ta.txt\n2\tb.txt\n")
        );
    }
}
