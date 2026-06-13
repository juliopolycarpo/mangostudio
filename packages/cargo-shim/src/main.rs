//! Thin launcher for MangoStudio, published to crates.io.
//!
//! The product is a Bun-compiled binary distributed via GitHub Releases
//! together with its `public/` frontend sidecar; this crate is not the app
//! source. On first run the launcher downloads the platform archive matching
//! the crate version into `~/.mango/dist/<version>/` (checksum-verified, the
//! same layout the shell installer uses), then hands over to the real binary
//! with arguments and environment untouched.

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
/// Hard cap for downloads; the largest platform archive is well under this.
const MAX_DOWNLOAD_BYTES: u64 = 1024 * 1024 * 1024;

fn main() {
    if let Err(message) = run() {
        eprintln!("mangostudio launcher: {message}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let install_dir = install_root()?.join(VERSION);
    let binary_path = install_dir.join(BINARY_NAME);
    if !binary_path.is_file() {
        install(&install_dir)?;
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

fn asset_name(platform: &str) -> String {
    format!("mangostudio-{VERSION}-{platform}.{ARCHIVE_EXTENSION}")
}

fn install(install_dir: &Path) -> Result<(), String> {
    let platform = platform_id()?;
    let asset = asset_name(platform);
    let base_url = dist_base_url();

    eprintln!("Downloading MangoStudio {VERSION} for {platform}...");
    let manifest = String::from_utf8(download(&format!("{base_url}/SHA256SUMS"))?)
        .map_err(|_| "SHA256SUMS is not valid UTF-8".to_string())?;
    let archive = download(&format!("{base_url}/{asset}"))?;

    let expected = expected_checksum(&manifest, &asset)?;
    let actual = sha256_hex(&archive);
    if expected != actual {
        return Err(format!(
            "checksum mismatch for {asset}: expected {expected}, got {actual}"
        ));
    }
    eprintln!("Checksum verified: {asset}");

    let install_root = install_dir
        .parent()
        .ok_or_else(|| format!("install dir {} has no parent", install_dir.display()))?;
    fs::create_dir_all(install_root)
        .map_err(|error| format!("cannot create {}: {error}", install_root.display()))?;

    // Unpack into a staging dir and rename into place so a crash mid-unpack
    // never leaves a half-written version directory that later runs trust.
    let staging = install_root.join(format!(".install-{VERSION}.{}", std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    unpack(&archive, &staging)?;

    let staged_binary = staging.join(BINARY_NAME);
    if !staged_binary.is_file() {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("archive is missing {BINARY_NAME}"));
    }
    // The binary serves its UI from the sibling `public/` sidecar, so reject an
    // archive that dropped it instead of installing a binary that fails later.
    // Mirrors the shell installer's `public/index.html` check.
    if !staging.join("public").join("index.html").is_file() {
        let _ = fs::remove_dir_all(&staging);
        return Err("archive is missing public/index.html".to_string());
    }
    make_executable(&staged_binary)?;

    let _ = fs::remove_dir_all(install_dir);
    if let Err(error) = fs::rename(&staging, install_dir) {
        let _ = fs::remove_dir_all(&staging);
        // A concurrent launcher may have completed the same install first.
        if !install_dir.join(BINARY_NAME).is_file() {
            return Err(format!(
                "cannot move install into {}: {error}",
                install_dir.display()
            ));
        }
    }
    eprintln!(
        "Installed MangoStudio {VERSION} to {}",
        install_dir.display()
    );
    Ok(())
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    let mut delay = Duration::from_secs(2);
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

/// Replace this process with the real binary (Unix) or spawn it and forward
/// the exit code (Windows).
#[cfg(unix)]
fn run_binary(binary: &Path) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let error = Command::new(binary).args(env::args_os().skip(1)).exec();
    Err(format!("cannot exec {}: {error}", binary.display()))
}

#[cfg(windows)]
fn run_binary(binary: &Path) -> Result<(), String> {
    let status = Command::new(binary)
        .args(env::args_os().skip(1))
        .status()
        .map_err(|error| format!("cannot run {}: {error}", binary.display()))?;
    std::process::exit(status.code().unwrap_or(1));
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHECKSUM_FIXTURE: &str = include_str!("../../../scripts/tests/support/SHA256SUMS.sample");

    #[test]
    fn platform_id_maps_the_test_host_to_a_release_asset() {
        let id = platform_id().expect("test host is a supported release platform");
        assert!(asset_name(id).starts_with(&format!("mangostudio-{VERSION}-")));
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
}
