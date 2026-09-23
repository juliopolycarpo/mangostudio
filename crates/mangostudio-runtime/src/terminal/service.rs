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
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

use super::flow::{ExitInfo, OutputFrame, SCROLLBACK_MAX_BYTES, TerminalFlow};
use super::pty::{DefaultPtySpawner, PtyError, PtyHandle, PtyRequest, PtySpawner};
use crate::blocking::run_blocking;
use crate::commands::{environment, toolchain};
use crate::consent::source::ConsentSource;
use crate::ports::authorization::consent_denial;
use crate::probing::detection::path_env::PathEnv;
use crate::registry::Registry;
use crate::subprocess::LaunchCheck;

const MAX_TERMINAL_SESSIONS: usize = 16;
const MAX_WRITE_BYTES: usize = 16 * 1024 - 1;
const CONSENT_POLL: Duration = Duration::from_millis(100);

pub(crate) fn register(mut registry: Registry, consent: ConsentSource) -> Registry {
    let service = Arc::new(Service::new(
        Arc::new(consent),
        Arc::new(DefaultPtySpawner),
        Arc::new(|| crate::probing::host::build_runtime_path_env(None)),
    ));
    for method in [
        "terminal.open",
        "terminal.attach",
        "terminal.detach",
        "terminal.write",
        "terminal.resize",
        "terminal.ack",
        "terminal.close",
        "terminal.list",
    ] {
        let service = Arc::clone(&service);
        registry = registry.implement(method, move |params: Value, context: CallContext| {
            let service = Arc::clone(&service);
            async move { service.call(method, params, context).await }
        });
    }
    registry
}

enum Slot {
    Opening(u64),
    Live(Arc<Entry>),
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
    consent_revoked: Arc<AtomicBool>,
}

impl Entry {
    fn snapshot(&self) -> Value {
        let size = *self
            .size
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
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
        Self {
            consent,
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
        let reservation_id = self.next_reservation.fetch_add(1, Ordering::Relaxed);
        {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if sessions.contains_key(&id) {
                return Err(argument(
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
            sessions.insert(id.clone(), Slot::Opening(reservation_id));
        }
        let mut reservation = Reservation::new(Arc::clone(self), id.clone(), reservation_id);
        let host = (self.host)();
        let prepared = run_blocking(move || prepare(params, host)).await?;
        let flow = Arc::new(Mutex::new(
            TerminalFlow::new(prepared.scrollback_bytes)
                .map_err(|message| argument(&message, "a positive scrollback byte count"))?,
        ));
        let on_data = {
            let flow = Arc::clone(&flow);
            let session = session.clone();
            let id = id.clone();
            Arc::new(move |bytes: Vec<u8>| {
                let mut emit = |frame| publish(&session, &id, frame);
                flow.lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .on_data(&bytes, &mut emit);
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
        let handle = tokio::select! {
            result = self.spawner.spawn(prepared.request, check, on_data, on_exit) => result.map_err(start_error)?,
            () = cancel.cancelled() => return Err(RemoteError::new(
                codes::CANCELLED,
                "Terminal open was cancelled before admission.",
            )),
        };
        if cancel.is_cancelled() {
            handle.close().await.map_err(pty_io)?;
            return Err(RemoteError::new(
                codes::CANCELLED,
                "Terminal open was cancelled before admission.",
            ));
        }
        if !self.fresh_shell_consent().await {
            handle.close().await.map_err(pty_io)?;
            return Err(consent_denial(
                "terminal.open",
                &["shell".to_string()],
                self.consent.slot().as_str(),
            ));
        }
        let entry = Arc::new(Entry {
            session_id: id.clone(),
            shell: prepared.shell,
            cwd: prepared.cwd.clone(),
            size: Mutex::new(prepared.size),
            flow,
            handle: Arc::clone(&handle),
            operation: AsyncMutex::new(()),
            closed: AtomicBool::new(false),
            consent_revoked,
        });
        let admitted = {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if matches!(sessions.get(&id), Some(Slot::Opening(current)) if *current == reservation_id)
            {
                sessions.insert(id.clone(), Slot::Live(entry));
                true
            } else {
                false
            }
        };
        if !admitted {
            handle.close().await.map_err(pty_io)?;
            return Err(not_found(&id));
        }
        reservation.committed = true;
        self.start_watcher(session);
        Ok(json!({
            "sessionId": id,
            "shell": prepared.shell,
            "cwd": prepared.cwd,
            "pid": handle.pid(),
        }))
    }

    fn attach(&self, params: SessionParams) -> Result<Value, RemoteError> {
        let entry = self.require(&params.session_id)?;
        let mut flow = entry
            .flow
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let state = flow.attach();
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
        let data = STANDARD
            .decode(params.data.as_bytes())
            .map_err(|_| argument("data=[invalid base64]", "base64-encoded terminal input"))?;
        if data.len() > MAX_WRITE_BYTES {
            return Err(argument(
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
        if !self.fresh_shell_consent().await {
            self.remove_live(&entry);
            entry.consent_revoked.store(true, Ordering::Release);
            self.close_entry(&entry).await.map_err(pty_io)?;
            return Err(consent_denial(
                "terminal.write",
                &["shell".to_string()],
                self.consent.slot().as_str(),
            ));
        }
        if entry.closed.load(Ordering::Acquire) {
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
        if !self.fresh_shell_consent().await {
            self.remove_live(&entry);
            entry.consent_revoked.store(true, Ordering::Release);
            self.close_entry(&entry).await.map_err(pty_io)?;
            return Err(consent_denial(
                "terminal.resize",
                &["shell".to_string()],
                self.consent.slot().as_str(),
            ));
        }
        if entry.closed.load(Ordering::Acquire) {
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
        let entry = {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            match sessions.remove(&params.session_id) {
                Some(Slot::Live(entry)) => {
                    entry.closed.store(true, Ordering::Release);
                    Some(entry)
                }
                _ => None,
            }
        };
        if let Some(entry) = entry {
            let _operation = entry.operation.lock().await;
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
                    Slot::Live(entry) => Some(Arc::clone(entry)),
                    Slot::Opening(_) => None,
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

    fn remove_live(&self, entry: &Arc<Entry>) {
        entry.closed.store(true, Ordering::Release);
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if matches!(sessions.get(&entry.session_id), Some(Slot::Live(current)) if Arc::ptr_eq(current, entry))
        {
            sessions.remove(&entry.session_id);
        }
    }

    async fn close_entry(&self, entry: &Arc<Entry>) -> std::io::Result<()> {
        entry.closed.store(true, Ordering::Release);
        entry.handle.close().await
    }

    async fn fresh_shell_consent(&self) -> bool {
        let source = Arc::clone(&self.consent);
        tokio::time::timeout(
            Duration::from_secs(2),
            run_blocking(move || source.refresh().shell),
        )
        .await
        .unwrap_or(false)
    }

    fn start_watcher(self: &Arc<Self>, session: Session) {
        if self.watcher_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move { watch_consent(weak, session).await });
    }

    async fn revoke_all(&self, consent_revoked: bool) {
        let entries = {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            sessions
                .drain()
                .filter_map(|(_, slot)| match slot {
                    Slot::Live(entry) => {
                        entry.closed.store(true, Ordering::Release);
                        entry
                            .consent_revoked
                            .store(consent_revoked, Ordering::Release);
                        Some(entry)
                    }
                    Slot::Opening(_) => None,
                })
                .collect::<Vec<_>>()
        };
        let mut closes = tokio::task::JoinSet::new();
        for entry in entries {
            closes.spawn(async move {
                let _ = entry.handle.close().await;
            });
        }
        while closes.join_next().await.is_some() {}
    }
}

async fn watch_consent(service: Weak<Service>, session: Session) {
    let mut ticks = tokio::time::interval(CONSENT_POLL);
    ticks.tick().await;
    loop {
        tokio::select! {
            _ = session.closed() => {
                if let Some(service) = service.upgrade() {
                    service.revoke_all(false).await;
                }
                return;
            }
            _ = ticks.tick() => {
                let Some(service) = service.upgrade() else { return; };
                if !service.fresh_shell_consent().await {
                    service.revoke_all(true).await;
                }
            }
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
        if matches!(sessions.get(&self.id), Some(Slot::Opening(current)) if *current == self.reservation_id)
        {
            sessions.remove(&self.id);
        }
    }
}

struct FreshLaunch {
    consent: Arc<ConsentSource>,
    cwd: Option<PathBuf>,
}

impl LaunchCheck for FreshLaunch {
    fn check(&self) -> Result<(), RemoteError> {
        if !self.consent.refresh().shell {
            return Err(consent_denial(
                "terminal.open",
                &["shell".to_string()],
                self.consent.slot().as_str(),
            ));
        }
        if let Some(cwd) = &self.cwd
            && !std::fs::metadata(cwd).is_ok_and(|metadata| metadata.is_dir())
        {
            return Err(argument(
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
}

fn prepare(params: OpenParams, host: PathEnv) -> Result<Prepared, RemoteError> {
    let cols = size(params.cols, 2, 500, "cols")?;
    let rows = size(params.rows, 1, 300, "rows")?;
    let scrollback_bytes = match params.scrollback_bytes {
        Some(bytes) => count(bytes, "scrollbackBytes")?.min(SCROLLBACK_MAX_BYTES),
        None => SCROLLBACK_MAX_BYTES,
    };
    if scrollback_bytes == 0 {
        return Err(argument("scrollbackBytes=0", "a positive byte count"));
    }
    let shell = params.shell.unwrap_or_else(|| default_shell(&host));
    let program = shell_program(shell, &host)?;
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
    let mut request = PtyRequest::new(program, args.iter().copied(), cols, rows);
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
    let candidates: &[&str] = match shell {
        RuntimeShellKind::Bash => &["bash"],
        RuntimeShellKind::Zsh => &["zsh"],
        RuntimeShellKind::Powershell if host.platform == "win32" => &["pwsh", "powershell"],
        RuntimeShellKind::Powershell => &[],
    };
    let path = host.env.get("PATH").map(String::as_str).unwrap_or("");
    candidates
        .iter()
        .find_map(|name| crate::health::which_in(name, OsStr::new(path)))
        .ok_or_else(|| {
            RemoteError::new(
                codes::INTERNAL,
                format!("The {shell:?} shell is not available on this system."),
            )
            .with_detail("kind", "shell_execution")
        })
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
        return Err(argument(
            &format!("{name}={value}"),
            &format!("an integer from {min} through {max}"),
        ));
    }
    Ok(value as u16)
}

fn count(value: f64, name: &str) -> Result<usize, RemoteError> {
    if !value.is_finite() || value.fract() != 0.0 || value < 0.0 || value > usize::MAX as f64 {
        return Err(argument(
            &format!("{name}={value}"),
            "a nonnegative finite integer byte count",
        ));
    }
    Ok(value as usize)
}

fn decode<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, RemoteError> {
    serde_json::from_value(value).map_err(|error| {
        argument(
            &format!("params={error}"),
            "the terminal method's declared object shape",
        )
    })
}

fn argument(value: &str, expected: &str) -> RemoteError {
    RemoteError::new(
        codes::INTERNAL,
        format!("Invalid {value}; expected {expected}."),
    )
    .with_detail("kind", "tool_argument")
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
        PtyError::InvalidSize { cols, rows } => argument(
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
