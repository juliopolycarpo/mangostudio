//! Guardian- or Job-owned stdio MCP servers.
//!
//! A stdio server is a child of this runtime, so it is launched exactly like every other child:
//! a fresh consent check runs immediately before the OS effect, the target is held behind the
//! platform start gate until that check has passed, and one owner task keeps the child until its
//! whole tree is gone. The SDK only ever sees the two pipe ends ([`OwnedStdio::stdin`] and
//! [`OwnedStdio::stdout`]); closing the SDK transport is not cleanup, [`ProcessOwner::close`] is.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use mango_protocol::error::RemoteError;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::blocking::run_blocking;
use crate::release::{EOF_CUTOFF, Owner, PROOF_CUTOFF, Release, TERM_CUTOFF};
use crate::subprocess::{LaunchCheck, PipeChild, ProcessRequest};

/// Process-wide ceiling on live stdio MCP servers.
///
/// Separate from the bounded-command pool on purpose: an MCP server lives as long as its session,
/// and drawing from the four command slots would let a few sessions starve git, shell and probes.
pub(crate) const MAX_MCP_CHILDREN: usize = 64;
/// Grace after stdin closes before the tree is asked to stop, matching the TypeScript SDK's
/// `StdioClientTransport.close`.
const EOF_GRACE: Duration = Duration::from_secs(2);
/// Grace after SIGTERM before the tree is killed, matching the same SDK close sequence.
const TERM_GRACE: Duration = Duration::from_secs(2);
/// Bound on waiting for the platform owner to prove the tree empty; see the supervisor's own
/// `CLEANUP_TIMEOUT` for why this cannot be unbounded.
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);

type Reader = Box<dyn AsyncRead + Send + Unpin>;
type Writer = Box<dyn AsyncWrite + Send + Unpin>;
/// Object-safe future returned by [`StdioSpawner`].
pub(crate) type StartFuture<'a> =
    Pin<Box<dyn Future<Output = Result<OwnedStdio, StartError>> + Send + 'a>>;

/// Exact argv and environment for one stdio server. The environment is complete: nothing is
/// inherited beyond what the caller put here.
#[derive(Clone, Debug)]
pub(crate) struct StdioLaunch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

/// Why no stdio server is running.
#[derive(Debug)]
pub(crate) enum StartError {
    /// Cancellation won before the target could execute.
    Cancelled,
    /// The fresh consent check refused the still-unstarted child.
    LaunchDenied(RemoteError),
    /// Every stdio MCP slot is in use.
    LimitExceeded,
    /// The operating system refused the launch.
    Spawn(io::Error),
    /// The owner task ended before it reported a result.
    Unavailable,
}

/// A started server: its two protocol pipes plus the owner of its process tree.
pub(crate) struct OwnedStdio {
    pub stdin: Writer,
    pub stdout: Reader,
    pub process: ProcessOwner,
}

/// Handle to the task that owns one server's tree. Cloning or dropping it never releases the
/// child; only [`Self::close`] or the target's own exit ends ownership.
#[derive(Clone, Debug)]
pub(crate) struct ProcessOwner {
    close: CancellationToken,
    terminal: watch::Receiver<Option<Result<(), String>>>,
}

impl ProcessOwner {
    /// Stops the tree and waits until its owner has proven it gone.
    ///
    /// The target first gets [`EOF_GRACE`] to exit on its own (the caller has already dropped
    /// stdin), then SIGTERM and [`TERM_GRACE`], then a forced tree kill. Concurrent and repeated
    /// callers all await the one owner and receive its single result.
    ///
    /// # Example
    /// ```ignore
    /// drop(owned.stdin);
    /// owned.process.close().await?;
    /// ```
    pub(crate) async fn close(&self) -> Result<(), String> {
        self.close.cancel();
        self.exited().await
    }

    /// Resolves once the tree has been cleaned up, whether it exited or was stopped.
    pub(crate) async fn exited(&self) -> Result<(), String> {
        let mut terminal = self.terminal.clone();
        loop {
            if let Some(result) = terminal.borrow().as_ref() {
                return result.clone();
            }
            if terminal.changed().await.is_err() {
                return Err("the MCP process owner stopped without a cleanup record".to_owned());
            }
        }
    }
}

/// Starts owned stdio servers. Tests implement this with named fakes.
pub(crate) trait StdioSpawner: Send + Sync {
    /// Launches `launch` after `check` passes. `cancel` only affects the start: once this
    /// returns a server, stopping it is [`ProcessOwner::close`]'s job.
    fn start(
        &self,
        launch: StdioLaunch,
        check: Arc<dyn LaunchCheck>,
        cancel: CancellationToken,
    ) -> StartFuture<'_>;
}

/// Production spawner over the Unix guardian or Windows kill-on-close Job.
///
/// # Example
/// ```ignore
/// let owned = GuardedStdioSpawner::default().start(launch, check, cancel).await?;
/// ```
pub(crate) struct GuardedStdioSpawner {
    pool: Arc<Semaphore>,
    /// The shutdown tracker each owner reports to and whose cut-offs bound its stop.
    release: &'static Release,
}

impl Default for GuardedStdioSpawner {
    fn default() -> Self {
        static POOL: OnceLock<Arc<Semaphore>> = OnceLock::new();
        Self {
            pool: Arc::clone(POOL.get_or_init(|| Arc::new(Semaphore::new(MAX_MCP_CHILDREN)))),
            release: Release::process(),
        }
    }
}

impl GuardedStdioSpawner {
    /// A spawner whose owners report to `release` instead of the process-wide tracker, so a test
    /// can begin its own shutdown without stopping every other test's servers.
    #[cfg(all(test, unix))]
    fn with_release(release: &'static Release) -> Self {
        Self {
            release,
            ..Self::default()
        }
    }
}

impl StdioSpawner for GuardedStdioSpawner {
    fn start(
        &self,
        launch: StdioLaunch,
        check: Arc<dyn LaunchCheck>,
        cancel: CancellationToken,
    ) -> StartFuture<'_> {
        let permit = Arc::clone(&self.pool).try_acquire_owned();
        let release = self.release;
        Box::pin(async move {
            let permit = permit.map_err(|_| StartError::LimitExceeded)?;
            let (ready_tx, ready_rx) = oneshot::channel();
            let start_cancel = cancel.child_token();
            // Dropping this future before a result arrives abandons the start, never the child:
            // the owner task sees the cancellation and cleans up whatever it already launched.
            let abandon = start_cancel.clone().drop_guard();
            let owner = release.own();
            tokio::spawn(own(
                launch,
                check,
                start_cancel.clone(),
                ready_tx,
                (permit, owner, release),
            ));
            let result = ready_rx.await.unwrap_or(Err(StartError::Unavailable));
            let _ = abandon.disarm();
            result
        })
    }
}

async fn own(
    launch: StdioLaunch,
    check: Arc<dyn LaunchCheck>,
    cancel: CancellationToken,
    ready: oneshot::Sender<Result<OwnedStdio, StartError>>,
    (_permit, _owner, tracker): (OwnedSemaphorePermit, Owner, &'static Release),
) {
    let mut request =
        ProcessRequest::new(launch.program, launch.args.into_iter().map(OsString::from));
    request.env = Some(
        launch
            .env
            .into_iter()
            .map(|(key, value)| (OsString::from(key), OsString::from(value)))
            .collect(),
    );
    let spawn_cancel = cancel.clone();
    let spawned = run_blocking(move || {
        if spawn_cancel.is_cancelled() {
            return Err(StartError::Cancelled);
        }
        check.check().map_err(StartError::LaunchDenied)?;
        if spawn_cancel.is_cancelled() {
            return Err(StartError::Cancelled);
        }
        PipeChild::spawn(&request).map_err(StartError::Spawn)
    })
    .await;
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    if let Err(error) = release(&mut child, &cancel).await {
        child.abort_start();
        let _ = cleanup(child, None, tracker).await;
        let _ = ready.send(Err(error));
        return;
    }
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.take_stdin(), child.take_stdout(), child.take_stderr())
    else {
        let _ = cleanup(child, None, tracker).await;
        let _ = ready.send(Err(StartError::Spawn(io::Error::other(
            "the MCP server started without its three stdio pipes",
        ))));
        return;
    };
    // A server that writes diagnostics would block on a full stderr pipe. The TypeScript host
    // discards stderr (`stderr: 'ignore'`); this drains and discards it for the same reason.
    let drain = tokio::spawn(discard(stderr));
    let close = CancellationToken::new();
    let (terminal_tx, terminal_rx) = watch::channel(None);
    let owned = OwnedStdio {
        stdin,
        stdout,
        process: ProcessOwner {
            close: close.clone(),
            terminal: terminal_rx,
        },
    };
    if ready.send(Ok(owned)).is_err() {
        close.cancel();
    }
    let result = run(child, &close, tracker).await;
    drain.abort();
    let _ = terminal_tx.send(Some(result));
}

async fn release(child: &mut PipeChild, cancel: &CancellationToken) -> Result<(), StartError> {
    tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(StartError::Cancelled),
        ready = child.wait_ready() => ready.map_err(StartError::Spawn)?,
    }
    if cancel.is_cancelled() {
        return Err(StartError::Cancelled);
    }
    child.release_start().map_err(StartError::Spawn)?;
    // Past the release byte the target may already be executing: cancellation can no longer
    // retract the launch, so the caller receives the server and closes it explicitly.
    child.wait_exec().await.map_err(StartError::Spawn)
}

/// Owns a running server until it exits or a close is requested, then proves the tree gone.
///
/// Process shutdown past [`EOF_CUTOFF`] counts as a close request too: a server whose session
/// nobody closed (a connect that landed during teardown) is still stopped inside the budget.
async fn run(
    mut child: PipeChild,
    close: &CancellationToken,
    release: &Release,
) -> Result<(), String> {
    let exited = tokio::select! {
        status = child.wait_target() => Some(status),
        () = close.cancelled() => None,
        () = release.cutoff(EOF_CUTOFF) => None,
    };
    let exited = match exited {
        Some(status) => Some(status),
        None => stop(&mut child, release).await,
    };
    cleanup(child, exited, release).await
}

/// EOF grace, SIGTERM grace, then a forced tree kill; returns the target status once seen.
///
/// Once process shutdown has begun, each grace also ends at its shutdown cut-off
/// ([`EOF_CUTOFF`], [`TERM_CUTOFF`]), so every server's stop fits the Hub's window however late
/// it started; see [`crate::release`] for the arithmetic.
async fn stop(
    child: &mut PipeChild,
    release: &Release,
) -> Option<io::Result<std::process::ExitStatus>> {
    if let Some(status) = wait_within(child, EOF_GRACE, EOF_CUTOFF, release).await {
        return Some(status);
    }
    if child.interrupt().is_ok()
        && let Some(status) = wait_within(child, TERM_GRACE, TERM_CUTOFF, release).await
    {
        return Some(status);
    }
    None
}

/// Waits for the target to exit, for at most `grace` or until the shutdown `cutoff`.
async fn wait_within(
    child: &mut PipeChild,
    grace: Duration,
    cutoff: Duration,
    release: &Release,
) -> Option<io::Result<std::process::ExitStatus>> {
    tokio::select! {
        status = child.wait_target() => Some(status),
        () = tokio::time::sleep(grace) => None,
        () = release.cutoff(cutoff) => None,
    }
}

/// Forces whatever is left of the tree, acknowledges final cleanup, and waits for the owner's
/// empty-tree proof. Every exit path runs this exactly once.
///
/// Once process shutdown has begun, both waits also end at [`PROOF_CUTOFF`], so the owner
/// reports released inside the shutdown budget; a proof still missing then is left to the
/// guardian or Job lease, which ends the tree with the process.
async fn cleanup(
    mut child: PipeChild,
    exited: Option<io::Result<std::process::ExitStatus>>,
    release: &Release,
) -> Result<(), String> {
    let forced = child.force();
    if exited.is_none() {
        let _ = within_cleanup_bound(child.wait_target(), release).await;
    }
    let finalized = child.finalize();
    let tree = within_cleanup_bound(child.wait_tree(), release).await;
    run_blocking(move || drop(child)).await;
    match tree {
        Some(Ok(())) => {}
        Some(Err(error)) => {
            return Err(format!("MCP server process tree cleanup failed: {error}"));
        }
        None => {
            return Err(format!(
                "MCP server process tree did not report empty within {CLEANUP_TIMEOUT:?} or \
                 the shutdown budget"
            ));
        }
    }
    // A forced kill that found the group already gone is the ordinary case after a natural exit.
    let _ = forced;
    finalized.map_err(|error| format!("MCP server final cleanup acknowledgement failed: {error}"))
}

/// `wait`, for at most [`CLEANUP_TIMEOUT`] or until the shutdown [`PROOF_CUTOFF`].
async fn within_cleanup_bound<T>(wait: impl Future<Output = T>, release: &Release) -> Option<T> {
    tokio::select! {
        result = wait => Some(result),
        () = tokio::time::sleep(CLEANUP_TIMEOUT) => None,
        () = release.cutoff(PROOF_CUTOFF) => None,
    }
}

async fn discard(mut stderr: Reader) {
    let mut buffer = [0_u8; 8 * 1024];
    while matches!(stderr.read(&mut buffer).await, Ok(read) if read > 0) {}
}

#[cfg(all(test, unix))]
mod tests {
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};

    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    use super::*;
    use crate::subprocess::AlwaysAllow;
    use crate::test_support::scratch_dir;

    fn launch(script: &Path) -> StdioLaunch {
        StdioLaunch {
            program: script.to_path_buf(),
            args: vec![],
            env: BTreeMap::from([("PATH".to_owned(), "/usr/bin:/bin".to_owned())]),
        }
    }

    fn script(directory: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = directory.join("server.sh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("script is written");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .expect("script is executable");
        path
    }

    fn pid_from(path: &Path) -> i32 {
        std::fs::read_to_string(path)
            .unwrap_or_else(|error| {
                panic!("expected pid file {} | received {error}", path.display())
            })
            .trim()
            .parse()
            .expect("pid files hold one decimal pid")
    }

    fn alive(pid: i32) -> bool {
        !matches!(
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
            Err(nix::errno::Errno::ESRCH)
        )
    }

    async fn wait_for(path: &Path) {
        for _ in 0..500 {
            if path.exists() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "expected {} to be written | received no file",
            path.display()
        );
    }

    async fn start(launch: StdioLaunch) -> OwnedStdio {
        GuardedStdioSpawner::default()
            .start(launch, Arc::new(AlwaysAllow), CancellationToken::new())
            .await
            .unwrap_or_else(|error| panic!("expected a started server | received {error:?}"))
    }

    #[tokio::test]
    async fn stdin_stays_open_and_round_trips_protocol_lines() {
        let directory = scratch_dir("mcp-process-echo");
        let owned = start(launch(&script(&directory, "exec cat"))).await;
        let OwnedStdio {
            mut stdin,
            stdout,
            process,
        } = owned;
        let mut lines = BufReader::new(stdout).lines();
        for message in ["first", "second"] {
            stdin
                .write_all(format!("{message}\n").as_bytes())
                .await
                .expect("stdin accepts a line");
            stdin.flush().await.expect("stdin flushes");
            let echoed = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
                .await
                .expect("the echo arrives within five seconds")
                .expect("stdout is readable");
            assert_eq!(echoed.as_deref(), Some(message), "expected the echoed line");
        }
        drop(stdin);
        assert_eq!(process.close().await, Ok(()));
    }

    #[tokio::test]
    async fn close_returns_only_after_every_descendant_is_gone() {
        let directory = scratch_dir("mcp-process-tree");
        let target = directory.join("target.pid");
        let descendant = directory.join("descendant.pid");
        // Ignoring SIGTERM forces the close past both graces into the tree kill.
        let body = format!(
            "trap '' TERM\necho $$ > {}\nsleep 30 & echo $! > {}\nwhile :; do sleep 1; done",
            target.display(),
            descendant.display()
        );
        let owned = start(launch(&script(&directory, &body))).await;
        wait_for(&target).await;
        wait_for(&descendant).await;
        drop(owned.stdin);
        assert_eq!(owned.process.close().await, Ok(()));
        for (name, pid) in [
            ("target", pid_from(&target)),
            ("descendant", pid_from(&descendant)),
        ] {
            assert!(
                !alive(pid),
                "expected {name} pid {pid} gone when close returned | received a live process"
            );
        }
    }

    /// A shutdown tracker of the test's own, so beginning shutdown here stops only this test's
    /// servers.
    fn isolated_release() -> &'static Release {
        Box::leak(Box::new(Release::new()))
    }

    #[tokio::test]
    async fn an_owner_nobody_closed_stops_gracefully_at_the_shutdown_cutoff() {
        let directory = scratch_dir("mcp-process-orphan");
        let ready = directory.join("ready");
        let log = directory.join("stop.log");
        // Stdin stays open (the orphaned client still holds it), so only the owner's own
        // shutdown cut-off can ask this server to stop; it leaves cleanly on SIGTERM.
        let body = format!(
            "trap 'echo term >> {log}; exit 0' TERM\necho ready > {ready}\nwhile :; do sleep 0.05; done",
            log = log.display(),
            ready = ready.display()
        );
        let release = isolated_release();
        let owned = GuardedStdioSpawner::with_release(release)
            .start(
                launch(&script(&directory, &body)),
                Arc::new(AlwaysAllow),
                CancellationToken::new(),
            )
            .await
            .unwrap_or_else(|error| panic!("expected a started server | received {error:?}"));
        wait_for(&ready).await;

        release.begin();
        let bound = EOF_CUTOFF + Duration::from_millis(1_500);
        let exited = tokio::time::timeout(bound, owned.process.exited()).await;

        assert_eq!(
            exited,
            Ok(Ok(())),
            "expected the unclosed owner to stop its server within {bound:?} of shutdown \
             beginning | received {exited:?}"
        );
        let stopped = std::fs::read_to_string(&log).unwrap_or_default();
        assert_eq!(
            stopped.trim(),
            "term",
            "expected the server to record a graceful SIGTERM | received {stopped:?}"
        );
        drop(owned.stdin);
    }

    #[tokio::test]
    async fn a_stubborn_tree_is_proven_gone_inside_the_shutdown_budget() {
        let directory = scratch_dir("mcp-process-stubborn-budget");
        let target = directory.join("target.pid");
        let descendant = directory.join("descendant.pid");
        // Ignores end of input and SIGTERM, with a descendant: only the forced tree kill ends it.
        let body = format!(
            "trap '' TERM\necho $$ > {}\nsleep 30 & echo $! > {}\nwhile :; do sleep 1; done",
            target.display(),
            descendant.display()
        );
        let release = isolated_release();
        let owned = GuardedStdioSpawner::with_release(release)
            .start(
                launch(&script(&directory, &body)),
                Arc::new(AlwaysAllow),
                CancellationToken::new(),
            )
            .await
            .unwrap_or_else(|error| panic!("expected a started server | received {error:?}"));
        wait_for(&target).await;
        wait_for(&descendant).await;

        let started = tokio::time::Instant::now();
        release.begin();
        drop(owned.stdin);
        let closing = tokio::spawn({
            let process = owned.process.clone();
            async move { process.close().await }
        });
        let released = release.released().await;
        let took = started.elapsed();

        assert!(
            released && took < crate::release::SHUTDOWN_BUDGET,
            "expected every owner released within {:?} | received released: {released} after \
             {took:?}",
            crate::release::SHUTDOWN_BUDGET
        );
        assert_eq!(
            closing.await.expect("the close task completes"),
            Ok(()),
            "expected the empty-tree proof to complete, not be cut off"
        );
        for (name, pid) in [
            ("target", pid_from(&target)),
            ("descendant", pid_from(&descendant)),
        ] {
            assert!(
                !alive(pid),
                "expected {name} pid {pid} gone once released | received a live process"
            );
        }
    }

    #[tokio::test]
    async fn concurrent_closes_share_one_owner_result() {
        let directory = scratch_dir("mcp-process-concurrent-close");
        let owned = start(launch(&script(&directory, "exec sleep 30"))).await;
        let first = owned.process.clone();
        let second = owned.process.clone();
        let (left, right) = tokio::join!(first.close(), second.close());
        assert_eq!((left, right), (Ok(()), Ok(())));
        assert_eq!(
            owned.process.close().await,
            Ok(()),
            "a repeated close is idempotent"
        );
    }

    #[tokio::test]
    async fn a_server_that_exits_on_its_own_still_publishes_its_cleanup() {
        let directory = scratch_dir("mcp-process-exit");
        let owned = start(launch(&script(&directory, "exit 3"))).await;
        let exited = tokio::time::timeout(Duration::from_secs(5), owned.process.exited()).await;
        assert_eq!(
            exited.expect("expected the exit to be observed within five seconds"),
            Ok(())
        );
    }

    #[tokio::test]
    async fn a_flooded_stderr_never_blocks_protocol_output() {
        let directory = scratch_dir("mcp-process-stderr");
        // Four MiB of stderr is far past any pipe buffer; stdout only follows once it is drained.
        let body = "head -c 4194304 /dev/zero >&2\necho ready\nexec sleep 30";
        let owned = start(launch(&script(&directory, body))).await;
        let mut lines = BufReader::new(owned.stdout).lines();
        let line = tokio::time::timeout(Duration::from_secs(10), lines.next_line())
            .await
            .expect("expected stdout within ten seconds | received a server blocked on stderr")
            .expect("stdout is readable");
        assert_eq!(line.as_deref(), Some("ready"));
        drop(owned.stdin);
        assert_eq!(owned.process.close().await, Ok(()));
    }

    struct CancellingCheck(CancellationToken);

    impl LaunchCheck for CancellingCheck {
        fn check(&self) -> Result<(), RemoteError> {
            self.0.cancel();
            Ok(())
        }
    }

    #[tokio::test]
    async fn cancellation_during_the_launch_check_never_executes_the_server() {
        let directory = scratch_dir("mcp-process-cancel");
        let marker = directory.join("ran");
        let body = format!("touch {}\nexec sleep 30", marker.display());
        let cancel = CancellationToken::new();
        let result = GuardedStdioSpawner::default()
            .start(
                launch(&script(&directory, &body)),
                Arc::new(CancellingCheck(cancel.clone())),
                cancel,
            )
            .await;
        assert!(
            matches!(result, Err(StartError::Cancelled)),
            "expected StartError::Cancelled | received {:?}",
            result.as_ref().map(|_| "a started server")
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!marker.exists(), "expected the server never to execute");
    }

    struct DenyingCheck(AtomicBool);

    impl LaunchCheck for DenyingCheck {
        fn check(&self) -> Result<(), RemoteError> {
            self.0.store(true, Ordering::SeqCst);
            Err(RemoteError::new(
                mango_protocol::error::codes::DENIED,
                "mcp consent was revoked",
            ))
        }
    }

    #[tokio::test]
    async fn a_refused_launch_check_reports_its_wire_error_unchanged() {
        let directory = scratch_dir("mcp-process-denied");
        let check = Arc::new(DenyingCheck(AtomicBool::new(false)));
        let result = GuardedStdioSpawner::default()
            .start(
                launch(&script(&directory, "exec sleep 30")),
                Arc::clone(&check) as Arc<dyn LaunchCheck>,
                CancellationToken::new(),
            )
            .await;
        match result {
            Err(StartError::LaunchDenied(error)) => {
                assert_eq!(error.message, "mcp consent was revoked");
            }
            other => panic!(
                "expected StartError::LaunchDenied | received {:?}",
                other.map(|_| "a started server")
            ),
        }
        assert!(check.0.load(Ordering::SeqCst), "expected the check to run");
    }

    #[tokio::test]
    async fn a_full_pool_refuses_instead_of_queueing() {
        let directory = scratch_dir("mcp-process-pool");
        let spawner = GuardedStdioSpawner {
            pool: Arc::new(Semaphore::new(1)),
            ..GuardedStdioSpawner::default()
        };
        let first = spawner
            .start(
                launch(&script(&directory, "exec sleep 30")),
                Arc::new(AlwaysAllow),
                CancellationToken::new(),
            )
            .await
            .expect("the first server takes the only slot");
        let second = spawner
            .start(
                launch(&script(&directory, "exec sleep 30")),
                Arc::new(AlwaysAllow),
                CancellationToken::new(),
            )
            .await;
        assert!(
            matches!(second, Err(StartError::LimitExceeded)),
            "expected StartError::LimitExceeded | received a second server"
        );
        drop(first.stdin);
        assert_eq!(first.process.close().await, Ok(()));
        let third = spawner
            .start(
                launch(&script(&directory, "exec sleep 30")),
                Arc::new(AlwaysAllow),
                CancellationToken::new(),
            )
            .await
            .expect("a closed server returns its slot");
        drop(third.stdin);
        assert_eq!(third.process.close().await, Ok(()));
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use crate::subprocess::AlwaysAllow;

    /// How long the `.cmd` shim below may take to run its recorder and exit.
    const SHIM_EXIT_TIMEOUT: Duration = Duration::from_secs(120);

    /// A `.cmd` shim resolved like `npx` receives shell syntax as literal text through `%*`, and
    /// an argument cmd.exe cannot quote is refused before anything runs (BatBadBut).
    #[tokio::test]
    async fn a_cmd_shim_receives_shell_syntax_literally_and_unquotable_arguments_are_refused() {
        use crate::mcp::stdio::{child_env, resolve_windows_program};

        let directory = crate::test_support::scratch_dir("mcp-cmd-shim");
        let output = directory.join("argv.json");
        let injected = directory.join("injected.txt");
        std::fs::write(
            directory.join("argv.mjs"),
            "import { writeFileSync } from 'node:fs';\n\
             writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n",
        )
        .expect("the argv recorder is written");
        std::fs::write(
            directory.join("run.cmd"),
            "@\"bun\" \"%~dp0argv.mjs\" %*\r\n",
        )
        .expect("the shim is written");
        let mut env = child_env(
            &crate::config::ProcessEnv,
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        env.insert("ARGV_OUT".into(), output.to_string_lossy().into_owned());
        let program = resolve_windows_program(
            "run",
            Some(&directory.to_string_lossy()),
            None,
            &|candidate| candidate.is_file(),
        )
        .expect("the shim resolves through PATHEXT");
        let tricky = format!("a&b|c<d>e^f(g) & echo x> {}", injected.display());
        let args = vec![tricky.clone(), "two words".to_owned(), "!x!".to_owned()];
        let owned = GuardedStdioSpawner::default()
            .start(
                StdioLaunch {
                    program: program.clone(),
                    args: args.clone(),
                    env: env.clone(),
                },
                Arc::new(AlwaysAllow),
                CancellationToken::new(),
            )
            .await
            .unwrap_or_else(|error| panic!("expected the shim to start | received {error:?}"));
        drop(owned.stdin);
        // The recorder writes its file before it exits, so the file is read only once the shim
        // has exited and its tree is gone. The bound is generous because the shim is cmd.exe
        // starting `bun`, and an interpreter cold start on a loaded Windows runner can stall
        // for tens of seconds.
        let exited = tokio::time::timeout(SHIM_EXIT_TIMEOUT, owned.process.exited()).await;
        assert!(
            matches!(exited, Ok(Ok(()))),
            "expected the shim to exit and its tree to be cleaned up within \
             {SHIM_EXIT_TIMEOUT:?} | received {exited:?}"
        );
        let received: Vec<String> = serde_json::from_str(
            &std::fs::read_to_string(&output).expect("the shim recorded its arguments"),
        )
        .expect("the recorded arguments are JSON");
        assert_eq!(
            received, args,
            "expected every argument delivered literally"
        );
        assert!(
            !injected.exists(),
            "expected no command injected through cmd.exe"
        );

        let refused = GuardedStdioSpawner::default()
            .start(
                StdioLaunch {
                    program,
                    args: vec!["100%\"&calc".to_owned()],
                    env,
                },
                Arc::new(AlwaysAllow),
                CancellationToken::new(),
            )
            .await;
        match refused {
            Err(StartError::Spawn(error)) => {
                assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
                assert!(
                    error.to_string().contains("argument 0 contains"),
                    "expected the refused argument named | received {error}"
                );
            }
            other => panic!(
                "expected StartError::Spawn(InvalidInput) | received {:?}",
                other.map(|_| "a started shim")
            ),
        }
    }

    /// A long-lived stdio server inside the kill-on-close Job: close must return after the Job
    /// has terminated it, well before the child would have exited on its own.
    #[tokio::test]
    async fn close_terminates_a_job_owned_server_and_awaits_its_cleanup() {
        let launch = StdioLaunch {
            program: PathBuf::from("cmd.exe"),
            args: vec!["/d".into(), "/c".into(), "ping -n 60 127.0.0.1 >nul".into()],
            env: BTreeMap::from([("SystemRoot".to_owned(), "C:\\Windows".to_owned())]),
        };
        let owned = GuardedStdioSpawner::default()
            .start(launch, Arc::new(AlwaysAllow), CancellationToken::new())
            .await
            .unwrap_or_else(|error| panic!("expected a Job-owned server | received {error:?}"));
        drop(owned.stdin);
        let started = std::time::Instant::now();
        assert_eq!(owned.process.close().await, Ok(()));
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "expected the Job to end the server promptly | received {:?}",
            started.elapsed()
        );
    }
}
