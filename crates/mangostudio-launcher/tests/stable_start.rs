//! Process-level pins for a stable launcher start, run against the real
//! launcher binary and a fake release host. A stable release never changes
//! under its version, so once installed a start makes no request at all, and
//! the install directory holds exactly what the archive carried.

#![cfg(unix)]

#[path = "support/fake_release_server.rs"]
#[allow(dead_code)]
mod fake_release_server;
#[path = "support/release_archive.rs"]
#[allow(dead_code)]
mod release_archive;

use fake_release_server::FakeReleaseServer;
use release_archive::{archive_with_binary, manifest_listing};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const LAUNCHER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The release platform id of this test host, as the launcher maps it.
fn host_platform_id() -> &'static str {
    match (
        std::env::consts::OS,
        std::env::consts::ARCH,
        cfg!(target_env = "musl"),
    ) {
        ("linux", "x86_64", false) => "linux-x64",
        ("linux", "x86_64", true) => "linux-x64-musl",
        ("linux", "aarch64", false) => "linux-arm64",
        ("linux", "aarch64", true) => "linux-arm64-musl",
        ("macos", "x86_64", _) => "darwin-x64",
        ("macos", "aarch64", _) => "darwin-arm64",
        (os, arch, _) => panic!("unsupported test host {os}-{arch}"),
    }
}

fn start_launcher(install_root: &Path, base_url: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_mangostudio"))
        .env("MANGOSTUDIO_INSTALL_DIR", install_root)
        .env("MANGOSTUDIO_DIST_URL", base_url)
        .arg("serve")
        .output()
        .expect("expected the launcher binary to run")
}

fn scratch_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("mangostudio-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("expected a fresh scratch install root");
    root
}

#[test]
fn stable_launcher_installs_once_then_starts_without_any_request() {
    let server = FakeReleaseServer::start();
    let asset = format!(
        "mangostudio-{LAUNCHER_VERSION}-{}.tar.gz",
        host_platform_id()
    );
    let archive = archive_with_binary("#!/bin/sh\necho stable hub \"$@\"\n");
    server.serve(
        "/SHA256SUMS",
        manifest_listing(&asset, &archive).into_bytes(),
    );
    server.serve(&format!("/{asset}"), archive);
    let root = scratch_root("stable-start");

    let first = start_launcher(&root, &server.base_url());
    let requests_after_first = server.requests();
    let second = start_launcher(&root, &server.base_url());

    let first_stdout = String::from_utf8_lossy(&first.stdout).into_owned();
    assert_eq!(
        first_stdout,
        "stable hub serve\n",
        "expected the first start to exec the unpacked binary with its arguments | received {first_stdout:?} (stderr {:?})",
        String::from_utf8_lossy(&first.stderr)
    );
    assert_eq!(
        requests_after_first,
        vec!["GET /SHA256SUMS".to_string(), format!("GET /{asset}"),],
        "expected one manifest and one archive request for the first start"
    );
    assert_eq!(
        String::from_utf8_lossy(&second.stdout),
        "stable hub serve\n",
        "expected the second start to exec the installed binary"
    );
    assert_eq!(
        server.requests(),
        requests_after_first,
        "expected the second start to make no request | received {:?}",
        server.requests()
    );

    let mut installed: Vec<String> = fs::read_dir(root.join(LAUNCHER_VERSION))
        .expect("expected the stable install directory")
        .map(|entry| {
            entry
                .expect("expected a readable entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    installed.sort();
    assert_eq!(
        installed,
        vec!["README.md".to_string(), "mangostudio".to_string()],
        "expected the stable install to hold only the archive's files"
    );
    let _ = fs::remove_dir_all(&root);
}
