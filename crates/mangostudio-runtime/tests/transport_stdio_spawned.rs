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

/// `SIGINT` sent as early as this test can manage — before any hub ever
/// writes a byte, so the child is still somewhere in its own startup
/// (consent read, host build, contract parse, `Session::open`) rather than
/// waiting on a `hello` — must still exit through this crate's own
/// controlled path (a normal `exit()`, never the process dying to
/// `SIGINT`'s default disposition). Checked directly against the child's
/// real `ExitStatus`, via `ExitStatusExt::signal()`, rather than through a
/// session closure: `mango_protocol`'s own port treats a plain pipe EOF
/// (which is what a signal-killed process's stdout also produces) the same
/// as an ordinary release, so a closure code alone cannot tell "exited
/// cleanly" apart from "was killed" — only the OS exit status can.
///
/// The regression this guards: `Signals::install` used to register `SIGTERM`
/// only, leaving `SIGINT` to a `tokio::signal::ctrl_c()` call inside `wait()`
/// itself — a future whose own documentation says its listener is installed
/// "when first polled", not when called. Everything `stdio::run` does
/// between `Signals::install` and that first poll (consent, `build_host`,
/// `Contract::from_catalog`, `Session::open`) was an uncovered window.
///
/// Best-effort on timing, not a guaranteed race window: nothing in
/// userspace can register a handler before the OS has even finished
/// exec'ing the binary, so an adversarially-early signal can still hit the
/// process's default disposition regardless of this fix — that earlier gap
/// is not what this test (or the code change) claims to close. What is
/// closed is the *later* gap this crate's own code controlled.
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
    // This delay is an empirical compromise: long enough to almost always
    // land after `Signals::install`, short enough to still land well
    // before a healthy handshake could ever complete.
    std::thread::sleep(std::time::Duration::from_millis(15));
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id().try_into().expect("a pid fits in i32")),
        nix::sys::signal::Signal::SIGINT,
    )
    .expect("this test process may signal its own child");

    let status = child
        .wait()
        .expect("waiting on a child this process spawned cannot fail");
    assert_eq!(
        status.signal(),
        None,
        "the child must exit through its own handler, not be killed by SIGINT's default \
         disposition (status: {status:?})"
    );
}
