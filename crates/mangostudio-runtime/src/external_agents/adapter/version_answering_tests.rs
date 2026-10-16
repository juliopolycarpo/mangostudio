//! The Codex version probe is answered by the test launcher and never reaches the wrapped one.
use std::collections::BTreeMap;
use std::sync::Arc;

use mango_agent_codex::MINIMUM_CODEX_VERSION;
use mango_agent_codex::discovery::{gate, parse_version};
use mango_external_agents::discovery::GateVerdict;
use mango_external_agents::testing::{FakeLauncher, FakeProcess};
use mango_external_agents::{LaunchSpec, ProcessLauncher};

use super::test_support::VersionAnsweringLauncher;

fn launch(argv: &[&str]) -> LaunchSpec {
    LaunchSpec {
        argv: argv.iter().map(|part| (*part).to_owned()).collect(),
        cwd: std::env::temp_dir(),
        env: BTreeMap::new(),
        stdin: false,
        hide_window: false,
    }
}

#[tokio::test]
async fn a_version_probe_is_answered_at_the_floor_and_not_forwarded() {
    let inner = FakeLauncher::new();
    let launcher = VersionAnsweringLauncher::over(Arc::new(inner.clone()));

    let mut probe = launcher
        .spawn(launch(&["/synthetic/codex", "--version"]))
        .await
        .expect("expected the version probe to be answered");
    let chunk = probe
        .stdout
        .next_chunk()
        .await
        .expect("expected a readable probe answer")
        .expect("expected the probe to print a line");
    let line = String::from_utf8(chunk).expect("expected a UTF-8 probe answer");

    let version = parse_version(&line);
    assert_eq!(
        version.as_deref(),
        Some(MINIMUM_CODEX_VERSION),
        "expected the probe to print the supported floor | received {line:?}"
    );
    assert_eq!(
        gate(version.as_deref(), MINIMUM_CODEX_VERSION),
        GateVerdict::Usable,
        "expected the answered build to meet the floor | received {line:?}"
    );
    assert_eq!(
        inner.launches().len(),
        0,
        "expected the probe to stay out of the wrapped launcher's log | received a recorded launch"
    );
}

#[tokio::test]
async fn any_other_launch_is_delegated_and_recorded_by_the_wrapped_launcher() {
    let inner = FakeLauncher::new();
    inner.push(FakeProcess::transcript(["app-server"]));
    let launcher = VersionAnsweringLauncher::over(Arc::new(inner.clone()));

    launcher
        .spawn(launch(&["/synthetic/codex", "app-server"]))
        .await
        .expect("expected the app-server launch to reach the queued fake");

    let launches = inner.launches();
    assert_eq!(
        launches
            .iter()
            .map(|spec| spec.argv.clone())
            .collect::<Vec<_>>(),
        vec![vec!["/synthetic/codex".to_owned(), "app-server".to_owned()]],
        "expected exactly the app-server launch recorded | received {launches:?}"
    );
}
