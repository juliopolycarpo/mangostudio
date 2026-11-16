//! Process-level pins for a launcher start, run against the real launcher
//! binary and a fake release host. A release never changes under its version,
//! so once installed a start makes no request at all; and two launchers
//! starting together on an empty install download the archive once.

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
use std::time::Duration;

const LAUNCHER_VERSION: &str = env!("CARGO_PKG_VERSION");
const HUB_SCRIPT: &str = "#!/bin/sh\necho stable hub \"$@\"\n";

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

/// A launcher invocation with every proxy variable removed: the fake host is a
/// loopback address and a developer's `HTTP_PROXY` would route around it.
fn launcher_command(install_root: &Path, base_url: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_mangostudio"));
    command
        .env("MANGOSTUDIO_INSTALL_DIR", install_root)
        .env("MANGOSTUDIO_DIST_URL", base_url)
        .arg("serve");
    for variable in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        command.env_remove(variable);
    }
    command
}

fn start_launcher(install_root: &Path, base_url: &str) -> Output {
    launcher_command(install_root, base_url)
        .output()
        .expect("expected the launcher binary to run")
}

fn scratch_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("mangostudio-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("expected a fresh scratch install root");
    root
}

fn publish_hub(server: &FakeReleaseServer) -> String {
    let asset = format!(
        "mangostudio-{LAUNCHER_VERSION}-{}.tar.gz",
        host_platform_id()
    );
    let archive = archive_with_binary(HUB_SCRIPT);
    server.serve(
        "/SHA256SUMS",
        manifest_listing(&asset, &archive).into_bytes(),
    );
    server.serve(&format!("/{asset}"), archive);
    asset
}

fn stdout_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[test]
fn launcher_installs_once_then_starts_without_any_request() {
    let server = FakeReleaseServer::start();
    let asset = publish_hub(&server);
    let root = scratch_root("stable-start");

    let first = start_launcher(&root, &server.base_url());
    let requests_after_first = server.requests();
    let second = start_launcher(&root, &server.base_url());

    assert_eq!(
        stdout_of(&first),
        "stable hub serve\n",
        "expected the first start to exec the unpacked binary with its arguments | received {:?} (stderr {:?})",
        stdout_of(&first),
        String::from_utf8_lossy(&first.stderr)
    );
    assert_eq!(
        requests_after_first,
        vec!["GET /SHA256SUMS".to_string(), format!("GET /{asset}")],
        "expected one manifest and one archive request for the first start"
    );
    assert_eq!(
        stdout_of(&second),
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
        .expect("expected the install directory")
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
        vec![
            ".launcher-record".to_string(),
            "README.md".to_string(),
            "mangostudio".to_string()
        ],
        "expected the install to hold the archive's files and the launcher's record"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn an_install_made_by_the_install_scripts_starts_without_any_request() {
    let server = FakeReleaseServer::start();
    publish_hub(&server);
    let root = scratch_root("script-installed");
    // The shell installer unpacks the archive as is: no launcher record.
    let install_dir = root.join(LAUNCHER_VERSION);
    fs::create_dir_all(&install_dir).expect("expected the install directory");
    let binary = install_dir.join("mangostudio");
    fs::write(&binary, "#!/bin/sh\necho script-installed hub\n").expect("expected the binary");
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755))
            .expect("expected the binary to be executable");
    }

    let output = start_launcher(&root, &server.base_url());

    assert_eq!(
        stdout_of(&output),
        "script-installed hub\n",
        "expected the existing install to run | received {:?} (stderr {:?})",
        stdout_of(&output),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        server.requests(),
        Vec::<String>::new(),
        "expected no request for an install the scripts made"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn two_launchers_starting_on_an_empty_install_download_the_archive_once() {
    let server = FakeReleaseServer::start();
    let asset = publish_hub(&server);
    // Hold the archive back so both processes are inside the install together.
    server.serve_slowly(
        &format!("/{asset}"),
        archive_with_binary(HUB_SCRIPT),
        Duration::from_millis(600),
    );
    let root = scratch_root("two-launchers");

    let mut first = launcher_command(&root, &server.base_url());
    let mut second = launcher_command(&root, &server.base_url());
    let first_child = first
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("expected the first launcher to start");
    let second_child = second
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("expected the second launcher to start");
    let first_output = first_child
        .wait_with_output()
        .expect("expected the first launcher to finish");
    let second_output = second_child
        .wait_with_output()
        .expect("expected the second launcher to finish");

    for (name, output) in [("first", &first_output), ("second", &second_output)] {
        assert_eq!(
            stdout_of(output),
            "stable hub serve\n",
            "expected the {name} launcher to exec the installed binary | received {:?} (stderr {:?})",
            stdout_of(output),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert_eq!(
        server.request_count(&format!("/{asset}")),
        1,
        "expected one archive download for two racing launchers | received {:?}",
        server.requests()
    );
    let _ = fs::remove_dir_all(&root);
}
