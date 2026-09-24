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
use mango_protocol::port::{MemoryPort, port_pair};
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
        self.inner.start_turn(request).await
    }

    async fn respond(&self, response: PermissionResponse) -> mango_external_agents::Result<()> {
        self.inner.respond(response).await
    }

    async fn cancel(&self, reason: CancelReason) -> mango_external_agents::Result<()> {
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
            inner: FakeHarness::new(),
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
}

impl WorkspaceAuthority for AllowListedWorkspaces {
    fn authorize<'a>(&'a self, canonical: &'a Path) -> PortFuture<'a, bool> {
        self.asks.fetch_add(1, Ordering::SeqCst);
        let allowed = self.allowed.contains(canonical);
        Box::pin(async move { allowed })
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
    _peer: MemoryPort,
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
}

impl Default for RigOptions {
    fn default() -> Self {
        Self {
            open: OpenBehaviour::Succeed,
            probes: Vec::new(),
            authorize_workspace: true,
            installed: true,
            session_cap: super::DEFAULT_SESSION_CAP,
        }
    }
}

fn rig(options: RigOptions) -> Rig {
    let workspace_dir = ScratchDir::created("agent-workspace");
    let private_dir = ScratchDir::created("agent-private");
    let workspace = std::fs::canonicalize(workspace_dir.path()).unwrap();
    let log = Arc::new(HarnessLog::default());
    let workspaces = Arc::new(AllowListedWorkspaces {
        allowed: if options.authorize_workspace {
            BTreeSet::from([workspace.clone()])
        } else {
            BTreeSet::new()
        },
        asks: AtomicUsize::new(0),
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
    let (port, peer) = port_pair();
    let (hub, _driver) = HubSession::spawn(
        port,
        SessionOptions::new(PeerInfo {
            name: "external-agent-test".into(),
            version: "0.1.0".into(),
            role: "runtime".into(),
        }),
    );
    Rig {
        supervisor,
        log,
        workspaces,
        executables,
        consent,
        hub,
        _peer: peer,
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
    });
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
    let rig = rig(RigOptions::default());
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
    let rig = rig(RigOptions::default());
    let outside = ScratchDir::created("agent-outside");
    let mut params = rig.open_params("one");
    params.configuration.workspace_roots = vec![
        std::fs::canonicalize(outside.path())
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
    let rig = rig(RigOptions::default());
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
    });
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
    let rig = rig(RigOptions::default());
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
async fn concurrent_opens_of_one_id_share_one_launch() {
    let (release, gate) = watch::channel(false);
    let rig = rig(RigOptions {
        open: OpenBehaviour::Gated(gate),
        ..RigOptions::default()
    });
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
    });
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
    let rig = rig(RigOptions::default());
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
    });
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
    let rig = rig(RigOptions::default());
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
            },
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
    });
    let mut params = rig.open_params("one");
    params.timeout_ms = 30;
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
    });
    let mut params = rig.open_params("one");
    params.timeout_ms = 30;
    let error = rig
        .supervisor
        .open(params, &rig.hub, &CancellationToken::new())
        .await
        .expect_err("an open past its deadline must fail");
    assert_eq!(error.code, codes::TIMEOUT, "received: {error:?}");
    assert_eq!(
        rig.log.closes(),
        vec![CloseReason::Requested],
        "expected the session the vendor opened late to be closed once"
    );
    assert_eq!(rig.live_count(), 0);
    assert_eq!(
        std::fs::read_dir(rig.private_root.join("scratch"))
            .unwrap()
            .count(),
        0,
        "expected the late session's scratch removed"
    );
}

#[tokio::test]
async fn a_child_the_sdk_could_not_clean_up_is_reaped_before_the_failure_returns() {
    let control = Arc::new(CountingControl::default());
    let rig = rig(RigOptions {
        open: OpenBehaviour::FailNeedingCleanup(Arc::clone(&control)),
        ..RigOptions::default()
    });
    rig.open("one").await.expect_err("the open must fail");
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
    let rig = rig(RigOptions::default());
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
    let rig = rig(RigOptions::default());
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
    });
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
    });
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
    });
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
    let rig = rig(RigOptions::default());
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
    });
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
    let rig = rig(RigOptions::default());
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
    let rig = rig(RigOptions::default());
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
