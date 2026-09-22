//! Exercises the parent-death boundary from a separate test-harness process.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use mangostudio_runtime::subprocess::{
    AlwaysAllow, DefaultProcessSpawner, ProcessBudget, ProcessRequest, ProcessSpawner,
};
use tokio_util::sync::CancellationToken;

mod support;

use support::scratch::scratch_dir;

const FIXTURE_DIRECTORY: &str = "MANGOSTUDIO_GUARDIAN_PARENT_DEATH_FIXTURE_DIRECTORY";

/// The outer invocation starts this same test binary in fixture mode, waits until that runtime
/// parent has released the target, then SIGKILLs the parent. The liveness-pipe watchdog must kill
/// both the target and its ordinary background descendant even though no supervisor worker gets
/// an opportunity to run cleanup after the parent dies.
#[tokio::test(flavor = "current_thread")]
async fn guardian_kills_the_tree_when_its_runtime_parent_dies() {
    if let Some(directory) = std::env::var_os(FIXTURE_DIRECTORY) {
        run_killed_parent_fixture(PathBuf::from(directory)).await;
        return;
    }

    let directory = scratch_dir("guardian-parent-death");
    let target_pid = directory.join("target.pid");
    let descendant_pid = directory.join("descendant.pid");
    let mut parent = Command::new(std::env::current_exe().expect("the test binary path exists"))
        .args([
            "--exact",
            "guardian_kills_the_tree_when_its_runtime_parent_dies",
            "--nocapture",
        ])
        .env(FIXTURE_DIRECTORY, directory.path())
        .spawn()
        .expect("the separate runtime-parent fixture starts");

    wait_for_file(&target_pid).await;
    wait_for_file(&descendant_pid).await;
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

    assert_process_is_gone(&target_pid).await;
    assert_process_is_gone(&descendant_pid).await;
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
    let request = ProcessRequest::new(script, std::iter::empty::<String>()).with_budget(
        ProcessBudget::new(Duration::from_secs(60), 1_024, 1_024)
            .with_post_exit_drain(Duration::from_millis(100)),
    );
    let control = DefaultProcessSpawner
        .start(request, Arc::new(AlwaysAllow), CancellationToken::new())
        .await
        .expect("fixture target starts behind the guardian start gate");

    // Keep the liveness writer owned by this process until the outer fixture kills us. Dropping
    // `control` alone is intentionally irrelevant to guardian ownership.
    let _control = control;
    tokio::time::sleep(Duration::from_secs(30)).await;
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
