//! Install handler tests: TypeScript parity through named fakes, cancellation barriers, and real
//! supervised processes.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use mango_protocol::error::RemoteError;
use mango_protocol::session::EventInput;
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::{InstallConsent, InstallEvents, Ports, Service};
use crate::commands::toolchain::ToolchainFs;
use crate::install::log::InstallLog;
use crate::install::runs::{InstallRuns, StopReason};
use crate::ports::audit::{Audit, AuditEntry, Outcome};
use crate::ports::authorization::consent_denial;
use crate::ports::wall_clock::FixedWallClock;
use crate::probing::detection::path_env::PathEnv;
use crate::subprocess::{
    LaunchCheck, PendingSettler, ProcessCapture, ProcessControl, ProcessExit, ProcessFuture,
    ProcessOutputChunk, ProcessOutputTap, ProcessRequest, ProcessSignal, ProcessSpawner,
    ProcessStartError, ProcessStream, ProcessTerminal, ProcessTerminalCause,
};

// ---------------------------------------------------------------------------------------------
// Named fakes
// ---------------------------------------------------------------------------------------------

/// What the next `start` call does.
enum Script {
    /// Launches, forwards `chunks`, and has already exited with `terminal`.
    Exit {
        chunks: Vec<ProcessOutputChunk>,
        terminal: ProcessTerminal,
    },
    /// Launches and stays running until the test settles it.
    Running,
    /// Launches, then runs `hook` before the owner sees the control (a racing stop).
    RunningAfter(Box<dyn FnOnce() + Send>),
    /// Waits at admission until released or cancelled, then launches and stays running.
    Admission(Arc<Notify>),
    /// Refuses the start.
    Refuse(fn() -> ProcessStartError),
}

#[derive(Default)]
struct SpawnerState {
    requests: Vec<ProcessRequest>,
    checks: usize,
    launches: usize,
    running: VecDeque<(ProcessOutputTap, PendingSettler)>,
}

/// A [`ProcessSpawner`] with the supervisor's pre-launch semantics: cancellation is observed
/// until the launch check passes, and nothing counts as launched before that.
struct ScriptedSpawner {
    scripts: Mutex<VecDeque<Script>>,
    state: Arc<Mutex<SpawnerState>>,
    launched: Arc<Notify>,
    admitted: Arc<Notify>,
}

impl ScriptedSpawner {
    fn new(scripts: Vec<Script>) -> Self {
        Self {
            scripts: Mutex::new(scripts.into()),
            state: Arc::default(),
            launched: Arc::new(Notify::new()),
            admitted: Arc::new(Notify::new()),
        }
    }

    fn launches(&self) -> usize {
        self.state.lock().unwrap().launches
    }

    fn checks(&self) -> usize {
        self.state.lock().unwrap().checks
    }

    fn starts(&self) -> usize {
        self.state.lock().unwrap().requests.len()
    }

    fn request(&self, index: usize) -> ProcessRequest {
        self.state.lock().unwrap().requests[index].clone()
    }

    /// Forwards a chunk from the oldest still-running step.
    async fn emit(&self, stream: ProcessStream, bytes: &[u8]) {
        let tap = self.state.lock().unwrap().running[0].0.clone();
        tap.into_sender()
            .send(ProcessOutputChunk {
                stream,
                bytes: bytes.to_vec(),
            })
            .await
            .expect("the owner still reads this step's output");
    }

    /// Ends the oldest still-running step with `terminal`, closing its output first.
    fn settle(&self, terminal: ProcessTerminal) {
        let (tap, settler) = self
            .state
            .lock()
            .unwrap()
            .running
            .pop_front()
            .expect("a step is running");
        drop(tap);
        settler.settle(terminal);
    }
}

impl ProcessSpawner for ScriptedSpawner {
    fn start(
        &self,
        mut request: ProcessRequest,
        check: Arc<dyn LaunchCheck>,
        cancel: CancellationToken,
    ) -> ProcessFuture<'_, Result<ProcessControl, ProcessStartError>> {
        let script = self
            .scripts
            .lock()
            .unwrap()
            .pop_front()
            .expect("a scripted start");
        let tap = request
            .output_tap
            .take()
            .expect("install always taps output");
        self.state.lock().unwrap().requests.push(request);
        let state = Arc::clone(&self.state);
        let launched = Arc::clone(&self.launched);
        let admitted = Arc::clone(&self.admitted);
        Box::pin(async move {
            if let Script::Refuse(error) = script {
                return Err(error());
            }
            if let Script::Admission(gate) = &script {
                admitted.notify_one();
                tokio::select! {
                    biased;
                    () = cancel.cancelled() => return Err(ProcessStartError::CancelledBeforeStart),
                    () = gate.notified() => {}
                }
            }
            if cancel.is_cancelled() {
                return Err(ProcessStartError::CancelledBeforeStart);
            }
            state.lock().unwrap().checks += 1;
            check.check().map_err(ProcessStartError::LaunchDenied)?;
            state.lock().unwrap().launches += 1;
            let control = match script {
                Script::Exit { chunks, terminal } => {
                    let sender = tap.into_sender();
                    for chunk in chunks {
                        sender.send(chunk).await.expect("the owner reads output");
                    }
                    ProcessControl::completed(terminal)
                }
                Script::RunningAfter(hook) => {
                    let (control, settler) = ProcessControl::pending();
                    state.lock().unwrap().running.push_back((tap, settler));
                    hook();
                    control
                }
                Script::Running | Script::Admission(_) => {
                    let (control, settler) = ProcessControl::pending();
                    state.lock().unwrap().running.push_back((tap, settler));
                    control
                }
                Script::Refuse(_) => unreachable!("handled above"),
            };
            launched.notify_one();
            Ok(control)
        })
    }
}

/// Records every frame; accepts `accept` frames, then answers as a closed session.
struct RecordingEvents {
    frames: Mutex<Vec<EventInput>>,
    accept: AtomicUsize,
}

impl RecordingEvents {
    fn open() -> Arc<Self> {
        Self::accepting(usize::MAX)
    }

    fn accepting(accept: usize) -> Arc<Self> {
        Arc::new(Self {
            frames: Mutex::new(Vec::new()),
            accept: AtomicUsize::new(accept),
        })
    }

    fn lines(&self) -> Vec<(String, String)> {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .filter(|frame| !frame.end)
            .map(|frame| {
                (
                    frame.payload["stream"].as_str().unwrap().to_owned(),
                    frame.payload["line"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    }

    fn has_line(&self, stream: &str, needle: &str) -> bool {
        self.lines()
            .iter()
            .any(|(name, line)| name == stream && line.contains(needle))
    }
}

impl InstallEvents for RecordingEvents {
    fn emit(&self, input: EventInput) -> Result<bool, String> {
        mangostudio_runtime_contract::schemas::validate_event(&input.topic, &input.payload)
            .map_err(|violation| violation.to_string())?;
        self.frames.lock().unwrap().push(input);
        let accepted = self
            .accept
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                left.checked_sub(1)
            })
            .is_ok();
        Ok(accepted)
    }
}

/// Shell consent that a test can withdraw; counts reads.
struct SwitchableConsent {
    granted: AtomicBool,
}

impl InstallConsent for SwitchableConsent {
    fn check(&self) -> Result<(), RemoteError> {
        if self.granted.load(Ordering::SeqCst) {
            return Ok(());
        }
        Err(consent_denial("install.run", &["shell".to_owned()], "host"))
    }
}

/// An in-memory log that can refuse to prepare, refuse appends, panic, or hold an append.
#[derive(Default)]
struct MemoryLog {
    prepared: Mutex<Vec<PathBuf>>,
    bytes: Mutex<Vec<u8>>,
    prepare_error: Option<&'static str>,
    append_error: Option<&'static str>,
    panic_on_prepare: bool,
    append_gate: Option<Arc<std::sync::Barrier>>,
}

impl InstallLog for MemoryLog {
    fn prepare(&self, path: &Path) -> std::io::Result<()> {
        assert!(!self.panic_on_prepare, "named log fake panicked on prepare");
        self.prepared.lock().unwrap().push(path.to_path_buf());
        match self.prepare_error {
            Some(message) => Err(std::io::Error::other(message)),
            None => Ok(()),
        }
    }

    fn append(&self, _path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        if let Some(gate) = &self.append_gate {
            gate.wait();
            gate.wait();
        }
        if let Some(message) = self.append_error {
            return Err(std::io::Error::other(message));
        }
        self.bytes.lock().unwrap().extend_from_slice(bytes);
        Ok(())
    }
}

/// A toolchain filesystem where nothing is installed.
struct EmptyToolchainFs;

impl ToolchainFs for EmptyToolchainFs {
    fn exists(&self, _path: &str) -> bool {
        false
    }

    fn read_alias(&self, _path: &str) -> Option<String> {
        None
    }

    fn entries(&self, _path: &str) -> Vec<String> {
        Vec::new()
    }
}

#[derive(Default)]
struct RecordingAudit(Mutex<Vec<AuditEntry>>);

impl Audit for RecordingAudit {
    fn record<'a>(
        &'a self,
        entry: AuditEntry,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        self.0.lock().unwrap().push(entry);
        Box::pin(async {})
    }
}

#[derive(Default)]
struct RecordingDiagnostics(Mutex<Vec<(String, Value)>>);

impl RecordingDiagnostics {
    fn events(&self) -> Vec<(String, Value)> {
        self.0.lock().unwrap().clone()
    }

    fn named(&self, event: &str) -> Option<Value> {
        self.events()
            .into_iter()
            .find(|(name, _)| name == event)
            .map(|(_, detail)| detail)
    }
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

struct Harness {
    service: Arc<Service>,
    spawner: Arc<ScriptedSpawner>,
    events: Arc<RecordingEvents>,
    consent: Arc<SwitchableConsent>,
    log: Arc<MemoryLog>,
    audit: Arc<RecordingAudit>,
    diagnostics: Arc<RecordingDiagnostics>,
    runs: Arc<InstallRuns>,
}

fn linux_host() -> PathEnv {
    PathEnv {
        platform: "linux".into(),
        home_dir: "/home/tester".into(),
        env: HashMap::from([("PATH".into(), "/usr/bin".into())]),
    }
}

fn harness(scripts: Vec<Script>) -> Harness {
    harness_with(
        scripts,
        MemoryLog::default(),
        RecordingEvents::open(),
        linux_host(),
    )
}

fn harness_with(
    scripts: Vec<Script>,
    log: MemoryLog,
    events: Arc<RecordingEvents>,
    host: PathEnv,
) -> Harness {
    let spawner = Arc::new(ScriptedSpawner::new(scripts));
    let consent = Arc::new(SwitchableConsent {
        granted: AtomicBool::new(true),
    });
    let log = Arc::new(log);
    let audit = Arc::new(RecordingAudit::default());
    let diagnostics = Arc::new(RecordingDiagnostics::default());
    let runs = Arc::new(InstallRuns::default());
    let recorded = Arc::clone(&diagnostics);
    let service = Arc::new(Service {
        ports: Ports {
            spawner: Arc::clone(&spawner) as Arc<dyn ProcessSpawner>,
            consent: Arc::clone(&consent) as Arc<dyn InstallConsent>,
            log: Arc::clone(&log) as Arc<dyn InstallLog>,
            host: Arc::new(move || host.clone()),
            toolchain_fs: Arc::new(EmptyToolchainFs),
            clock: Arc::new(FixedWallClock::new(
                UNIX_EPOCH + Duration::from_secs(1_700_000_000),
            )),
            audit: Arc::clone(&audit) as Arc<dyn Audit>,
            diagnostics: Arc::new(move |event, detail| {
                recorded.0.lock().unwrap().push((event.to_owned(), detail));
            }),
            runs: Arc::clone(&runs),
            runtime_home: PathBuf::from("/mango/runtime"),
        },
    });
    Harness {
        service,
        spawner,
        events,
        consent,
        log,
        audit,
        diagnostics,
        runs,
    }
}

fn command(run_id: &str) -> Value {
    json!({
        "runId": run_id,
        "argv": ["echo", "hello"],
        "timeoutMs": 1000,
        "logPath": "/tmp/install.log",
    })
}

impl Harness {
    async fn run(&self, params: Value) -> Result<Value, RemoteError> {
        let events = Arc::clone(&self.events) as Arc<dyn InstallEvents>;
        self.service
            .run(params, events, CancellationToken::new())
            .await
    }

    /// Starts a run on a task, with `cancel` standing in for the request's session token.
    fn spawn_run(
        &self,
        params: Value,
        cancel: CancellationToken,
    ) -> tokio::task::JoinHandle<Result<Value, RemoteError>> {
        let service = Arc::clone(&self.service);
        let events = Arc::clone(&self.events) as Arc<dyn InstallEvents>;
        tokio::spawn(async move { service.run(params, events, cancel).await })
    }

    fn cancel(&self, run_id: &str) -> Value {
        self.service
            .cancel(json!({ "runId": run_id }))
            .expect("install.cancel never fails for a well-formed id")
    }

    async fn wait_launched(&self) {
        within("the step to launch", self.spawner.launched.notified()).await;
    }

    async fn wait_admitted(&self) {
        within(
            "the step to reach admission",
            self.spawner.admitted.notified(),
        )
        .await;
    }

    async fn wait_for_line(&self, needle: &str) {
        within(&format!("a system line containing {needle:?}"), async {
            while !self.events.has_line("system", needle) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
    }
}

async fn within<T>(what: &str, future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .unwrap_or_else(|_| panic!("expected {what} | received: nothing within 5s"))
}

fn capture() -> ProcessCapture {
    ProcessCapture {
        bytes: Vec::new(),
        truncated: true,
        incomplete: false,
    }
}

fn exited(code: i32) -> ProcessTerminal {
    ProcessTerminal {
        cause: ProcessTerminalCause::Exited,
        exit: Some(ProcessExit {
            success: code == 0,
            code: Some(code),
            signal: None,
        }),
        elapsed: Duration::from_millis(5),
        stdout: capture(),
        stderr: capture(),
    }
}

fn chunk(stream: ProcessStream, bytes: &[u8]) -> ProcessOutputChunk {
    ProcessOutputChunk {
        stream,
        bytes: bytes.to_vec(),
    }
}

fn hello_world_exit() -> Script {
    Script::Exit {
        chunks: vec![
            chunk(ProcessStream::Stdout, b"hello\nworld\n"),
            chunk(ProcessStream::Stderr, b"warning\n"),
        ],
        terminal: exited(0),
    }
}

fn status(result: &Value) -> &str {
    result["status"].as_str().expect("a wire status")
}

fn pairs(lines: &[(&str, &str)]) -> Vec<(String, String)> {
    lines
        .iter()
        .map(|(stream, line)| ((*stream).to_owned(), (*line).to_owned()))
        .collect()
}

// ---------------------------------------------------------------------------------------------
// TypeScript parity (apps/runtime/tests/unit/services/install.test.ts)
// ---------------------------------------------------------------------------------------------

/// TS: "streams lines, writes a bounded raw log, and records success".
#[tokio::test]
async fn streams_lines_writes_the_raw_log_and_records_success() {
    let harness = harness(vec![hello_world_exit()]);

    let result = harness.run(command("run-1")).await.unwrap();

    assert_eq!(
        (status(&result), &result["exitCode"], &result["truncated"]),
        ("succeeded", &json!(0), &json!(false)),
        "expected a succeeded, untruncated run | received {result}"
    );
    assert_eq!(
        harness.events.lines(),
        pairs(&[
            ("stdout", "hello"),
            ("stdout", "world"),
            ("stderr", "warning")
        ])
    );
    assert_eq!(
        harness.log.bytes.lock().unwrap().as_slice(),
        b"hello\nworld\nwarning\n",
        "expected the raw captured bytes in the log"
    );
    assert_eq!(
        harness.log.prepared.lock().unwrap().as_slice(),
        [PathBuf::from("/tmp/install.log")]
    );
    assert_eq!(result["finishedAt"], json!(1_700_000_000_000_u64));
    assert_eq!(result["durationMs"], json!(0));
}

/// TS: "stops streaming once the hub session refuses a line, without abandoning the install".
#[tokio::test]
async fn stops_streaming_once_the_session_refuses_without_abandoning_the_install() {
    let harness = harness_with(
        vec![hello_world_exit()],
        MemoryLog::default(),
        RecordingEvents::accepting(0),
        linux_host(),
    );

    let result = harness.run(command("run-1")).await.unwrap();

    assert_eq!(
        harness.events.frames.lock().unwrap().len(),
        1,
        "expected one attempt, then silence"
    );
    assert_eq!(status(&result), "succeeded");
    assert_eq!(
        harness.log.bytes.lock().unwrap().as_slice(),
        b"hello\nworld\nwarning\n",
        "expected the log to keep what the dropped lines said"
    );
    assert_eq!(
        harness.diagnostics.named("install_output_unobserved"),
        Some(json!({ "runId": "run-1" }))
    );
}

/// TS: "publishes every line the hub still takes, and stops at the one it refuses".
#[tokio::test]
async fn publishes_every_line_the_hub_takes_and_stops_at_the_refused_one() {
    let harness = harness_with(
        vec![Script::Exit {
            chunks: vec![chunk(
                ProcessStream::Stdout,
                b"first\nsecond\nthird\nfourth\n",
            )],
            terminal: exited(0),
        }],
        MemoryLog::default(),
        RecordingEvents::accepting(2),
        linux_host(),
    );

    harness.run(command("run-1")).await.unwrap();

    assert_eq!(
        harness.events.lines(),
        pairs(&[
            ("stdout", "first"),
            ("stdout", "second"),
            ("stdout", "third")
        ])
    );
}

/// TS: "reports a log-file failure the silenced stream was carrying".
#[tokio::test]
async fn reports_a_log_failure_the_silenced_stream_was_carrying() {
    let harness = harness_with(
        vec![Script::Exit {
            chunks: vec![chunk(ProcessStream::Stdout, b"hello\n")],
            terminal: exited(0),
        }],
        MemoryLog {
            append_error: Some("ENOSPC: no space left on device"),
            ..MemoryLog::default()
        },
        RecordingEvents::accepting(0),
        linux_host(),
    );

    let result = harness.run(command("run-1")).await.unwrap();

    assert_eq!(status(&result), "succeeded");
    let detail = harness
        .diagnostics
        .named("install_failure_unobserved")
        .expect("expected install_failure_unobserved | received no such diagnostic");
    assert!(
        detail["detail"]
            .as_str()
            .unwrap()
            .contains("ENOSPC: no space left on device"),
        "expected the log failure in the diagnostic | received {detail}"
    );
}

/// TS: "reports an install that never started once the stream is silenced".
#[tokio::test]
async fn reports_an_install_that_never_started_once_the_stream_is_silenced() {
    let harness = harness_with(
        vec![],
        MemoryLog {
            prepare_error: Some("EACCES: permission denied"),
            ..MemoryLog::default()
        },
        RecordingEvents::accepting(0),
        linux_host(),
    );

    let result = harness.run(command("run-1")).await.unwrap();

    assert_eq!(
        (status(&result), &result["exitCode"]),
        ("spawn-failed", &Value::Null)
    );
    assert_eq!(harness.spawner.starts(), 0, "expected nothing started");
    assert_eq!(
        harness.diagnostics.named("install_failure_unobserved"),
        Some(json!({ "runId": "run-1", "detail": "EACCES: permission denied" }))
    );
}

/// TS: "treats an accepted non-zero exit code as success" and "matches an accepted exit code by
/// bit pattern, not sign", through the handler.
#[tokio::test]
async fn an_accepted_non_zero_exit_code_is_success_through_the_handler() {
    let harness = harness(vec![Script::Exit {
        chunks: vec![],
        terminal: exited(-1_978_335_189),
    }]);
    let mut params = command("run-1");
    params["acceptedExitCodes"] = json!([2_316_632_107_u64]);

    let result = harness.run(params).await.unwrap();

    assert_eq!(
        (status(&result), &result["exitCode"]),
        ("succeeded", &json!(-1_978_335_189))
    );
}

/// TS: "still fails a non-zero exit code the recipe did not accept".
#[tokio::test]
async fn an_unaccepted_non_zero_exit_code_fails_through_the_handler() {
    let harness = harness(vec![Script::Exit {
        chunks: vec![],
        terminal: exited(1),
    }]);
    let mut params = command("run-1");
    params["acceptedExitCodes"] = json!([-1_978_335_189]);

    assert_eq!(status(&harness.run(params).await.unwrap()), "failed");
}

/// TS: "caps captured output while continuing to a terminal result".
#[tokio::test]
async fn caps_captured_output_while_continuing_to_a_terminal_result() {
    let harness = harness(vec![Script::Exit {
        chunks: vec![chunk(ProcessStream::Stdout, b"0123456789")],
        terminal: exited(0),
    }]);
    let mut params = command("run-1");
    params["outputLimitBytes"] = json!(4);

    let result = harness.run(params).await.unwrap();

    assert_eq!(
        (status(&result), &result["truncated"]),
        ("succeeded", &json!(true))
    );
    assert_eq!(harness.log.bytes.lock().unwrap().len(), 4);
    assert_eq!(
        harness.events.lines(),
        pairs(&[
            ("system", "Output truncated after 4 bytes."),
            ("stdout", "0123"),
        ]),
        "expected the notice before the accepted chunk's lines, and the tail flushed"
    );
}

/// A run without `outputLimitBytes` gets `INSTALL_OUTPUT_LIMIT_BYTES` (1 MiB), shared by both pipes.
#[tokio::test]
async fn the_default_output_limit_is_one_mebibyte() {
    let harness = harness(vec![Script::Exit {
        chunks: vec![
            chunk(ProcessStream::Stdout, &vec![b'a'; 1024 * 1024 - 1]),
            chunk(ProcessStream::Stderr, b"bc"),
        ],
        terminal: exited(0),
    }]);

    let result = harness.run(command("run-1")).await.unwrap();

    assert_eq!(result["truncated"], json!(true));
    assert_eq!(
        harness.log.bytes.lock().unwrap().len(),
        1024 * 1024,
        "expected exactly 1 MiB kept across both pipes"
    );
    assert!(
        harness
            .events
            .has_line("system", "Output truncated after 1048576 bytes.")
    );
}

/// Consent that stays granted must never be read as a withdrawal while a step runs.
#[tokio::test]
async fn granted_consent_never_marks_a_running_step_stopping() {
    let harness = harness(vec![Script::Running]);
    let run = harness.spawn_run(command("run-1"), CancellationToken::new());
    harness.wait_launched().await;

    // Several consent polls (every 100 ms) run while the step is held.
    tokio::time::sleep(Duration::from_millis(350)).await;
    harness.spawner.settle(exited(0));
    let result = within("the step to settle", run).await.unwrap().unwrap();

    assert_eq!(status(&result), "succeeded");
    assert!(
        !harness
            .events
            .has_line("system", "no further step will start"),
        "expected no stopping notice while consent stayed granted | received {:?}",
        harness.events.lines()
    );
}

/// TS: "kills a timed-out child with SIGKILL" — the supervisor forces the tree at the deadline
/// (proved against a real process below); the handler reports it as Bun did.
#[tokio::test]
async fn a_timed_out_step_reports_timed_out_with_partial_effects() {
    let harness = harness(vec![Script::Exit {
        chunks: vec![],
        terminal: ProcessTerminal {
            cause: ProcessTerminalCause::TimedOut,
            exit: Some(ProcessExit {
                success: false,
                code: None,
                signal: Some(ProcessSignal {
                    number: 9,
                    name: "SIGKILL",
                }),
            }),
            elapsed: Duration::from_millis(1000),
            stdout: capture(),
            stderr: capture(),
        },
    }]);

    let result = harness.run(command("run-1")).await.unwrap();

    let expected_exit = if cfg!(windows) { 1 } else { 137 };
    assert_eq!(
        (status(&result), &result["exitCode"]),
        ("timed-out", &json!(expected_exit))
    );
    assert!(
        harness
            .events
            .has_line("system", "the machine may be partially changed"),
        "expected a partial-effects notice | received {:?}",
        harness.events.lines()
    );
}

/// TS: "accepts a cancel for a run it no longer holds rather than failing".
#[tokio::test]
async fn accepts_a_cancel_for_a_run_it_no_longer_holds() {
    let harness = harness(vec![]);

    assert_eq!(harness.cancel("never-started"), json!({ "ok": true }));
}

/// TS: "ends the output stream so the hub stops waiting for frames".
#[tokio::test]
async fn ends_the_output_stream_exactly_once_and_last() {
    let harness = harness(vec![Script::Exit {
        chunks: vec![chunk(ProcessStream::Stdout, b"done\n")],
        terminal: exited(0),
    }]);

    harness.run(command("run-1")).await.unwrap();

    let frames = harness.events.frames.lock().unwrap();
    let ends: Vec<_> = frames.iter().filter(|frame| frame.end).collect();
    assert_eq!(ends.len(), 1, "expected exactly one end frame");
    let last = frames.last().unwrap();
    assert!(last.end, "expected the end frame last");
    assert_eq!(last.stream_id.as_deref(), Some("run-1"));
    assert_eq!(last.topic, "install.output");
    assert_eq!(
        last.payload,
        json!({ "stream": "system", "line": "", "end": true })
    );
}

/// TS: "reports a synchronous spawn failure without throwing".
#[tokio::test]
async fn reports_a_spawn_failure_without_throwing() {
    let harness = harness(vec![Script::Refuse(|| {
        ProcessStartError::SpawnFailed(std::io::Error::other("binary missing"))
    })]);

    let result = harness.run(command("run-1")).await.unwrap();

    assert_eq!(
        (status(&result), &result["exitCode"]),
        ("spawn-failed", &Value::Null)
    );
    assert_eq!(
        harness.events.lines(),
        pairs(&[("system", "binary missing")])
    );
}

/// TS: "prepends the resolved toolchain node dir to the spawned PATH".
#[tokio::test]
async fn prepends_the_resolved_toolchain_node_dir_to_the_spawned_path() {
    let harness = harness(vec![Script::Exit {
        chunks: vec![],
        terminal: exited(0),
    }]);
    let mut params = command("run-1");
    params["toolchain"] = json!({ "node": "/opt/custom/node/bin/node", "bun": "auto" });

    harness.run(params).await.unwrap();

    let env = harness
        .spawner
        .request(0)
        .env
        .expect("an exact environment");
    assert_eq!(
        env.get(std::ffi::OsStr::new("PATH")),
        Some(&"/opt/custom/node/bin:/usr/bin".into())
    );
}

/// TS: "leaves PATH untouched when the run carries no toolchain".
#[tokio::test]
async fn leaves_path_untouched_without_a_toolchain() {
    let harness = harness(vec![Script::Exit {
        chunks: vec![],
        terminal: exited(0),
    }]);

    harness.run(command("run-1")).await.unwrap();

    let env = harness
        .spawner
        .request(0)
        .env
        .expect("an exact environment");
    assert_eq!(
        env.get(std::ffi::OsStr::new("PATH")),
        Some(&"/usr/bin".into())
    );
}

/// TS: "selects the win32 environment allowlist from the injected platform".
#[tokio::test]
async fn selects_the_win32_allowlist_from_the_injected_platform() {
    let host = PathEnv {
        platform: "win32".into(),
        home_dir: "C:\\Users\\tester".into(),
        env: HashMap::from([
            ("Path".into(), "C:\\Windows".into()),
            ("SystemRoot".into(), "C:\\Windows".into()),
            ("ComSpec".into(), "C:\\Windows\\system32\\cmd.exe".into()),
            ("GITHUB_TOKEN".into(), "secret".into()),
        ]),
    };
    let harness = harness_with(
        vec![Script::Exit {
            chunks: vec![],
            terminal: exited(0),
        }],
        MemoryLog::default(),
        RecordingEvents::open(),
        host,
    );

    harness.run(command("run-1")).await.unwrap();

    let env = harness
        .spawner
        .request(0)
        .env
        .expect("an exact environment");
    let get = |key: &str| env.get(std::ffi::OsStr::new(key)).cloned();
    assert_eq!(get("SystemRoot"), Some("C:\\Windows".into()));
    assert_eq!(
        get("ComSpec"),
        Some("C:\\Windows\\system32\\cmd.exe".into())
    );
    assert_eq!(get("PATH"), Some("C:\\Windows".into()));
    assert_eq!(get("GITHUB_TOKEN"), None, "expected credentials withheld");
}

// ---------------------------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_hub_built_argv_reaches_the_supervisor_exactly() {
    let harness = harness(vec![Script::Exit {
        chunks: vec![],
        terminal: exited(0),
    }]);
    let mut params = command("run-1");
    params["argv"] = json!(["bash", "-c", "echo $1", "mangostudio-install", "a b"]);
    params["timeoutMs"] = json!(2500);

    harness.run(params).await.unwrap();

    let request = harness.spawner.request(0);
    assert_eq!(request.program, PathBuf::from("bash"));
    assert_eq!(
        request.args,
        ["-c", "echo $1", "mangostudio-install", "a b"].map(std::ffi::OsString::from)
    );
    assert_eq!(
        request.cwd, None,
        "expected the runtime's own cwd, as Bun.spawn used"
    );
    assert_eq!(request.budget.deadline, Duration::from_millis(2500));
    assert_eq!(
        (
            request.budget.max_stdout_bytes,
            request.budget.max_stderr_bytes
        ),
        (0, 0),
        "expected the supervisor to retain nothing; the run's own limit applies"
    );
}

#[tokio::test]
async fn a_relative_log_path_lands_under_the_runtime_or_home_directory() {
    let harness = harness(vec![
        Script::Exit {
            chunks: vec![],
            terminal: exited(0),
        },
        Script::Exit {
            chunks: vec![],
            terminal: exited(0),
        },
    ]);
    let mut remote = command("run-1");
    remote["logPath"] = json!(".mango/runtime/logs/install-run-1.log");
    let mut relative = command("run-2");
    relative["logPath"] = json!("logs/install-run-2.log");

    harness.run(remote).await.unwrap();
    harness.run(relative).await.unwrap();

    assert_eq!(
        harness.log.prepared.lock().unwrap().as_slice(),
        [
            Path::new("/home/tester").join(".mango/runtime/logs/install-run-1.log"),
            Path::new("/mango/runtime").join("logs/install-run-2.log"),
        ]
    );
}

#[tokio::test]
async fn malformed_requests_are_refused_before_any_effect() {
    let harness = harness(vec![]);
    let cases = [
        ("argv", json!([]), "argv=[]"),
        ("timeoutMs", json!(0), "timeoutMs=0"),
        ("timeoutMs", json!(-5), "timeoutMs=-5"),
        ("outputLimitBytes", json!(-1), "outputLimitBytes=-1"),
    ];
    for (field, value, echoed) in cases {
        let mut params = command("run-1");
        params[field] = value;
        let error = harness.run(params).await.unwrap_err();
        assert!(
            error.message.contains(echoed) && error.message.contains("expected"),
            "expected a refusal naming {echoed:?} and the expected shape | received {:?}",
            error.message
        );
        assert_eq!(error.details.as_ref().unwrap()["kind"], "tool_argument");
    }
    assert!(
        harness.log.prepared.lock().unwrap().is_empty() && harness.spawner.starts() == 0,
        "expected no log and no start for refused requests"
    );
}

#[tokio::test]
async fn a_second_run_with_an_active_id_is_refused_and_the_first_is_untouched() {
    let harness = harness(vec![Script::Running]);
    let first = harness.spawn_run(command("run-1"), CancellationToken::new());
    harness.wait_launched().await;

    let error = harness.run(command("run-1")).await.unwrap_err();

    assert!(
        error.message.contains("runId=\"run-1\"") && error.message.contains("not already active"),
        "expected an already-active refusal | received {:?}",
        error.message
    );
    harness.spawner.settle(exited(0));
    assert_eq!(status(&first.await.unwrap().unwrap()), "succeeded");
    assert_eq!(harness.spawner.starts(), 1);
}

// ---------------------------------------------------------------------------------------------
// Cancellation barriers
// ---------------------------------------------------------------------------------------------

/// Before a step starts, cancellation prevents launch.
#[tokio::test]
async fn cancel_before_launch_prevents_the_launch() {
    let gate = Arc::new(Notify::new());
    let harness = harness(vec![Script::Admission(Arc::clone(&gate))]);
    let run = harness.spawn_run(command("run-1"), CancellationToken::new());
    harness.wait_admitted().await;

    harness.cancel("run-1");
    let result = within("the cancelled run to settle", run)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(
        (status(&result), &result["exitCode"]),
        ("cancelled", &Value::Null),
        "expected a cancelled, never-launched run | received {result}"
    );
    assert_eq!(
        (harness.spawner.checks(), harness.spawner.launches()),
        (0, 0),
        "expected no launch check and no launch"
    );
    assert!(harness.events.has_line("system", "nothing was launched"));
}

/// The hub may cancel before its `install.run` is dispatched; the run then never launches.
#[tokio::test]
async fn a_cancel_that_arrives_before_the_run_prevents_its_launch() {
    let harness = harness(vec![]);
    harness.cancel("run-early");

    let result = harness.run(command("run-early")).await.unwrap();

    assert_eq!(status(&result), "cancelled");
    assert_eq!(harness.spawner.starts(), 0, "expected no start call at all");
}

/// A cancel landing after the launch check but before the owner holds the control finds the step
/// running: it stops the chain, and the step still finishes with its real result.
#[tokio::test]
async fn a_cancel_racing_the_launch_lets_the_launched_step_finish() {
    let runs_slot: Arc<Mutex<Option<Arc<InstallRuns>>>> = Arc::default();
    let hook_runs = Arc::clone(&runs_slot);
    let harness = harness(vec![Script::RunningAfter(Box::new(move || {
        hook_runs
            .lock()
            .unwrap()
            .as_ref()
            .expect("runs installed")
            .stop("run-1", StopReason::Cancelled);
    }))]);
    *runs_slot.lock().unwrap() = Some(Arc::clone(&harness.runs));
    let run = harness.spawn_run(command("run-1"), CancellationToken::new());
    harness.wait_launched().await;
    harness.wait_for_line("Cancellation requested").await;

    harness.spawner.settle(exited(0));
    let result = within("the raced run to settle", run)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(
        status(&result),
        "succeeded",
        "expected the launched step's real result, not a fabricated cancel"
    );
    assert_eq!(harness.spawner.launches(), 1);
}

/// During a step, explicit cancel stops the chain but never kills the step (TS killed it with
/// SIGKILL; this is the issue's documented correction).
#[tokio::test]
async fn cancel_during_a_step_lets_it_finish_and_records_its_real_result() {
    let harness = harness(vec![Script::Running]);
    let run = harness.spawn_run(command("run-1"), CancellationToken::new());
    harness.wait_launched().await;
    harness
        .spawner
        .emit(ProcessStream::Stdout, b"before\n")
        .await;

    assert_eq!(harness.cancel("run-1"), json!({ "ok": true }));
    harness.wait_for_line("Cancellation requested").await;
    assert!(
        !run.is_finished(),
        "expected the step still running after cancel"
    );
    harness
        .spawner
        .emit(ProcessStream::Stdout, b"after\n")
        .await;
    harness.spawner.settle(exited(0));
    let result = within("the cancelled step to settle", run)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(status(&result), "succeeded");
    assert_eq!(
        harness
            .events
            .lines()
            .into_iter()
            .filter(|(stream, _)| stream == "stdout")
            .collect::<Vec<_>>(),
        pairs(&[("stdout", "before"), ("stdout", "after")]),
        "expected output after the cancel to keep streaming"
    );
    assert_eq!(harness.spawner.launches(), 1);
}

/// Between steps: a cancel after the step's process exited cannot alter the recorded result.
#[tokio::test]
async fn a_cancel_after_the_step_exited_does_not_change_its_result() {
    let gate = Arc::new(std::sync::Barrier::new(2));
    let harness = harness_with(
        vec![Script::Exit {
            chunks: vec![chunk(ProcessStream::Stdout, b"done\n")],
            terminal: exited(3),
        }],
        MemoryLog {
            append_gate: Some(Arc::clone(&gate)),
            ..MemoryLog::default()
        },
        RecordingEvents::open(),
        linux_host(),
    );
    let run = harness.spawn_run(command("run-1"), CancellationToken::new());
    let arrived = Arc::clone(&gate);
    tokio::task::spawn_blocking(move || arrived.wait())
        .await
        .unwrap();

    harness.cancel("run-1");
    let released = Arc::clone(&gate);
    tokio::task::spawn_blocking(move || released.wait())
        .await
        .unwrap();
    let result = within("the exited step to settle", run)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(
        (status(&result), &result["exitCode"]),
        ("failed", &json!(3)),
        "expected the exited step's own result | received {result}"
    );
}

/// Hub loss while step A runs and step B waits at admission: A finishes, B never launches.
#[tokio::test]
async fn hub_loss_finishes_the_running_step_and_starts_no_later_step() {
    let gate = Arc::new(Notify::new());
    let harness = harness(vec![Script::Running, Script::Admission(Arc::clone(&gate))]);
    let session = CancellationToken::new();
    let first = harness.spawn_run(command("run-a"), session.child_token());
    harness.wait_launched().await;
    let second = harness.spawn_run(command("run-b"), session.child_token());
    harness.wait_admitted().await;

    session.cancel();
    let second = within("the queued step to settle", second)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        status(&second),
        "cancelled",
        "expected the queued step stopped before launch | received {second}"
    );
    assert!(!first.is_finished(), "expected the running step kept alive");
    harness.spawner.settle(exited(0));
    let first = within("the running step to settle", first)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(status(&first), "succeeded");
    assert_eq!(
        harness.spawner.launches(),
        1,
        "expected exactly one launch across the chain"
    );
}

/// Consent withdrawn mid-step: noticed locally, the step finishes, and no later step starts
/// (#1051's "no later step").
#[tokio::test]
async fn revocation_during_a_step_is_handled_locally_and_blocks_the_next_launch() {
    let harness = harness(vec![Script::Running, Script::Running]);
    let run = harness.spawn_run(command("run-a"), CancellationToken::new());
    harness.wait_launched().await;

    harness.consent.granted.store(false, Ordering::SeqCst);
    harness.wait_for_line("Shell consent was withdrawn").await;
    assert!(
        !run.is_finished(),
        "expected the step still running after revocation"
    );
    harness.spawner.settle(exited(0));
    let first = within("the step to settle", run).await.unwrap().unwrap();
    let second = harness.run(command("run-b")).await.unwrap();

    assert_eq!(status(&first), "succeeded");
    assert_eq!(
        status(&second),
        "cancelled",
        "expected the later step refused at its launch check | received {second}"
    );
    assert_eq!(harness.spawner.launches(), 1, "expected no later launch");
    assert!(harness.events.has_line("system", "nothing was launched"));
}

/// Consent is rechecked immediately before launch, not only at the guard.
#[tokio::test]
async fn consent_withdrawn_before_launch_prevents_the_launch() {
    let harness = harness(vec![Script::Running]);
    harness.consent.granted.store(false, Ordering::SeqCst);

    let result = harness.run(command("run-1")).await.unwrap();

    assert_eq!(status(&result), "cancelled");
    assert_eq!(
        (harness.spawner.checks(), harness.spawner.launches()),
        (1, 0)
    );
}

/// The running step's owner outlives the request that started it (session teardown drops the
/// handler task) and records the outcome itself.
#[tokio::test]
async fn a_running_step_survives_its_request_and_records_its_own_outcome() {
    let harness = harness(vec![Script::Running]);
    let run = harness.spawn_run(command("run-1"), CancellationToken::new());
    harness.wait_launched().await;

    run.abort();
    let _ = run.await;
    let reconnect = harness.run(command("run-1")).await.unwrap_err();
    assert!(
        reconnect.message.contains("not already active"),
        "expected a reconnecting hub to see the surviving step | received {:?}",
        reconnect.message
    );
    harness.spawner.settle(exited(0));
    within("every run to settle", harness.runs.settled()).await;

    assert_eq!(
        harness.diagnostics.named("install_run_settled_unobserved"),
        Some(json!({
            "runId": "run-1", "status": "succeeded", "exitCode": 0, "truncated": false,
            "durationMs": 0, "partialEffectsPossible": false,
        }))
    );
    let audit = harness.audit.0.lock().unwrap();
    assert_eq!(audit.len(), 1, "expected one audit line from the owner");
    assert_eq!(
        (audit[0].method.as_str(), audit[0].outcome),
        ("install.run", Outcome::Ok)
    );
}

/// A delivered result is audited by the registry wrapper, never twice by the owner.
#[tokio::test]
async fn a_delivered_result_is_not_audited_by_the_owner() {
    let harness = harness(vec![hello_world_exit()]);

    harness.run(command("run-1")).await.unwrap();

    assert!(harness.audit.0.lock().unwrap().is_empty());
    assert_eq!(
        harness.diagnostics.named("install_run_settled_unobserved"),
        None
    );
}

/// A panicking owner still settles its request and frees the run id.
#[tokio::test]
async fn a_panicking_owner_settles_as_failed_and_frees_the_run_id() {
    let harness = harness_with(
        vec![],
        MemoryLog {
            panic_on_prepare: true,
            ..MemoryLog::default()
        },
        RecordingEvents::open(),
        linux_host(),
    );

    let result = within("the request to settle", harness.run(command("run-1")))
        .await
        .unwrap();

    assert_eq!(
        (status(&result), &result["exitCode"]),
        ("failed", &Value::Null)
    );
    assert!(
        harness
            .events
            .frames
            .lock()
            .unwrap()
            .last()
            .is_some_and(|frame| frame.end),
        "expected the stream ended"
    );
    within("the run id to be freed", harness.runs.settled()).await;
}

#[tokio::test]
async fn a_start_that_never_launched_reports_why() {
    let harness = harness(vec![
        Script::Refuse(|| ProcessStartError::TimedOutBeforeStart),
        Script::Refuse(|| ProcessStartError::LimitExceeded),
        Script::Refuse(|| ProcessStartError::SupervisorUnavailable),
    ]);

    let timed_out = harness.run(command("a")).await.unwrap();
    let limited = harness.run(command("b")).await.unwrap();
    let unavailable = harness.run(command("c")).await.unwrap();

    assert_eq!(
        (status(&timed_out), status(&limited), status(&unavailable)),
        ("timed-out", "spawn-failed", "failed")
    );
    assert!(
        harness
            .events
            .has_line("system", "before it started; nothing was launched")
    );
    assert!(
        harness
            .events
            .has_line("system", "admission limit exceeded")
    );
    assert!(
        harness
            .events
            .has_line("system", "stopped before reporting")
    );
}

/// The production consent port reads `runtime.json` fresh and names `install.run` in its denial.
#[test]
fn the_source_consent_adapter_follows_the_stored_shell_grant() {
    use crate::consent::source::ConsentSource;
    use crate::ports::wall_clock::SystemWallClock;
    use crate::runtime_home::RuntimeSlot;
    use crate::setup::{NonInteractiveSetupRequest, SetupAuthority, run_non_interactive_setup};
    use mangostudio_runtime_contract::manifest::ManifestProfile;

    let home = crate::test_support::ScratchDir::created("install-source-consent");
    let consent = super::SourceConsent(ConsentSource::new(RuntimeSlot::Host, home.to_path_buf()));
    let set = |profile| {
        run_non_interactive_setup(
            &NonInteractiveSetupRequest {
                slot: RuntimeSlot::Host,
                profile: (profile, SetupAuthority::Cli),
                allow_overrides: &[],
            },
            &home,
            &SystemWallClock,
        )
        .unwrap();
    };

    set(ManifestProfile::Full);
    assert!(
        consent.check().is_ok(),
        "expected the full profile to grant shell"
    );
    set(ManifestProfile::None);
    let denial = consent
        .check()
        .expect_err("expected the none profile to deny shell");
    assert!(
        denial.message.contains("install.run") && denial.message.contains("shell"),
        "expected a denial naming install.run and shell | received {:?}",
        denial.message
    );
}

// ---------------------------------------------------------------------------------------------
// Real supervised processes
// ---------------------------------------------------------------------------------------------

#[cfg(unix)]
mod real {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use std::time::{Duration, UNIX_EPOCH};

    use serde_json::{Value, json};
    use tokio_util::sync::CancellationToken;

    use super::{
        EmptyToolchainFs, RecordingAudit, RecordingDiagnostics, RecordingEvents, SwitchableConsent,
        status, within,
    };
    use crate::install::log::FileInstallLog;
    use crate::install::runs::InstallRuns;
    use crate::install::service::{InstallEvents, Ports, Service};
    use crate::ports::wall_clock::FixedWallClock;
    use crate::probing::detection::path_env::PathEnv;
    use crate::subprocess::DefaultProcessSpawner;
    use crate::test_support::ScratchDir;

    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    fn service(runs: &Arc<InstallRuns>) -> Arc<Service> {
        Arc::new(Service {
            ports: Ports {
                spawner: Arc::new(DefaultProcessSpawner),
                consent: Arc::new(SwitchableConsent {
                    granted: AtomicBool::new(true),
                }),
                log: Arc::new(FileInstallLog),
                host: Arc::new(|| PathEnv {
                    platform: "linux".into(),
                    home_dir: "/nonexistent-home".into(),
                    env: [("PATH".to_owned(), "/usr/bin:/bin".to_owned())].into(),
                }),
                toolchain_fs: Arc::new(EmptyToolchainFs),
                clock: Arc::new(FixedWallClock::new(UNIX_EPOCH)),
                audit: Arc::new(RecordingAudit::default()),
                diagnostics: {
                    let diagnostics = Arc::new(RecordingDiagnostics::default());
                    Arc::new(move |event, detail| {
                        diagnostics
                            .0
                            .lock()
                            .unwrap()
                            .push((event.to_owned(), detail));
                    })
                },
                runs: Arc::clone(runs),
                runtime_home: PathBuf::from("/nonexistent-runtime-home"),
            },
        })
    }

    fn params(run_id: &str, program: &Path, log: &Path, timeout_ms: u64) -> Value {
        json!({
            "runId": run_id,
            "argv": [program],
            "timeoutMs": timeout_ms,
            "logPath": log,
        })
    }

    async fn pid_is_gone(pid_file: &Path) -> bool {
        let pid: i32 = std::fs::read_to_string(pid_file)
            .expect("the grandchild pid was recorded")
            .trim()
            .parse()
            .expect("an integer pid");
        for _ in 0..300 {
            if matches!(
                nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
                Err(nix::errno::Errno::ESRCH)
            ) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        false
    }

    #[tokio::test]
    async fn a_real_step_streams_both_pipes_into_events_and_the_log() {
        let dir = ScratchDir::created("install-real-stream");
        let program = script(
            &dir,
            "installer.sh",
            "printf 'one\\ntwo\\n'; printf 'warn\\n' >&2",
        );
        let log = dir.join("logs").join("install.log");
        let events = RecordingEvents::open();
        let runs = Arc::new(InstallRuns::default());

        let result = service(&runs)
            .run(
                params("real-1", &program, &log, 10_000),
                Arc::clone(&events) as Arc<dyn InstallEvents>,
                CancellationToken::new(),
            )
            .await
            .unwrap();

        assert_eq!(
            status(&result),
            "succeeded",
            "received {result} with lines {:?}",
            events.lines()
        );
        let mut stdout: Vec<_> = events
            .lines()
            .into_iter()
            .filter(|(stream, _)| stream != "system")
            .collect();
        stdout.sort();
        assert_eq!(
            stdout,
            super::pairs(&[("stderr", "warn"), ("stdout", "one"), ("stdout", "two")])
        );
        let mut logged = std::fs::read(&log).unwrap();
        logged.sort_unstable();
        let mut expected = b"one\ntwo\nwarn\n".to_vec();
        expected.sort_unstable();
        assert_eq!(logged, expected, "expected every captured byte in the log");
    }

    /// The step's timeout forces the whole tree: a backgrounded grandchild is gone afterwards.
    #[tokio::test]
    async fn a_timed_out_real_step_is_reported_and_its_grandchild_is_gone() {
        let dir = ScratchDir::created("install-real-timeout");
        let pid_file = dir.join("grandchild.pid");
        let program = script(
            &dir,
            "hang.sh",
            &format!(
                "sleep 30 & echo $! > {}; echo started; wait",
                pid_file.display()
            ),
        );
        let events = RecordingEvents::open();
        let runs = Arc::new(InstallRuns::default());

        let result = service(&runs)
            .run(
                params("real-timeout", &program, &dir.join("install.log"), 700),
                Arc::clone(&events) as Arc<dyn InstallEvents>,
                CancellationToken::new(),
            )
            .await
            .unwrap();

        assert_eq!(
            (status(&result), &result["exitCode"]),
            ("timed-out", &json!(137)),
            "expected Bun's SIGKILL reading of a timed-out step | received {result}"
        );
        assert!(
            pid_is_gone(&pid_file).await,
            "expected the backgrounded grandchild killed with the step's tree"
        );
        assert!(events.has_line("stdout", "started"));
    }

    /// Cancel during a real step: the installer is not killed and completes its effect once.
    #[tokio::test]
    async fn cancel_during_a_real_step_lets_the_installer_complete_its_effect() {
        let dir = ScratchDir::created("install-real-cancel");
        let release = dir.join("release");
        let marker = dir.join("installed");
        let program = script(
            &dir,
            "installer.sh",
            &format!(
                "echo waiting; while [ ! -e {release} ]; do sleep 0.02; done; echo x >> {marker}; echo done",
                release = release.display(),
                marker = marker.display()
            ),
        );
        let events = RecordingEvents::open();
        let runs = Arc::new(InstallRuns::default());
        let service = service(&runs);
        let run = tokio::spawn({
            let service = Arc::clone(&service);
            let params = params("real-cancel", &program, &dir.join("install.log"), 10_000);
            let events = Arc::clone(&events) as Arc<dyn InstallEvents>;
            async move { service.run(params, events, CancellationToken::new()).await }
        });
        within("the installer to start", async {
            while !events.has_line("stdout", "waiting") {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;

        service.cancel(json!({ "runId": "real-cancel" })).unwrap();
        std::fs::write(&release, b"").unwrap();
        let result = within("the step to finish", run).await.unwrap().unwrap();

        assert_eq!(status(&result), "succeeded", "received {result}");
        assert_eq!(
            std::fs::read_to_string(&marker).unwrap(),
            "x\n",
            "expected the installer's effect applied exactly once"
        );
        assert!(events.has_line("stdout", "done"));
    }
}

/// Every Windows recipe runs `powershell`; its pipeline output must stream through the real
/// `install.run` path: host environment snapshot, install allowlist, supervisor and tap.
#[cfg(windows)]
mod windows_powershell {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use std::time::UNIX_EPOCH;

    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    use super::{RecordingAudit, RecordingEvents, SwitchableConsent, status};
    use crate::commands::toolchain::NativeToolchainFs;
    use crate::install::log::FileInstallLog;
    use crate::install::runs::InstallRuns;
    use crate::install::service::{InstallEvents, Ports, Service};
    use crate::ports::wall_clock::FixedWallClock;
    use crate::subprocess::DefaultProcessSpawner;
    use crate::test_support::ScratchDir;

    #[tokio::test]
    async fn a_powershell_recipe_streams_write_output_through_install_run() {
        let dir = ScratchDir::created("install-windows-powershell");
        let service = Arc::new(Service {
            ports: Ports {
                spawner: Arc::new(DefaultProcessSpawner),
                consent: Arc::new(SwitchableConsent {
                    granted: AtomicBool::new(true),
                }),
                log: Arc::new(FileInstallLog),
                host: Arc::new(|| crate::probing::host::build_runtime_path_env(None)),
                toolchain_fs: Arc::new(NativeToolchainFs),
                clock: Arc::new(FixedWallClock::new(UNIX_EPOCH)),
                audit: Arc::new(RecordingAudit::default()),
                diagnostics: Arc::new(|_, _| {}),
                runs: Arc::new(InstallRuns::default()),
                runtime_home: PathBuf::from(&*dir),
            },
        });
        let events = RecordingEvents::open();

        let result = service
            .run(
                json!({
                    "runId": "windows-powershell",
                    "argv": [
                        "powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy",
                        "Bypass", "-Command", "Write-Output x",
                    ],
                    "timeoutMs": 60_000,
                    "logPath": dir.join("install.log"),
                }),
                Arc::clone(&events) as Arc<dyn InstallEvents>,
                CancellationToken::new(),
            )
            .await
            .unwrap();

        let mut host_only: Vec<String> = crate::probing::host::build_runtime_path_env(None)
            .env
            .into_keys()
            .collect();
        host_only.sort();
        assert!(
            status(&result) == "succeeded" && events.has_line("stdout", "x"),
            "expected a PowerShell recipe to stream stdout \"x\" and succeed | received {result} \
             with lines {:?}; host variable names (the allowlist forwards a subset): {host_only:?}",
            events.lines()
        );
    }
}
