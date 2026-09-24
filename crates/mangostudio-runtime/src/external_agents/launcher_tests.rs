use std::collections::BTreeMap;

use mango_external_agents::Limits;
use mango_external_agents::process::{
    InterruptOutcome, LaunchSpec, ManagedProcess, ProcessLauncher,
};
use mango_external_agents::session::CancelReason;

use super::*;
use crate::subprocess::AlwaysAllow;
use crate::test_support::scratch_dir;

const BOUND: Duration = Duration::from_secs(10);

fn launcher() -> GuardedProcessLauncher {
    GuardedProcessLauncher::new(Arc::new(AlwaysAllow), &Limits::default())
}

async fn start(launcher: &GuardedProcessLauncher, spec: LaunchSpec) -> ManagedProcess {
    tokio::time::timeout(BOUND, launcher.spawn(spec))
        .await
        .expect("expected the launch within the bound | received a hung launch")
        .unwrap_or_else(|error| panic!("expected a started child | received {error}"))
}

#[cfg(unix)]
mod unix {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    use mango_external_agents::Error;
    use mango_external_agents::process::ExitStatus;
    use mango_protocol::error::RemoteError;

    use super::*;

    /// Counts every OS launch it forwards to the production spawner.
    #[derive(Default)]
    struct CountingSpawner {
        spawns: AtomicUsize,
    }

    impl ChildSpawner for CountingSpawner {
        fn spawn(&self, request: &ProcessRequest, stdin_pipe: bool) -> io::Result<PipeChild> {
            self.spawns.fetch_add(1, Ordering::SeqCst);
            PipeChildSpawner.spawn(request, stdin_pipe)
        }
    }

    /// A consent check that has been revoked; counts how often it was asked.
    #[derive(Default)]
    struct RevokedConsent {
        checks: AtomicUsize,
    }

    impl LaunchCheck for RevokedConsent {
        fn check(&self) -> std::result::Result<(), RemoteError> {
            self.checks.fetch_add(1, Ordering::SeqCst);
            Err(RemoteError::new(
                mango_protocol::error::codes::DENIED,
                "external-agent consent was revoked",
            ))
        }
    }

    fn spec(argv: &[&str], cwd: &Path, stdin: bool) -> LaunchSpec {
        LaunchSpec {
            argv: argv.iter().map(|&argument| argument.to_owned()).collect(),
            cwd: cwd.to_path_buf(),
            env: BTreeMap::from([("PATH".to_owned(), "/usr/bin:/bin".to_owned())]),
            stdin,
            hide_window: true,
        }
    }

    /// Reads stdout to EOF within the bound.
    async fn read_all(process: &mut ManagedProcess) -> String {
        let mut output = Vec::new();
        loop {
            let chunk = tokio::time::timeout(BOUND, process.stdout.next_chunk())
                .await
                .expect("expected stdout to reach EOF within the bound | received no EOF")
                .unwrap_or_else(|error| panic!("expected readable stdout | received {error}"));
            match chunk {
                Some(chunk) => output.extend_from_slice(&chunk),
                None => return String::from_utf8_lossy(&output).into_owned(),
            }
        }
    }

    async fn wait(process: &ManagedProcess) -> ExitStatus {
        tokio::time::timeout(BOUND, process.control.wait())
            .await
            .expect("expected the child reaped within the bound | received no exit")
            .unwrap_or_else(|error| panic!("expected an exit status | received {error}"))
    }

    fn script(directory: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = directory.join("agent.sh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("script is written");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .expect("script is executable");
        path
    }

    fn alive(pid: i32) -> bool {
        !matches!(
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
            Err(nix::errno::Errno::ESRCH)
        )
    }

    /// Polls until `path` holds a pid; the panic names the file it waited for.
    async fn pid_in(path: &Path) -> i32 {
        for _ in 0..500 {
            if let Ok(text) = std::fs::read_to_string(path)
                && let Ok(pid) = text.trim().parse()
            {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("expected a pid in {} | received no pid", path.display());
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

    /// Polls until `pid` is gone; the panic names the pid still alive.
    async fn assert_gone(name: &str, pid: i32) {
        for _ in 0..200 {
            if !alive(pid) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("expected {name} pid {pid} gone after kill | received pid {pid} still alive");
    }

    #[tokio::test]
    async fn the_child_sees_exactly_the_given_argv_cwd_and_env() {
        let directory = scratch_dir("agent-launcher-authority");
        let cwd = std::fs::canonicalize(&*directory).expect("scratch dir canonicalises");
        let env = BTreeMap::from([
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
            ("AGENT_SENTINEL".to_owned(), "given value".to_owned()),
        ]);
        let mut env_process = start(
            &launcher(),
            LaunchSpec {
                env: env.clone(),
                ..spec(&["/usr/bin/env"], &cwd, false)
            },
        )
        .await;
        let printed = read_all(&mut env_process).await;
        let mut lines: Vec<&str> = printed.lines().collect();
        lines.sort_unstable();
        // Only names reach the failure message: an inherited environment would carry the
        // parent's credentials into the test log. HOME is set in the test process, so its absence
        // proves nothing was inherited.
        let names: Vec<&str> = lines
            .iter()
            .map(|line| line.split_once('=').map_or(*line, |(name, _)| name))
            .collect();
        assert_eq!(
            names,
            vec!["AGENT_SENTINEL", "PATH"],
            "expected exactly the spec's environment names | received names {names:?}"
        );
        assert_eq!(
            lines,
            vec!["AGENT_SENTINEL=given value", "PATH=/usr/bin:/bin"],
            "expected the spec's environment values unchanged"
        );
        assert_eq!(wait(&env_process).await.code, Some(0));

        let body = "printf '%s\\n' \"$0\" \"$#\" \"$@\"\npwd -P";
        let program = script(&directory, body);
        let program = program.to_str().expect("utf-8 scratch path");
        let mut argv_process = start(
            &launcher(),
            spec(&[program, "two words", "", "--flag=x"], &cwd, false),
        )
        .await;
        let printed = read_all(&mut argv_process).await;
        let expected = format!("{program}\n3\ntwo words\n\n--flag=x\n{}\n", cwd.display());
        assert_eq!(
            printed, expected,
            "expected argv[0], three literal arguments and the spec cwd | received {printed:?}"
        );
        wait(&argv_process).await;
    }

    #[tokio::test]
    async fn stdout_streams_chunks_to_eof_and_stdin_round_trips_until_closed() {
        let directory = scratch_dir("agent-launcher-stdio");
        let mut process = start(&launcher(), spec(&["cat"], &directory, true)).await;
        let stdin = process.stdin.as_mut().expect("expected a stdin pipe");
        stdin
            .write_all(b"first\n")
            .await
            .expect("stdin accepts bytes");
        let chunk = tokio::time::timeout(BOUND, process.stdout.next_chunk())
            .await
            .expect("expected an echoed chunk within the bound")
            .expect("stdout is readable");
        assert_eq!(chunk.as_deref(), Some(&b"first\n"[..]));
        stdin.close().await.expect("stdin closes");
        assert_eq!(
            read_all(&mut process).await,
            "",
            "expected EOF after stdin closed"
        );
        assert_eq!(wait(&process).await.code, Some(0));
    }

    #[tokio::test]
    async fn a_spec_without_stdin_gives_the_child_no_pipe() {
        let directory = scratch_dir("agent-launcher-no-stdin");
        let body = "if [ -p /dev/stdin ]; then echo pipe; else echo none; fi";
        let program = script(&directory, body);
        let mut process = start(
            &launcher(),
            spec(&[program.to_str().expect("utf-8")], &directory, false),
        )
        .await;
        assert!(
            process.stdin.is_none(),
            "expected no stdin sink for stdin: false"
        );
        let printed = read_all(&mut process).await;
        assert_eq!(
            printed.trim(),
            "none",
            "expected stdin connected to no pipe | received {printed:?}"
        );
        wait(&process).await;
    }

    #[tokio::test]
    async fn the_stderr_tail_is_bounded_and_redacted() {
        let directory = scratch_dir("agent-launcher-stderr");
        let body = "head -c 65536 /dev/zero | tr '\\0' 'x' >&2\necho >&2\n\
                    echo 'Authorization: Bearer sk-launcher-secret-123456' >&2\necho tail-end >&2";
        let program = script(&directory, body);
        let limits = Limits {
            stderr_tail_bytes: 256,
            ..Limits::default()
        };
        let launcher = GuardedProcessLauncher::new(Arc::new(AlwaysAllow), &limits);
        let mut process = start(
            &launcher,
            spec(&[program.to_str().expect("utf-8")], &directory, false),
        )
        .await;
        read_all(&mut process).await;
        wait(&process).await;
        let tail = process.control.stderr_tail();
        assert!(
            tail.len() <= 256,
            "expected at most 256 retained stderr bytes | received {}",
            tail.len()
        );
        assert!(
            tail.contains("tail-end") && !tail.contains('x'),
            "expected only the last lines kept | received {tail:?}"
        );
        assert!(
            !tail.contains("sk-launcher-secret-123456"),
            "expected the credential redacted | received {tail:?}"
        );
    }

    #[tokio::test]
    async fn kill_reaps_the_whole_tree_and_concurrent_kills_are_idempotent() {
        let directory = scratch_dir("agent-launcher-tree");
        let target = directory.join("target.pid");
        let grandchild = directory.join("grandchild.pid");
        let body = format!(
            "trap '' INT TERM\necho $$ > {}\nsleep 60 & echo $! > {}\nwhile :; do sleep 1; done",
            target.display(),
            grandchild.display()
        );
        let program = script(&directory, &body);
        let process = start(
            &launcher(),
            spec(&[program.to_str().expect("utf-8")], &directory, false),
        )
        .await;
        let target_pid = pid_in(&target).await;
        let grandchild_pid = pid_in(&grandchild).await;
        assert_eq!(
            process.control.pid(),
            u32::try_from(target_pid).ok(),
            "expected pid() to be the target's own pid"
        );
        let first = Arc::clone(&process.control);
        let second = Arc::clone(&process.control);
        let (left, right) = tokio::time::timeout(BOUND, async {
            tokio::join!(
                first.kill(CancelReason::Requested),
                second.kill(CancelReason::Requested)
            )
        })
        .await
        .expect("expected both kills to finish within the bound");
        assert!(
            left.is_ok() && right.is_ok(),
            "expected both concurrent kills to succeed | received {left:?} and {right:?}"
        );
        assert_gone("target", target_pid).await;
        assert_gone("grandchild", grandchild_pid).await;
        let repeated = process.control.kill(CancelReason::Requested).await;
        assert!(
            repeated.is_ok(),
            "expected a repeated kill to succeed | received {repeated:?}"
        );
        assert_eq!(
            wait(&process).await.signal,
            Some(libc::SIGKILL),
            "expected the target ended by the forced tree kill"
        );
    }

    #[tokio::test]
    async fn dropping_every_handle_reaps_the_tree() {
        let directory = scratch_dir("agent-launcher-drop");
        let target = directory.join("target.pid");
        let body = format!(
            "trap '' INT TERM\necho $$ > {}\nexec sleep 60",
            target.display()
        );
        let program = script(&directory, &body);
        let process = start(
            &launcher(),
            spec(&[program.to_str().expect("utf-8")], &directory, true),
        )
        .await;
        let target_pid = pid_in(&target).await;
        drop(process);
        assert_gone("dropped target", target_pid).await;
    }

    #[tokio::test]
    async fn interrupt_delivers_sigint_to_a_running_child() {
        let directory = scratch_dir("agent-launcher-interrupt");
        let ready = directory.join("ready");
        let body = format!(
            "trap 'exit 42' INT\ntouch {}\nwhile :; do sleep 0.05; done",
            ready.display()
        );
        let program = script(&directory, &body);
        let process = start(
            &launcher(),
            spec(&[program.to_str().expect("utf-8")], &directory, false),
        )
        .await;
        wait_for(&ready).await;
        let outcome = process.control.interrupt(CancelReason::Requested).await;
        assert!(
            matches!(outcome, Ok(InterruptOutcome::Delivered)),
            "expected InterruptOutcome::Delivered | received {outcome:?}"
        );
        let status = wait(&process).await;
        assert_eq!(
            status.code,
            Some(42),
            "expected the SIGINT trap's exit code 42 | received {status:?}"
        );
    }

    #[tokio::test]
    async fn interrupt_after_exit_is_not_delivered() {
        let directory = scratch_dir("agent-launcher-interrupt-exited");
        let process = start(&launcher(), spec(&["true"], &directory, false)).await;
        wait(&process).await;
        let outcome = process.control.interrupt(CancelReason::Requested).await;
        assert!(
            matches!(outcome, Ok(InterruptOutcome::NotDelivered)),
            "expected InterruptOutcome::NotDelivered for an exited child | received {outcome:?}"
        );
    }

    #[tokio::test]
    async fn a_full_pool_refuses_the_next_launch_and_frees_its_slot_on_exit() {
        let directory = scratch_dir("agent-launcher-pool");
        let gate = directory.join("gate");
        let body = format!("while [ ! -e {} ]; do sleep 0.05; done", gate.display());
        let program = script(&directory, &body);
        let program = program.to_str().expect("utf-8");
        let launcher = launcher().with_pool(1);
        let first = start(&launcher, spec(&[program], &directory, false)).await;
        let refused =
            tokio::time::timeout(BOUND, launcher.spawn(spec(&[program], &directory, false)))
                .await
                .expect("expected the refusal within the bound | received a queued launch");
        assert!(
            matches!(refused, Err(Error::LimitExceeded { limit: 1, .. })),
            "expected Error::LimitExceeded at 1 live process | received {:?}",
            refused.as_ref().map(|_| "a second child")
        );
        std::fs::write(&gate, "").expect("gate opens");
        wait(&first).await;
        let third = start(&launcher, spec(&["true"], &directory, false)).await;
        wait(&third).await;
    }

    #[tokio::test]
    async fn a_refusing_launch_check_prevents_exec() {
        let directory = scratch_dir("agent-launcher-refused");
        let spawner = Arc::new(CountingSpawner::default());
        let consent = Arc::new(RevokedConsent::default());
        let launcher = GuardedProcessLauncher::new(
            Arc::clone(&consent) as Arc<dyn LaunchCheck>,
            &Limits::default(),
        )
        .with_spawner(Arc::clone(&spawner) as Arc<dyn ChildSpawner>);
        let result = launcher.spawn(spec(&["true"], &directory, false)).await;
        assert!(
            matches!(
                result,
                Err(Error::Cancelled {
                    reason: CancelReason::ConsentRevoked
                })
            ),
            "expected Error::Cancelled(ConsentRevoked) | received {:?}",
            result.as_ref().map(|_| "a started child")
        );
        assert_eq!(
            consent.checks.load(Ordering::SeqCst),
            1,
            "expected the check to run once"
        );
        assert_eq!(
            spawner.spawns.load(Ordering::SeqCst),
            0,
            "expected zero OS launches after a refused check"
        );
    }

    #[tokio::test]
    async fn an_allowing_launch_check_reaches_the_spawner_once() {
        let directory = scratch_dir("agent-launcher-allowed");
        let spawner = Arc::new(CountingSpawner::default());
        let launcher = launcher().with_spawner(Arc::clone(&spawner) as Arc<dyn ChildSpawner>);
        let process = start(&launcher, spec(&["true"], &directory, false)).await;
        wait(&process).await;
        assert_eq!(
            spawner.spawns.load(Ordering::SeqCst),
            1,
            "expected one OS launch"
        );
    }

    #[tokio::test]
    async fn a_missing_program_is_a_launch_error_naming_the_os_failure() {
        let directory = scratch_dir("agent-launcher-missing");
        let mut missing = spec(&["/nonexistent/agent-cli"], &directory, false);
        missing
            .env
            .insert("AGENT_TOKEN".to_owned(), "env-secret-value".to_owned());
        let result = launcher().spawn(missing).await;
        let Err(Error::Launch { program, message }) = result else {
            panic!(
                "expected Error::Launch | received {:?}",
                result.map(|_| "a started child")
            );
        };
        assert_eq!(program, "/nonexistent/agent-cli");
        assert!(
            message.contains("os error 2") && !message.contains("env-secret-value"),
            "expected the OS error and no environment value | received {message:?}"
        );
    }

    #[tokio::test]
    async fn shutdown_forces_a_tree_nobody_killed() {
        let directory = scratch_dir("agent-launcher-shutdown");
        let target = directory.join("target.pid");
        let body = format!(
            "trap '' INT TERM\necho $$ > {}\nexec sleep 60",
            target.display()
        );
        let program = script(&directory, &body);
        let release: &'static Release = Box::leak(Box::new(Release::new()));
        let launcher = launcher().with_release(release);
        let process = start(
            &launcher,
            spec(&[program.to_str().expect("utf-8")], &directory, false),
        )
        .await;
        let target_pid = pid_in(&target).await;
        let released = release.released().await;
        assert!(
            released,
            "expected the owner released inside the shutdown budget"
        );
        assert_gone("unkilled target", target_pid).await;
        drop(process);
    }

    #[tokio::test]
    async fn an_empty_argv_is_a_host_configuration_error() {
        let directory = scratch_dir("agent-launcher-empty");
        let result = launcher().spawn(spec(&[], &directory, false)).await;
        assert!(
            matches!(result, Err(Error::HostConfiguration { .. })),
            "expected Error::HostConfiguration | received {:?}",
            result.as_ref().map(|_| "a started child")
        );
    }
}

#[cfg(windows)]
#[tokio::test]
async fn windows_interrupt_is_unsupported_and_kill_ends_the_job() {
    let directory = scratch_dir("agent-launcher-windows");
    let process = start(
        &launcher(),
        LaunchSpec {
            argv: vec![
                "cmd.exe".into(),
                "/d".into(),
                "/c".into(),
                "ping -n 60 127.0.0.1 >nul".into(),
            ],
            cwd: directory.to_path_buf(),
            env: BTreeMap::from([("SystemRoot".to_owned(), "C:\\Windows".to_owned())]),
            stdin: false,
            hide_window: true,
        },
    )
    .await;
    let outcome = process.control.interrupt(CancelReason::Requested).await;
    assert!(
        matches!(outcome, Ok(InterruptOutcome::Unsupported)),
        "expected InterruptOutcome::Unsupported on Windows | received {outcome:?}"
    );
    let killed = tokio::time::timeout(BOUND, process.control.kill(CancelReason::Requested)).await;
    assert!(
        matches!(killed, Ok(Ok(()))),
        "expected the Job to end the child within the bound | received {killed:?}"
    );
}
