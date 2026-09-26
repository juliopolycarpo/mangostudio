//! Exercises Windows Job containment through the public process supervisor.

#![cfg(windows)]

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use mangostudio_runtime::subprocess::{
    AlwaysAllow, DefaultProcessSpawner, ProcessBudget, ProcessRequest, ProcessSpawner,
    ProcessStdin, ProcessStop, ProcessTerminal, ProcessTerminalCause,
};
use tokio_util::sync::CancellationToken;

mod support;

use support::scratch::scratch_dir;

const FIXTURE_DIRECTORY: &str = "MANGOSTUDIO_WINDOWS_JOB_FIXTURE_DIRECTORY";
const STDIO_FIXTURE: &str = "MANGOSTUDIO_WINDOWS_STDIO_FIXTURE";

static WINDOWS_JOB_START_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

/// A normal child proves that the explicit handle list carries stdout, stderr, stdin, Unicode
/// argv, cwd, and an exact environment into CreateProcessW.
///
/// The child is this test binary re-entered in fixture mode, not a shell. A PowerShell host cannot
/// serve as the child here: with stdout bound to an anonymous pipe it blocks forever on its first
/// stdout write — one byte is enough — while its stderr write on an identically created pipe still
/// arrives. `job_child_writes_stdout_under_the_full_request_shape` pins that down by running
/// `cmd.exe` under this exact request shape and passing, so the stall belongs to the host and not
/// to the pipe setup here. A Rust child also writes the exact bytes it means to, with no console
/// encoding state in the way of the Unicode argument.
#[tokio::test(flavor = "current_thread")]
async fn job_child_preserves_stdio_argv_cwd_and_exact_environment() {
    if std::env::var_os(STDIO_FIXTURE).is_some() {
        run_stdio_fixture();
        return;
    }

    let directory = scratch_dir("windows-job-stdio");
    let argument = "seedling 🌱 with a space and \"quote\"";
    let mut request = ProcessRequest::new(
        std::env::current_exe().expect("the test binary path exists"),
        [
            OsString::from("--exact"),
            OsString::from("job_child_preserves_stdio_argv_cwd_and_exact_environment"),
            OsString::from("--nocapture"),
            OsString::from(argument),
        ],
    )
    .with_stdin(ProcessStdin::Bytes(b"input-bytes".to_vec()))
    .with_budget(ProcessBudget::new(Duration::from_secs(15), 4_096, 4_096));
    request.cwd = Some(directory.to_path_buf());
    request.env = Some(BTreeMap::from([
        (
            OsString::from("SystemRoot"),
            std::env::var_os("SystemRoot").expect("Windows defines SystemRoot"),
        ),
        (
            OsString::from("MANGO_WINDOWS_MARKER"),
            OsString::from("exact-environment"),
        ),
        (OsString::from(STDIO_FIXTURE), OsString::from("1")),
    ]));

    let terminal = start(request).await.wait().await;

    let report = describe(&terminal);
    assert_eq!(terminal.cause, ProcessTerminalCause::Exited, "{report}");
    assert_eq!(
        terminal.exit.as_ref().and_then(|exit| exit.code),
        Some(0),
        "{report}"
    );
    let stdout = String::from_utf8(terminal.stdout.bytes).expect("fixture emits UTF-8");
    let stderr = String::from_utf8(terminal.stderr.bytes).expect("fixture emits UTF-8");
    // The child runs under libtest, which writes its own progress lines to the same two streams,
    // so each expectation locates the fixture's payload rather than owning the whole capture.
    assert!(stderr.contains("stderr-marker"), "{report}");
    let expected_cwd =
        std::fs::canonicalize(&directory).unwrap_or_else(|_| directory.to_path_buf());
    assert!(
        stdout.contains(&format!(
            "{argument}|{}|exact-environment|input-bytes",
            expected_cwd.display()
        )),
        "{report}"
    );
}

/// The child half of `job_child_preserves_stdio_argv_cwd_and_exact_environment`: it reports the
/// argv tail, cwd, marker variable, and stdin it was handed, so the parent can assert on exactly
/// what `CreateProcessW` delivered.
///
/// Stdin is read to EOF, which also proves the supervisor closes its write end after feeding the
/// configured bytes; a leaked write handle anywhere would hang here instead of returning.
fn run_stdio_fixture() {
    use std::io::{Read as _, Write as _};

    let argument = std::env::args_os()
        .next_back()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let cwd = std::env::current_dir().expect("the fixture child has a working directory");
    // Both ends canonicalise: the parent launches with the requested path while Windows may hand
    // the child a resolved or short-name form of the same directory.
    let cwd = std::fs::canonicalize(&cwd).unwrap_or(cwd);
    let marker = std::env::var("MANGO_WINDOWS_MARKER").unwrap_or_default();
    let mut stdin = String::new();
    std::io::stdin()
        .read_to_string(&mut stdin)
        .expect("the fixture child reads stdin to EOF");

    let mut error = std::io::stderr();
    error
        .write_all(b"stderr-marker")
        .expect("the fixture child writes stderr");
    error.flush().expect("the fixture child flushes stderr");

    let mut out = std::io::stdout();
    out.write_all(format!("{argument}|{}|{marker}|{stdin}", cwd.display()).as_bytes())
        .expect("the fixture child writes stdout");
    out.flush().expect("the fixture child flushes stdout");
}

/// A minimal, non-.NET child proves the explicit handle list carries stdout on its own, apart from
/// whatever console machinery a PowerShell host installs over its standard handles. It is the
/// control for `job_child_preserves_stdio_argv_cwd_and_exact_environment`: both take the same
/// supervisor path, so stdout reaching only one of them localises the fault to the host rather than
/// to this crate's pipe setup.
#[tokio::test(flavor = "current_thread")]
async fn job_child_writes_stdout_through_the_handle_list() {
    let request = ProcessRequest::new(
        command_processor(),
        [OsString::from("/c"), OsString::from("echo mango")],
    )
    .with_budget(ProcessBudget::new(Duration::from_secs(15), 4_096, 4_096));

    let terminal = start(request).await.wait().await;

    let report = describe(&terminal);
    assert_eq!(terminal.cause, ProcessTerminalCause::Exited, "{report}");
    assert!(
        String::from_utf8_lossy(&terminal.stdout.bytes).contains("mango"),
        "{report}"
    );
}

/// The same minimal child under the PowerShell fixture's full request shape — exact environment,
/// overridden cwd, and a byte-fed stdin pipe. It separates the two survivors: stdout arriving here
/// means only the PowerShell host mishandles it, while stdout stalling here means one of those
/// request options breaks stdout for any child and belongs to this crate.
#[tokio::test(flavor = "current_thread")]
async fn job_child_writes_stdout_under_the_full_request_shape() {
    let directory = scratch_dir("windows-job-stdout-shape");
    let mut request = ProcessRequest::new(
        command_processor(),
        [OsString::from("/c"), OsString::from("echo mango")],
    )
    .with_stdin(ProcessStdin::Bytes(b"input-bytes\r\n".to_vec()))
    .with_budget(ProcessBudget::new(Duration::from_secs(15), 4_096, 4_096));
    request.cwd = Some(directory.to_path_buf());
    request.env = Some(BTreeMap::from([
        (
            OsString::from("SystemRoot"),
            std::env::var_os("SystemRoot").expect("Windows defines SystemRoot"),
        ),
        (
            OsString::from("MANGO_WINDOWS_MARKER"),
            OsString::from("exact-environment"),
        ),
    ]));

    let terminal = start(request).await.wait().await;

    let report = describe(&terminal);
    assert_eq!(terminal.cause, ProcessTerminalCause::Exited, "{report}");
    assert!(
        String::from_utf8_lossy(&terminal.stdout.bytes).contains("mango"),
        "{report}"
    );
}

/// The Job includes normal descendants and `force_kill` waits for it to become empty.
#[tokio::test(flavor = "current_thread")]
async fn force_kill_reaps_the_target_and_descendant_before_terminal() {
    let directory = scratch_dir("windows-job-force");
    let (control, target, descendant) = start_tree(&directory, Duration::from_secs(30)).await;

    let terminal = observed(control.force_kill().await);

    assert_eq!(terminal.cause, ProcessTerminalCause::Forced);
    assert_process_is_gone(&target).await;
    assert_process_is_gone(&descendant).await;
}

/// Cancellation claims the same Job-wide cleanup path as a forced shutdown.
#[tokio::test(flavor = "current_thread")]
async fn cancellation_reaps_the_target_and_descendant_before_terminal() {
    let directory = scratch_dir("windows-job-cancel");
    let (control, target, descendant) = start_tree(&directory, Duration::from_secs(30)).await;

    let terminal = observed(control.cancel().await);

    assert_eq!(terminal.cause, ProcessTerminalCause::Cancelled);
    assert_process_is_gone(&target).await;
    assert_process_is_gone(&descendant).await;
}

/// Windows has no safe, job-wide graceful signal equivalent, so the supervisor must report that
/// limitation instead of relabeling a forced Job termination as an interrupt.
#[tokio::test(flavor = "current_thread")]
async fn graceful_interrupt_is_explicitly_unsupported() {
    let directory = scratch_dir("windows-job-interrupt");
    let (control, target, descendant) = start_tree(&directory, Duration::from_secs(30)).await;

    assert!(matches!(
        control.interrupt().await,
        ProcessStop::Unsupported
    ));
    let terminal = observed(control.force_kill().await);

    assert_eq!(terminal.cause, ProcessTerminalCause::Forced);
    assert_process_is_gone(&target).await;
    assert_process_is_gone(&descendant).await;
}

/// Unsupported interrupts must not leave one blocking OS waiter behind for every request. The
/// public control remains usable after a large burst and the Job still reaches one forced cleanup.
#[tokio::test(flavor = "current_thread")]
async fn repeated_unsupported_interrupts_keep_waiting_bounded() {
    let directory = scratch_dir("windows-job-interrupt-burst");
    let (control, target, descendant) = start_tree(&directory, Duration::from_secs(30)).await;

    for _ in 0..512 {
        assert!(matches!(
            control.interrupt().await,
            ProcessStop::Unsupported
        ));
    }

    let terminal = observed(control.force_kill().await);
    assert_eq!(terminal.cause, ProcessTerminalCause::Forced);
    assert_process_is_gone(&target).await;
    assert_process_is_gone(&descendant).await;
}

/// A deadline can expire after a descendant has inherited the Job, and terminal publication
/// still waits for both processes to disappear.
#[tokio::test(flavor = "current_thread")]
async fn timeout_reaps_the_target_and_descendant_before_terminal() {
    let directory = scratch_dir("windows-job-timeout");
    let (control, target, descendant) = start_tree(&directory, Duration::from_secs(2)).await;

    let terminal = control.wait().await;

    assert_eq!(terminal.cause, ProcessTerminalCause::TimedOut);
    assert_process_is_gone(&target).await;
    assert_process_is_gone(&descendant).await;
}

/// Concurrent closes share one worker and observe the same terminal cleanup record.
#[tokio::test(flavor = "current_thread")]
async fn concurrent_close_has_one_job_cleanup_owner() {
    let directory = scratch_dir("windows-job-close");
    let (control, target, descendant) = start_tree(&directory, Duration::from_secs(30)).await;
    let other = control.clone();

    let (first, second) = tokio::join!(control.close(), other.close());

    assert_eq!(observed(first).cause, ProcessTerminalCause::Forced);
    assert_eq!(observed(second).cause, ProcessTerminalCause::Forced);
    assert_process_is_gone(&target).await;
    assert_process_is_gone(&descendant).await;
}

/// Closing the last runtime-side Job handle on an abrupt parent death must terminate every
/// associated process, even though no supervisor worker remains to call `force_kill`.
#[tokio::test(flavor = "current_thread")]
async fn job_kills_the_tree_when_its_runtime_parent_dies() {
    if let Some(directory) = fixture_directory() {
        run_parent_death_fixture(directory).await;
        return;
    }

    let directory = scratch_dir("windows-job-parent-death");
    let target = directory.join("target.pid");
    let descendant = directory.join("descendant.pid");
    let mut parent = spawn_fixture(
        "job_kills_the_tree_when_its_runtime_parent_dies",
        &directory,
    );

    wait_for_file(&target).await;
    wait_for_file(&descendant).await;
    kill_fixture_parent(&mut parent);

    assert_process_is_gone(&target).await;
    assert_process_is_gone(&descendant).await;
}

async fn run_parent_death_fixture(directory: PathBuf) {
    let (control, target, descendant) = start_tree(&directory, Duration::from_secs(60)).await;
    wait_for_file(&target).await;
    wait_for_file(&descendant).await;

    // The outer test kills this runtime before the sleep completes. Retaining the control holds
    // the Job handle whose close is the parent-death signal for both processes.
    let _control = control;
    tokio::time::sleep(Duration::from_secs(30)).await;
}

async fn start_tree(
    directory: &Path,
    deadline: Duration,
) -> (
    mangostudio_runtime::subprocess::ProcessControl,
    PathBuf,
    PathBuf,
) {
    let target = directory.join("target.pid");
    let descendant = directory.join("descendant.pid");
    let script = directory.join("tree.ps1");
    std::fs::write(
        &script,
        "param([string] $targetPath, [string] $descendantPath)\n[IO.File]::WriteAllText($targetPath, $PID)\n$fixtureRoot = Split-Path -Parent $targetPath\n$childStdin = Join-Path $fixtureRoot 'descendant.stdin'\n$childStdout = Join-Path $fixtureRoot 'descendant.stdout'\n$childStderr = Join-Path $fixtureRoot 'descendant.stderr'\n[IO.File]::WriteAllText($childStdin, '')\n$child = Start-Process -FilePath \"$env:SystemRoot\\System32\\timeout.exe\" -ArgumentList '/t', '30', '/nobreak' -RedirectStandardInput $childStdin -RedirectStandardOutput $childStdout -RedirectStandardError $childStderr -PassThru\n[IO.File]::WriteAllText($descendantPath, $child.Id)\nStart-Sleep -Seconds 30\n",
    )
    .expect("PowerShell tree fixture is written");
    let request = ProcessRequest::new(
        powershell(),
        [
            OsString::from("-NoProfile"),
            OsString::from("-File"),
            script.into_os_string(),
            target.as_os_str().to_os_string(),
            descendant.as_os_str().to_os_string(),
        ],
    )
    .with_budget(ProcessBudget::new(deadline, 4_096, 4_096));
    let control = start(request).await;
    wait_for_file(&target).await;
    wait_for_file(&descendant).await;
    (control, target, descendant)
}

async fn start(request: ProcessRequest) -> mangostudio_runtime::subprocess::ProcessControl {
    // Keep CreateProcessW fixture launches sequential. Several fixtures here start a PowerShell
    // host, which is slow enough on a hosted runner that two concurrent startups can outlast the
    // short deadline `timeout_reaps_the_target_and_descendant_before_terminal` depends on.
    let _launch_guard = WINDOWS_JOB_START_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    DefaultProcessSpawner
        .start(request, Arc::new(AlwaysAllow), CancellationToken::new())
        .await
        .expect("Windows Job child starts")
}

/// Renders a terminal record so a failed expectation names what the supervisor actually observed
/// instead of only the mismatched cause.
///
/// A bare cause prints `left: TimedOut, right: Exited` and names neither the exit code nor the
/// captured bytes, and those are what separate a child that never finished from one whose capture
/// never drained.
fn describe(terminal: &ProcessTerminal) -> String {
    format!(
        "cause={:?} exit={:?} elapsed={:?} \
         stdout(incomplete={}, truncated={})={:?} stderr(incomplete={}, truncated={})={:?}",
        terminal.cause,
        terminal.exit,
        terminal.elapsed,
        terminal.stdout.incomplete,
        terminal.stdout.truncated,
        String::from_utf8_lossy(&terminal.stdout.bytes),
        terminal.stderr.incomplete,
        terminal.stderr.truncated,
        String::from_utf8_lossy(&terminal.stderr.bytes),
    )
}

fn observed(stop: ProcessStop) -> ProcessTerminal {
    match stop {
        ProcessStop::Observed(terminal) => terminal,
        ProcessStop::Unsupported => panic!("Windows Job force/cancel must be supported"),
        ProcessStop::DispatchFailed(error) => panic!("Windows Job cleanup failed: {error}"),
    }
}

fn fixture_directory() -> Option<PathBuf> {
    std::env::var_os(FIXTURE_DIRECTORY).map(PathBuf::from)
}

fn spawn_fixture(test_name: &str, directory: &Path) -> Child {
    Command::new(std::env::current_exe().expect("the test binary path exists"))
        .args(["--exact", test_name, "--nocapture"])
        .env(FIXTURE_DIRECTORY, directory)
        .spawn()
        .expect("the separate runtime-parent fixture starts")
}

fn kill_fixture_parent(parent: &mut Child) {
    let output = Command::new("taskkill.exe")
        .args(["/PID", &parent.id().to_string(), "/F"])
        .output()
        .expect("taskkill starts");
    assert!(
        output.status.success(),
        "taskkill failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let status = parent.wait().expect("the killed fixture is reaped");
    assert!(
        !status.success(),
        "abrupt parent death cannot look successful"
    );
}

/// Waits until a fixture's pid file holds a whole pid. `[IO.File]::WriteAllText` creates the
/// file before it writes the content, so existence alone can race a cancel that kills the
/// fixture mid-write and leaves the file empty.
async fn wait_for_file(path: &Path) {
    let mut contents = String::new();
    for _ in 0..500 {
        contents = std::fs::read_to_string(path).unwrap_or_default();
        if contents.trim().parse::<u32>().is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!(
        "expected a numeric pid in {} | received {contents:?}",
        path.display()
    );
}

async fn assert_process_is_gone(pid_file: &Path) {
    let pid = std::fs::read_to_string(pid_file)
        .unwrap_or_else(|error| panic!("{} was never written: {error}", pid_file.display()))
        .trim()
        .parse::<u32>()
        .expect("the fixture wrote a numeric pid");
    for _ in 0..100 {
        let output = Command::new("tasklist.exe")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .expect("tasklist starts");
        let listed = String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line.starts_with('"'));
        if !listed {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("pid {pid} from {} survived Job cleanup", pid_file.display());
}

fn command_processor() -> PathBuf {
    system32().join("cmd.exe")
}

fn system32() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").expect("Windows defines SystemRoot"))
        .join("System32")
}

fn powershell() -> PathBuf {
    system32()
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}
