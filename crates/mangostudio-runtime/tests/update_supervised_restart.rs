//! A runtime update committed over `serve` or `connect` must restart a
//! supervised runtime.
//!
//! Runs the real binary from a slot's version directory, the way a user
//! service runs it through `current`, and streams `runtime.update.*` to it
//! over a real WebSocket. The commit must answer `restart: "scheduled"`, the
//! runtime must release the hub's session after that answer, and the process
//! must exit with `RUNTIME_UPDATE_EXIT_CODE` so the systemd unit, launchd
//! agent, or Scheduled Task runner relaunches the new `current`.

use std::io::{BufRead as _, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mango_protocol::close::close_codes;
use mango_protocol::session::{Session, SessionOptions};
use mango_protocol::transports::deadline::ConnectDeadline;
use mango_protocol::transports::websocket::WebSocketOptions;
use mango_protocol::transports::websocket::client::{WebSocketConnectOptions, connect_websocket};
use mango_protocol::transports::websocket::server::{AcceptOptions, accept_websocket};
use mangostudio_runtime_contract::strings::RUNTIME_UPDATE_EXIT_CODE;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};

mod support;

use support::scratch::{ScratchDir, scratch_path};

const TOKEN: &str = "update-restart-serve-token";
const NEXT_VERSION: &str = "9.9.9-restart-test";

fn binary_path() -> &'static str {
    env!("CARGO_BIN_EXE_mangostudio-runtime")
}

/// The release the binary reports, the same expression as `src/cli.rs`.
fn installed_version() -> &'static str {
    option_env!("MANGOSTUDIO_RELEASE_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}

fn runtime_file_name() -> &'static str {
    if cfg!(windows) {
        "mangostudio-runtime.exe"
    } else {
        "mangostudio-runtime"
    }
}

/// Runs one CLI step against `home` and fails with its stderr when it fails.
fn run_step(home: &Path, args: &[&str]) {
    let output = Command::new(binary_path())
        .args(args)
        .env("MANGO_HOME", home)
        .output()
        .expect("the runtime binary runs");
    assert!(
        output.status.success(),
        "expected `{}` exit: success | received: {} with stderr {}",
        args.join(" "),
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Places this build in the remote slot's version directory and grants it
/// updates, returning that executable: the one a user service runs through
/// `current`. A hard link (or a copy across filesystems) rather than
/// `install`, which spends about a minute hashing an unoptimized test build.
fn provision_remote_slot(home: &Path) -> PathBuf {
    run_step(
        home,
        &["setup", "--slot", "remote", "--profile", "full", "--yes"],
    );
    let version_dir = home
        .join("runtime")
        .join("remote")
        .join(installed_version());
    std::fs::create_dir_all(&version_dir).expect("the slot version directory is creatable");
    let binary = version_dir.join(runtime_file_name());
    if std::fs::hard_link(binary_path(), &binary).is_err() {
        std::fs::copy(binary_path(), &binary).unwrap_or_else(|error| {
            panic!(
                "expected slot binary at {} | received: {error}",
                binary.display()
            )
        });
    }
    binary
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .expect("an ephemeral loopback port is available")
        .port()
}

/// A running `serve` or `connect` process plus every stderr line it has printed.
struct RuntimeProcess {
    child: Child,
    stderr: mpsc::Receiver<String>,
}

impl RuntimeProcess {
    /// Starts `binary` with `args`, reading its token from `token_variable`.
    fn spawn(binary: &Path, home: &Path, args: &[&str], token_variable: &str) -> Self {
        let mut child = Command::new(binary)
            .args(args)
            .env("MANGO_HOME", home)
            .env(token_variable, TOKEN)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the slot binary starts");
        let stderr = child.stderr.take().expect("stderr was piped");
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            stderr: receiver,
        }
    }

    fn stderr_so_far(&self) -> Vec<String> {
        self.stderr.try_iter().collect()
    }

    fn wait_for_exit(&mut self, budget: Duration) -> Option<ExitStatus> {
        let deadline = Instant::now() + budget;
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait().expect("the child can be polled") {
                return Some(status);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        None
    }
}

impl Drop for RuntimeProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Dials the runtime until it accepts, as the hub's `connectHttpRuntime` does.
async fn dial(port: u16, serve: &RuntimeProcess) -> Session {
    let url = format!("ws://127.0.0.1:{port}/");
    let options = WebSocketConnectOptions::default().with_bearer(TOKEN);
    let started = Instant::now();
    loop {
        let deadline = ConnectDeadline::default().with_timeout(Duration::from_secs(5));
        if let Ok(port) = connect_websocket(&url, &options, &deadline).await {
            let (session, _driver) =
                Session::spawn(port, SessionOptions::new(support::peer("hub")));
            session
                .ready()
                .await
                .expect("the runtime completes its handshake");
            return session;
        }
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "expected serve listening on 127.0.0.1:{port} | received: no listener after 20s, \
             stderr {:?}",
            serve.stderr_so_far()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Streams `bytes` as `NEXT_VERSION` and returns the commit's answer.
async fn stream_update(session: &Session, bytes: &[u8]) -> Value {
    let digest: String = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let begun = session
        .request(
            "runtime.update.begin",
            json!({
                "version": NEXT_VERSION,
                "digest": format!("sha256:{digest}"),
                "totalBytes": bytes.len(),
            }),
        )
        .await
        .unwrap_or_else(|error| panic!("expected runtime.update.begin: ok | received: {error:?}"));
    let session_id = begun["sessionId"].as_str().expect("begin names a session");
    session
        .request(
            "runtime.update.chunk",
            json!({ "sessionId": session_id, "seq": 0, "bytesBase64": STANDARD.encode(bytes) }),
        )
        .await
        .unwrap_or_else(|error| panic!("expected runtime.update.chunk: ok | received: {error:?}"));
    session
        .request("runtime.update.commit", json!({ "sessionId": session_id }))
        .await
        .unwrap_or_else(|error| panic!("expected runtime.update.commit: ok | received: {error:?}"))
}

/// Streams an update over `session` and checks everything a supervisor needs
/// to relaunch the new version: the scheduled answer, the released session,
/// exit code 75, and the committed bytes in the slot.
async fn assert_update_restarts(session: &Session, runtime: &mut RuntimeProcess, home: &Path) {
    let committed = stream_update(session, b"next runtime bytes").await;
    assert_eq!(
        committed["restart"], "scheduled",
        "expected commit restart: \"scheduled\" | received: {committed}"
    );

    let closure = tokio::time::timeout(Duration::from_secs(10), session.closed())
        .await
        .unwrap_or_else(|_| {
            panic!(
                "expected the runtime to release the hub session after the commit | received: \
                 still open after 10s, stderr {:?}",
                runtime.stderr_so_far()
            )
        });
    assert_eq!(
        (closure.code, closure.reason.as_deref()),
        (close_codes::RELEASED, Some("Runtime update committed")),
        "expected the restart close | received: {closure:?}"
    );

    let status = runtime.wait_for_exit(Duration::from_secs(10));
    assert_eq!(
        status.and_then(|status| status.code()),
        Some(i32::from(RUNTIME_UPDATE_EXIT_CODE)),
        "expected runtime exit code: {RUNTIME_UPDATE_EXIT_CODE} | received: {status:?}, stderr \
         {:?}",
        runtime.stderr_so_far()
    );
    let published = home
        .join("runtime")
        .join("remote")
        .join(NEXT_VERSION)
        .join(runtime_file_name());
    assert_eq!(
        std::fs::read(&published).ok().as_deref(),
        Some(&b"next runtime bytes"[..]),
        "expected the committed bytes at {} for the relaunch",
        published.display()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_committed_update_over_serve_exits_for_the_supervisor_to_restart() {
    let home: ScratchDir = scratch_path("update-supervised-restart-serve");
    std::fs::create_dir_all(&*home).expect("scratch home is creatable");
    let binary = provision_remote_slot(&home);
    let port = free_port();
    let listen = format!("127.0.0.1:{port}");
    let mut serve = RuntimeProcess::spawn(
        &binary,
        &home,
        &["serve", "--listen", &listen, "--token", "env"],
        "MANGOSTUDIO_RUNTIME_SERVE_TOKEN",
    );

    let session = dial(port, &serve).await;
    assert_update_restarts(&session, &mut serve, &home).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_committed_update_over_connect_exits_for_the_supervisor_to_restart() {
    let home: ScratchDir = scratch_path("update-supervised-restart-connect");
    std::fs::create_dir_all(&*home).expect("scratch home is creatable");
    let binary = provision_remote_slot(&home);
    let hub = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("the fake hub binds loopback");
    let hub_url = format!("ws://{}/", hub.local_addr().expect("bound address"));
    let mut connect = RuntimeProcess::spawn(
        &binary,
        &home,
        &["connect", "--hub", &hub_url, "--token", "env"],
        "MANGOSTUDIO_RUNTIME_TOKEN",
    );

    let (stream, _peer) = tokio::time::timeout(Duration::from_secs(20), hub.accept())
        .await
        .unwrap_or_else(|_| {
            panic!(
                "expected connect to dial {hub_url} | received: no dial after 20s, stderr {:?}",
                connect.stderr_so_far()
            )
        })
        .expect("the fake hub accepts");
    let port = accept_websocket(
        stream,
        AcceptOptions::from(WebSocketOptions::default()),
        |upgrade| {
            if upgrade.bearer() == Some(TOKEN) {
                Ok(())
            } else {
                Err(close_codes::UNAUTHORIZED)
            }
        },
    )
    .await
    .expect("the runtime completes the WebSocket upgrade");
    let (session, _driver) = Session::spawn(port, SessionOptions::new(support::peer("hub")));
    session
        .ready()
        .await
        .expect("the runtime completes its handshake");
    assert_update_restarts(&session, &mut connect, &home).await;
}
