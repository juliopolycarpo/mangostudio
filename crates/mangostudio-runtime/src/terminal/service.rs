//! Terminal method dispatch, session ownership, and consent revocation.

use std::collections::{BTreeMap, HashMap};
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mango_protocol::error::{RemoteError, codes};
use mango_protocol::session::{CallContext, EventInput, Session};
use mangostudio_runtime_contract::manifest::RuntimeShellKind;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, watch};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use super::flow::{ExitInfo, OutputFrame, SCROLLBACK_MAX_BYTES, TerminalFlow};
use super::pty::{DefaultPtySpawner, PtyError, PtyHandle, PtyRequest, PtySpawner};
use crate::blocking::run_blocking;
use crate::commands::{environment, toolchain};
use crate::consent::read::{CONSENT_READ_TIMEOUT, ConsentRead, ConsentReader, read_consent};
use crate::consent::source::ConsentSource;
use crate::ports::authorization::consent_denial;
use crate::probing::detection::path_env::PathEnv;
use crate::registry::Registry;
use crate::subprocess::LaunchCheck;
use crate::tool_argument::invalid_argument;

const MAX_TERMINAL_SESSIONS: usize = 16;
// The PTY pool is process-wide; a smaller one refuses, with `UNAVAILABLE`, a session this
// service and the hub (8 per user by default) already admitted.
const _: () = assert!(
    super::pty::MAX_PTY_CHILDREN >= MAX_TERMINAL_SESSIONS,
    "expected the PTY pool to admit at least MAX_TERMINAL_SESSIONS children"
);
const MAX_WRITE_BYTES: usize = 16 * 1024 - 1;
const CONSENT_POLL: Duration = Duration::from_millis(100);

/// Reads whether shell consent is granted now; injected so a test can model a slow store.
type ShellRead = Arc<dyn Fn() -> bool + Send + Sync>;

/// Every method [`register`] installs; the hello manifest attests them as one unit.
pub(crate) const TERMINAL_METHODS: [&str; 8] = [
    "terminal.open",
    "terminal.attach",
    "terminal.detach",
    "terminal.write",
    "terminal.resize",
    "terminal.ack",
    "terminal.close",
    "terminal.list",
];

pub(crate) fn register(mut registry: Registry, consent: ConsentSource) -> Registry {
    let service = Arc::new(Service::new(
        Arc::new(consent),
        Arc::new(DefaultPtySpawner),
        Arc::new(|| crate::probing::host::build_runtime_path_env(None)),
    ));
    for method in TERMINAL_METHODS {
        let service = Arc::clone(&service);
        registry = registry.implement(method, move |params: Value, context: CallContext| {
            let service = Arc::clone(&service);
            async move { service.call(method, params, context).await }
        });
    }
    registry
}

enum Slot {
    Opening {
        reservation_id: u64,
        cancel: CancellationToken,
        handoff: watch::Receiver<Option<Arc<Entry>>>,
    },
    Starting {
        reservation_id: u64,
        entry: Arc<Entry>,
    },
    Live(Arc<Entry>),
}

impl Slot {
    fn entry(&self) -> Option<&Arc<Entry>> {
        match self {
            Self::Starting { entry, .. } | Self::Live(entry) => Some(entry),
            Self::Opening { .. } => None,
        }
    }
}

struct Entry {
    session_id: String,
    shell: RuntimeShellKind,
    cwd: String,
    size: Mutex<(u16, u16)>,
    flow: Arc<Mutex<TerminalFlow>>,
    handle: Arc<dyn PtyHandle>,
    operation: AsyncMutex<()>,
    closed: AtomicBool,
    close_scheduled: AtomicBool,
    close_result: AsyncMutex<Option<Result<(), Arc<std::io::Error>>>>,
    consent_revoked: Arc<AtomicBool>,
}

impl Entry {
    fn accepts_effects(&self) -> bool {
        let expired = self
            .flow
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .login_expired();
        !expired && !self.closed.load(Ordering::Acquire)
    }

    fn snapshot(&self) -> Value {
        let size = {
            let guard = self
                .size
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            *guard
        };
        let flow = self
            .flow
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let exit = flow.exit();
        json!({
            "sessionId": self.session_id,
            "shell": self.shell,
            "cwd": self.cwd,
            "cols": size.0,
            "rows": size.1,
            "status": if exit.is_some() { "exited" } else { "running" },
            "exitCode": exit.and_then(|value| value.exit_code),
            "signal": exit.and_then(|value| value.signal.as_deref()),
            "attached": flow.attached(),
            "pid": self.handle.pid(),
        })
    }
}

struct Service {
    consent: Arc<ConsentSource>,
    shell_read: ShellRead,
    consent_read_timeout: Duration,
    consent_reader: ConsentReader,
    spawner: Arc<dyn PtySpawner>,
    host: Arc<dyn Fn() -> PathEnv + Send + Sync>,
    sessions: Mutex<HashMap<String, Slot>>,
    next_reservation: AtomicU64,
    watcher_started: AtomicBool,
}

impl Service {
    fn new(
        consent: Arc<ConsentSource>,
        spawner: Arc<dyn PtySpawner>,
        host: Arc<dyn Fn() -> PathEnv + Send + Sync>,
    ) -> Self {
        let source = Arc::clone(&consent);
        Self {
            consent,
            shell_read: Arc::new(move || source.refresh().shell),
            consent_read_timeout: CONSENT_READ_TIMEOUT,
            consent_reader: ConsentReader::new("shell"),
            spawner,
            host,
            sessions: Mutex::new(HashMap::new()),
            next_reservation: AtomicU64::new(1),
            watcher_started: AtomicBool::new(false),
        }
    }

    async fn call(
        self: &Arc<Self>,
        method: &'static str,
        params: Value,
        context: CallContext,
    ) -> Result<Value, RemoteError> {
        match method {
            "terminal.open" => {
                self.open(
                    decode(params)?,
                    context.session().clone(),
                    context.cancel().clone(),
                )
                .await
            }
            "terminal.attach" => self.attach(decode(params)?),
            "terminal.detach" => self.detach(decode(params)?),
            "terminal.write" => self.write(decode(params)?).await,
            "terminal.resize" => self.resize(decode(params)?).await,
            "terminal.ack" => self.ack(decode(params)?, context.session()),
            "terminal.close" => self.close(decode(params)?).await,
            "terminal.list" => self.list(),
            _ => unreachable!("the terminal registry names exactly eight methods"),
        }
    }

    async fn open(
        self: &Arc<Self>,
        params: OpenParams,
        session: Session,
        cancel: CancellationToken,
    ) -> Result<Value, RemoteError> {
        let id = params.session_id.clone();
        let cancel = cancel.child_token();
        let (spawned, handoff) = watch::channel(None);
        let reservation_id = self.next_reservation.fetch_add(1, Ordering::Relaxed);
        {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if sessions.contains_key(&id) {
                return Err(invalid_argument(
                    &format!("sessionId={id:?}"),
                    "a fresh terminal session id",
                ));
            }
            if sessions.len() >= MAX_TERMINAL_SESSIONS {
                return Err(RemoteError::new(
                    codes::UNAVAILABLE,
                    format!(
                        "Terminal capacity {MAX_TERMINAL_SESSIONS} is full; expected a free session slot."
                    ),
                ));
            }
            sessions.insert(
                id.clone(),
                Slot::Opening {
                    reservation_id,
                    cancel: cancel.clone(),
                    handoff,
                },
            );
        }
        let mut reservation = Reservation::new(Arc::clone(self), id.clone(), reservation_id);
        let host = Arc::clone(&self.host);
        let prepared = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(open_cancelled()),
            result = run_blocking(move || prepare(params, host())) => result?,
        };
        let mut initial_flow = TerminalFlow::new(prepared.scrollback_bytes)
            .map_err(|message| invalid_argument(&message, "a positive scrollback byte count"))?;
        if prepared.login {
            initial_flow.enable_login();
        }
        let flow = Arc::new(Mutex::new(initial_flow));
        let on_data = {
            let flow = Arc::clone(&flow);
            let session = session.clone();
            let id = id.clone();
            Arc::new(move |bytes: &[u8]| {
                let mut emit = |frame| publish(&session, &id, frame);
                flow.lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .on_data(bytes, &mut emit);
            })
        };
        let consent_revoked = Arc::new(AtomicBool::new(false));
        let on_exit = {
            let flow = Arc::clone(&flow);
            let session = session.clone();
            let id = id.clone();
            let exit_reason = Arc::clone(&consent_revoked);
            Arc::new(move |exit: super::pty::PtyExit| {
                let native = ExitInfo {
                    exit_code: exit.code,
                    signal: exit.signal.map(|signal| signal.name.to_string()),
                };
                let mut emit = |frame| publish(&session, &id, frame);
                flow.lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .on_exit(native, exit_reason.load(Ordering::Acquire), &mut emit);
            })
        };
        let check: Arc<dyn LaunchCheck> = Arc::new(FreshLaunch {
            consent: Arc::clone(&self.consent),
            cwd: prepared.request.cwd.clone(),
        });
        let handle = self
            .spawner
            .spawn(prepared.request, check, on_data, on_exit, cancel.clone())
            .await
            .map_err(start_error)?;
        let entry = Arc::new(Entry {
            session_id: id.clone(),
            shell: prepared.shell,
            cwd: prepared.cwd.clone(),
            size: Mutex::new(prepared.size),
            flow,
            handle: Arc::clone(&handle),
            operation: AsyncMutex::new(()),
            closed: AtomicBool::new(false),
            close_scheduled: AtomicBool::new(false),
            close_result: AsyncMutex::new(None),
            consent_revoked,
        });
        {
            let mut sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
            // The live reservation guard is the only owner that can remove
            // this opening marker. Close and revocation cancel it in place.
            let slot = sessions.get_mut(&id).expect("terminal opening reservation");
            *slot = Slot::Starting {
                reservation_id,
                entry: Arc::clone(&entry),
            };
        }
        let _ = spawned.send(Some(Arc::clone(&entry)));
        self.start_watcher(session);
        if cancel.is_cancelled() {
            self.close_entry(&entry).await.map_err(pty_io)?;
            return Err(open_cancelled());
        }
        let consent = self.launch_shell_consent().await;
        if !consent.allows() {
            if consent == ConsentRead::Denied {
                entry.consent_revoked.store(true, Ordering::Release);
            }
            self.close_entry(&entry).await.map_err(pty_io)?;
            return Err(if consent == ConsentRead::Denied {
                shell_denial("terminal.open", &self.consent)
            } else {
                consent_unconfirmed("terminal.open")
            });
        }
        if cancel.is_cancelled() {
            self.close_entry(&entry).await.map_err(pty_io)?;
            return Err(open_cancelled());
        }
        let admitted = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
            if matches!(sessions.get(&id), Some(Slot::Starting { entry: current, .. }) if Arc::ptr_eq(current, &entry))
                && !entry.closed.load(Ordering::Acquire)
            {
                sessions.insert(id.clone(), Slot::Live(Arc::clone(&entry)));
                true
            } else {
                false
            }
        };
        if !admitted {
            self.close_entry(&entry).await.map_err(pty_io)?;
            return Err(not_found(&id));
        }
        reservation.committed = true;
        Ok(json!({
            "sessionId": id,
            "shell": prepared.shell,
            "cwd": prepared.cwd,
            "pid": handle.pid(),
        }))
    }

    fn attach(&self, params: SessionParams) -> Result<Value, RemoteError> {
        let entry = self.require(&params.session_id)?;
        let state = {
            let mut flow = entry
                .flow
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if entry.closed.load(Ordering::Acquire) || flow.login_expired() {
                return Err(not_found(&params.session_id));
            }
            flow.attach()
        };
        let size = *entry
            .size
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        Ok(json!({
            "sessionId": entry.session_id,
            "scrollback": STANDARD.encode(&state.scrollback),
            "status": if state.exited { "exited" } else { "running" },
            "exitCode": state.exit.as_ref().and_then(|value| value.exit_code),
            "signal": state.exit.as_ref().and_then(|value| value.signal.as_deref()),
            "cols": size.0,
            "rows": size.1,
        }))
    }

    fn detach(&self, params: SessionParams) -> Result<Value, RemoteError> {
        let entry = self.require(&params.session_id)?;
        entry
            .flow
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .detach();
        Ok(json!({ "ok": true }))
    }

    async fn write(&self, params: WriteParams) -> Result<Value, RemoteError> {
        let entry = self.require(&params.session_id)?;
        let data = STANDARD.decode(params.data.as_bytes()).map_err(|_| {
            invalid_argument("data=[invalid base64]", "base64-encoded terminal input")
        })?;
        if data.len() > MAX_WRITE_BYTES {
            return Err(invalid_argument(
                &format!("data={} raw bytes", data.len()),
                &format!("at most {MAX_WRITE_BYTES} raw terminal input bytes"),
            ));
        }
        let _operation = entry.operation.lock().await;
        if entry.closed.load(Ordering::Acquire) {
            return Err(not_found(&params.session_id));
        }
        if entry
            .flow
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .exit()
            .is_some()
        {
            return Err(exited(&params.session_id));
        }
        self.recheck(&entry, "terminal.write").await?;
        if !entry.accepts_effects() {
            return Err(not_found(&params.session_id));
        }
        entry.handle.write(data).await.map_err(pty_io)?;
        Ok(json!({ "ok": true }))
    }

    async fn resize(&self, params: ResizeParams) -> Result<Value, RemoteError> {
        let entry = self.require(&params.session_id)?;
        let cols = size(params.cols, 2, 500, "cols")?;
        let rows = size(params.rows, 1, 300, "rows")?;
        let _operation = entry.operation.lock().await;
        if entry.closed.load(Ordering::Acquire) {
            return Err(not_found(&params.session_id));
        }
        self.recheck(&entry, "terminal.resize").await?;
        if !entry.accepts_effects() {
            return Err(not_found(&params.session_id));
        }
        entry.handle.resize(cols, rows).await.map_err(pty_io)?;
        *entry
            .size
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = (cols, rows);
        Ok(json!({ "ok": true }))
    }

    fn ack(&self, params: AckParams, session: &Session) -> Result<Value, RemoteError> {
        let entry = self.require(&params.session_id)?;
        let bytes = count(params.bytes, "ack bytes")?;
        let mut emit = |frame| publish(session, &entry.session_id, frame);
        entry
            .flow
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .ack(bytes, &mut emit);
        Ok(json!({ "ok": true }))
    }

    async fn close(&self, params: SessionParams) -> Result<Value, RemoteError> {
        let (entry, handoff) = {
            let sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            match sessions.get(&params.session_id) {
                Some(Slot::Starting { entry, .. } | Slot::Live(entry)) => {
                    entry.closed.store(true, Ordering::Release);
                    (Some(Arc::clone(entry)), None)
                }
                Some(Slot::Opening {
                    cancel, handoff, ..
                }) => {
                    cancel.cancel();
                    (None, Some(handoff.clone()))
                }
                None => (None, None),
            }
        };
        // Opening holds the sender until startup either hands off a child or
        // settles without a handle. Both outcomes resolve the pending close.
        let entry = if let Some(mut handoff) = handoff {
            handoff
                .wait_for(Option::is_some)
                .await
                .ok()
                .and_then(|entry| entry.clone())
        } else {
            entry
        };
        // No `operation` lock: a write to a shell that stopped reading input holds it until the
        // child dies, and killing the child is exactly what releases it. `closed` is already set,
        // so a write that has not reached its final check still refuses.
        if let Some(entry) = entry {
            self.close_entry(&entry).await.map_err(pty_io)?;
        }
        Ok(json!({ "ok": true }))
    }

    fn list(&self) -> Result<Value, RemoteError> {
        let entries = {
            let sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            sessions
                .values()
                .filter_map(|slot| match slot {
                    Slot::Live(entry) if !entry.closed.load(Ordering::Acquire) => {
                        Some(Arc::clone(entry))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        Ok(json!({ "sessions": entries.iter().map(|entry| entry.snapshot()).collect::<Vec<_>>() }))
    }

    fn require(&self, id: &str) -> Result<Arc<Entry>, RemoteError> {
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        match sessions.get(id) {
            Some(Slot::Live(entry)) if !entry.closed.load(Ordering::Acquire) => {
                Ok(Arc::clone(entry))
            }
            _ => Err(not_found(id)),
        }
    }

    fn remove_settled(&self, entry: &Arc<Entry>) {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if sessions
            .get(&entry.session_id)
            .and_then(Slot::entry)
            .is_some_and(|current| Arc::ptr_eq(current, entry))
        {
            sessions.remove(&entry.session_id);
        }
    }

    /// Stops a session whose shell consent was withdrawn mid-call and returns the denial.
    async fn revoke(&self, entry: &Arc<Entry>, method: &str) -> RemoteError {
        entry.consent_revoked.store(true, Ordering::Release);
        match self.close_entry(entry).await {
            Ok(()) => shell_denial(method, &self.consent),
            Err(error) => pty_io(error),
        }
    }

    async fn close_entry(&self, entry: &Arc<Entry>) -> std::io::Result<()> {
        entry.closed.store(true, Ordering::Release);
        entry
            .flow
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .stop_login_output();
        let mut settled = entry.close_result.lock().await;
        let result = if let Some(result) = &*settled {
            result.clone()
        } else {
            let result = entry.handle.close().await.map_err(Arc::new);
            if result.is_ok() || entry.handle.close_is_settled() {
                *settled = Some(result.clone());
                self.remove_settled(entry);
                if let Err(error) = &result {
                    eprintln!(
                        "[runtime] terminal cleanup failed after supervisor settled: {error}"
                    );
                }
            }
            result
        };
        result.map_err(|error| std::io::Error::new(error.kind(), error.to_string()))
    }

    /// The fresh, uncoalesced read immediately before a terminal is admitted. Anything but a
    /// grant refuses the open (see [`ConsentRead::allows`]): a denial with `DENIED`, an
    /// unknown answer with the retryable `UNAVAILABLE`.
    async fn launch_shell_consent(&self) -> ConsentRead {
        let read = Arc::clone(&self.shell_read);
        read_consent("shell", self.consent_read_timeout, move || read()).await
    }

    /// The coalesced read the watcher and live-session rechecks share, so a hung consent store
    /// holds one blocking permit however often they ask.
    async fn fresh_shell_consent(&self) -> ConsentRead {
        let read = Arc::clone(&self.shell_read);
        self.consent_reader
            .read(self.consent_read_timeout, move || read())
            .await
    }

    /// The fresh check before writing to or resizing a live shell.
    ///
    /// An explicit denial revokes the session, as the watcher would. An unknown read refuses
    /// this one effect with `UNAVAILABLE` (fail closed) but leaves the session open: a slow
    /// consent store is not a withdrawal, and the next call or watcher poll reads again.
    async fn recheck(&self, entry: &Arc<Entry>, method: &str) -> Result<(), RemoteError> {
        match self.fresh_shell_consent().await {
            ConsentRead::Granted => Ok(()),
            ConsentRead::Denied => Err(self.revoke(entry, method).await),
            ConsentRead::Unknown => Err(consent_unconfirmed(method)),
        }
    }

    /// One watcher poll: schedules cleanup once shell consent is explicitly withdrawn;
    /// an unknown read keeps them open until the next poll.
    async fn poll_consent(self: &Arc<Self>, closes: &mut JoinSet<()>) {
        if self.fresh_shell_consent().await.revokes() {
            self.revoke_entries(true);
            self.schedule_closes(closes);
        }
    }

    fn schedule_closes(self: &Arc<Self>, closes: &mut JoinSet<()>) {
        let entries: Vec<_> = self
            .sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .filter_map(|slot| slot.entry().map(Arc::clone))
            .collect();
        for entry in entries {
            let pending = entry.closed.load(Ordering::Acquire)
                || entry
                    .flow
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .login_expired();
            if pending && !entry.close_scheduled.swap(true, Ordering::AcqRel) {
                let service = Arc::clone(self);
                closes.spawn(async move {
                    let _ = service.close_entry(&entry).await;
                    entry.close_scheduled.store(false, Ordering::Release);
                });
            }
        }
    }

    fn start_watcher(self: &Arc<Self>, session: Session) {
        if self.watcher_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move { watch_consent(weak, session).await });
    }

    fn revoke_entries(&self, consent_revoked: bool) {
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        for slot in sessions.values() {
            match slot {
                Slot::Starting { entry, .. } | Slot::Live(entry) => {
                    if consent_revoked {
                        entry.consent_revoked.store(true, Ordering::Release);
                    }
                    entry.closed.store(true, Ordering::Release);
                }
                Slot::Opening { cancel, .. } => cancel.cancel(),
            }
        }
    }
}

async fn watch_consent(service: Weak<Service>, session: Session) {
    let mut ticks = tokio::time::interval(CONSENT_POLL);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticks.tick().await;
    let mut closes = JoinSet::new();
    let mut disconnected = None;
    loop {
        tokio::select! {
            _ = session.closed(), if disconnected.is_none() => {
                let Some(service) = service.upgrade() else { return; };
                service.revoke_entries(false);
                disconnected = Some(service);
            }
            _ = ticks.tick() => {
                if let Some(service) = &disconnected {
                    if service.sessions.lock().unwrap_or_else(|p| p.into_inner()).is_empty() {
                        return;
                    }
                    service.schedule_closes(&mut closes);
                } else {
                    let Some(service) = service.upgrade() else { return; };
                    service.schedule_closes(&mut closes);
                    service.poll_consent(&mut closes).await;
                }
            }
            _ = closes.join_next(), if !closes.is_empty() => {}
        }
    }
}

struct Reservation {
    service: Arc<Service>,
    id: String,
    reservation_id: u64,
    committed: bool,
}

impl Reservation {
    fn new(service: Arc<Service>, id: String, reservation_id: u64) -> Self {
        Self {
            service,
            id,
            reservation_id,
            committed: false,
        }
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let mut sessions = self
            .service
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        match sessions.get(&self.id) {
            Some(Slot::Opening { reservation_id, .. })
                if *reservation_id == self.reservation_id =>
            {
                sessions.remove(&self.id);
            }
            Some(Slot::Starting {
                reservation_id,
                entry,
            }) if *reservation_id == self.reservation_id => {
                // A failed admission still owns its native child until cleanup settles.
                entry.closed.store(true, Ordering::Release);
            }
            _ => {}
        }
    }
}

/// The refusal for an effect whose shell consent could not be confirmed in time: `UNAVAILABLE`,
/// retryable, and distinct from the `DENIED` an explicit withdrawal gets.
///
/// # Example
/// ```ignore
/// return Err(consent_unconfirmed("terminal.open"));
/// ```
fn consent_unconfirmed(method: &str) -> RemoteError {
    RemoteError::new(
        codes::UNAVAILABLE,
        format!("{method} was not delivered: shell consent could not be confirmed in time."),
    )
}

fn shell_denial(method: &str, consent: &ConsentSource) -> RemoteError {
    consent_denial(method, &["shell".to_string()], consent.slot().as_str())
}

struct FreshLaunch {
    consent: Arc<ConsentSource>,
    cwd: Option<PathBuf>,
}

impl LaunchCheck for FreshLaunch {
    fn check(&self) -> Result<(), RemoteError> {
        if !self.consent.refresh().shell {
            return Err(shell_denial("terminal.open", &self.consent));
        }
        if let Some(cwd) = &self.cwd
            && !std::fs::metadata(cwd).is_ok_and(|metadata| metadata.is_dir())
        {
            return Err(invalid_argument(
                &format!("cwd={cwd:?}"),
                "an existing terminal working directory",
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenParams {
    session_id: String,
    shell: Option<RuntimeShellKind>,
    login_target: Option<String>,
    cwd: Option<String>,
    cols: f64,
    rows: f64,
    env: Option<BTreeMap<String, String>>,
    #[serde(default)]
    env_policy: environment::ShellEnvPolicy,
    scrollback_bytes: Option<f64>,
    toolchain: Option<toolchain::Selection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionParams {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteParams {
    session_id: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResizeParams {
    session_id: String,
    cols: f64,
    rows: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AckParams {
    session_id: String,
    bytes: f64,
}

struct Prepared {
    request: PtyRequest,
    shell: RuntimeShellKind,
    cwd: String,
    size: (u16, u16),
    scrollback_bytes: usize,
    login: bool,
}

fn prepare(params: OpenParams, host: PathEnv) -> Result<Prepared, RemoteError> {
    let cols = size(params.cols, 2, 500, "cols")?;
    let rows = size(params.rows, 1, 300, "rows")?;
    let scrollback_bytes = match params.scrollback_bytes {
        Some(bytes) => count(bytes, "scrollbackBytes")?.min(SCROLLBACK_MAX_BYTES),
        None => SCROLLBACK_MAX_BYTES,
    };
    if scrollback_bytes == 0 {
        return Err(invalid_argument(
            "scrollbackBytes=0",
            "a positive byte count",
        ));
    }
    let shell = params.shell.unwrap_or_else(|| default_shell(&host));
    let login = params.login_target.is_some();
    if login
        && (params.shell.is_some()
            || params.env.is_some()
            || !params.env_policy.allow.is_empty()
            || !params.env_policy.deny.is_empty())
    {
        return Err(invalid_argument(
            "login overrides",
            "a login target without shell or environment overrides",
        ));
    }
    let home = PathBuf::from(&host.home_dir);
    let cwd = resolve_cwd(params.cwd.as_deref(), &home);
    let env = toolchain::build(
        &host,
        params.toolchain.as_ref(),
        &toolchain::NativeToolchainFs,
    );
    let mut env = environment::shell(&env, &params.env_policy);
    env.insert("TERM".into(), "xterm-256color".into());
    env.insert("COLORTERM".into(), "truecolor".into());
    env.insert("MANGOSTUDIO_TERMINAL".into(), "1".into());
    env.extend(params.env.unwrap_or_default());
    let args: &[&str] = match shell {
        RuntimeShellKind::Powershell => &["-NoLogo"],
        _ if host.platform == "darwin" => &["-l"],
        _ => &[],
    };
    let (program, args) = if let Some(target) = params.login_target {
        let descriptors = super::login::descriptors();
        let descriptor = descriptors
            .get(&target)
            .ok_or_else(|| invalid_argument("login target", "a supported vendor"))?;
        let windows = host.is_windows();
        let path = environment::allowlisted_entry(&env, "PATH", windows)
            .map(|(_, value)| value.as_str())
            .filter(|value| !value.is_empty());
        // Native Windows installs use .exe. The bare shim and the batch launcher
        // installed alongside it cannot be passed literal argv on Windows.
        let name = if windows {
            format!("{}.exe", descriptor.program)
        } else {
            descriptor.program.clone()
        };
        let program = path
            .and_then(|path| crate::health::which_in(&name, OsStr::new(path)))
            .ok_or_else(|| {
                let message = if windows {
                    "A native login executable is unavailable. Copy the command instead."
                } else {
                    "Login executable is unavailable."
                };
                RemoteError::new(codes::UNAVAILABLE, message)
            })?;
        // Resolve relative PATH entries against the runtime directory before
        // the PTY changes to the requested workspace.
        let program = std::path::absolute(program).map_err(pty_io)?;
        (program, descriptor.args.clone())
    } else {
        (
            shell_program(shell, &host)?,
            args.iter().map(|value| (*value).to_owned()).collect(),
        )
    };
    let mut request = PtyRequest::new(program, args, cols, rows);
    request.cwd = Some(cwd.clone());
    request.env = Some(
        env.into_iter()
            .map(|(key, value)| (OsString::from(key), OsString::from(value)))
            .collect(),
    );
    Ok(Prepared {
        request,
        shell,
        cwd: cwd.to_string_lossy().into_owned(),
        size: (cols, rows),
        scrollback_bytes,
        login,
    })
}

fn default_shell(host: &PathEnv) -> RuntimeShellKind {
    if host.platform != "win32" {
        let login = host
            .env
            .get("SHELL")
            .and_then(|value| std::path::Path::new(value).file_name())
            .and_then(OsStr::to_str);
        let kind = match login {
            Some("bash") => Some(RuntimeShellKind::Bash),
            Some("zsh") => Some(RuntimeShellKind::Zsh),
            _ => None,
        };
        if let Some(kind) = kind
            && shell_program(kind, host).is_ok()
        {
            return kind;
        }
    }
    let order = if host.platform == "win32" {
        [
            RuntimeShellKind::Powershell,
            RuntimeShellKind::Bash,
            RuntimeShellKind::Zsh,
        ]
    } else {
        [
            RuntimeShellKind::Bash,
            RuntimeShellKind::Zsh,
            RuntimeShellKind::Powershell,
        ]
    };
    order
        .into_iter()
        .find(|kind| shell_program(*kind, host).is_ok())
        .unwrap_or(order[0])
}

fn shell_program(shell: RuntimeShellKind, host: &PathEnv) -> Result<PathBuf, RemoteError> {
    // The rule `detect_shells` and `shell.run` also use: PowerShell is Windows-only.
    let candidates = crate::health::shell_path_candidates(shell, host.is_windows());
    let path = host.env.get("PATH").map(String::as_str).unwrap_or("");
    candidates
        .iter()
        .find_map(|name| crate::health::which_in(name, OsStr::new(path)))
        .ok_or_else(|| {
            RemoteError::new(
                codes::INTERNAL,
                format!(
                    "The \"{}\" shell is not available on this system.",
                    shell_wire_name(shell)
                ),
            )
            .with_detail("kind", "shell_execution")
        })
}

/// The shell's wire name, as `terminal.open` takes it and the TypeScript refusal quoted it.
fn shell_wire_name(shell: RuntimeShellKind) -> &'static str {
    match shell {
        RuntimeShellKind::Bash => "bash",
        RuntimeShellKind::Zsh => "zsh",
        RuntimeShellKind::Powershell => "powershell",
    }
}

fn resolve_cwd(requested: Option<&str>, home: &std::path::Path) -> PathBuf {
    let path = match requested {
        None | Some("") | Some("~") => home.to_path_buf(),
        Some(value) if value.starts_with("~/") => home.join(&value[2..]),
        Some(value) => PathBuf::from(value),
    };
    if std::fs::metadata(&path).is_ok_and(|metadata| metadata.is_dir()) {
        path
    } else {
        home.to_path_buf()
    }
}

fn publish(session: &Session, id: &str, frame: OutputFrame) -> bool {
    crate::event_check::checked_emit(
        session,
        EventInput {
            topic: "terminal.output".to_string(),
            payload: frame.payload,
            stream_id: Some(id.to_string()),
            end: frame.end,
        },
    )
    .unwrap_or(false)
}

fn size(value: f64, min: u16, max: u16, name: &str) -> Result<u16, RemoteError> {
    if !value.is_finite()
        || value.fract() != 0.0
        || value < f64::from(min)
        || value > f64::from(max)
    {
        return Err(invalid_argument(
            &format!("{name}={value}"),
            &format!("an integer from {min} through {max}"),
        ));
    }
    Ok(value as u16)
}

fn count(value: f64, name: &str) -> Result<usize, RemoteError> {
    if !value.is_finite() || value.fract() != 0.0 || value < 0.0 || value > usize::MAX as f64 {
        return Err(invalid_argument(
            &format!("{name}={value}"),
            "a nonnegative finite integer byte count",
        ));
    }
    Ok(value as usize)
}

fn decode<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, RemoteError> {
    serde_json::from_value(value).map_err(|error| {
        invalid_argument(
            &format!("params={error}"),
            "the terminal method's declared object shape",
        )
    })
}

fn open_cancelled() -> RemoteError {
    RemoteError::new(
        codes::CANCELLED,
        "Terminal open was cancelled before admission.",
    )
}

fn not_found(id: &str) -> RemoteError {
    RemoteError::new(
        codes::INTERNAL,
        format!("Terminal session {id:?} was not found; it may have already closed."),
    )
    .with_detail("kind", "terminal_not_found")
    .with_detail("sessionId", id)
}

fn exited(id: &str) -> RemoteError {
    RemoteError::new(
        codes::INTERNAL,
        format!("Terminal session {id:?} has already exited; write is refused."),
    )
    .with_detail("kind", "terminal_exited")
    .with_detail("sessionId", id)
}

fn pty_io(error: std::io::Error) -> RemoteError {
    RemoteError::new(codes::INTERNAL, format!("Terminal IO failed: {error}"))
        .with_detail("kind", "shell_execution")
}

fn start_error(error: PtyError) -> RemoteError {
    match error {
        PtyError::LaunchDenied(error) => error,
        PtyError::CancelledBeforeStart => RemoteError::new(
            codes::CANCELLED,
            "Terminal open was cancelled before launch.",
        ),
        PtyError::LimitExceeded => {
            RemoteError::new(codes::UNAVAILABLE, "Terminal process capacity is full.")
        }
        PtyError::InvalidSize { cols, rows } => invalid_argument(
            &format!("size={cols}x{rows}"),
            "a size within the terminal's column and row limits",
        ),
        PtyError::Start(error) => pty_io(error),
        PtyError::SupervisorUnavailable => {
            RemoteError::new(codes::UNAVAILABLE, "Terminal supervisor is unavailable.")
        }
    }
}

#[cfg(test)]
mod tests;
