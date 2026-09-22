//! Exercises Windows Job containment through the public process supervisor.

#![cfg(windows)]

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Arc;
use std::time::Duration;

use mangostudio_runtime::subprocess::{
    AlwaysAllow, DefaultProcessSpawner, ProcessBudget, ProcessRequest, ProcessSpawner,
    ProcessStdin, ProcessStop, ProcessTerminal, ProcessTerminalCause,
};
use tokio_util::sync::CancellationToken;

mod support;

use support::scratch::scratch_dir;

const FIXTURE_DIRECTORY: &str = "MANGOSTUDIO_WINDOWS_JOB_FIXTURE_DIRECTORY";

/// A normal child proves that the explicit handle list carries stdout, stderr, stdin, Unicode
/// argv, cwd, and an exact environment into CreateProcessW.
#[tokio::test(flavor = "current_thread")]
async fn job_child_preserves_stdio_argv_cwd_and_exact_environment() {
    let directory = scratch_dir("windows-job-stdio");
    let script = directory.join("stdio.ps1");
    std::fs::write(
        &script,
        "param([string] $argument)\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n[Console]::Out.Write($argument + '|' + (Get-Location).Path + '|' + $env:MANGO_WINDOWS_MARKER + '|' + [Console]::In.ReadToEnd())\n[Console]::Error.Write('stderr')\n",
    )
    .expect("PowerShell fixture is written");
    let argument = "seedling 🌱 with a space and \"quote\"";
    let mut request = ProcessRequest::new(
        powershell(),
        [
            OsString::from("-NoProfile"),
            OsString::from("-File"),
            script.into_os_string(),
            OsString::from(argument),
        ],
    )
    .with_stdin(ProcessStdin::Bytes(b"input-bytes".to_vec()))
    .with_budget(ProcessBudget::new(Duration::from_secs(5), 4_096, 4_096));
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

    assert_eq!(terminal.cause, ProcessTerminalCause::Exited);
    assert_eq!(terminal.exit.as_ref().and_then(|exit| exit.code), Some(0));
    assert_eq!(terminal.stderr.bytes, b"stderr");
    let stdout = String::from_utf8(terminal.stdout.bytes).expect("fixture emits UTF-8");
    assert!(stdout.starts_with(argument));
    assert!(stdout.contains("|exact-environment|input-bytes"));
    assert!(stdout.contains(directory.to_string_lossy().as_ref()));
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
    let (control, target, descendant) = start_tree(&directory, Duration::from_millis(250)).await;

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
        "param([string] $targetPath, [string] $descendantPath)\n[IO.File]::WriteAllText($targetPath, $PID)\n$child = Start-Process -FilePath \"$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -ArgumentList '-NoProfile', '-Command', 'Start-Sleep -Seconds 30' -PassThru\n[IO.File]::WriteAllText($descendantPath, $child.Id)\nStart-Sleep -Seconds 30\n",
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
    DefaultProcessSpawner
        .start(request, Arc::new(AlwaysAllow), CancellationToken::new())
        .await
        .expect("Windows Job child starts")
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

async fn wait_for_file(path: &Path) {
    for _ in 0..500 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("{} was never created", path.display());
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

fn powershell() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").expect("Windows defines SystemRoot"))
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}
