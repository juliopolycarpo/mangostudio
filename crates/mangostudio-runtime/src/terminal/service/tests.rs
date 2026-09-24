use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use mango_protocol::error::codes;
use mango_protocol::frame::PeerInfo;
use mango_protocol::port::port_pair;
use mango_protocol::session::{Session, SessionOptions};
use mangostudio_runtime_contract::manifest::RuntimeShellKind;
use tokio_util::sync::CancellationToken;

use super::{
    AckParams, Entry, OpenParams, ResizeParams, Service, SessionParams, Slot, WriteParams, count,
    default_shell, resolve_cwd, size,
};
use crate::consent::source::ConsentSource;
use crate::probing::detection::path_env::PathEnv;
use crate::runtime_home::RuntimeSlot;
use crate::terminal::flow::TerminalFlow;
use crate::terminal::pty::{PtyFuture, PtyHandle, PtySpawner};
use crate::test_support::ScratchDir;

struct FakePtyHandle {
    closes: Arc<Mutex<usize>>,
}

impl PtyHandle for FakePtyHandle {
    fn pid(&self) -> u32 {
        42
    }

    fn write(&self, _data: Vec<u8>) -> PtyFuture<'_, std::io::Result<()>> {
        Box::pin(async { Ok(()) })
    }

    fn resize(&self, _cols: u16, _rows: u16) -> PtyFuture<'_, std::io::Result<()>> {
        Box::pin(async { Ok(()) })
    }

    fn close(&self) -> PtyFuture<'_, std::io::Result<()>> {
        let closes = Arc::clone(&self.closes);
        Box::pin(async move {
            *closes.lock().unwrap() += 1;
            Ok(())
        })
    }
}

struct FakePtySpawner;

impl PtySpawner for FakePtySpawner {
    fn spawn(
        &self,
        _request: crate::terminal::pty::PtyRequest,
        _check: Arc<dyn crate::subprocess::LaunchCheck>,
        _on_data: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
        _on_exit: Arc<dyn Fn(crate::terminal::pty::PtyExit) + Send + Sync>,
    ) -> PtyFuture<'_, Result<Arc<dyn PtyHandle>, crate::terminal::pty::PtyError>> {
        Box::pin(async { unreachable!("these tests insert a live fake directly") })
    }
}

#[derive(Default)]
struct RecordingPtyState {
    closes: usize,
    writes: Vec<Vec<u8>>,
    sizes: Vec<(u16, u16)>,
    on_data: Option<Arc<dyn Fn(Vec<u8>) + Send + Sync>>,
    on_exit: Option<Arc<dyn Fn(crate::terminal::pty::PtyExit) + Send + Sync>>,
}

struct RecordingPtyHandle(Arc<Mutex<RecordingPtyState>>);

impl PtyHandle for RecordingPtyHandle {
    fn pid(&self) -> u32 {
        1234
    }

    fn write(&self, data: Vec<u8>) -> PtyFuture<'_, std::io::Result<()>> {
        self.0.lock().unwrap().writes.push(data);
        Box::pin(async { Ok(()) })
    }

    fn resize(&self, cols: u16, rows: u16) -> PtyFuture<'_, std::io::Result<()>> {
        self.0.lock().unwrap().sizes.push((cols, rows));
        Box::pin(async { Ok(()) })
    }

    fn close(&self) -> PtyFuture<'_, std::io::Result<()>> {
        self.0.lock().unwrap().closes += 1;
        Box::pin(async { Ok(()) })
    }
}

struct RecordingPtySpawner(Arc<Mutex<RecordingPtyState>>);

impl PtySpawner for RecordingPtySpawner {
    fn spawn(
        &self,
        _request: crate::terminal::pty::PtyRequest,
        check: Arc<dyn crate::subprocess::LaunchCheck>,
        on_data: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
        on_exit: Arc<dyn Fn(crate::terminal::pty::PtyExit) + Send + Sync>,
    ) -> PtyFuture<'_, Result<Arc<dyn PtyHandle>, crate::terminal::pty::PtyError>> {
        let state = Arc::clone(&self.0);
        Box::pin(async move {
            check
                .check()
                .map_err(crate::terminal::pty::PtyError::LaunchDenied)?;
            {
                let mut state = state.lock().unwrap();
                state.on_data = Some(on_data);
                state.on_exit = Some(on_exit);
            }
            Ok(Arc::new(RecordingPtyHandle(state)) as Arc<dyn PtyHandle>)
        })
    }
}

fn fake_session() -> Session {
    let (port, _peer) = port_pair();
    let options = SessionOptions::new(PeerInfo {
        name: "terminal-test".into(),
        version: "0.1.0".into(),
        role: "runtime".into(),
    });
    Session::open(port, options).0
}

fn prepared_service() -> (ScratchDir, Arc<Service>, Arc<Mutex<RecordingPtyState>>) {
    prepared_service_with(|_| {})
}

/// A consent read that blocks well past [`SHORT_READ_TIMEOUT`], then grants.
fn slow_grant() -> super::ShellRead {
    Arc::new(|| {
        std::thread::sleep(std::time::Duration::from_millis(300));
        true
    })
}

const SHORT_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(20);

fn prepared_service_with(
    adjust: impl FnOnce(&mut Service),
) -> (ScratchDir, Arc<Service>, Arc<Mutex<RecordingPtyState>>) {
    let scratch = ScratchDir::created("terminal-service-fake-pty");
    let shell = scratch.join(if cfg!(windows) { "bash.exe" } else { "bash" });
    std::fs::write(&shell, b"fake shell").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let path = scratch.to_string_lossy().into_owned();
    let host = PathEnv {
        platform: if cfg!(windows) { "win32" } else { "linux" }.into(),
        home_dir: path.clone(),
        env: HashMap::from([("PATH".into(), path)]),
    };
    let consent = Arc::new(ConsentSource::new(RuntimeSlot::Host, scratch.join("home")));
    let state = Arc::new(Mutex::new(RecordingPtyState::default()));
    let mut service = Service::new(
        consent,
        Arc::new(RecordingPtySpawner(Arc::clone(&state))),
        Arc::new(move || host.clone()),
    );
    adjust(&mut service);
    (scratch, Arc::new(service), state)
}

fn open_params() -> OpenParams {
    OpenParams {
        session_id: "terminal-1".into(),
        shell: Some(RuntimeShellKind::Bash),
        cwd: None,
        cols: 80.0,
        rows: 24.0,
        env: None,
        env_policy: Default::default(),
        scrollback_bytes: Some(64.0),
        toolchain: None,
    }
}

fn service_with_live_entry(closes: Arc<Mutex<usize>>) -> Service {
    let consent = Arc::new(ConsentSource::new(
        RuntimeSlot::Host,
        PathBuf::from("/nonexistent-mango-terminal-test"),
    ));
    let service = Service::new(
        consent,
        Arc::new(FakePtySpawner),
        Arc::new(PathEnv::default),
    );
    let entry = Arc::new(Entry {
        session_id: "one".into(),
        shell: RuntimeShellKind::Bash,
        cwd: "/tmp".into(),
        size: Mutex::new((80, 24)),
        flow: Arc::new(Mutex::new(TerminalFlow::new(64).unwrap())),
        handle: Arc::new(FakePtyHandle { closes }),
        operation: tokio::sync::Mutex::new(()),
        closed: std::sync::atomic::AtomicBool::new(false),
        consent_revoked: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    });
    *service.sessions.lock().unwrap() = HashMap::from([("one".into(), Slot::Live(entry))]);
    service
}

#[test]
fn terminal_size_and_byte_counts_refuse_bad_shapes() {
    assert_eq!(size(80.0, 2, 500, "cols").unwrap(), 80);
    assert!(
        size(0.0, 2, 500, "cols")
            .unwrap_err()
            .message
            .contains("cols=0")
    );
    assert!(size(80.5, 2, 500, "cols").is_err());
    assert_eq!(count(7.0, "ack bytes").unwrap(), 7);
    assert!(
        count(-1.0, "ack bytes")
            .unwrap_err()
            .message
            .contains("ack bytes=-1")
    );
    assert!(count(f64::NAN, "ack bytes").is_err());
}

#[test]
fn default_shell_prefers_login_shell_only_when_present() {
    let host = PathEnv {
        platform: "linux".into(),
        home_dir: "/home/test".into(),
        env: HashMap::from([("SHELL".into(), "/bin/zsh".into())]),
    };
    assert_eq!(default_shell(&host), RuntimeShellKind::Bash);
}

#[test]
fn missing_cwd_falls_back_to_home() {
    let home = std::env::temp_dir();
    assert_eq!(
        resolve_cwd(Some("/definitely/missing/terminal/path"), &home),
        home
    );
    assert_eq!(resolve_cwd(None, &home), home);
}

#[tokio::test]
async fn closing_a_live_session_is_idempotent_and_removes_it_from_listing() {
    let closes = Arc::new(Mutex::new(0));
    let service = service_with_live_entry(Arc::clone(&closes));
    assert_eq!(service.list().unwrap()["sessions"][0]["pid"], 42);
    service
        .close(SessionParams {
            session_id: "one".into(),
        })
        .await
        .unwrap();
    service
        .close(SessionParams {
            session_id: "one".into(),
        })
        .await
        .unwrap();
    assert_eq!(*closes.lock().unwrap(), 1);
    assert!(
        service.list().unwrap()["sessions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(service.require("one").err().unwrap().code, codes::INTERNAL);
}

#[tokio::test]
async fn revocation_closes_each_live_session() {
    let closes = Arc::new(Mutex::new(0));
    let service = service_with_live_entry(Arc::clone(&closes));
    service.revoke_all(true).await;
    assert_eq!(*closes.lock().unwrap(), 1);
    assert!(
        service.list().unwrap()["sessions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn slow_consent_store_does_not_close_terminals() {
    let closes = Arc::new(Mutex::new(0));
    let mut service = service_with_live_entry(Arc::clone(&closes));
    service.shell_read = slow_grant();
    service.consent_read_timeout = SHORT_READ_TIMEOUT;

    service.poll_consent().await;

    let closed = *closes.lock().unwrap();
    let listed = service.list().unwrap()["sessions"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(
        (closed, listed),
        (0, 1),
        "expected (closes, listed sessions) after a slow consent read: (0, 1) | received \
         ({closed}, {listed})"
    );
}

#[tokio::test]
async fn explicit_shell_denial_on_the_watcher_poll_closes_terminals() {
    let closes = Arc::new(Mutex::new(0));
    let mut service = service_with_live_entry(Arc::clone(&closes));
    let entry = service.require("one").unwrap();
    service.shell_read = Arc::new(|| false);

    service.poll_consent().await;

    let closed = *closes.lock().unwrap();
    let revoked = entry
        .consent_revoked
        .load(std::sync::atomic::Ordering::Acquire);
    assert_eq!(
        (closed, revoked),
        (1, true),
        "expected (closes, consent_revoked) after an explicit denial: (1, true) | received \
         ({closed}, {revoked})"
    );
}

#[tokio::test]
async fn slow_consent_on_write_refuses_the_write_without_closing_the_terminal() {
    let closes = Arc::new(Mutex::new(0));
    let mut service = service_with_live_entry(Arc::clone(&closes));
    service.shell_read = slow_grant();
    service.consent_read_timeout = SHORT_READ_TIMEOUT;

    let refused = service
        .write(WriteParams {
            session_id: "one".into(),
            data: "YQ==".into(),
        })
        .await
        .expect_err("expected an unconfirmed consent read to refuse the write");

    let closed = *closes.lock().unwrap();
    assert_eq!(
        (refused.code.as_str(), closed),
        (codes::UNAVAILABLE, 0),
        "expected (error code, closes): (UNAVAILABLE, 0) | received ({}, {closed})",
        refused.code
    );
}

#[tokio::test]
async fn slow_consent_at_terminal_open_refuses_the_launch() {
    let (_scratch, service, state) = prepared_service_with(|service| {
        service.shell_read = slow_grant();
        service.consent_read_timeout = SHORT_READ_TIMEOUT;
    });

    let refused = service
        .open(open_params(), fake_session(), CancellationToken::new())
        .await
        .expect_err("expected an unconfirmed consent read to refuse terminal.open");

    let closes = state.lock().unwrap().closes;
    let listed = service.list().unwrap()["sessions"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(
        (refused.code.as_str(), closes, listed),
        (codes::UNAVAILABLE, 1, 0),
        "expected (error code, spawned handle closes, listed sessions): (UNAVAILABLE, 1, 0) | \
         received ({}, {closes}, {listed})",
        refused.code
    );
}

#[tokio::test]
async fn cancel_during_the_consent_read_refuses_terminal_open() {
    let cancel = CancellationToken::new();
    let cancel_in_read = cancel.clone();
    let (_scratch, service, state) = prepared_service_with(move |service| {
        service.shell_read = Arc::new(move || {
            cancel_in_read.cancel();
            true
        });
    });

    let refused = service
        .open(open_params(), fake_session(), cancel)
        .await
        .expect_err("expected a cancel during the consent read to refuse terminal.open");

    let closes = state.lock().unwrap().closes;
    let listed = service.list().unwrap()["sessions"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(
        (refused.code.as_str(), closes, listed),
        (codes::CANCELLED, 1, 0),
        "expected (error code, spawned handle closes, listed sessions): (CANCELLED, 1, 0) | \
         received ({}, {closes}, {listed})",
        refused.code
    );
}

#[tokio::test]
async fn explicit_shell_denial_at_terminal_open_refuses_with_denied() {
    let (_scratch, service, state) = prepared_service_with(|service| {
        service.shell_read = Arc::new(|| false);
    });

    let refused = service
        .open(open_params(), fake_session(), CancellationToken::new())
        .await
        .expect_err("expected an explicit shell denial to refuse terminal.open");

    let closes = state.lock().unwrap().closes;
    assert_eq!(
        (refused.code.as_str(), closes),
        (codes::DENIED, 1),
        "expected (error code, spawned handle closes): (DENIED, 1) | received ({}, {closes})",
        refused.code
    );
}

#[tokio::test]
async fn revocation_closes_even_while_a_terminal_operation_is_busy() {
    let closes = Arc::new(Mutex::new(0));
    let service = service_with_live_entry(Arc::clone(&closes));
    let entry = service.require("one").unwrap();
    let _busy = entry.operation.lock().await;

    tokio::time::timeout(
        std::time::Duration::from_millis(100),
        service.revoke_all(true),
    )
    .await
    .expect("revocation must not wait for a blocked terminal write");
    assert_eq!(*closes.lock().unwrap(), 1);
}

#[tokio::test]
async fn close_does_not_wait_for_a_blocked_terminal_write() {
    let closes = Arc::new(Mutex::new(0));
    let service = service_with_live_entry(Arc::clone(&closes));
    let entry = service.require("one").unwrap();
    // A shell that stops reading input keeps `write_all` pending while `write` holds this lock.
    let _busy = entry.operation.lock().await;

    tokio::time::timeout(
        std::time::Duration::from_millis(100),
        service.close(SessionParams {
            session_id: "one".into(),
        }),
    )
    .await
    .expect("terminal.close must not wait for a blocked terminal write")
    .unwrap();
    assert_eq!(*closes.lock().unwrap(), 1);
}

#[tokio::test]
async fn fake_pty_covers_open_attach_write_resize_ack_detach_and_close() {
    let (_scratch, service, state) = prepared_service();
    let session = fake_session();
    let opened = service
        .open(open_params(), session.clone(), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(opened["sessionId"], "terminal-1");
    assert_eq!(opened["pid"], 1234);
    assert_eq!(service.list().unwrap()["sessions"][0]["status"], "running");

    let on_data = state.lock().unwrap().on_data.as_ref().unwrap().clone();
    on_data(b"hello".to_vec());
    let attached = service
        .attach(SessionParams {
            session_id: "terminal-1".into(),
        })
        .unwrap();
    assert_eq!(attached["scrollback"], "aGVsbG8=");
    service
        .write(WriteParams {
            session_id: "terminal-1".into(),
            data: "YQ==".into(),
        })
        .await
        .unwrap();
    service
        .resize(ResizeParams {
            session_id: "terminal-1".into(),
            cols: 100.0,
            rows: 40.0,
        })
        .await
        .unwrap();
    service
        .ack(
            AckParams {
                session_id: "terminal-1".into(),
                bytes: 5.0,
            },
            &session,
        )
        .unwrap();
    assert_eq!(state.lock().unwrap().writes, [b"a".to_vec()]);
    assert_eq!(state.lock().unwrap().sizes, [(100, 40)]);
    service
        .detach(SessionParams {
            session_id: "terminal-1".into(),
        })
        .unwrap();
    assert_eq!(service.list().unwrap()["sessions"][0]["attached"], false);
    service
        .close(SessionParams {
            session_id: "terminal-1".into(),
        })
        .await
        .unwrap();
    assert_eq!(state.lock().unwrap().closes, 1);
}

#[tokio::test]
async fn fake_pty_exit_refuses_write_with_typed_error_and_preserves_native_code() {
    let (_scratch, service, state) = prepared_service();
    let session = fake_session();
    service
        .open(open_params(), session, CancellationToken::new())
        .await
        .unwrap();
    let on_exit = state.lock().unwrap().on_exit.as_ref().unwrap().clone();
    on_exit(crate::terminal::pty::PtyExit {
        code: Some(7),
        signal: None,
    });
    let error = service
        .write(WriteParams {
            session_id: "terminal-1".into(),
            data: "YQ==".into(),
        })
        .await
        .unwrap_err();
    assert_eq!(error.details.unwrap()["kind"], "terminal_exited");
    assert_eq!(service.list().unwrap()["sessions"][0]["exitCode"], 7);
}
