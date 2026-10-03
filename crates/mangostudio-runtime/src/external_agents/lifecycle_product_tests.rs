//! Relay and supervisor policy over owned events and named product fakes only.
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mango_protocol::frame::PeerInfo;
use mango_protocol::session::{Session, SessionOptions};
use tokio_util::sync::CancellationToken;

use super::{Ports, Supervisor};
use crate::external_agents::failure::AgentFailure;
use crate::external_agents::interactions::{Answer, MappedEvent, PendingInteraction};
use crate::external_agents::port::*;
use crate::external_agents::wire;
use crate::test_support::ScratchDir;

#[derive(Default)]
struct OwnedLifecycle {
    opens: AtomicUsize,
    live: AtomicUsize,
    stops: AtomicUsize,
    closes: Mutex<Vec<CloseCause>>,
    cancels: Mutex<Vec<CancelReason>>,
    stopped: AtomicBool,
    cancel: CancellationToken,
    script: Mutex<VecDeque<TurnEvent>>,
    wait_for_cancel: bool,
    start_failure: Mutex<Option<AgentFailure>>,
    starts: AtomicUsize,
    reviews: AtomicUsize,
    native_review: bool,
}
struct OwnedLifecycleBackend(Arc<OwnedLifecycle>);
struct OwnedLifecycleSession(Arc<OwnedLifecycle>);
struct OwnedLifecycleEvents {
    log: Arc<OwnedLifecycle>,
    script: VecDeque<TurnEvent>,
    terminal_phase: usize,
}
struct NoSessionChanges;
#[async_trait::async_trait]
impl SessionSubscription for NoSessionChanges {
    fn current(&self) -> Vec<wire::Command> {
        Vec::new()
    }
    async fn changed(&mut self) -> Option<Vec<wire::Command>> {
        None
    }
}
fn event(wire: wire::Event) -> TurnEvent {
    TurnEvent {
        at_ms: Some(1),
        idle_timeout: false,
        mapped: MappedEvent {
            wire: Some(wire),
            ..Default::default()
        },
    }
}
#[async_trait::async_trait]
impl EventStream for OwnedLifecycleEvents {
    fn native_turn_id(&self) -> &str {
        "owned-turn"
    }
    async fn recv(&mut self) -> Option<TurnEvent> {
        if let Some(event) = self.script.pop_front() {
            return Some(event);
        }
        if !self.log.wait_for_cancel {
            return None;
        }
        match self.terminal_phase {
            0 => {
                self.log.cancel.cancelled().await;
                self.terminal_phase = 1;
                Some(event(wire::Event::Cancelled))
            }
            1 => {
                self.terminal_phase = 2;
                Some(event(wire::Event::Completed))
            }
            _ => None,
        }
    }
}
fn capabilities(native_review: bool) -> wire::Capabilities {
    wire::Capabilities {
        structured_streaming: true,
        reasoning_stream: true,
        interactive_approvals: true,
        resume: false,
        model_catalog: false,
        images: false,
        usage_reporting: false,
        cancellation: true,
        steering: false,
        session_listing: false,
        native_review,
        account_usage: false,
    }
}
#[async_trait::async_trait]
impl AgentSession for OwnedLifecycleSession {
    fn open_result(&self, requested: &wire::Configuration) -> wire::OpenResult {
        wire::OpenResult {
            native_session_id: "owned-session".into(),
            resumed: false,
            fallback_reason: None,
            effective_configuration: requested.clone(),
            capabilities: capabilities(self.0.native_review),
            account_limits: None,
        }
    }
    fn native_session_id(&self) -> String {
        "owned-session".into()
    }
    fn capabilities(&self) -> wire::Capabilities {
        capabilities(self.0.native_review)
    }
    fn subscribe(&self) -> Box<dyn SessionSubscription> {
        Box::new(NoSessionChanges)
    }
    async fn start_turn(&self, _request: TurnRequest<'_>) -> AgentResult<TurnStream> {
        self.0.starts.fetch_add(1, Ordering::SeqCst);
        if let Some(failure) = self.0.start_failure.lock().unwrap().take() {
            return Err(failure);
        }
        Ok(self.stream())
    }
    async fn start_review(&self, _turn_id: String) -> AgentResult<ReviewStream> {
        self.0.reviews.fetch_add(1, Ordering::SeqCst);
        if let Some(failure) = self.0.start_failure.lock().unwrap().take() {
            return Err(failure);
        }
        Ok(ReviewStream {
            turn: self.stream(),
            review_thread_id: self.native_session_id(),
        })
    }
    async fn respond(&self, _answer: Answer) -> AgentResult<()> {
        Ok(())
    }
    async fn steer(&self, _steer: Steer) -> AgentResult<wire::SteerResult> {
        unreachable!("the fake exposes no steering")
    }
    async fn cancel(&self, reason: CancelReason) -> AgentResult<()> {
        self.0.cancels.lock().unwrap().push(reason);
        self.0.cancel.cancel();
        Ok(())
    }
    async fn close(&self, reason: CloseCause) -> AgentResult<()> {
        self.0.closes.lock().unwrap().push(reason);
        self.0.cancel.cancel();
        if !self.0.stopped.swap(true, Ordering::SeqCst) {
            self.0.live.fetch_sub(1, Ordering::SeqCst);
            self.0.stops.fetch_add(1, Ordering::SeqCst);
        }
        Ok(())
    }
    async fn refresh_account_usage(&self) -> AgentResult<wire::RefreshAccountUsageResult> {
        unreachable!("the fake exposes no account usage")
    }
}
impl OwnedLifecycleSession {
    /// Supplies the same owned event stream for a fake turn or native review.
    fn stream(&self) -> TurnStream {
        TurnStream {
            dispatch: Dispatch::Accepted,
            native_id: Ok("owned-turn".into()),
            events: Box::new(OwnedLifecycleEvents {
                log: Arc::clone(&self.0),
                script: std::mem::take(&mut *self.0.script.lock().unwrap()),
                terminal_phase: 0,
            }),
        }
    }
}
#[async_trait::async_trait]
impl AgentBackend for OwnedLifecycleBackend {
    fn close_budget(&self) -> Duration {
        Duration::ZERO
    }
    async fn discover(
        &self,
        _target: wire::TargetId,
        _executable: Option<std::path::PathBuf>,
        _host: Host,
        _key: Option<&AccountKey>,
    ) -> AgentResult<wire::Descriptor> {
        unreachable!("these tests open directly")
    }
    async fn open(
        &self,
        _target: wire::TargetId,
        _executable: std::path::PathBuf,
        _host: Host,
        _request: &wire::OpenParams,
    ) -> AgentResult<Box<dyn AgentSession>> {
        self.0.opens.fetch_add(1, Ordering::SeqCst);
        self.0.live.fetch_add(1, Ordering::SeqCst);
        self.0.stopped.store(false, Ordering::SeqCst);
        Ok(Box::new(OwnedLifecycleSession(Arc::clone(&self.0))))
    }
    async fn list_sessions(
        &self,
        _target: wire::TargetId,
        _executable: Option<std::path::PathBuf>,
        _host: Host,
        _query: SessionQuery,
    ) -> AgentResult<wire::ListSessionsResult> {
        unreachable!("the fake exposes no session listing")
    }
}
struct AuthorizedWorkspace(std::path::PathBuf);
impl super::WorkspaceAuthority for AuthorizedWorkspace {
    fn authorize<'a>(
        &'a self,
        _hub: &'a Session,
        path: &'a std::path::Path,
    ) -> super::PortFuture<'a, bool> {
        Box::pin(async move { path == self.0 })
    }
}
struct InstalledExecutable;
impl super::ExecutableResolver for InstalledExecutable {
    fn resolve<'a>(
        &'a self,
        _target: wire::TargetId,
        _cancel: &'a CancellationToken,
    ) -> super::PortFuture<'a, Option<std::path::PathBuf>> {
        Box::pin(async { Some("/owned/fake-agent".into()) })
    }
}
struct Rig {
    supervisor: Arc<Supervisor>,
    events: mango_protocol::session::EventStream,
    _sessions: (Session, Session),
    _dirs: (ScratchDir, ScratchDir),
    open_params: wire::OpenParams,
}
impl Rig {
    async fn new(log: Arc<OwnedLifecycle>) -> Self {
        let workspace = ScratchDir::created("owned-lifecycle-workspace");
        let canonical = crate::workspace_path::canonical_directory(workspace.path()).unwrap();
        let private = ScratchDir::created("owned-lifecycle-private");
        let supervisor = Supervisor::new(Ports {
            harnesses: Arc::new(OwnedLifecycleBackend(log)),
            workspaces: Arc::new(AuthorizedWorkspace(canonical.clone())),
            executables: Arc::new(InstalledExecutable),
            environment: Arc::new(crate::probing::detection::path_env::PathEnv::default),
            consent: Arc::new(|| true),
            private_root: private.path().to_path_buf(),
            runtime_version: "owned-lifecycle".into(),
            account_key: Arc::new(|| None),
            session_cap: 1,
            consent_poll: Duration::from_secs(60),
            consent_read_timeout: Duration::from_secs(2),
            cleanup_timeout: Duration::from_secs(2),
            hard_turn_timeout: Duration::from_secs(30),
        });
        let (port, peer) = mango_protocol::port::port_pair();
        let info = |role: &str| PeerInfo {
            name: "owned-lifecycle".into(),
            version: "0.0.0".into(),
            role: role.into(),
        };
        let (runtime, _) = Session::spawn(port, SessionOptions::new(info("runtime")));
        let (hub, _) = Session::spawn(peer, SessionOptions::new(info("hub")));
        let (a, b) = tokio::join!(runtime.ready(), hub.ready());
        a.unwrap();
        b.unwrap();
        let events = hub.events();
        let open_params = wire::OpenParams {
            session_id: "owned".into(),
            target_id: wire::TargetId::Claude,
            workspace_path: canonical.to_string_lossy().into_owned(),
            configuration: configuration(),
            resume_ref: None,
            resume_mode: wire::ResumeMode::Fallback,
            timeout_ms: 5_000,
            toolchain: None,
        };
        supervisor
            .open(open_params.clone(), &runtime, &CancellationToken::new())
            .await
            .unwrap();
        Self {
            supervisor,
            events,
            _sessions: (runtime, hub),
            _dirs: (workspace, private),
            open_params,
        }
    }
    async fn turn(&self, cancel: &CancellationToken) {
        self.start(false, cancel).await.unwrap();
    }
    /// Calls either product start entry point with the same client message receipt key.
    async fn start(
        &self,
        review: bool,
        cancel: &CancellationToken,
    ) -> Result<(), mango_protocol::error::RemoteError> {
        if review {
            return self
                .supervisor
                .start_review(
                    wire::StartReviewParams {
                        session_id: "owned".into(),
                        client_message_id: "owned-message".into(),
                        target: wire::ReviewTarget::UncommittedChanges,
                    },
                    cancel,
                )
                .await
                .map(|_| ());
        }
        self.supervisor
            .turn(
                wire::TurnParams {
                    session_id: "owned".into(),
                    client_message_id: "owned-message".into(),
                    input: "hello".into(),
                    configuration: configuration(),
                    attachments: None,
                },
                cancel,
            )
            .await
            .map(|_| ())
    }
    async fn terminal(&mut self, wanted: &str) -> Vec<serde_json::Value> {
        let mut events = Vec::new();
        loop {
            let envelope = tokio::time::timeout(Duration::from_secs(5), self.events.recv())
                .await
                .unwrap()
                .unwrap()
                .payload;
            let done = envelope["event"]["type"] == wanted;
            events.push(envelope);
            if done {
                return events;
            }
        }
    }
}

/// Exercises spent failure eviction and fresh same-message admission through product ports.
///
/// ```ignore
/// assert_spent_start_eviction(settled_adapter_failure, true).await;
/// ```
pub(in crate::external_agents) async fn assert_spent_start_eviction(
    failure: AgentFailure,
    review: bool,
) {
    let log = Arc::new(OwnedLifecycle {
        start_failure: Mutex::new(Some(failure)),
        native_review: true,
        script: Mutex::new(VecDeque::from([event(wire::Event::Completed)])),
        ..Default::default()
    });
    let mut rig = Rig::new(Arc::clone(&log)).await;
    let cancel = CancellationToken::new();
    let error = rig.start(review, &cancel).await.unwrap_err();
    assert_eq!(error.details.as_ref().unwrap()["kind"], "tool_argument");
    assert!(
        error.message.contains("expected a new session"),
        "{error:?}"
    );
    assert_eq!(rig.supervisor.live_sessions().0, 0);
    assert_eq!(log.live.load(Ordering::SeqCst), 0);
    assert_eq!(log.stops.load(Ordering::SeqCst), 1);
    assert_eq!(*log.closes.lock().unwrap(), [CloseCause::Requested]);
    assert!(log.cancels.lock().unwrap().is_empty());
    rig.start(review, &cancel).await.unwrap_err();
    assert_eq!(log.starts.load(Ordering::SeqCst), usize::from(!review));
    assert_eq!(log.reviews.load(Ordering::SeqCst), usize::from(review));
    rig.supervisor
        .open(rig.open_params.clone(), &rig._sessions.0, &cancel)
        .await
        .unwrap();
    rig.start(review, &cancel).await.unwrap();
    rig.terminal("completed").await;
    assert_eq!(log.opens.load(Ordering::SeqCst), 2);
    assert_eq!(log.live.load(Ordering::SeqCst), 1);
    assert_eq!(log.stops.load(Ordering::SeqCst), 1);
    assert_eq!(log.starts.load(Ordering::SeqCst), 2 * usize::from(!review));
    assert_eq!(log.reviews.load(Ordering::SeqCst), 2 * usize::from(review));
    rig.supervisor.close_all(CloseCause::Requested).await;
    assert_eq!(log.live.load(Ordering::SeqCst), 0);
    assert_eq!(log.stops.load(Ordering::SeqCst), 2);
    assert_eq!(
        *log.closes.lock().unwrap(),
        [CloseCause::Requested, CloseCause::Requested]
    );
}
fn configuration() -> wire::Configuration {
    wire::Configuration {
        model: None,
        effort: None,
        level: wire::PermissionLevel::Default,
        routing: wire::ApprovalRouting::User,
        workspace_roots: Vec::new(),
    }
}
fn resolution(id: &str) -> TurnEvent {
    let mut resolved = event(wire::Event::ApprovalResolved {
        request_id: id.into(),
        decision: wire::ApprovalDecision {
            option_id: "decline".into(),
            source: wire::DecisionSource::Cancelled,
        },
    });
    resolved.mapped.closed = Some(id.into());
    resolved
}
fn requested() -> TurnEvent {
    let mut opened = event(wire::Event::ApprovalRequested {
        request: wire::ApprovalRequest {
            request_id: "shown".into(),
            kind: wire::ActivityKind::Command,
            title: "git status".into(),
            detail: None,
            options: vec![wire::ApprovalOption {
                id: "decline".into(),
                label_key: None,
                raw_label: Some("Deny".into()),
                is_destructive: false,
            }],
            expires_at_ms: 1_900_000_000_000,
            truncated: None,
        },
    });
    opened.mapped.opened = Some(PendingInteraction::Approval {
        request_id: "shown".into(),
        option_ids: vec!["decline".into()],
        expires_at_ms: 1_900_000_000_000,
    });
    opened
}

#[tokio::test]
async fn owned_relay_suppresses_unseen_and_duplicate_resolutions_before_cancel_or_timeout() {
    for timeout in [false, true] {
        let mut cancelled = event(wire::Event::Cancelled);
        cancelled.idle_timeout = timeout;
        let log = Arc::new(OwnedLifecycle {
            script: Mutex::new(VecDeque::from([
                resolution("never-shown"),
                requested(),
                resolution("shown"),
                resolution("shown"),
                cancelled,
                event(wire::Event::Completed),
            ])),
            ..Default::default()
        });
        let mut rig = Rig::new(Arc::clone(&log)).await;
        rig.turn(&CancellationToken::new()).await;
        let events = rig
            .terminal(if timeout { "error" } else { "completed" })
            .await;
        let kinds: Vec<_> = events
            .iter()
            .map(|event| event["event"]["type"].as_str().unwrap())
            .collect();
        assert_eq!(
            kinds,
            if timeout {
                vec![
                    "commands_available",
                    "approval_requested",
                    "approval_resolved",
                    "error",
                ]
            } else {
                vec![
                    "commands_available",
                    "approval_requested",
                    "approval_resolved",
                    "cancelled",
                    "completed",
                ]
            }
        );
        if timeout {
            assert_eq!(
                events.last().unwrap()["event"]["error"]["code"],
                "adapter-stream"
            );
        }
        let stale = rig
            .supervisor
            .respond(wire::RespondParams {
                session_id: "owned".into(),
                native_turn_id: "owned-turn".into(),
                request_id: "shown".into(),
                option_id: "decline".into(),
            })
            .await
            .unwrap_err();
        assert!(stale.message.contains("not pending") || stale.message.contains("not running"));
        rig.supervisor.close_all(CloseCause::Shutdown).await;
        assert_eq!(log.live.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn turn_caller_token_is_not_an_active_stop_owner_and_user_cancel_keeps_its_reason() {
    let log = Arc::new(OwnedLifecycle {
        wait_for_cancel: true,
        ..Default::default()
    });
    let mut rig = Rig::new(Arc::clone(&log)).await;
    let caller = CancellationToken::new();
    rig.turn(&caller).await;
    caller.cancel();
    tokio::task::yield_now().await;
    assert!(
        log.cancels.lock().unwrap().is_empty(),
        "completed RPC ownership does not become an active-turn token bridge"
    );
    rig.supervisor
        .cancel(wire::CancelParams {
            session_id: "owned".into(),
            native_turn_id: Some("owned-turn".into()),
        })
        .await
        .unwrap();
    let events = rig.terminal("completed").await;
    assert_eq!(events[events.len() - 2]["event"]["type"], "cancelled");
    assert_eq!(*log.cancels.lock().unwrap(), [CancelReason::Requested]);
    assert_eq!(log.live.load(Ordering::SeqCst), 1);
    rig.supervisor.close_all(CloseCause::Requested).await;
    assert_eq!(log.live.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn each_product_close_owner_settles_active_work_once_and_preserves_its_reason() {
    for reason in [
        CloseCause::Requested,
        CloseCause::ConsentRevoked,
        CloseCause::Shutdown,
    ] {
        let log = Arc::new(OwnedLifecycle {
            wait_for_cancel: true,
            ..Default::default()
        });
        let mut rig = Rig::new(Arc::clone(&log)).await;
        rig.turn(&CancellationToken::new()).await;
        let close = wire::CloseParams {
            session_id: "owned".into(),
        };
        let (first, second) = tokio::join!(
            rig.supervisor.close_session(close.clone(), reason),
            rig.supervisor.close_session(close, reason)
        );
        first.unwrap();
        second.unwrap();
        rig.terminal("completed").await;
        assert_eq!(*log.closes.lock().unwrap(), [reason]);
        assert_eq!(log.stops.load(Ordering::SeqCst), 1);
        assert_eq!(log.opens.load(Ordering::SeqCst), 1);
        assert_eq!(log.live.load(Ordering::SeqCst), 0);
        assert_eq!(rig.supervisor.live_sessions().0, 0);
        assert!(
            log.cancels.lock().unwrap().is_empty(),
            "close reasons remain distinct from turn cancellation"
        );
    }
}
