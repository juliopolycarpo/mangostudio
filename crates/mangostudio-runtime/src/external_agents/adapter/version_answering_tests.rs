//! The Codex version probe is answered by the test launcher and never reaches the wrapped one,
//! and the runtime's own Codex open runs that probe before any app-server.
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use mango_agent_codex::MINIMUM_CODEX_VERSION;
use mango_agent_codex::discovery::{gate, parse_version};
use mango_external_agents::discovery::GateVerdict;
use mango_external_agents::testing::{FakeLauncher, FakeProcess};
use mango_external_agents::{LaunchSpec, ProcessLauncher};

use super::backend::{Backend, ProductHarnesses};
use super::test_support::{self as fixtures, VersionAnsweringLauncher};
use crate::external_agents::failure::FailureCause;
use crate::external_agents::port::AgentBackend;
use crate::external_agents::wire;
use crate::test_support::ScratchDir;

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
    let launches = inner.launches();
    assert!(
        launches.is_empty(),
        "expected the probe to stay out of the wrapped launcher's log | received {launches:?}"
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

#[tokio::test]
async fn a_codex_open_refuses_an_outdated_build_before_starting_an_app_server() {
    let launcher = Arc::new(FakeLauncher::new());
    launcher.push(FakeProcess::transcript(["codex-cli 0.1.0"]));
    let backend = Backend::new(
        launcher.clone(),
        Arc::new(ProductHarnesses),
        fixtures::limits(),
        Duration::from_secs(2),
    );
    let workspace = ScratchDir::created("codex-version-floor-workspace");
    let params = wire::OpenParams {
        session_id: "version-floor-open".into(),
        target_id: wire::TargetId::Codex,
        workspace_path: workspace.path().to_string_lossy().into_owned(),
        configuration: fixtures::configuration(),
        resume_ref: None,
        resume_mode: wire::ResumeMode::Fallback,
        timeout_ms: 5_000,
        toolchain: None,
    };

    let opened = backend
        .open(
            wire::TargetId::Codex,
            "/synthetic/codex".into(),
            fixtures::host(workspace.path().to_path_buf()),
            &params,
        )
        .await;

    let Err(failure) = opened else {
        panic!("expected an outdated Codex build refused at open | received an open session");
    };
    let kind = failure
        .remote
        .details
        .as_ref()
        .and_then(|details| details.get("kind"))
        .and_then(|kind| kind.as_str());
    assert_eq!(
        (failure.cause, kind),
        (
            FailureCause::Version,
            Some("external_agent_version_unsupported")
        ),
        "expected (cause, kind) of a version refusal | received {failure:?}"
    );
    let argv: Vec<_> = launcher
        .launches()
        .into_iter()
        .map(|spec| spec.argv)
        .collect();
    assert_eq!(
        argv,
        vec![vec!["/synthetic/codex".to_owned(), "--version".to_owned()]],
        "expected only the version probe launched | received {argv:?}"
    );
}
