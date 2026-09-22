//! Exercises the Unix guardian's parent-death boundary from separate test-harness processes.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Barrier};
use std::time::Duration;

use mango_protocol::RemoteError;
use mangostudio_runtime::subprocess::{
    AlwaysAllow, DefaultProcessSpawner, LaunchCheck, ProcessBudget, ProcessRequest, ProcessSpawner,
};
use tokio_util::sync::CancellationToken;

mod support;

use support::scratch::scratch_dir;

const FIXTURE_DIRECTORY: &str = "MANGOSTUDIO_GUARDIAN_PARENT_DEATH_FIXTURE_DIRECTORY";
const FIXTURE_CASE: &str = "MANGOSTUDIO_GUARDIAN_PARENT_DEATH_FIXTURE_CASE";
const LEADER_EXIT_CASE: &str = "leader-exit";
const CONCURRENT_CASE: &str = "concurrent";

/// The outer invocation starts this same test binary in fixture mode, waits until that runtime
/// parent has released the target, then SIGKILLs the parent. The liveness-pipe watchdog must kill
/// both the target and its ordinary background descendant even though no supervisor worker gets
/// an opportunity to run cleanup after the parent dies.
#[tokio::test(flavor = "current_thread")]
async fn guardian_kills_the_tree_when_its_runtime_parent_dies() {
    if let Some(directory) = fixture_directory() {
        run_killed_parent_fixture(directory).await;
        return;
    }

    let directory = scratch_dir("guardian-parent-death");
    let target_pid = directory.join("target.pid");
    let descendant_pid = directory.join("descendant.pid");
    let mut parent = spawn_fixture(
        "guardian_kills_the_tree_when_its_runtime_parent_dies",
        &directory,
        None,
    );

    wait_for_file(&target_pid).await;
    wait_for_file(&descendant_pid).await;
    kill_fixture_parent(&mut parent);

    assert_process_is_gone(&target_pid).await;
    assert_process_is_gone(&descendant_pid).await;
}

/// A direct target may exit while its descendant keeps stdout open. The guardian reports that
/// target status to the runtime, but keeps its watchdog and liveness lease until the runtime
/// explicitly concludes capture. Killing the runtime in that interval must still kill the
/// descendant; otherwise leader exit would reopen a parent-death cleanup gap.
#[tokio::test(flavor = "current_thread")]
async fn guardian_keeps_parent_death_cleanup_after_direct_target_exit() {
    if let Some(directory) = fixture_directory() {
        if std::env::var_os(FIXTURE_CASE).as_deref() == Some(LEADER_EXIT_CASE.as_ref()) {
            run_leader_exit_fixture(directory).await;
            return;
        }
        panic!("leader-exit guardian fixture started without its fixture case");
    }

    let directory = scratch_dir("guardian-parent-death-leader-exit");
    let target_pid = directory.join("target.pid");
    let descendant_pid = directory.join("descendant.pid");
    let mut parent = spawn_fixture(
        "guardian_keeps_parent_death_cleanup_after_direct_target_exit",
        &directory,
        Some(LEADER_EXIT_CASE),
    );

    wait_for_file(&target_pid).await;
    wait_for_file(&descendant_pid).await;
    kill_fixture_parent(&mut parent);

    assert_process_is_gone(&target_pid).await;
    assert_process_is_gone(&descendant_pid).await;
}

/// Two starts deliberately reach their launch checks together. Each guardian must close every
/// descriptor except its own lease before it forks its watchdog: retaining a sibling's liveness
/// writer could otherwise create a cycle that survives a runtime SIGKILL.
#[tokio::test(flavor = "current_thread")]
async fn concurrent_guardians_do_not_retain_each_others_parent_death_leases() {
    if let Some(directory) = fixture_directory() {
        if std::env::var_os(FIXTURE_CASE).as_deref() == Some(CONCURRENT_CASE.as_ref()) {
            run_concurrent_fixture(directory).await;
            return;
        }
        panic!("concurrent guardian fixture started without its fixture case");
    }

    let directory = scratch_dir("guardian-parent-death-concurrent");
    let first_pid = directory.join("first.pid");
    let second_pid = directory.join("second.pid");
    let mut parent = spawn_fixture(
        "concurrent_guardians_do_not_retain_each_others_parent_death_leases",
        &directory,
        Some(CONCURRENT_CASE),
    );

    wait_for_file(&first_pid).await;
    wait_for_file(&second_pid).await;
    kill_fixture_parent(&mut parent);

    assert_process_is_gone(&first_pid).await;
    assert_process_is_gone(&second_pid).await;
}

async fn run_killed_parent_fixture(directory: PathBuf) {
    let target_pid = directory.join("target.pid");
    let descendant_pid = directory.join("descendant.pid");
    let script = write_script(
        &directory,
        "target.sh",
        &format!(
            "echo $$ > {}\nsleep 30 & echo $! > {}\nsleep 30",
            target_pid.display(),
            descendant_pid.display(),
        ),
    );
    let control = start_fixture_target(script, Arc::new(AlwaysAllow)).await;

    // Keep the liveness writer owned by this process until the outer fixture kills us. Dropping
    // `control` alone is intentionally irrelevant to guardian ownership.
    let _control = control;
    tokio::time::sleep(Duration::from_secs(30)).await;
}

async fn run_leader_exit_fixture(directory: PathBuf) {
    let target_pid = directory.join("target.pid");
    let descendant_pid = directory.join("descendant.pid");
    let script = write_script(
        &directory,
        "leader-exits.sh",
        &format!(
            "echo $$ > {}\nsleep 30 & echo $! > {}\nexit 0",
            target_pid.display(),
            descendant_pid.display(),
        ),
    );
    let control = start_fixture_target(script, Arc::new(AlwaysAllow)).await;

    // The descendant inherits stdout, so the worker is boundedly draining while its guardian
    // waits for finalization. The outer process kills this runtime in that exact interval.
    let _control = control;
    tokio::time::sleep(Duration::from_secs(30)).await;
}

async fn run_concurrent_fixture(directory: PathBuf) {
    let first = write_script(
        &directory,
        "first.sh",
        &format!(
            "echo $$ > {}\nsleep 30",
            directory.join("first.pid").display()
        ),
    );
    let second = write_script(
        &directory,
        "second.sh",
        &format!(
            "echo $$ > {}\nsleep 30",
            directory.join("second.pid").display()
        ),
    );
    let check: Arc<dyn LaunchCheck> = Arc::new(ConcurrentStartBarrier(Barrier::new(2)));
    let (first, second) = tokio::join!(
        start_fixture_target(first, Arc::clone(&check)),
        start_fixture_target(second, check),
    );
    let _first = first;
    let _second = second;
    tokio::time::sleep(Duration::from_secs(30)).await;
}

async fn start_fixture_target(
    script: PathBuf,
    check: Arc<dyn LaunchCheck>,
) -> mangostudio_runtime::subprocess::ProcessControl {
    let request = ProcessRequest::new(script, std::iter::empty::<String>()).with_budget(
        ProcessBudget::new(Duration::from_secs(60), 1_024, 1_024)
            .with_post_exit_drain(Duration::from_millis(100)),
    );
    DefaultProcessSpawner
        .start(request, check, CancellationToken::new())
        .await
        .expect("fixture target starts behind the guardian start gate")
}

struct ConcurrentStartBarrier(Barrier);

impl LaunchCheck for ConcurrentStartBarrier {
    fn check(&self) -> Result<(), RemoteError> {
        self.0.wait();
        Ok(())
    }
}

fn fixture_directory() -> Option<PathBuf> {
    std::env::var_os(FIXTURE_DIRECTORY).map(PathBuf::from)
}

fn spawn_fixture(test_name: &str, directory: &Path, fixture_case: Option<&str>) -> Child {
    let mut command = Command::new(std::env::current_exe().expect("the test binary path exists"));
    command
        .args(["--exact", test_name, "--nocapture"])
        .env(FIXTURE_DIRECTORY, directory);
    if let Some(fixture_case) = fixture_case {
        command.env(FIXTURE_CASE, fixture_case);
    }
    command
        .spawn()
        .expect("the separate runtime-parent fixture starts")
}

fn kill_fixture_parent(parent: &mut Child) {
    let pid = i32::try_from(parent.id()).expect("test fixture pid fits Unix pid range");
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(pid),
        nix::sys::signal::Signal::SIGKILL,
    )
    .expect("the outer test kills its fixture parent");
    let status = parent.wait().expect("the killed fixture is reaped");
    assert!(
        !status.success(),
        "SIGKILL cannot look like a successful parent exit"
    );
}

fn write_script(directory: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let script = directory.join(name);
    std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).expect("script is written");
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))
        .expect("script is executable");
    script
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
    let pid: i32 = std::fs::read_to_string(pid_file)
        .unwrap_or_else(|error| panic!("{} was never written: {error}", pid_file.display()))
        .trim()
        .parse()
        .expect("the fixture wrote a numeric pid");
    for _ in 0..300 {
        if matches!(
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
            Err(nix::errno::Errno::ESRCH)
        ) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!(
        "pid {pid} from {} survived runtime-parent death",
        pid_file.display()
    );
}
