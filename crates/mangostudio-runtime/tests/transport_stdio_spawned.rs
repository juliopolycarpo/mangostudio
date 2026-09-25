//! Spawns the real `mangostudio-runtime stdio` binary as an OS child and
//! completes a handshake over its actual stdin/stdout pipes — the one thing
//! an in-process `NdjsonPort` test cannot prove: that stdout carries
//! protocol frames and nothing else, end to end through a real process.

use std::time::Duration;

use mango_protocol::close::close_codes;
use mango_protocol::session::{Session, SessionOptions};
use mango_protocol::transports::spawn::{SpawnOptions, sanitized_env, spawn_port};

mod support;

use support::scratch::{ScratchDir, scratch_path};

fn binary_path() -> String {
    env!("CARGO_BIN_EXE_mangostudio-runtime").to_string()
}

fn scratch_home(name: &str) -> ScratchDir {
    scratch_path(&format!("transport-stdio-spawn-test-{name}"))
}

/// A fresh `MANGO_HOME` with nothing in it at all resolves to the `host`
/// slot (the binary is not under any `<mango_home>/runtime/<slot>` tree),
/// which starts pre-consented — so the child completes its handshake with
/// no `setup` step required first.
///
/// This is also this crate's proof that stdout carries protocol frames and
/// nothing else: `Session::spawn` reads the child's real stdout through an
/// NDJSON port, and any stray byte on that stream ahead of, between, or
/// inside a frame would desynchronise the parser and fail the handshake or
/// the close below — so a clean pass here means nothing else wrote to it
/// while the port was reading. That window is exactly "while a handshake or
/// session is active"; nothing reads the child's stdout once its driver has
/// stopped, so a `println!` after `exit_code()` returns is not caught by
/// this or any other test in this crate.
#[tokio::test]
async fn a_spawned_stdio_child_completes_the_handshake_over_real_pipes() {
    let home = scratch_home("handshake");
    let env = sanitized_env([(
        "MANGO_HOME".to_string(),
        home.to_string_lossy().into_owned(),
    )]);
    let options = SpawnOptions::new([binary_path(), "stdio".to_string()]).with_env(env);
    let (port, launched) = spawn_port(options).expect("the argv names a real binary");

    let (session, driver) = Session::spawn(port, SessionOptions::new(support::peer("hub")));
    let remote = tokio::time::timeout(Duration::from_secs(10), session.ready())
        .await
        .expect("the child must say hello within the timeout")
        .expect("the handshake succeeds");
    assert_eq!(remote.peer.name, "mangostudio-runtime");
    assert_eq!(remote.peer.role, "runtime");
    assert!(launched.pid().is_some());

    // Release cleanly: the hub side closes, the child exits 0 (see the
    // stdio consent tests in `tests/cli.rs` for the refusal path).
    session
        .close(close_codes::RELEASED, Some("test done"))
        .await;
    let _ = driver.await;
}

/// The hub's `hello.capabilities.hub` names every audit line the stdio
/// child writes after the handshake, as `session.ts` did through `setHub`.
#[tokio::test]
async fn a_hub_hello_identity_names_the_stdio_childs_next_audit_line() {
    let home = scratch_home("hub-identity");
    let env = sanitized_env([(
        "MANGO_HOME".to_string(),
        home.to_string_lossy().into_owned(),
    )]);
    let options = SpawnOptions::new([binary_path(), "stdio".to_string()]).with_env(env);
    let (port, _launched) = spawn_port(options).expect("the argv names a real binary");
    let capabilities = serde_json::json!({ "hub": { "user": "bob", "host": "desk" } });
    let options = SessionOptions::new(support::peer("hub"))
        .with_capabilities(capabilities.as_object().unwrap().clone());
    let (session, driver) = Session::spawn(port, options);
    tokio::time::timeout(Duration::from_secs(10), session.ready())
        .await
        .expect("the child must say hello within the timeout")
        .expect("the handshake succeeds");
    let _ = session
        .request("runtime.health", serde_json::json!({}))
        .await;

    let path = mangostudio_runtime::runtime_home::slot_audit_log_path(
        mangostudio_runtime::runtime_home::RuntimeSlot::Host,
        &home,
    );
    let hub = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let contents = std::fs::read_to_string(&path).unwrap_or_default();
            if let Some(line) = contents.lines().last() {
                let line: serde_json::Value = serde_json::from_str(line).unwrap();
                return line["hub"].as_str().unwrap_or_default().to_string();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "expected an audit line in {} | received: none",
            path.display()
        )
    });
    session
        .close(close_codes::RELEASED, Some("test done"))
        .await;
    let _ = driver.await;
    assert!(
        hub == "bob@desk",
        "expected audit hub: bob@desk | received: {hub}"
    );
}

/// `SIGINT` sent before any hub writes a byte must still exit through this crate's own
/// controlled path (a normal `exit()`, never the process dying to
/// `SIGINT`'s default disposition). Checked directly against the child's
/// real `ExitStatus`, via `ExitStatusExt::signal()`, rather than through a
/// session closure: `mango_protocol`'s own port treats a plain pipe EOF
/// (which is what a signal-killed process's stdout also produces) the same
/// as an ordinary release, so a closure code alone cannot tell "exited
/// cleanly" apart from "was killed" — only the OS exit status can.
///
/// This exercises the handler registered by `ShutdownSignals::install`
/// without completing a handshake. The child must first finish process
/// startup, because no userspace handler can catch a signal sent before the
/// binary runs.
#[cfg(unix)]
#[test]
fn a_sigint_sent_before_any_handshake_still_exits_cleanly_not_killed() {
    use std::os::unix::process::ExitStatusExt as _;

    let home = scratch_home("sigint-before-handshake");
    let mut child = std::process::Command::new(binary_path())
        .arg("stdio")
        .env("MANGO_HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("the binary runs");

    // A pure process-startup race (fork/exec, dynamic linking, the Tokio
    // runtime's own bootstrap) exists before this crate's code runs at
    // all, and no userspace fix can close it — sending the signal with no
    // delay mostly measures *that* race, not the one this test exists for.
    // Give a contended CI host enough time to execute this binary's handler
    // registration. No hub bytes are sent, so the handshake still cannot
    // complete before the signal regardless of this delay.
    std::thread::sleep(std::time::Duration::from_millis(250));
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id().try_into().expect("a pid fits in i32")),
        nix::sys::signal::Signal::SIGINT,
    )
    .expect("this test process may signal its own child");

    let status = wait_bounded(&mut child, SIGNALLED_EXIT_BOUND);
    assert_eq!(
        status.signal(),
        None,
        "the child must exit through its own handler, not be killed by SIGINT's default \
         disposition (status: {status:?})"
    );
}

/// End of stdio input means the hub went away, not that the machine mutation should die with the
/// runtime: an install step that outlives the session's 5-second handler grace still finishes
/// before the process exits. The launcher's own terminate grace is stretched so no signal
/// arrives, as when the hub process itself dies.
#[cfg(unix)]
#[tokio::test]
async fn end_of_input_lets_a_running_install_step_finish_past_the_handler_grace() {
    use std::os::unix::fs::PermissionsExt;

    let home = scratch_home("install-eof");
    let work = scratch_home("install-eof-work");
    std::fs::create_dir_all(&*work).unwrap();
    let started = work.join("started");
    let marker = work.join("installed");
    let installer = work.join("installer.sh");
    std::fs::write(
        &installer,
        format!(
            "#!/bin/sh\necho started > '{}'\nsleep 6\necho run >> '{}'\n",
            started.display(),
            marker.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&installer, std::fs::Permissions::from_mode(0o700)).unwrap();
    let env = sanitized_env([(
        "MANGO_HOME".to_string(),
        home.to_string_lossy().into_owned(),
    )]);
    let mut options = SpawnOptions::new([binary_path(), "stdio".to_string()]).with_env(env);
    options.terminate_grace = Duration::from_secs(60);
    let (port, launched) = spawn_port(options).expect("the argv names a real binary");
    let (session, driver) = Session::spawn(port, SessionOptions::new(support::peer("hub")));
    tokio::time::timeout(Duration::from_secs(10), session.ready())
        .await
        .expect("the child must say hello within the timeout")
        .expect("the handshake succeeds");
    let request = tokio::spawn({
        let session = session.clone();
        let params = serde_json::json!({
            "runId": "eof-install",
            "argv": [installer],
            "timeoutMs": 30_000,
            "logPath": work.join("install.log"),
        });
        async move { session.request("install.run", params).await }
    });
    for _ in 0..500 {
        if started.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(started.exists(), "expected the installer to start");

    session
        .close(close_codes::RELEASED, Some("the hub went away"))
        .await;
    let _ = driver.await;
    let _ = request.await;
    tokio::time::timeout(Duration::from_secs(30), launched.exited())
        .await
        .expect("expected the runtime to exit once the step settled | received: still running");

    assert_eq!(
        std::fs::read_to_string(&marker).ok().as_deref(),
        Some("run\n"),
        "expected the step to finish before the runtime exited | received no completed effect"
    );
}

/// How long a signalled stdio child may take to exit. Generous against a
/// loaded CI runner, and still far below "hung until the job times out".
#[cfg(any(unix, windows))]
const SIGNALLED_EXIT_BOUND: Duration = Duration::from_secs(10);

/// Waits for `child` to exit within `bound`, killing it and failing the test
/// with the elapsed time instead of hanging the whole test binary.
#[cfg(any(unix, windows))]
fn wait_bounded(child: &mut std::process::Child, bound: Duration) -> std::process::ExitStatus {
    let started = std::time::Instant::now();
    loop {
        if let Some(status) = child
            .try_wait()
            .expect("polling a child this process spawned cannot fail")
        {
            return status;
        }
        if started.elapsed() >= bound {
            let _ = child.kill();
            let _ = child.wait();
            panic!(
                "expected the signalled stdio child to exit within {bound:?} | received: still \
                 running after {:?}, killed by the test",
                started.elapsed()
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A shutdown signal that arrives once the child has said `hello` and is
/// waiting on the hub, while the hub still holds the child's stdin open,
/// must end the process. Before the fix the session closed, but dropping the
/// async runtime then waited on its blocking stdin reader, so the process
/// stayed alive until the parent happened to close the pipe.
#[cfg(unix)]
fn assert_exits_after_hello_on(signal: nix::sys::signal::Signal) {
    use std::io::BufRead as _;
    use std::os::unix::process::ExitStatusExt as _;

    let home = scratch_home(&format!("signal-after-hello-{}", signal.as_str()));
    let mut child = std::process::Command::new(binary_path())
        .arg("stdio")
        .env("MANGO_HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("the binary runs");
    // Held until the end of the test: the hub has not gone away.
    let _stdin = child.stdin.take().expect("stdin is piped");
    let mut stdout = std::io::BufReader::new(child.stdout.take().expect("stdout is piped"));
    let mut hello = String::new();
    stdout
        .read_line(&mut hello)
        .expect("the child writes its hello frame");
    assert!(
        hello.contains("hello"),
        "expected the first stdout line to be the hello frame | received {hello:?}"
    );
    // The child starts reading stdin for the hub's reply right after writing
    // `hello`; give that read time to block so the signal lands in the window
    // this test exists for, not just before it.
    std::thread::sleep(Duration::from_millis(300));

    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id().try_into().expect("a pid fits in i32")),
        signal,
    )
    .expect("this test process may signal its own child");

    let status = wait_bounded(&mut child, SIGNALLED_EXIT_BOUND);
    assert_eq!(
        (status.signal(), status.code()),
        (None, Some(0)),
        "expected a clean exit 0 through the runtime's own handler after {signal} | received \
         {status:?}"
    );
}

#[cfg(unix)]
#[test]
fn a_sigint_after_hello_exits_while_the_hub_keeps_stdin_open() {
    assert_exits_after_hello_on(nix::sys::signal::Signal::SIGINT);
}

#[cfg(unix)]
#[test]
fn a_sigterm_after_hello_exits_while_the_hub_keeps_stdin_open() {
    assert_exits_after_hello_on(nix::sys::signal::Signal::SIGTERM);
}

/// The Windows analogue of the two tests above: a console control event that
/// arrives after `hello`, while the hub still holds stdin open, must end the
/// process through the runtime's own handler. The child gets its own process
/// group because `CTRL_C_EVENT` cannot target one; `CTRL_BREAK_EVENT` can,
/// and it reaches only that group, never this test process.
#[cfg(windows)]
#[test]
#[allow(unsafe_code)] // One documented FFI call: no safe binding sends a console control event.
fn a_ctrl_break_after_hello_exits_while_the_hub_keeps_stdin_open() {
    use std::io::BufRead as _;
    use std::os::windows::process::CommandExt as _;
    use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, GenerateConsoleCtrlEvent};
    use windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP;

    let home = scratch_home("signal-after-hello-ctrl-break");
    let mut child = std::process::Command::new(binary_path())
        .arg("stdio")
        .env("MANGO_HOME", &home)
        .creation_flags(CREATE_NEW_PROCESS_GROUP)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("the binary runs");
    // Held until the end of the test: the hub has not gone away.
    let _stdin = child.stdin.take().expect("stdin is piped");
    let mut stdout = std::io::BufReader::new(child.stdout.take().expect("stdout is piped"));
    let mut hello = String::new();
    stdout
        .read_line(&mut hello)
        .expect("the child writes its hello frame");
    assert!(
        hello.contains("hello"),
        "expected the first stdout line to be the hello frame | received {hello:?}"
    );
    // Same window as the Unix tests: let the stdin read block first.
    std::thread::sleep(Duration::from_millis(300));

    // SAFETY: plain FFI call with no pointers; the group id is the child's
    // pid because it was spawned with `CREATE_NEW_PROCESS_GROUP`.
    let delivered = unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, child.id()) };
    if delivered == 0 {
        let error = std::io::Error::last_os_error();
        let _ = child.kill();
        let _ = child.wait();
        panic!(
            "expected GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, {}) to succeed | received {error}",
            child.id()
        );
    }

    let status = wait_bounded(&mut child, SIGNALLED_EXIT_BOUND);
    assert_eq!(
        status.code(),
        Some(0),
        "expected a clean exit 0 through the runtime's own handler after CTRL_BREAK | received \
         {status:?}"
    );
}
