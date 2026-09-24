//! Owns every external-agent session this runtime hosts: admission, the
//! aggregate cap, private scratch, consent revocation and awaited cleanup.
//!
//! A port of the session half of `apps/runtime/src/services/external-agents/
//! supervisor.ts`. Vendor protocols are the SDK's; this module decides who may
//! open what, holds what was opened, and proves it gone.
//!
//! # Owners
//!
//! | What | Owned by | Ends when |
//! | --- | --- | --- |
//! | An opening | its [`Slot::Opening`] entry and the task in [`Supervisor::tasks`] | the open settles; a result nobody will register is closed by that same task |
//! | A live session | its [`Slot::Live`] entry | [`Supervisor::close_session`] awaits the vendor close and removes the scratch |
//! | The consent watcher | [`Supervisor::tasks`] | the hub session closes, after every session is closed |
//!
//! Every spawned task is tracked. When the hub session ends, the watcher
//! cancels every opening and closes every live session before it returns.
//! Vendor process trees are also owned by the launcher, which reaps them at
//! runtime shutdown whether or not a close ran.
//!
//! # Authority
//!
//! A workspace is authorised only at open, through [`WorkspaceAuthority`],
//! after canonicalisation and an exact canonical-form check. The production
//! authority asks the hub on the calling session (`hub.workspace.authorize`,
//! see [`super::hub_authority`]) and fails closed on anything but an explicit
//! yes. Turn configuration may later narrow the roots an open authorised,
//! never widen them.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use mango_external_agents::{
    CancelToken, CloseReason, EnvSource, Error as SdkError, Harness, HostContext, Limits,
    OpenSession, ProcessLauncher, ResumeMode as SdkResumeMode, Session, SessionQuery,
};
use mango_protocol::error::{RemoteError, codes};
use mango_protocol::session::Session as HubSession;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::map;
use super::wire::{
    AckResult, CloseParams, Descriptor, DiscoverParams, DiscoverResult, ListSessionsParams,
    ListSessionsResult, OpenParams, OpenResult, RefreshAccountUsageParams,
    RefreshAccountUsageResult, ResumeMode, TargetId,
};
use crate::probing::detection::path_env::PathEnv;

/// How many sessions may be live or opening at once, as in the TS host.
pub(crate) const DEFAULT_SESSION_CAP: usize = 4;
/// How often a live or opening session re-reads `externalAgents` consent.
pub(crate) const CONSENT_POLL: Duration = Duration::from_millis(250);
/// How long one vendor close, or one late open's cleanup, may take before it
/// is reported as failed. Bounds awaited cleanup; never skips it silently.
pub(crate) const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
/// The longest one turn may run, approvals included, before the runtime ends
/// it with its own error and asks the vendor to stop — the TypeScript host's
/// `DEFAULT_HARD_TURN_TIMEOUT_MS`. The SDK's own `idle_timeout` bounds a
/// silent turn; this bounds one that keeps talking.
pub(crate) const HARD_TURN_TIMEOUT: Duration = Duration::from_secs(60 * 60);

/// A boxed future, for the object-safe ports below.
pub(crate) type PortFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Decides whether one canonical directory may be a session's workspace.
///
/// Only ever asked about a path that already exists, is a directory, and was
/// given in its canonical form. Omission is a denial; there is no allow-all.
///
/// `hub` is the session the call arrived on: the authority may ask the peer
/// that made the request, and never a different one.
pub(crate) trait WorkspaceAuthority: Send + Sync {
    /// Whether `canonical` may be opened, answered before any vendor launch.
    fn authorize<'a>(&'a self, hub: &'a HubSession, canonical: &'a Path) -> PortFuture<'a, bool>;
}

/// The fallback authority, for a host with no authorisation source: every
/// workspace is refused.
///
/// Test-only today: every admission runs on a hub session, so production
/// always has [`super::hub_authority::HubWorkspaceAuthority`] to ask. A
/// future caller without a session must use this, never an allow-all.
#[cfg(test)]
pub(crate) struct DenyEveryWorkspace;

#[cfg(test)]
impl WorkspaceAuthority for DenyEveryWorkspace {
    fn authorize<'a>(&'a self, _hub: &'a HubSession, _canonical: &'a Path) -> PortFuture<'a, bool> {
        Box::pin(async { false })
    }
}

/// Finds the executable a target launches, the way `probing.agent-clis` does.
pub(crate) trait ExecutableResolver: Send + Sync {
    /// The resolved path, or `None` when the target is not installed.
    fn resolve<'a>(
        &'a self,
        target: TargetId,
        cancel: &'a CancellationToken,
    ) -> PortFuture<'a, Option<PathBuf>>;
}

/// Builds the harness for one target around the executable it resolved.
pub(crate) trait HarnessFactory: Send + Sync {
    /// The harness `target` is served by, launching `executable` when known.
    fn harness(&self, target: TargetId, executable: Option<PathBuf>) -> Arc<dyn Harness>;
}

/// The production factory: the three product harnesses, through [`map`].
pub(crate) struct ProductHarnesses;

impl HarnessFactory for ProductHarnesses {
    fn harness(&self, target: TargetId, executable: Option<PathBuf>) -> Arc<dyn Harness> {
        map::harness_for(target, executable)
    }
}

/// Whether `externalAgents` consent is granted right now. A read that fails
/// closed answers `false`.
pub(crate) type ConsentProbe = Arc<dyn Fn() -> bool + Send + Sync>;

/// Everything the supervisor reaches outside itself, injected so tests use
/// named fakes rather than a vendor CLI or the real consent store.
pub(crate) struct Ports {
    /// Spawns every vendor child, with the runtime's tree ownership.
    pub launcher: Arc<dyn ProcessLauncher>,
    /// Builds a target's harness.
    pub harnesses: Arc<dyn HarnessFactory>,
    /// Authorises a session's workspace.
    pub workspaces: Arc<dyn WorkspaceAuthority>,
    /// Resolves a target's executable.
    pub executables: Arc<dyn ExecutableResolver>,
    /// This machine's environment snapshot, read per launch.
    pub environment: Arc<dyn Fn() -> PathEnv + Send + Sync>,
    /// A fresh `externalAgents` consent read.
    pub consent: ConsentProbe,
    /// A private, runtime-owned directory. Probes run with it as their
    /// working directory; each session gets a scratch leaf beneath it.
    pub private_root: PathBuf,
    /// This runtime's version, sent to vendors as the client identity.
    pub runtime_version: String,
    /// The SDK caps every harness reads.
    pub limits: Limits,
    /// Live plus opening sessions allowed at once.
    pub session_cap: usize,
    /// How often consent is re-read while anything is live or opening.
    pub consent_poll: Duration,
    /// The bound on each awaited cleanup.
    pub cleanup_timeout: Duration,
    /// The bound on one turn, from its start to its end.
    pub hard_turn_timeout: Duration,
}

/// Why a session is being closed, in the product's vocabulary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CloseCause {
    /// The hub asked.
    Requested,
    /// The owner withdrew `externalAgents` consent.
    ConsentRevoked,
    /// The hub session ended or the runtime is stopping.
    Shutdown,
}

impl CloseCause {
    fn sdk(self) -> CloseReason {
        match self {
            Self::Requested => CloseReason::Requested,
            Self::ConsentRevoked => CloseReason::ConsentRevoked,
            Self::Shutdown => CloseReason::Shutdown,
        }
    }
}

/// One live session, as registered after its open succeeded.
pub(crate) struct LiveSession {
    pub(super) session_id: String,
    pub(super) target: TargetId,
    workspace: PathBuf,
    /// The canonical roots `open` authorised; a turn may narrow them, never widen.
    pub(super) authorized_roots: std::collections::BTreeSet<String>,
    executable: Option<PathBuf>,
    opened_at: Instant,
    open_result: OpenResult,
    pub(super) session: Box<dyn Session>,
    scratch: PathBuf,
    pub(super) closing: AtomicBool,
    closed: watch::Sender<Option<Result<(), String>>>,
    /// Turns, receipts, interactions and the event stream to the hub.
    pub(super) turns: super::turns::TurnState,
}

/// An operation stopped by its deadline, its caller or shutdown, with any
/// value it still produced while it was being told to stop.
struct Interrupted<T> {
    error: RemoteError,
    late: Option<T>,
}

/// What an open found when it took the lock.
enum Admission {
    /// The session is live: answer what its open answered.
    Ready(Box<OpenResult>),
    /// The same open is in flight: wait for its outcome.
    Join(Arc<Opening>),
    /// Nothing was there: this call reserved the slot.
    Fresh(Arc<Opening>),
}

enum Slot {
    Opening(Arc<Opening>),
    Live(Arc<LiveSession>),
}

/// An open in flight: joinable by a repeat of the same open, cancellable by a
/// close, consent revocation or shutdown, which record why.
struct Opening {
    target: TargetId,
    cancel: CancellationToken,
    close_cause: Mutex<Option<CloseCause>>,
    outcome: watch::Sender<Option<Result<OpenResult, RemoteError>>>,
    /// Resolves once the task is finished, including any cleanup of a result
    /// nobody registered. A close of an opening session waits on this.
    settled: watch::Sender<bool>,
    /// Why closing a session this open produced but never registered failed.
    cleanup_failure: Mutex<Option<String>>,
}

impl Opening {
    fn cancel_with(&self, cause: CloseCause) {
        let mut recorded = self
            .close_cause
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        recorded.get_or_insert(cause);
        drop(recorded);
        self.cancel.cancel();
    }

    fn record_cleanup(&self, outcome: Result<(), String>) {
        if let Err(detail) = outcome {
            *self
                .cleanup_failure
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()) = Some(detail);
        }
    }

    /// Whether everything this open produced was released.
    fn cleanup_outcome(&self) -> Result<(), RemoteError> {
        let failure = self
            .cleanup_failure
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        match failure {
            None => Ok(()),
            Some(detail) => Err(RemoteError::new(
                codes::INTERNAL,
                format!("External-agent late-open cleanup failed: {detail}"),
            )),
        }
    }

    fn cause(&self) -> Option<CloseCause> {
        *self
            .close_cause
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}

/// A health row for one live session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LiveSessionHealth {
    /// The hub's id.
    pub session_id: String,
    /// Its target.
    pub target: TargetId,
    /// Milliseconds since it opened.
    pub age_ms: u64,
    /// `idle`, `running` or `closing`.
    pub state: &'static str,
}

/// Owns every external-agent session for one hub session.
pub(crate) struct Supervisor {
    ports: Ports,
    slots: Mutex<HashMap<String, Slot>>,
    shutdown: CancellationToken,
    pub(super) tasks: TaskTracker,
    watcher_started: AtomicBool,
}

impl Supervisor {
    /// A supervisor with no sessions.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let supervisor = Supervisor::new(ports);
    /// let result = supervisor.discover(params, &cancel).await?;
    /// ```
    pub(crate) fn new(ports: Ports) -> Arc<Self> {
        Arc::new(Self {
            ports,
            slots: Mutex::new(HashMap::new()),
            shutdown: CancellationToken::new(),
            tasks: TaskTracker::new(),
            watcher_started: AtomicBool::new(false),
        })
    }

    fn slots(&self) -> std::sync::MutexGuard<'_, HashMap<String, Slot>> {
        self.slots
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// The bound on one turn, from its start to its end.
    pub(super) fn hard_turn_timeout(&self) -> Duration {
        self.ports.hard_turn_timeout
    }

    /// Health rows for the live sessions, oldest first, and the true count.
    pub(crate) fn live_sessions(&self) -> (usize, Vec<LiveSessionHealth>) {
        let mut rows: Vec<_> = self
            .slots()
            .values()
            .filter_map(|slot| match slot {
                Slot::Live(live) => Some(Arc::clone(live)),
                Slot::Opening(_) => None,
            })
            .collect();
        rows.sort_by_key(|live| live.opened_at);
        let count = rows.len();
        let rows = rows
            .into_iter()
            .map(|live| LiveSessionHealth {
                session_id: live.session_id.clone(),
                target: live.target,
                age_ms: u64::try_from(live.opened_at.elapsed().as_millis()).unwrap_or(u64::MAX),
                state: if live.closing.load(Ordering::Acquire) {
                    "closing"
                } else if live.turns.is_busy() {
                    "running"
                } else {
                    "idle"
                },
            })
            .collect();
        (count, rows)
    }

    /// The `runtime.health` `externalAgents` subtree: the product targets, the
    /// live sessions (count kept true, rows bounded by the schema's limit),
    /// and this process's attestation unless the hub withdrew it.
    pub(crate) async fn health(&self, isolation_withdrawn: bool) -> serde_json::Value {
        const LIVE_SESSION_ROW_LIMIT: usize = 128;
        let (count, rows) = self.live_sessions();
        let rows: Vec<_> = rows
            .into_iter()
            .take(LIVE_SESSION_ROW_LIMIT)
            .map(|row| {
                serde_json::json!({
                    "sessionId": row.session_id,
                    "targetId": row.target,
                    "ageMs": row.age_ms,
                    "state": row.state,
                })
            })
            .collect();
        let mut health = serde_json::json!({
            "targets": TargetId::ALL,
            "liveSessionCount": count,
            "liveSessions": rows,
        });
        if !isolation_withdrawn
            && let Some(isolation) =
                crate::blocking::run_blocking(super::isolation::detect_external_agent_isolation)
                    .await
        {
            health["identityIsolation"] = serde_json::json!(isolation);
        }
        health
    }

    /// The live session for `session_id`, refusing one that is closing.
    pub(super) fn require_live(&self, session_id: &str) -> Result<Arc<LiveSession>, RemoteError> {
        match self.slots().get(session_id) {
            Some(Slot::Live(live)) if !live.closing.load(Ordering::Acquire) => Ok(Arc::clone(live)),
            _ => Err(argument(format!(
                "External-agent session {session_id:?} is not open; expected an open session id."
            ))),
        }
    }

    /// `external-agent.discover`: one descriptor per target that answered.
    ///
    /// Each target is bounded by `timeoutMs` on its own, so one slow vendor
    /// costs only its own descriptor. A batch where nothing answered is still
    /// a failure, carrying the first target's error.
    pub(crate) async fn discover(
        self: &Arc<Self>,
        params: DiscoverParams,
        cancel: &CancellationToken,
    ) -> Result<DiscoverResult, RemoteError> {
        let deadline = Duration::from_millis(params.timeout_ms);
        let mut probes = tokio::task::JoinSet::new();
        for (index, target) in params.target_ids.iter().copied().enumerate() {
            let this = Arc::clone(self);
            let cancel = cancel.child_token();
            probes.spawn(async move {
                let outcome = this.discover_one(target, deadline, &cancel).await;
                (index, outcome)
            });
        }
        let mut outcomes: Vec<Option<Result<Descriptor, RemoteError>>> =
            (0..params.target_ids.len()).map(|_| None).collect();
        while let Some(joined) = probes.join_next().await {
            let (index, outcome) = joined.map_err(|error| {
                RemoteError::new(
                    codes::INTERNAL,
                    format!("External-agent discovery task failed: {error}"),
                )
            })?;
            outcomes[index] = Some(outcome);
        }
        let mut first_error = None;
        let mut descriptors = Vec::new();
        for outcome in outcomes.into_iter().flatten() {
            match outcome {
                Ok(descriptor) => descriptors.push(descriptor),
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        if descriptors.is_empty() {
            return Err(first_error.unwrap_or_else(|| {
                RemoteError::new(
                    codes::INTERNAL,
                    "External-agent discovery returned no descriptors.",
                )
            }));
        }
        Ok(DiscoverResult { descriptors })
    }

    async fn discover_one(
        &self,
        target: TargetId,
        deadline: Duration,
        cancel: &CancellationToken,
    ) -> Result<Descriptor, RemoteError> {
        let host_cancel = CancelToken::new();
        let work = async {
            let executable = self.ports.executables.resolve(target, cancel).await;
            let harness = self.ports.harnesses.harness(target, executable);
            let probe_dir = self.probe_dir()?;
            let host = self.host_context(&probe_dir, None, None, &host_cancel)?;
            stopped_before_launch(cancel, &host_cancel)?;
            let discovery = match harness.discover(&host).await {
                Ok(discovery) => discovery,
                Err(error) => return Err(self.sdk_failure(error).await),
            };
            Ok(map::descriptor(
                target,
                &discovery,
                epoch_ms(SystemTime::now()),
            ))
        };
        self.bounded(work, deadline, cancel, &host_cancel, || {
            format!(
                "External-agent discovery for {:?} timed out.",
                target.as_str()
            )
        })
        .await
        .map_err(|stopped| stopped.error)
    }

    /// `external-agent.open`.
    ///
    /// A repeat of an open for the same id joins it, or answers what it
    /// answered; the same id for another target is refused. The aggregate cap
    /// counts live and opening sessions together.
    pub(crate) async fn open(
        self: &Arc<Self>,
        params: OpenParams,
        session: &mango_protocol::session::Session,
        cancel: &CancellationToken,
    ) -> Result<OpenResult, RemoteError> {
        if self.shutdown.is_cancelled() {
            return Err(argument(
                "The external-agent supervisor is closed; expected a live runtime session.",
            ));
        }
        let opening = match self.admit(&params)? {
            Admission::Ready(result) => return Ok(*result),
            Admission::Join(opening) => return join_opening(&opening).await,
            Admission::Fresh(opening) => opening,
        };
        self.start_watcher(session.clone());

        let params_session_id = params.session_id.clone();
        let this = Arc::clone(self);
        let task_opening = Arc::clone(&opening);
        let hub = session.clone();
        self.tasks.spawn(async move {
            let session_id = params.session_id.clone();
            let outcome = this.run_open(params, &task_opening, hub).await;
            let published = match outcome {
                Ok(live) => this.register(&session_id, &task_opening, live).await,
                Err(error) => {
                    this.remove_opening(&session_id, &task_opening);
                    Err(error)
                }
            };
            task_opening.outcome.send_replace(Some(published));
            task_opening.settled.send_replace(true);
        });

        tokio::select! {
            outcome = join_opening(&opening) => outcome,
            () = cancel.cancelled() => {
                // The hub stopped waiting. The open itself keeps its own
                // deadline; a result nobody registers is closed by its task.
                self.cancel_opening(&params_session_id, &opening, CloseCause::Requested).await;
                Err(RemoteError::new(codes::CANCELLED, "External-agent open was cancelled."))
            }
        }
    }

    /// Decides, under one lock, whether an open joins, answers, or starts.
    fn admit(&self, params: &OpenParams) -> Result<Admission, RemoteError> {
        let mut slots = self.slots();
        let existing_target = match slots.get(&params.session_id) {
            Some(Slot::Live(live)) => Some((
                live.target,
                Admission::Ready(Box::new(live.open_result.clone())),
            )),
            Some(Slot::Opening(opening)) => {
                Some((opening.target, Admission::Join(Arc::clone(opening))))
            }
            None => None,
        };
        if let Some((target, admission)) = existing_target {
            if target != params.target_id {
                return Err(argument(format!(
                    "External-agent session {:?} already belongs to target {:?}; expected {:?}.",
                    params.session_id,
                    target.as_str(),
                    params.target_id.as_str()
                )));
            }
            return Ok(admission);
        }
        if self.shutdown.is_cancelled() {
            return Err(argument(
                "The external-agent supervisor is closed; expected a live runtime session.",
            ));
        }
        if slots.len() >= self.ports.session_cap {
            return Err(argument(format!(
                "External-agent session capacity is {}; close a session before opening another.",
                self.ports.session_cap
            )));
        }
        let opening = Arc::new(Opening {
            target: params.target_id,
            cancel: self.shutdown.child_token(),
            close_cause: Mutex::new(None),
            outcome: watch::channel(None).0,
            settled: watch::channel(false).0,
            cleanup_failure: Mutex::new(None),
        });
        slots.insert(
            params.session_id.clone(),
            Slot::Opening(Arc::clone(&opening)),
        );
        Ok(Admission::Fresh(opening))
    }

    /// Runs one open to a live session, or fails having cleaned up after itself.
    async fn run_open(
        &self,
        params: OpenParams,
        opening: &Opening,
        hub: HubSession,
    ) -> Result<LiveSession, RemoteError> {
        let deadline = Duration::from_millis(params.timeout_ms);
        let host_cancel = CancelToken::new();
        let cancel = opening.cancel.clone();
        let target = params.target_id;
        let work = async {
            refuse_unoffered_configuration(target, &params.configuration)?;
            let workspace = self
                .authorized_workspace(&hub, &params.workspace_path)
                .await?;
            // Every extra root is authorised at open, and refuses the whole
            // open if any one is not; a later turn may only narrow the set.
            let mut authorized_roots = std::collections::BTreeSet::from([path_text(&workspace)]);
            for root in &params.configuration.workspace_roots {
                authorized_roots.insert(path_text(&self.authorized_workspace(&hub, root).await?));
            }
            // Nothing is probed, created or launched once the open has been
            // told to stop: the grace in `bounded` is for work already
            // launched, and resolving an executable itself runs its version.
            stopped_before_launch(&cancel, &host_cancel)?;
            let executable = self
                .ports
                .executables
                .resolve(target, &cancel)
                .await
                .ok_or_else(|| {
                    argument(format!(
                        "External-agent executable for {:?} is not installed; expected an installed target.",
                        target.as_str()
                    ))
                })?;
            let scratch = self.session_scratch(&params.session_id)?;
            let host = self.host_context(
                &workspace,
                Some(&scratch),
                params.toolchain.as_ref(),
                &host_cancel,
            )?;
            let harness = self
                .ports
                .harnesses
                .harness(target, Some(executable.clone()));
            let mut request = OpenSession::new(params.session_id.clone())
                .with_configuration(map::configuration_patch(&params.configuration));
            if let Some(native) = &params.resume_ref {
                request = request.resuming(native.clone(), sdk_resume_mode(params.resume_mode));
            }
            if let Err(error) = stopped_before_launch(&cancel, &host_cancel) {
                remove_scratch(&scratch);
                return Err(error);
            }
            let opened = harness.open_session(&host, request).await;
            match opened {
                Ok(session) => Ok((session, workspace, authorized_roots, executable, scratch)),
                Err(error) => {
                    remove_scratch(&scratch);
                    Err(self.sdk_failure(error).await)
                }
            }
        };
        let opened = self
            .bounded(work, deadline, &cancel, &host_cancel, || {
                format!(
                    "Opening external-agent target {:?} timed out.",
                    target.as_str()
                )
            })
            .await;
        let (session, workspace, authorized_roots, executable, scratch) = match opened {
            Ok(opened) => opened,
            Err(stopped) => {
                // The vendor finished opening while it was being told to stop:
                // nobody will register that session, so it is closed here.
                if let Some((session, _, _, _, scratch)) = stopped.late {
                    let cause = opening.cause().unwrap_or(if self.shutdown.is_cancelled() {
                        CloseCause::Shutdown
                    } else {
                        CloseCause::Requested
                    });
                    let closed =
                        tokio::time::timeout(self.close_bound(), session.close(cause.sdk())).await;
                    remove_scratch(&scratch);
                    opening.record_cleanup(match closed {
                        Ok(Ok(())) => Ok(()),
                        Ok(Err(error)) => Err(error.to_string()),
                        Err(_) => Err("the vendor close did not finish in time".to_owned()),
                    });
                }
                return Err(stopped.error);
            }
        };
        let snapshot = session.snapshot();
        let open_result = map::open_result(&params.configuration, &snapshot, None);
        let (closed, _) = watch::channel(None);
        Ok(LiveSession {
            session_id: params.session_id,
            target,
            workspace,
            authorized_roots,
            executable: Some(executable),
            opened_at: Instant::now(),
            open_result,
            session,
            scratch,
            closing: AtomicBool::new(false),
            closed,
            turns: super::turns::TurnState::new(hub),
        })
    }

    /// Makes an opened session live, unless a close, revocation or shutdown
    /// claimed it first; then it is closed for that cause and the open fails.
    async fn register(
        self: &Arc<Self>,
        session_id: &str,
        opening: &Arc<Opening>,
        live: LiveSession,
    ) -> Result<OpenResult, RemoteError> {
        let live = Arc::new(live);
        let refused = {
            let mut slots = self.slots();
            let cause = opening.cause();
            let still_ours = matches!(
                slots.get(session_id),
                Some(Slot::Opening(current)) if Arc::ptr_eq(current, opening)
            );
            if cause.is_none() && still_ours && !self.shutdown.is_cancelled() {
                slots.insert(session_id.to_owned(), Slot::Live(Arc::clone(&live)));
                None
            } else {
                if still_ours {
                    slots.remove(session_id);
                }
                Some(cause.unwrap_or(CloseCause::Shutdown))
            }
        };
        let Some(cause) = refused else {
            return Ok(live.open_result.clone());
        };
        let cleanup = self.finish_close(&live, cause).await;
        opening.record_cleanup(cleanup.clone());
        let message = "External-agent open was cancelled before registration.";
        Err(match cleanup {
            Ok(()) => RemoteError::new(codes::CANCELLED, message),
            Err(detail) => RemoteError::new(codes::CANCELLED, format!("{message} {detail}")),
        })
    }

    fn remove_opening(&self, session_id: &str, opening: &Arc<Opening>) {
        let mut slots = self.slots();
        if matches!(slots.get(session_id), Some(Slot::Opening(current)) if Arc::ptr_eq(current, opening))
        {
            slots.remove(session_id);
        }
    }

    /// `external-agent.close`: idempotent, and awaited. An unknown id is
    /// already closed. An opening one is cancelled, and this returns once its
    /// open has settled and anything it produced has been closed.
    pub(crate) async fn close_session(
        &self,
        params: CloseParams,
        cause: CloseCause,
    ) -> Result<AckResult, RemoteError> {
        let slot = {
            let slots = self.slots();
            match slots.get(&params.session_id) {
                None => return Ok(AckResult::OK),
                Some(Slot::Opening(opening)) => {
                    // Under the same lock `register` decides under, so the open
                    // either registered already (and is Live here) or will see
                    // this cause and close what it opened.
                    opening.cancel_with(cause);
                    Slot::Opening(Arc::clone(opening))
                }
                Some(Slot::Live(live)) => Slot::Live(Arc::clone(live)),
            }
        };
        match slot {
            Slot::Opening(opening) => {
                wait_settled(&opening).await;
                opening.cleanup_outcome().map(|()| AckResult::OK)
            }
            Slot::Live(live) => self.close_live(&live, cause).await.map(|()| AckResult::OK),
        }
    }

    /// Cancels an opening for `cause` under the slot lock, then, if the open
    /// had already registered, closes the live session it became.
    async fn cancel_opening(&self, session_id: &str, opening: &Arc<Opening>, cause: CloseCause) {
        let registered = {
            let slots = self.slots();
            match slots.get(session_id) {
                Some(Slot::Opening(current)) if Arc::ptr_eq(current, opening) => {
                    opening.cancel_with(cause);
                    None
                }
                Some(Slot::Live(live)) => Some(Arc::clone(live)),
                _ => None,
            }
        };
        if let Some(live) = registered {
            let _ = self.close_live(&live, cause).await;
        }
    }

    /// Closes one live session once, however many callers ask; every caller
    /// awaits the same outcome.
    async fn close_live(
        &self,
        live: &Arc<LiveSession>,
        cause: CloseCause,
    ) -> Result<(), RemoteError> {
        if !live.closing.swap(true, Ordering::AcqRel) {
            let result = self.finish_close(live, cause).await;
            {
                let mut slots = self.slots();
                if matches!(slots.get(&live.session_id), Some(Slot::Live(current)) if Arc::ptr_eq(current, live))
                {
                    slots.remove(&live.session_id);
                }
            }
            live.closed.send_replace(Some(result));
        }
        let mut closed = live.closed.subscribe();
        let outcome = loop {
            if let Some(outcome) = closed.borrow_and_update().clone() {
                break outcome;
            }
            if closed.changed().await.is_err() {
                break Err("the session owner ended without a cleanup record".to_owned());
            }
        };
        outcome.map_err(|detail| {
            RemoteError::new(
                codes::INTERNAL,
                format!(
                    "External-agent session {:?} cleanup failed: {detail}",
                    live.session_id
                ),
            )
        })
    }

    /// The vendor close, bounded, then the scratch leaf. Both always run.
    async fn finish_close(&self, live: &LiveSession, cause: CloseCause) -> Result<(), String> {
        let vendor =
            tokio::time::timeout(self.close_bound(), live.session.close(cause.sdk())).await;
        remove_scratch(&live.scratch);
        match vendor {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(error.to_string()),
            Err(_) => Err(format!(
                "the vendor close did not finish within {} ms",
                self.close_bound().as_millis()
            )),
        }
    }

    /// How long one vendor close may take: the SDK's own close budget (its
    /// kill grace plus its shutdown timeout) with the cleanup bound on top,
    /// so a vendor that uses its whole grace is not reported as failed.
    fn close_bound(&self) -> Duration {
        self.ports.limits.kill_grace
            + self.ports.limits.shutdown_timeout
            + self.ports.cleanup_timeout
    }

    /// `external-agent.list-sessions`: the vendor's own history for one target.
    ///
    /// Never opens a conversation: it asks the harness, which uses a bounded
    /// probe connection. A `workspacePath` is authorised exactly as `open`
    /// authorises one, because a listing is a read of conversation titles.
    pub(crate) async fn list_sessions(
        &self,
        params: ListSessionsParams,
        hub: &HubSession,
        cancel: &CancellationToken,
    ) -> Result<ListSessionsResult, RemoteError> {
        let live = self.live_for_target(params.session_id.as_deref(), params.target_id)?;
        let deadline = Duration::from_millis(params.timeout_ms);
        let host_cancel = CancelToken::new();
        let target = params.target_id;
        let work = async {
            let workspace = match &params.workspace_path {
                Some(path) => Some(self.authorized_workspace(hub, path).await?),
                None => None,
            };
            let executable = match &live {
                Some(live) => live.executable.clone(),
                None => self.ports.executables.resolve(target, cancel).await,
            };
            let cwd = match (&workspace, &live) {
                (Some(workspace), _) => workspace.clone(),
                (None, Some(live)) => live.workspace.clone(),
                (None, None) => self.probe_dir()?,
            };
            let host = self.host_context(&cwd, None, None, &host_cancel)?;
            let harness = self.ports.harnesses.harness(target, executable);
            let query = SessionQuery {
                cursor: params.cursor.clone(),
                limit: params.limit.map(|limit| limit as usize),
                workspace_path: workspace.clone(),
            };
            stopped_before_launch(cancel, &host_cancel)?;
            match harness.list_sessions(&host, query).await {
                Ok(page) => Ok(map::native_sessions(target, page)),
                Err(SdkError::NotSupported { .. }) => Err(argument(format!(
                    "External-agent target {:?} cannot list sessions; expected a target with session listing.",
                    target.as_str()
                ))),
                Err(error) => Err(self.sdk_failure(error).await),
            }
        };
        self.bounded(work, deadline, cancel, &host_cancel, || {
            format!(
                "Listing external-agent sessions for {:?} timed out.",
                target.as_str()
            )
        })
        .await
        .map_err(|stopped| stopped.error)
    }

    /// `external-agent.refresh-account-usage`.
    ///
    /// A live session is asked through its own connection. Without one, the
    /// SDK has no harness-level usage service, so the answer is `{}`: nothing
    /// to report, which is not the same as "no limits".
    pub(crate) async fn refresh_account_usage(
        &self,
        params: RefreshAccountUsageParams,
        cancel: &CancellationToken,
    ) -> Result<RefreshAccountUsageResult, RemoteError> {
        let live = self.live_for_target(params.session_id.as_deref(), params.target_id)?;
        let Some(live) = live else {
            return Ok(RefreshAccountUsageResult::default());
        };
        let deadline = Duration::from_millis(params.timeout_ms);
        let host_cancel = CancelToken::new();
        let target = params.target_id;
        let work = async {
            match live.session.refresh_account_usage().await {
                Ok(usage) => Ok(RefreshAccountUsageResult {
                    limits: usage
                        .limits
                        .as_ref()
                        .map(|limits| map::account_limits(target, limits, SystemTime::now())),
                }),
                Err(SdkError::NotSupported { .. }) => Ok(RefreshAccountUsageResult::default()),
                Err(error) => Err(self.sdk_failure(error).await),
            }
        };
        self.bounded(work, deadline, cancel, &host_cancel, || {
            format!(
                "External-agent account-usage refresh for {:?} timed out.",
                target.as_str()
            )
        })
        .await
        .map_err(|stopped| stopped.error)
    }

    fn live_for_target(
        &self,
        session_id: Option<&str>,
        target: TargetId,
    ) -> Result<Option<Arc<LiveSession>>, RemoteError> {
        let Some(session_id) = session_id else {
            return Ok(None);
        };
        let live = match self.slots().get(session_id) {
            Some(Slot::Live(live)) if !live.closing.load(Ordering::Acquire) => Arc::clone(live),
            _ => return Ok(None),
        };
        if live.target != target {
            return Err(argument(format!(
                "Session {session_id:?} belongs to {:?}; expected {:?}.",
                live.target.as_str(),
                target.as_str()
            )));
        }
        Ok(Some(live))
    }

    /// Canonicalises `input`, requires it to have been given canonically, and
    /// asks the workspace authority. Mirrors `#canonicalAuthorizedWorkspace`.
    async fn authorized_workspace(
        &self,
        hub: &HubSession,
        input: &str,
    ) -> Result<PathBuf, RemoteError> {
        let requested = PathBuf::from(input);
        let canonical = crate::blocking::run_blocking(move || crate::workspace_path::canonical_directory(&requested))
        .await
        .ok_or_else(|| {
            argument(format!(
                "External-agent workspace {input:?} is not a directory; expected an existing directory."
            ))
        })?;
        if path_text(&canonical) != input {
            return Err(argument(format!(
                "External-agent workspace {input:?} is not canonical; expected {:?}.",
                path_text(&canonical)
            )));
        }
        if !self.ports.workspaces.authorize(hub, &canonical).await {
            return Err(argument(format!(
                "External-agent workspace {input:?} is not authorized for this session; expected a workspace the runtime owner authorized."
            )));
        }
        Ok(canonical)
    }

    /// Maps an SDK failure to the wire, first reaping any child the SDK
    /// handed back because its own bounded cleanup did not finish.
    ///
    /// A failed reap is reported on the error rather than dropped: the child
    /// may still be alive, and the caller has to hear that.
    pub(super) async fn sdk_failure(&self, error: SdkError) -> RemoteError {
        let mapped = map::remote_error(&error);
        let Some(control) = error.cleanup_control() else {
            return mapped;
        };
        let reaped = tokio::time::timeout(self.ports.cleanup_timeout, async {
            control
                .kill(mango_external_agents::CancelReason::Shutdown)
                .await?;
            control.wait().await.map(|_| ())
        })
        .await;
        match reaped {
            Ok(Ok(())) => without_detail(mapped, "cleanupRequired"),
            _ => mapped.with_detail("cleanup", "unconfirmed"),
        }
    }

    fn host_context(
        &self,
        cwd: &Path,
        scratch: Option<&Path>,
        toolchain: Option<&crate::commands::toolchain::Selection>,
        cancel: &CancelToken,
    ) -> Result<HostContext, RemoteError> {
        let path_env = (self.ports.environment)();
        let env = crate::commands::toolchain::build(
            &path_env,
            toolchain,
            &crate::commands::toolchain::NativeToolchainFs,
        );
        let mut builder = HostContext::builder()
            .launcher(Arc::clone(&self.ports.launcher))
            .cwd(cwd.to_path_buf())
            .environment(EnvSource::from_pairs(env))
            .client_info("mangostudio-runtime", self.ports.runtime_version.clone())
            .cancel(cancel.clone())
            .limits(self.ports.limits);
        if let Some(scratch) = scratch {
            builder = builder.scratch(scratch.to_path_buf());
        }
        builder.build().map_err(|error| map::remote_error(&error))
    }

    /// The private directory probes run in. Created owner-only on first use.
    fn probe_dir(&self) -> Result<PathBuf, RemoteError> {
        let dir = self.ports.private_root.join("probe");
        create_private_dir(&dir)?;
        Ok(dir)
    }

    /// A fresh scratch leaf for one session, under the private root.
    fn session_scratch(&self, session_id: &str) -> Result<PathBuf, RemoteError> {
        let scratch_root = self.ports.private_root.join("scratch");
        create_private_dir(&scratch_root)?;
        // Unique per open, not per session id: supervisors of successive hub
        // connections share this root, and one's close must never remove the
        // leaf another's live session is using.
        let leaf = scratch_root.join(scratch_leaf_name(session_id, open_nonce()));
        create_private_dir(&leaf)?;
        Ok(leaf)
    }

    /// Runs `work` under `deadline`, the caller's `cancel` and shutdown.
    ///
    /// When one of them wins, `host_cancel` tells the harness to stop, and
    /// `work` is still polled for up to the cleanup bound so the harness can
    /// stop its vendor the way it knows how, rather than having its future
    /// dropped mid-exchange. A value it produces in that grace is returned as
    /// [`Interrupted::late`], for a caller that must release it. Past the
    /// grace `work` is dropped, and the launcher reaps what it started.
    async fn bounded<T>(
        &self,
        work: impl Future<Output = Result<T, RemoteError>>,
        deadline: Duration,
        cancel: &CancellationToken,
        host_cancel: &CancelToken,
        timed_out: impl FnOnce() -> String,
    ) -> Result<T, Interrupted<T>> {
        let mut work = std::pin::pin!(work);
        let error = tokio::select! {
            outcome = tokio::time::timeout(deadline, &mut work) => match outcome {
                Ok(Ok(value)) => return Ok(value),
                Ok(Err(error)) => return Err(Interrupted { error, late: None }),
                Err(_) => RemoteError::new(codes::TIMEOUT, timed_out()),
            },
            () = cancel.cancelled() => RemoteError::new(
                codes::CANCELLED,
                "External-agent operation was cancelled.",
            ),
            () = self.shutdown.cancelled() => RemoteError::new(
                codes::CANCELLED,
                "The external-agent supervisor is shutting down.",
            ),
        };
        host_cancel.cancel();
        let late = tokio::time::timeout(self.ports.cleanup_timeout, &mut work)
            .await
            .ok()
            .and_then(Result::ok);
        Err(Interrupted { error, late })
    }

    /// Starts the consent watcher once; it also owns shutdown when the hub
    /// session ends.
    fn start_watcher(self: &Arc<Self>, session: mango_protocol::session::Session) {
        if self.watcher_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let this = Arc::clone(self);
        self.tasks.spawn(async move {
            let mut ticks = tokio::time::interval(this.ports.consent_poll);
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            ticks.tick().await;
            loop {
                tokio::select! {
                    _ = session.closed() => break,
                    () = this.shutdown.cancelled() => break,
                    _ = ticks.tick() => {
                        if this.slots().is_empty() {
                            continue;
                        }
                        if !this.consent_granted().await {
                            this.close_all(CloseCause::ConsentRevoked).await;
                        }
                    }
                }
            }
            this.shutdown.cancel();
            this.close_all(CloseCause::Shutdown).await;
        });
    }

    async fn consent_granted(&self) -> bool {
        let probe = Arc::clone(&self.ports.consent);
        crate::blocking::run_blocking(move || probe()).await
    }

    /// Cancels every opening and closes every live session for `cause`,
    /// awaiting all of it.
    pub(crate) async fn close_all(&self, cause: CloseCause) {
        let (openings, lives): (Vec<_>, Vec<_>) = {
            let slots = self.slots();
            slots
                .values()
                .map(|slot| match slot {
                    Slot::Opening(opening) => {
                        opening.cancel_with(cause);
                        (Some(Arc::clone(opening)), None)
                    }
                    Slot::Live(live) => (None, Some(Arc::clone(live))),
                })
                .unzip()
        };
        let closes = lives
            .iter()
            .flatten()
            .map(|live| self.close_live(live, cause));
        // Each failure is already recorded on its session's own close outcome,
        // which any concurrent `close` of that session receives.
        let _ = futures_util::future::join_all(closes).await;
        for opening in openings.into_iter().flatten() {
            wait_settled(&opening).await;
        }
    }
}

async fn join_opening(opening: &Opening) -> Result<OpenResult, RemoteError> {
    let mut outcome = opening.outcome.subscribe();
    loop {
        if let Some(result) = outcome.borrow_and_update().clone() {
            return result;
        }
        if outcome.changed().await.is_err() {
            return Err(RemoteError::new(
                codes::INTERNAL,
                "The external-agent open ended without an outcome.",
            ));
        }
    }
}

async fn wait_settled(opening: &Opening) {
    let mut settled = opening.settled.subscribe();
    while !*settled.borrow_and_update() {
        if settled.changed().await.is_err() {
            return;
        }
    }
}

/// Refuses a configuration the product never offers for `target`, even where
/// the SDK harness would accept it.
///
/// Cursor's ACP profile reports auto-review routing as supported, but the
/// product has no Cursor reviewer: the descriptor refuses those cells with
/// `cursorNoAutoReview`, and a hub that sends one anyway must not reach the
/// vendor with it.
pub(super) fn refuse_unoffered_configuration(
    target: TargetId,
    configuration: &super::wire::Configuration,
) -> Result<(), RemoteError> {
    if target == TargetId::Cursor
        && configuration.routing == super::wire::ApprovalRouting::AutoReview
    {
        return Err(argument(
            "External-agent target \"cursor\" does not offer auto-review routing; expected routing \"user\".",
        ));
    }
    Ok(())
}

/// Refuses to start anything new once an operation has been told to stop.
fn stopped_before_launch(
    cancel: &CancellationToken,
    host_cancel: &CancelToken,
) -> Result<(), RemoteError> {
    if cancel.is_cancelled() || host_cancel.is_cancelled() {
        return Err(RemoteError::new(
            codes::CANCELLED,
            "External-agent operation was stopped before it launched anything.",
        ));
    }
    Ok(())
}

fn sdk_resume_mode(mode: ResumeMode) -> SdkResumeMode {
    match mode {
        ResumeMode::Strict => SdkResumeMode::Strict,
        ResumeMode::Fallback => SdkResumeMode::Fallback,
    }
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn epoch_ms(at: SystemTime) -> u64 {
    at.duration_since(UNIX_EPOCH).map_or(0, |elapsed| {
        u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
    })
}

/// A scratch leaf name that is a pure function of the session id, holds no
/// path syntax, and stays short enough for a vendor command line.
fn scratch_leaf_name(session_id: &str, nonce: u64) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(session_id.as_bytes());
    let hex: String = digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("s-{hex}-{nonce:016x}")
}

/// A value no other open in this process, or a recent one, will reuse.
fn open_nonce() -> u64 {
    use std::sync::atomic::AtomicU64;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let mut random = [0_u8; 8];
    let _ = getrandom::fill(&mut random);
    u64::from_le_bytes(random) ^ NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Creates `dir` and every missing ancestor as directories only this account
/// can enter: mode `0700` on Unix, an owner-only ACL on Windows. An existing
/// directory is re-restricted, so a loosened mode does not survive a restart.
fn create_private_dir(dir: &Path) -> Result<(), RemoteError> {
    let failed = |what: &str| {
        RemoteError::new(
            codes::INTERNAL,
            format!("Could not {what} the runtime's private external-agent directory {dir:?}."),
        )
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|_| failed("create"))?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| failed("restrict"))?;
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir).map_err(|_| failed("create"))?;
        if !crate::runtime_home::owner_only::restrict_to_owner(dir) {
            return Err(failed("restrict"));
        }
    }
    Ok(())
}

/// `error` without the detail `key`, for a fact the supervisor has since resolved.
fn without_detail(mut error: RemoteError, key: &str) -> RemoteError {
    if let Some(details) = error.details.as_mut() {
        details.remove(key);
        if details.is_empty() {
            error.details = None;
        }
    }
    error
}

fn remove_scratch(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

pub(super) fn argument(message: impl Into<String>) -> RemoteError {
    RemoteError::new(codes::INTERNAL, message).with_detail("kind", "tool_argument")
}

#[cfg(test)]
mod tests;
