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

const FORWARDED: [(&str, &str); 7] = [
    ("XDG_CONFIG_HOME", "/home/synthetic/.config-elsewhere"),
    ("XDG_DATA_HOME", "/home/synthetic/.data-elsewhere"),
    ("XDG_STATE_HOME", "/home/synthetic/.state-elsewhere"),
    ("XDG_CACHE_HOME", "/home/synthetic/.cache-elsewhere"),
    ("APPDATA", r"D:\Users\synthetic\Roaming"),
    ("LOCALAPPDATA", r"D:\Users\synthetic\Local"),
    ("CURSOR_CONFIG_DIR", "/home/synthetic/.cursor-elsewhere"),
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

/// A Linux machine whose process environment holds `pairs` beside a `PATH`.
fn machine_environment(pairs: &[(&str, &str)]) -> PathEnv {
    PathEnv {
        platform: "linux".into(),
        home_dir: "/home/synthetic".into(),
        env: pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .chain([("PATH".to_owned(), "/usr/bin".to_owned())])
            .collect::<HashMap<_, _>>(),
    }
}

#[tokio::test]
async fn a_cursor_child_reads_the_users_config_location_and_never_a_credential() {
    let launcher = Arc::new(FakeLauncher::new());
    launcher.push(FakeAcpAgent::new().process());
    let rig = Rig::with_environment(
        launcher.clone(),
        wire::TargetId::Cursor,
        fixtures::limits(),
        machine_environment(&[FORWARDED, WITHHELD].concat()),
    )
    .await;
    rig.open().await;

    let launches = launcher.launches();
    let [launch] = launches.as_slice() else {
        panic!(
            "expected one Cursor launch | received {} launches",
            launches.len()
        );
    };
    for (key, value) in FORWARDED {
        let received = launch.env.get(key).map(String::as_str);
        assert_eq!(
            received,
            Some(value),
            "expected {key} forwarded to the Cursor child | received {received:?}"
        );
    }
    for (key, _) in WITHHELD {
        assert!(
            !launch.env.contains_key(key),
            "expected {key} withheld from the Cursor child | received it in the launch environment"
        );
    }
    rig.close().await;
    fixtures::reaped(&launcher).await;
}
