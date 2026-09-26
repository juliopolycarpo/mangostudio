use super::*;
use crate::runtime_home::{RuntimeSlot, write_runtime_slot_config};
use crate::subprocess::{
    ProcessCapture, ProcessControl, ProcessExit, ProcessFuture, ProcessSignal,
};
use crate::test_support::scratch_dir;
use std::sync::Mutex;

#[test]
fn captured_text_matches_text_decoder_bom_and_replacement_behavior() {
    assert_eq!(capture_text(b"\xef\xbb\xbfhello"), "hello");
    assert_eq!(capture_text(b"hello\xff"), "hello\u{fffd}");
    assert_eq!(capture_text(b"hello\xef\xbb\xbf"), "hello\u{feff}");
}

struct RecordingSpawner {
    requests: Mutex<Vec<ProcessRequest>>,
    terminal: ProcessTerminal,
    revoke_at_launch: Option<PathBuf>,
}

impl ProcessSpawner for RecordingSpawner {
    fn start(
        &self,
        request: ProcessRequest,
        check: Arc<dyn LaunchCheck>,
        _: CancellationToken,
    ) -> ProcessFuture<'_, Result<ProcessControl, ProcessStartError>> {
        Box::pin(async move {
            if let Some(home) = &self.revoke_at_launch {
                write_runtime_slot_config(
                    RuntimeSlot::Host,
                    home,
                    &[("allow", Some(json!({"git":false,"shell":false})))],
                )
                .unwrap();
            }
            check.check().map_err(ProcessStartError::LaunchDenied)?;
            self.requests.lock().unwrap().push(request);
            Ok(ProcessControl::completed(self.terminal.clone()))
        })
    }
}

fn terminal(code: i32) -> ProcessTerminal {
    ProcessTerminal {
        cause: ProcessTerminalCause::Exited,
        exit: Some(ProcessExit {
            success: code == 0,
            code: Some(code),
            signal: None,
        }),
        elapsed: Duration::from_millis(12),
        stdout: ProcessCapture {
            bytes: b"output\n".to_vec(),
            truncated: false,
            incomplete: false,
        },
        stderr: ProcessCapture {
            bytes: Vec::new(),
            truncated: false,
            incomplete: false,
        },
    }
}

fn service(home: &std::path::Path, revoke: bool) -> (Service, Arc<RecordingSpawner>) {
    let spawner = Arc::new(RecordingSpawner {
        requests: Mutex::new(Vec::new()),
        terminal: terminal(0),
        revoke_at_launch: revoke.then(|| home.to_path_buf()),
    });
    (
        Service {
            consent: Arc::new(ConsentSource::new(RuntimeSlot::Host, home.to_path_buf())),
            spawner: spawner.clone(),
        },
        spawner,
    )
}

#[tokio::test]
async fn cli_launch_preserves_argv_cwd_and_bounded_environment() {
    let home = scratch_dir("commands-exact-launch");
    let (service, spawner) = service(&home, false);
    let args = ["log", "--format=%s", "a path with spaces;echo no"];
    let result = service
        .run(
            "git.exec",
            json!({"args":args,"cwd":home.path()}),
            CancellationToken::new(),
            4 * 1024 * 1024,
        )
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({"stdout":"output\n","stderr":"","exitCode":0})
    );
    let requests = spawner.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].program, PathBuf::from("git"));
    assert_eq!(requests[0].args, args.map(std::ffi::OsString::from));
    assert_eq!(requests[0].cwd.as_deref(), Some(home.path()));
    let env = requests[0].env.as_ref().unwrap();
    assert_eq!(env[OsStr::new("GIT_TERMINAL_PROMPT")], "0");
    assert!(!env.contains_key(OsStr::new("GH_TOKEN")));
    assert_eq!(requests[0].budget.deadline, Duration::from_secs(15));
    assert_eq!(
        requests[0].budget.post_exit_drain,
        Duration::from_millis(50)
    );
}

#[tokio::test]
async fn consent_revoked_after_preparation_prevents_launch() {
    let home = scratch_dir("commands-revoked-launch");
    let (service, spawner) = service(&home, true);
    let error = service
        .run(
            "gh.mutate",
            json!({"args":["pr","create"],"cwd":home.path()}),
            CancellationToken::new(),
            4 * 1024 * 1024,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, codes::DENIED);
    assert!(spawner.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cancellation_before_admission_has_no_spawn_effect() {
    let home = scratch_dir("commands-pre-cancel");
    let (service, spawner) = service(&home, false);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let error = service
        .run(
            "gh.mutate",
            json!({"args":["pr","create"],"cwd":home.path()}),
            cancel,
            4 * 1024 * 1024,
        )
        .await
        .unwrap_err();
    assert_eq!(error.details.unwrap()["aborted"], true);
    assert!(spawner.requests.lock().unwrap().is_empty());
}

#[test]
fn invalid_cli_inputs_fail_before_any_launch() {
    let host = PathEnv::default();
    for params in [
        json!({"args":[],"cwd":""}),
        json!({"args":["nul\u{0000}"],"cwd":"/repo"}),
        json!({"args":[],"cwd":"/repo","command":"ignored"}),
        json!({"args":[],"cwd":"/repo","acceptedExitCodes":[1.5]}),
        json!({"args":[],"cwd":"/repo","timeoutMs":0}),
    ] {
        let error = prepare("git.exec", params, &host, 100_000).err().unwrap();
        assert_eq!(error.details.unwrap()["kind"], "tool_argument");
    }
    assert!(
        prepare(
            "gh.exec",
            json!({"args":["pr","private body"],"cwd":"/repo"}),
            &host,
            100_000
        )
        .is_err()
    );
}

#[test]
fn cwd_revalidation_rejects_removed_or_non_directory_paths() {
    let home = scratch_dir("commands-cwd-check");
    let cwd = home.join("cwd");
    std::fs::write(&cwd, "file").unwrap();
    let check = FreshLaunch {
        consent: Arc::new(ConsentSource::new(RuntimeSlot::Host, home.to_path_buf())),
        method: "git.exec",
        cwd: Some(cwd.clone()),
    };
    assert_eq!(
        check.check().unwrap_err().details.unwrap()["kind"],
        "git_execution"
    );
    std::fs::remove_file(&cwd).unwrap();
    std::fs::create_dir(&cwd).unwrap();
    assert!(check.check().is_ok());
    std::fs::remove_dir(&cwd).unwrap();
    assert!(check.check().is_err());
}

#[test]
fn duration_and_response_budgets_are_checked_without_unbounded_allocations() {
    assert_eq!(duration(1.5).unwrap(), Duration::from_micros(1500));
    let platform_overflow = if cfg!(unix) { vec![1.0e22] } else { Vec::new() };
    for value in [0.0, -1.0, f64::NAN, f64::INFINITY]
        .into_iter()
        .chain(platform_overflow)
    {
        let error = duration(value).unwrap_err();
        assert_eq!(error.details.unwrap()["kind"], "tool_argument");
        assert!(error.message.contains("timeoutMs="));
    }
    assert!(output_cap(1024, &json!({"command":"large"}), 100).is_err());
    assert!(output_cap(2000, &json!({}), usize::MAX).unwrap() < 100);
    assert_eq!(
        shell_cwd(Some("~/project"), "/home/test").unwrap(),
        Some(std::path::absolute("/home/test/project").unwrap())
    );
    assert_eq!(
        shell_cwd(Some("~"), "/home/test").unwrap(),
        Some(std::path::absolute("/home/test").unwrap())
    );
    assert_eq!(shell_cwd(Some(""), "/home/test").unwrap(), None);
}

#[cfg(unix)]
#[test]
fn shell_preparation_uses_exact_command_and_sanitized_environment() {
    use std::os::unix::fs::PermissionsExt;
    let home = scratch_dir("commands-shell-prepare");
    let shell = home.join("bash");
    std::fs::write(&shell, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o700)).unwrap();
    let host = PathEnv {
        platform: "linux".into(),
        home_dir: home.to_string_lossy().into_owned(),
        env: std::collections::HashMap::from([
            ("PATH".into(), home.to_string_lossy().into_owned()),
            ("API_KEY".into(), "private".into()),
        ]),
    };
    let params = json!({"kind":"bash","command":"printf '%s' 'a;b'","cwd":"~","timeoutMs":5000,"maxOutputBytes":1000});
    let prepared = prepare_shell(params, &host, 100_000).unwrap();
    assert_eq!(prepared.request.program, shell);
    assert_eq!(
        prepared.request.args,
        ["-c", "printf '%s' 'a;b'"].map(std::ffi::OsString::from)
    );
    assert_eq!(prepared.request.cwd.as_deref(), Some(home.path()));
    assert!(
        !prepared
            .request
            .env
            .unwrap()
            .contains_key(OsStr::new("API_KEY"))
    );
}

/// `shell.run` accepts exactly the shells `detect_shells` may advertise:
/// both read `crate::health::shell_path_candidates`, so PowerShell is
/// Windows-only even when `pwsh` is on a non-Windows `PATH`.
#[cfg(unix)]
#[test]
fn shell_acceptance_matches_the_advertised_shell_rule_per_platform() {
    use mangostudio_runtime_contract::manifest::RuntimeShellKind;
    use std::os::unix::fs::PermissionsExt;
    let home = scratch_dir("commands-shell-parity");
    for name in ["bash", "zsh", "pwsh", "powershell"] {
        let path = home.join(name);
        std::fs::write(&path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    for platform in ["linux", "darwin", "win32"] {
        let host = PathEnv {
            platform: platform.into(),
            home_dir: home.to_string_lossy().into_owned(),
            env: std::collections::HashMap::from([(
                "PATH".into(),
                home.to_string_lossy().into_owned(),
            )]),
        };
        for (kind, wire) in [
            (RuntimeShellKind::Bash, "bash"),
            (RuntimeShellKind::Zsh, "zsh"),
            (RuntimeShellKind::Powershell, "powershell"),
        ] {
            let advertised =
                !crate::health::shell_path_candidates(kind, host.is_windows()).is_empty();
            let params =
                json!({"kind":wire,"command":"true","timeoutMs":5000,"maxOutputBytes":1000});
            let accepted = prepare_shell(params, &host, 100_000).is_ok();
            assert_eq!(
                accepted, advertised,
                "expected shell.run acceptance of {wire} on {platform}: {advertised} | received: {accepted}"
            );
        }
        let powershell =
            json!({"kind":"powershell","command":"true","timeoutMs":5000,"maxOutputBytes":1000});
        let accepted = prepare_shell(powershell, &host, 100_000).is_ok();
        assert_eq!(
            accepted,
            platform == "win32",
            "expected powershell accepted only on win32 | received: accepted={accepted} on {platform}"
        );
    }
}

/// A shell kind with no executable on `PATH` fails as a shell execution error that names the
/// kind, the same wording the TypeScript runtime used, before anything is launched.
#[test]
fn an_unavailable_shell_kind_is_reported_as_not_available() {
    let home = scratch_dir("commands-shell-unavailable");
    let host = PathEnv {
        platform: "linux".into(),
        home_dir: home.to_string_lossy().into_owned(),
        env: std::collections::HashMap::from([(
            "PATH".into(),
            home.to_string_lossy().into_owned(),
        )]),
    };
    for kind in ["bash", "zsh", "powershell"] {
        let params = json!({"kind":kind,"command":"true","timeoutMs":5000,"maxOutputBytes":1000});
        let Err(error) = prepare_shell(params, &host, 100_000) else {
            panic!("expected shell.run {kind} with an empty PATH to fail | received a launch");
        };
        let expected = format!("The \"{kind}\" shell is not available on this system.");
        assert_eq!(
            error.message, expected,
            "expected message {expected:?} | received {:?}",
            error.message
        );
        let details = error.details.expect("shell errors carry details");
        assert_eq!(
            details["kind"], "shell_execution",
            "expected kind shell_execution | received {}",
            details["kind"]
        );
    }
}

#[test]
fn results_preserve_nonzero_acceptance_incomplete_capture_and_error_details() {
    let prepared = prepare(
        "git.exec",
        json!({"args":["diff"],"cwd":"/repo","acceptedExitCodes":[1]}),
        &PathEnv::default(),
        100_000,
    )
    .unwrap();
    let mut observed = terminal(1);
    observed.stdout.incomplete = true;
    let result = map_terminal("git.exec", &prepared, observed.clone()).unwrap();
    assert_eq!(result["incomplete"], true);
    assert_eq!(result["exitCode"], 1);
    observed.exit.as_mut().unwrap().code = Some(2);
    observed.stderr.bytes = b"failure\n".to_vec();
    let error = map_terminal("git.exec", &prepared, observed.clone()).unwrap_err();
    assert_eq!(error.message, "failure");
    assert_eq!(error.details.unwrap()["stdout"], "output");
    observed.cause = ProcessTerminalCause::TimedOut;
    assert!(
        map_terminal("git.exec", &prepared, observed.clone())
            .unwrap_err()
            .message
            .contains("timed out")
    );
    observed.cause = ProcessTerminalCause::Cancelled;
    assert_eq!(
        map_terminal("git.exec", &prepared, observed)
            .unwrap_err()
            .details
            .unwrap()["aborted"],
        true
    );
}

#[test]
fn shell_result_keeps_natural_signal_and_capture_flags() {
    let prepared = Prepared {
        request: ProcessRequest::new("bash", ["-c", "exit"]),
        shell: Some(("bash".into(), "exit".into())),
        args: Vec::new(),
        accepted: Vec::new(),
    };
    let mut observed = terminal(0);
    observed.exit = Some(ProcessExit {
        success: false,
        code: None,
        signal: Some(ProcessSignal {
            number: 15,
            name: "SIGTERM",
        }),
    });
    observed.stderr.incomplete = true;
    let result = map_terminal("shell.run", &prepared, observed).unwrap();
    assert_eq!(
        result["termination"],
        json!({"kind":"signalled","signal":"SIGTERM"})
    );
    assert_eq!(result["truncated"], true);
    assert_eq!(result["durationMs"], 12.0);
    mangostudio_runtime_contract::schemas::validate_result("shell.run", &result).unwrap();
}

#[test]
fn start_errors_preserve_consent_and_classify_failures() {
    let denied = RemoteError::new(codes::DENIED, "revoked").with_detail("capability", "shell");
    let result = start_error("gh.mutate", &[], ProcessStartError::LaunchDenied(denied));
    assert_eq!(result.code, codes::DENIED);
    for failure in [
        ProcessStartError::LimitExceeded,
        ProcessStartError::SupervisorUnavailable,
        ProcessStartError::TimedOutBeforeStart,
        ProcessStartError::SpawnFailed(std::io::Error::from(std::io::ErrorKind::NotFound)),
    ] {
        assert_eq!(
            start_error("git.exec", &[], failure).details.unwrap()["kind"],
            "git_execution"
        );
    }
    assert_eq!(
        start_error("gh.exec", &[], ProcessStartError::CancelledBeforeStart)
            .details
            .unwrap()["aborted"],
        true
    );
}

#[cfg(unix)]
struct MutationFixtureSpawner {
    ready: PathBuf,
    release: PathBuf,
}

#[cfg(unix)]
impl ProcessSpawner for MutationFixtureSpawner {
    fn start(
        &self,
        mut request: ProcessRequest,
        check: Arc<dyn LaunchCheck>,
        cancel: CancellationToken,
    ) -> ProcessFuture<'_, Result<ProcessControl, ProcessStartError>> {
        request.program = PathBuf::from("/bin/sh");
        request.args = vec![
            "-c".into(),
            "printf ready > \"$1\"; while [ ! -f \"$2\" ]; do sleep 0.01; done; printf completed"
                .into(),
            "mutation-fixture".into(),
            self.ready.clone().into_os_string(),
            self.release.clone().into_os_string(),
        ];
        Box::pin(async move { DefaultProcessSpawner.start(request, check, cancel).await })
    }
}

#[cfg(unix)]
#[tokio::test]
async fn admitted_mutation_finishes_after_the_caller_cancels() {
    let home = scratch_dir("commands-mutation-cancel");
    let ready = home.join("ready");
    let release = home.join("release");
    let service = Service {
        consent: Arc::new(ConsentSource::new(RuntimeSlot::Host, home.to_path_buf())),
        spawner: Arc::new(MutationFixtureSpawner {
            ready: ready.clone(),
            release: release.clone(),
        }),
    };
    let cancel = CancellationToken::new();
    let call_cancel = cancel.clone();
    let params = json!({"args":["pr","create"],"cwd":home.path(),"timeoutMs":5000});
    let call =
        tokio::spawn(async move { service.run("gh.mutate", params, call_cancel, 100_000).await });
    tokio::time::timeout(Duration::from_secs(3), async {
        while !ready.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the fixture must cross the launch boundary before cancellation");
    cancel.cancel();
    tokio::time::sleep(Duration::from_millis(50)).await;
    std::fs::write(release, "release").unwrap();
    let result = call.await.unwrap().unwrap();
    assert_eq!(result["stdout"], "completed");
    assert_eq!(result["exitCode"], 0);
}

#[test]
fn windows_forced_shell_exit_matches_bun_without_rewriting_natural_exits() {
    let mut observed = terminal(1);
    assert_eq!(shell_exit(&observed, true), (Some(1), None));
    for cause in [
        ProcessTerminalCause::TimedOut,
        ProcessTerminalCause::Cancelled,
        ProcessTerminalCause::Forced,
    ] {
        observed.cause = cause;
        assert_eq!(shell_exit(&observed, true), (Some(1), None));
        assert_eq!(cli_exit(&observed, true), Some(1));
        assert_eq!(shell_exit(&observed, false), (Some(1), None));
    }
}

#[test]
fn timed_out_cli_errors_preserve_buns_numeric_signal_exit() {
    let prepared = prepare(
        "git.exec",
        json!({"args":["--version"],"cwd":"/repo"}),
        &PathEnv::default(),
        100_000,
    )
    .unwrap();
    let mut observed = terminal(0);
    observed.cause = ProcessTerminalCause::TimedOut;
    observed.exit = Some(ProcessExit {
        success: false,
        code: None,
        signal: Some(ProcessSignal {
            number: 9,
            name: "SIGKILL",
        }),
    });
    let error = map_terminal("git.exec", &prepared, observed).unwrap_err();
    assert_eq!(
        error.details.unwrap()["exitCode"],
        if cfg!(windows) { 1 } else { 137 }
    );
}

#[test]
fn silent_cli_failures_keep_the_tools_named_error_message() {
    for (method, args, message) in [
        ("git.exec", vec!["--version"], "Git command failed."),
        ("gh.exec", vec!["--version"], "GitHub CLI command failed."),
    ] {
        let prepared = prepare(
            method,
            json!({"args":args,"cwd":"/repo"}),
            &PathEnv::default(),
            100_000,
        )
        .unwrap();
        let mut observed = terminal(1);
        observed.stdout.bytes.clear();
        let error = map_terminal(method, &prepared, observed).unwrap_err();
        assert_eq!(error.message, message);
    }
}

/// Rewrites a `gh.exec` launch into a shell whose background child calls `setsid`, leaving the
/// target's process group and session, then keeps the leader alive until it is stopped.
#[cfg(target_os = "linux")]
struct SessionEscapeeSpawner {
    pid_file: PathBuf,
}

#[cfg(target_os = "linux")]
impl ProcessSpawner for SessionEscapeeSpawner {
    fn start(
        &self,
        mut request: ProcessRequest,
        check: Arc<dyn LaunchCheck>,
        cancel: CancellationToken,
    ) -> ProcessFuture<'_, Result<ProcessControl, ProcessStartError>> {
        request.program = PathBuf::from("/bin/sh");
        request.args = vec![
            "-c".into(),
            "setsid sleep 60 >/dev/null 2>&1 & echo $! > \"$1.tmp\"; mv \"$1.tmp\" \"$1\"; \
             sleep 60"
                .into(),
            "escapee-fixture".into(),
            self.pid_file.clone().into_os_string(),
        ];
        Box::pin(async move { DefaultProcessSpawner.start(request, check, cancel).await })
    }
}

/// `(process group, state)` from `/proc/<pid>/stat`, or `None` once the pid is gone.
#[cfg(target_os = "linux")]
fn linux_process_group_and_state(pid: u32) -> Option<(i32, char)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let mut fields = stat.rsplit_once(')')?.1.split_whitespace();
    let state = fields.next()?.chars().next()?;
    let _parent = fields.next()?;
    let group = fields.next()?.parse().ok()?;
    Some((group, state))
}

/// The TypeScript runtime's process-tree kill reaped a descendant that called `setsid` while its
/// leader was still running. A cancelled ordinary subprocess must not leave that escapee behind.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_cancelled_call_reaps_a_descendant_that_left_its_session() {
    let home = scratch_dir("commands-setsid-escapee");
    let pid_file = home.join("escapee.pid");
    let service = Service {
        consent: Arc::new(ConsentSource::new(RuntimeSlot::Host, home.to_path_buf())),
        spawner: Arc::new(SessionEscapeeSpawner {
            pid_file: pid_file.clone(),
        }),
    };
    let cancel = CancellationToken::new();
    let call_cancel = cancel.clone();
    let params = json!({"args":["pr","list"],"cwd":home.path(),"timeoutMs":30_000});
    let call =
        tokio::spawn(async move { service.run("gh.exec", params, call_cancel, 100_000).await });

    let escapee: u32 = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(text) = std::fs::read_to_string(&pid_file)
                && let Ok(pid) = text.trim().parse()
            {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("expected the fixture to record its setsid child's pid | received nothing in 5s");
    tokio::time::timeout(Duration::from_secs(2), async {
        while linux_process_group_and_state(escapee).map(|(group, _)| group) != Some(escapee as i32)
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("expected the setsid child to lead its own process group | received no change");

    cancel.cancel();
    let result = tokio::time::timeout(Duration::from_secs(15), call)
        .await
        .expect("expected the cancelled call to settle | received: still running after 15s")
        .unwrap();
    assert!(
        result.is_err(),
        "expected the cancelled read to fail | received {result:?}"
    );

    let gone = tokio::time::timeout(Duration::from_secs(10), async {
        while linux_process_group_and_state(escapee).is_some_and(|(_, state)| state != 'Z') {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .is_ok();
    if !gone {
        // Cleanup only, so the failing run does not leak a sleeper; the assertion follows.
        let _ = std::process::Command::new("kill")
            .args(["-KILL", &escapee.to_string()])
            .status();
    }
    assert!(
        gone,
        "expected the setsid escapee {escapee} to be killed with the cancelled call's tree | \
         received: still running 10s after the call settled"
    );
}
