//! How the runtime reads the SDK's two launch errors.
//!
//! `Error::ProgramNotFound` is the launcher's statement that the program does not exist, and the
//! SDK's version probes read only that as "not installed". `Error::Launch` is a program that is
//! there and would not start: a probe returns it from `discover`, and `Backend::discover` turns it
//! into the `launch-refused` descriptor. These tests drive the real harnesses over the SDK's
//! named launcher fakes, so they hold on every platform; `launch_failure_tests` covers the same
//! split against the production launcher and a real file on `PATH` (Unix only).
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use mango_agent_codex::account::AccountFingerprintKey;
use mango_external_agents::testing::FakeLauncher;
use mango_external_agents::{
    CancelReason, Error, ExitStatus, Harness, HostContext, ProcessControl, ProcessLauncher,
};
use mango_protocol::error::codes;
use mangostudio_runtime_contract::errors::EXTERNAL_AGENT_DISCOVERY_LAUNCH_REFUSED_CODE;

use super::backend::{Backend, ProductHarnesses, SdkHarnessFactory, TargetDiscovery};
use super::test_support::{RecordingDiagnostics, configuration, host, limits};
use crate::diagnostics::DiagnosticSink;
use crate::external_agents::port::AgentBackend;
use crate::external_agents::supervisor::PortFuture;
use crate::external_agents::wire::{self, DiscoveryState, RemedyKind, TargetId, UnavailableReason};

/// What the production launcher's message looks like for an unexecutable program.
const OS_REFUSAL: &str = "an OS launch failure (Permission denied (os error 13))";
const TARGETS: [TargetId; 3] = [TargetId::Claude, TargetId::Codex, TargetId::Cursor];

fn backend_over(
    launcher: Arc<dyn ProcessLauncher>,
    harnesses: Arc<dyn SdkHarnessFactory>,
    diagnostics: &Arc<RecordingDiagnostics>,
) -> Backend {
    Backend::new(launcher, harnesses, limits(), Duration::from_secs(2))
        .with_diagnostics(Arc::clone(diagnostics) as Arc<dyn DiagnosticSink>)
}

/// The real harnesses over `launcher`.
fn production_harnesses_over(
    launcher: FakeLauncher,
    diagnostics: &Arc<RecordingDiagnostics>,
) -> Backend {
    backend_over(Arc::new(launcher), Arc::new(ProductHarnesses), diagnostics)
}

/// Counts the kill and wait the adapter asks of a child an error still owns.
#[derive(Default)]
struct ReapedControl {
    kills: AtomicUsize,
    waits: AtomicUsize,
}

#[async_trait::async_trait]
impl ProcessControl for ReapedControl {
    fn pid(&self) -> Option<u32> {
        None
    }
    fn stderr_tail(&self) -> String {
        String::new()
    }
    async fn wait(&self) -> mango_external_agents::Result<ExitStatus> {
        self.waits.fetch_add(1, Ordering::SeqCst);
        Ok(ExitStatus {
            code: Some(0),
            signal: None,
        })
    }
    async fn kill(&self, _reason: CancelReason) -> mango_external_agents::Result<()> {
        self.kills.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

/// A harness factory whose discovery fails with one scripted SDK error and launches nothing.
struct ScriptedDiscoveryFailure(std::sync::Mutex<Option<Error>>);

impl ScriptedDiscoveryFailure {
    fn of(error: Error) -> Arc<Self> {
        Arc::new(Self(std::sync::Mutex::new(Some(error))))
    }
}

impl SdkHarnessFactory for ScriptedDiscoveryFailure {
    fn harness(&self, target: TargetId, _executable: Option<PathBuf>) -> Arc<dyn Harness> {
        panic!("expected only discovery to run | received a harness request for {target:?}")
    }
    fn discover<'a>(
        &'a self,
        _target: TargetId,
        _executable: Option<PathBuf>,
        _host: &'a HostContext,
        _key: Option<&'a AccountFingerprintKey>,
    ) -> PortFuture<'a, mango_external_agents::Result<TargetDiscovery>> {
        let error = self
            .0
            .lock()
            .unwrap()
            .take()
            .expect("expected one scripted discovery failure | received a second discovery");
        Box::pin(async move { Err(error) })
    }
}

fn launch_failure(message: &str) -> Error {
    Error::Launch {
        program: String::from("claude"),
        message: message.to_owned(),
    }
}

async fn discover_over(backend: &Backend, target: TargetId) -> wire::Descriptor {
    backend
        .discover(target, None, host(std::env::temp_dir()), None)
        .await
        .unwrap_or_else(|failure| {
            panic!(
                "expected a {target:?} descriptor | received {:?}",
                failure.into_remote()
            )
        })
}

#[tokio::test]
async fn a_launcher_that_reports_a_missing_program_discovers_as_not_installed() {
    for target in TARGETS {
        let diagnostics = Arc::new(RecordingDiagnostics::default());
        let backend = production_harnesses_over(FakeLauncher::missing_program(), &diagnostics);

        let descriptor = discover_over(&backend, target).await;

        assert_eq!(
            (
                descriptor.installed,
                descriptor.discovery_state,
                descriptor.unavailable_reason,
                descriptor.remedy.map(|remedy| remedy.kind),
                descriptor.discovery.and_then(|report| report.failure_code),
            ),
            (
                false,
                DiscoveryState::Determined,
                Some(UnavailableReason::NotInstalled),
                Some(RemedyKind::Install),
                None
            ),
            "({target:?} discovery): expected (installed, state, reason, remedy, failureCode) of \
             a missing program"
        );
        assert!(
            diagnostics.lines().is_empty(),
            "({target:?} discovery): expected no diagnostic for a missing program | received {:?}",
            diagnostics.lines()
        );
    }
}

#[tokio::test]
async fn a_launcher_that_reports_a_launch_failure_discovers_as_launch_refused() {
    for target in TARGETS {
        let diagnostics = Arc::new(RecordingDiagnostics::default());
        let backend =
            production_harnesses_over(FakeLauncher::refusing_launches(OS_REFUSAL), &diagnostics);

        let descriptor = discover_over(&backend, target).await;

        assert_eq!(
            (
                descriptor.installed,
                descriptor.discovery_state,
                descriptor.unavailable_reason,
                descriptor.remedy.map(|remedy| remedy.kind),
                descriptor.discovery.and_then(|report| report.failure_code),
            ),
            (
                true,
                DiscoveryState::Undetermined,
                None,
                None,
                Some(EXTERNAL_AGENT_DISCOVERY_LAUNCH_REFUSED_CODE)
            ),
            "({target:?} discovery): expected (installed, state, reason, remedy, failureCode) of \
             a refused launch"
        );
        let lines = diagnostics.lines();
        assert!(
            matches!(lines.as_slice(), [line]
                if line.contains("external_agent_launch_refused")
                    && line.contains("\"level\":\"warn\"")
                    && line.contains(&format!("\"target\":\"{}\"", target.as_str()))
                    && line.contains(OS_REFUSAL)),
            "({target:?} discovery): expected one warn line naming the target and the OS error | \
             received {lines:?}"
        );
    }
}

/// A launcher whose every start fails and whose cleanup of the failed child then fails too: what
/// `GuardedProcessLauncher` returns when the tree of a child that never ran is not proven empty.
struct LeftoverChildLauncher;

#[async_trait::async_trait]
impl ProcessLauncher for LeftoverChildLauncher {
    async fn spawn(
        &self,
        _spec: mango_external_agents::LaunchSpec,
    ) -> mango_external_agents::Result<mango_external_agents::ManagedProcess> {
        Err(Error::Teardown {
            pid: Some(4242),
            message: format!(
                "a process tree not proven empty within 2s after a failed start ({})",
                launch_failure(OS_REFUSAL)
            ),
        })
    }
}

/// A failed start that leaves a process behind says nothing about whether the CLI is installed:
/// discovery fails with the launch-failed kind instead of answering not-installed or
/// launch-refused.
#[tokio::test]
async fn a_failed_start_with_a_leftover_child_fails_discovery_instead_of_describing_the_cli() {
    for target in TARGETS {
        let diagnostics = Arc::new(RecordingDiagnostics::default());
        let backend = backend_over(
            Arc::new(LeftoverChildLauncher),
            Arc::new(ProductHarnesses),
            &diagnostics,
        );

        let outcome = backend
            .discover(target, None, host(std::env::temp_dir()), None)
            .await;

        let remote = match outcome {
            Err(failure) => failure.into_remote(),
            Ok(descriptor) => panic!(
                "({target:?} discovery): expected a failure naming the leftover tree | received \
                 a descriptor with installed {} and reason {:?}",
                descriptor.installed, descriptor.unavailable_reason
            ),
        };
        assert_eq!(
            (
                remote.code.as_str(),
                remote
                    .details
                    .as_ref()
                    .and_then(|details| details["kind"].as_str()),
            ),
            (codes::UNAVAILABLE, Some("external_agent_launch_failed")),
            "({target:?} discovery): expected the launch-failed (code, kind) | received {remote:?}"
        );
        assert!(
            remote.message.contains("process tree 4242"),
            "({target:?} discovery): expected the message to name the leftover pid 4242 | \
             received {:?}",
            remote.message
        );
        assert!(
            diagnostics.lines().is_empty(),
            "({target:?} discovery): expected no launch-refused diagnostic | received {:?}",
            diagnostics.lines()
        );
    }
}

/// A launch error that still carries a child's cleanup control is not a refused launch: the child
/// may be running, so the error surfaces after the adapter reaps it, as it did before.
#[tokio::test]
async fn a_launch_failure_that_owns_a_child_is_reaped_and_reported_not_read_as_refused() {
    let control = Arc::new(ReapedControl::default());
    let error = Error::CleanupRequired {
        control: Arc::clone(&control) as Arc<dyn ProcessControl>,
        source: Box::new(launch_failure(OS_REFUSAL)),
    };
    let diagnostics = Arc::new(RecordingDiagnostics::default());
    let backend = backend_over(
        Arc::new(FakeLauncher::new()),
        ScriptedDiscoveryFailure::of(error),
        &diagnostics,
    );

    let failure = backend
        .discover(TargetId::Claude, None, host(std::env::temp_dir()), None)
        .await
        .expect_err("expected the launch failure to surface, received a descriptor");

    assert_eq!(
        (
            control.kills.load(Ordering::SeqCst),
            control.waits.load(Ordering::SeqCst)
        ),
        (1, 1),
        "expected the adapter to kill and wait the child the error owns once"
    );
    let remote = failure.into_remote();
    assert_eq!(
        remote
            .details
            .as_ref()
            .and_then(|details| details["kind"].as_str()),
        Some("external_agent_launch_failed"),
        "expected the existing launch-failed kind | received {remote:?}"
    );
    assert!(
        diagnostics.lines().is_empty(),
        "expected no launch-refused diagnostic | received {:?}",
        diagnostics.lines()
    );
}

/// A host annotates a failure with what it knows of dispatch; the refusal is still the cause.
#[tokio::test]
async fn an_annotated_launch_failure_is_still_a_refused_launch() {
    let diagnostics = Arc::new(RecordingDiagnostics::default());
    let backend = backend_over(
        Arc::new(FakeLauncher::new()),
        ScriptedDiscoveryFailure::of(
            launch_failure(OS_REFUSAL).with_dispatch(mango_external_agents::Dispatch::NotSubmitted),
        ),
        &diagnostics,
    );

    let descriptor = discover_over(&backend, TargetId::Claude).await;

    assert_eq!(
        descriptor.discovery.and_then(|report| report.failure_code),
        Some(EXTERNAL_AGENT_DISCOVERY_LAUNCH_REFUSED_CODE),
        "expected the launch-refused code for an annotated launch failure"
    );
}

/// Only a launch failure is a refused launch. Everything else a discovery can return keeps
/// failing the call with its own wire code.
#[tokio::test]
async fn errors_unrelated_to_launching_still_fail_discovery() {
    let cases = [
        (
            Error::Timeout {
                operation: String::from("version probe"),
                after: Duration::from_secs(5),
            },
            codes::TIMEOUT,
        ),
        (Error::Closed { subject: "link" }, codes::UNAVAILABLE),
        (
            Error::Cancelled {
                reason: CancelReason::Shutdown,
            },
            codes::CANCELLED,
        ),
    ];
    for (error, code) in cases {
        let rendered = format!("{error:?}");
        let diagnostics = Arc::new(RecordingDiagnostics::default());
        let backend = backend_over(
            Arc::new(FakeLauncher::new()),
            ScriptedDiscoveryFailure::of(error),
            &diagnostics,
        );

        let outcome = backend
            .discover(TargetId::Claude, None, host(std::env::temp_dir()), None)
            .await;

        let failure = outcome.expect_err(&format!(
            "expected {rendered} to fail discovery | received a descriptor"
        ));
        assert_eq!(
            failure.into_remote().code,
            code,
            "expected the wire code of {rendered}"
        );
        assert!(
            diagnostics.lines().is_empty(),
            "expected no launch-refused diagnostic for {rendered} | received {:?}",
            diagnostics.lines()
        );
    }
}

fn open_params(target: TargetId) -> wire::OpenParams {
    wire::OpenParams {
        session_id: "launch-error-session".into(),
        target_id: target,
        workspace_path: std::env::temp_dir().to_string_lossy().into_owned(),
        configuration: configuration(),
        resume_ref: None,
        resume_mode: wire::ResumeMode::Fallback,
        timeout_ms: 5_000,
        toolchain: None,
    }
}

/// What an open over `launcher` fails with, as the hub receives it.
async fn open_failure_over(launcher: FakeLauncher, target: TargetId) -> (String, Option<String>) {
    let diagnostics = Arc::new(RecordingDiagnostics::default());
    let backend = production_harnesses_over(launcher, &diagnostics);
    let outcome = backend
        .open(
            target,
            PathBuf::from("/synthetic/vendor-agent"),
            host(std::env::temp_dir()),
            &open_params(target),
        )
        .await;
    let Err(failure) = outcome else {
        panic!("expected the {target:?} open to fail | received an open session");
    };
    let remote = failure.into_remote();
    let kind = remote
        .details
        .as_ref()
        .and_then(|details| details["kind"].as_str().map(str::to_owned));
    (remote.code, kind)
}

/// The runtime's resolver answers `external_agent_not_installed` for an executable it cannot find;
/// a launcher that finds it gone a moment later says the same thing, so the hub presents the install
/// remedy and drops the stale discovery answer.
#[tokio::test]
async fn a_program_that_vanishes_before_the_open_launches_is_reported_as_not_installed() {
    for target in TARGETS {
        let failure = open_failure_over(FakeLauncher::missing_program(), target).await;
        assert_eq!(
            failure,
            (
                codes::INTERNAL.to_owned(),
                Some("external_agent_not_installed".to_owned())
            ),
            "({target:?} open): expected the not-installed (code, kind) for a missing program"
        );
    }
}

#[tokio::test]
async fn an_open_that_cannot_start_the_program_keeps_the_launch_failed_kind() {
    for target in TARGETS {
        let failure = open_failure_over(FakeLauncher::refusing_launches(OS_REFUSAL), target).await;
        assert_eq!(
            failure,
            (
                codes::UNAVAILABLE.to_owned(),
                Some("external_agent_launch_failed".to_owned())
            ),
            "({target:?} open): expected the launch-failed (code, kind) for a launch failure"
        );
    }
}
