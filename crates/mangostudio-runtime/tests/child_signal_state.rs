//! A child the runtime starts must get the signal state of a fresh program, not the runtime's.
//!
//! `execve` keeps an ignored disposition and the blocked-signal mask. A runtime started under
//! `nohup`, as a background job of a non-interactive shell, or by a supervisor that ignores
//! `SIGINT` would otherwise hand that to every agent CLI, shell, and tool it spawns, and the
//! Hub's interrupt (`SIGINT` to the child's process group) would silently do nothing.
//!
//! Each test re-executes this same test binary as a fixture "runtime" whose signal state is set
//! before `execve`, the way `nohup` or a supervisor would leave it, so no other test in this
//! process sees an ignored or blocked signal. The fixture runs children through the real
//! `run_bounded_child` path, the guardian every runtime child (bounded, MCP, terminal, external
//! agent) is started by, and reports which signals a child could not take. For the blocked mask
//! the child is this same test binary again, asking the kernel for its own mask, so the check
//! needs neither `/proc` nor a shell (dash clears the mask itself).

#![cfg(unix)]
#![allow(
    unsafe_code,
    reason = "`pre_exec` is the only way to give the fixture process an ignored or blocked signal before it starts"
)]

use std::collections::HashMap;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Output};
use std::time::Duration;

use mangostudio_runtime::subprocess::{ChildBudget, ChildOutcome, run_bounded_child};
use nix::sys::signal::{SigHandler, SigSet, SigmaskHow, Signal, pthread_sigmask, signal};
use tokio_util::sync::CancellationToken;

const FIXTURE: &str = "MANGOSTUDIO_CHILD_SIGNAL_STATE_FIXTURE";
/// Set only in the environment of the probe child the fixture starts.
const PROBE: &str = "MANGOSTUDIO_CHILD_SIGNAL_STATE_PROBE";
/// Prefix of the one stdout line the probe child prints: the blocked signals it found.
const PROBE_REPORT: &str = "MANGOSTUDIO_BLOCKED_SIGNALS=";
/// What a child must be able to trap, receive, and not have blocked.
const SIGNALS: [Signal; 5] = [
    Signal::SIGHUP,
    Signal::SIGINT,
    Signal::SIGQUIT,
    Signal::SIGTERM,
    Signal::SIGPIPE,
];
const TRAP_EXIT_CODE: i32 = 42;

#[derive(Clone, Copy)]
enum Inherited {
    Ignored,
    Blocked,
}

#[test]
fn a_child_can_take_every_signal_the_runtime_ignores() {
    assert_fixture_passes("ignored_fixture", Inherited::Ignored);
}

#[test]
fn a_child_starts_with_no_signal_blocked_by_the_runtime() {
    assert_fixture_passes("blocked_fixture", Inherited::Blocked);
}

/// Runs in the re-executed binary only; a plain run of this binary skips it.
#[tokio::test(flavor = "current_thread")]
async fn ignored_fixture() {
    if !is_fixture() {
        return;
    }
    let mut failures = Vec::new();
    for target in SIGNALS {
        let name = trap_name(target);
        let script =
            format!("trap 'exit {TRAP_EXIT_CODE}' {name}\nkill -s {name} $$\nsleep 1\nexit 0");
        let received = run_child("/bin/sh", &["-c", &script], None).await.exit_code;
        if received != Some(TRAP_EXIT_CODE) {
            failures.push(format!("SIG{name}: exit code {received:?}"));
        }
    }
    assert!(
        failures.is_empty(),
        "expected every child to exit {TRAP_EXIT_CODE} from a trap on its ignored signal | received: {}",
        failures.join(", "),
    );
}

/// Runs in the re-executed binary only; a plain run of this binary skips it.
#[tokio::test(flavor = "current_thread")]
async fn blocked_fixture() {
    if !is_fixture() {
        return;
    }
    let this_binary = std::env::current_exe().expect("the test binary path exists");
    let probe_env = HashMap::from([(PROBE.to_owned(), "1".to_owned())]);
    let outcome = run_child(
        this_binary.to_str().expect("the test binary path is UTF-8"),
        &["--exact", "blocked_probe_child", "--nocapture"],
        Some(&probe_env),
    )
    .await;
    let stdout = String::from_utf8_lossy(&outcome.stdout);
    let blocked = stdout
        .lines()
        .find_map(|line| line.strip_prefix(PROBE_REPORT))
        .unwrap_or_else(|| {
            panic!(
                "expected a {PROBE_REPORT} line from the probe child | received: {stdout:?} (exit {:?})",
                outcome.exit_code
            )
        });
    assert!(
        blocked.is_empty(),
        "expected a child with none of {SIGNALS:?} blocked | received blocked: {blocked}",
    );
}

/// The child of `blocked_fixture`: prints which of [`SIGNALS`] its own mask blocks. A plain run
/// of this binary skips it.
#[test]
fn blocked_probe_child() {
    if std::env::var_os(PROBE).is_none() {
        return;
    }
    let mut mask = SigSet::empty();
    pthread_sigmask(SigmaskHow::SIG_BLOCK, None, Some(&mut mask))
        .expect("the current signal mask can be read");
    let blocked: Vec<_> = SIGNALS
        .iter()
        .filter(|target| mask.contains(**target))
        .map(|target| target.as_str())
        .collect();
    println!("{PROBE_REPORT}{}", blocked.join(","));
}

fn is_fixture() -> bool {
    std::env::var_os(FIXTURE).is_some()
}

/// The name `trap` and `kill -s` take: the signal without its `SIG` prefix.
fn trap_name(target: Signal) -> &'static str {
    &target.as_str()[3..]
}

/// Starts this binary as the fixture runtime with `inherited` set for every signal in
/// [`SIGNALS`], and requires the fixture's assertions to have run and passed.
fn assert_fixture_passes(fixture: &str, inherited: Inherited) {
    let output = spawn_fixture(fixture, inherited);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success() && stdout.contains("1 passed"),
        "expected the child to get a fresh signal state | received fixture {}:\n{stdout}\n{stderr}",
        output.status,
    );
}

fn spawn_fixture(fixture: &str, inherited: Inherited) -> Output {
    let mut command = Command::new(std::env::current_exe().expect("the test binary path exists"));
    command
        .args(["--exact", fixture, "--nocapture", "--test-threads=1"])
        .env(FIXTURE, "1");
    // SAFETY: the closure calls only `sigaction` and `sigprocmask`, which are async-signal-safe.
    unsafe {
        command.pre_exec(move || {
            for target in SIGNALS {
                give_fixture(inherited, target)?;
            }
            Ok(())
        });
    }
    command.output().expect("the fixture runtime starts")
}

fn give_fixture(inherited: Inherited, target: Signal) -> std::io::Result<()> {
    match inherited {
        // SAFETY: `SigIgn` installs no handler code.
        Inherited::Ignored => unsafe { signal(target, SigHandler::SigIgn) }.map(drop)?,
        Inherited::Blocked => {
            let mut set = SigSet::empty();
            set.add(target);
            pthread_sigmask(SigmaskHow::SIG_BLOCK, Some(&set), None)?;
        }
    }
    Ok(())
}

/// Runs `program` through the runtime's guardian. `env` is the child's whole environment when
/// `Some`, and the fixture's own when `None`.
async fn run_child(
    program: &str,
    args: &[&str],
    env: Option<&HashMap<String, String>>,
) -> ChildOutcome {
    let budget = ChildBudget {
        deadline: Duration::from_secs(10),
        max_stdout_bytes: 8_192,
        max_stderr_bytes: 1_024,
    };
    run_bounded_child(
        Path::new(program),
        args,
        env,
        budget,
        &CancellationToken::new(),
    )
    .await
    .expect("the child starts and exits inside its deadline")
}
