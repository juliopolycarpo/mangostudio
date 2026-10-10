//! Every site that reports the runtime's release reports the one it was handed, not the package
//! version.
//!
//! The shipped binary is stamped at compile time and no CI lane stamps the Rust tests, so the
//! tests of the real binary (`cli`, `transport_stdio_spawned`, `update_supervised_restart`)
//! compare the package version with itself: an edit that passed `CARGO_PKG_VERSION` to one site
//! would keep them green. These tests run the same library entry point through
//! `tests/fixtures/injected_version_runtime.rs`, which reports a version chosen at run time, one no
//! manifest carries, so a site that ignores what it was handed fails here with the site's name and
//! both versions, in an unstamped build.
//!
//! The fixture is the `injected-version-runtime` binary target, built when the
//! `injected-version-fixture` feature is on (every lane passes `--all-features`); a run that
//! selects this test target by hand needs `--features injected-version-fixture`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use mango_protocol::close::close_codes;
use mango_protocol::session::{Session, SessionOptions};
use mango_protocol::transports::spawn::{SpawnOptions, sanitized_env, spawn_port};

use super::cli::{assert_all_report, borrowed, runtime_version_of};
use super::update_supervised_restart::{
    RuntimeProcess, accept_runtime_dial, dial, free_port, reported_versions,
};
use crate::support::scratch::scratch_path;

/// The version every test hands the runtime: one no manifest carries.
const INJECTED: &str = "9.8.7-injected";

/// The variable `tests/fixtures/injected_version_runtime.rs` reads its version from.
const INJECTED_VERSION_VARIABLE: &str = "MANGOSTUDIO_TEST_INJECTED_VERSION";

/// Where cargo built the fixture, or a failure saying how to build it.
fn fixture_path() -> PathBuf {
    let Some(path) = option_env!("CARGO_BIN_EXE_injected-version-runtime") else {
        panic!(
            "expected the injected-version fixture binary | received: not built; pass `--features \
             injected-version-fixture` (every lane passes `--all-features`)"
        );
    };
    PathBuf::from(path)
}

/// A fresh `MANGO_HOME` for `name`.
fn scratch_home(name: &str) -> crate::support::scratch::ScratchDir {
    scratch_path(&format!("injected-version-{name}"))
}

/// Runs the fixture with `args` against `home` and returns its stdout, failing with its stderr
/// when it exits non-zero.
fn run_fixture(home: &Path, args: &[&str]) -> String {
    let output = Command::new(fixture_path())
        .args(args)
        .env("MANGO_HOME", home)
        .env(INJECTED_VERSION_VARIABLE, INJECTED)
        .stdin(std::process::Stdio::null())
        .output()
        .expect("the fixture runs");
    assert!(
        output.status.success(),
        "expected `{}` exit: success | received: {} with stderr {}",
        args.join(" "),
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("utf8 stdout")
}

/// `run_fixture` parsed as one JSON document.
fn run_fixture_json(home: &Path, args: &[&str]) -> serde_json::Value {
    let stdout = run_fixture(home, args);
    serde_json::from_str(&stdout).unwrap_or_else(|error| {
        panic!(
            "expected `{}` to print JSON | received: {stdout:?} ({error})",
            args.join(" ")
        )
    })
}

/// The `version` the slot's `runtime.json` records.
fn recorded_version(home: &Path, slot: &str) -> String {
    let path = home.join("runtime").join(slot).join("runtime.json");
    let written = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("expected {} to exist | received: {error}", path.display()));
    let stored: serde_json::Value = serde_json::from_str(&written).expect("runtime.json is JSON");
    stored["version"].as_str().unwrap_or("<missing>").to_owned()
}

#[test]
fn the_one_shot_commands_report_the_injected_version() {
    let home = scratch_home("one-shot");
    let version = run_fixture(&home, &["--version"]);
    let help = run_fixture(&home, &["--help"]);
    let header = help.lines().next().unwrap_or_default();
    let setup = run_fixture_json(
        &home,
        &["setup", "--profile", "readonly", "--yes", "--json"],
    );
    let health_text = run_fixture(&home, &["health"]);
    let health_line = health_text
        .lines()
        .find_map(|line| line.strip_prefix("version "))
        .map_or("<no version line>", str::trim);
    let health = run_fixture_json(&home, &["health", "--json"]);
    let doctor = run_fixture_json(&home, &["doctor", "--json"]);
    let installed = run_fixture_json(&home, &["install", "--slot", "host", "--json"]);

    assert_all_report(
        INJECTED,
        &[
            ("--version", version.trim()),
            (
                "--help header",
                header
                    .strip_prefix("mangostudio-runtime ")
                    .unwrap_or(header),
            ),
            ("setup --json runtimeVersion", &runtime_version_of(&setup)),
            ("health version line", health_line),
            ("health --json runtimeVersion", &runtime_version_of(&health)),
            (
                "doctor --json health.runtimeVersion",
                &runtime_version_of(&doctor["health"]),
            ),
            (
                "install --json version",
                installed["version"].as_str().unwrap_or("<missing>"),
            ),
            (
                "install-recorded config version",
                &recorded_version(&home, "host"),
            ),
        ],
    );
}

#[tokio::test]
async fn a_stdio_runtime_reports_the_injected_version_in_its_hello_and_health() {
    let home = scratch_home("stdio");
    let env = sanitized_env([
        (
            "MANGO_HOME".to_string(),
            home.to_string_lossy().into_owned(),
        ),
        (INJECTED_VERSION_VARIABLE.to_string(), INJECTED.to_string()),
    ]);
    let program = fixture_path().to_string_lossy().into_owned();
    let options = SpawnOptions::new([program, "stdio".to_string()]).with_env(env);
    let (port, _launched) = spawn_port(options).expect("the argv names a real binary");

    let (session, driver) = Session::spawn(port, SessionOptions::new(crate::support::peer("hub")));
    let reports = tokio::time::timeout(
        Duration::from_secs(10),
        reported_versions("stdio", &session),
    )
    .await
    .expect("the child must answer hello and health within the timeout");
    session
        .close(close_codes::RELEASED, Some("test done"))
        .await;
    let _ = driver.await;

    assert_all_report(INJECTED, &borrowed(&reports));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_serve_runtime_reports_the_injected_version_and_records_it_with_its_consent() {
    let home = scratch_home("serve");
    let port = free_port();
    let listen = format!("127.0.0.1:{port}");
    let serve = RuntimeProcess::spawn(
        &fixture_path(),
        &home,
        &["serve", "--listen", &listen, "--token", "env"],
        "MANGOSTUDIO_RUNTIME_SERVE_TOKEN",
        &[(INJECTED_VERSION_VARIABLE, INJECTED)],
    );

    let session = dial(port, &serve).await;
    let mut reports = reported_versions("serve", &session).await;
    reports.push((
        "serve consent-recorded version".to_string(),
        recorded_version(&home, "remote"),
    ));

    assert_all_report(INJECTED, &borrowed(&reports));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connect_runtime_reports_the_injected_version_and_records_it_with_its_consent() {
    let home = scratch_home("connect");
    let hub = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("the fake hub binds loopback");
    let hub_url = format!("ws://{}/", hub.local_addr().expect("bound address"));
    let connect = RuntimeProcess::spawn(
        &fixture_path(),
        &home,
        &["connect", "--hub", &hub_url, "--token", "env"],
        "MANGOSTUDIO_RUNTIME_TOKEN",
        &[(INJECTED_VERSION_VARIABLE, INJECTED)],
    );

    let session = accept_runtime_dial(&hub, &hub_url, &connect).await;
    let mut reports = reported_versions("connect", &session).await;
    reports.push((
        "connect consent-recorded version".to_string(),
        recorded_version(&home, "remote"),
    ));

    assert_all_report(INJECTED, &borrowed(&reports));
}
