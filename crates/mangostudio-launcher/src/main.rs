//! Thin launcher for MangoStudio, published to crates.io.
//!
//! The product is a Bun-compiled binary distributed via GitHub Releases with
//! the frontend embedded in the executable; this crate is not the app source. On first run the launcher downloads the platform archive matching
//! the crate version into `~/.mango/dist/<version>/` (checksum-verified, the
//! same layout the shell installer uses), then hands over to the real binary
//! with arguments and environment untouched, except for two markers —
//! `MANGOSTUDIO_LAUNCHER` and `MANGOSTUDIO_LAUNCHER_PATH` — that announce this
//! shim to the binary it spawns, the way the npm wrapper announces itself too.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

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
/// The canary freshness probe runs on every start, so it gets one attempt and
/// a short deadline instead of the retrying download path: a dead network must
/// cost a canary start seconds, not the retry backoff.
const CANARY_CHECK_TIMEOUT: Duration = Duration::from_secs(10);
/// Written into a canary install directory: the SHA-256 of the archive that
/// directory was unpacked from. It is staged inside the tree and lands with the
/// same rename, so it exists only beside a complete, verified unpack.
const ARCHIVE_DIGEST_MARKER: &str = ".archive-sha256";

fn main() {
    if let Err(message) = run() {
        eprintln!("mangostudio launcher: {message}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let install_dir = install_root()?.join(VERSION);
    let binary_path = install_dir.join(BINARY_NAME);
    if is_canary_version() {
        match ensure_canary_current(&Release::for_this_build()?, &install_dir)? {
            CanaryStart::Current | CanaryStart::Installed => {}
            CanaryStart::KeptInstalled { reason } => {
                eprintln!("mangostudio launcher: warning: {reason}; starting the installed build");
            }
        }
    } else if !binary_path.is_file() {
        // A stable release never changes under its version: an installed
        // binary is the end of the matter, with no request and no marker.
        install(&Release::for_this_build()?, &install_dir)?;
    }
    run_binary(&binary_path)
}

fn is_canary_version() -> bool {
    is_canary(VERSION)
}

fn is_canary(version: &str) -> bool {
    version
        .split('+')
        .next()
        .unwrap_or(version)
        .contains("-canary")
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
/// live, and the platform archive to pick. Everything the install path needs
/// is a field here so tests can aim it at a fake server and a canary version.
struct Release<'a> {
    version: &'a str,
    platform: &'a str,
    base_url: String,
    retry_delay: Duration,
}

impl Release<'static> {
    fn for_this_build() -> Result<Self, String> {
        Ok(Self {
            version: VERSION,
            platform: platform_id()?,
            base_url: dist_base_url(),
            retry_delay: DOWNLOAD_RETRY_DELAY,
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
}

fn asset_name(version: &str, platform: &str) -> String {
    format!("mangostudio-{version}-{platform}.{ARCHIVE_EXTENSION}")
}

/// Download, verify and unpack the release into `install_dir`. A stable
/// launcher runs this only when the binary is missing.
fn install(release: &Release<'_>, install_dir: &Path) -> Result<(), String> {
    eprintln!(
        "Downloading MangoStudio {} for {}...",
        release.version, release.platform
    );
    let manifest = download_manifest(release)?;
    install_archive(release, install_dir, &manifest, None).map(|_| ())
}

fn download_manifest(release: &Release<'_>) -> Result<String, String> {
    String::from_utf8(download(&release.manifest_url(), release.retry_delay)?)
        .map_err(|_| "SHA256SUMS is not valid UTF-8".to_string())
}

/// How [`install_archive`] left the install directory.
#[derive(Debug, PartialEq, Eq)]
enum SwapOutcome {
    Replaced,
    /// The directory holding a working binary could not be moved aside, which
    /// is what a running Windows hub does to its own files. The previous
    /// install is untouched.
    InUse,
}

/// Download the archive named by `manifest`, check it against the manifest's
/// digest, unpack it into a staging directory and swap that into
/// `install_dir`. `record_digest` is the canary marker: when set it is staged
/// with the tree, so it lands with the same rename and never describes a
/// half-written install.
fn install_archive(
    release: &Release<'_>,
    install_dir: &Path,
    manifest: &str,
    record_digest: Option<&str>,
) -> Result<SwapOutcome, String> {
    let asset = release.asset();
    let expected = expected_checksum(manifest, &asset)?;
    let archive = download(&release.archive_url(), release.retry_delay)?;

    let actual = sha256_hex(&archive);
    if expected != actual {
        return Err(format!(
            "checksum mismatch for {asset}: expected {expected}, got {actual}"
        ));
    }
    eprintln!("Checksum verified: {asset}");

    let install_root = install_root_of(install_dir)?;
    fs::create_dir_all(install_root)
        .map_err(|error| format!("cannot create {}: {error}", install_root.display()))?;

    // Unpack into a staging dir and rename into place so a crash mid-unpack
    // never leaves a half-written version directory that later runs trust.
    let staging = install_root.join(format!(
        ".install-{}.{}",
        release.version,
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&staging);
    unpack(&archive, &staging)?;

    let staged_binary = staging.join(BINARY_NAME);
    if !staged_binary.is_file() {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("archive is missing {BINARY_NAME}"));
    }
    make_executable(&staged_binary)?;
    if let Some(digest) = record_digest
        && let Err(error) = fs::write(staging.join(ARCHIVE_DIGEST_MARKER), format!("{digest}\n"))
    {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "cannot record the installed archive digest: {error}"
        ));
    }

    let outcome = swap_into_place(release, &staging, install_dir, install_root, record_digest)?;
    if outcome == SwapOutcome::Replaced {
        eprintln!(
            "Installed MangoStudio {} to {}",
            release.version,
            install_dir.display()
        );
    }
    Ok(outcome)
}

fn install_root_of(install_dir: &Path) -> Result<&Path, String> {
    install_dir
        .parent()
        .ok_or_else(|| format!("install dir {} has no parent", install_dir.display()))
}

/// Put the staged tree at `install_dir`. An install that still has a binary is
/// moved aside before the swap instead of deleted in place: a Unix hub keeps
/// running from its unlinked inode either way, and on Windows the move fails
/// cleanly while the hub holds its files, where a recursive delete would
/// half-empty the directory the hub is running from.
fn swap_into_place(
    release: &Release<'_>,
    staging: &Path,
    install_dir: &Path,
    install_root: &Path,
    expected_digest: Option<&str>,
) -> Result<SwapOutcome, String> {
    let aside = if install_dir.join(BINARY_NAME).is_file() {
        let aside = install_root.join(format!(
            ".rollback-{}.{}",
            release.version,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&aside);
        if fs::rename(install_dir, &aside).is_err() {
            let _ = fs::remove_dir_all(staging);
            return Ok(SwapOutcome::InUse);
        }
        Some(aside)
    } else {
        let _ = fs::remove_dir_all(install_dir);
        None
    };

    if let Err(error) = fs::rename(staging, install_dir) {
        let _ = fs::remove_dir_all(staging);
        if let Some(aside) = &aside {
            let _ = fs::rename(aside, install_dir);
        }
        // A concurrent launcher may have completed the same install first. A
        // canary install only counts when it carries the digest we expected,
        // so a restored older build is not mistaken for it.
        let complete = match expected_digest {
            Some(digest) => install_is_current(install_dir, digest),
            None => install_dir.join(BINARY_NAME).is_file(),
        };
        if !complete {
            return Err(format!(
                "cannot move install into {}: {error}",
                install_dir.display()
            ));
        }
        return Ok(SwapOutcome::Replaced);
    }
    if let Some(aside) = aside {
        let _ = fs::remove_dir_all(aside);
    }
    Ok(SwapOutcome::Replaced)
}

/// What a canary start did about its install.
#[derive(Debug, PartialEq, Eq)]
enum CanaryStart {
    /// The installed archive matches the published one; nothing was downloaded.
    Current,
    /// A new archive was downloaded, verified and unpacked.
    Installed,
    /// The published build could not be checked or swapped in, and an install
    /// already exists. The caller starts it and says why.
    KeptInstalled { reason: String },
}

/// Bring a canary install up to date with its release. The release's
/// `SHA256SUMS` is the freshness probe: its digest for this platform's archive
/// is compared with the one recorded when the installed tree was unpacked, and
/// the archive is downloaded only when they differ or the install is missing,
/// incomplete or unrecorded. A failed probe never blocks a start that has
/// something to start; a failed update after the probe saw a change still does,
/// as a failed first install does.
fn ensure_canary_current(release: &Release<'_>, install_dir: &Path) -> Result<CanaryStart, String> {
    let asset = release.asset();
    let installed = install_dir.join(BINARY_NAME).is_file();

    let manifest = if installed {
        match fetch_manifest_once(release) {
            Ok(manifest) => manifest,
            Err(error) => {
                return Ok(CanaryStart::KeptInstalled {
                    reason: format!("cannot check for a newer canary build ({error})"),
                });
            }
        }
    } else {
        eprintln!(
            "Downloading MangoStudio {} for {}...",
            release.version, release.platform
        );
        download_manifest(release)?
    };
    let expected = match expected_checksum(&manifest, &asset) {
        Ok(expected) => expected,
        Err(error) if installed => {
            return Ok(CanaryStart::KeptInstalled {
                reason: format!("cannot check for a newer canary build ({error})"),
            });
        }
        Err(error) => return Err(error),
    };
    if install_is_current(install_dir, &expected) {
        return Ok(CanaryStart::Current);
    }

    let install_root = install_root_of(install_dir)?;
    fs::create_dir_all(install_root)
        .map_err(|error| format!("cannot create {}: {error}", install_root.display()))?;
    // Two launchers starting together would otherwise both download the
    // archive and swap the same directory. The first one in does the work; the
    // second wakes to a current install and leaves it alone.
    let _lock = lock_install(release, install_root)?;
    if install_is_current(install_dir, &expected) {
        return Ok(CanaryStart::Current);
    }
    if installed {
        eprintln!(
            "Downloading MangoStudio {} for {} (the installed canary build is not the published one)...",
            release.version, release.platform
        );
    }
    match install_archive(release, install_dir, &manifest, Some(&expected))? {
        SwapOutcome::Replaced => Ok(CanaryStart::Installed),
        SwapOutcome::InUse => Ok(CanaryStart::KeptInstalled {
            reason: format!(
                "the installed canary build is in use and was not replaced; stop the running hub and start again to take {}",
                release.version
            ),
        }),
    }
}

/// An install is current when its binary is there and the marker names the
/// digest the release publishes. A directory from the shell installer, or one
/// from before the marker existed, has no marker and is refreshed once.
fn install_is_current(install_dir: &Path, expected_digest: &str) -> bool {
    install_dir.join(BINARY_NAME).is_file()
        && fs::read_to_string(install_dir.join(ARCHIVE_DIGEST_MARKER))
            .is_ok_and(|recorded| recorded.trim() == expected_digest)
}

/// Exclusive advisory lock beside the version directories, held until the
/// returned file drops (or the process dies). The name starts with `.install-`
/// like the staging directories, and `install.sh --prune` sweeps only
/// directories, so the file is never read as a version.
fn lock_install(release: &Release<'_>, install_root: &Path) -> Result<fs::File, String> {
    let path = install_root.join(format!(".install-{}.lock", release.version));
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|error| format!("cannot open {}: {error}", path.display()))?;
    file.lock()
        .map_err(|error| format!("cannot lock {}: {error}", path.display()))?;
    Ok(file)
}

fn fetch_manifest_once(release: &Release<'_>) -> Result<String, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(CANARY_CHECK_TIMEOUT))
        .build()
        .into();
    let mut response = agent
        .get(&release.manifest_url())
        .call()
        .map_err(|error| error.to_string())?;
    response
        .body_mut()
        .with_config()
        .limit(MAX_MANIFEST_BYTES)
        .read_to_string()
        .map_err(|error| error.to_string())
}

fn download(url: &str, initial_delay: Duration) -> Result<Vec<u8>, String> {
    let mut delay = initial_delay;
    let mut last_error = String::new();
    for attempt in 1..=DOWNLOAD_ATTEMPTS {
        match fetch(url) {
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

fn fetch(url: &str) -> Result<Vec<u8>, String> {
    let mut response = ureq::get(url).call().map_err(|error| error.to_string())?;
    response
        .body_mut()
        .with_config()
        .limit(MAX_DOWNLOAD_BYTES)
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
        zip::ZipArchive::new(cursor).map_err(|error| format!("cannot open archive: {error}"))?;
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
    fn committed_launcher_version_is_not_canary() {
        assert!(!is_canary_version());
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

    #[test]
    fn is_canary_reads_the_prerelease_and_ignores_build_metadata() {
        assert!(is_canary("0.1.0-canary"));
        assert!(is_canary("0.1.0-canary.abc1234"));
        assert!(!is_canary("0.1.1"));
        assert!(!is_canary("0.1.1+canary-build"));
    }

    // --- canary freshness: a named fake release host, real files on disk ---

    use crate::fake_release_server::{FakeReleaseServer, unreachable_base_url};
    use crate::release_archive::{archive_with_binary, manifest_listing};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const CANARY_VERSION: &str = "0.0.0-canary.abc1234";
    const TEST_PLATFORM: &str = "test-platform";

    /// A scratch install root removed on drop.
    struct ScratchRoot(PathBuf);

    impl ScratchRoot {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = env::temp_dir().join(format!(
                "mangostudio-launcher-canary-{}-{}",
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

    /// One canary version published on a fake host, installed under a scratch root.
    struct CanaryFixture {
        server: FakeReleaseServer,
        root: ScratchRoot,
    }

    impl CanaryFixture {
        fn new() -> Self {
            Self {
                server: FakeReleaseServer::start(),
                root: ScratchRoot::new(),
            }
        }

        fn install_dir(&self) -> PathBuf {
            self.root.0.join(CANARY_VERSION)
        }

        fn release_at(&self, base_url: String) -> Release<'static> {
            Release {
                version: CANARY_VERSION,
                platform: TEST_PLATFORM,
                base_url,
                retry_delay: Duration::ZERO,
            }
        }

        fn release(&self) -> Release<'static> {
            self.release_at(self.server.base_url())
        }

        fn asset(&self) -> String {
            asset_name(CANARY_VERSION, TEST_PLATFORM)
        }

        /// Publish an archive whose binary holds `binary_body`; returns its digest.
        fn publish(&self, binary_body: &str) -> String {
            let archive = archive_with_binary(binary_body);
            let manifest = manifest_listing(&self.asset(), &archive);
            let digest = sha256_hex(&archive);
            self.server.serve(&format!("/{}", self.asset()), archive);
            self.server.serve("/SHA256SUMS", manifest.into_bytes());
            digest
        }

        fn start(&self) -> Result<CanaryStart, String> {
            ensure_canary_current(&self.release(), &self.install_dir())
        }

        fn installed_binary_body(&self) -> String {
            fs::read_to_string(self.install_dir().join(BINARY_NAME))
                .expect("expected an installed binary")
        }

        fn recorded_digest(&self) -> Option<String> {
            fs::read_to_string(self.install_dir().join(ARCHIVE_DIGEST_MARKER))
                .ok()
                .map(|recorded| recorded.trim().to_string())
        }

        fn archive_requests(&self) -> usize {
            self.server.request_count(&format!("/{}", self.asset()))
        }
    }

    #[test]
    fn canary_start_without_an_install_downloads_and_records_the_archive_digest() {
        let fixture = CanaryFixture::new();
        let digest = fixture.publish("binary one");

        let outcome = fixture.start();

        assert_eq!(outcome, Ok(CanaryStart::Installed));
        assert_eq!(fixture.installed_binary_body(), "binary one");
        assert_eq!(fixture.recorded_digest(), Some(digest));
    }

    #[test]
    fn canary_start_with_an_unchanged_release_makes_one_small_request_and_no_download() {
        let fixture = CanaryFixture::new();
        fixture.publish("binary one");
        assert_eq!(fixture.start(), Ok(CanaryStart::Installed));
        fixture.server.forget_requests();

        let outcome = fixture.start();

        assert_eq!(outcome, Ok(CanaryStart::Current));
        assert_eq!(
            fixture.server.requests(),
            vec!["GET /SHA256SUMS".to_string()],
            "expected exactly one request, for SHA256SUMS | received {:?}",
            fixture.server.requests()
        );
    }

    #[test]
    fn canary_start_after_the_published_archive_changed_downloads_it_once_and_updates_the_marker() {
        let fixture = CanaryFixture::new();
        fixture.publish("binary one");
        assert_eq!(fixture.start(), Ok(CanaryStart::Installed));
        let new_digest = fixture.publish("binary two");
        fixture.server.forget_requests();

        let outcome = fixture.start();

        assert_eq!(outcome, Ok(CanaryStart::Installed));
        assert_eq!(fixture.archive_requests(), 1);
        assert_eq!(fixture.server.request_count("/SHA256SUMS"), 1);
        assert_eq!(fixture.installed_binary_body(), "binary two");
        assert_eq!(fixture.recorded_digest(), Some(new_digest));
    }

    #[test]
    fn canary_install_without_a_marker_is_refreshed_once_and_then_trusted() {
        let fixture = CanaryFixture::new();
        let digest = fixture.publish("binary one");
        // An install laid down by the shell installer, or by a launcher from
        // before the marker existed: binary present, nothing recorded.
        fs::create_dir_all(fixture.install_dir()).expect("expected the install dir");
        fs::write(fixture.install_dir().join(BINARY_NAME), "unrecorded binary")
            .expect("expected the unrecorded binary");

        assert_eq!(fixture.start(), Ok(CanaryStart::Installed));
        assert_eq!(fixture.recorded_digest(), Some(digest));
        fixture.server.forget_requests();
        assert_eq!(fixture.start(), Ok(CanaryStart::Current));
        assert_eq!(fixture.archive_requests(), 0);
    }

    #[test]
    fn canary_marker_beside_a_missing_binary_does_not_count_as_current() {
        let fixture = CanaryFixture::new();
        let digest = fixture.publish("binary one");
        fs::create_dir_all(fixture.install_dir()).expect("expected the install dir");
        fs::write(
            fixture.install_dir().join(ARCHIVE_DIGEST_MARKER),
            format!("{digest}\n"),
        )
        .expect("expected the marker");

        assert_eq!(fixture.start(), Ok(CanaryStart::Installed));
        assert_eq!(fixture.installed_binary_body(), "binary one");
    }

    #[test]
    fn canary_start_offline_with_an_install_keeps_it_and_names_the_failed_check() {
        let fixture = CanaryFixture::new();
        let digest = fixture.publish("binary one");
        assert_eq!(fixture.start(), Ok(CanaryStart::Installed));

        let outcome = ensure_canary_current(
            &fixture.release_at(unreachable_base_url()),
            &fixture.install_dir(),
        );

        assert!(
            matches!(&outcome, Ok(CanaryStart::KeptInstalled { reason }) if reason.contains("cannot check for a newer canary build")),
            "expected KeptInstalled naming the failed check | received {outcome:?}"
        );
        assert_eq!(fixture.installed_binary_body(), "binary one");
        assert_eq!(fixture.recorded_digest(), Some(digest));
    }

    #[test]
    fn canary_start_offline_without_an_install_fails_as_a_first_install_does() {
        let fixture = CanaryFixture::new();

        let outcome = ensure_canary_current(
            &fixture.release_at(unreachable_base_url()),
            &fixture.install_dir(),
        );

        assert!(
            matches!(&outcome, Err(message) if message.contains("cannot download")),
            "expected a download failure | received {outcome:?}"
        );
        assert!(!fixture.install_dir().exists());
    }

    #[test]
    fn canary_start_with_a_pruned_release_keeps_the_installed_build() {
        let fixture = CanaryFixture::new();
        fixture.publish("binary one");
        assert_eq!(fixture.start(), Ok(CanaryStart::Installed));
        // A pruned canary release answers 404 for every asset.
        fixture.server.serve_status("/SHA256SUMS", 404);

        let outcome = fixture.start();

        assert!(
            matches!(&outcome, Ok(CanaryStart::KeptInstalled { reason }) if reason.contains("404")),
            "expected KeptInstalled citing the 404 | received {outcome:?}"
        );
        assert_eq!(fixture.installed_binary_body(), "binary one");
    }

    #[test]
    fn canary_start_with_a_manifest_that_omits_the_archive_keeps_the_installed_build() {
        let fixture = CanaryFixture::new();
        fixture.publish("binary one");
        assert_eq!(fixture.start(), Ok(CanaryStart::Installed));
        fixture.server.serve(
            "/SHA256SUMS",
            format!("{}  unrelated-asset.bin\n", "0".repeat(64)).into_bytes(),
        );
        fixture.server.forget_requests();

        let outcome = fixture.start();

        assert!(
            matches!(&outcome, Ok(CanaryStart::KeptInstalled { reason }) if reason.contains("does not list")),
            "expected KeptInstalled citing the missing entry | received {outcome:?}"
        );
        assert_eq!(fixture.archive_requests(), 0);
    }

    #[test]
    fn canary_archive_that_fails_its_checksum_fails_the_start_and_keeps_the_previous_install() {
        let fixture = CanaryFixture::new();
        let digest = fixture.publish("binary one");
        assert_eq!(fixture.start(), Ok(CanaryStart::Installed));
        // The manifest announces a new archive; the host serves other bytes.
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
        assert_eq!(fixture.installed_binary_body(), "binary one");
        assert_eq!(fixture.recorded_digest(), Some(digest));
    }

    #[test]
    fn canary_unpack_failure_leaves_no_install_and_no_marker() {
        let fixture = CanaryFixture::new();
        // Verified bytes that are not an archive: the checksum passes, the
        // unpack dies half way, which is the crash a marker must not survive.
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
            matches!(&outcome, Err(message) if message.contains("cannot unpack archive")),
            "expected an unpack failure | received {outcome:?}"
        );
        assert!(
            !fixture.install_dir().exists(),
            "expected no install directory after a failed unpack | received {:?}",
            fixture.install_dir()
        );
        assert_eq!(fixture.recorded_digest(), None);
    }

    #[test]
    fn canary_start_clears_staging_left_by_a_crashed_install() {
        let fixture = CanaryFixture::new();
        fixture.publish("binary one");
        let leftover = fixture
            .root
            .0
            .join(format!(".install-{CANARY_VERSION}.{}", std::process::id()));
        fs::create_dir_all(&leftover).expect("expected the leftover staging dir");
        fs::write(leftover.join(BINARY_NAME), "half written").expect("expected a leftover file");
        fs::write(leftover.join(ARCHIVE_DIGEST_MARKER), "stale\n").expect("expected a marker");

        assert_eq!(fixture.start(), Ok(CanaryStart::Installed));

        assert_eq!(fixture.installed_binary_body(), "binary one");
        assert!(!leftover.exists());
    }

    #[test]
    fn two_canary_starts_racing_an_empty_install_download_the_archive_once() {
        let fixture = CanaryFixture::new();
        fixture.publish("binary one");
        // Hold the archive back so both starts are inside the install at once.
        let archive = archive_with_binary("binary one");
        fixture.server.serve_slowly(
            &format!("/{}", fixture.asset()),
            archive,
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
            outcomes.contains(&Ok(CanaryStart::Installed)),
            "{outcomes:?}"
        );
        assert!(outcomes.contains(&Ok(CanaryStart::Current)), "{outcomes:?}");
        assert_eq!(fixture.installed_binary_body(), "binary one");
    }

    #[cfg(unix)]
    #[test]
    fn canary_refresh_leaves_a_running_hub_process_alive() {
        let fixture = CanaryFixture::new();
        fixture.publish("#!/bin/sh\nexec sleep 30\n");
        assert_eq!(fixture.start(), Ok(CanaryStart::Installed));
        let mut running_hub = Command::new(fixture.install_dir().join(BINARY_NAME))
            .spawn()
            .expect("expected the installed canary binary to start");
        fixture.publish("#!/bin/sh\necho second build\n");

        let outcome = fixture.start();
        let still_running = running_hub
            .try_wait()
            .expect("expected to poll the running hub")
            .is_none();
        let _ = running_hub.kill();
        let _ = running_hub.wait();

        assert_eq!(outcome, Ok(CanaryStart::Installed));
        assert!(
            still_running,
            "expected the hub started from the old build to survive the refresh | received an exit"
        );
        assert_eq!(
            fixture.installed_binary_body(),
            "#!/bin/sh\necho second build\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn canary_refresh_that_cannot_move_the_install_aside_keeps_it_and_says_so() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = CanaryFixture::new();
        fixture.publish("binary one");
        assert_eq!(fixture.start(), Ok(CanaryStart::Installed));
        fixture.publish("binary two");
        // Block the move-aside target: a non-empty directory the launcher
        // cannot clear, the way a held-open directory blocks a Windows rename.
        let blocker = fixture
            .root
            .0
            .join(format!(".rollback-{CANARY_VERSION}.{}", std::process::id()));
        fs::create_dir_all(blocker.join("held")).expect("expected the blocking directory");
        fs::write(blocker.join("held/file"), "x").expect("expected a file inside the blocker");
        fs::set_permissions(blocker.join("held"), fs::Permissions::from_mode(0o555))
            .expect("expected the blocker to turn read-only");
        let blocker_holds = fs::write(blocker.join("held/probe"), "x").is_err();

        let outcome = fixture.start();

        fs::set_permissions(blocker.join("held"), fs::Permissions::from_mode(0o755))
            .expect("expected the blocker to become removable again");
        if !blocker_holds {
            // Running as root: permissions do not block anything, so the
            // premise of this test does not exist.
            return;
        }
        assert!(
            matches!(&outcome, Ok(CanaryStart::KeptInstalled { reason }) if reason.contains("in use")),
            "expected KeptInstalled citing the install in use | received {outcome:?}"
        );
        assert_eq!(fixture.installed_binary_body(), "binary one");
        let staging = fixture
            .root
            .0
            .join(format!(".install-{CANARY_VERSION}.{}", std::process::id()));
        assert!(
            !staging.exists(),
            "expected the staging dir to be cleaned up"
        );
    }

    #[test]
    fn stable_install_records_no_digest_marker() {
        let server = FakeReleaseServer::start();
        let root = ScratchRoot::new();
        let release = Release {
            version: "0.0.0",
            platform: TEST_PLATFORM,
            base_url: server.base_url(),
            retry_delay: Duration::ZERO,
        };
        let asset = release.asset();
        let archive = archive_with_binary("stable binary");
        server.serve(
            "/SHA256SUMS",
            manifest_listing(&asset, &archive).into_bytes(),
        );
        server.serve(&format!("/{asset}"), archive);
        let install_dir = root.0.join("0.0.0");

        install(&release, &install_dir).expect("expected the stable install to succeed");

        assert_eq!(
            fs::read_to_string(install_dir.join(BINARY_NAME))
                .ok()
                .as_deref(),
            Some("stable binary")
        );
        assert!(
            !install_dir.join(ARCHIVE_DIGEST_MARKER).exists(),
            "expected a stable install to carry no digest marker"
        );
    }
}
