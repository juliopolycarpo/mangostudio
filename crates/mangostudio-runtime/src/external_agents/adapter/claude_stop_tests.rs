//! A Claude stop that cannot prove its child gone is reconciled through the launcher's control,
//! exactly as a Codex one is. Real Claude harness, named fake process: the child outlives its
//! closed stdin and its control refuses or never answers the SDK's kill, so only the adapter's
//! own kill and wait through the control can end it.
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mango_external_agents::testing::{Announcer, FakeLauncher, FakeProcess};
use mango_external_agents::{
    ByteSink, ByteSource, CancelReason, Error, ExitStatus, InterruptOutcome, LaunchSpec, Limits,
    ManagedProcess, ProcessControl, ProcessLauncher, Result,
};
use serde_json::json;
use tokio::sync::Notify;

use super::backend::{Backend, ProductHarnesses};
use super::lifecycle_tests::observed;
use super::test_support::{self as fixtures, CodexPeer, Rig};
use crate::external_agents::failure::{AgentFailure, CleanupOutcome, FailureCause};
use crate::external_agents::port::{AgentBackend, AgentSession, CloseCause, TurnRequest};
use crate::external_agents::wire;
use mango_protocol::error::codes;

const HELP: &str = include_str!("../../../tests/fixtures/external-agents/claude-help-2.1.270.txt");
const VERSION: &str = "2.1.270 (Claude Code)";
const SIGNED_IN: &str = r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}"#;

/// What the control does when the SDK, then the adapter, asks it to kill.
#[derive(Clone, Copy, Debug)]
pub(super) enum Kill {
    /// Answers with the host's own error and leaves the child running.
    Refuse,
    /// Never answers, so the SDK's stage runs out.
    Hang,
    /// Ends the child.
    End,
}

/// Which kills the control receives, in order, and how it answers each. An empty script ends the
/// child.
struct KillScript(Mutex<VecDeque<Kill>>);

/// A Claude print-mode child that keeps running after its stdin closes.
struct StubbornChild {
    script: Arc<KillScript>,
    ended: Mutex<bool>,
    changed: Notify,
    kills: Mutex<Vec<CancelReason>>,
}
impl StubbornChild {
    fn is_ended(&self) -> bool {
        *self.ended.lock().unwrap()
    }
}
#[async_trait::async_trait]
impl ProcessControl for StubbornChild {
    fn pid(&self) -> Option<u32> {
        None
    }
    fn stderr_tail(&self) -> String {
        String::new()
    }
    async fn wait(&self) -> Result<ExitStatus> {
        loop {
            let changed = self.changed.notified();
            if self.is_ended() {
                return Ok(ExitStatus {
                    code: None,
                    signal: Some(9),
                });
            }
            changed.await;
        }
    }
    async fn interrupt(&self, _reason: CancelReason) -> Result<InterruptOutcome> {
        Ok(InterruptOutcome::Unsupported)
    }
    async fn kill(&self, reason: CancelReason) -> Result<()> {
        self.kills.lock().unwrap().push(reason);
        let next = self
            .script
            .0
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Kill::End);
        match next {
            Kill::Refuse => Err(Error::Link {
                peer: "synthetic claude control".into(),
                message: "kill refused".into(),
            }),
            Kill::Hang => std::future::pending().await,
            Kill::End => {
                *self.ended.lock().unwrap() = true;
                self.changed.notify_waiters();
                Ok(())
            }
        }
    }
}
struct StubbornStdout(Arc<StubbornChild>);
#[async_trait::async_trait]
impl ByteSource for StubbornStdout {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>> {
        loop {
            let changed = self.0.changed.notified();
            if self.0.is_ended() {
                return Ok(None);
            }
            changed.await;
        }
    }
}
/// Takes the prompt and keeps the child alive when its input closes.
struct StubbornStdin;
#[async_trait::async_trait]
impl ByteSink for StubbornStdin {
    async fn write_all(&mut self, _bytes: &[u8]) -> Result<()> {
        Ok(())
    }
    async fn close(&mut self) -> Result<()> {
        Ok(())
    }
}

/// A launch held inside the launcher: `arrived` fires when it is reached, `release` lets it go.
#[derive(Default)]
pub(super) struct SpawnGate {
    pub(super) arrived: Notify,
    pub(super) release: Notify,
}

/// Answers Claude's three probes from a queue and gives every other launch a [`StubbornChild`].
pub(super) struct StubbornClaudeLauncher {
    probes: FakeLauncher,
    gate: Mutex<Option<Arc<SpawnGate>>>,
    script: Arc<KillScript>,
    children: Mutex<Vec<Arc<StubbornChild>>>,
}
impl StubbornClaudeLauncher {
    pub(super) fn new(script: impl IntoIterator<Item = Kill>) -> Arc<Self> {
        let probes = FakeLauncher::new();
        probes.push(FakeProcess::transcript([VERSION]));
        probes.push(FakeProcess::transcript(HELP.lines().map(str::to_owned)));
        probes.push(FakeProcess::transcript([SIGNED_IN]));
        Arc::new(Self {
            probes,
            gate: Mutex::new(None),
            script: Arc::new(KillScript(Mutex::new(script.into_iter().collect()))),
            children: Mutex::new(Vec::new()),
        })
    }
    pub(super) fn live_children(&self) -> usize {
        let children = self.children.lock().unwrap();
        children.iter().filter(|child| !child.is_ended()).count()
    }
    /// The host's own reconciliation of a child the adapter left unconfirmed.
    async fn end_children(&self) {
        let children = self.children.lock().unwrap().clone();
        for child in children {
            let _ = child.kill(CancelReason::Shutdown).await;
        }
    }
    /// Holds the next turn launch inside the launcher until the test releases it, as a launcher
    /// that is still checking consent or starting a container would.
    pub(super) fn gate_turn_launch(&self) -> Arc<SpawnGate> {
        let gate = Arc::new(SpawnGate::default());
        *self.gate.lock().unwrap() = Some(Arc::clone(&gate));
        gate
    }
    pub(super) fn launches(&self) -> usize {
        self.children.lock().unwrap().len()
    }
    pub(super) fn kills(&self) -> Vec<CancelReason> {
        let children = self.children.lock().unwrap();
        children
            .iter()
            .flat_map(|child| child.kills.lock().unwrap().clone())
            .collect()
    }
}
fn is_probe(spec: &LaunchSpec) -> bool {
    spec.argv
        .iter()
        .any(|argument| matches!(argument.as_str(), "--version" | "--help" | "auth"))
}
#[async_trait::async_trait]
impl ProcessLauncher for StubbornClaudeLauncher {
    async fn spawn(&self, spec: LaunchSpec) -> Result<ManagedProcess> {
        if is_probe(&spec) {
            return self.probes.spawn(spec).await;
        }
        let gate = self.gate.lock().unwrap().take();
        if let Some(gate) = gate {
            gate.arrived.notify_one();
            gate.release.notified().await;
        }
        let child = Arc::new(StubbornChild {
            script: Arc::clone(&self.script),
            ended: Mutex::new(false),
            changed: Notify::new(),
            kills: Mutex::new(Vec::new()),
        });
        self.children.lock().unwrap().push(Arc::clone(&child));
        Ok(ManagedProcess {
            stdout: Box::new(StubbornStdout(Arc::clone(&child))),
            stdin: Some(Box::new(StubbornStdin)),
            control: child,
        })
    }
}

pub(super) fn limits() -> Limits {
    Limits {
        kill_grace: Duration::from_millis(10),
        shutdown_timeout: Duration::from_millis(300),
        cancel_settle_timeout: Duration::from_millis(300),
        ..Limits::default()
    }
}
fn backend(launcher: Arc<StubbornClaudeLauncher>) -> Backend {
    Backend::new(
        launcher,
        Arc::new(ProductHarnesses),
        limits(),
        Duration::from_millis(500),
    )
}
fn open_params(target: wire::TargetId, workspace: &std::path::Path) -> wire::OpenParams {
    wire::OpenParams {
        session_id: "stop-session".into(),
        target_id: target,
        workspace_path: workspace.to_string_lossy().into_owned(),
        configuration: fixtures::configuration(),
        resume_ref: None,
        resume_mode: wire::ResumeMode::Fallback,
        timeout_ms: 5_000,
        toolchain: None,
    }
}
async fn open_claude(backend: &Backend) -> Box<dyn AgentSession> {
    let workspace = std::env::temp_dir();
    let params = open_params(wire::TargetId::Claude, &workspace);
    backend
        .open(
            wire::TargetId::Claude,
            PathBuf::from("/synthetic/claude"),
            fixtures::host(workspace),
            &params,
        )
        .await
        .map_err(|failure| failure.to_string())
        .expect("expected the Claude harness to open over the probe fakes")
}
async fn start(session: &dyn AgentSession) -> crate::external_agents::port::TurnStream {
    let configuration = fixtures::configuration();
    session
        .start_turn(TurnRequest {
            turn_id: "stop-turn".into(),
            input: "hold".into(),
            attachments: Vec::new(),
            configuration: &configuration,
        })
        .await
        .map_err(|failure| failure.to_string())
        .expect("expected a running Claude turn")
}

/// Which SDK call the stop failure comes back through.
#[derive(Clone, Copy, Debug)]
enum Through {
    Close,
    Cancel,
    StartTurn,
}

/// Runs one failing stop through `through` on a real Claude session and returns what the adapter
/// reported with the launcher it ran on.
async fn failing_stop(
    through: Through,
    script: impl IntoIterator<Item = Kill>,
) -> (AgentFailure, Arc<StubbornClaudeLauncher>) {
    let launcher = StubbornClaudeLauncher::new(script);
    let backend = backend(Arc::clone(&launcher));
    let session = open_claude(&backend).await;
    let failure = match through {
        Through::Close => {
            let _turn = start(session.as_ref()).await;
            session.close(CloseCause::Requested).await
        }
        Through::Cancel => {
            let _turn = start(session.as_ref()).await;
            session
                .cancel(crate::external_agents::port::CancelReason::Requested)
                .await
        }
        Through::StartTurn => {
            // A turn id the event model cannot keep is refused after the child started, so the
            // start stops the child it launched.
            let configuration = fixtures::configuration();
            session
                .start_turn(TurnRequest {
                    turn_id: "   ".into(),
                    input: "hold".into(),
                    attachments: Vec::new(),
                    configuration: &configuration,
                })
                .await
                .map(|_| ())
        }
    }
    .expect_err("expected a stop the control refused to fail the call");
    (failure, launcher)
}

fn assert_reconciled(path: Through, failure: &AgentFailure, launcher: &StubbornClaudeLauncher) {
    assert_eq!(
        failure.cleanup,
        CleanupOutcome::Settled,
        "expected a Claude {path:?} whose stop failed to be reconciled through the launcher's control | received cleanup {:?}, {} live child(ren), kills {:?}, error {failure}",
        failure.cleanup,
        launcher.live_children(),
        launcher.kills(),
    );
    assert_eq!(
        (launcher.live_children(), launcher.kills().len()),
        (0, 2),
        "expected the SDK's kill, then the adapter's, and no child left after a Claude {path:?} | received (live children, kills) {:?} with {:?}",
        (launcher.live_children(), launcher.kills().len()),
        launcher.kills(),
    );
}

#[tokio::test]
async fn a_claude_close_whose_kill_is_refused_is_killed_and_reaped_through_the_control() {
    let (failure, launcher) = failing_stop(Through::Close, [Kill::Refuse, Kill::End]).await;
    assert_reconciled(Through::Close, &failure, &launcher);
    assert_eq!(
        failure.cause,
        FailureCause::Link,
        "expected the control's own error to stay the cause of a Claude close | received {failure}"
    );
    let remote = failure.into_remote();
    assert!(
        remote
            .details
            .as_ref()
            .is_none_or(|details| !details.contains_key("cleanupRequired")),
        "expected the settled obligation to be dropped from the wire error | received {:?}",
        remote.details
    );
}

#[tokio::test]
async fn a_claude_cancel_whose_kill_is_refused_is_killed_and_reaped_through_the_control() {
    let (failure, launcher) = failing_stop(Through::Cancel, [Kill::Refuse, Kill::End]).await;
    assert_reconciled(Through::Cancel, &failure, &launcher);
    assert_eq!(
        failure.cause,
        FailureCause::Link,
        "expected the control's own error to stay the cause of a Claude cancel | received {failure}"
    );
}

#[tokio::test]
async fn a_claude_start_that_cannot_stop_its_child_kills_and_reaps_it_through_the_control() {
    let (failure, launcher) = failing_stop(Through::StartTurn, [Kill::Refuse, Kill::End]).await;
    assert_reconciled(Through::StartTurn, &failure, &launcher);
}

#[tokio::test]
async fn a_claude_stop_that_runs_out_of_time_keeps_its_timeout_cause_and_is_reconciled() {
    for through in [Through::Close, Through::Cancel] {
        let (failure, launcher) = failing_stop(through, [Kill::Hang, Kill::End]).await;
        assert_reconciled(through, &failure, &launcher);
        assert_eq!(
            (failure.cause, failure.remote.code.as_str()),
            (FailureCause::Timeout, codes::TIMEOUT),
            "expected the stage that ran out to stay the cause of a Claude {through:?} | received {failure}",
        );
    }
}

#[tokio::test]
async fn a_claude_stop_the_control_keeps_refusing_stays_unconfirmed_and_names_the_obligation() {
    let (failure, launcher) =
        failing_stop(Through::Close, [Kill::Refuse, Kill::Refuse, Kill::End]).await;
    assert_eq!(
        (failure.cleanup, launcher.live_children()),
        (CleanupOutcome::Unconfirmed, 1),
        "expected a control that refuses twice to leave the child running and the cleanup unconfirmed | received {:?} with {} live child(ren)",
        failure.cleanup,
        launcher.live_children(),
    );
    let remote = failure.into_remote();
    let details = remote.details.clone().unwrap_or_default();
    assert_eq!(
        (details.get("cleanup"), details.get("cleanupRequired")),
        (Some(&json!("unconfirmed")), Some(&json!(true))),
        "expected the wire error to name the unconfirmed cleanup | received {details:?}"
    );
}

/// What a close that failed to stop its child reports, in the fields a caller branches on.
fn close_report(failure: &AgentFailure) -> (CleanupOutcome, FailureCause, String, usize) {
    (
        failure.cleanup,
        failure.cause,
        failure.remote.code.clone(),
        failure
            .remote
            .details
            .as_ref()
            .map_or(0, serde_json::Map::len),
    )
}

#[tokio::test]
async fn claude_reports_a_refused_close_the_way_codex_does() {
    for refusals in [1_usize, 2] {
        let script = std::iter::repeat_n(Kill::Refuse, refusals).chain([Kill::End]);
        let (claude, launcher) = failing_stop(Through::Close, script).await;
        let claude_kills = launcher.kills().len();

        let fake = FakeLauncher::new();
        fake.push(CodexPeer::default().process(Announcer::new()));
        let (codex_launcher, log) = observed(fake.clone(), false, refusals);
        let backend = Backend::new(
            codex_launcher,
            Arc::new(ProductHarnesses),
            limits(),
            Duration::from_millis(500),
        );
        let workspace = std::env::temp_dir();
        let params = open_params(wire::TargetId::Codex, &workspace);
        let session = backend
            .open(
                wire::TargetId::Codex,
                "/synthetic/codex".into(),
                fixtures::host(workspace),
                &params,
            )
            .await
            .map_err(|failure| failure.to_string())
            .expect("expected the Codex harness to open");
        let codex = session
            .close(CloseCause::Requested)
            .await
            .expect_err("expected a refused kill to fail the Codex close");
        let codex_kills = log.kills.lock().unwrap().len();

        assert_eq!(
            (close_report(&claude), claude_kills),
            (close_report(&codex), codex_kills),
            "expected a Claude close to report (cleanup, cause, code, detail count, kills) as a Codex close does after {refusals} refused kill(s)",
        );
        if refusals == 2 {
            // Reconcile what each side left behind so nothing outlives the test.
            let controls = log.controls.lock().unwrap().clone();
            for control in controls {
                let _ = control.kill(CancelReason::Shutdown).await;
            }
            fixtures::reaped(&fake).await;
            launcher.end_children().await;
        }
    }
}

#[tokio::test]
async fn a_supervisor_close_of_a_claude_session_reconciles_the_child_as_for_codex() {
    let launcher = StubbornClaudeLauncher::new([Kill::Refuse, Kill::End]);
    let rig = Rig::new(Arc::clone(&launcher) as _, wire::TargetId::Claude, limits()).await;
    rig.open().await;
    rig.turn("hold").await.expect("expected a running turn");
    let error = rig
        .supervisor
        .close_session(
            wire::CloseParams {
                session_id: rig.params.session_id.clone(),
            },
            CloseCause::Requested,
        )
        .await
        .expect_err("expected the refused kill to be reported by the close");
    assert_eq!(
        (
            error.code.as_str(),
            launcher.live_children(),
            rig.supervisor.live_sessions().0
        ),
        (codes::INTERNAL, 0, 0),
        "expected the supervisor to report a failed close (code, live children, live sessions) after reconciling through the control | received {error:?}",
    );
    assert!(
        error.message.contains("cleanup failed"),
        "expected the close to say its cleanup failed, as for Codex | received {}",
        error.message
    );
}

/// The UUID shape Claude documents for `--resume`.
const STORED_CONVERSATION: &str = "0b6f3c2e-4f1a-4d57-9c1e-2a7d9e5b8c41";

async fn open_resuming(
    backend: &Backend,
    mode: wire::ResumeMode,
) -> Result<Box<dyn AgentSession>, AgentFailure> {
    let workspace = std::env::temp_dir();
    let mut params = open_params(wire::TargetId::Claude, &workspace);
    params.resume_ref = Some(STORED_CONVERSATION.into());
    params.resume_mode = mode;
    backend
        .open(
            wire::TargetId::Claude,
            PathBuf::from("/synthetic/claude"),
            fixtures::host(workspace),
            &params,
        )
        .await
}

/// The hub asks Claude for the only mode its harness supports. If the SDK ever starts accepting
/// fallback, or stops accepting strict, this fails by name instead of every Claude reopen with a
/// stored conversation failing in production.
#[tokio::test]
async fn the_claude_harness_refuses_fallback_resume_and_opens_a_strict_one() {
    let backend = backend(StubbornClaudeLauncher::new([]));

    let fallback = open_resuming(&backend, wire::ResumeMode::Fallback).await;
    let strict = open_resuming(&backend, wire::ResumeMode::Strict).await;

    let received = match &fallback {
        Ok(_) => String::from("an open session"),
        Err(failure) => format!("{:?}: {failure}", failure.cause),
    };
    assert!(
        matches!(&fallback, Err(failure) if failure.cause == FailureCause::InvalidRequest
            && failure.to_string().contains("a strict Claude resume")),
        "expected a fallback resume refused as an invalid request naming a strict Claude resume | received: {received}"
    );
    let strict_received = strict
        .as_ref()
        .err()
        .map_or(String::from("an open session"), ToString::to_string);
    assert!(
        strict.is_ok(),
        "expected a strict resume of {STORED_CONVERSATION} to open | received: {strict_received}"
    );
}
