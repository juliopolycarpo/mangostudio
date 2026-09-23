//! `install.run` and `install.cancel` handlers, and the owner task each run keeps until it ends.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use mango_protocol::error::{RemoteError, codes};
use mango_protocol::session::{CallContext, EventInput, Session};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use super::environment::install_environment;
use super::log::{FileInstallLog, InstallLog, resolve_log_path};
use super::outcome::{RunOutcome, RunStatus, launched_status};
use super::output::{LineDecoder, OutputLimit};
use super::runs::{AlreadyActive, InstallRuns, RunControl, RunLease, StopReason};
use crate::blocking::run_blocking;
use crate::commands::toolchain::{self, NativeToolchainFs, ToolchainFs};
use crate::consent::read::{CONSENT_READ_TIMEOUT, ConsentRead, ConsentReader};
use crate::consent::source::ConsentSource;
use crate::ports::audit::{Audit, AuditEntry, Outcome};
use crate::ports::authorization::consent_denial;
use crate::ports::wall_clock::{SystemWallClock, WallClock};
use crate::probing::detection::path_env::PathEnv;
use crate::registry::Registry;
use crate::subprocess::{
    DefaultProcessSpawner, LaunchCheck, ProcessBudget, ProcessControl, ProcessOutputChunk,
    ProcessOutputTap, ProcessRequest, ProcessSpawner, ProcessStartError, ProcessStream,
};

#[cfg(test)]
mod tests;

/// Every method [`register`] installs; together with the other shell methods they back
/// `features.shell`.
pub(crate) const INSTALL_METHODS: [&str; 2] = ["install.run", "install.cancel"];

/// The event topic carrying one run's output, keyed by run id.
const INSTALL_OUTPUT_TOPIC: &str = "install.output";

/// `INSTALL_OUTPUT_LIMIT_BYTES`: the combined capture limit when a run names none.
const DEFAULT_OUTPUT_LIMIT_BYTES: usize = 1024 * 1024;

/// How often a running step rechecks shell consent — the terminal service's cadence.
const CONSENT_POLL: Duration = Duration::from_millis(100);

/// Unread output chunks one run may hold before the pipe reader waits for the owner.
const OUTPUT_TAP_CHUNKS: usize = 64;

/// Publishes `install.output` frames for one run.
pub(crate) trait InstallEvents: Send + Sync {
    /// `Ok(false)` means the session can no longer carry frames; `Err` refuses only this frame.
    fn emit(&self, input: EventInput) -> Result<bool, String>;
}

/// The production [`InstallEvents`]: the hub session the run was requested on.
struct SessionEvents(Session);

impl InstallEvents for SessionEvents {
    fn emit(&self, input: EventInput) -> Result<bool, String> {
        crate::event_check::checked_emit(&self.0, input)
    }
}

/// A fresh read of this machine's shell consent.
pub(crate) trait InstallConsent: Send + Sync {
    /// `Err` carries the wire denial for `install.run`.
    fn check(&self) -> Result<(), RemoteError>;
}

/// The production [`InstallConsent`]: `runtime.json`, re-read on every call.
struct SourceConsent(ConsentSource);

impl InstallConsent for SourceConsent {
    fn check(&self) -> Result<(), RemoteError> {
        if self.0.refresh().shell {
            return Ok(());
        }
        Err(consent_denial(
            "install.run",
            &["shell".to_owned()],
            self.0.slot().as_str(),
        ))
    }
}

/// The supervisor's last check before the effect: consent, read immediately before launch.
struct LaunchConsent(Arc<dyn InstallConsent>);

impl LaunchCheck for LaunchConsent {
    fn check(&self) -> Result<(), RemoteError> {
        self.0.check()
    }
}

/// Where lifecycle facts go that no hub may be left to hear: `event` plus a JSON detail.
pub(crate) type Diagnostics = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// Everything a run touches outside its own memory, injected so tests use named fakes.
pub(crate) struct Ports {
    pub spawner: Arc<dyn ProcessSpawner>,
    pub consent: Arc<dyn InstallConsent>,
    pub log: Arc<dyn InstallLog>,
    pub host: Arc<dyn Fn() -> PathEnv + Send + Sync>,
    pub toolchain_fs: Arc<dyn ToolchainFs + Send + Sync>,
    pub clock: Arc<dyn WallClock>,
    pub audit: Arc<dyn Audit>,
    pub diagnostics: Diagnostics,
    pub runs: Arc<InstallRuns>,
    /// `<mango_home>/runtime`, where a relative log path lands.
    pub runtime_home: PathBuf,
}

/// Registers `install.run` and `install.cancel` against the process-wide run table.
pub(crate) fn register(
    mut registry: Registry,
    consent: ConsentSource,
    mango_home: &Path,
) -> Registry {
    let service = Arc::new(Service {
        ports: Ports {
            spawner: Arc::new(DefaultProcessSpawner),
            consent: Arc::new(SourceConsent(consent)),
            log: Arc::new(FileInstallLog),
            host: Arc::new(|| crate::probing::host::build_runtime_path_env(None)),
            toolchain_fs: Arc::new(NativeToolchainFs),
            clock: Arc::new(SystemWallClock),
            audit: registry.audit(),
            diagnostics: Arc::new(|event, detail| {
                eprintln!("mangostudio-runtime: {event} {detail}");
            }),
            runs: InstallRuns::process(),
            runtime_home: mango_home.join("runtime"),
        },
        consent_read_timeout: CONSENT_READ_TIMEOUT,
    });
    for method in INSTALL_METHODS {
        let service = Arc::clone(&service);
        registry = registry.implement(method, move |params: Value, context: CallContext| {
            let service = Arc::clone(&service);
            async move {
                if method == "install.cancel" {
                    return service.cancel(params);
                }
                let events: Arc<dyn InstallEvents> =
                    Arc::new(SessionEvents(context.session().clone()));
                service.run(params, events, context.cancel().clone()).await
            }
        });
    }
    registry
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunParams {
    run_id: String,
    argv: Vec<String>,
    env: Option<BTreeMap<String, String>>,
    timeout_ms: f64,
    log_path: String,
    output_limit_bytes: Option<f64>,
    accepted_exit_codes: Option<Vec<f64>>,
    toolchain: Option<toolchain::Selection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelParams {
    run_id: String,
}

/// One validated run request; nothing here has touched the machine yet.
struct RunPlan {
    run_id: String,
    argv: Vec<String>,
    recipe_env: BTreeMap<String, String>,
    timeout: Duration,
    log_path: String,
    limit: usize,
    limit_label: String,
    accepted: Vec<f64>,
    toolchain: Option<toolchain::Selection>,
}

impl RunPlan {
    /// Validates the request shape before any reservation or effect.
    fn new(params: RunParams) -> Result<Self, RemoteError> {
        if params.argv.is_empty() {
            return Err(argument(
                "argv=[]",
                "a non-empty argv naming the installer to execute",
            ));
        }
        let timeout = positive_duration(params.timeout_ms)?;
        let (limit, limit_label) = match params.output_limit_bytes {
            None => (
                DEFAULT_OUTPUT_LIMIT_BYTES,
                DEFAULT_OUTPUT_LIMIT_BYTES.to_string(),
            ),
            Some(bytes) if bytes.is_finite() && bytes >= 0.0 => {
                // A fractional limit keeps its whole bytes, as a JavaScript `subarray` would.
                (bytes.floor() as usize, js_number(bytes))
            }
            Some(bytes) => {
                return Err(argument(
                    &format!("outputLimitBytes={bytes}"),
                    "a finite non-negative byte count",
                ));
            }
        };
        Ok(Self {
            run_id: params.run_id,
            argv: params.argv,
            recipe_env: params.env.unwrap_or_default(),
            timeout,
            log_path: params.log_path,
            limit,
            limit_label,
            accepted: params.accepted_exit_codes.unwrap_or_default(),
            toolchain: params.toolchain,
        })
    }
}

/// The install handlers over one set of [`Ports`].
pub(crate) struct Service {
    ports: Ports,
    /// Bound on one running-step consent read; [`CONSENT_READ_TIMEOUT`] outside tests.
    consent_read_timeout: Duration,
}

impl Service {
    /// `install.run`: reserves the run id, hands the run to its own owner task, and waits for it.
    ///
    /// `cancel` fires when the hub session ends or the hub abandons this request. That marks the
    /// run stopping — a step that has not launched never will, a running step still finishes —
    /// and the handler keeps waiting, so it never reports a status the step did not reach.
    async fn run(
        self: &Arc<Self>,
        params: Value,
        events: Arc<dyn InstallEvents>,
        cancel: CancellationToken,
    ) -> Result<Value, RemoteError> {
        let params: RunParams = serde_json::from_value(params).map_err(|_| {
            argument(
                "params=[redacted]",
                "a run id, argv, numeric timeout and log path",
            )
        })?;
        let plan = RunPlan::new(params)?;
        let lease = self
            .ports
            .runs
            .reserve(&plan.run_id)
            .map_err(|AlreadyActive| {
                argument(
                    &format!("runId={:?}", plan.run_id),
                    "a run id that is not already active",
                )
            })?;
        let control = Arc::clone(lease.control());
        let run_id = plan.run_id.clone();
        let started = epoch_ms(self.ports.clock.now());
        let (delivered, mut received) = oneshot::channel();
        tokio::spawn(Arc::clone(self).own(plan, lease, Arc::clone(&events), started, delivered));
        let received = tokio::select! {
            biased;
            result = &mut received => result,
            () = cancel.cancelled() => {
                control.request_stop(StopReason::HubLost);
                received.await
            }
        };
        match received {
            Ok(result) => Ok(result),
            Err(_) => Ok(self.owner_vanished(&run_id, events, started)),
        }
    }

    /// `install.cancel`: a machine mutation, so it stops the chain rather than killing a step.
    fn cancel(&self, params: Value) -> Result<Value, RemoteError> {
        let params: CancelParams = serde_json::from_value(params)
            .map_err(|_| argument("params=[redacted]", "a run id to cancel"))?;
        self.ports.runs.stop(&params.run_id, StopReason::Cancelled);
        Ok(json!({ "ok": true }))
    }

    /// Runs one step to its end, independent of the request that started it.
    async fn own(
        self: Arc<Self>,
        plan: RunPlan,
        lease: RunLease,
        events: Arc<dyn InstallEvents>,
        started: u64,
        delivered: oneshot::Sender<Value>,
    ) {
        let mut stream = OutputStream {
            events,
            run_id: plan.run_id.clone(),
            diagnostics: Arc::clone(&self.ports.diagnostics),
            observed: true,
        };
        let outcome = self.execute(&plan, lease.control(), &mut stream).await;
        stream.end();
        let finished = epoch_ms(self.ports.clock.now());
        if delivered.send(outcome.to_wire(started, finished)).is_err() {
            self.record_unobserved(&plan.run_id, outcome, started, finished)
                .await;
        }
        drop(lease);
    }

    async fn execute(
        &self,
        plan: &RunPlan,
        control: &RunControl,
        stream: &mut OutputStream,
    ) -> RunOutcome {
        let host = (self.ports.host)();
        let log_path = resolve_log_path(
            &plan.log_path,
            &self.ports.runtime_home,
            Path::new(&host.home_dir),
        );
        let prepared = {
            let log = Arc::clone(&self.ports.log);
            let path = log_path.clone();
            run_blocking(move || log.prepare(&path)).await
        };
        if let Err(error) = prepared {
            stream.report_failure(&error.to_string());
            return RunOutcome::not_launched(RunStatus::SpawnFailed);
        }
        if let Some(reason) = control.stop_reason() {
            stream.line("system", stopped_before_launch(reason));
            return RunOutcome::not_launched(RunStatus::Cancelled);
        }
        let env = {
            let fs = Arc::clone(&self.ports.toolchain_fs);
            let selection = plan.toolchain.clone();
            let recipe = plan.recipe_env.clone();
            run_blocking(move || {
                let source = toolchain::build(&host, selection.as_ref(), fs.as_ref());
                install_environment(&source, &recipe, &host.platform)
            })
            .await
        };
        let (tap, chunks) = ProcessOutputTap::channel(OUTPUT_TAP_CHUNKS);
        let mut request = ProcessRequest::new(&plan.argv[0], plan.argv[1..].iter().cloned())
            .with_budget(ProcessBudget::new(plan.timeout, 0, 0))
            .with_output_tap(tap);
        request.env = Some(
            env.into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect(),
        );
        let check: Arc<dyn LaunchCheck> = Arc::new(LaunchConsent(Arc::clone(&self.ports.consent)));
        match self
            .ports
            .spawner
            .start(request, check, control.launch_token().clone())
            .await
        {
            Ok(process) => {
                self.follow(plan, control, &process, chunks, log_path, stream)
                    .await
            }
            Err(error) => not_launched(error, control, stream),
        }
    }

    /// Streams a launched step's output until the supervisor publishes its terminal record.
    async fn follow(
        &self,
        plan: &RunPlan,
        control: &RunControl,
        process: &ProcessControl,
        mut chunks: mpsc::Receiver<ProcessOutputChunk>,
        log_path: PathBuf,
        stream: &mut OutputStream,
    ) -> RunOutcome {
        let mut output = RunOutput {
            limit: OutputLimit::new(plan.limit, plan.limit_label.clone()),
            stdout: LineDecoder::default(),
            stderr: LineDecoder::default(),
            log: Arc::clone(&self.ports.log),
            log_path,
            log_failure: None,
        };
        let mut stop = control.subscribe();
        // A stop recorded between the launch check and this point finds the step running.
        if let Some(reason) = *stop.borrow_and_update() {
            stream.line("system", stopping_notice(reason));
        }
        let mut stop_open = true;
        let mut consent_poll = tokio::time::interval(CONSENT_POLL);
        consent_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        consent_poll.tick().await;
        let mut watching_consent = true;
        let consent_reader = ConsentReader::new("shell");
        let terminal = loop {
            tokio::select! {
                biased;
                chunk = chunks.recv() => match chunk {
                    Some(chunk) => output.consume(chunk, stream).await,
                    None => break process.wait().await,
                },
                terminal = process.wait() => {
                    while let Ok(chunk) = chunks.try_recv() {
                        output.consume(chunk, stream).await;
                    }
                    break terminal;
                }
                changed = stop.changed(), if stop_open => {
                    stop_open = changed.is_ok();
                    if let Some(reason) = *stop.borrow_and_update() {
                        stream.line("system", stopping_notice(reason));
                    }
                }
                _ = consent_poll.tick(), if watching_consent => {
                    if self.consent_read(&consent_reader).await.revokes() {
                        watching_consent = false;
                        control.request_stop(StopReason::ConsentRevoked);
                    }
                }
            }
        };
        output.finish(stream);
        if let Some(detail) = output.log_failure.take() {
            stream.report_failure(&format!("Install log write failed: {detail}"));
        }
        let (exit_code, status) = launched_status(&terminal, &plan.accepted, cfg!(windows));
        if status == RunStatus::TimedOut {
            stream.line(
                "system",
                "The install step reached its timeout and its process tree was stopped; the \
                 machine may be partially changed.",
            );
        }
        RunOutcome {
            exit_code,
            status,
            truncated: output.limit.truncated(),
            launched: true,
        }
    }

    /// A fresh consent read for the running-step watcher, bounded; a read that cannot finish is
    /// [`ConsentRead::Unknown`], which leaves the step running until the next poll.
    async fn consent_read(&self, reader: &ConsentReader) -> ConsentRead {
        let consent = Arc::clone(&self.ports.consent);
        reader
            .read(self.consent_read_timeout, move || consent.check().is_ok())
            .await
    }

    /// Records a run whose request is gone: the audit line its handler never wrote, and the
    /// outcome on stderr, since no hub is left to receive the result.
    async fn record_unobserved(
        &self,
        run_id: &str,
        outcome: RunOutcome,
        started: u64,
        finished: u64,
    ) {
        (self.ports.diagnostics)(
            "install_run_settled_unobserved",
            json!({
                "runId": run_id,
                "status": outcome.status.as_str(),
                "exitCode": outcome.exit_code,
                "truncated": outcome.truncated,
                "durationMs": finished.saturating_sub(started),
                "partialEffectsPossible": outcome.partial_effects_possible(),
            }),
        );
        self.ports
            .audit
            .record(AuditEntry {
                method: "install.run".to_owned(),
                outcome: Outcome::Ok,
                duration: Duration::from_millis(finished.saturating_sub(started)),
                capability: None,
                code: None,
            })
            .await;
    }

    /// The owner task ended without a result (it panicked). The step may have run, so the
    /// honest reading is `failed`, as the hub reads a lost track of an install.
    fn owner_vanished(&self, run_id: &str, events: Arc<dyn InstallEvents>, started: u64) -> Value {
        let mut stream = OutputStream {
            events,
            run_id: run_id.to_owned(),
            diagnostics: Arc::clone(&self.ports.diagnostics),
            observed: true,
        };
        stream.report_failure(
            "The install run's owner stopped unexpectedly; the machine may be partially changed.",
        );
        stream.end();
        let outcome = RunOutcome {
            exit_code: None,
            status: RunStatus::Failed,
            truncated: false,
            launched: true,
        };
        outcome.to_wire(started, epoch_ms(self.ports.clock.now()))
    }
}

/// Maps a start that never produced a running step. Nothing launched in any of these cases,
/// except a supervisor that stopped before reporting, whose effect is unknown.
fn not_launched(
    error: ProcessStartError,
    control: &RunControl,
    stream: &mut OutputStream,
) -> RunOutcome {
    match error {
        ProcessStartError::CancelledBeforeStart => {
            let reason = control.stop_reason().unwrap_or(StopReason::Cancelled);
            stream.line("system", stopped_before_launch(reason));
            RunOutcome::not_launched(RunStatus::Cancelled)
        }
        ProcessStartError::LaunchDenied(_) => {
            stream.line(
                "system",
                "Shell consent was withdrawn before the install started; nothing was launched.",
            );
            RunOutcome::not_launched(RunStatus::Cancelled)
        }
        ProcessStartError::TimedOutBeforeStart => {
            stream.line(
                "system",
                "The install reached its timeout before it started; nothing was launched.",
            );
            RunOutcome::not_launched(RunStatus::TimedOut)
        }
        ProcessStartError::SpawnFailed(error) => {
            stream.report_failure(&error.to_string());
            RunOutcome::not_launched(RunStatus::SpawnFailed)
        }
        ProcessStartError::LimitExceeded => {
            stream.report_failure(
                "Process admission limit exceeded; nothing was launched. Retry once other \
                 commands finish.",
            );
            RunOutcome::not_launched(RunStatus::SpawnFailed)
        }
        ProcessStartError::SupervisorUnavailable => {
            stream.report_failure(
                "The process supervisor stopped before reporting whether the install started.",
            );
            RunOutcome {
                exit_code: None,
                status: RunStatus::Failed,
                truncated: false,
                launched: true,
            }
        }
    }
}

fn stopped_before_launch(reason: StopReason) -> &'static str {
    match reason {
        StopReason::Cancelled => "Install cancelled before it started; nothing was launched.",
        StopReason::HubLost => {
            "The hub stopped waiting before the install started; nothing was launched."
        }
        StopReason::ConsentRevoked => {
            "Shell consent was withdrawn before the install started; nothing was launched."
        }
    }
}

fn stopping_notice(reason: StopReason) -> &'static str {
    match reason {
        StopReason::Cancelled => {
            "Cancellation requested: the running install step will finish within its timeout, \
             and no further step will start."
        }
        StopReason::HubLost => {
            "The hub stopped waiting: the running install step will finish within its timeout, \
             and no further step will start."
        }
        StopReason::ConsentRevoked => {
            "Shell consent was withdrawn: the running install step will finish within its \
             timeout, and no further step will start."
        }
    }
}

/// One run's `install.output` stream, which goes silent the first time the session is gone.
///
/// A closed session is final for a run: the installer keeps going (it is a machine mutation, and
/// abandoning it half-applied is worse than finishing unobserved) and the log file keeps every
/// captured byte the dropped lines would have carried.
struct OutputStream {
    events: Arc<dyn InstallEvents>,
    run_id: String,
    diagnostics: Diagnostics,
    observed: bool,
}

impl OutputStream {
    fn publish(&mut self, stream: &str, line: &str, end: bool) -> bool {
        if !self.observed {
            return false;
        }
        let mut payload = json!({ "stream": stream, "line": line });
        if end {
            payload["end"] = json!(true);
        }
        let input = EventInput {
            topic: INSTALL_OUTPUT_TOPIC.to_owned(),
            payload,
            stream_id: Some(self.run_id.clone()),
            end,
        };
        match self.events.emit(input) {
            Ok(true) => true,
            Ok(false) => {
                self.observed = false;
                (self.diagnostics)("install_output_unobserved", json!({ "runId": self.run_id }));
                false
            }
            Err(error) => {
                (self.diagnostics)(
                    "install_output_rejected",
                    json!({ "runId": self.run_id, "error": error }),
                );
                false
            }
        }
    }

    fn line(&mut self, stream: &str, line: &str) {
        self.publish(stream, line, false);
    }

    /// Why a run did not succeed — the one fact the log file cannot record — goes to stderr when
    /// the stream can no longer carry it. Details are host errors, never arguments or secrets.
    fn report_failure(&mut self, detail: &str) {
        if self.publish("system", detail, false) {
            return;
        }
        (self.diagnostics)(
            "install_failure_unobserved",
            json!({ "runId": self.run_id, "detail": detail }),
        );
    }

    fn end(&mut self) {
        self.publish("system", "", true);
    }
}

/// A launched step's bounded capture: the shared limit, a decoder per pipe, and the raw log.
struct RunOutput {
    limit: OutputLimit,
    stdout: LineDecoder,
    stderr: LineDecoder,
    log: Arc<dyn InstallLog>,
    log_path: PathBuf,
    log_failure: Option<String>,
}

impl RunOutput {
    async fn consume(&mut self, chunk: ProcessOutputChunk, stream: &mut OutputStream) {
        let accepted = self.limit.accept(&chunk.bytes).to_vec();
        if let Some(notice) = self.limit.take_notice() {
            stream.line("system", &notice);
        }
        if accepted.is_empty() {
            return;
        }
        self.append_log(&accepted).await;
        let (name, decoder) = match chunk.stream {
            ProcessStream::Stdout => ("stdout", &mut self.stdout),
            ProcessStream::Stderr => ("stderr", &mut self.stderr),
        };
        for line in decoder.push(&accepted) {
            stream.line(name, &line);
        }
    }

    /// Appends in arrival order; after the first failure no later byte is written, and the
    /// failure is reported once the step ends rather than overriding its status.
    async fn append_log(&mut self, bytes: &[u8]) {
        if self.log_failure.is_some() {
            return;
        }
        let log = Arc::clone(&self.log);
        let path = self.log_path.clone();
        let bytes = bytes.to_vec();
        if let Err(error) = run_blocking(move || log.append(&path, &bytes)).await {
            self.log_failure = Some(error.to_string());
        }
    }

    fn finish(&mut self, stream: &mut OutputStream) {
        if let Some(tail) = self.stdout.finish() {
            stream.line("stdout", &tail);
        }
        if let Some(tail) = self.stderr.finish() {
            stream.line("stderr", &tail);
        }
    }
}

fn positive_duration(milliseconds: f64) -> Result<Duration, RemoteError> {
    let invalid = || {
        argument(
            &format!("timeoutMs={milliseconds}"),
            "a positive finite duration the platform clock can represent",
        )
    };
    if !milliseconds.is_finite() || milliseconds <= 0.0 {
        return Err(invalid());
    }
    let duration = Duration::try_from_secs_f64(milliseconds / 1000.0).map_err(|_| invalid())?;
    if std::time::Instant::now().checked_add(duration).is_none() {
        return Err(invalid());
    }
    Ok(duration)
}

/// JavaScript's `Number#toString` for the finite values a byte limit can take.
fn js_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e21 {
        return format!("{}", value as i128);
    }
    format!("{value}")
}

fn epoch_ms(at: SystemTime) -> u64 {
    at.duration_since(UNIX_EPOCH).map_or(0, |elapsed| {
        u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
    })
}

fn argument(value: &str, expected: &str) -> RemoteError {
    RemoteError::new(
        codes::INTERNAL,
        format!("Invalid {value}; expected {expected}."),
    )
    .with_detail("kind", "tool_argument")
}
