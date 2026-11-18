//! What reaches a vendor child from the runtime's environment, observed at the launcher.
//!
//! The open runs through the supervisor, so the environment it builds from the machine snapshot is
//! the one the child receives.
//!
//! The runtime hands the SDK its whole environment snapshot and the SDK forwards only its
//! allowlist. Since SDK 0.7.1 that allowlist carries the XDG base directories and each ACP
//! profile's documented home variable, so `cursor-agent` reads the account the user configured
//! instead of the default location's. Credentials still never cross.
use std::collections::HashMap;
use std::sync::Arc;

use mango_agent_acp::testing::FakeAcpAgent;
use mango_external_agents::testing::FakeLauncher;

use super::test_support::{self as fixtures, Rig};
use crate::external_agents::wire;
use crate::probing::detection::path_env::PathEnv;

const PORTABLE: [(&str, &str); 6] = [
    ("XDG_CONFIG_HOME", "/home/synthetic/.config-elsewhere"),
    ("XDG_DATA_HOME", "/home/synthetic/.data-elsewhere"),
    ("XDG_STATE_HOME", "/home/synthetic/.state-elsewhere"),
    ("XDG_CACHE_HOME", "/home/synthetic/.cache-elsewhere"),
    ("CURSOR_CONFIG_DIR", "/home/synthetic/.cursor-elsewhere"),
    ("PATH", "/usr/bin"),
];
const WINDOWS_LOCATIONS: [(&str, &str); 2] = [
    ("APPDATA", r"D:\Users\synthetic\Roaming"),
    ("LOCALAPPDATA", r"D:\Users\synthetic\Local"),
];
const WITHHELD: [(&str, &str); 7] = [
    ("XDG_RUNTIME_DIR", "/run/user/1000"),
    ("GITHUB_TOKEN", "ghp_synthetic_never_forwarded"),
    ("OPENAI_API_KEY", "sk-synthetic-never-forwarded"),
    ("CURSOR_API_KEY", "cursor-synthetic-never-forwarded"),
    (
        "CURSOR_AUTH_TOKEN",
        "cursor-token-synthetic-never-forwarded",
    ),
    ("NODE_OPTIONS", "--require=/synthetic/injected.js"),
    (
        "HTTPS_PROXY",
        "http://synthetic:credential@proxy.invalid:8080",
    ),
];

/// A machine on `platform` whose process environment holds `pairs`.
fn machine_environment(platform: &str, pairs: &[(&str, &str)]) -> PathEnv {
    PathEnv {
        platform: platform.into(),
        home_dir: "/home/synthetic".into(),
        env: pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect::<HashMap<_, _>>(),
    }
}

/// Opens a Cursor session on `environment`, then closes it before judging the launch.
///
/// Closing precedes every assertion so a failed expectation cannot leave a live session or an
/// unreaped child behind; the failures come back for the caller to assert on.
async fn cursor_launch_failures(
    environment: PathEnv,
    forwarded: &[(&str, &str)],
    withheld: &[(&str, &str)],
) -> Vec<String> {
    let launcher = Arc::new(FakeLauncher::new());
    launcher.push(FakeAcpAgent::new().process());
    let rig = Rig::with_environment(
        launcher.clone(),
        wire::TargetId::Cursor,
        fixtures::limits(),
        environment,
    )
    .await;
    rig.open().await;
    let launches = launcher.launches();
    rig.close().await;
    fixtures::reaped(&launcher).await;

    let [launch] = launches.as_slice() else {
        return vec![format!(
            "expected one Cursor launch | received {} launches",
            launches.len()
        )];
    };
    let mut failures = Vec::new();
    for (key, value) in forwarded {
        let received = launch.env.get(*key).map(String::as_str);
        if received != Some(*value) {
            failures.push(format!(
                "expected {key} forwarded to the Cursor child as {value:?} | received {received:?}"
            ));
        }
    }
    for (key, _) in withheld {
        if launch.env.contains_key(*key) {
            failures.push(format!(
                "expected {key} withheld from the Cursor child | received it in the launch environment"
            ));
        }
    }
    failures
}

#[tokio::test]
async fn a_cursor_child_reads_the_users_config_location_and_never_a_credential() {
    let environment = machine_environment("linux", &[PORTABLE.as_slice(), &WITHHELD].concat());
    let failures = cursor_launch_failures(environment, &PORTABLE, &WITHHELD).await;
    assert!(failures.is_empty(), "{failures:#?}");
}

#[tokio::test]
async fn a_windows_cursor_child_reads_the_roaming_and_local_locations() {
    let environment = machine_environment(
        "win32",
        &[PORTABLE.as_slice(), &WINDOWS_LOCATIONS, &WITHHELD].concat(),
    );
    let forwarded = [PORTABLE.as_slice(), &WINDOWS_LOCATIONS].concat();
    let failures = cursor_launch_failures(environment, &forwarded, &WITHHELD).await;
    assert!(failures.is_empty(), "{failures:#?}");
}

#[tokio::test]
async fn a_windows_cursor_child_receives_one_path_not_two_aliases() {
    let launcher = Arc::new(FakeLauncher::new());
    launcher.push(FakeAcpAgent::new().process());
    let environment =
        machine_environment("win32", &[("Path", r"C:\stale"), ("PATH", r"C:\canonical")]);
    let rig = Rig::with_environment(
        launcher.clone(),
        wire::TargetId::Cursor,
        fixtures::limits(),
        environment,
    )
    .await;
    rig.open().await;
    let launches = launcher.launches();
    rig.close().await;
    fixtures::reaped(&launcher).await;

    let [launch] = launches.as_slice() else {
        panic!(
            "expected one Cursor launch | received {} launches",
            launches.len()
        );
    };
    let aliases: Vec<_> = launch
        .env
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case("PATH"))
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    assert_eq!(
        aliases,
        [("PATH", r"C:\canonical")],
        "expected only the canonical PATH in the Windows launch environment | received {aliases:?}"
    );
}
