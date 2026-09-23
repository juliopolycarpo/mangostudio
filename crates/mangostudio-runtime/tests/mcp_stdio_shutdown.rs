//! Proves the real runtime binary gives every stdio MCP server its graceful stop when the runtime
//! itself is shutting down, and still leaves before the Hub's SIGKILL.
//!
//! The Hub stops a stdio runtime by ending its stdin, sending SIGTERM two seconds later, and
//! SIGKILL two seconds after that (`TERMINATE_GRACE_MS` + `KILL_GRACE_MS` in
//! `apps/api/src/services/runtime-client/spawn-runtime-child.ts`). A server killed by the
//! runtime's parent-death lease never records `clean-exit`; one released gracefully does.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use mango_protocol::close::close_codes;
use mango_protocol::session::{Session, SessionOptions};
use mango_protocol::transports::spawn::{LaunchedPeer, SpawnOptions, sanitized_env, spawn_port};
use serde_json::{Value, json};

mod support;

use support::scratch::{ScratchDir, scratch_dir, scratch_path};

/// The Hub's end-of-stdin to SIGTERM grace.
const HUB_TERMINATE_GRACE: Duration = Duration::from_secs(2);
/// The Hub's SIGKILL deadline, measured from end of stdin.
const HUB_SIGKILL_DEADLINE: Duration = Duration::from_secs(4);
/// Above the runtime's 1 s shutdown end-of-input cut-off, well below its ordinary 2 s grace.
const COMPRESSED_EOF_GRACE_BOUND: Duration = Duration::from_millis(1_600);

struct Server {
    _work: ScratchDir,
    config: Value,
    log: PathBuf,
}

/// The crate's Bun MCP fixture, recording its stop events to a file under `mode`.
fn server(name: &str, mode: &str) -> Server {
    let work = scratch_dir(&format!("mcp-shutdown-{name}"));
    let log = work.join("shutdown.log");
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcp_server.mjs");
    let path = std::env::var("PATH").expect("the test harness has a PATH that can find bun");
    let config = json!({
        "id": format!("shutdown-{name}"),
        "slug": format!("shutdown-{name}"),
        "transport": "stdio",
        "command": "bun",
        "args": [script.to_string_lossy()],
        "env": {
            "PATH": path,
            "MCP_FIXTURE_SHUTDOWN_LOG": log.to_string_lossy(),
            "MCP_FIXTURE_SHUTDOWN_MODE": mode,
        },
        "url": null,
        "timeoutMs": 10_000,
    });
    Server {
        _work: work,
        config,
        log,
    }
}

async fn start_runtime(home: &ScratchDir) -> (Session, LaunchedPeer, tokio::task::JoinHandle<()>) {
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
    let (session, driver) = Session::spawn(port, SessionOptions::new(support::peer("hub")));
    tokio::time::timeout(Duration::from_secs(10), session.ready())
        .await
        .expect("expected the runtime handshake within ten seconds")
        .expect("expected the runtime handshake to succeed");
    let driver = tokio::spawn(async move {
        let _ = driver.await;
    });
    (session, launched, driver)
}

async fn connect(session: &Session, server: &Server) {
    session
        .request("mcp.connect", json!({ "config": server.config }))
        .await
        .unwrap_or_else(|error| panic!("expected mcp.connect to succeed | received {error:?}"));
}

/// Ends the runtime's stdin the way the Hub's `hub.close()` does.
async fn end_stdin(session: Session, driver: tokio::task::JoinHandle<()>) {
    session
        .close(close_codes::RELEASED, Some("hub closing"))
        .await;
    let _ = driver.await;
}

/// `(event, epoch ms)` lines the fixture recorded, in order.
fn timed_events(log: &Path) -> Vec<(String, u64)> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let (event, at) = line.split_once(' ')?;
            Some((event.to_owned(), at.parse().ok()?))
        })
        .collect()
}

fn events(log: &Path) -> Vec<String> {
    timed_events(log)
        .into_iter()
        .map(|(event, _)| event)
        .collect()
}

/// How long after its end of input `log`'s server was sent SIGTERM.
fn eof_to_term(log: &Path) -> Duration {
    let seen = timed_events(log);
    let at = |name: &str| {
        seen.iter()
            .find(|(event, _)| event == name)
            .map(|(_, at)| *at)
            .unwrap_or_else(|| panic!("expected a {name} event | received {seen:?}"))
    };
    Duration::from_millis(at("term").saturating_sub(at("eof")))
}

/// The server writes `clean-exit` on its own schedule after the runtime exits only if it was
/// never killed; give that write a moment instead of racing it.
async fn assert_events(name: &str, log: &Path, expected: &[&str]) {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let seen = events(log);
        if expected
            .iter()
            .all(|event| seen.iter().any(|line| line == event))
        {
            return;
        }
        if Instant::now() > deadline {
            panic!("expected MCP server {name} to record {expected:?} | received {seen:?}");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn signal(launched: &LaunchedPeer, signal: nix::sys::signal::Signal) {
    let pid = launched.pid().expect("the runtime child has a pid");
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(i32::try_from(pid).expect("pid fits")),
        signal,
    )
    .expect("the test signals its runtime child");
}

#[tokio::test]
async fn stdio_eof_gives_the_mcp_server_its_graceful_stop() {
    let home = scratch_path("mcp-shutdown-eof-home");
    let server = server("eof", "graceful");
    let (session, launched, driver) = start_runtime(&home).await;
    connect(&session, &server).await;

    let started = Instant::now();
    end_stdin(session, driver).await;
    let status = launched.exited().await;
    let took = started.elapsed();

    assert_events("eof", &server.log, &["eof", "clean-exit"]).await;
    assert!(
        took < HUB_SIGKILL_DEADLINE,
        "expected the runtime to exit before the Hub's SIGKILL deadline {HUB_SIGKILL_DEADLINE:?} \
         | received exit {status} after {took:?}"
    );
}

#[tokio::test]
async fn sigint_gives_the_mcp_server_its_graceful_stop() {
    let home = scratch_path("mcp-shutdown-sigint-home");
    let server = server("sigint", "graceful");
    let (session, launched, _driver) = start_runtime(&home).await;
    connect(&session, &server).await;

    signal(&launched, nix::sys::signal::Signal::SIGINT);
    let _ = launched.exited().await;

    assert_events("sigint", &server.log, &["eof", "clean-exit"]).await;
    drop(session);
}

/// Replays the Hub's escalation against servers that ignore end of input: the runtime still
/// asks each one with SIGTERM, concurrently, and leaves before the Hub's SIGKILL.
#[tokio::test]
async fn a_hub_stop_terms_stubborn_servers_concurrently_and_exits_before_sigkill() {
    let home = scratch_path("mcp-shutdown-hub-home");
    let servers = [
        server("hub-one", "ignore-eof"),
        server("hub-two", "ignore-eof"),
        server("hub-three", "stubborn"),
    ];
    let (session, launched, driver) = start_runtime(&home).await;
    for server in &servers {
        connect(&session, server).await;
    }

    let started = Instant::now();
    end_stdin(session, driver).await;
    let exited = tokio::select! {
        status = launched.exited() => Some(status),
        () = tokio::time::sleep_until((started + HUB_TERMINATE_GRACE).into()) => None,
    };
    if exited.is_none() {
        signal(&launched, nix::sys::signal::Signal::SIGTERM);
        let _ = tokio::time::timeout(HUB_SIGKILL_DEADLINE, launched.exited()).await;
    }
    let took = started.elapsed();
    launched.kill();

    assert!(
        took < HUB_SIGKILL_DEADLINE,
        "expected the runtime to exit before the Hub's SIGKILL deadline {HUB_SIGKILL_DEADLINE:?} \
         | received still running after {took:?}"
    );
    assert_events("hub-one", &servers[0].log, &["eof", "term", "clean-exit"]).await;
    assert_events("hub-two", &servers[1].log, &["eof", "term", "clean-exit"]).await;
    assert_events("hub-three", &servers[2].log, &["eof", "term"]).await;
    // The ordinary end-of-input grace is 2 s; shutdown compresses it to 1 s so the SIGTERM grace
    // and the forced kill still fit before the Hub's SIGKILL.
    for server in &servers {
        let waited = eof_to_term(&server.log);
        assert!(
            waited < COMPRESSED_EOF_GRACE_BOUND,
            "expected SIGTERM within {COMPRESSED_EOF_GRACE_BOUND:?} of end of input during \
             shutdown | received {waited:?}"
        );
    }
}
