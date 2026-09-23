//! Proves a stdio MCP server started through the real runtime binary is owned by the runtime's
//! process supervisor: when the runtime dies without running any cleanup code, the server and an
//! ordinary descendant it forked die with it.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use mango_protocol::close::close_codes;
use mango_protocol::session::{Session, SessionOptions};
use mango_protocol::transports::spawn::{SpawnOptions, sanitized_env, spawn_port};
use serde_json::{Value, json};

mod support;

use support::scratch::{ScratchDir, scratch_dir, scratch_path};

struct Fixture {
    _work: ScratchDir,
    config: Value,
    target_pid: PathBuf,
    descendant_pid: PathBuf,
}

/// A stdio MCP server that records its own pid, forks a `sleep` descendant, then becomes the
/// crate's small Bun MCP fixture so the runtime's `initialize` succeeds.
fn fixture(name: &str) -> Fixture {
    use std::os::unix::fs::PermissionsExt;

    let work = scratch_dir(&format!("mcp-ownership-{name}"));
    let target_pid = work.join("target.pid");
    let descendant_pid = work.join("descendant.pid");
    let server = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcp_server.mjs");
    let script = work.join("server.sh");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\necho $$ > {}\nsleep 30 & echo $! > {}\nexec bun {}\n",
            target_pid.display(),
            descendant_pid.display(),
            server.display()
        ),
    )
    .expect("the wrapper script is written");
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))
        .expect("the wrapper script is executable");
    let path = std::env::var("PATH").expect("the test harness has a PATH that can find bun");
    let config = json!({
        "id": format!("ownership-{name}"),
        "slug": format!("ownership-{name}"),
        "transport": "stdio",
        "command": script.to_string_lossy(),
        "args": [],
        "env": { "PATH": path },
        "url": null,
        "timeoutMs": 10_000,
    });
    Fixture {
        _work: work,
        config,
        target_pid,
        descendant_pid,
    }
}

async fn start_runtime(home: &ScratchDir) -> (Session, u32, tokio::task::JoinHandle<()>) {
    let env = sanitized_env([(
        "MANGO_HOME".to_string(),
        home.to_string_lossy().into_owned(),
    )]);
    let options = SpawnOptions::new([
        env!("CARGO_BIN_EXE_mangostudio-runtime").to_string(),
        "stdio".to_string(),
    ])
    .with_env(env);
    let (port, launched) = spawn_port(options).expect("the runtime binary starts");
    let pid = launched.pid().expect("the runtime child has a pid");
    let (session, driver) = Session::spawn(port, SessionOptions::new(support::peer("hub")));
    tokio::time::timeout(Duration::from_secs(10), session.ready())
        .await
        .expect("expected the runtime handshake within ten seconds")
        .expect("expected the runtime handshake to succeed");
    let driver = tokio::spawn(async move {
        let _ = driver.await;
    });
    (session, pid, driver)
}

fn read_pid(path: &Path) -> i32 {
    std::fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("expected pid file {} | received {error}", path.display()))
        .trim()
        .parse()
        .expect("pid files hold one decimal pid")
}

async fn assert_gone(name: &str, path: &Path) {
    let pid = read_pid(path);
    for _ in 0..500 {
        if matches!(
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
            Err(nix::errno::Errno::ESRCH)
        ) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("expected MCP {name} pid {pid} gone after runtime loss | received a live process");
}

#[tokio::test]
async fn a_killed_runtime_takes_its_stdio_mcp_server_tree_with_it() {
    let home = scratch_path("mcp-ownership-sigkill-home");
    let fixture = fixture("sigkill");
    let (session, runtime_pid, _driver) = start_runtime(&home).await;
    let connected = session
        .request("mcp.connect", json!({ "config": fixture.config }))
        .await
        .unwrap_or_else(|error| panic!("expected mcp.connect to succeed | received {error:?}"));
    assert_eq!(connected["capabilities"]["tools"], json!(true));

    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(i32::try_from(runtime_pid).expect("pid fits")),
        nix::sys::signal::Signal::SIGKILL,
    )
    .expect("the test kills its runtime child");

    assert_gone("server", &fixture.target_pid).await;
    assert_gone("descendant", &fixture.descendant_pid).await;
}

#[tokio::test]
async fn disconnect_returns_after_the_server_tree_is_gone() {
    let home = scratch_path("mcp-ownership-disconnect-home");
    let fixture = fixture("disconnect");
    let (session, _pid, driver) = start_runtime(&home).await;
    let server_id = fixture.config["id"].clone();
    session
        .request("mcp.connect", json!({ "config": fixture.config }))
        .await
        .unwrap_or_else(|error| panic!("expected mcp.connect to succeed | received {error:?}"));
    let target = read_pid(&fixture.target_pid);
    let descendant = read_pid(&fixture.descendant_pid);

    let ack = session
        .request("mcp.disconnect", json!({ "serverId": server_id }))
        .await
        .unwrap_or_else(|error| panic!("expected mcp.disconnect to succeed | received {error:?}"));
    assert_eq!(ack, json!({ "ok": true }));
    for (name, pid) in [("server", target), ("descendant", descendant)] {
        assert!(
            matches!(
                nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
                Err(nix::errno::Errno::ESRCH)
            ),
            "expected MCP {name} pid {pid} gone when disconnect answered | received a live process"
        );
    }
    session
        .close(close_codes::RELEASED, Some("test done"))
        .await;
    let _ = driver.await;
}
