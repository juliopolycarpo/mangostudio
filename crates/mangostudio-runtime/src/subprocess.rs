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
use std::path::Path;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::blocking::run_blocking;

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

/// How long this module waits for a killed child to actually exit before
/// giving up and logging instead of blocking forever.
///
/// A `SIGKILL` (Unix) or `TerminateProcess` (Windows) is not synchronous:
/// the kernel still has to schedule the target, tear down its address
/// space, and let a caller's `wait`/`waitpid` observe the exit. Two seconds
/// is generous for that teardown alone while still bounding a caller that
/// asked this module to give up on a child — a caller who timed out or
/// cancelled at [`ChildBudget::deadline`] must not then wait indefinitely
/// for this module's own cleanup on top of it.
const REAP_TIMEOUT: Duration = Duration::from_secs(2);

/// The process-wide gate every [`run_bounded_child`] call acquires a permit
/// from before it spawns anything, held until that child is reaped.
fn child_pool() -> &'static Semaphore {
    static POOL: OnceLock<Semaphore> = OnceLock::new();
    POOL.get_or_init(|| Semaphore::new(MAX_CONCURRENT_CHILD_PROCESSES))
}

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
/// function does not return until the child is no longer running (bounded
/// by `REAP_TIMEOUT`; see that constant's docs for what happens past it).
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
    let _permit = child_pool()
        .acquire()
        .await
        .expect("the child pool's semaphore is never closed, so acquiring it never fails");

    let mut child = spawn(program, args, env)
        .await
        .map_err(ChildRunError::SpawnFailed)?;
    let stdout = child.stdout.take().expect("stdout was requested as piped");
    let stderr = child.stderr.take().expect("stderr was requested as piped");
    let stdout_reader = tokio::spawn(read_capped(stdout, budget.max_stdout_bytes));
    let stderr_reader = tokio::spawn(read_capped(stderr, budget.max_stderr_bytes));

    let outcome = tokio::select! {
        biased;
        () = cancel.cancelled() => Err(ChildRunError::Cancelled),
        () = tokio::time::sleep(budget.deadline) => Err(ChildRunError::TimedOut),
        status = child.wait() => Ok(status.expect(
            "waiting on a spawned child failed; tokio only documents this for a double `wait`, \
             which this function never performs"
        )),
    };

    match outcome {
        Ok(status) => {
            let (stdout, stdout_truncated) = stdout_reader
                .await
                .expect("the stdout reader task must not panic");
            let (stderr, stderr_truncated) = stderr_reader
                .await
                .expect("the stderr reader task must not panic");
            Ok(ChildOutcome {
                status_success: status.success(),
                stdout,
                stderr,
                stdout_truncated,
                stderr_truncated,
            })
        }
        Err(error) => {
            kill_and_reap(&mut child).await;
            // The child is gone (or logged as not, past `REAP_TIMEOUT`)
            // either way, so the reader tasks have nothing left to read —
            // aborting them is cleanup of this function's own owned tasks,
            // not a fire-and-forget spawn left to someone else.
            stdout_reader.abort();
            stderr_reader.abort();
            Err(error)
        }
    }
}

/// The one place `tokio::process::Command::spawn` is called — see the
/// module docs for why it runs inside [`run_blocking`] rather than directly
/// on the calling task.
async fn spawn(
    program: &Path,
    args: &[&str],
    env: Option<&HashMap<String, String>>,
) -> std::io::Result<Child> {
    let program = program.to_path_buf();
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
    let env = env.cloned();
    run_blocking(move || {
        let mut command = Command::new(&program);
        command
            .args(&args)
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(env) = env {
            command.env_clear().envs(env);
        }
        command.spawn()
    })
    .await
}

/// Kills `child` and waits for it to actually exit, bounded by
/// [`REAP_TIMEOUT`]. Never returns early leaving a live process behind
/// silently — the one case this cannot resolve (the kill itself failing, or
/// the reap outrunning its own bound) is reported to stderr, this crate's
/// diagnostic channel (see `crate::transport::stdio`'s own module docs for
/// why stdout is never used for this).
async fn kill_and_reap(child: &mut Child) {
    if let Err(error) = child.start_kill() {
        eprintln!("mangostudio-runtime: could not signal a bounded child to stop: {error}");
        return;
    }
    match tokio::time::timeout(REAP_TIMEOUT, child.wait()).await {
        Ok(Ok(_status)) => {}
        Ok(Err(error)) => {
            eprintln!("mangostudio-runtime: reaping a killed child failed: {error}");
        }
        Err(_elapsed) => {
            eprintln!(
                "mangostudio-runtime: a killed child did not exit within {REAP_TIMEOUT:?}; \
                 leaving further cleanup to kill_on_drop"
            );
        }
    }
}

/// Reads `reader` up to `max_bytes`, returning what was read and whether
/// more was actually available past the cap.
///
/// Truncation is detected by reading one byte past the cap after filling
/// it, rather than inferring it from a short final read — a reader that
/// fills the buffer exactly on its last chunk is not truncated, and this
/// is the only way to tell the two apart.
async fn read_capped<R>(mut reader: R, max_bytes: usize) -> (Vec<u8>, bool)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buffer = vec![0u8; max_bytes];
    let mut filled = 0;
    while filled < max_bytes {
        match reader.read(&mut buffer[filled..]).await {
            Ok(0) => {
                buffer.truncate(filled);
                return (buffer, false);
            }
            Ok(read) => filled += read,
            Err(_) => {
                buffer.truncate(filled);
                return (buffer, false);
            }
        }
    }
    let mut probe = [0u8; 1];
    let truncated = matches!(reader.read(&mut probe).await, Ok(read) if read > 0);
    (buffer, truncated)
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use tokio_util::sync::CancellationToken;

    use super::{ChildBudget, ChildRunError, run_bounded_child};

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mango-subprocess-test-{name}-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

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

    /// A child that outruns its deadline is killed and reaped — proven by
    /// checking, after the call returns, that the pid it recorded no
    /// longer names a live process (`kill(pid, 0)` fails with `ESRCH`).
    #[tokio::test]
    async fn a_child_past_its_deadline_is_killed_and_reaped() {
        let dir = scratch_dir("timeout");
        let pid_file = dir.join("pid");
        let sh = script(
            &dir,
            "slow.sh",
            &format!("echo $$ > {}\nsleep 5\n", pid_file.display()),
        );
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

        assert_process_is_gone(&pid_file);
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
        assert!(matches!(error, ChildRunError::Cancelled));

        assert_process_is_gone(&pid_file);
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

    fn assert_process_is_gone(pid_file: &Path) {
        let pid_text = std::fs::read_to_string(pid_file)
            .unwrap_or_else(|error| panic!("{} was never written: {error}", pid_file.display()));
        let pid: i32 = pid_text.trim().parse().expect("a pid is an integer");
        let result = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None);
        assert!(
            matches!(result, Err(nix::errno::Errno::ESRCH)),
            "the child's pid must no longer be live, got {result:?}"
        );
    }
}
