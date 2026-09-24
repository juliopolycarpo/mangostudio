use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mango_external_agents::testing::{FakeHarness, FakeLauncher};
use mango_external_agents::{
    AccountUsage, CancelReason, CloseReason, Discovery, Error as SdkError, ExitStatus, Harness,
    HarnessDescriptor, HostContext, InterruptOutcome, Limits, OpenSession, PermissionMatrix,
    PermissionResponse, ProcessControl, Session, SessionPage, SessionQuery, SessionState,
    TurnRequest, TurnStream,
};
use mango_protocol::error::codes;
use mango_protocol::frame::PeerInfo;
use mango_protocol::port::port_pair;
use mango_protocol::session::{Session as HubSession, SessionOptions};
use serde_json::json;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::{
    CloseCause, ExecutableResolver, HarnessFactory, PortFuture, Ports, Supervisor,
    WorkspaceAuthority,
};
use crate::external_agents::wire::{
    ApprovalRouting, CloseParams, Configuration, DiscoverParams, ListSessionsParams, OpenParams,
    PermissionLevel, RefreshAccountUsageParams, ResumeMode, TargetId,
};
use crate::probing::detection::path_env::PathEnv;
use crate::test_support::ScratchDir;

// ---------------------------------------------------------------------------
// Named fakes
// ---------------------------------------------------------------------------

/// Everything a [`CountingHarness`] observed, shared with the test.
#[derive(Default)]
struct HarnessLog {
    opens: AtomicUsize,
    closes: Mutex<Vec<CloseReason>>,
    probes: AtomicUsize,
    listings: AtomicUsize,
    /// Set when a stalled probe or open observed the host's cancellation.
    saw_host_cancel: AtomicBool,
    turns_started: AtomicUsize,
    permission_answers: AtomicUsize,
    question_answers: AtomicUsize,
    cancels: AtomicUsize,
}

impl HarnessLog {
    fn opens(&self) -> usize {
        self.opens.load(Ordering::SeqCst)
    }

    fn closes(&self) -> Vec<CloseReason> {
        self.closes.lock().unwrap().clone()
    }
}

/// How a [`CountingHarness`] answers an open.
#[derive(Clone)]
enum OpenBehaviour {
    /// Opens the SDK's fake session straight away.
    Succeed,
    /// Waits until the gate reads `true`, then opens.
    Gated(watch::Receiver<bool>),
    /// Never finishes; records the host cancellation it is eventually told of.
    Stall,
    /// Waits for the host cancellation, then opens anyway: a vendor that
    /// answered while it was being told to stop.
    FinishWhenCancelled,
    /// Fails, handing back a child whose cleanup the host must finish.
    FailNeedingCleanup(Arc<CountingControl>),
    /// Opens a session whose every turn asks one single-choice question.
    AskingOneChoice,
}

/// How a [`CountingHarness`] answers a probe.
#[derive(Clone, Copy)]
enum ProbeBehaviour {
    Answer,
    Fail,
    Stall,
}

/// The SDK's `FakeHarness`, with every open, close, probe and listing counted,
/// and opens and probes that can be held, stalled or failed on demand.
struct CountingHarness {
    inner: FakeHarness,
    log: Arc<HarnessLog>,
    open: OpenBehaviour,
    probe: ProbeBehaviour,
}

#[async_trait::async_trait]
impl Harness for CountingHarness {
    fn descriptor(&self) -> &HarnessDescriptor {
        self.inner.descriptor()
    }

    fn permission_matrix(&self) -> PermissionMatrix {
        self.inner.permission_matrix()
    }

    async fn probe(&self, host: &HostContext) -> mango_external_agents::Result<Discovery> {
        self.log.probes.fetch_add(1, Ordering::SeqCst);
        match self.probe {
            ProbeBehaviour::Answer => self.inner.probe(host).await,
            ProbeBehaviour::Fail => Err(SdkError::Launch {
                program: String::from("fake-agent"),
                message: String::from("probe refused"),
            }),
            ProbeBehaviour::Stall => {
                host.cancel().cancelled().await;
                self.log.saw_host_cancel.store(true, Ordering::SeqCst);
                std::future::pending().await
            }
        }
    }

    async fn open_session(
        &self,
        host: &HostContext,
        request: OpenSession,
    ) -> mango_external_agents::Result<Box<dyn Session>> {
        self.log.opens.fetch_add(1, Ordering::SeqCst);
        match &self.open {
            OpenBehaviour::Succeed => {}
            OpenBehaviour::Gated(gate) => {
                let mut gate = gate.clone();
                while !*gate.borrow_and_update() {
                    if gate.changed().await.is_err() {
                        break;
                    }
                }
            }
            OpenBehaviour::Stall => {
                host.cancel().cancelled().await;
                self.log.saw_host_cancel.store(true, Ordering::SeqCst);
                std::future::pending::<()>().await;
            }
            OpenBehaviour::FinishWhenCancelled => {
                host.cancel().cancelled().await;
                self.log.saw_host_cancel.store(true, Ordering::SeqCst);
            }
            OpenBehaviour::AskingOneChoice => {}
            OpenBehaviour::FailNeedingCleanup(control) => {
                return Err(SdkError::CleanupRequired {
                    control: Arc::clone(control) as Arc<dyn ProcessControl>,
                    source: Box::new(SdkError::Launch {
                        program: String::from("fake-agent"),
                        message: String::from("handshake failed"),
                    }),
                });
            }
        }
        let inner = self.inner.open_session(host, request).await?;
        if matches!(self.open, OpenBehaviour::AskingOneChoice) {
            return Ok(Box::new(OneChoiceSession {
                inner,
                log: Arc::clone(&self.log),
                host: host.clone(),
                sink: tokio::sync::Mutex::new(None),
            }));
        }
        Ok(Box::new(CountingSession {
            inner,
            log: Arc::clone(&self.log),
        }))
    }

    async fn list_native_sessions(
        &self,
        _host: &HostContext,
        _query: SessionQuery,
    ) -> mango_external_agents::Result<SessionPage> {
        self.log.listings.fetch_add(1, Ordering::SeqCst);
        Ok(SessionPage {
            sessions: Vec::new(),
            next_cursor: None,
            truncated: false,
        })
    }
}

/// Delegates to the SDK's fake session and records every close reason.
struct CountingSession {
    inner: Box<dyn Session>,
    log: Arc<HarnessLog>,
}

#[async_trait::async_trait]
impl Session for CountingSession {
    fn state(&self) -> &SessionState {
        self.inner.state()
    }

    async fn start_turn(&self, request: TurnRequest) -> mango_external_agents::Result<TurnStream> {
        self.log.turns_started.fetch_add(1, Ordering::SeqCst);
        self.inner.start_turn(request).await
    }

    async fn respond(&self, response: PermissionResponse) -> mango_external_agents::Result<()> {
        self.log.permission_answers.fetch_add(1, Ordering::SeqCst);
        self.inner.respond(response).await
    }

    async fn answer(
        &self,
        response: mango_external_agents::QuestionResponse,
    ) -> mango_external_agents::Result<()> {
        self.log.question_answers.fetch_add(1, Ordering::SeqCst);
        self.inner.answer(response).await
    }

    async fn steer(
        &self,
        steer: mango_external_agents::Steer,
    ) -> mango_external_agents::Result<mango_external_agents::SteerOutcome> {
        self.inner.steer(steer).await
    }

    async fn cancel(&self, reason: CancelReason) -> mango_external_agents::Result<()> {
        self.log.cancels.fetch_add(1, Ordering::SeqCst);
        self.inner.cancel(reason).await
    }

    async fn close(&self, reason: CloseReason) -> mango_external_agents::Result<()> {
        self.log.closes.lock().unwrap().push(reason);
        self.inner.close(reason).await
    }

    async fn refresh_account_usage(&self) -> mango_external_agents::Result<AccountUsage> {
        Ok(AccountUsage { limits: None })
    }
}

/// A session whose turn asks exactly one single-choice question — the one
/// question shape the product can show — and ends once it is answered. Every
/// answer is counted by the route it arrived on.
struct OneChoiceSession {
    inner: Box<dyn Session>,
    log: Arc<HarnessLog>,
    host: HostContext,
    sink: tokio::sync::Mutex<Option<mango_external_agents::EventSink>>,
}

#[async_trait::async_trait]
impl Session for OneChoiceSession {
    fn state(&self) -> &SessionState {
        self.inner.state()
    }

    async fn start_turn(&self, request: TurnRequest) -> mango_external_agents::Result<TurnStream> {
        use mango_external_agents::{
            EventKind, EventSink, Interaction, InteractionId, InteractionKind, Question,
            QuestionForm, QuestionId, QuestionOption, QuestionOptionId, QuestionRequest,
        };
        self.log.turns_started.fetch_add(1, Ordering::SeqCst);
        let session_id = self.snapshot().ids.session_id.clone();
        let (sink, events) = EventSink::with_limits(
            session_id.clone(),
            request.turn_id.clone(),
            request.attempt,
            Arc::clone(self.host.clock()),
            self.host.limits(),
        );
        let question = QuestionRequest::new(
            Interaction::new(
                InteractionId::new("choice-1"),
                InteractionKind::Question,
                session_id,
                self.host.now() + Duration::from_secs(300),
            )
            .during(sink.operation()),
            vec![Question::new(
                QuestionId::new("pick"),
                "Which one?",
                QuestionForm::Choice {
                    options: vec![
                        QuestionOption::new(QuestionOptionId::new("left")).with_label("Left"),
                        QuestionOption::new(QuestionOptionId::new("right")).with_label("Right"),
                    ],
                    multi_select: false,
                },
            )],
        );
        sink.emit(EventKind::QuestionAsked { request: question })
            .await?;
        *self.sink.lock().await = Some(sink);
        Ok(TurnStream::accepted(
            request.turn_id,
            request.attempt,
            "choice-turn",
            events,
        ))
    }

    async fn respond(&self, _response: PermissionResponse) -> mango_external_agents::Result<()> {
        self.log.permission_answers.fetch_add(1, Ordering::SeqCst);
        Err(SdkError::Protocol {
            expected: String::from("an answer to the question"),
            received: String::from("a permission response"),
        })
    }

    async fn answer(
        &self,
        response: mango_external_agents::QuestionResponse,
    ) -> mango_external_agents::Result<()> {
        use mango_external_agents::{AnswerValue, EventKind, QuestionOutcome};
        // As strict as a vendor: an answer for another interaction or
        // question, or a choice it never offered, is refused.
        let routed = response.interaction_id.as_str() == "choice-1"
            && matches!(response.answers.as_slice(), [answer]
                if answer.question_id.as_str() == "pick"
                    && matches!(&answer.value, AnswerValue::Chosen { option_ids }
                        if option_ids.iter().map(|id| id.as_str()).eq(["right"])));
        if !routed {
            return Err(SdkError::Protocol {
                expected: String::from("the answer to choice-1/pick"),
                received: String::from("an answer routed elsewhere"),
            });
        }
        self.log.question_answers.fetch_add(1, Ordering::SeqCst);
        if let Some(sink) = self.sink.lock().await.take() {
            sink.emit(EventKind::QuestionResolved {
                interaction_id: response.interaction_id.clone(),
                outcome: QuestionOutcome::Answered {
                    answers: response.answers,
                },
            })
            .await?;
            sink.complete().await?;
        }
        Ok(())
    }

    async fn cancel(&self, _reason: CancelReason) -> mango_external_agents::Result<()> {
        self.log.cancels.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn close(&self, reason: CloseReason) -> mango_external_agents::Result<()> {
        self.log.closes.lock().unwrap().push(reason);
        self.inner.close(reason).await
    }
}

/// A child the SDK handed back for cleanup: counts the kill and the wait.
#[derive(Default)]
struct CountingControl {
    kills: AtomicUsize,
    waits: AtomicUsize,
}

#[async_trait::async_trait]
impl ProcessControl for CountingControl {
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

    async fn interrupt(
        &self,
        _reason: CancelReason,
    ) -> mango_external_agents::Result<InterruptOutcome> {
        Ok(InterruptOutcome::Unsupported)
    }

    async fn kill(&self, _reason: CancelReason) -> mango_external_agents::Result<()> {
        self.kills.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

/// Builds [`CountingHarness`]es that all report to one log, with a per-target
/// probe behaviour.
struct CountingHarnesses {
    log: Arc<HarnessLog>,
    fake: FakeHarness,
    open: OpenBehaviour,
    probes: Mutex<Vec<(TargetId, ProbeBehaviour)>>,
}

impl HarnessFactory for CountingHarnesses {
    fn harness(&self, target: TargetId, _executable: Option<PathBuf>) -> Arc<dyn Harness> {
        let probe = self
            .probes
            .lock()
            .unwrap()
            .iter()
            .find(|(candidate, _)| *candidate == target)
            .map_or(ProbeBehaviour::Answer, |(_, behaviour)| *behaviour);
        Arc::new(CountingHarness {
            inner: self.fake.clone(),
            log: Arc::clone(&self.log),
            open: self.open.clone(),
            probe,
        })
    }
}

/// Authorises exactly the directories it was given, and counts every ask.
struct AllowListedWorkspaces {
    allowed: BTreeSet<PathBuf>,
    asks: AtomicUsize,
    /// When set, every answer waits until the gate reads `true`.
    gate: Option<watch::Receiver<bool>>,
}

impl WorkspaceAuthority for AllowListedWorkspaces {
    fn authorize<'a>(&'a self, canonical: &'a Path) -> PortFuture<'a, bool> {
        self.asks.fetch_add(1, Ordering::SeqCst);
        let allowed = self.allowed.contains(canonical);
        let gate = self.gate.clone();
        Box::pin(async move {
            if let Some(mut gate) = gate {
                while !*gate.borrow_and_update() {
                    if gate.changed().await.is_err() {
                        break;
                    }
                }
            }
            allowed
        })
    }
}

/// Resolves every target to a fixed path, or to nothing, and counts lookups.
struct FixedExecutables {
    installed: bool,
    lookups: AtomicUsize,
}

impl ExecutableResolver for FixedExecutables {
    fn resolve<'a>(
        &'a self,
        target: TargetId,
        _cancel: &'a CancellationToken,
    ) -> PortFuture<'a, Option<PathBuf>> {
        self.lookups.fetch_add(1, Ordering::SeqCst);
        let path = self
            .installed
            .then(|| PathBuf::from(format!("/fake/bin/{}", target.as_str())));
        Box::pin(async move { path })
    }
}

/// A test rig: a supervisor over the fakes above, a canonical authorised
/// workspace, and the hub session it serves, kept open by its peer port.
struct Rig {
    supervisor: Arc<Supervisor>,
    log: Arc<HarnessLog>,
    workspaces: Arc<AllowListedWorkspaces>,
    executables: Arc<FixedExecutables>,
    consent: Arc<AtomicBool>,
    hub: HubSession,
    /// The hub's side of the connection, kept open for the rig's lifetime.
    _observer: HubSession,
    events: tokio::sync::Mutex<mango_protocol::session::EventStream>,
    workspace: String,
    private_root: PathBuf,
    _dirs: (ScratchDir, ScratchDir),
}

struct RigOptions {
    open: OpenBehaviour,
    probes: Vec<(TargetId, ProbeBehaviour)>,
    authorize_workspace: bool,
    installed: bool,
    session_cap: usize,
    authority_gate: Option<watch::Receiver<bool>>,
    fake: FakeHarness,
}

impl Default for RigOptions {
    fn default() -> Self {
        Self {
            open: OpenBehaviour::Succeed,
            probes: Vec::new(),
            authorize_workspace: true,
            installed: true,
            session_cap: super::DEFAULT_SESSION_CAP,
            authority_gate: None,
            fake: FakeHarness::new(),
        }
    }
}

async fn handshaken_pair() -> (HubSession, HubSession) {
    let (port, peer) = port_pair();
    let peer_info = |role: &str| PeerInfo {
        name: "external-agent-test".into(),
        version: "0.1.0".into(),
        role: role.into(),
    };
    let (runtime, _runtime_driver) =
        HubSession::spawn(port, SessionOptions::new(peer_info("runtime")));
    let (hub, _hub_driver) = HubSession::spawn(peer, SessionOptions::new(peer_info("hub")));
    let (ran, hubbed) = tokio::join!(runtime.ready(), hub.ready());
    ran.expect("the runtime side completes its handshake");
    hubbed.expect("the hub side completes its handshake");
    (runtime, hub)
}

async fn rig(options: RigOptions) -> Rig {
    let workspace_dir = ScratchDir::created("agent-workspace");
    let private_dir = ScratchDir::created("agent-private");
    let workspace = super::canonical_directory(workspace_dir.path()).unwrap();
    let log = Arc::new(HarnessLog::default());
    let workspaces = Arc::new(AllowListedWorkspaces {
        allowed: if options.authorize_workspace {
            BTreeSet::from([workspace.clone()])
        } else {
            BTreeSet::new()
        },
        asks: AtomicUsize::new(0),
        gate: options.authority_gate,
    });
    let executables = Arc::new(FixedExecutables {
        installed: options.installed,
        lookups: AtomicUsize::new(0),
    });
    let consent = Arc::new(AtomicBool::new(true));
    let consent_read = Arc::clone(&consent);
    let private_root = private_dir.path().join("external-agents");
    let supervisor = Supervisor::new(Ports {
        launcher: Arc::new(FakeLauncher::new()),
        harnesses: Arc::new(CountingHarnesses {
            log: Arc::clone(&log),
            fake: options.fake,
            open: options.open,
            probes: Mutex::new(options.probes),
        }),
        workspaces: Arc::clone(&workspaces) as Arc<dyn WorkspaceAuthority>,
        executables: Arc::clone(&executables) as Arc<dyn ExecutableResolver>,
        environment: Arc::new(PathEnv::default),
        consent: Arc::new(move || consent_read.load(Ordering::SeqCst)),
        private_root: private_root.clone(),
        runtime_version: String::from("0.0.0-test"),
        limits: Limits::default(),
        session_cap: options.session_cap,
        consent_poll: Duration::from_millis(10),
        cleanup_timeout: Duration::from_secs(2),
    });
    let (hub, observer) = handshaken_pair().await;
    let events = tokio::sync::Mutex::new(observer.events());
    Rig {
        supervisor,
        log,
        workspaces,
        executables,
        consent,
        hub,
        _observer: observer,
        events,
        workspace: workspace.to_string_lossy().into_owned(),
        private_root,
        _dirs: (workspace_dir, private_dir),
    }
}

impl Rig {
    fn open_params(&self, session_id: &str) -> OpenParams {
        OpenParams {
            session_id: session_id.into(),
            target_id: TargetId::Claude,
            workspace_path: self.workspace.clone(),
            configuration: Configuration {
                model: None,
                effort: None,
                level: PermissionLevel::Default,
                routing: ApprovalRouting::User,
                workspace_roots: Vec::new(),
            },
            resume_ref: None,
            resume_mode: ResumeMode::Fallback,
            timeout_ms: 5_000,
            toolchain: None,
        }
    }

    async fn open(
        &self,
        session_id: &str,
    ) -> Result<crate::external_agents::wire::OpenResult, mango_protocol::error::RemoteError> {
        self.supervisor
            .open(
                self.open_params(session_id),
                &self.hub,
                &CancellationToken::new(),
            )
            .await
    }

    async fn close(&self, session_id: &str) {
        self.supervisor
            .close_session(
                CloseParams {
                    session_id: session_id.into(),
                },
                CloseCause::Requested,
            )
            .await
            .unwrap_or_else(|error| {
                panic!("expected close of {session_id:?} to succeed | received: {error}")
            });
    }

    fn live_count(&self) -> usize {
        self.supervisor.live_sessions().0
    }
}

/// Polls `condition` until it holds, failing with the last value it saw.
async fn eventually<T: std::fmt::Debug>(
    what: &str,
    mut read: impl FnMut() -> T,
    holds: impl Fn(&T) -> bool,
) {
    let mut last = read();
    for _ in 0..400 {
        if holds(&last) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
        last = read();
    }
    panic!("expected {what} | last seen: {last:?}");
}

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_unauthorized_workspace_is_refused_before_any_lookup_or_launch() {
    let rig = rig(RigOptions {
        authorize_workspace: false,
        ..RigOptions::default()
    })
    .await;
    let error = rig
        .open("one")
        .await
        .expect_err("an unauthorized open must fail");
    assert!(
        error.message.contains("is not authorized"),
        "expected an authorization refusal | received: {}",
        error.message
    );
    assert_eq!(
        (
            rig.workspaces.asks.load(Ordering::SeqCst),
            rig.executables.lookups.load(Ordering::SeqCst),
            rig.log.opens()
        ),
        (1, 0, 0),
        "expected (authority asks, executable lookups, vendor opens) = (1, 0, 0)"
    );
    assert_eq!(rig.live_count(), 0);
}

#[tokio::test]
async fn the_production_authority_denies_every_workspace() {
    let authority = super::DenyEveryWorkspace;
    assert!(
        !authority.authorize(Path::new("/")).await,
        "expected the production workspace authority to deny | received: allow"
    );
}

#[tokio::test]
async fn a_non_canonical_workspace_is_refused_without_asking_the_authority() {
    let rig = rig(RigOptions::default()).await;
    let mut params = rig.open_params("one");
    params.workspace_path = format!("{}/.", rig.workspace);
    let error = rig
        .supervisor
        .open(params, &rig.hub, &CancellationToken::new())
        .await
        .expect_err("a non-canonical workspace must be refused");
    assert!(
        error.message.contains("is not canonical"),
        "expected a canonical-form refusal | received: {}",
        error.message
    );
    assert_eq!(rig.workspaces.asks.load(Ordering::SeqCst), 0);
    assert_eq!(rig.log.opens(), 0);
}

#[tokio::test]
async fn every_extra_workspace_root_is_authorized_at_open() {
    let rig = rig(RigOptions::default()).await;
    let outside = ScratchDir::created("agent-outside");
    let mut params = rig.open_params("one");
    params.configuration.workspace_roots = vec![
        super::canonical_directory(outside.path())
            .unwrap()
            .to_string_lossy()
            .into_owned(),
    ];
    let error = rig
        .supervisor
        .open(params, &rig.hub, &CancellationToken::new())
        .await
        .expect_err("an unauthorized extra root must refuse the whole open");
    assert!(
        error.message.contains("is not authorized"),
        "received: {}",
        error.message
    );
    assert_eq!(
        rig.log.opens(),
        0,
        "expected no vendor open for a refused root"
    );
}

#[tokio::test]
async fn cursor_auto_review_is_refused_before_any_launch() {
    let rig = rig(RigOptions::default()).await;
    let mut params = rig.open_params("one");
    params.target_id = TargetId::Cursor;
    params.configuration.routing = ApprovalRouting::AutoReview;
    let error = rig
        .supervisor
        .open(params, &rig.hub, &CancellationToken::new())
        .await
        .expect_err("Cursor auto-review must be refused");
    assert!(
        error.message.contains("does not offer auto-review"),
        "received: {}",
        error.message
    );
    assert_eq!(
        (
            rig.log.opens(),
            rig.executables.lookups.load(Ordering::SeqCst)
        ),
        (0, 0),
        "expected (vendor opens, executable lookups) = (0, 0)"
    );
}

#[tokio::test]
async fn a_target_that_is_not_installed_is_refused_without_a_launch() {
    let rig = rig(RigOptions {
        installed: false,
        ..RigOptions::default()
    })
    .await;
    let error = rig
        .open("one")
        .await
        .expect_err("an uninstalled target must fail");
    assert!(
        error.message.contains("is not installed"),
        "received: {}",
        error.message
    );
    assert_eq!(rig.log.opens(), 0);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_repeated_open_answers_without_a_second_launch() {
    let rig = rig(RigOptions::default()).await;
    let first = rig.open("one").await.unwrap();
    let second = rig.open("one").await.unwrap();
    assert_eq!(first, second);
    assert_eq!(
        rig.log.opens(),
        1,
        "expected one vendor open for a repeated id"
    );

    let mut other_target = rig.open_params("one");
    other_target.target_id = TargetId::Codex;
    let error = rig
        .supervisor
        .open(other_target, &rig.hub, &CancellationToken::new())
        .await
        .expect_err("the same id for another target must be refused");
    assert!(
        error.message.contains("already belongs to target"),
        "received: {}",
        error.message
    );
    rig.close("one").await;
}

#[tokio::test]
async fn a_resumed_open_carries_the_native_session_and_says_it_resumed() {
    let rig = rig(RigOptions::default()).await;
    for (session_id, mode) in [
        ("strict", ResumeMode::Strict),
        ("fallback", ResumeMode::Fallback),
    ] {
        let mut params = rig.open_params(session_id);
        params.resume_ref = Some(format!("native-{session_id}"));
        params.resume_mode = mode;
        let opened = rig
            .supervisor
            .open(params, &rig.hub, &CancellationToken::new())
            .await
            .unwrap_or_else(|error| {
                panic!("expected a {mode:?} resume to open | received: {error}")
            });
        assert_eq!(
            (opened.native_session_id.as_str(), opened.resumed),
            (format!("native-{session_id}").as_str(), true),
            "expected ({mode:?}) the vendor's own session, reported as resumed"
        );
        rig.close(session_id).await;
    }
    let fresh = rig.open("fresh").await.unwrap();
    assert!(
        !fresh.resumed,
        "expected an open without a resume ref to start fresh"
    );
    rig.close("fresh").await;
}

#[tokio::test]
async fn concurrent_opens_of_one_id_share_one_launch() {
    let (release, gate) = watch::channel(false);
    let rig = rig(RigOptions {
        open: OpenBehaviour::Gated(gate),
        ..RigOptions::default()
    })
    .await;
    let (first, second, ()) = tokio::join!(rig.open("one"), rig.open("one"), async {
        eventually(
            "the first open to reach the vendor",
            || rig.log.opens(),
            |opens| *opens == 1,
        )
        .await;
        release.send_replace(true);
    });
    assert_eq!(first.unwrap(), second.unwrap());
    assert_eq!(
        rig.log.opens(),
        1,
        "expected the joined open to launch once"
    );
    rig.close("one").await;
}

#[tokio::test]
async fn the_session_cap_counts_opening_sessions() {
    let (release, gate) = watch::channel(false);
    let rig = rig(RigOptions {
        open: OpenBehaviour::Gated(gate),
        session_cap: 1,
        ..RigOptions::default()
    })
    .await;
    let supervisor = Arc::clone(&rig.supervisor);
    let hub = rig.hub.clone();
    let params = rig.open_params("one");
    let held = tokio::spawn(async move {
        supervisor
            .open(params, &hub, &CancellationToken::new())
            .await
    });
    eventually(
        "the first open to reach the vendor",
        || rig.log.opens(),
        |opens| *opens == 1,
    )
    .await;
    let error = rig
        .open("two")
        .await
        .expect_err("a second session past the cap must fail");
    assert!(
        error.message.contains("capacity is 1"),
        "expected a capacity refusal | received: {}",
        error.message
    );
    release.send_replace(true);
    held.await.unwrap().unwrap();
    rig.close("one").await;
}

#[tokio::test]
async fn closing_a_live_session_is_idempotent_awaited_and_removes_its_scratch() {
    let rig = rig(RigOptions::default()).await;
    rig.open("one").await.unwrap();
    let scratch_root = rig.private_root.join("scratch");
    let leaves: Vec<_> = std::fs::read_dir(&scratch_root).unwrap().collect();
    assert_eq!(
        leaves.len(),
        1,
        "expected one scratch leaf while the session is live"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&scratch_root)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            mode, 0o700,
            "expected an owner-only scratch root | received: {mode:o}"
        );
    }

    let (first, second) = tokio::join!(
        rig.supervisor.close_session(
            CloseParams {
                session_id: "one".into()
            },
            CloseCause::Requested
        ),
        rig.supervisor.close_session(
            CloseParams {
                session_id: "one".into()
            },
            CloseCause::Requested
        ),
    );
    first.unwrap();
    second.unwrap();
    assert_eq!(
        rig.log.closes(),
        vec![CloseReason::Requested],
        "expected exactly one vendor close"
    );
    assert_eq!(rig.live_count(), 0);
    assert_eq!(
        std::fs::read_dir(&scratch_root).unwrap().count(),
        0,
        "expected the session's scratch leaf removed by the time close returned"
    );
    rig.close("one").await;
    assert_eq!(
        rig.log.closes().len(),
        1,
        "expected a close of an unknown id to do nothing"
    );
}

#[tokio::test]
async fn closing_an_opening_session_cancels_it_and_waits_for_it_to_settle() {
    let rig = rig(RigOptions {
        open: OpenBehaviour::Stall,
        ..RigOptions::default()
    })
    .await;
    let supervisor = Arc::clone(&rig.supervisor);
    let hub = rig.hub.clone();
    let params = rig.open_params("one");
    let opening = tokio::spawn(async move {
        supervisor
            .open(params, &hub, &CancellationToken::new())
            .await
    });
    eventually(
        "the open to reach the vendor",
        || rig.log.opens(),
        |opens| *opens == 1,
    )
    .await;
    rig.close("one").await;
    assert!(
        rig.log.saw_host_cancel.load(Ordering::SeqCst),
        "expected the stalled vendor open to be told to stop"
    );
    let error = opening
        .await
        .unwrap()
        .expect_err("a cancelled open must fail");
    assert_eq!(error.code, codes::CANCELLED, "received: {error:?}");
    assert_eq!(rig.live_count(), 0);
    assert!(
        rig.supervisor.slots().is_empty(),
        "expected no slot left behind"
    );
}

#[tokio::test]
async fn an_open_that_finishes_after_a_close_was_requested_is_closed_not_registered() {
    let rig = rig(RigOptions::default()).await;
    let opening = rig
        .supervisor
        .admit(&rig.open_params("one"))
        .map(|admission| match admission {
            super::Admission::Fresh(opening) => opening,
            _ => panic!("expected a fresh reservation"),
        })
        .unwrap();
    // The close lands after the vendor answered but before registration.
    opening.cancel_with(CloseCause::ConsentRevoked);
    let live = rig
        .supervisor
        .run_open(
            rig.open_params("one"),
            &super::Opening {
                target: TargetId::Claude,
                cancel: CancellationToken::new(),
                close_cause: Mutex::new(None),
                outcome: watch::channel(None).0,
                settled: watch::channel(false).0,
                cleanup_failure: Mutex::new(None),
            },
            rig.hub.clone(),
        )
        .await
        .unwrap();
    let error = rig
        .supervisor
        .register("one", &opening, live)
        .await
        .expect_err("a claimed open must not register");
    assert_eq!(error.code, codes::CANCELLED, "received: {error:?}");
    assert_eq!(
        rig.log.closes(),
        vec![CloseReason::ConsentRevoked],
        "expected the unregistered session closed for the recorded cause"
    );
    assert_eq!(rig.live_count(), 0);
}

#[tokio::test]
async fn an_open_bounded_by_its_deadline_tells_the_vendor_to_stop() {
    let rig = rig(RigOptions {
        open: OpenBehaviour::Stall,
        ..RigOptions::default()
    })
    .await;
    let mut params = rig.open_params("one");
    // Long enough that the vendor is reached well before it fires.
    params.timeout_ms = 500;
    let error = rig
        .supervisor
        .open(params, &rig.hub, &CancellationToken::new())
        .await
        .expect_err("a stalled open must time out");
    assert_eq!(error.code, codes::TIMEOUT, "received: {error:?}");
    eventually(
        "the stalled open to observe the host cancellation",
        || rig.log.saw_host_cancel.load(Ordering::SeqCst),
        |seen| *seen,
    )
    .await;
    assert!(
        rig.supervisor.slots().is_empty(),
        "expected the timed-out slot released"
    );
}

#[tokio::test]
async fn a_vendor_that_opens_while_being_stopped_is_closed_not_leaked() {
    let rig = rig(RigOptions {
        open: OpenBehaviour::FinishWhenCancelled,
        ..RigOptions::default()
    })
    .await;
    let supervisor = Arc::clone(&rig.supervisor);
    let hub = rig.hub.clone();
    let params = rig.open_params("one");
    let caller = CancellationToken::new();
    let caller_cancel = caller.clone();
    let opening = tokio::spawn(async move { supervisor.open(params, &hub, &caller).await });
    // Only once the vendor is mid-open does the hub give up on the call.
    eventually(
        "the open to reach the vendor",
        || rig.log.opens(),
        |opens| *opens == 1,
    )
    .await;
    caller_cancel.cancel();
    let error = opening
        .await
        .unwrap()
        .expect_err("a cancelled open must fail");
    assert_eq!(error.code, codes::CANCELLED, "received: {error:?}");
    eventually(
        "the session the vendor opened late to be closed",
        || rig.log.closes(),
        |closes| !closes.is_empty(),
    )
    .await;
    assert_eq!(
        rig.log.closes(),
        vec![CloseReason::Requested],
        "expected the session the vendor opened late to be closed once"
    );
    eventually("no live session", || rig.live_count(), |live| *live == 0).await;
    eventually(
        "the late session's scratch removed",
        || {
            std::fs::read_dir(rig.private_root.join("scratch"))
                .unwrap()
                .count()
        },
        |leaves| *leaves == 0,
    )
    .await;
}

#[tokio::test]
async fn a_child_the_sdk_could_not_clean_up_is_reaped_before_the_failure_returns() {
    let control = Arc::new(CountingControl::default());
    let rig = rig(RigOptions {
        open: OpenBehaviour::FailNeedingCleanup(Arc::clone(&control)),
        ..RigOptions::default()
    })
    .await;
    let error = rig.open("one").await.expect_err("the open must fail");
    assert!(
        error
            .details
            .as_ref()
            .is_none_or(|details| !details.contains_key("cleanupRequired")),
        "expected no cleanupRequired once the child was reaped | received: {:?}",
        error.details
    );
    assert_eq!(
        (
            control.kills.load(Ordering::SeqCst),
            control.waits.load(Ordering::SeqCst)
        ),
        (1, 1),
        "expected the handed-back child killed and awaited once"
    );
    assert_eq!(
        std::fs::read_dir(rig.private_root.join("scratch"))
            .unwrap()
            .count(),
        0,
        "expected the failed open's scratch leaf removed"
    );
}

// ---------------------------------------------------------------------------
// Consent and hub lifetime
// ---------------------------------------------------------------------------

#[tokio::test]
async fn withdrawing_consent_closes_every_live_session_for_that_reason() {
    let rig = rig(RigOptions::default()).await;
    rig.open("one").await.unwrap();
    rig.consent.store(false, Ordering::SeqCst);
    eventually(
        "the live session closed after revocation",
        || rig.live_count(),
        |live| *live == 0,
    )
    .await;
    assert_eq!(rig.log.closes(), vec![CloseReason::ConsentRevoked]);
}

#[tokio::test]
async fn the_hub_session_ending_shuts_every_session_down() {
    let rig = rig(RigOptions::default()).await;
    rig.open("one").await.unwrap();
    rig.hub.close_now(4000, None);
    eventually(
        "the live session closed at hub shutdown",
        || rig.live_count(),
        |live| *live == 0,
    )
    .await;
    assert_eq!(rig.log.closes(), vec![CloseReason::Shutdown]);
    let error = rig
        .open("two")
        .await
        .expect_err("a closed supervisor must refuse opens");
    assert!(
        error.message.contains("is closed"),
        "received: {}",
        error.message
    );
}

// ---------------------------------------------------------------------------
// Workspace-free services
// ---------------------------------------------------------------------------

#[tokio::test]
async fn discovery_omits_a_failing_target_and_keeps_the_rest() {
    let rig = rig(RigOptions {
        probes: vec![(TargetId::Cursor, ProbeBehaviour::Fail)],
        ..RigOptions::default()
    })
    .await;
    let result = rig
        .supervisor
        .discover(
            DiscoverParams {
                target_ids: vec![TargetId::Claude, TargetId::Cursor],
                timeout_ms: 5_000,
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let targets: Vec<_> = result
        .descriptors
        .iter()
        .map(|descriptor| descriptor.target_id)
        .collect();
    assert_eq!(
        targets,
        vec![TargetId::Claude],
        "expected only the answering target"
    );
    assert_eq!(
        rig.log.opens(),
        0,
        "expected discovery to open no conversation"
    );
}

#[tokio::test]
async fn discovery_where_nothing_answers_is_a_failure() {
    let rig = rig(RigOptions {
        probes: vec![(TargetId::Claude, ProbeBehaviour::Fail)],
        ..RigOptions::default()
    })
    .await;
    let error = rig
        .supervisor
        .discover(
            DiscoverParams {
                target_ids: vec![TargetId::Claude],
                timeout_ms: 5_000,
            },
            &CancellationToken::new(),
        )
        .await
        .expect_err("a batch where nothing answered must fail");
    assert!(
        error.message.contains("probe refused"),
        "received: {}",
        error.message
    );
}

#[tokio::test]
async fn a_stalled_probe_costs_only_its_own_target_and_is_told_to_stop() {
    let rig = rig(RigOptions {
        probes: vec![(TargetId::Cursor, ProbeBehaviour::Stall)],
        ..RigOptions::default()
    })
    .await;
    let result = rig
        .supervisor
        .discover(
            DiscoverParams {
                target_ids: vec![TargetId::Claude, TargetId::Cursor],
                timeout_ms: 50,
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.descriptors.len(), 1);
    eventually(
        "the stalled probe to observe the host cancellation",
        || rig.log.saw_host_cancel.load(Ordering::SeqCst),
        |seen| *seen,
    )
    .await;
}

#[tokio::test]
async fn listing_sessions_never_opens_a_conversation_and_authorizes_its_workspace() {
    let rig = rig(RigOptions::default()).await;
    let listed = rig
        .supervisor
        .list_sessions(
            ListSessionsParams {
                target_id: TargetId::Claude,
                workspace_path: Some(rig.workspace.clone()),
                cursor: None,
                limit: None,
                session_id: None,
                timeout_ms: 5_000,
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(listed.sessions.is_empty());
    assert_eq!(
        (
            rig.log.listings.load(Ordering::SeqCst),
            rig.log.opens(),
            rig.workspaces.asks.load(Ordering::SeqCst)
        ),
        (1, 0, 1),
        "expected (listings, opens, authority asks) = (1, 0, 1)"
    );

    let refused = self::rig(RigOptions {
        authorize_workspace: false,
        ..RigOptions::default()
    })
    .await;
    let error = refused
        .supervisor
        .list_sessions(
            ListSessionsParams {
                target_id: TargetId::Claude,
                workspace_path: Some(refused.workspace.clone()),
                cursor: None,
                limit: None,
                session_id: None,
                timeout_ms: 5_000,
            },
            &CancellationToken::new(),
        )
        .await
        .expect_err("an unauthorized listing workspace must be refused");
    assert!(
        error.message.contains("is not authorized"),
        "received: {}",
        error.message
    );
    assert_eq!(refused.log.listings.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn account_usage_without_a_live_session_is_nothing_to_report() {
    let rig = rig(RigOptions::default()).await;
    let result = rig
        .supervisor
        .refresh_account_usage(
            RefreshAccountUsageParams {
                target_id: TargetId::Claude,
                session_id: None,
                timeout_ms: 5_000,
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(result).unwrap(), json!({}));
    assert_eq!(
        rig.log.opens(),
        0,
        "expected no conversation opened to read usage"
    );
}

#[tokio::test]
async fn account_usage_refuses_a_live_session_of_another_target() {
    let rig = rig(RigOptions::default()).await;
    rig.open("one").await.unwrap();
    let error = rig
        .supervisor
        .refresh_account_usage(
            RefreshAccountUsageParams {
                target_id: TargetId::Codex,
                session_id: Some("one".into()),
                timeout_ms: 5_000,
            },
            &CancellationToken::new(),
        )
        .await
        .expect_err("another target's session must be refused");
    assert!(
        error.message.contains("belongs to"),
        "received: {}",
        error.message
    );
    rig.close("one").await;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

#[tokio::test]
async fn health_reports_live_sessions_and_withholds_a_withdrawn_attestation() {
    let rig = rig(RigOptions::default()).await;
    rig.open("one").await.unwrap();

    let reported = rig.supervisor.health(false).await;
    assert_eq!(reported["targets"], json!(["codex", "cursor", "claude"]));
    assert_eq!(reported["liveSessionCount"], json!(1));
    assert_eq!(reported["liveSessions"][0]["sessionId"], json!("one"));
    assert_eq!(reported["liveSessions"][0]["targetId"], json!("claude"));
    assert_eq!(reported["liveSessions"][0]["state"], json!("idle"));
    let attested = crate::external_agents::isolation::detect_external_agent_isolation();
    assert_eq!(
        reported.get("identityIsolation").cloned(),
        attested.map(|isolation| serde_json::to_value(isolation).unwrap()),
        "expected health to carry exactly this process's attestation"
    );

    let withdrawn = rig.supervisor.health(true).await;
    assert!(
        withdrawn.get("identityIsolation").is_none(),
        "expected no attestation once the hub withdrew it | received: {withdrawn}"
    );
    rig.close("one").await;
}

#[test]
fn only_an_explicit_withdrawal_in_the_hub_hello_withholds_attestation() {
    let hello = |value: serde_json::Value| {
        let serde_json::Value::Object(map) = json!({ "externalAgentIsolation": value }) else {
            unreachable!()
        };
        map
    };
    assert!(crate::external_agents::hub_withdrew_isolation(&hello(
        json!("withdrawn")
    )));
    assert!(!crate::external_agents::hub_withdrew_isolation(&hello(
        json!("single-user")
    )));
    assert!(!crate::external_agents::hub_withdrew_isolation(
        &serde_json::Map::new()
    ));
}

// ---------------------------------------------------------------------------
// Review regressions
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_open_stopped_before_it_launched_never_reaches_the_vendor() {
    let (release, gate) = watch::channel(false);
    let rig = rig(RigOptions {
        authority_gate: Some(gate),
        ..RigOptions::default()
    })
    .await;
    let supervisor = Arc::clone(&rig.supervisor);
    let hub = rig.hub.clone();
    let params = rig.open_params("one");
    let opening = tokio::spawn(async move {
        supervisor
            .open(params, &hub, &CancellationToken::new())
            .await
    });
    eventually(
        "the open to wait on the workspace authority",
        || rig.workspaces.asks.load(Ordering::SeqCst),
        |asks| *asks == 1,
    )
    .await;
    // The close lands while the open is still deciding; the authority then
    // says yes inside the grace the stop allows.
    let closing = rig.supervisor.close_session(
        CloseParams {
            session_id: "one".into(),
        },
        CloseCause::Requested,
    );
    let (closed, ()) = tokio::join!(closing, async {
        tokio::time::sleep(Duration::from_millis(20)).await;
        release.send_replace(true);
    });
    closed.unwrap();
    opening.await.unwrap().expect_err("a closed open must fail");
    assert_eq!(
        (
            rig.log.opens(),
            rig.executables.lookups.load(Ordering::SeqCst)
        ),
        (0, 0),
        "expected (vendor opens, executable lookups) = (0, 0) after a stop before launch"
    );
    let scratch = rig.private_root.join("scratch");
    assert!(
        !scratch.exists() || std::fs::read_dir(&scratch).unwrap().count() == 0,
        "expected no scratch created for an open stopped before launch"
    );
}

#[tokio::test]
async fn each_open_gets_its_own_scratch_leaf_even_for_one_session_id() {
    let rig = rig(RigOptions::default()).await;
    let first = rig.supervisor.session_scratch("same").unwrap();
    let second = rig.supervisor.session_scratch("same").unwrap();
    assert_ne!(
        first, second,
        "expected distinct leaves for two opens of one id"
    );
    assert!(
        first.is_dir() && second.is_dir(),
        "expected creating the second leaf to leave the first in place"
    );
}

#[test]
fn a_failed_late_cleanup_is_reported_by_the_close_that_waited_for_it() {
    let opening = super::Opening {
        target: TargetId::Claude,
        cancel: CancellationToken::new(),
        close_cause: Mutex::new(None),
        outcome: watch::channel(None).0,
        settled: watch::channel(false).0,
        cleanup_failure: Mutex::new(None),
    };
    assert!(opening.cleanup_outcome().is_ok());
    opening.record_cleanup(Err("the vendor close did not finish in time".into()));
    let error = opening
        .cleanup_outcome()
        .expect_err("a failed late cleanup must be reported");
    assert!(
        error.message.contains("did not finish in time"),
        "received: {}",
        error.message
    );
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

impl Rig {
    fn turn_params(&self, session_id: &str, client_message_id: &str, input: &str) -> TurnParams {
        TurnParams {
            session_id: session_id.into(),
            client_message_id: client_message_id.into(),
            input: input.into(),
            configuration: self.open_params(session_id).configuration,
            attachments: None,
        }
    }

    /// The next event the hub received, or a failure naming what was expected.
    async fn next_event(&self, expecting: &str) -> serde_json::Value {
        let mut events = self.events.lock().await;
        let received = tokio::time::timeout(Duration::from_secs(5), events.recv()).await;
        match received {
            Ok(Some(event)) => {
                assert_eq!(
                    event.topic, "external-agent.event",
                    "expected only turn events"
                );
                event.payload
            }
            Ok(None) => panic!("expected {expecting} | received: the hub session closed"),
            Err(_) => panic!("expected {expecting} | received: nothing within 5s"),
        }
    }

    /// Events up to and including the first of `kind`.
    async fn events_until(&self, kind: &str) -> Vec<serde_json::Value> {
        let mut seen = Vec::new();
        loop {
            let event = self.next_event(&format!("a {kind} event")).await;
            let done = event["event"]["type"] == kind;
            seen.push(event);
            if done {
                return seen;
            }
        }
    }
}

use crate::external_agents::wire::{
    CancelParams, RespondParams, SteerParams, SteerResult, TurnParams,
};

#[tokio::test]
async fn a_turn_streams_ordered_events_and_an_approval_round_trips() {
    let rig = rig(RigOptions::default()).await;
    rig.open("one").await.unwrap();
    let turn = rig
        .supervisor
        .turn(
            rig.turn_params("one", "m1", "fix it"),
            &CancellationToken::new(),
        )
        .await
        .unwrap();

    let events = rig.events_until("approval_requested").await;
    let sequences: Vec<u64> = events
        .iter()
        .map(|event| event["sequence"].as_u64().unwrap())
        .collect();
    assert_eq!(
        sequences,
        (1..=sequences.len() as u64).collect::<Vec<_>>(),
        "expected gap-free sequences"
    );
    for event in &events {
        assert_eq!(event["sessionId"], json!("one"));
        // Every event, the command catalog included, travels under this
        // turn's id: the hub drops one that names no turn once one began.
        assert_eq!(
            event["nativeTurnId"],
            json!(turn.native_turn_id),
            "received: {event}"
        );
    }
    assert!(
        events.iter().any(|event| event["event"]
            == json!({ "type": "commands_available", "commands": [{ "name": "review", "description": "Reviews the diff" }] })),
        "expected the session's command catalog on the wire | received: {events:?}"
    );
    assert!(
        events
            .iter()
            .any(|event| event["event"]
                == json!({ "type": "text_delta", "text": "working on fix it" })),
        "expected the vendor's text on the wire | received: {events:?}"
    );
    assert_eq!(rig.supervisor.live_sessions().1[0].state, "running");

    let request = &events.last().unwrap()["event"]["request"];
    let option = request["options"][0]["id"].as_str().unwrap().to_owned();
    rig.supervisor
        .respond(RespondParams {
            session_id: "one".into(),
            native_turn_id: turn.native_turn_id.clone(),
            request_id: request["requestId"].as_str().unwrap().into(),
            option_id: option,
        })
        .await
        .unwrap();
    let rest = rig.events_until("completed").await;
    assert!(
        rest.iter()
            .any(|event| event["event"]["type"] == "approval_resolved"),
        "expected the approval resolved on the wire | received: {rest:?}"
    );
    assert_eq!(rig.log.permission_answers.load(Ordering::SeqCst), 1);
    assert_eq!(rig.log.question_answers.load(Ordering::SeqCst), 0);
    eventually(
        "the session idle after its turn",
        || rig.supervisor.live_sessions().1[0].state,
        |state| *state == "idle",
    )
    .await;
    rig.close("one").await;
}

#[tokio::test]
async fn a_repeated_client_message_id_answers_without_a_second_turn() {
    let rig = rig(RigOptions::default()).await;
    rig.open("one").await.unwrap();
    let first = rig
        .supervisor
        .turn(
            rig.turn_params("one", "m1", "same"),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let again = rig
        .supervisor
        .turn(
            rig.turn_params("one", "m1", "same"),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(first, again);
    assert_eq!(
        rig.log.turns_started.load(Ordering::SeqCst),
        1,
        "expected one vendor turn for a repeated id"
    );
    let error = rig
        .supervisor
        .turn(
            rig.turn_params("one", "m1", "different"),
            &CancellationToken::new(),
        )
        .await
        .expect_err("a reused id with other input must be refused");
    assert!(
        error.message.contains("reused with different turn input"),
        "received: {}",
        error.message
    );
    rig.close("one").await;
}

#[tokio::test]
async fn a_second_turn_waits_for_the_first_to_end() {
    let rig = rig(RigOptions::default()).await;
    rig.open("one").await.unwrap();
    rig.supervisor
        .turn(
            rig.turn_params("one", "m1", "first"),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let error = rig
        .supervisor
        .turn(
            rig.turn_params("one", "m2", "second"),
            &CancellationToken::new(),
        )
        .await
        .expect_err("a second concurrent turn must be refused");
    assert!(
        error.message.contains("already has an active turn"),
        "received: {}",
        error.message
    );
    assert_eq!(rig.log.turns_started.load(Ordering::SeqCst), 1);
    rig.close("one").await;
}

#[tokio::test]
async fn a_turn_may_narrow_its_roots_but_never_widen_them() {
    let rig = rig(RigOptions::default()).await;
    rig.open("one").await.unwrap();
    let mut params = rig.turn_params("one", "m1", "go");
    params.configuration.workspace_roots = vec!["/somewhere/else".into()];
    let error = rig
        .supervisor
        .turn(params, &CancellationToken::new())
        .await
        .expect_err("an unopened root must be refused");
    assert!(
        error.message.contains("was not authorized when session"),
        "received: {}",
        error.message
    );
    let mut narrowed = rig.turn_params("one", "m2", "go");
    narrowed.configuration.workspace_roots = vec![rig.workspace.clone()];
    rig.supervisor
        .turn(narrowed, &CancellationToken::new())
        .await
        .expect("an opened root is allowed");
    assert_eq!(rig.log.turns_started.load(Ordering::SeqCst), 1);
    rig.close("one").await;
}

#[tokio::test]
async fn a_response_is_refused_for_an_unknown_request_or_another_turn() {
    let rig = rig(RigOptions::default()).await;
    rig.open("one").await.unwrap();
    let turn = rig
        .supervisor
        .turn(
            rig.turn_params("one", "m1", "go"),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let events = rig.events_until("approval_requested").await;
    let request = events.last().unwrap()["event"]["request"]["requestId"]
        .as_str()
        .unwrap()
        .to_owned();
    let respond = |native: &str, request: &str, option: &str| RespondParams {
        session_id: "one".into(),
        native_turn_id: native.into(),
        request_id: request.into(),
        option_id: option.into(),
    };
    let unknown = rig
        .supervisor
        .respond(respond(&turn.native_turn_id, "nope", "x"))
        .await;
    assert!(unknown.unwrap_err().message.contains("is not pending"));
    let other_turn = rig
        .supervisor
        .respond(respond("another-turn", &request, "x"))
        .await;
    assert!(other_turn.unwrap_err().message.contains("is not running"));
    let bad_option = rig
        .supervisor
        .respond(respond(&turn.native_turn_id, &request, "not-offered"))
        .await;
    assert!(
        bad_option.is_err(),
        "expected an option the vendor never offered to be refused"
    );
    assert_eq!(
        rig.log.permission_answers.load(Ordering::SeqCst),
        0,
        "expected no answer reached the vendor"
    );
    rig.close("one").await;
}

#[tokio::test]
async fn a_question_the_product_cannot_show_or_decline_fails_the_turn_explicitly() {
    // FakeHarness asks a round with a required free-text question: no card can
    // carry it, and the SDK refuses a decline of a required question.
    let rig = rig(RigOptions {
        fake: FakeHarness::new().without_approvals().asking_a_question(),
        ..RigOptions::default()
    })
    .await;
    rig.open("one").await.unwrap();
    rig.supervisor
        .turn(
            rig.turn_params("one", "m1", "ask me"),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let events = rig.events_until("error").await;
    let error = &events.last().unwrap()["event"]["error"];
    assert_eq!(
        error["code"],
        json!("unsupported-question"),
        "received: {error}"
    );
    assert!(
        !events
            .iter()
            .any(|event| event["event"]["type"] == "approval_requested"),
        "expected no approval card for a question the product cannot show"
    );
    assert_eq!(
        (
            rig.log.question_answers.load(Ordering::SeqCst),
            rig.log.permission_answers.load(Ordering::SeqCst)
        ),
        (1, 0),
        "expected (question declines attempted, permission answers) = (1, 0)"
    );
    eventually(
        "the refused turn cancelled",
        || rig.log.cancels.load(Ordering::SeqCst),
        |cancels| *cancels == 1,
    )
    .await;
    eventually(
        "the session idle after the refused turn",
        || rig.supervisor.live_sessions().1[0].state,
        |state| *state == "idle",
    )
    .await;
    rig.close("one").await;
}

#[tokio::test]
async fn steering_is_answered_not_thrown_when_it_cannot_land() {
    let rig = rig(RigOptions::default()).await;
    rig.open("one").await.unwrap();
    let steer = |native: &str, id: &str| SteerParams {
        session_id: "one".into(),
        native_turn_id: native.into(),
        client_message_id: id.into(),
        input: "more".into(),
    };
    let idle = rig.supervisor.steer(steer("none", "s1")).await.unwrap();
    assert_eq!(
        serde_json::to_value(idle).unwrap(),
        json!({ "accepted": false, "reasonCode": "turn-already-completed" })
    );
    let turn = rig
        .supervisor
        .turn(
            rig.turn_params("one", "m1", "go"),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    rig.events_until("approval_requested").await;
    let first = rig
        .supervisor
        .steer(steer(&turn.native_turn_id, "s2"))
        .await
        .unwrap();
    assert_eq!(first, SteerResult::ACCEPTED);
    let reused = rig
        .supervisor
        .steer(steer(&turn.native_turn_id, "s2"))
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(reused).unwrap(),
        json!({ "accepted": false, "reasonCode": "id-reused" })
    );
    rig.close("one").await;
}

#[tokio::test]
async fn cancelling_a_turn_ends_it_with_the_marker_before_completion_and_frees_the_session() {
    let rig = rig(RigOptions::default()).await;
    rig.open("one").await.unwrap();
    rig.supervisor
        .turn(
            rig.turn_params("one", "m1", "go"),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    rig.events_until("approval_requested").await;
    rig.supervisor
        .cancel(CancelParams {
            session_id: "one".into(),
            native_turn_id: None,
        })
        .await
        .unwrap();
    let rest = rig.events_until("completed").await;
    let kinds: Vec<_> = rest
        .iter()
        .map(|event| event["event"]["type"].as_str().unwrap().to_owned())
        .collect();
    let cancelled = kinds.iter().position(|kind| kind == "cancelled");
    assert!(
        cancelled.is_some_and(
            |at| at + 1 == kinds.len() - 1 || kinds[at + 1..].contains(&"completed".to_owned())
        ),
        "expected the cancelled marker before completed | received: {kinds:?}"
    );
    eventually(
        "the session idle after its cancelled turn",
        || rig.supervisor.live_sessions().1[0].state,
        |state| *state == "idle",
    )
    .await;
    rig.supervisor
        .turn(
            rig.turn_params("one", "m2", "again"),
            &CancellationToken::new(),
        )
        .await
        .expect("a new turn after the cancelled one");
    rig.close("one").await;
}

#[tokio::test]
async fn revoking_consent_mid_turn_closes_the_session_and_refuses_its_pending_answer() {
    let rig = rig(RigOptions::default()).await;
    rig.open("one").await.unwrap();
    let turn = rig
        .supervisor
        .turn(
            rig.turn_params("one", "m1", "go"),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let events = rig.events_until("approval_requested").await;
    let request = events.last().unwrap()["event"]["request"]["requestId"]
        .as_str()
        .unwrap()
        .to_owned();
    rig.consent.store(false, Ordering::SeqCst);
    eventually(
        "the session closed after revocation",
        || rig.live_count(),
        |live| *live == 0,
    )
    .await;
    assert_eq!(rig.log.closes(), vec![CloseReason::ConsentRevoked]);
    let refused = rig
        .supervisor
        .respond(RespondParams {
            session_id: "one".into(),
            native_turn_id: turn.native_turn_id,
            request_id: request,
            option_id: "anything".into(),
        })
        .await
        .expect_err("an answer after revocation must be refused");
    assert!(
        refused.message.contains("is not open"),
        "received: {}",
        refused.message
    );
    assert_eq!(
        rig.log.permission_answers.load(Ordering::SeqCst),
        0,
        "expected no answer to reach a revoked vendor"
    );
}

#[tokio::test]
async fn a_cancel_for_a_turn_that_is_no_longer_running_never_stops_the_current_one() {
    let rig = rig(RigOptions::default()).await;
    rig.open("one").await.unwrap();
    rig.supervisor
        .turn(
            rig.turn_params("one", "m1", "go"),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    rig.events_until("approval_requested").await;
    rig.supervisor
        .cancel(CancelParams {
            session_id: "one".into(),
            native_turn_id: Some("an-earlier-turn".into()),
        })
        .await
        .unwrap();
    assert_eq!(
        rig.log.cancels.load(Ordering::SeqCst),
        0,
        "expected a stale cancel to reach no vendor"
    );
    assert_eq!(rig.supervisor.live_sessions().1[0].state, "running");
    rig.close("one").await;
}

#[tokio::test]
async fn a_single_choice_question_is_a_card_answered_as_a_question_never_as_a_permission() {
    let rig = rig(RigOptions {
        open: OpenBehaviour::AskingOneChoice,
        ..RigOptions::default()
    })
    .await;
    rig.open("one").await.unwrap();
    let turn = rig
        .supervisor
        .turn(
            rig.turn_params("one", "m1", "choose"),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let events = rig.events_until("approval_requested").await;
    let request = &events.last().unwrap()["event"]["request"];
    let option_ids: Vec<_> = request["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|option| option["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        option_ids,
        ["left", "right"],
        "expected the card's options to be the choice ids"
    );
    rig.supervisor
        .respond(RespondParams {
            session_id: "one".into(),
            native_turn_id: turn.native_turn_id,
            request_id: request["requestId"].as_str().unwrap().into(),
            option_id: "right".into(),
        })
        .await
        .unwrap();
    let rest = rig.events_until("completed").await;
    let resolved = rest
        .iter()
        .find(|event| event["event"]["type"] == "approval_resolved")
        .expect("expected the question resolved on the wire");
    assert_eq!(resolved["event"]["decision"]["optionId"], json!("right"));
    assert_eq!(
        (
            rig.log.question_answers.load(Ordering::SeqCst),
            rig.log.permission_answers.load(Ordering::SeqCst)
        ),
        (1, 0),
        "expected (question answers, permission answers) = (1, 0)"
    );
    rig.close("one").await;
}

#[tokio::test]
async fn a_malformed_attachment_refuses_the_turn_and_leaves_the_session_idle() {
    let rig = rig(RigOptions::default()).await;
    rig.open("one").await.unwrap();
    let mut params = rig.turn_params("one", "m1", "look");
    params.attachments = Some(vec![crate::external_agents::wire::Attachment {
        id: "a1".into(),
        original_name: "x.png".into(),
        mime_type: "image/png".into(),
        size_bytes: 3,
        kind: crate::external_agents::wire::AttachmentKind::Image,
        bytes_base64: "not base64!".into(),
    }]);
    let error = rig
        .supervisor
        .turn(params, &CancellationToken::new())
        .await
        .expect_err("a malformed attachment must be refused");
    assert!(
        error.message.contains("is not valid base64"),
        "received: {}",
        error.message
    );
    assert_eq!(rig.supervisor.live_sessions().1[0].state, "idle");
    rig.supervisor
        .turn(
            rig.turn_params("one", "m2", "again"),
            &CancellationToken::new(),
        )
        .await
        .expect("the session is still free for the next turn");
    rig.close("one").await;
}

#[tokio::test]
async fn a_turn_cannot_switch_cursor_to_auto_review() {
    let rig = rig(RigOptions::default()).await;
    let mut open = rig.open_params("one");
    open.target_id = TargetId::Cursor;
    rig.supervisor
        .open(open, &rig.hub, &CancellationToken::new())
        .await
        .unwrap();
    let mut params = rig.turn_params("one", "m1", "go");
    params.configuration.routing = ApprovalRouting::AutoReview;
    let error = rig
        .supervisor
        .turn(params, &CancellationToken::new())
        .await
        .expect_err("auto-review must be refused for Cursor at turn time too");
    assert!(
        error.message.contains("does not offer auto-review"),
        "received: {}",
        error.message
    );
    assert_eq!(rig.log.turns_started.load(Ordering::SeqCst), 0);
    rig.close("one").await;
}

#[tokio::test]
async fn a_start_the_hub_gave_up_on_releases_the_session() {
    let rig = rig(RigOptions::default()).await;
    rig.open("one").await.unwrap();
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let error = rig
        .supervisor
        .turn(rig.turn_params("one", "m1", "go"), &cancelled)
        .await
        .expect_err("a start the hub abandoned must fail");
    assert_eq!(error.code, codes::CANCELLED, "received: {error:?}");
    assert_eq!(
        rig.log.turns_started.load(Ordering::SeqCst),
        0,
        "expected the start never reached the vendor"
    );
    assert_eq!(rig.supervisor.live_sessions().1[0].state, "idle");
    rig.supervisor
        .turn(
            rig.turn_params("one", "m2", "next"),
            &CancellationToken::new(),
        )
        .await
        .expect("the session is free after the abandoned start");
    rig.close("one").await;
}
