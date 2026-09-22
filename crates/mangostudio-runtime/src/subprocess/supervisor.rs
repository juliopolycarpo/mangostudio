//! Shared, cancellation-safe ownership of bounded child processes.
//!
//! A caller starts a process with exact argv, cwd, environment, input, and
//! capture bounds. The supervisor keeps the permit and child in one worker
//! until it publishes a terminal record, so dropping a request future cannot
//! release admission or orphan a child.
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::ExitStatus;
#[cfg(all(not(unix), not(windows)))]
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use mango_protocol::RemoteError;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
#[cfg(all(not(unix), not(windows)))]
use tokio::process::{Child, Command};
use tokio::sync::{Semaphore, mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use super::MAX_CONCURRENT_CHILD_PROCESSES;
use crate::blocking::run_blocking;

#[cfg(unix)]
use super::unix_guardian;
#[cfg(windows)]
use super::windows_job;

/// The object-safe future returned by process ports.
pub type ProcessFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The largest number of requests that may own supervisor admission state at once.
///
/// Four of these can own a child (see [`MAX_CONCURRENT_CHILD_PROCESSES`]); the
/// remaining slots are bounded queueing. Refusing a larger burst keeps a caller
/// from creating unbounded tasks that each retain request input and consent state.
pub const MAX_SUPERVISED_PROCESS_REQUESTS: usize = 16;

/// The maximum outstanding stop requests for one owned process.
///
/// Calls beyond this bound wait for the worker to receive a request or publish its terminal
/// record. This prevents cloned controls from retaining an unbounded queue of reply channels.
const MAX_PROCESS_CONTROL_COMMANDS: usize = 16;

/// Exact launch configuration for one process.
#[derive(Clone, Debug)]
pub struct ProcessRequest {
    /// Executable path or platform command name.
    pub program: PathBuf,
    /// Exact argv entries after the executable, never reparsed as a shell command.
    pub args: Vec<OsString>,
    /// `None` inherits the runtime environment; `Some` clears it and supplies exactly these pairs.
    pub env: Option<BTreeMap<OsString, OsString>>,
    /// Working directory when the handler contract requires one.
    pub cwd: Option<PathBuf>,
    /// Data connected to standard input.
    pub stdin: ProcessStdin,
    /// Deadline and capture limits applied to this owned process.
    pub budget: ProcessBudget,
}

impl ProcessRequest {
    /// Builds a request with inherited environment, null stdin, and a five-second 64-KiB budget.
    ///
    /// # Example
    ///
    /// ```
    /// use mangostudio_runtime::subprocess::ProcessRequest;
    ///
    /// let request = ProcessRequest::new("git", ["--version"]);
    /// assert_eq!(request.args.len(), 1);
    /// ```
    #[must_use]
    pub fn new(
        program: impl Into<PathBuf>,
        args: impl IntoIterator<Item = impl Into<OsString>>,
    ) -> Self {
        Self {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
            env: None,
            cwd: None,
            stdin: ProcessStdin::Null,
            budget: ProcessBudget::new(Duration::from_secs(5), 64 * 1024, 64 * 1024),
        }
    }

    /// Replaces the stdin policy.
    #[must_use]
    pub fn with_stdin(mut self, stdin: ProcessStdin) -> Self {
        self.stdin = stdin;
        self
    }

    /// Replaces the deadline and capture limits.
    #[must_use]
    pub fn with_budget(mut self, budget: ProcessBudget) -> Self {
        self.budget = budget;
        self
    }
}

/// Standard-input policy for a child process.
#[derive(Clone, Debug)]
pub enum ProcessStdin {
    /// Connects stdin to the platform null device.
    Null,
    /// Writes these bytes then closes stdin.
    Bytes(Vec<u8>),
}

/// Deadline and per-stream capture limits for one process.
#[derive(Clone, Copy, Debug)]
pub struct ProcessBudget {
    /// Total time from admission queueing through terminal cleanup.
    pub deadline: Duration,
    /// Retained stdout bytes; excess is drained and marked truncated.
    pub max_stdout_bytes: usize,
    /// Retained stderr bytes; excess is drained and marked truncated.
    pub max_stderr_bytes: usize,
    /// Maximum post-exit wait for inherited stdout/stderr writers.
    pub post_exit_drain: Duration,
}

impl ProcessBudget {
    /// Creates a budget whose pipe-drain grace is bounded by the remaining deadline.
    #[must_use]
    pub const fn new(deadline: Duration, max_stdout_bytes: usize, max_stderr_bytes: usize) -> Self {
        Self {
            deadline,
            max_stdout_bytes,
            max_stderr_bytes,
            post_exit_drain: deadline,
        }
    }

    /// Narrows the post-exit pipe-drain grace for callers such as Git and GitHub.
    #[must_use]
    pub const fn with_post_exit_drain(mut self, grace: Duration) -> Self {
        self.post_exit_drain = grace;
        self
    }
}

/// Preserved wire error returned by the final consent and cwd check.
pub type LaunchCheckError = RemoteError;

/// A synchronous freshness check run inside the spawn closure immediately before the OS effect.
pub trait LaunchCheck: Send + Sync {
    /// Refuses a process that has definitely not started, preserving its wire error unchanged.
    fn check(&self) -> Result<(), LaunchCheckError>;
}

/// Named always-allow launch check for host probes with no user consent boundary.
#[derive(Debug, Default)]
pub struct AlwaysAllow;

impl LaunchCheck for AlwaysAllow {
    fn check(&self) -> Result<(), LaunchCheckError> {
        Ok(())
    }
}

/// Why no process was started.
#[derive(Debug)]
pub enum ProcessStartError {
    /// Caller cancellation won before `Command::spawn` executed.
    CancelledBeforeStart,
    /// The budget expired before `Command::spawn` executed.
    TimedOutBeforeStart,
    /// The late launch check refused the still-unstarted request.
    LaunchDenied(LaunchCheckError),
    /// The operating system rejected the launch before any child existed.
    SpawnFailed(io::Error),
    /// The supervisor worker stopped before reporting a start result.
    SupervisorUnavailable,
    /// Every running and bounded-queue admission slot is occupied.
    LimitExceeded,
}

/// Starts owned processes. Handler tests can implement this port with named fakes.
pub trait ProcessSpawner: Send + Sync {
    /// Applies cancellation and deadline while waiting admission and running the final check. Once
    /// this returns a control, the caller explicitly requests post-launch cancellation or close.
    fn start(
        &self,
        request: ProcessRequest,
        check: Arc<dyn LaunchCheck>,
        cancel: CancellationToken,
    ) -> ProcessFuture<'_, Result<ProcessControl, ProcessStartError>>;
}

/// Production [`ProcessSpawner`] implementation.
///
/// On Unix it launches a small guardian process that owns the target and a private process
/// group. A parent-death lease makes the guardian kill that group if this runtime dies abruptly;
/// terminal publication also clears ordinary descendants that outlive their direct parent. This
/// contains ordinary descendants, not a program that deliberately escapes by creating another
/// session or process group.
#[derive(Clone, Copy, Debug, Default)]
pub struct DefaultProcessSpawner;

impl ProcessSpawner for DefaultProcessSpawner {
    fn start(
        &self,
        request: ProcessRequest,
        check: Arc<dyn LaunchCheck>,
        cancel: CancellationToken,
    ) -> ProcessFuture<'_, Result<ProcessControl, ProcessStartError>> {
        let admission = match Arc::clone(admission_pool()).try_acquire_owned() {
            Ok(admission) => admission,
            Err(_) => return Box::pin(async { Err(ProcessStartError::LimitExceeded) }),
        };
        Box::pin(async move {
            let (result_tx, result_rx) = oneshot::channel();
            tokio::spawn(supervise_start(
                request,
                check,
                cancel,
                Instant::now(),
                result_tx,
                admission,
            ));
            result_rx
                .await
                .unwrap_or(Err(ProcessStartError::SupervisorUnavailable))
        })
    }
}

/// Observed exit state for the direct child.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessExit {
    /// Whether the process status was successful.
    pub success: bool,
    /// Exit code, or `None` when Unix reports a signal.
    pub code: Option<i32>,
    /// Natural Unix signal, when one ended the direct child.
    pub signal: Option<ProcessSignal>,
}

/// A Unix signal represented portably for handler result mapping.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessSignal {
    /// Numeric signal value.
    pub number: i32,
    /// Stable POSIX signal name, or `UNKNOWN` for an unmapped value.
    pub name: &'static str,
}

/// Supervisor reason for the terminal record.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessTerminalCause {
    /// The child exited without a supervisor stop request.
    Exited,
    /// The configured deadline expired.
    TimedOut,
    /// A caller explicitly cancelled after launch.
    Cancelled,
    /// A caller requested graceful interruption.
    Interrupted,
    /// A caller requested forced process-tree termination.
    Forced,
}

/// Bounded stream capture. `incomplete` means collection stopped before EOF, unlike truncation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessCapture {
    /// Retained bytes.
    pub bytes: Vec<u8>,
    /// More bytes were read beyond the configured cap.
    pub truncated: bool,
    /// The reader was stopped or failed before EOF.
    pub incomplete: bool,
}

/// Authoritative terminal record published after one worker cleans up the child it owns.
#[derive(Clone, Debug)]
pub struct ProcessTerminal {
    /// Why the supervisor settled this result.
    pub cause: ProcessTerminalCause,
    /// Direct-child exit status when waiting succeeded.
    pub exit: Option<ProcessExit>,
    /// Time from request start to final cleanup.
    pub elapsed: Duration,
    /// Captured stdout.
    pub stdout: ProcessCapture,
    /// Captured stderr.
    pub stderr: ProcessCapture,
}

/// Result of a requested stop action.
#[derive(Clone, Debug)]
pub enum ProcessStop {
    /// The worker observed the terminal record after cleanup.
    Observed(ProcessTerminal),
    /// The platform has no graceful-interrupt implementation.
    Unsupported,
    /// Signalling the still-running process failed before a terminal record existed.
    DispatchFailed(Arc<io::Error>),
}

/// A handle to one process worker. Cloning or dropping it cannot take ownership from the worker.
#[derive(Clone)]
pub struct ProcessControl {
    shared: Arc<Shared>,
}

impl std::fmt::Debug for ProcessControl {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProcessControl")
            .finish_non_exhaustive()
    }
}

impl ProcessControl {
    /// Builds an already-settled control for a deterministic [`ProcessSpawner`] test fake.
    ///
    /// The returned handle owns no OS process. Its stop methods therefore return the supplied
    /// terminal record immediately, which lets handler tests describe a non-zero exit, an
    /// incomplete capture, or a timeout without spawning a platform child.
    ///
    /// # Example
    ///
    /// ```
    /// use std::time::Duration;
    ///
    /// use mangostudio_runtime::subprocess::{
    ///     ProcessCapture, ProcessControl, ProcessTerminal, ProcessTerminalCause,
    /// };
    ///
    /// # #[tokio::main(flavor = "current_thread")]
    /// # async fn main() {
    /// let terminal = ProcessTerminal {
    ///     cause: ProcessTerminalCause::TimedOut,
    ///     exit: None,
    ///     elapsed: Duration::from_secs(1),
    ///     stdout: ProcessCapture { bytes: vec![], truncated: false, incomplete: true },
    ///     stderr: ProcessCapture { bytes: vec![], truncated: false, incomplete: true },
    /// };
    /// let control = ProcessControl::completed(terminal);
    /// assert_eq!(control.wait().await.cause, ProcessTerminalCause::TimedOut);
    /// # }
    /// ```
    #[must_use]
    pub fn completed(terminal: ProcessTerminal) -> Self {
        let (commands, _receiver) = mpsc::channel(MAX_PROCESS_CONTROL_COMMANDS);
        let (terminal_tx, _) = watch::channel(Some(terminal));
        Self {
            shared: Arc::new(Shared {
                commands,
                terminal: terminal_tx,
            }),
        }
    }

    /// Waits for terminal cleanup. Dropping this future does not affect the owned child.
    pub fn wait(&self) -> ProcessFuture<'_, ProcessTerminal> {
        let mut terminal = self.shared.terminal.subscribe();
        Box::pin(async move { wait_for_terminal(&mut terminal).await })
    }

    /// Requests SIGTERM-style graceful interruption and resolves only with an observed terminal result.
    pub fn interrupt(&self) -> ProcessFuture<'_, ProcessStop> {
        self.request_stop(StopRequest::Interrupt)
    }

    /// Requests forceful tree termination and resolves only with terminal cleanup.
    pub fn force_kill(&self) -> ProcessFuture<'_, ProcessStop> {
        self.request_stop(StopRequest::Force)
    }

    /// Records post-launch request cancellation and forcibly stops the owned tree.
    pub fn cancel(&self) -> ProcessFuture<'_, ProcessStop> {
        self.request_stop(StopRequest::Cancel)
    }

    /// Closes by forcibly stopping the owned tree. Concurrent callers wait on this one worker.
    pub fn close(&self) -> ProcessFuture<'_, ProcessStop> {
        self.request_stop(StopRequest::Force)
    }

    fn request_stop(&self, request: StopRequest) -> ProcessFuture<'_, ProcessStop> {
        let shared = Arc::clone(&self.shared);
        Box::pin(async move {
            let mut terminal = shared.terminal.subscribe();
            if let Some(terminal) = terminal.borrow().clone() {
                return ProcessStop::Observed(terminal);
            }
            let (reply, mut result) = oneshot::channel();
            let command = ControlCommand { request, reply };
            tokio::select! {
                biased;
                changed = terminal.changed() => {
                    let _ = changed;
                    return ProcessStop::Observed(wait_for_terminal(&mut terminal).await);
                }
                sent = shared.commands.send(command) => {
                    if sent.is_err() {
                        return ProcessStop::Observed(wait_for_terminal(&mut terminal).await);
                    }
                }
            }
            tokio::select! {
                biased;
                changed = terminal.changed() => {
                    let _ = changed;
                    ProcessStop::Observed(wait_for_terminal(&mut terminal).await)
                }
                response = &mut result => match response {
                    Ok(Ok(())) => ProcessStop::Observed(wait_for_terminal(&mut terminal).await),
                    Ok(Err(error)) if error.kind() == io::ErrorKind::Unsupported => ProcessStop::Unsupported,
                    Ok(Err(error)) => ProcessStop::DispatchFailed(Arc::new(error)),
                    Err(_) => ProcessStop::Observed(wait_for_terminal(&mut terminal).await),
                },
            }
        })
    }
}

struct Shared {
    commands: mpsc::Sender<ControlCommand>,
    terminal: watch::Sender<Option<ProcessTerminal>>,
}

struct ControlCommand {
    request: StopRequest,
    reply: oneshot::Sender<io::Result<()>>,
}

#[derive(Clone, Copy)]
enum StopRequest {
    Interrupt,
    Force,
    Cancel,
    Timeout,
}

fn process_pool() -> &'static Arc<Semaphore> {
    static POOL: OnceLock<Arc<Semaphore>> = OnceLock::new();
    POOL.get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_CHILD_PROCESSES)))
}

fn admission_pool() -> &'static Arc<Semaphore> {
    static POOL: OnceLock<Arc<Semaphore>> = OnceLock::new();
    POOL.get_or_init(|| Arc::new(Semaphore::new(MAX_SUPERVISED_PROCESS_REQUESTS)))
}

async fn supervise_start(
    request: ProcessRequest,
    check: Arc<dyn LaunchCheck>,
    cancel: CancellationToken,
    started: Instant,
    result_tx: oneshot::Sender<Result<ProcessControl, ProcessStartError>>,
    admission: tokio::sync::OwnedSemaphorePermit,
) {
    let Some(deadline) = started.checked_add(request.budget.deadline) else {
        let error = io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "process deadline {:?} exceeds the representable Instant range",
                request.budget.deadline
            ),
        );
        let _ = result_tx.send(Err(ProcessStartError::SpawnFailed(error)));
        return;
    };
    let permit = tokio::select! {
        biased;
        () = cancel.cancelled() => {
            let _ = result_tx.send(Err(ProcessStartError::CancelledBeforeStart));
            return;
        }
        () = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
            let _ = result_tx.send(Err(ProcessStartError::TimedOutBeforeStart));
            return;
        }
        permit = Arc::clone(process_pool()).acquire_owned() => permit.expect("the process pool is never closed"),
    };

    let mut child = match launch_child(request.clone(), check, cancel.clone(), deadline).await {
        Ok(child) => child,
        Err(error) => {
            let _ = result_tx.send(Err(error));
            return;
        }
    };
    let guardian_pid = child.id();
    let pre_launch_error = tokio::select! {
        biased;
        () = cancel.cancelled() => Some(ProcessStartError::CancelledBeforeStart),
        () = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => Some(ProcessStartError::TimedOutBeforeStart),
        ready = child.wait_ready() => ready.err().map(ProcessStartError::SpawnFailed),
    };
    if let Some(error) = pre_launch_error {
        cleanup_failed_start(&mut child, guardian_pid).await;
        let _ = result_tx.send(Err(error));
        return;
    }
    if let Err(error) = check_before_effect(&cancel, deadline) {
        cleanup_failed_start(&mut child, guardian_pid).await;
        let _ = result_tx.send(Err(error));
        return;
    }
    if let Err(error) = child.release_start() {
        cleanup_failed_start(&mut child, guardian_pid).await;
        let _ = result_tx.send(Err(ProcessStartError::SpawnFailed(error)));
        return;
    }
    // Once the release byte is written, the target may execute at any instant. Cancellation is
    // deliberately no longer observed here: it cannot truthfully retract an accepted effect.
    // A deadline instead becomes an owned terminal timeout below, even if it races with the
    // `execve` acknowledgement.
    let released_at_deadline = tokio::select! {
        biased;
        () = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => true,
        result = child.wait_exec() => {
            if let Err(error) = result {
                cleanup_failed_start(&mut child, guardian_pid).await;
                let _ = result_tx.send(Err(ProcessStartError::SpawnFailed(error)));
                return;
            }
            false
        }
    };
    let (command_tx, command_rx) = mpsc::channel(MAX_PROCESS_CONTROL_COMMANDS);
    let (terminal_tx, _) = watch::channel(None);
    let shared = Arc::new(Shared {
        commands: command_tx,
        terminal: terminal_tx,
    });
    let control = ProcessControl {
        shared: Arc::clone(&shared),
    };
    let _ = result_tx.send(Ok(control));
    let initial_stop = if released_at_deadline || Instant::now() >= deadline {
        Some(StopRequest::Timeout)
    } else {
        None
    };
    supervise_child(
        child,
        request,
        deadline,
        started,
        command_rx,
        shared,
        initial_stop,
        permit,
        admission,
    )
    .await;
}

/// Reclaims a child that never became a public [`ProcessControl`].
///
/// The Unix guardian deliberately remains alive after it has reported the target status, until
/// its parent acknowledges group cleanup. Every failed-start path therefore performs that final
/// handshake as well as waiting, so an `execve` error cannot strand a guardian behind a closed
/// start-result channel.
async fn cleanup_failed_start(child: &mut OwnedChild, pid: Option<u32>) {
    // A Unix target is held behind a private start gate until the public control is returned.
    // Closing that gate first lets a target which has already created its own process group exit
    // even when readiness has not reached the supervisor yet. The Windows equivalent keeps its
    // suspended primary thread stopped and relies on Job termination below.
    child.abort_start();
    let _ = force_tree_for_child(child, pid);
    let _ = child.wait_target().await;
    let _ = child.finalize();
    let _ = child.wait_guardian().await;
}

async fn launch_child(
    request: ProcessRequest,
    check: Arc<dyn LaunchCheck>,
    cancel: CancellationToken,
    deadline: Instant,
) -> Result<OwnedChild, ProcessStartError> {
    run_blocking(move || {
        check_before_effect(&cancel, deadline)?;
        check.check().map_err(ProcessStartError::LaunchDenied)?;
        check_before_effect(&cancel, deadline)?;

        #[cfg(unix)]
        {
            unix_guardian::spawn(&request)
                .map(OwnedChild::Guardian)
                .map_err(ProcessStartError::SpawnFailed)
        }

        #[cfg(windows)]
        {
            windows_job::spawn(&request)
                .map(OwnedChild::WindowsJob)
                .map_err(ProcessStartError::SpawnFailed)
        }

        #[cfg(all(not(unix), not(windows)))]
        {
            let mut command = Command::new(&request.program);
            command
                .args(&request.args)
                .kill_on_drop(true)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            match request.stdin {
                ProcessStdin::Null => {
                    command.stdin(Stdio::null());
                }
                ProcessStdin::Bytes(_) => {
                    command.stdin(Stdio::piped());
                }
            }
            if let Some(cwd) = request.cwd {
                command.current_dir(cwd);
            }
            if let Some(env) = request.env {
                command.env_clear().envs(env);
            }
            configure_containment(&mut command)?;
            command
                .spawn()
                .map(OwnedChild::Tokio)
                .map_err(ProcessStartError::SpawnFailed)
        }
    })
    .await
}

fn check_before_effect(
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<(), ProcessStartError> {
    if cancel.is_cancelled() {
        return Err(ProcessStartError::CancelledBeforeStart);
    }
    if Instant::now() >= deadline {
        return Err(ProcessStartError::TimedOutBeforeStart);
    }
    Ok(())
}

enum OwnedChild {
    #[cfg(unix)]
    Guardian(unix_guardian::GuardianChild),
    #[cfg(windows)]
    WindowsJob(windows_job::WindowsJobChild),
    #[cfg(all(not(unix), not(windows)))]
    Tokio(Child),
}

impl OwnedChild {
    fn id(&self) -> Option<u32> {
        match self {
            #[cfg(unix)]
            Self::Guardian(child) => child.id(),
            #[cfg(windows)]
            Self::WindowsJob(child) => child.id(),
            #[cfg(all(not(unix), not(windows)))]
            Self::Tokio(child) => child.id(),
        }
    }

    async fn wait_ready(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Guardian(child) => child.wait_ready().await,
            #[cfg(windows)]
            Self::WindowsJob(child) => child.wait_ready().await,
            #[cfg(all(not(unix), not(windows)))]
            Self::Tokio(_) => Ok(()),
        }
    }

    fn release_start(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Guardian(child) => child.release_start(),
            #[cfg(windows)]
            Self::WindowsJob(child) => child.release_start(),
            #[cfg(all(not(unix), not(windows)))]
            Self::Tokio(_) => Ok(()),
        }
    }

    fn abort_start(&mut self) {
        match self {
            #[cfg(unix)]
            Self::Guardian(child) => child.abort_start(),
            #[cfg(windows)]
            Self::WindowsJob(_) => {}
            #[cfg(all(not(unix), not(windows)))]
            Self::Tokio(_) => {}
        }
    }

    fn take_stdout(&mut self) -> Option<Box<dyn AsyncRead + Send + Unpin>> {
        match self {
            #[cfg(unix)]
            Self::Guardian(child) => child.take_stdout(),
            #[cfg(windows)]
            Self::WindowsJob(child) => child.take_stdout(),
            #[cfg(all(not(unix), not(windows)))]
            Self::Tokio(child) => child
                .stdout
                .take()
                .map(|stdout| Box::new(stdout) as Box<dyn AsyncRead + Send + Unpin>),
        }
    }

    fn take_stderr(&mut self) -> Option<Box<dyn AsyncRead + Send + Unpin>> {
        match self {
            #[cfg(unix)]
            Self::Guardian(child) => child.take_stderr(),
            #[cfg(windows)]
            Self::WindowsJob(child) => child.take_stderr(),
            #[cfg(all(not(unix), not(windows)))]
            Self::Tokio(child) => child
                .stderr
                .take()
                .map(|stderr| Box::new(stderr) as Box<dyn AsyncRead + Send + Unpin>),
        }
    }

    fn take_stdin(&mut self) -> Option<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> {
        match self {
            #[cfg(unix)]
            Self::Guardian(child) => child.take_stdin(),
            #[cfg(windows)]
            Self::WindowsJob(child) => child.take_stdin(),
            #[cfg(all(not(unix), not(windows)))]
            Self::Tokio(child) => child
                .stdin
                .take()
                .map(|stdin| Box::new(stdin) as Box<dyn tokio::io::AsyncWrite + Send + Unpin>),
        }
    }

    async fn wait_exec(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Guardian(child) => child.wait_exec().await,
            #[cfg(windows)]
            Self::WindowsJob(child) => child.wait_exec().await,
            #[cfg(all(not(unix), not(windows)))]
            Self::Tokio(_) => Ok(()),
        }
    }

    async fn wait_target(&mut self) -> io::Result<ExitStatus> {
        match self {
            #[cfg(unix)]
            Self::Guardian(child) => child.wait_target().await,
            #[cfg(windows)]
            Self::WindowsJob(child) => child.wait_target().await,
            #[cfg(all(not(unix), not(windows)))]
            Self::Tokio(child) => child.wait().await,
        }
    }

    fn finalize(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Guardian(child) => child.finalize(),
            #[cfg(windows)]
            Self::WindowsJob(child) => child.finalize(),
            #[cfg(all(not(unix), not(windows)))]
            Self::Tokio(_) => Ok(()),
        }
    }

    async fn wait_guardian(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Guardian(child) => child.wait_guardian().await,
            #[cfg(windows)]
            Self::WindowsJob(child) => child.wait_guardian().await,
            #[cfg(all(not(unix), not(windows)))]
            Self::Tokio(_) => Ok(()),
        }
    }

    fn interrupt(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Guardian(child) => child.interrupt(),
            #[cfg(windows)]
            Self::WindowsJob(child) => child.interrupt(),
            #[cfg(all(not(unix), not(windows)))]
            Self::Tokio(_) => Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "graceful interruption is unsupported on Windows",
            )),
        }
    }

    fn force(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Guardian(child) => child.force(),
            #[cfg(windows)]
            Self::WindowsJob(child) => child.force(),
            #[cfg(all(not(unix), not(windows)))]
            Self::Tokio(child) => child.start_kill(),
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn supervise_child(
    mut child: OwnedChild,
    request: ProcessRequest,
    deadline: Instant,
    started: Instant,
    mut commands: mpsc::Receiver<ControlCommand>,
    shared: Arc<Shared>,
    initial_stop: Option<StopRequest>,
    _permit: tokio::sync::OwnedSemaphorePermit,
    _admission: tokio::sync::OwnedSemaphorePermit,
) {
    let pid = child.id();
    let stdout = child.take_stdout().expect("stdout is piped");
    let stderr = child.take_stderr().expect("stderr is piped");
    let stdout_stop = CancellationToken::new();
    let stderr_stop = CancellationToken::new();
    let mut stdout_reader = tokio::spawn(read_capped(
        stdout,
        request.budget.max_stdout_bytes,
        stdout_stop.clone(),
    ));
    let mut stderr_reader = tokio::spawn(read_capped(
        stderr,
        request.budget.max_stderr_bytes,
        stderr_stop.clone(),
    ));
    let stdin_writer = match request.stdin {
        ProcessStdin::Null => None,
        ProcessStdin::Bytes(bytes) => child.take_stdin().map(|mut stdin| {
            tokio::spawn(async move {
                let result = stdin.write_all(&bytes).await;
                let _ = stdin.shutdown().await;
                result
            })
        }),
    };

    let mut cause = ProcessTerminalCause::Exited;
    let mut graceful_requested = false;
    let mut force_requested = false;
    let mut stopped_capture = StoppedCapture::default();
    if let Some(request) = initial_stop {
        cause = cause_for(request);
        let capture_was_open = capture_was_open(&stdout_reader, &stderr_reader);
        let dispatched = dispatch_stop(&mut child, pid, request).is_ok();
        graceful_requested = dispatched && matches!(request, StopRequest::Interrupt);
        force_requested = matches!(
            request,
            StopRequest::Force | StopRequest::Cancel | StopRequest::Timeout
        );
        if dispatched && request_stops_capture(request) {
            stopped_capture.record(capture_was_open);
        }
    }
    let status = loop {
        tokio::select! {
            status = child.wait_target() => break status.ok(),
            () = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)), if !force_requested => {
                cause = ProcessTerminalCause::TimedOut;
                let capture_was_open = capture_was_open(&stdout_reader, &stderr_reader);
                let dispatched = dispatch_stop(&mut child, pid, StopRequest::Force).is_ok();
                force_requested = true;
                if dispatched {
                    stopped_capture.record(capture_was_open);
                }
            }
            Some(command) = commands.recv() => {
                if (matches!(command.request, StopRequest::Interrupt) && (graceful_requested || force_requested))
                    || (matches!(command.request, StopRequest::Force | StopRequest::Cancel) && force_requested)
                {
                    let _ = command.reply.send(Ok(()));
                    continue;
                }
                let capture_was_open = capture_was_open(&stdout_reader, &stderr_reader);
                match dispatch_stop(&mut child, pid, command.request) {
                    Ok(()) => {
                        cause = cause_for(command.request);
                        graceful_requested |= matches!(command.request, StopRequest::Interrupt);
                        force_requested |= matches!(command.request, StopRequest::Force | StopRequest::Cancel);
                        if request_stops_capture(command.request) {
                            stopped_capture.record(capture_was_open);
                        }
                        let _ = command.reply.send(Ok(()));
                    }
                    Err(error) => {
                        let _ = command.reply.send(Err(error));
                    }
                }
            }
        }
    };
    if let Some(writer) = stdin_writer {
        writer.abort();
    }
    let (mut stdout, mut stderr, drain_reached_deadline) = collect_output(
        &mut stdout_reader,
        &mut stderr_reader,
        deadline,
        request.budget.post_exit_drain,
        &stdout_stop,
        &stderr_stop,
    )
    .await;
    if drain_reached_deadline && cause == ProcessTerminalCause::Exited {
        cause = ProcessTerminalCause::TimedOut;
    }
    stopped_capture.apply(&mut stdout, &mut stderr);
    // The guardian mirrors its direct target's status, but an ordinary descendant can outlive
    // that target without holding a captured pipe. A bounded drain concludes first; force any
    // remaining target-group members at the deadline, then always acknowledge final cleanup so
    // the guardian can reap itself after it has reported the target status.
    if drain_reached_deadline {
        let _ = child.force();
    }
    let _ = child.finalize();
    let _ = child.wait_guardian().await;
    let _ = shared.terminal.send(Some(ProcessTerminal {
        cause,
        exit: status.map(process_exit),
        elapsed: started.elapsed(),
        stdout,
        stderr,
    }));
}

fn cause_for(request: StopRequest) -> ProcessTerminalCause {
    match request {
        StopRequest::Interrupt => ProcessTerminalCause::Interrupted,
        StopRequest::Force => ProcessTerminalCause::Forced,
        StopRequest::Cancel => ProcessTerminalCause::Cancelled,
        StopRequest::Timeout => ProcessTerminalCause::TimedOut,
    }
}

fn request_stops_capture(request: StopRequest) -> bool {
    matches!(
        request,
        StopRequest::Force | StopRequest::Cancel | StopRequest::Timeout
    )
}

fn capture_was_open(
    stdout_reader: &tokio::task::JoinHandle<ProcessCapture>,
    stderr_reader: &tokio::task::JoinHandle<ProcessCapture>,
) -> (bool, bool) {
    (!stdout_reader.is_finished(), !stderr_reader.is_finished())
}

#[derive(Default)]
struct StoppedCapture {
    stdout: bool,
    stderr: bool,
}

impl StoppedCapture {
    fn record(&mut self, open: (bool, bool)) {
        self.stdout |= open.0;
        self.stderr |= open.1;
    }

    fn apply(&self, stdout: &mut ProcessCapture, stderr: &mut ProcessCapture) {
        stdout.incomplete |= self.stdout;
        stderr.incomplete |= self.stderr;
    }
}

async fn collect_output(
    stdout_reader: &mut tokio::task::JoinHandle<ProcessCapture>,
    stderr_reader: &mut tokio::task::JoinHandle<ProcessCapture>,
    deadline: Instant,
    post_exit_drain: Duration,
    stdout_stop: &CancellationToken,
    stderr_stop: &CancellationToken,
) -> (ProcessCapture, ProcessCapture, bool) {
    let remaining = deadline.saturating_duration_since(Instant::now());
    let reaches_deadline = post_exit_drain >= remaining;
    let grace = remaining.min(post_exit_drain);
    let timeout = tokio::time::sleep(grace);
    tokio::pin!(timeout);
    let mut stdout = None;
    let mut stderr = None;

    while stdout.is_none() || stderr.is_none() {
        tokio::select! {
            result = &mut *stdout_reader, if stdout.is_none() => stdout = Some(result),
            result = &mut *stderr_reader, if stderr.is_none() => stderr = Some(result),
            () = &mut timeout => break,
        }
    }

    let timed_out = stdout.is_none() || stderr.is_none();
    let stdout = match stdout {
        Some(result) => capture_result(result),
        None => stop_reader(stdout_reader, stdout_stop).await,
    };
    let stderr = match stderr {
        Some(result) => capture_result(result),
        None => stop_reader(stderr_reader, stderr_stop).await,
    };
    (stdout, stderr, timed_out && reaches_deadline)
}

fn capture_result(result: Result<ProcessCapture, tokio::task::JoinError>) -> ProcessCapture {
    result.unwrap_or_else(|_| ProcessCapture::incomplete())
}

async fn stop_reader(
    reader: &mut tokio::task::JoinHandle<ProcessCapture>,
    stop: &CancellationToken,
) -> ProcessCapture {
    stop.cancel();
    capture_result((&mut *reader).await)
}

impl ProcessCapture {
    fn incomplete() -> Self {
        Self {
            bytes: Vec::new(),
            truncated: false,
            incomplete: true,
        }
    }
}

async fn read_capped<R>(mut reader: R, max_bytes: usize, stop: CancellationToken) -> ProcessCapture
where
    R: AsyncRead + Unpin,
{
    let mut bytes = vec![0; max_bytes];
    let mut filled = 0;
    let mut truncated = false;
    let mut discard = [0; 8192];
    loop {
        let read = if filled < max_bytes {
            tokio::select! {
                () = stop.cancelled() => {
                    bytes.truncate(filled);
                    return ProcessCapture { bytes, truncated, incomplete: true };
                },
                result = reader.read(&mut bytes[filled..]) => result,
            }
        } else {
            tokio::select! {
                () = stop.cancelled() => {
                    bytes.truncate(filled);
                    return ProcessCapture { bytes, truncated, incomplete: true };
                },
                result = reader.read(&mut discard) => result,
            }
        };
        match read {
            Ok(0) => {
                bytes.truncate(filled);
                return ProcessCapture {
                    bytes,
                    truncated,
                    incomplete: false,
                };
            }
            Ok(read) if filled < max_bytes => filled += read,
            Ok(_) => truncated = true,
            Err(_) => {
                bytes.truncate(filled);
                return ProcessCapture {
                    bytes,
                    truncated,
                    incomplete: true,
                };
            }
        }
    }
}

async fn wait_for_terminal(
    receiver: &mut watch::Receiver<Option<ProcessTerminal>>,
) -> ProcessTerminal {
    loop {
        if let Some(terminal) = receiver.borrow().clone() {
            return terminal;
        }
        let _ = receiver.changed().await;
    }
}

#[cfg(all(not(unix), not(windows)))]
fn configure_containment(_command: &mut Command) -> Result<(), ProcessStartError> {
    Err(ProcessStartError::SpawnFailed(io::Error::new(
        io::ErrorKind::Unsupported,
        "process-tree containment is unavailable on this platform",
    )))
}

fn dispatch_stop(child: &mut OwnedChild, pid: Option<u32>, request: StopRequest) -> io::Result<()> {
    match request {
        StopRequest::Interrupt => child.interrupt(),
        StopRequest::Force | StopRequest::Cancel | StopRequest::Timeout => {
            force_tree_for_child(child, pid)
        }
    }
}

fn force_tree_for_child(child: &mut OwnedChild, _pid: Option<u32>) -> io::Result<()> {
    child.force()
}

fn process_exit(status: ExitStatus) -> ProcessExit {
    ProcessExit {
        success: status.success(),
        code: status.code(),
        signal: process_signal(&status),
    }
}

#[cfg(unix)]
fn process_signal(status: &ExitStatus) -> Option<ProcessSignal> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|number| ProcessSignal {
        number,
        name: signal_name(number),
    })
}

#[cfg(not(unix))]
fn process_signal(_status: &ExitStatus) -> Option<ProcessSignal> {
    None
}

#[cfg(unix)]
fn signal_name(number: i32) -> &'static str {
    match number {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        6 => "SIGABRT",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        15 => "SIGTERM",
        _ => "UNKNOWN",
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, OnceLock};
    use std::time::Duration;

    use mango_protocol::RemoteError;
    use tokio_util::sync::CancellationToken;

    use super::{
        AlwaysAllow, DefaultProcessSpawner, LaunchCheck, ProcessBudget, ProcessCapture,
        ProcessControl, ProcessRequest, ProcessSpawner, ProcessStartError, ProcessStdin,
        ProcessTerminal, ProcessTerminalCause,
    };
    use crate::test_support::scratch_dir;

    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    fn request(program: PathBuf) -> ProcessRequest {
        ProcessRequest::new(program, std::iter::empty::<String>()).with_budget(
            ProcessBudget::new(Duration::from_secs(10), 1_024, 1_024)
                .with_post_exit_drain(Duration::from_millis(100)),
        )
    }

    fn ignored_term_script(dir: &Path, ready: &Path) -> PathBuf {
        script(
            dir,
            "ignore-term.sh",
            &format!(
                "exec /bin/bash -c 'trap \"\" TERM; printf ready > \"$1\"; while :; do sleep 20; done' bash {}",
                ready.display()
            ),
        )
    }

    async fn process_test_guard() -> tokio::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await
    }

    #[tokio::test]
    async fn exact_argv_cwd_environment_and_bytes_stdin_reach_the_child() {
        let _guard = process_test_guard().await;
        let dir = scratch_dir("process-request");
        let sh = script(
            &dir,
            "show.sh",
            "printf '%s|%s|%s|' \"$1\" \"$PWD\" \"$EXACT_VALUE\"; cat",
        );
        let mut request = request(sh);
        request.args = vec!["one value".into()];
        request.cwd = Some(dir.path().to_path_buf());
        request.env = Some(BTreeMap::from([("EXACT_VALUE".into(), "kept".into())]));
        request.stdin = ProcessStdin::Bytes(b" input".to_vec());

        let terminal = DefaultProcessSpawner
            .start(request, Arc::new(AlwaysAllow), CancellationToken::new())
            .await
            .expect("script starts")
            .wait()
            .await;

        assert_eq!(terminal.cause, ProcessTerminalCause::Exited);
        // macOS exposes `/var` as a symlink to `/private/var` after the child enters its cwd.
        // Compare the kernel's resolved directory while retaining the requested path for launch.
        let expected_cwd =
            std::fs::canonicalize(dir.path()).unwrap_or_else(|_| dir.path().to_path_buf());
        assert_eq!(
            terminal.stdout.bytes,
            format!("one value|{}|kept| input", expected_cwd.display()).into_bytes()
        );
        assert!(!terminal.stdout.truncated);
        assert!(!terminal.stdout.incomplete);
    }

    #[tokio::test]
    async fn launch_cancellation_before_admission_never_calls_the_named_check() {
        let cancel = CancellationToken::new();
        cancel.cancel();

        let error = DefaultProcessSpawner
            .start(
                ProcessRequest::new("/bin/true", std::iter::empty::<String>()),
                Arc::new(PanicIfCalled),
                cancel,
            )
            .await
            .expect_err("cancelled admission cannot reach a launch effect");

        assert!(matches!(error, ProcessStartError::CancelledBeforeStart));
    }

    /// An unrepresentable deadline fails before admission or the final launch check can create
    /// a child, rather than panicking inside the detached supervisor task.
    #[tokio::test]
    async fn unrepresentable_deadline_is_rejected_before_any_launch_effect() {
        let request = ProcessRequest::new("/bin/true", std::iter::empty::<String>())
            .with_budget(ProcessBudget::new(Duration::MAX, 1_024, 1_024));

        let error = DefaultProcessSpawner
            .start(request, Arc::new(PanicIfCalled), CancellationToken::new())
            .await
            .expect_err("an invalid Instant range cannot start a child");

        match error {
            ProcessStartError::SpawnFailed(error) => {
                assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
                assert!(error.to_string().contains("deadline"));
            }
            other => panic!("expected an invalid deadline error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn late_launch_denial_preserves_the_remote_error() {
        let error = DefaultProcessSpawner
            .start(
                ProcessRequest::new("/bin/true", std::iter::empty::<String>()),
                Arc::new(DenyLaunch),
                CancellationToken::new(),
            )
            .await
            .expect_err("the named fake rejects the final check");

        match error {
            ProcessStartError::LaunchDenied(error) => {
                assert_eq!(error.code, "DENIED");
                assert_eq!(error.message, "late launch check denied this executable");
            }
            other => panic!("expected the unmodified launch denial, got {other:?}"),
        }
    }

    /// A failed `execve` is a launch error, not a successfully started program that chose 127.
    #[tokio::test]
    async fn missing_executable_returns_the_original_spawn_error() {
        let _guard = process_test_guard().await;
        let dir = scratch_dir("process-missing-executable");
        let error = DefaultProcessSpawner
            .start(
                ProcessRequest::new(
                    dir.path().join("does-not-exist"),
                    std::iter::empty::<String>(),
                ),
                Arc::new(AlwaysAllow),
                CancellationToken::new(),
            )
            .await
            .expect_err("a missing executable cannot produce a process control");

        match error {
            ProcessStartError::SpawnFailed(error) => {
                assert_eq!(error.raw_os_error(), Some(libc::ENOENT));
            }
            other => panic!("expected an exec spawn error, got {other:?}"),
        }
    }

    /// A program which successfully calls `exit 127` remains an observed terminal result.
    #[tokio::test]
    async fn an_executable_that_exits_127_is_not_reclassified_as_a_spawn_error() {
        let _guard = process_test_guard().await;
        let dir = scratch_dir("process-exit-127");
        let terminal = DefaultProcessSpawner
            .start(
                request(script(&dir, "exit-127.sh", "exit 127")),
                Arc::new(AlwaysAllow),
                CancellationToken::new(),
            )
            .await
            .expect("execve succeeded")
            .wait()
            .await;

        assert_eq!(terminal.cause, ProcessTerminalCause::Exited);
        assert_eq!(terminal.exit.and_then(|exit| exit.code), Some(127));
    }

    #[tokio::test]
    async fn concurrent_close_waits_for_the_same_forced_tree_cleanup() {
        let _guard = process_test_guard().await;
        let dir = scratch_dir("process-close");
        let child_pid = dir.join("child-pid");
        let sh = script(
            &dir,
            "slow.sh",
            &format!("sleep 20 & echo $! > {}\nsleep 20", child_pid.display()),
        );
        let control = DefaultProcessSpawner
            .start(request(sh), Arc::new(AlwaysAllow), CancellationToken::new())
            .await
            .expect("script starts");
        wait_for_file(&child_pid).await;

        let (first, second) = tokio::join!(control.close(), control.close());
        assert_eq!(observed(first).cause, ProcessTerminalCause::Forced);
        assert_eq!(observed(second).cause, ProcessTerminalCause::Forced);
        assert_process_is_gone(&child_pid).await;
    }

    /// Force signals only the target group, leaving the guardian alive to report SIGKILL before
    /// it performs its final descendant cleanup.
    #[tokio::test]
    async fn force_kill_reports_the_target_sigkill() {
        let _guard = process_test_guard().await;
        let dir = scratch_dir("process-force-signal");
        let control = DefaultProcessSpawner
            .start(
                request(script(&dir, "slow.sh", "sleep 20")),
                Arc::new(AlwaysAllow),
                CancellationToken::new(),
            )
            .await
            .expect("script starts");

        let terminal = observed(control.force_kill().await);
        assert_eq!(terminal.cause, ProcessTerminalCause::Forced);
        assert_eq!(
            terminal
                .exit
                .as_ref()
                .and_then(|exit| exit.signal.as_ref().map(|signal| signal.number)),
            Some(libc::SIGKILL)
        );
    }

    /// A graceful request does not consume forced ownership: an ignored TERM can be escalated by
    /// a later close and still returns the status that the target actually observed.
    #[tokio::test]
    async fn ignored_interrupt_can_be_escalated_to_a_forced_terminal() {
        let _guard = process_test_guard().await;
        let dir = scratch_dir("process-interrupt-force");
        let ready = dir.join("ready");
        let control = DefaultProcessSpawner
            .start(
                request(ignored_term_script(&dir, &ready)),
                Arc::new(AlwaysAllow),
                CancellationToken::new(),
            )
            .await
            .expect("script starts");
        wait_for_file(&ready).await;

        let interrupter = control.clone();
        let interrupted = tokio::spawn(async move { interrupter.interrupt().await });
        tokio::time::sleep(Duration::from_millis(50)).await;

        let terminal = observed(control.force_kill().await);
        assert_eq!(terminal.cause, ProcessTerminalCause::Forced);
        assert_eq!(
            terminal
                .exit
                .as_ref()
                .and_then(|exit| exit.signal.as_ref().map(|signal| signal.number)),
            Some(libc::SIGKILL)
        );
        let interrupted = observed(interrupted.await.expect("interrupt task joins"));
        assert_eq!(interrupted.cause, terminal.cause);
        assert_eq!(interrupted.exit, terminal.exit);
    }

    /// An ignored TERM still reaches the request deadline, which escalates the target group to
    /// SIGKILL and records the deadline rather than leaving the worker indefinitely graceful.
    #[tokio::test]
    async fn ignored_interrupt_escalates_at_the_deadline() {
        let _guard = process_test_guard().await;
        let dir = scratch_dir("process-interrupt-timeout");
        let ready = dir.join("ready");
        let mut process_request = request(ignored_term_script(&dir, &ready));
        process_request.budget.deadline = Duration::from_secs(2);
        let control = DefaultProcessSpawner
            .start(
                process_request,
                Arc::new(AlwaysAllow),
                CancellationToken::new(),
            )
            .await
            .expect("script starts");
        wait_for_file(&ready).await;

        let interrupter = control.clone();
        let interrupted = tokio::spawn(async move { interrupter.interrupt().await });
        let terminal = control.wait().await;

        assert_eq!(terminal.cause, ProcessTerminalCause::TimedOut);
        assert_eq!(
            terminal
                .exit
                .as_ref()
                .and_then(|exit| exit.signal.as_ref().map(|signal| signal.number)),
            Some(libc::SIGKILL)
        );
        let interrupted = observed(interrupted.await.expect("interrupt task joins"));
        assert_eq!(interrupted.cause, terminal.cause);
        assert_eq!(interrupted.exit, terminal.exit);
    }

    #[tokio::test]
    async fn a_dropped_control_keeps_its_worker_until_deadline_cleanup() {
        let _guard = process_test_guard().await;
        let dir = scratch_dir("process-drop-control");
        let pid_file = dir.join("pid");
        let sh = script(
            &dir,
            "slow.sh",
            &format!("echo $$ > {}\nsleep 20", pid_file.display()),
        );
        let mut request = request(sh);
        request.budget.deadline = Duration::from_secs(2);
        let control = DefaultProcessSpawner
            .start(request, Arc::new(AlwaysAllow), CancellationToken::new())
            .await
            .expect("script starts");
        wait_for_file(&pid_file).await;
        drop(control);

        assert_process_is_gone(&pid_file).await;
    }

    /// `start` returned only after the guardian had forked a target in its private group. This
    /// proves a deadline that expires after that launch kills and reaps the actual target rather
    /// than merely reporting a pre-admission timeout.
    #[tokio::test]
    async fn a_launched_child_past_its_deadline_is_killed_and_reaped() {
        let _guard = process_test_guard().await;
        let dir = scratch_dir("process-launched-timeout");
        let pid_file = dir.join("pid");
        let sh = script(
            &dir,
            "slow.sh",
            &format!("echo $$ > {}\nsleep 20", pid_file.display()),
        );
        let mut request = request(sh);
        // Admission is part of the public deadline. Leave enough room for unrelated unit tests
        // sharing the global four-child pool, then prove this particular target was launched
        // before asserting its later deadline cleanup.
        request.budget.deadline = Duration::from_secs(5);
        let control = DefaultProcessSpawner
            .start(request, Arc::new(AlwaysAllow), CancellationToken::new())
            .await
            .expect("the target launches before its five-second deadline");
        wait_for_file(&pid_file).await;

        let terminal = control.wait().await;
        assert_eq!(terminal.cause, ProcessTerminalCause::TimedOut);
        assert_process_is_gone(&pid_file).await;
    }

    /// If a descendant holds only stderr, post-exit draining must retain completed stdout and
    /// the stderr prefix already captured before bounded collection stops.
    #[tokio::test]
    async fn post_exit_drain_retains_stdout_and_partial_stderr_without_repolling_stdout() {
        let _guard = process_test_guard().await;
        let dir = scratch_dir("process-drain-stderr");
        let sh = script(
            &dir,
            "leader-exits.sh",
            "printf stdout-prefix
printf stderr-prefix >&2
exec 1>&-
sleep 20 >&2 &
exit 0",
        );
        let terminal = DefaultProcessSpawner
            .start(request(sh), Arc::new(AlwaysAllow), CancellationToken::new())
            .await
            .expect("script starts")
            .wait()
            .await;

        assert_eq!(terminal.cause, ProcessTerminalCause::Exited);
        assert_eq!(terminal.stdout.bytes, b"stdout-prefix".to_vec());
        assert!(!terminal.stdout.incomplete);
        assert_eq!(terminal.stderr.bytes, b"stderr-prefix".to_vec());
        assert!(terminal.stderr.incomplete);
        assert!(terminal.elapsed < Duration::from_secs(1));
    }

    /// The inverse descriptor arrangement must preserve stderr while the stdout reader stops
    /// cooperatively, proving either completion order reaches a bounded terminal record.
    #[tokio::test]
    async fn post_exit_drain_retains_stderr_and_partial_stdout_without_repolling_stderr() {
        let _guard = process_test_guard().await;
        let dir = scratch_dir("process-drain-stdout");
        let sh = script(
            &dir,
            "leader-exits.sh",
            "printf stdout-prefix
printf stderr-prefix >&2
exec 2>&-
sleep 20 &
exit 0",
        );
        let terminal = DefaultProcessSpawner
            .start(request(sh), Arc::new(AlwaysAllow), CancellationToken::new())
            .await
            .expect("script starts")
            .wait()
            .await;

        assert_eq!(terminal.cause, ProcessTerminalCause::Exited);
        assert_eq!(terminal.stdout.bytes, b"stdout-prefix".to_vec());
        assert!(terminal.stdout.incomplete);
        assert_eq!(terminal.stderr.bytes, b"stderr-prefix".to_vec());
        assert!(!terminal.stderr.incomplete);
        assert!(terminal.elapsed < Duration::from_secs(1));
    }

    /// When a direct target exits just before its deadline while a descendant holds a pipe, the
    /// forced group cleanup still sends the guardian's final acknowledgement. Without it the
    /// guardian waits forever with the target leader retained as a zombie.
    #[tokio::test]
    async fn deadline_drain_forces_descendants_and_finalizes_the_guardian() {
        let _guard = process_test_guard().await;
        let dir = scratch_dir("process-deadline-drain-finalize");
        let sh = script(
            &dir,
            "leader-exits-near-deadline.sh",
            "sleep 1
sleep 20 &
exit 0",
        );
        let mut process_request = request(sh);
        process_request.budget.deadline = Duration::from_millis(1_050);
        process_request.budget.post_exit_drain = Duration::from_millis(100);

        let started = std::time::Instant::now();
        let terminal = DefaultProcessSpawner
            .start(
                process_request,
                Arc::new(AlwaysAllow),
                CancellationToken::new(),
            )
            .await
            .expect("script starts")
            .wait()
            .await;

        assert_eq!(terminal.cause, ProcessTerminalCause::TimedOut);
        assert!(terminal.stdout.incomplete);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    /// A forced timeout must retain the observation that each capture stream was still open
    /// when the supervisor killed the group, even when EOF arrives while the group is reaped.
    #[tokio::test]
    async fn forced_timeout_marks_open_captures_incomplete_after_reaping() {
        let _guard = process_test_guard().await;
        let dir = scratch_dir("process-timeout-capture");
        let sh = script(&dir, "slow.sh", "sleep 20");
        let mut request = request(sh);
        // Admission consumes the public deadline, so leave room for parallel unit tests before
        // this test proves a launched target's forced timeout behavior.
        request.budget.deadline = Duration::from_secs(2);
        let terminal = DefaultProcessSpawner
            .start(request, Arc::new(AlwaysAllow), CancellationToken::new())
            .await
            .expect("script starts")
            .wait()
            .await;

        assert_eq!(terminal.cause, ProcessTerminalCause::TimedOut);
        assert!(terminal.stdout.incomplete);
        assert!(terminal.stderr.incomplete);
    }

    /// Streams which reached EOF before a later timeout remain complete. A sleeping target that
    /// closed both descriptors must not look like its output was interrupted.
    #[tokio::test]
    async fn forced_timeout_keeps_closed_captures_complete() {
        let _guard = process_test_guard().await;
        let dir = scratch_dir("process-timeout-closed-capture");
        let sh = script(
            &dir,
            "slow.sh",
            "exec 1>&- 2>&-
sleep 20",
        );
        let mut request = request(sh);
        // Admission consumes the public deadline, so leave room for parallel unit tests before
        // this test proves a launched target's forced timeout behavior.
        request.budget.deadline = Duration::from_secs(2);
        let terminal = DefaultProcessSpawner
            .start(request, Arc::new(AlwaysAllow), CancellationToken::new())
            .await
            .expect("script starts")
            .wait()
            .await;

        assert_eq!(terminal.cause, ProcessTerminalCause::TimedOut);
        assert!(!terminal.stdout.incomplete);
        assert!(!terminal.stderr.incomplete);
    }

    #[tokio::test]
    async fn completed_control_makes_a_named_handler_fake_deterministic() {
        let expected = ProcessTerminal {
            cause: ProcessTerminalCause::TimedOut,
            exit: None,
            elapsed: Duration::from_millis(50),
            stdout: ProcessCapture {
                bytes: b"partial".to_vec(),
                truncated: false,
                incomplete: true,
            },
            stderr: ProcessCapture {
                bytes: Vec::new(),
                truncated: false,
                incomplete: true,
            },
        };
        let control = ProcessControl::completed(expected.clone());

        assert_eq!(control.wait().await.cause, expected.cause);
        assert_eq!(observed(control.close().await).stdout, expected.stdout);
    }

    struct PanicIfCalled;

    impl LaunchCheck for PanicIfCalled {
        fn check(&self) -> Result<(), RemoteError> {
            panic!("a cancelled request called its launch check")
        }
    }

    struct DenyLaunch;

    impl LaunchCheck for DenyLaunch {
        fn check(&self) -> Result<(), RemoteError> {
            Err(RemoteError::new(
                "DENIED",
                "late launch check denied this executable",
            ))
        }
    }

    fn observed(stop: super::ProcessStop) -> super::ProcessTerminal {
        match stop {
            super::ProcessStop::Observed(terminal) => terminal,
            other => panic!("expected an observed terminal result, got {other:?}"),
        }
    }

    async fn wait_for_file(path: &Path) {
        for _ in 0..500 {
            if path.exists() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("{} was never written", path.display());
    }

    async fn assert_process_is_gone(pid_file: &Path) {
        let pid: i32 = std::fs::read_to_string(pid_file)
            .expect("the child pid was recorded")
            .trim()
            .parse()
            .expect("the pid is an integer");
        for _ in 0..200 {
            if matches!(
                nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
                Err(nix::errno::Errno::ESRCH)
            ) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("pid {pid} remained live after its worker deadline");
    }
}
