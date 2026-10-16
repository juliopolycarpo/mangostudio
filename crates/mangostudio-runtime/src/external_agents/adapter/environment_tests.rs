//! What reaches a vendor child from the runtime's environment, observed at the launcher.
//!
//! The runtime hands the SDK its whole environment snapshot and the SDK forwards only its
//! allowlist. Since SDK 0.7.1 that allowlist carries the XDG base directories and each ACP
//! profile's documented home variable, so `cursor-agent` reads the account the user configured
//! instead of the default location's. Credentials still never cross.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use mango_agent_acp::testing::FakeAcpAgent;
use mango_external_agents::testing::FakeLauncher;

use super::backend::{Backend, ProductHarnesses};
use super::test_support as fixtures;
use crate::commands::toolchain::{self, NativeToolchainFs};
use crate::external_agents::port::AgentBackend;
use crate::external_agents::wire;
use crate::probing::detection::path_env::PathEnv;
use crate::test_support::ScratchDir;

const FORWARDED: [(&str, &str); 3] = [
    ("XDG_CONFIG_HOME", "/home/synthetic/.config-elsewhere"),
    ("XDG_DATA_HOME", "/home/synthetic/.data-elsewhere"),
    ("CURSOR_CONFIG_DIR", "/home/synthetic/.cursor-elsewhere"),
];
const WITHHELD: [(&str, &str); 3] = [
    ("XDG_RUNTIME_DIR", "/run/user/1000"),
    ("GITHUB_TOKEN", "ghp_synthetic_never_forwarded"),
    ("OPENAI_API_KEY", "sk-synthetic-never-forwarded"),
];

/// The environment the supervisor builds for a host, from a runtime snapshot holding `pairs`.
fn runtime_environment(pairs: &[(&str, &str)]) -> std::collections::BTreeMap<String, String> {
    let snapshot = PathEnv {
        platform: "linux".into(),
        home_dir: "/home/synthetic".into(),
        env: pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .chain([("PATH".to_owned(), "/usr/bin".to_owned())])
            .collect::<HashMap<_, _>>(),
    };
    toolchain::build(&snapshot, None, &NativeToolchainFs)
}

#[tokio::test]
async fn a_cursor_child_reads_the_users_config_location_and_never_a_credential() {
    let launcher = Arc::new(FakeLauncher::new());
    launcher.push(FakeAcpAgent::new().process());
    let backend = Backend::new(
        launcher.clone(),
        Arc::new(ProductHarnesses),
        fixtures::limits(),
        Duration::from_secs(2),
    );
    let workspace = ScratchDir::created("acp-environment-workspace");
    let mut host = fixtures::host(workspace.path().to_path_buf());
    host.environment = runtime_environment(&[FORWARDED, WITHHELD].concat());
    let params = wire::OpenParams {
        session_id: "environment-open".into(),
        target_id: wire::TargetId::Cursor,
        workspace_path: workspace.path().to_string_lossy().into_owned(),
        configuration: fixtures::configuration(),
        resume_ref: None,
        resume_mode: wire::ResumeMode::Fallback,
        timeout_ms: 5_000,
        toolchain: None,
    };
    let opened = backend
        .open(
            wire::TargetId::Cursor,
            "/synthetic/cursor".into(),
            host,
            &params,
        )
        .await;
    assert!(
        opened.is_ok(),
        "expected the fake Cursor agent to open | received an open failure"
    );

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
}
