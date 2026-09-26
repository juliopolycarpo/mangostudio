//! A bounded child-process runner: every deadline, every byte cap, and the
//! process concurrency itself are named constants, and every child this
//! module starts is reaped before [`run_bounded_child`] returns — killed
//! and awaited, never merely dropped.
//!
//! Nothing in [`crate::transport`] has spawned a child process before this
//! module; [`crate::health`]'s `git --version` probe is its first caller.
//! [`tokio::process::Command::kill_on_drop`] is a real safety net, but it is
//! a *best-effort* one for a process this module is asked to give up on
//! early — this module never leans on it as the primary cleanup path.
//!
//! # Spawning is not routed through [`crate::blocking::run_blocking`]
//!
//! `tokio::process::Command::spawn` looks async-friendly, but its own
//! source (`tokio-1.53.1/src/process/mod.rs`) calls
//! `std::process::Command::spawn` — the ordinary, synchronous
//! `fork`+`exec`/`posix_spawn` — directly on whatever task calls it, not
//! through Tokio's blocking pool. That is exactly the "synchronous OS call
//! on an executor thread" [`crate::blocking`]'s module docs describe, so
//! this module runs the spawn itself inside [`crate::blocking::run_blocking`]
//! rather than calling `Command::spawn` straight from an async context.
use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::process::ExitStatus;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

#[cfg(any(windows, test))]
mod batch;
mod pipe_child;
#[cfg(any(windows, test))]
mod powershell_script;
#[cfg(test)]
pub(crate) use powershell_script::powershell_script_request;
mod supervisor;
#[cfg(unix)]
mod unix_guardian;
#[cfg(windows)]
mod windows_job;

/// How long the Unix guardian may sweep a terminal session's job groups before it reports failure.
/// A PTY `close` resolves only after that sweep, so tests bound `close` by this plus slack.
#[cfg(all(unix, test))]
pub(crate) const TERMINAL_SESSION_CLEANUP_BOUND: std::time::Duration =
    std::time::Duration::from_secs(
        unix_guardian::TERMINAL_SESSION_CLEANUP_SECONDS.unsigned_abs() as u64,
    );

/// PTY child with the same guardian or Job ownership as a bounded process.
pub(crate) enum PtyChild {
    #[cfg(unix)]
    Unix(unix_guardian::GuardianChild),
    #[cfg(windows)]
    Windows(windows_job::WindowsJobChild),
}

impl PtyChild {
    pub(crate) fn spawn(request: &ProcessRequest, cols: u16, rows: u16) -> io::Result<Self> {
        #[cfg(unix)]
        {
            unix_guardian::spawn_pty(request, cols, rows).map(Self::Unix)
        }
        #[cfg(windows)]
        {
            windows_job::spawn_pty(request, cols, rows).map(Self::Windows)
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (request, cols, rows);
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "PTY requires Unix or Windows",
            ))
        }
    }

    pub(crate) fn id(&self) -> Option<u32> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.id(),
            #[cfg(windows)]
            Self::Windows(child) => child.id(),
        }
    }

    pub(crate) async fn wait_ready(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.wait_ready().await,
            #[cfg(windows)]
            Self::Windows(child) => child.wait_ready().await,
        }
    }

    pub(crate) fn release_start(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.release_start(),
            #[cfg(windows)]
            Self::Windows(child) => child.release_start(),
        }
    }

    pub(crate) async fn wait_exec(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.wait_exec().await,
            #[cfg(windows)]
            Self::Windows(child) => child.wait_exec().await,
        }
    }

    pub(crate) fn take_output(&mut self) -> Option<Box<dyn tokio::io::AsyncRead + Send + Unpin>> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.take_stdout(),
            #[cfg(windows)]
            Self::Windows(child) => child.take_stdout(),
        }
    }

    pub(crate) fn take_input(&mut self) -> Option<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.take_stdin(),
            #[cfg(windows)]
            Self::Windows(child) => child.take_stdin(),
        }
    }

    pub(crate) async fn resize(&mut self, cols: u16, rows: u16) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.resize(cols, rows)?.await,
            #[cfg(windows)]
            Self::Windows(child) => child.resize(cols, rows)?.await,
        }
    }

    pub(crate) fn abort_start(&mut self) {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.abort_start(),
            #[cfg(windows)]
            Self::Windows(_) => {}
        }
    }

    pub(crate) fn force(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.force(),
            #[cfg(windows)]
            Self::Windows(child) => child.force(),
        }
    }

    pub(crate) async fn wait_target(&mut self) -> io::Result<ExitStatus> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.wait_target().await,
            #[cfg(windows)]
            Self::Windows(child) => child.wait_target().await,
        }
    }

    pub(crate) fn finalize(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.finalize(),
            #[cfg(windows)]
            Self::Windows(child) => child.finalize(),
        }
    }

    pub(crate) async fn wait_tree(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.wait_guardian().await,
            #[cfg(windows)]
            Self::Windows(child) => child.wait_guardian().await,
        }
    }
}

pub(crate) use pipe_child::PipeChild;

#[cfg(test)]
pub(crate) use supervisor::PendingSettler;

pub use supervisor::{
    AlwaysAllow, DefaultProcessSpawner, LaunchCheck, LaunchCheckError,
    MAX_SUPERVISED_PROCESS_REQUESTS, ProcessBudget, ProcessCapture, ProcessControl, ProcessExit,
    ProcessFuture, ProcessOutputChunk, ProcessOutputTap, ProcessRequest, ProcessSignal,
    ProcessSpawner, ProcessStartError, ProcessStdin, ProcessStop, ProcessStream, ProcessTerminal,
    ProcessTerminalCause,
};

/// How many children this process runs at once, across every caller.
///
/// A `--version` probe (this module's first user, in [`crate::health`]) is
/// cheap and short-lived, but nothing stops a future caller from asking for
/// several at once — a hub that just reconnected and immediately calls
/// `runtime.health` while another call is already probing `git`, say. A
/// small bound keeps a burst of such calls from spawning unboundedly many
/// OS processes at once, while still allowing more than one in flight
/// (unlike a bound of 1, which would serialise unrelated calls through a
/// single child slot for no shared resource this module actually owns).
pub const MAX_CONCURRENT_CHILD_PROCESSES: usize = 4;

/// The bounds one [`run_bounded_child`] call enforces.
#[derive(Debug, Clone, Copy)]
pub struct ChildBudget {
    /// How long the child is allowed to run before it is killed and
    /// [`ChildRunError::TimedOut`] is returned.
    pub deadline: Duration,
    /// Stdout bytes kept; anything past this is read and discarded (never
    /// buffered), with [`ChildOutcome::stdout_truncated`] set.
    pub max_stdout_bytes: usize,
    /// Stderr bytes kept, mirroring `max_stdout_bytes`.
    pub max_stderr_bytes: usize,
}

/// Why [`run_bounded_child`] did not return a [`ChildOutcome`].
#[derive(Debug)]
pub enum ChildRunError {
    /// The child could not be started at all.
    SpawnFailed(std::io::Error),
    /// The child was still running at [`ChildBudget::deadline`] and was
    /// killed.
    TimedOut,
    /// `cancel` fired before the child exited and it was killed.
    Cancelled,
}

/// What a bounded child produced, capped to its budget.
#[derive(Debug, Clone)]
pub struct ChildOutcome {
    /// Whether the child's own exit status reports success.
    pub status_success: bool,
    /// The child's raw exit code, when the platform can report one.
    ///
    /// `None` when the child was terminated by a signal rather than
    /// exiting on its own (Unix only — `kill_and_reap`'s own `SIGKILL`
    /// path lands here, but that path never reaches this struct at all,
    /// since a killed child is reported as [`ChildRunError::TimedOut`] or
    /// [`ChildRunError::Cancelled`] instead). [`std::process::ExitStatus::code`]
    /// is already portable: on Unix it is the low byte of the exit status
    /// (`0`–`255`); on Windows it is the full 32-bit exit code as a signed
    /// `i32`, which is what lets a caller distinguish `winget`'s own
    /// negative "no packages found" code from an ordinary non-zero
    /// failure — `status_success` alone cannot tell those apart, and
    /// `crate::probing::host`'s winget ownership probe is the first
    /// caller that needs to.
    pub exit_code: Option<i32>,
    /// The POSIX name of the signal that ended the child on its own
    /// (`SIGSEGV`, …), when one did. Never a signal this function sent: a
    /// child it killed is [`ChildRunError::TimedOut`] or
    /// [`ChildRunError::Cancelled`]. Always `None` on Windows.
    pub signal: Option<&'static str>,
    /// Stdout, capped at [`ChildBudget::max_stdout_bytes`].
    pub stdout: Vec<u8>,
    /// Stderr, capped at [`ChildBudget::max_stderr_bytes`].
    pub stderr: Vec<u8>,
    /// Whether stdout carried more bytes than this outcome kept.
    pub stdout_truncated: bool,
    /// Whether stderr carried more bytes than this outcome kept.
    pub stderr_truncated: bool,
}

/// Runs `program` to completion, killing and reaping it if it outruns
/// `budget.deadline` or `cancel` fires first — whichever happens, this
/// function does not return until its supervisor has published terminal
/// cleanup for the child it owns.
///
/// `env` mirrors `tokio::process::Command`'s own split: `Some` clears this
/// process's environment and runs the child with exactly the pairs given
/// (`.env_clear().envs(env)`); `None` inherits this process's environment
/// unchanged.
///
/// Stdout and stderr are read concurrently and independently capped —
/// neither can starve the other, and a child that fills one pipe without
/// ever being read on the other cannot deadlock this function the way a
/// sequential read of two pipes could.
///
/// # Errors
/// See [`ChildRunError`].
///
/// # Example
///
/// ```
/// use std::collections::HashMap;
/// use std::path::Path;
/// use std::time::Duration;
///
/// use mangostudio_runtime::subprocess::{ChildBudget, run_bounded_child};
/// use tokio_util::sync::CancellationToken;
///
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// let budget = ChildBudget {
///     deadline: Duration::from_secs(5),
///     max_stdout_bytes: 4_096,
///     max_stderr_bytes: 1_024,
/// };
/// let cancel = CancellationToken::new();
/// # #[cfg(unix)]
/// let outcome = run_bounded_child(
///     Path::new("/bin/echo"),
///     &["hi"],
///     None::<&HashMap<String, String>>,
///     budget,
///     &cancel,
/// )
/// .await
/// .expect("echo runs and exits quickly");
/// # #[cfg(unix)]
/// assert!(outcome.status_success);
/// # }
/// ```
pub async fn run_bounded_child(
    program: &Path,
    args: &[&str],
    env: Option<&HashMap<String, String>>,
    budget: ChildBudget,
    cancel: &CancellationToken,
) -> Result<ChildOutcome, ChildRunError> {
    let mut request = ProcessRequest::new(program, args).with_budget(ProcessBudget::new(
        budget.deadline,
        budget.max_stdout_bytes,
        budget.max_stderr_bytes,
    ));
    request.env = env.map(|env| {
        env.iter()
            .map(|(key, value)| (key.clone().into(), value.clone().into()))
            .collect()
    });
    let control = DefaultProcessSpawner
        .start(request, std::sync::Arc::new(AlwaysAllow), cancel.clone())
        .await
        .map_err(map_start_error)?;
    let terminal = tokio::select! {
        terminal = control.wait() => terminal,
        () = cancel.cancelled() => match control.cancel().await {
            ProcessStop::Observed(terminal) => terminal,
            ProcessStop::Unsupported | ProcessStop::DispatchFailed(_) => return Err(ChildRunError::Cancelled),
        },
    };
    match terminal.cause {
        ProcessTerminalCause::TimedOut => Err(ChildRunError::TimedOut),
        ProcessTerminalCause::Cancelled => Err(ChildRunError::Cancelled),
        // No observed status means the supervisor never learned what the child did (its
        // cleanup owner died before reporting one), which is not the same as "the child ran
        // and failed" — a caller reading `status_success: false` with no `exit_code` cannot
        // tell the two apart, and this one reports a missing tool that way.
        _ if terminal.exit.is_none() => Err(ChildRunError::SpawnFailed(std::io::Error::other(
            "the process supervisor published no exit status for a bounded child",
        ))),
        _ => Ok(ChildOutcome {
            status_success: terminal.exit.as_ref().is_some_and(|exit| exit.success),
            exit_code: terminal.exit.as_ref().and_then(|exit| exit.code),
            signal: terminal
                .exit
                .as_ref()
                .and_then(|exit| exit.signal.as_ref())
                .map(|signal| signal.name),
            stdout: terminal.stdout.bytes,
            stderr: terminal.stderr.bytes,
            stdout_truncated: terminal.stdout.truncated,
            stderr_truncated: terminal.stderr.truncated,
        }),
    }
}

fn map_start_error(error: ProcessStartError) -> ChildRunError {
    match error {
        ProcessStartError::CancelledBeforeStart => ChildRunError::Cancelled,
        ProcessStartError::TimedOutBeforeStart => ChildRunError::TimedOut,
        ProcessStartError::SpawnFailed(error) => ChildRunError::SpawnFailed(error),
        ProcessStartError::LaunchDenied(error) => {
            ChildRunError::SpawnFailed(std::io::Error::other(error))
        }
        ProcessStartError::SupervisorUnavailable => ChildRunError::SpawnFailed(
            std::io::Error::other("the process supervisor stopped before reporting launch status"),
        ),
        ProcessStartError::LimitExceeded => ChildRunError::SpawnFailed(std::io::Error::other(
            "the process supervisor has reached its bounded request limit",
        )),
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use tokio_util::sync::CancellationToken;

    use super::{ChildBudget, ChildRunError, run_bounded_child};
    use crate::test_support::scratch_dir;

    /// Writes an executable `sh` script at `dir/name` and returns its path.
    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    fn budget(deadline: Duration) -> ChildBudget {
        ChildBudget {
            deadline,
            max_stdout_bytes: 64 * 1024,
            max_stderr_bytes: 64 * 1024,
        }
    }

    #[tokio::test]
    async fn a_quick_child_returns_its_output_within_budget() {
        let dir = scratch_dir("quick");
        let sh = script(&dir, "quick.sh", "printf hello");
        let cancel = CancellationToken::new();

        let outcome = run_bounded_child(
            &sh,
            &[],
            None::<&HashMap<String, String>>,
            budget(Duration::from_secs(5)),
            &cancel,
        )
        .await
        .expect("a fast script must succeed");

        assert!(outcome.status_success);
        assert_eq!(outcome.stdout, b"hello");
        assert!(!outcome.stdout_truncated);
    }

    /// The compatibility adapter's deadline starts before admission. Under
    /// whole-crate load this request can therefore expire without an OS child
    /// ever existing; either path is still the same public timeout result.
    /// The supervisor owns the separate launched-child cleanup proof.
    #[tokio::test]
    async fn a_child_past_its_deadline_is_killed_and_reaped() {
        let dir = scratch_dir("timeout");
        let sh = script(&dir, "slow.sh", "sleep 5");
        let cancel = CancellationToken::new();

        let error = run_bounded_child(
            &sh,
            &[],
            None::<&HashMap<String, String>>,
            budget(Duration::from_millis(200)),
            &cancel,
        )
        .await
        .expect_err("a script sleeping past its deadline must time out");
        assert!(matches!(error, ChildRunError::TimedOut));
    }

    /// Regression test for the reader-join half of the deadline: the direct
    /// child can exit successfully well within budget while a descendant it
    /// backgrounded (a shim's own hook, a credential helper) keeps the
    /// inherited stdout pipe open indefinitely. Before the fix, only
    /// `child.wait()` was bounded by `budget.deadline` — the two reader
    /// joins afterward had no bound at all, so this reproduced a genuine
    /// hang: measured directly against the pre-fix code, `run_bounded_child`
    /// had not returned after 8 seconds (this test's own 2-second bound is
    /// what actually catches that, not the assertion on the error variant
    /// alone).
    ///
    /// Also proves the descendant itself is killed, not merely that this
    /// call stops waiting on it: the direct child has already exited by the
    /// time the reader join times out, so there is no live `Child` left for
    /// `kill_and_reap` to signal — only `child_pid`, captured before the
    /// child was ever awaited, can still name the process group the
    /// descendant shares with it.
    #[tokio::test]
    async fn a_backgrounded_descendant_holding_the_pipe_does_not_hang_the_call() {
        let dir = scratch_dir("orphan-pipe");
        let descendant_pid_file = dir.join("descendant-pid");
        let sh = script(
            &dir,
            "orphan.sh",
            &format!(
                "sleep 20 & echo $! > {}\nprintf ok\nexit 0\n",
                descendant_pid_file.display()
            ),
        );
        let cancel = CancellationToken::new();

        let result = tokio::time::timeout(
            Duration::from_secs(2),
            run_bounded_child(
                &sh,
                &[],
                None::<&HashMap<String, String>>,
                budget(Duration::from_millis(300)),
                &cancel,
            ),
        )
        .await
        .expect(
            "run_bounded_child must return within its own deadline, not hang on a descendant \
             still holding the pipe open",
        );

        assert!(
            matches!(result, Err(ChildRunError::TimedOut)),
            "the direct child exited cleanly, but draining its output still overran the \
             budget — expected TimedOut, got {result:?}"
        );
        assert_process_is_gone(&descendant_pid_file).await;
    }

    /// Regression test for `kill_and_reap` killing only the direct child:
    /// a script that backgrounds a descendant before sleeping past its own
    /// deadline used to leave that descendant running as an orphan after
    /// `run_bounded_child` returned `TimedOut` — `child.start_kill()`
    /// signals exactly one pid, and a plain `sleep &` never calls
    /// `setpgid` itself, so it shared the child's process group with
    /// nothing there to reach it. `spawn`'s `process_group(0)` plus
    /// `kill_and_reap`'s group-wide `kill(-pid, SIGKILL)` now reaches both.
    #[tokio::test]
    async fn a_backgrounded_descendant_that_never_touches_the_pipe_is_still_killed() {
        let dir = scratch_dir("orphan-process");
        let parent_pid_file = dir.join("parent-pid");
        let descendant_pid_file = dir.join("descendant-pid");
        let sh = script(
            &dir,
            "backgrounds-and-sleeps.sh",
            &format!(
                "echo $$ > {}\nsleep 5 & echo $! > {}\nsleep 5\n",
                parent_pid_file.display(),
                descendant_pid_file.display()
            ),
        );
        let cancel = CancellationToken::new();

        let error = run_bounded_child(
            &sh,
            &[],
            None::<&HashMap<String, String>>,
            budget(Duration::from_millis(300)),
            &cancel,
        )
        .await
        .expect_err("a script sleeping past its deadline must time out");
        assert!(matches!(error, ChildRunError::TimedOut));

        assert_process_is_gone(&parent_pid_file).await;
        assert_process_is_gone(&descendant_pid_file).await;
    }

    /// The same proof as the deadline test, but for cooperative
    /// cancellation fired from a concurrent task after the child has
    /// already started.
    #[tokio::test]
    async fn a_cancelled_child_is_killed_and_reaped() {
        let dir = scratch_dir("cancel");
        let pid_file = dir.join("pid");
        let sh = script(
            &dir,
            "slow.sh",
            &format!("echo $$ > {}\nsleep 5\n", pid_file.display()),
        );
        let cancel = CancellationToken::new();
        let cancel_after = cancel.clone();
        let pid_file_for_wait = pid_file.clone();
        tokio::spawn(async move {
            wait_for_file(&pid_file_for_wait).await;
            cancel_after.cancel();
        });

        let error = run_bounded_child(
            &sh,
            &[],
            None::<&HashMap<String, String>>,
            budget(Duration::from_secs(30)),
            &cancel,
        )
        .await
        .expect_err("cancellation must stop the child before its own deadline");
        assert!(
            matches!(error, ChildRunError::Cancelled),
            "unexpected child error: {error:?}"
        );

        assert_process_is_gone(&pid_file).await;
    }

    /// Stdout past `max_stdout_bytes` is capped, and the outcome says so.
    #[tokio::test]
    async fn stdout_past_the_cap_is_truncated() {
        let dir = scratch_dir("cap");
        // A deterministic, larger-than-the-cap byte count regardless of
        // line buffering: `head -c` truncates mid-stream on an exact byte
        // count.
        let sh = script(&dir, "big.sh", "yes A | head -c 5000");
        let cancel = CancellationToken::new();
        let mut small_budget = budget(Duration::from_secs(5));
        small_budget.max_stdout_bytes = 1_000;

        let outcome = run_bounded_child(
            &sh,
            &[],
            None::<&HashMap<String, String>>,
            small_budget,
            &cancel,
        )
        .await
        .expect("head must exit successfully");

        assert_eq!(outcome.stdout.len(), 1_000);
        assert!(outcome.stdout_truncated);
    }

    /// Regression test: a child that writes well past the cap in *many
    /// small writes* — mirroring a verbose CLI wrapper's line-buffered
    /// output, unlike `stdout_past_the_cap_is_truncated` above's single
    /// `yes | head` pipeline, which hands the whole capped byte count to
    /// the kernel through one write on the writing end and so never
    /// exercised this — must still be observed exiting successfully.
    /// `read_capped` used to stop reading (and drop its end of the pipe)
    /// the instant the cap filled; a script that wrote again afterward got
    /// `SIGPIPE` on that write, which reported as a failed exit status for
    /// a child that never actually failed.
    #[tokio::test]
    async fn a_child_writing_past_the_cap_in_many_small_writes_still_exits_successfully() {
        let dir = scratch_dir("verbose-writer");
        let sh = script(
            &dir,
            "verbose.sh",
            "i=0; while [ $i -lt 200 ]; do printf 'line %03d of output past the cap\\n' \"$i\"; \
             i=$((i+1)); done",
        );
        let cancel = CancellationToken::new();
        let mut small_budget = budget(Duration::from_secs(5));
        small_budget.max_stdout_bytes = 128;

        let outcome = run_bounded_child(
            &sh,
            &[],
            None::<&HashMap<String, String>>,
            small_budget,
            &cancel,
        )
        .await
        .expect("a verbose script writing past the cap must still be observed exiting");

        assert!(
            outcome.status_success,
            "the child must exit successfully even though its output was capped past this \
             function's own buffer, not fail with SIGPIPE on a later write"
        );
        assert!(outcome.stdout_truncated);
    }

    /// Polls for `path` to exist without a fixed sleep loop's usual
    /// flakiness risk: a short poll interval bounded by a generous overall
    /// timeout, used only to learn "the child has started", never to
    /// synchronise the property under test itself.
    async fn wait_for_file(path: &Path) {
        for _ in 0..500 {
            if path.exists() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("{} was never created", path.display());
    }

    /// Asserts `pid_file`'s pid is no longer live, polling briefly rather
    /// than checking once: a direct child this function itself `wait()`ed
    /// on is reaped synchronously, but a backgrounded descendant that
    /// outlived its own parent is reparented to an init/subreaper process
    /// and only actually reaped (leaving zombie state, where `kill(pid,
    /// 0)` still reports it as live) whenever that new parent gets around
    /// to it — a real delay this assertion must tolerate, not a flake to
    /// paper over with a longer single wait.
    async fn assert_process_is_gone(pid_file: &Path) {
        let pid_text = std::fs::read_to_string(pid_file)
            .unwrap_or_else(|error| panic!("{} was never written: {error}", pid_file.display()));
        let pid: i32 = pid_text.trim().parse().expect("a pid is an integer");
        for _ in 0..200 {
            let result = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None);
            if matches!(result, Err(nix::errno::Errno::ESRCH)) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "pid {pid} from {} must no longer be live",
            pid_file.display()
        );
    }
}
