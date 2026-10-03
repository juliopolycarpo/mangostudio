//! Actual SDK process ownership under broken writes, cancellation, drop and missing stdin.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mango_agent_acp::testing::FakeAcpAgent;
use mango_external_agents::testing::{Announcer, FakeLauncher};
use mango_external_agents::{
    CancelReason, ExitStatus, InterruptOutcome, LaunchSpec, ManagedProcess, ProcessControl,
    ProcessLauncher,
};

use super::backend::{Backend, ProductHarnesses};
use super::test_support::{self as fixtures, CodexPeer, Rig};
use crate::external_agents::failure::{CleanupOutcome, FailureCause, SessionUsability};
use crate::external_agents::port::{AgentBackend, CloseCause, TurnRequest};
use crate::external_agents::wire;

#[derive(Default)]
struct StopLog {
    kills: Mutex<Vec<CancelReason>>,
    failures: AtomicUsize,
    controls: Mutex<Vec<Arc<ObservedControl>>>,
}
struct ObservedLauncher {
    fake: FakeLauncher,
    log: Arc<StopLog>,
    missing_stdin: bool,
}
struct ObservedControl {
    inner: Arc<dyn ProcessControl>,
    log: std::sync::Weak<StopLog>,
}
#[async_trait::async_trait]
impl ProcessControl for ObservedControl {
    fn pid(&self) -> Option<u32> {
        self.inner.pid()
    }
    fn stderr_tail(&self) -> String {
        self.inner.stderr_tail()
    }
    async fn wait(&self) -> mango_external_agents::Result<ExitStatus> {
        self.inner.wait().await
    }
    async fn interrupt(
        &self,
        reason: CancelReason,
    ) -> mango_external_agents::Result<InterruptOutcome> {
        self.inner.interrupt(reason).await
    }
    async fn kill(&self, reason: CancelReason) -> mango_external_agents::Result<()> {
        let log = self
            .log
            .upgrade()
            .expect("the launcher retains stop observations");
        log.kills.lock().unwrap().push(reason);
        if log
            .failures
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                left.checked_sub(1)
            })
            .is_ok()
        {
            return Err(mango_external_agents::Error::Link {
                peer: "synthetic process control".into(),
                message: "cleanup refused".into(),
            });
        }
        self.inner.kill(reason).await
    }
}
#[async_trait::async_trait]
impl ProcessLauncher for ObservedLauncher {
    async fn spawn(&self, spec: LaunchSpec) -> mango_external_agents::Result<ManagedProcess> {
        let mut process = self.fake.spawn(spec).await?;
        let control = Arc::new(ObservedControl {
            inner: process.control,
            log: Arc::downgrade(&self.log),
        });
        self.log.controls.lock().unwrap().push(Arc::clone(&control));
        process.control = control;
        if self.missing_stdin {
            process.stdin = None;
        }
        Ok(process)
    }
}
fn observed(
    fake: FakeLauncher,
    missing_stdin: bool,
    failures: usize,
) -> (Arc<ObservedLauncher>, Arc<StopLog>) {
    let log = Arc::new(StopLog::default());
    log.failures.store(failures, Ordering::SeqCst);
    (
        Arc::new(ObservedLauncher {
            fake,
            log: Arc::clone(&log),
            missing_stdin,
        }),
        log,
    )
}

#[tokio::test]
async fn failed_approval_stdin_settles_the_child_and_the_next_message_uses_a_fresh_usable_session()
{
    let fake = FakeLauncher::new();
    let peer = CodexPeer {
        start_frames: vec![fixtures::approval(vec!["git".into(), "status".into()])],
        ..Default::default()
    };
    fake.push(
        peer.process(Announcer::new())
            .failing_stdin_after(5, "EPIPE"),
    );
    fake.push(
        CodexPeer {
            complete: true,
            ..Default::default()
        }
        .process(Announcer::new()),
    );
    let (launcher, log) = observed(fake.clone(), false, 0);
    let mut rig = Rig::new(launcher, wire::TargetId::Codex, fixtures::limits()).await;
    rig.open().await;
    let turn = rig.turn("broken-write").await.unwrap();
    let events = rig.through("approval_requested").await;
    let request_id = events.last().unwrap()["event"]["request"]["requestId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        fake.written().len(),
        5,
        "the failure must land on the answer, after handshake and turn start"
    );
    let response = rig
        .supervisor
        .respond(wire::RespondParams {
            session_id: rig.params.session_id.clone(),
            native_turn_id: turn.native_turn_id,
            request_id,
            option_id: "decline".into(),
        })
        .await;
    assert!(
        response.is_ok(),
        "answer submission acknowledges before the failed write settles on the stream: {response:?}"
    );
    let terminal = rig.through("error").await;
    assert_eq!(
        terminal.last().unwrap()["event"]["type"],
        "error",
        "streamed failure stays on the event topic"
    );
    fixtures::reaped(&fake).await;
    assert_eq!(fake.launches().len(), 1);
    let lost = rig.turn("next-message").await.unwrap_err();
    assert_eq!(
        lost.details.as_ref().unwrap()["kind"],
        "tool_argument",
        "the existing spent-session response is a product argument error; received {lost:?}"
    );
    assert!(
        lost.message.contains("can no longer run turns")
            && lost.message.contains("expected a new session")
    );
    assert_eq!(
        rig.supervisor.live_sessions().0,
        0,
        "the spent session is evicted before reopening"
    );
    rig.open().await;
    rig.turn("next-message").await.unwrap();
    rig.through("completed").await;
    assert_eq!(
        fake.launches().len(),
        2,
        "the next usable send has a fresh process"
    );
    assert_eq!(fake.live_children(), 1);
    rig.close().await;
    fixtures::reaped(&fake).await;
    assert_eq!(
        log.kills.lock().unwrap().len(),
        2,
        "one physical stop per launched child"
    );
}

#[tokio::test]
async fn failed_turn_start_stdin_reports_uncertain_admission_over_rpc_and_reopening_is_usable() {
    let fake = FakeLauncher::new();
    fake.push(
        CodexPeer::default()
            .process(Announcer::new())
            .failing_stdin_after(4, "EPIPE"),
    );
    fake.push(
        CodexPeer {
            complete: true,
            ..Default::default()
        }
        .process(Announcer::new()),
    );
    let (launcher, log) = observed(fake.clone(), false, 0);
    let mut rig = Rig::new(launcher, wire::TargetId::Codex, fixtures::limits()).await;
    rig.open().await;
    assert_eq!(
        fake.written().len(),
        4,
        "the broken pipe must follow the open handshake"
    );
    let failed = rig.turn("rpc-broken-write").await.unwrap_err();
    assert_eq!(failed.code, mango_protocol::error::codes::INTERNAL);
    assert_eq!(
        failed.details.as_ref().unwrap()["kind"],
        "external_agent_protocol"
    );
    assert_eq!(
        failed.details.as_ref().unwrap()["dispatch"],
        "acceptance-unknown"
    );
    assert!(failed.message.contains("native turn id"));
    fixtures::reaped(&fake).await;
    let lost = rig.turn("rpc-next-message").await.unwrap_err();
    assert_eq!(lost.details.as_ref().unwrap()["kind"], "tool_argument");
    assert!(lost.message.contains("expected a new session"));
    assert_eq!(rig.supervisor.live_sessions().0, 0);
    rig.open().await;
    rig.turn("rpc-next-message").await.unwrap();
    rig.through("completed").await;
    assert_eq!(fake.launches().len(), 2);
    assert_eq!(fake.live_children(), 1);
    rig.close().await;
    fixtures::reaped(&fake).await;
    assert_eq!(log.kills.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn a_failed_live_account_read_exposes_rpc_link_provenance_separately_from_streamed_errors() {
    let fake = FakeLauncher::new();
    fake.push(
        CodexPeer::default()
            .process(Announcer::new())
            .failing_stdin_after(4, "EPIPE"),
    );
    fake.push(
        CodexPeer {
            complete: true,
            ..Default::default()
        }
        .process(Announcer::new()),
    );
    let (launcher, log) = observed(fake.clone(), false, 0);
    let mut rig = Rig::new(launcher, wire::TargetId::Codex, fixtures::limits()).await;
    rig.open().await;
    let error = rig
        .supervisor
        .refresh_account_usage(
            wire::RefreshAccountUsageParams {
                target_id: wire::TargetId::Codex,
                session_id: Some(rig.params.session_id.clone()),
                timeout_ms: 5_000,
            },
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, mango_protocol::error::codes::UNAVAILABLE);
    assert_eq!(
        error.details.as_ref().unwrap()["kind"],
        "external_agent_link_lost"
    );
    fixtures::reaped(&fake).await;
    assert_eq!(log.kills.lock().unwrap().len(), 1);
    let spent = rig.turn("after-account-failure").await.unwrap_err();
    assert_eq!(spent.details.as_ref().unwrap()["kind"], "tool_argument");
    assert!(spent.message.contains("expected a new session"));
    assert_eq!(rig.supervisor.live_sessions().0, 0);
    rig.open().await;
    rig.turn("after-account-failure").await.unwrap();
    rig.through("completed").await;
    assert_eq!(fake.launches().len(), 2);
    assert_eq!(fake.live_children(), 1);
    rig.close().await;
    fixtures::reaped(&fake).await;
    assert_eq!(log.kills.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn requested_cancel_settles_only_the_turn_and_explicit_close_does_not_double_stop_on_drop() {
    let fake = FakeLauncher::new();
    let announcer = Announcer::new();
    let peer = CodexPeer::default();
    fake.push(peer.process(announcer.clone()));
    let (launcher, log) = observed(fake.clone(), false, 0);
    let mut rig = Rig::new(launcher, wire::TargetId::Codex, fixtures::limits()).await;
    rig.open().await;
    let first = rig.turn("cancel-first").await.unwrap();
    assert_eq!(fake.live_children(), 1);
    rig.supervisor
        .cancel(wire::CancelParams {
            session_id: rig.params.session_id.clone(),
            native_turn_id: Some(first.native_turn_id),
        })
        .await
        .unwrap();
    let terminal = rig.through("completed").await;
    assert_eq!(fixtures::shape(&terminal), ["cancelled", "completed"]);
    assert_eq!(
        fake.live_children(),
        1,
        "graceful turn cancellation keeps the session usable"
    );
    assert!(log.kills.lock().unwrap().is_empty());
    rig.turn("after-cancel").await.unwrap();
    announcer.announce(fixtures::completed("completed").to_string());
    rig.through("completed").await;
    assert_eq!(
        fake.launches().len(),
        1,
        "next send reuses the healthy session"
    );
    rig.close().await;
    fixtures::reaped(&fake).await;
    drop(rig);
    tokio::task::yield_now().await;
    assert_eq!(
        log.kills.lock().unwrap().len(),
        1,
        "SDK drop and product close share one stop"
    );
}

#[tokio::test]
async fn dropping_an_active_stream_settles_work_while_session_drop_reaps_the_child_once() {
    let fake = FakeLauncher::new();
    fake.push(CodexPeer::default().process(Announcer::new()));
    let (launcher, log) = observed(fake.clone(), false, 0);
    let rig = Rig::new(launcher.clone(), wire::TargetId::Codex, fixtures::limits()).await;
    let backend = Backend::new(
        launcher,
        Arc::new(ProductHarnesses),
        fixtures::limits(),
        Duration::from_secs(2),
    );
    let session = backend
        .open(
            wire::TargetId::Codex,
            "/synthetic/codex".into(),
            fixtures::host(rig.params.workspace_path.clone().into()),
            &rig.params,
        )
        .await
        .unwrap();
    let configuration = fixtures::configuration();
    let stream = session
        .start_turn(TurnRequest {
            turn_id: "drop-stream".into(),
            input: "synthetic input".into(),
            attachments: Vec::new(),
            configuration: &configuration,
        })
        .await
        .unwrap();
    assert_eq!(fake.live_children(), 1);
    drop(stream);
    tokio::time::timeout(Duration::from_secs(5), async {
        while !fake
            .written()
            .iter()
            .any(|line| line.contains("turn/interrupt"))
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("dropping observation stops its active native turn");
    session.close(CloseCause::Requested).await.unwrap();
    assert_eq!(
        fake.live_children(),
        0,
        "explicit close must settle before returning, while its session owner is retained"
    );
    drop(session);
    fixtures::reaped(&fake).await;
    assert_eq!(log.kills.lock().unwrap().len(), 1);

    fake.push(CodexPeer::default().process(Announcer::new()));
    let session = backend
        .open(
            wire::TargetId::Codex,
            "/synthetic/codex".into(),
            fixtures::host(rig.params.workspace_path.clone().into()),
            &rig.params,
        )
        .await
        .unwrap();
    let mut stream = session
        .start_turn(TurnRequest {
            turn_id: "drop-session".into(),
            input: "synthetic input".into(),
            attachments: Vec::new(),
            configuration: &configuration,
        })
        .await
        .unwrap();
    drop(session);
    fixtures::reaped(&fake).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while stream.recv().await.is_some() {}
    })
    .await
    .expect("a retained stream observes settlement when its session owner drops");
    drop(stream);
    assert_eq!(
        log.kills.lock().unwrap().len(),
        2,
        "one stop for each independent child"
    );
    rig.close().await;
}

#[tokio::test]
async fn missing_stdin_cleanup_is_settled_or_explicitly_unconfirmed_with_control_retained() {
    for (failures, expected) in [
        (0, CleanupOutcome::NotRequired),
        (1, CleanupOutcome::Settled),
        (2, CleanupOutcome::Unconfirmed),
    ] {
        let fake = FakeLauncher::new();
        fake.push(FakeAcpAgent::new().process());
        let (launcher, log) = observed(fake.clone(), true, failures);
        let rig = Rig::new(launcher.clone(), wire::TargetId::Cursor, fixtures::limits()).await;
        let backend = Backend::new(
            launcher,
            Arc::new(ProductHarnesses),
            fixtures::limits(),
            Duration::from_secs(2),
        );
        let error = backend
            .open(
                wire::TargetId::Cursor,
                "/synthetic/cursor".into(),
                fixtures::host(rig.params.workspace_path.clone().into()),
                &rig.params,
            )
            .await
            .err()
            .expect("missing stdin refuses the open");
        assert_eq!(error.cause, FailureCause::Link);
        assert_eq!(
            error.remote.details.as_ref().unwrap()["kind"],
            "external_agent_link_lost"
        );
        assert_eq!(error.cleanup, expected);
        if expected == CleanupOutcome::Unconfirmed {
            assert_eq!(
                fake.live_children(),
                1,
                "failure must not imply successful cleanup"
            );
            let remote = error.into_remote();
            assert_eq!(remote.details.as_ref().unwrap()["cleanup"], "unconfirmed");
            let control = log.controls.lock().unwrap()[0].clone();
            control.kill(CancelReason::Shutdown).await.unwrap();
            control.wait().await.unwrap();
        }
        fixtures::reaped(&fake).await;
        assert_eq!(
            log.kills.lock().unwrap().len(),
            if failures == 0 { 1 } else { failures + 1 }
        );
        rig.close().await;
    }
}

/// Wraps a spent SDK cause in both operation/cleanup nesting orders without losing either fact.
fn wrapped_spent_error(
    cancelled: bool,
    operation_outside: bool,
    control: Arc<dyn ProcessControl>,
) -> mango_external_agents::Error {
    use mango_external_agents::{Dispatch, Error};
    let source = if cancelled {
        Error::Cancelled {
            reason: CancelReason::Shutdown,
        }
    } else {
        Error::Closed { subject: "session" }
    };
    if operation_outside {
        return Error::Operation {
            dispatch: Dispatch::NotSubmitted,
            source: Box::new(Error::CleanupRequired {
                source: Box::new(source),
                control,
            }),
        };
    }
    Error::CleanupRequired {
        source: Box::new(source.with_dispatch(Dispatch::NotSubmitted)),
        control,
    }
}

#[tokio::test]
async fn cleanup_wrapped_closed_and_cancelled_remain_spent_and_evict_product_starts() {
    for (cancelled, operation_outside, review) in [
        (false, false, false),
        (false, false, true),
        (false, true, false),
        (false, true, true),
        (true, false, false),
        (true, false, true),
        (true, true, false),
        (true, true, true),
    ] {
        let fake = FakeLauncher::new();
        fake.push(CodexPeer::default().process(Announcer::new()));
        let (launcher, log) = observed(fake.clone(), false, 0);
        let process = launcher
            .spawn(LaunchSpec {
                argv: vec!["/synthetic/wrapped-spent-agent".into()],
                cwd: ".".into(),
                env: Default::default(),
                stdin: true,
                hide_window: true,
            })
            .await
            .unwrap();
        let error = wrapped_spent_error(cancelled, operation_outside, process.control.clone());
        let before = super::failure::facts(error.clone());
        assert_eq!(
            before.session,
            SessionUsability::Spent,
            "cleanup wrapper must preserve spent classification: cancelled={cancelled}, operation_outside={operation_outside}"
        );
        assert_eq!(before.cleanup, CleanupOutcome::Unconfirmed);
        assert_eq!(
            before.dispatch,
            Some(crate::external_agents::port::Dispatch::NotSubmitted)
        );
        assert_eq!(
            before.cause,
            if cancelled {
                FailureCause::Cancelled
            } else {
                FailureCause::Closed
            }
        );
        assert_eq!(fake.live_children(), 1);
        let settled = super::failure::settle(error, Duration::from_secs(2)).await;
        assert_eq!(settled.session, SessionUsability::Spent);
        assert_eq!(settled.cleanup, CleanupOutcome::Settled);
        assert_eq!(fake.live_children(), 0);
        assert_eq!(*log.kills.lock().unwrap(), [CancelReason::Shutdown]);
        crate::external_agents::supervisor::lifecycle_product_tests::assert_spent_start_eviction(
            settled, review,
        )
        .await;
        process.control.wait().await.unwrap();
        assert_eq!(*log.kills.lock().unwrap(), [CancelReason::Shutdown]);
    }
}
