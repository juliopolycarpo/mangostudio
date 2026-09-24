//! The SDK `ProcessLauncher` port over this runtime's process supervision.
//!
//! A vendor CLI is a child of this runtime, so it starts exactly like every other long-lived
//! child: a fresh launch check runs immediately before the OS effect, the target waits behind the
//! Unix guardian's start gate (or suspended inside a kill-on-close Windows Job) until that check
//! has passed, and one owner task keeps the [`PipeChild`] until its whole tree is proven gone.
//!
//! The SDK receives three separately owned halves: a [`ByteSource`] over stdout, an optional
//! [`ByteSink`] over stdin, and an [`Arc<dyn ProcessControl>`]. Dropping all three is a kill
//! request; the guardian or Job lease still ends the tree if this whole process dies first, and
//! runtime shutdown past [`TERM_CUTOFF`] forces every tree still owned here.
//!
//! Interruption is `SIGINT` to the target's process group on Unix. Windows has no console port
//! yet, so [`ProcessControl::interrupt`] reports [`InterruptOutcome::Unsupported`] there, which
//! makes every cancel a forced termination that the SDK records as nonresumable.
use std::ffi::OsString;
use std::future::Future;
use std::io;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use mango_external_agents::process::{
    ByteSink, ByteSource, ExitStatus, InterruptOutcome, LaunchSpec, ManagedProcess, ProcessControl,
    ProcessLauncher, StderrTail,
};
use mango_external_agents::session::CancelReason;
use mango_external_agents::{Error, Limits, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch};
use tokio_util::sync::{CancellationToken, DropGuard};

use crate::blocking::run_blocking;
use crate::release::{Owner, PROOF_CUTOFF, Release, TERM_CUTOFF};
use crate::subprocess::{LaunchCheck, PipeChild, ProcessRequest};

/// Process-wide ceiling on live external-agent process trees.
///
/// A pool of its own rather than the MCP pool: a vendor CLI is a heavyweight, session-long tree
/// (a Node or native agent plus the tools it runs), and sharing the MCP pool's
/// slots would let a few agent sessions starve the MCP servers other sessions depend on, or the
/// reverse. Sixteen concurrent agent trees is well past interactive use while still bounding a
/// runaway caller.
pub(crate) const MAX_EXTERNAL_AGENT_CHILDREN: usize = 16;
/// Bound on each cleanup wait (target status, then the empty-tree proof). Together with
/// [`DRAIN_TIMEOUT`] the worst case stays under the SDK's default five-second
/// `Limits::shutdown_timeout`, so `stop_process` never times out a kill that is merely slow.
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
/// Bound on joining the stderr drain once the tree is gone and every writer has closed.
const DRAIN_TIMEOUT: Duration = Duration::from_millis(500);
/// Size of one stdout read handed to the SDK.
const CHUNK_BYTES: usize = 16 * 1024;

type Reader = Box<dyn AsyncRead + Send + Unpin>;
type Writer = Box<dyn AsyncWrite + Send + Unpin>;
type InterruptReply = oneshot::Sender<InterruptOutcome>;

/// Starts the platform child. Production uses [`PipeChildSpawner`]; tests wrap it with named
/// fakes to count or refuse OS launches.
pub(crate) trait ChildSpawner: Send + Sync {
    /// Starts `request` held behind its start gate, with a stdin pipe only when `stdin_pipe`.
    fn spawn(&self, request: &ProcessRequest, stdin_pipe: bool) -> io::Result<PipeChild>;
}

/// The guardian- or Job-owned [`PipeChild`] spawner every other long-lived child uses.
#[derive(Debug, Default)]
pub(crate) struct PipeChildSpawner;

impl ChildSpawner for PipeChildSpawner {
    fn spawn(&self, request: &ProcessRequest, stdin_pipe: bool) -> io::Result<PipeChild> {
        PipeChild::spawn_with_stdin(request, stdin_pipe)
    }
}

/// The runtime's `ProcessLauncher`: exact authority, guardian/Job ownership, a bounded pool, and a
/// launch check re-run immediately before exec.
///
/// # Example
/// ```ignore
/// let launcher = GuardedProcessLauncher::new(consent_check, &Limits::default());
/// let child = launcher.spawn(spec).await?;
/// child.control.kill(CancelReason::Requested).await?;
/// ```
pub(crate) struct GuardedProcessLauncher {
    pool: Arc<Semaphore>,
    limit: usize,
    release: &'static Release,
    check: Arc<dyn LaunchCheck>,
    spawner: Arc<dyn ChildSpawner>,
    stderr_tail_bytes: usize,
}

impl GuardedProcessLauncher {
    /// A launcher drawing from the process-wide external-agent pool and shutdown tracker.
    ///
    /// `check` runs right before every exec, so a caller that binds it to consent can refuse a
    /// launch after consent is revoked; `limits` supplies the stderr tail cap.
    ///
    /// # Example
    /// ```ignore
    /// let launcher = GuardedProcessLauncher::new(Arc::new(AlwaysAllow), &Limits::default());
    /// ```
    pub(crate) fn new(check: Arc<dyn LaunchCheck>, limits: &Limits) -> Self {
        static POOL: OnceLock<Arc<Semaphore>> = OnceLock::new();
        Self {
            pool: Arc::clone(
                POOL.get_or_init(|| Arc::new(Semaphore::new(MAX_EXTERNAL_AGENT_CHILDREN))),
            ),
            limit: MAX_EXTERNAL_AGENT_CHILDREN,
            release: Release::process(),
            check,
            spawner: Arc::new(PipeChildSpawner),
            stderr_tail_bytes: limits.stderr_tail_bytes,
        }
    }

    /// Replaces the pool with a private one of `limit` slots.
    #[cfg(all(test, unix))]
    fn with_pool(mut self, limit: usize) -> Self {
        self.pool = Arc::new(Semaphore::new(limit));
        self.limit = limit;
        self
    }

    /// Reports owners to `release` instead of the process-wide tracker.
    #[cfg(all(test, unix))]
    fn with_release(mut self, release: &'static Release) -> Self {
        self.release = release;
        self
    }

    /// Replaces the platform spawner.
    #[cfg(all(test, unix))]
    fn with_spawner(mut self, spawner: Arc<dyn ChildSpawner>) -> Self {
        self.spawner = spawner;
        self
    }
}

#[async_trait::async_trait]
impl ProcessLauncher for GuardedProcessLauncher {
    async fn spawn(&self, spec: LaunchSpec) -> Result<ManagedProcess> {
        let Some(program) = spec.program().map(str::to_owned) else {
            return Err(Error::HostConfiguration {
                expected: "an argv naming a program",
                received: String::from("an empty argv"),
            });
        };
        let permit =
            Arc::clone(&self.pool)
                .try_acquire_owned()
                .map_err(|_| Error::LimitExceeded {
                    subject: "live external-agent processes",
                    limit: self.limit,
                    received: self.limit + 1,
                })?;
        let start = Start {
            request: request(&spec),
            stdin_pipe: spec.stdin,
            program,
            check: Arc::clone(&self.check),
            spawner: Arc::clone(&self.spawner),
            tail: StderrTail::with_capacity(self.stderr_tail_bytes),
        };
        let (ready_tx, ready_rx) = oneshot::channel();
        let cancel = CancellationToken::new();
        // Dropping this future before a result arrives abandons the start, never the child: the
        // owner sees the cancellation and cleans up whatever it already launched.
        let abandon = cancel.clone().drop_guard();
        let owner = self.release.own();
        tokio::spawn(own(start, cancel, ready_tx, (permit, owner, self.release)));
        let result = ready_rx.await.unwrap_or_else(|_| {
            Err(Error::Closed {
                subject: "external-agent process owner",
            })
        });
        let _ = abandon.disarm();
        result
    }
}

/// The exact request: argv[0] is the program, the environment is complete (nothing inherited),
/// and the cwd is the one the SDK already authorised.
fn request(spec: &LaunchSpec) -> ProcessRequest {
    let mut request = ProcessRequest::new(
        spec.argv[0].clone(),
        spec.argv[1..].iter().map(OsString::from),
    );
    request.env = Some(
        spec.env
            .iter()
            .map(|(key, value)| (OsString::from(key), OsString::from(value)))
            .collect(),
    );
    request.cwd = Some(spec.cwd.clone());
    request.hide_window = spec.hide_window;
    request
}

struct Start {
    request: ProcessRequest,
    stdin_pipe: bool,
    program: String,
    check: Arc<dyn LaunchCheck>,
    spawner: Arc<dyn ChildSpawner>,
    tail: StderrTail,
}

/// What the owner publishes once the tree is gone.
#[derive(Clone)]
struct Terminal {
    status: std::result::Result<ExitStatus, String>,
    cleanup: std::result::Result<(), String>,
}

/// Owns one child from the launch check to the empty-tree proof.
async fn own(
    start: Start,
    cancel: CancellationToken,
    ready: oneshot::Sender<Result<ManagedProcess>>,
    (permit, owner, release): (OwnedSemaphorePermit, Owner, &'static Release),
) {
    let Start {
        request,
        stdin_pipe,
        program,
        check,
        spawner,
        tail,
    } = start;
    let spawn_cancel = cancel.clone();
    let launched = run_blocking(move || {
        if spawn_cancel.is_cancelled() {
            return Err(StartFailure::Cancelled);
        }
        check.check().map_err(|_| StartFailure::Refused)?;
        if spawn_cancel.is_cancelled() {
            return Err(StartFailure::Cancelled);
        }
        spawner
            .spawn(&request, stdin_pipe)
            .map_err(StartFailure::Os)
    })
    .await;
    let mut child = match launched {
        Ok(child) => child,
        Err(failure) => {
            let _ = ready.send(Err(failure.into_error(&program)));
            return;
        }
    };
    if let Err(failure) = open_gate(&mut child, &cancel).await {
        child.abort_start();
        let _ = cleanup(child, None, release).await;
        let _ = ready.send(Err(failure.into_error(&program)));
        return;
    }
    let (Some(stdout), Some(stderr)) = (child.take_stdout(), child.take_stderr()) else {
        let _ = cleanup(child, None, release).await;
        let _ = ready.send(Err(Error::Launch {
            program,
            message: String::from("a child without its stdout and stderr pipes"),
        }));
        return;
    };
    let stdin = child.take_stdin();
    let drain = tokio::spawn(drain_into(stderr, tail.clone()));
    let handed_out = CancellationToken::new();
    let lease = Arc::new(Lease {
        _guard: handed_out.clone().drop_guard(),
    });
    let kill = CancellationToken::new();
    let (interrupt_tx, mut interrupts) = mpsc::channel::<InterruptReply>(4);
    let (terminal_tx, terminal_rx) = watch::channel(None);
    let control = GuardedControl {
        pid: child.id(),
        program: program.clone(),
        tail,
        kill: kill.clone(),
        interrupts: interrupt_tx,
        terminal: terminal_rx,
        _lease: Arc::clone(&lease),
    };
    let managed = ManagedProcess {
        stdout: Box::new(ChildStdout {
            reader: stdout,
            _lease: Arc::clone(&lease),
        }),
        stdin: stdin.map(|writer| -> Box<dyn ByteSink> {
            Box::new(ChildStdin {
                writer: Some(writer),
                _lease: Arc::clone(&lease),
            })
        }),
        control: Arc::new(control),
    };
    drop(lease);
    if ready.send(Ok(managed)).is_err() {
        kill.cancel();
    }
    let exited = supervise(&mut child, &kill, &handed_out, &mut interrupts, release).await;
    // Pending and later interrupt requests now resolve as `NotDelivered` instead of waiting.
    drop(interrupts);
    let (status, cleanup) = cleanup(child, exited, release).await;
    join_drain(drain).await;
    drop(permit);
    drop(owner);
    let _ = terminal_tx.send(Some(Terminal { status, cleanup }));
}

/// Why a child never started.
enum StartFailure {
    Cancelled,
    Refused,
    Os(io::Error),
}

impl StartFailure {
    fn into_error(self, program: &str) -> Error {
        match self {
            Self::Cancelled => Error::Cancelled {
                reason: CancelReason::Requested,
            },
            Self::Refused => Error::Cancelled {
                reason: CancelReason::ConsentRevoked,
            },
            Self::Os(error) => launch_error(program, &error),
        }
    }
}

/// Maps an OS failure to [`Error::Launch`] from structured values only: the OS error text for a
/// raw errno, or the error kind. A custom io error's text can carry argv or cwd, so it never
/// reaches the message; environment values never do.
fn launch_error(program: &str, error: &io::Error) -> Error {
    let message = match error.raw_os_error() {
        Some(code) => format!(
            "an OS launch failure ({})",
            io::Error::from_raw_os_error(code)
        ),
        None => format!("a launcher failure ({:?})", error.kind()),
    };
    Error::Launch {
        program: program.to_owned(),
        message,
    }
}

/// Waits for the start gate, releases it, and waits for exec to succeed or fail.
async fn open_gate(
    child: &mut PipeChild,
    cancel: &CancellationToken,
) -> std::result::Result<(), StartFailure> {
    tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(StartFailure::Cancelled),
        ready = child.wait_ready() => ready.map_err(StartFailure::Os)?,
    }
    if cancel.is_cancelled() {
        return Err(StartFailure::Cancelled);
    }
    child.release_start().map_err(StartFailure::Os)?;
    // Past the release byte the target may already be executing: cancellation can no longer
    // retract the launch, so an abandoned start is cleaned up through the kill path instead.
    child.wait_exec().await.map_err(StartFailure::Os)
}

/// Keeps the child until it exits, a kill is requested, every handle is dropped, or shutdown
/// reaches [`TERM_CUTOFF`]; serves interrupt requests meanwhile. Returns the target status when
/// the target exited on its own.
async fn supervise(
    child: &mut PipeChild,
    kill: &CancellationToken,
    handed_out: &CancellationToken,
    interrupts: &mut mpsc::Receiver<InterruptReply>,
    release: &Release,
) -> Option<io::Result<std::process::ExitStatus>> {
    loop {
        tokio::select! {
            biased;
            () = kill.cancelled() => return None,
            () = handed_out.cancelled() => return None,
            () = release.cutoff(TERM_CUTOFF) => return None,
            status = child.wait_target() => return Some(status),
            Some(reply) = interrupts.recv() => {
                let outcome = match child.interrupt_gracefully() {
                    Ok(()) => InterruptOutcome::Delivered,
                    Err(_) => InterruptOutcome::NotDelivered,
                };
                let _ = reply.send(outcome);
            }
        }
    }
}

/// Forces whatever is left of the tree, acknowledges final cleanup, and waits for the owner's
/// empty-tree proof. Every exit path runs this exactly once.
async fn cleanup(
    mut child: PipeChild,
    exited: Option<io::Result<std::process::ExitStatus>>,
    release: &Release,
) -> (
    std::result::Result<ExitStatus, String>,
    std::result::Result<(), String>,
) {
    // A forced kill that finds the group already gone is the ordinary case after a natural exit.
    let _ = child.force();
    let exited = match exited {
        Some(status) => Some(status),
        None => within_cleanup_bound(child.wait_target(), release).await,
    };
    let finalized = child.finalize();
    let tree = within_cleanup_bound(child.wait_tree(), release).await;
    run_blocking(move || drop(child)).await;
    let status = match exited {
        Some(Ok(status)) => Ok(exit_status(status)),
        Some(Err(error)) => Err(format!("a wait failure ({:?})", error.kind())),
        None => Err(String::from("no target status within the cleanup bound")),
    };
    let cleanup = match (tree, finalized) {
        (Some(Ok(())), Ok(())) => Ok(()),
        (Some(Err(error)), _) => Err(format!(
            "a process-tree cleanup failure ({:?})",
            error.kind()
        )),
        (None, _) => Err(format!(
            "a process tree not proven empty within {CLEANUP_TIMEOUT:?}"
        )),
        (_, Err(error)) => Err(format!(
            "a final cleanup acknowledgement failure ({:?})",
            error.kind()
        )),
    };
    (status, cleanup)
}

/// `wait`, for at most [`CLEANUP_TIMEOUT`] or until the shutdown [`PROOF_CUTOFF`].
async fn within_cleanup_bound<T>(wait: impl Future<Output = T>, release: &Release) -> Option<T> {
    tokio::select! {
        result = wait => Some(result),
        () = tokio::time::sleep(CLEANUP_TIMEOUT) => None,
        () = release.cutoff(PROOF_CUTOFF) => None,
    }
}

fn exit_status(status: std::process::ExitStatus) -> ExitStatus {
    ExitStatus {
        code: status.code(),
        signal: exit_signal(status),
    }
}

#[cfg(unix)]
fn exit_signal(status: std::process::ExitStatus) -> Option<i32> {
    std::os::unix::process::ExitStatusExt::signal(&status)
}

#[cfg(not(unix))]
fn exit_signal(_status: std::process::ExitStatus) -> Option<i32> {
    None
}

/// Keeps stderr drained into the bounded tail, so a chatty child never blocks on a full pipe.
async fn drain_into(mut stderr: Reader, tail: StderrTail) {
    let mut buffer = vec![0_u8; CHUNK_BYTES];
    while let Ok(read) = stderr.read(&mut buffer).await {
        if read == 0 {
            return;
        }
        tail.push(&buffer[..read]);
    }
}

/// Joins the drain: it ends by itself once the tree is gone; a descendant that escaped the tree
/// with the pipe open is cut off after [`DRAIN_TIMEOUT`], and the aborted task is still awaited.
async fn join_drain(mut drain: tokio::task::JoinHandle<()>) {
    if tokio::time::timeout(DRAIN_TIMEOUT, &mut drain)
        .await
        .is_ok()
    {
        return;
    }
    drain.abort();
    let _ = drain.await;
}

/// Shared by the three handed-out halves; dropping the last one asks the owner to kill the tree.
struct Lease {
    _guard: DropGuard,
}

struct ChildStdout {
    reader: Reader,
    _lease: Arc<Lease>,
}

#[async_trait::async_trait]
impl ByteSource for ChildStdout {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>> {
        let mut buffer = vec![0_u8; CHUNK_BYTES];
        let read = self
            .reader
            .read(&mut buffer)
            .await
            .map_err(|error| link_error("stdout read", &error))?;
        if read == 0 {
            return Ok(None);
        }
        buffer.truncate(read);
        Ok(Some(buffer))
    }
}

struct ChildStdin {
    writer: Option<Writer>,
    _lease: Arc<Lease>,
}

#[async_trait::async_trait]
impl ByteSink for ChildStdin {
    async fn write_all(&mut self, bytes: &[u8]) -> Result<()> {
        let Some(writer) = self.writer.as_mut() else {
            return Err(Error::Closed {
                subject: "external-agent stdin",
            });
        };
        writer
            .write_all(bytes)
            .await
            .map_err(|error| link_error("stdin write", &error))?;
        writer
            .flush()
            .await
            .map_err(|error| link_error("stdin flush", &error))
    }

    async fn close(&mut self) -> Result<()> {
        let Some(mut writer) = self.writer.take() else {
            return Ok(());
        };
        writer
            .shutdown()
            .await
            .map_err(|error| link_error("stdin close", &error))
    }
}

fn link_error(operation: &str, error: &io::Error) -> Error {
    Error::Link {
        peer: String::from("external agent"),
        message: format!("a {operation} failure ({:?})", error.kind()),
    }
}

/// The SDK's control half: pid, stderr tail, wait, interrupt, kill.
struct GuardedControl {
    pid: Option<u32>,
    program: String,
    tail: StderrTail,
    kill: CancellationToken,
    interrupts: mpsc::Sender<InterruptReply>,
    terminal: watch::Receiver<Option<Terminal>>,
    _lease: Arc<Lease>,
}

impl GuardedControl {
    async fn terminal(&self) -> Result<Terminal> {
        let mut terminal = self.terminal.clone();
        let recorded = terminal
            .wait_for(Option::is_some)
            .await
            .map_err(|_| Error::Closed {
                subject: "external-agent process owner",
            })?;
        Ok(recorded
            .clone()
            .expect("wait_for returned a recorded terminal"))
    }

    fn launch_failure(&self, message: String) -> Error {
        Error::Launch {
            program: self.program.clone(),
            message,
        }
    }
}

#[async_trait::async_trait]
impl ProcessControl for GuardedControl {
    fn pid(&self) -> Option<u32> {
        self.pid
    }

    fn stderr_tail(&self) -> String {
        self.tail.read()
    }

    async fn wait(&self) -> Result<ExitStatus> {
        self.terminal()
            .await?
            .status
            .map_err(|message| self.launch_failure(message))
    }

    async fn interrupt(&self, _reason: CancelReason) -> Result<InterruptOutcome> {
        if cfg!(windows) {
            // No console port for Job-owned children yet: interruption there is a forced
            // termination, which the SDK treats as nonresumable.
            return Ok(InterruptOutcome::Unsupported);
        }
        if self.kill.is_cancelled() || self.terminal.borrow().is_some() {
            return Ok(InterruptOutcome::NotDelivered);
        }
        let (reply, outcome) = oneshot::channel();
        if self.interrupts.send(reply).await.is_err() {
            return Ok(InterruptOutcome::NotDelivered);
        }
        Ok(outcome.await.unwrap_or(InterruptOutcome::NotDelivered))
    }

    async fn kill(&self, _reason: CancelReason) -> Result<()> {
        self.kill.cancel();
        self.terminal()
            .await?
            .cleanup
            .map_err(|message| self.launch_failure(message))
    }
}

#[cfg(test)]
#[path = "launcher_tests.rs"]
mod tests;
