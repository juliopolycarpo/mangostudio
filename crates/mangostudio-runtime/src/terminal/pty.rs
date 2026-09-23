//! Owned interactive pseudo-terminals. The platform child keeps the same Unix guardian or
//! Windows Job lifetime as a supervised noninteractive process.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Semaphore, mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::blocking::run_blocking;
use crate::subprocess::{
    LaunchCheck, LaunchCheckError, ProcessRequest, ProcessSignal, ProcessStdin, PtyChild,
};

/// A future returned by the object-safe PTY port.
pub type PtyFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The number of interactive child trees this runtime will own at once.
pub const MAX_PTY_CHILDREN: usize = 4;
const MAX_PTY_COMMANDS: usize = 16;
const MAX_PTY_WRITES: usize = 16;

/// Exact terminal launch, with an explicit initial screen size.
#[derive(Clone, Debug)]
pub struct PtyRequest {
    /// Executable path or platform command name.
    pub program: PathBuf,
    /// Arguments after the executable, never passed through a shell parser.
    pub args: Vec<OsString>,
    /// `None` inherits the host environment; `Some` replaces it exactly.
    pub env: Option<BTreeMap<OsString, OsString>>,
    /// Working directory for the child.
    pub cwd: Option<PathBuf>,
    /// Initial columns.
    pub cols: u16,
    /// Initial rows.
    pub rows: u16,
    #[cfg(test)]
    ready_gate: Option<Arc<ReadyGate>>,
    #[cfg(test)]
    fail_cleanup: bool,
}

impl PtyRequest {
    /// Creates a request for one executable with inherited environment.
    ///
    /// # Example
    ///
    /// ```
    /// use mangostudio_runtime::terminal::pty::PtyRequest;
    /// let request = PtyRequest::new("sh", ["-i"], 80, 24);
    /// assert_eq!(request.cols, 80);
    /// ```
    #[must_use]
    pub fn new(
        program: impl Into<PathBuf>,
        args: impl IntoIterator<Item = impl Into<OsString>>,
        cols: u16,
        rows: u16,
    ) -> Self {
        Self {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
            env: None,
            cwd: None,
            cols,
            rows,
            #[cfg(test)]
            ready_gate: None,
            #[cfg(test)]
            fail_cleanup: false,
        }
    }
}

#[cfg(test)]
#[derive(Debug)]
struct ReadyGate {
    reached: tokio::sync::Notify,
    resume: tokio::sync::Notify,
    settled: tokio::sync::Notify,
    released: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
struct PendingOutput;

#[cfg(test)]
impl tokio::io::AsyncRead for PendingOutput {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        _buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::task::Poll::Pending
    }
}

/// Direct-child status, or unknown status when process-tree cleanup fails.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PtyExit {
    /// Exit code when the process exited normally.
    pub code: Option<i32>,
    /// POSIX signal when one ended the process.
    pub signal: Option<ProcessSignal>,
}

/// Why a PTY could not start.
#[derive(Debug)]
pub enum PtyError {
    /// Initial size was zero.
    InvalidSize {
        /// Supplied columns.
        cols: u16,
        /// Supplied rows.
        rows: u16,
    },
    /// The final freshness check denied the still-unstarted child.
    LaunchDenied(LaunchCheckError),
    /// The caller abandoned the open before ownership transferred to a handle.
    CancelledBeforeStart,
    /// The bounded PTY process pool is full.
    LimitExceeded,
    /// The OS rejected or could not complete the launch.
    Start(io::Error),
    /// The launch worker ended before it reported a result.
    SupervisorUnavailable,
}

/// A child terminal. Closing waits for process-tree cleanup; dropping the handle leaves the
/// worker as owner until the child exits or the runtime itself dies.
pub trait PtyHandle: Send + Sync {
    /// Direct child's operating-system process ID.
    fn pid(&self) -> u32;
    /// Writes raw input bytes to the terminal master.
    fn write(&self, data: Vec<u8>) -> PtyFuture<'_, io::Result<()>>;
    /// Resizes the terminal and sends the platform's resize notification.
    fn resize(&self, cols: u16, rows: u16) -> PtyFuture<'_, io::Result<()>>;
    /// Kills the child tree and waits for its cleanup. Repeated closes share one result.
    fn close(&self) -> PtyFuture<'_, io::Result<()>>;
}

/// Starts a real PTY; tests can implement this port with a named fake.
pub trait PtySpawner: Send + Sync {
    /// Calls `on_data` for raw output and `on_exit` once after the tree cleanup attempt.
    fn spawn(
        &self,
        request: PtyRequest,
        check: Arc<dyn LaunchCheck>,
        on_data: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
        on_exit: Arc<dyn Fn(PtyExit) + Send + Sync>,
    ) -> PtyFuture<'_, Result<Arc<dyn PtyHandle>, PtyError>>;
}

/// Production PTY spawner over the Unix guardian or Windows Job.
#[derive(Clone, Copy, Debug, Default)]
pub struct DefaultPtySpawner;

impl PtySpawner for DefaultPtySpawner {
    fn spawn(
        &self,
        request: PtyRequest,
        check: Arc<dyn LaunchCheck>,
        on_data: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
        on_exit: Arc<dyn Fn(PtyExit) + Send + Sync>,
    ) -> PtyFuture<'_, Result<Arc<dyn PtyHandle>, PtyError>> {
        if request.cols == 0 || request.rows == 0 {
            return Box::pin(async move {
                Err(PtyError::InvalidSize {
                    cols: request.cols,
                    rows: request.rows,
                })
            });
        }
        let permit = match Arc::clone(pty_pool()).try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => return Box::pin(async { Err(PtyError::LimitExceeded) }),
        };
        Box::pin(async move {
            let (tx, rx) = oneshot::channel();
            let cancel = CancellationToken::new();
            let mut drop_guard = CancelOnDrop {
                token: cancel.clone(),
                armed: true,
            };
            tokio::spawn(supervise_pty(
                request, check, on_data, on_exit, cancel, tx, permit,
            ));
            let result = rx.await.unwrap_or(Err(PtyError::SupervisorUnavailable));
            drop_guard.armed = false;
            result
        })
    }
}

struct CancelOnDrop {
    token: CancellationToken,
    armed: bool,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.token.cancel();
        }
    }
}

fn pty_pool() -> &'static Arc<Semaphore> {
    static POOL: OnceLock<Arc<Semaphore>> = OnceLock::new();
    POOL.get_or_init(|| Arc::new(Semaphore::new(MAX_PTY_CHILDREN)))
}

struct RealPtyHandle {
    pid: u32,
    commands: mpsc::Sender<Command>,
    input: mpsc::Sender<WriteCommand>,
    terminal: watch::Receiver<Option<Result<(), Arc<io::Error>>>>,
}

enum Command {
    Resize {
        cols: u16,
        rows: u16,
        reply: oneshot::Sender<io::Result<()>>,
    },
    Close {
        reply: oneshot::Sender<io::Result<()>>,
    },
}

struct WriteCommand {
    data: Vec<u8>,
    reply: oneshot::Sender<io::Result<()>>,
}

impl PtyHandle for RealPtyHandle {
    fn pid(&self) -> u32 {
        self.pid
    }

    fn write(&self, data: Vec<u8>) -> PtyFuture<'_, io::Result<()>> {
        let input = self.input.clone();
        Box::pin(async move {
            let (reply, result) = oneshot::channel();
            input
                .send(WriteCommand { data, reply })
                .await
                .map_err(|_| closed_error())?;
            result.await.map_err(|_| closed_error())?
        })
    }

    fn resize(&self, cols: u16, rows: u16) -> PtyFuture<'_, io::Result<()>> {
        let commands = self.commands.clone();
        Box::pin(async move {
            if cols == 0 || rows == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("terminal size {cols}x{rows} requires nonzero columns and rows"),
                ));
            }
            let (reply, result) = oneshot::channel();
            commands
                .send(Command::Resize { cols, rows, reply })
                .await
                .map_err(|_| closed_error())?;
            result.await.map_err(|_| closed_error())?
        })
    }

    fn close(&self) -> PtyFuture<'_, io::Result<()>> {
        let commands = self.commands.clone();
        let mut terminal = self.terminal.clone();
        Box::pin(async move {
            if terminal.borrow().is_none() {
                let (reply, result) = oneshot::channel();
                if commands.send(Command::Close { reply }).await.is_ok()
                    && let Ok(Err(error)) = result.await
                {
                    return Err(error);
                }
            }
            loop {
                if let Some(result) = terminal.borrow().as_ref() {
                    return result
                        .as_ref()
                        .copied()
                        .map_err(|error| io::Error::new(error.kind(), error.to_string()));
                }
                terminal.changed().await.map_err(|_| closed_error())?;
            }
        })
    }
}

fn closed_error() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "terminal is already closed")
}

async fn supervise_pty(
    request: PtyRequest,
    check: Arc<dyn LaunchCheck>,
    on_data: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
    on_exit: Arc<dyn Fn(PtyExit) + Send + Sync>,
    cancel: CancellationToken,
    ready: oneshot::Sender<Result<Arc<dyn PtyHandle>, PtyError>>,
    _permit: tokio::sync::OwnedSemaphorePermit,
) {
    let cols = request.cols;
    let rows = request.rows;
    #[cfg(test)]
    let ready_gate = request.ready_gate.clone();
    #[cfg(test)]
    let fail_cleanup = request.fail_cleanup;
    let mut process = ProcessRequest::new(request.program, request.args)
        .with_stdin(ProcessStdin::Bytes(Vec::new()));
    process.cwd = request.cwd;
    process.env = request.env;
    let spawn_cancel = cancel.clone();
    let mut child = match run_blocking(move || {
        if spawn_cancel.is_cancelled() {
            return Err(PtyError::CancelledBeforeStart);
        }
        check.check().map_err(PtyError::LaunchDenied)?;
        if spawn_cancel.is_cancelled() {
            return Err(PtyError::CancelledBeforeStart);
        }
        PtyChild::spawn(&process, cols, rows).map_err(PtyError::Start)
    })
    .await
    {
        Ok(child) => child,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    let start_result = async {
        tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(PtyError::CancelledBeforeStart),
            result = child.wait_ready() => result.map_err(PtyError::Start)?,
        }
        #[cfg(test)]
        if let Some(gate) = &ready_gate {
            gate.reached.notify_one();
            gate.resume.notified().await;
        }
        if cancel.is_cancelled() {
            return Err(PtyError::CancelledBeforeStart);
        }
        child.release_start().map_err(PtyError::Start)?;
        #[cfg(test)]
        if let Some(gate) = &ready_gate {
            gate.released
                .store(true, std::sync::atomic::Ordering::Release);
        }
        child.wait_exec().await.map_err(PtyError::Start)
    }
    .await;
    if let Err(error) = start_result {
        child.abort_start();
        let _ = child.force();
        let _ = child.wait_target().await;
        let _ = child.finalize();
        let _ = child.wait_tree().await;
        run_blocking(move || drop(child)).await;
        #[cfg(test)]
        if let Some(gate) = &ready_gate {
            gate.settled.notify_one();
        }
        let _ = ready.send(Err(error));
        return;
    }
    if cancel.is_cancelled() {
        child.abort_start();
        let _ = child.force();
        let _ = child.wait_target().await;
        let _ = child.finalize();
        let _ = child.wait_tree().await;
        run_blocking(move || drop(child)).await;
        #[cfg(test)]
        if let Some(gate) = &ready_gate {
            gate.settled.notify_one();
        }
        let _ = ready.send(Err(PtyError::CancelledBeforeStart));
        return;
    }
    let Some(pid) = child.id() else {
        let _ = child.force();
        let _ = child.wait_target().await;
        let _ = child.finalize();
        let _ = child.wait_tree().await;
        run_blocking(move || drop(child)).await;
        let _ = ready.send(Err(PtyError::Start(io::Error::other(
            "PTY child has no process ID",
        ))));
        return;
    };
    let output = child.take_output().expect("PTY output exists");
    #[cfg(test)]
    let output: Box<dyn tokio::io::AsyncRead + Send + Unpin> = if fail_cleanup {
        Box::new(PendingOutput)
    } else {
        output
    };
    let input = child.take_input().expect("PTY input exists");
    let (commands_tx, mut commands_rx) = mpsc::channel(MAX_PTY_COMMANDS);
    let (input_tx, input_rx) = mpsc::channel(MAX_PTY_WRITES);
    let (terminal_tx, terminal_rx) = watch::channel(None);
    let handle: Arc<dyn PtyHandle> = Arc::new(RealPtyHandle {
        pid,
        commands: commands_tx,
        input: input_tx,
        terminal: terminal_rx,
    });
    if ready.send(Ok(handle)).is_err() {
        let _ = child.force();
        let _ = child.wait_target().await;
        let _ = child.finalize();
        let _ = child.wait_tree().await;
        run_blocking(move || drop(child)).await;
        return;
    }
    let reader = tokio::spawn(read_output(output, on_data));
    let writer = tokio::spawn(write_input(input, input_rx));
    let status = loop {
        tokio::select! {
            () = cancel.cancelled() => {
                let _ = child.force();
                break child.wait_target().await;
            }
            status = child.wait_target() => break status,
            Some(command) = commands_rx.recv() => match command {
                Command::Resize { cols, rows, reply } => { let _ = reply.send(child.resize(cols, rows).await); }
                Command::Close { reply } => {
                    match child.force() {
                        Ok(()) => {
                            let _ = reply.send(Ok(()));
                            break child.wait_target().await;
                        }
                        Err(error) => {
                            let _ = reply.send(Err(error));
                        }
                    }
                }
            },
        }
    };
    writer.abort();
    let finalization = child.finalize();
    let tree = child.wait_tree().await;
    let cleanup = finalization.and(tree);
    #[cfg(test)]
    let cleanup = if fail_cleanup {
        Err(io::Error::other("injected PTY cleanup failure"))
    } else {
        cleanup
    };
    // Closing ConPTY releases its output writer. The reader cannot reach EOF before this drop.
    run_blocking(move || drop(child)).await;
    if let Err(error) = cleanup {
        reader.abort();
        let _ = reader.await;
        on_exit(PtyExit {
            code: None,
            signal: None,
        });
        let _ = terminal_tx.send(Some(Err(Arc::new(error))));
        return;
    }
    let _ = reader.await;
    on_exit(status.map(exit_from_status).unwrap_or(PtyExit {
        code: None,
        signal: None,
    }));
    let _ = terminal_tx.send(Some(Ok(())));
}

async fn read_output(
    mut output: Box<dyn tokio::io::AsyncRead + Send + Unpin>,
    on_data: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
) {
    let mut buffer = [0_u8; 8192];
    loop {
        match output.read(&mut buffer).await {
            Ok(0) => return,
            Ok(size) => on_data(buffer[..size].to_vec()),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if error.raw_os_error() == Some(libc_eio()) => return,
            Err(_) => return,
        }
    }
}

#[cfg(unix)]
fn libc_eio() -> i32 {
    libc::EIO
}
#[cfg(not(unix))]
fn libc_eio() -> i32 {
    -1
}

async fn write_input(
    mut input: Box<dyn tokio::io::AsyncWrite + Send + Unpin>,
    mut receiver: mpsc::Receiver<WriteCommand>,
) {
    while let Some(command) = receiver.recv().await {
        let result = input.write_all(&command.data).await;
        let _ = command.reply.send(result);
    }
}

fn exit_from_status(status: std::process::ExitStatus) -> PtyExit {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        let signal = status.signal().map(|number| ProcessSignal {
            number,
            name: signal_name(number),
        });
        PtyExit {
            code: status.code(),
            signal,
        }
    }
    #[cfg(not(unix))]
    {
        PtyExit {
            code: status.code(),
            signal: None,
        }
    }
}

#[cfg(unix)]
fn signal_name(number: i32) -> &'static str {
    match number {
        libc::SIGTERM => "SIGTERM",
        libc::SIGKILL => "SIGKILL",
        libc::SIGINT => "SIGINT",
        libc::SIGHUP => "SIGHUP",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGPIPE => "SIGPIPE",
        _ => "UNKNOWN",
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::io;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::task::{Context, Poll};
    use std::time::Duration;

    use mango_protocol::RemoteError;
    use tokio::io::{AsyncRead, ReadBuf};
    use tokio::sync::oneshot;

    use super::{
        DefaultPtySpawner, PtyError, PtyExit, PtyRequest, PtySpawner, ReadyGate, read_output,
    };
    use crate::subprocess::{AlwaysAllow, LaunchCheck};

    static REAL_PTY_TEST: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    struct DenyLaunch;

    struct InterruptedOnce {
        step: u8,
    }

    impl AsyncRead for InterruptedOnce {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            match self.step {
                0 => {
                    self.step = 1;
                    Poll::Ready(Err(io::Error::from(io::ErrorKind::Interrupted)))
                }
                1 => {
                    self.step = 2;
                    buffer.put_slice(b"after-interrupt");
                    Poll::Ready(Ok(()))
                }
                _ => Poll::Ready(Ok(())),
            }
        }
    }

    #[tokio::test]
    async fn interrupted_pty_read_keeps_draining_output() {
        let output = Arc::new(Mutex::new(Vec::new()));
        let collected = Arc::clone(&output);
        read_output(
            Box::new(InterruptedOnce { step: 0 }),
            Arc::new(move |bytes| collected.lock().unwrap().extend(bytes)),
        )
        .await;
        assert_eq!(*output.lock().unwrap(), b"after-interrupt");
    }

    #[tokio::test]
    async fn abandoned_open_does_not_release_a_ready_unix_target() {
        let _serial = REAL_PTY_TEST.lock().await;
        let gate = Arc::new(ReadyGate {
            reached: tokio::sync::Notify::new(),
            resume: tokio::sync::Notify::new(),
            settled: tokio::sync::Notify::new(),
            released: AtomicBool::new(false),
        });
        let mut request = PtyRequest::new("/bin/sh", ["-c", "exit 0"], 80, 24);
        request.ready_gate = Some(Arc::clone(&gate));
        let opener = tokio::spawn(async move {
            DefaultPtySpawner
                .spawn(
                    request,
                    Arc::new(AlwaysAllow),
                    Arc::new(|_| {}),
                    Arc::new(|_| {}),
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), gate.reached.notified())
            .await
            .expect("guardian reports ready");
        opener.abort();
        let _ = opener.await;
        gate.resume.notify_one();
        tokio::time::timeout(Duration::from_secs(5), gate.settled.notified())
            .await
            .expect("cancelled guardian is reaped");
        assert!(!gate.released.load(Ordering::Acquire));
    }

    impl LaunchCheck for DenyLaunch {
        fn check(&self) -> Result<(), RemoteError> {
            Err(RemoteError::new(
                "DENIED",
                "terminal launch consent was revoked",
            ))
        }
    }

    #[tokio::test]
    async fn final_launch_check_runs_before_the_pty_effect() {
        let request = PtyRequest::new("/missing-shell", std::iter::empty::<String>(), 80, 24);
        let result = DefaultPtySpawner
            .spawn(
                request,
                Arc::new(DenyLaunch),
                Arc::new(|_| {}),
                Arc::new(|_| {}),
            )
            .await;
        assert!(matches!(result, Err(PtyError::LaunchDenied(error)) if error.code == "DENIED"));
    }

    #[tokio::test]
    async fn invalid_initial_size_is_rejected_before_launch() {
        let request = PtyRequest::new("/bin/sh", std::iter::empty::<String>(), 0, 24);
        let result = DefaultPtySpawner
            .spawn(
                request,
                Arc::new(AlwaysAllow),
                Arc::new(|_| {}),
                Arc::new(|_| {}),
            )
            .await;
        assert!(matches!(
            result,
            Err(PtyError::InvalidSize { cols: 0, rows: 24 })
        ));
    }

    #[tokio::test]
    async fn unix_pty_has_controlling_tty_and_reports_native_exit() {
        let _serial = REAL_PTY_TEST.lock().await;
        let output = Arc::new(Mutex::new(Vec::new()));
        let collected = Arc::clone(&output);
        let (exit_tx, exit_rx) = oneshot::channel();
        let exit_tx = Arc::new(Mutex::new(Some(exit_tx)));
        let request = PtyRequest::new(
            "/bin/sh",
            [
                "-c",
                "stty size; read line; printf '<%s>\\n' \"$line\"; exit 7",
            ],
            83,
            31,
        );
        let handle = DefaultPtySpawner
            .spawn(
                request,
                Arc::new(AlwaysAllow),
                Arc::new(move |chunk| collected.lock().unwrap().extend(chunk)),
                Arc::new(move |exit: PtyExit| {
                    if let Some(sender) = exit_tx.lock().unwrap().take() {
                        let _ = sender.send(exit);
                    }
                }),
            )
            .await
            .expect("PTY starts");
        assert!(handle.pid() > 0);
        handle
            .write(b"hello\n".to_vec())
            .await
            .expect("input is written");
        let exit = tokio::time::timeout(Duration::from_secs(5), exit_rx)
            .await
            .expect("shell exits")
            .expect("exit callback runs");
        assert_eq!(exit.code, Some(7));
        assert!(exit.signal.is_none());
        let text = String::from_utf8_lossy(&output.lock().unwrap()).into_owned();
        assert!(
            text.contains("31 83"),
            "terminal size missing from {text:?}"
        );
        assert!(
            text.contains("<hello>"),
            "terminal input missing from {text:?}"
        );
        handle.close().await.expect("completed close is idempotent");
    }

    #[tokio::test]
    async fn unix_pty_resize_changes_the_childs_reported_size() {
        let _serial = REAL_PTY_TEST.lock().await;
        let output = Arc::new(Mutex::new(Vec::new()));
        let collected = Arc::clone(&output);
        let request = PtyRequest::new("/bin/sh", ["-c", "read line; stty size; read line"], 80, 24);
        let handle = DefaultPtySpawner
            .spawn(
                request,
                Arc::new(AlwaysAllow),
                Arc::new(move |chunk| collected.lock().unwrap().extend(chunk)),
                Arc::new(|_| {}),
            )
            .await
            .expect("PTY starts");
        handle.resize(101, 43).await.expect("PTY resizes");
        handle
            .write(b"first\n".to_vec())
            .await
            .expect("shell continues");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if String::from_utf8_lossy(&output.lock().unwrap()).contains("43 101") {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("resized size appears");
        handle.close().await.expect("owned child tree closes");
        handle.close().await.expect("second close is idempotent");
        assert!(handle.write(b"late".to_vec()).await.is_err());
    }

    #[tokio::test]
    async fn cleanup_failure_reports_one_unknown_exit_and_preserves_close_error() {
        let _serial = REAL_PTY_TEST.lock().await;
        let (exit_tx, exit_rx) = oneshot::channel();
        let exit_tx = Arc::new(Mutex::new(Some(exit_tx)));
        let exits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let recorded = Arc::clone(&exits);
        let mut request = PtyRequest::new("/bin/sh", ["-c", "exit 0"], 80, 24);
        request.fail_cleanup = true;
        let handle = DefaultPtySpawner
            .spawn(
                request,
                Arc::new(AlwaysAllow),
                Arc::new(|_| {}),
                Arc::new(move |exit| {
                    recorded.fetch_add(1, Ordering::AcqRel);
                    if let Some(sender) = exit_tx.lock().unwrap().take() {
                        let _ = sender.send(exit);
                    }
                }),
            )
            .await
            .expect("PTY starts");
        let error = tokio::time::timeout(Duration::from_secs(5), handle.close())
            .await
            .expect("cleanup completes")
            .expect_err("cleanup failure is preserved");
        assert!(error.to_string().contains("injected PTY cleanup failure"));
        let exit = tokio::time::timeout(Duration::from_secs(5), exit_rx)
            .await
            .expect("cleanup failure publishes exit")
            .expect("exit callback runs");
        assert_eq!(
            exit,
            PtyExit {
                code: None,
                signal: None
            }
        );
        assert_eq!(exits.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn closing_interactive_shell_kills_background_job_groups() {
        let _serial = REAL_PTY_TEST.lock().await;
        let output = Arc::new(Mutex::new(Vec::new()));
        let collected = Arc::clone(&output);
        let request = PtyRequest::new("/bin/bash", ["-i"], 80, 24);
        let handle = DefaultPtySpawner
            .spawn(
                request,
                Arc::new(AlwaysAllow),
                Arc::new(move |chunk| collected.lock().unwrap().extend(chunk)),
                Arc::new(|_| {}),
            )
            .await
            .expect("interactive shell starts");
        handle
            .write(b"set +H; printf 'HISTORY_READY:%s\\n' $$\n".to_vec())
            .await
            .expect("history expansion is disabled before using $!");
        let history_ready = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let text = String::from_utf8_lossy(&output.lock().unwrap()).into_owned();
                if background_pid(&text, "HISTORY_READY:") == Some(handle.pid() as i32) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        if history_ready.is_err() {
            let captured = String::from_utf8_lossy(&output.lock().unwrap()).into_owned();
            let close = tokio::time::timeout(Duration::from_secs(15), handle.close()).await;
            panic!("shell did not disable history expansion; output={captured:?}; close={close:?}");
        }
        handle
            .write(b"sleep 60 & echo BG1:$!; (trap '' HUP; sleep 60) & echo BG2:$!\n".to_vec())
            .await
            .expect("jobs start");
        let pids = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let text = String::from_utf8_lossy(&output.lock().unwrap()).into_owned();
                if let (Some(first), Some(second)) =
                    (background_pid(&text, "BG1:"), background_pid(&text, "BG2:"))
                {
                    break [first, second];
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        let pids = match pids {
            Ok(pids) => pids,
            Err(_) => {
                let captured = String::from_utf8_lossy(&output.lock().unwrap()).into_owned();
                let close = tokio::time::timeout(Duration::from_secs(15), handle.close()).await;
                panic!(
                    "shell did not report both background job PIDs; output={captured:?}; close={close:?}"
                );
            }
        };
        let jobs_started = pids.iter().all(|pid| process_running(*pid));
        let separate_from_shell = pids
            .iter()
            .all(|pid| process_group(*pid) != Some(handle.pid() as i32));
        let separate_jobs = process_group(pids[0]) != process_group(pids[1]);
        let close = tokio::time::timeout(Duration::from_secs(5), handle.close()).await;
        let survivors = pids
            .into_iter()
            .filter(|pid| process_running(*pid))
            .collect::<Vec<_>>();
        for pid in &survivors {
            let _ = std::process::Command::new("kill")
                .args(["-KILL", &pid.to_string()])
                .status();
        }
        close
            .expect("terminal closes")
            .expect("owned tree cleanup completes");
        assert!(jobs_started, "both jobs must be running before close");
        assert!(
            separate_from_shell && separate_jobs,
            "jobs must have their own process groups"
        );
        assert!(
            survivors.is_empty(),
            "background jobs survived close: {survivors:?}"
        );
    }

    fn background_pid(output: &str, marker: &str) -> Option<libc::pid_t> {
        output
            .split(marker)
            .skip(1)
            .filter_map(|text| {
                text.chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
                    .parse()
                    .ok()
            })
            .next()
    }

    fn process_running(pid: libc::pid_t) -> bool {
        let output = std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "stat="])
            .output()
            .expect("ps inspects the test child");
        let state = String::from_utf8_lossy(&output.stdout);
        output.status.success() && !state.trim().is_empty() && !state.trim().starts_with('Z')
    }

    fn process_group(pid: libc::pid_t) -> Option<libc::pid_t> {
        let output = std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "pgid="])
            .output()
            .expect("ps inspects the test job group");
        String::from_utf8_lossy(&output.stdout).trim().parse().ok()
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tokio::sync::oneshot;

    use super::{DefaultPtySpawner, PtyExit, PtyRequest, PtySpawner};
    use crate::subprocess::AlwaysAllow;

    #[tokio::test]
    async fn conpty_runs_inside_an_owned_job_and_reports_output_and_exit() {
        let output = Arc::new(Mutex::new(Vec::new()));
        let collected = Arc::clone(&output);
        let (exit_tx, exit_rx) = oneshot::channel();
        let exit_tx = Arc::new(Mutex::new(Some(exit_tx)));
        let request = PtyRequest::new("cmd.exe", ["/C", "echo CONPTY_READY"], 80, 24);
        let handle = DefaultPtySpawner
            .spawn(
                request,
                Arc::new(AlwaysAllow),
                Arc::new(move |chunk| collected.lock().unwrap().extend(chunk)),
                Arc::new(move |exit: PtyExit| {
                    if let Some(sender) = exit_tx.lock().unwrap().take() {
                        let _ = sender.send(exit);
                    }
                }),
            )
            .await
            .expect("ConPTY starts");
        assert!(handle.pid() > 0);
        let exit = tokio::time::timeout(Duration::from_secs(10), exit_rx)
            .await
            .expect("ConPTY child exits")
            .expect("exit callback runs");
        assert_eq!(exit.code, Some(0));
        assert!(String::from_utf8_lossy(&output.lock().unwrap()).contains("CONPTY_READY"));
        handle.close().await.expect("Job cleanup is observed");
    }

    #[tokio::test]
    async fn conpty_accepts_input_and_resize_then_closes_the_job() {
        let output = Arc::new(Mutex::new(Vec::new()));
        let collected = Arc::clone(&output);
        let (exit_tx, exit_rx) = oneshot::channel();
        let exit_tx = Arc::new(Mutex::new(Some(exit_tx)));
        let request = PtyRequest::new("cmd.exe", ["/Q", "/K"], 80, 24);
        let handle = DefaultPtySpawner
            .spawn(
                request,
                Arc::new(AlwaysAllow),
                Arc::new(move |chunk| collected.lock().unwrap().extend(chunk)),
                Arc::new(move |exit: PtyExit| {
                    if let Some(sender) = exit_tx.lock().unwrap().take() {
                        let _ = sender.send(exit);
                    }
                }),
            )
            .await
            .expect("interactive ConPTY starts");
        handle.resize(101, 43).await.expect("ConPTY resizes");
        handle
            .write(b"echo INPUT_READY\r".to_vec())
            .await
            .expect("input reaches ConPTY");
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if String::from_utf8_lossy(&output.lock().unwrap()).contains("INPUT_READY") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("input echo appears");
        tokio::time::timeout(Duration::from_secs(10), handle.close())
            .await
            .expect("Job cleanup finishes")
            .expect("Job cleanup succeeds");
        tokio::time::timeout(Duration::from_secs(10), exit_rx)
            .await
            .expect("close reports exit")
            .expect("exit callback runs");
    }
}
