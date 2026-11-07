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
    default_shell, prepare, resolve_cwd, size,
};
use crate::consent::source::ConsentSource;
use crate::probing::detection::path_env::PathEnv;
use crate::runtime_home::RuntimeSlot;
use crate::terminal::flow::TerminalFlow;
use crate::terminal::pty::{PtyFuture, PtyHandle, PtyOutput, PtySpawner};
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

    fn close_is_settled(&self) -> bool {
        false
    }

    fn close(&self) -> PtyFuture<'_, std::io::Result<()>> {
        let closes = Arc::clone(&self.closes);
        Box::pin(async move {
            *closes.lock().unwrap() += 1;
            Ok(())
        })
    }
}

struct StalledClosePtyHandle {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
    settled: std::sync::atomic::AtomicBool,
    fail_on_release: bool,
}

impl PtyHandle for StalledClosePtyHandle {
    fn pid(&self) -> u32 {
        43
    }

    fn write(&self, _data: Vec<u8>) -> PtyFuture<'_, std::io::Result<()>> {
        unreachable!("expired login must not receive writes")
    }

    fn resize(&self, _cols: u16, _rows: u16) -> PtyFuture<'_, std::io::Result<()>> {
        unreachable!("expired login must not receive resizes")
    }

    fn close_is_settled(&self) -> bool {
        self.settled.load(std::sync::atomic::Ordering::Acquire)
    }

    fn close(&self) -> PtyFuture<'_, std::io::Result<()>> {
        Box::pin(async {
            self.entered.notify_one();
            self.release.notified().await;
            self.settled
                .store(true, std::sync::atomic::Ordering::Release);
            if self.fail_on_release {
                Err(std::io::Error::other("injected settled PTY close failure"))
            } else {
                Ok(())
            }
        })
    }
}

struct FakePtySpawner;

impl PtySpawner for FakePtySpawner {
    fn spawn(
        &self,
        _request: crate::terminal::pty::PtyRequest,
        _check: Arc<dyn crate::subprocess::LaunchCheck>,
        _on_data: PtyOutput,
        _on_exit: Arc<dyn Fn(crate::terminal::pty::PtyExit) + Send + Sync>,
    ) -> PtyFuture<'_, Result<Arc<dyn PtyHandle>, crate::terminal::pty::PtyError>> {
        Box::pin(async { unreachable!("these tests insert a live fake directly") })
    }
}

#[derive(Default)]
struct RecordingPtyState {
    closes: usize,
    close_failures: usize,
    settles_on_close_failure: bool,
    launches: Vec<(PathBuf, Vec<std::ffi::OsString>)>,
    writes: Vec<Vec<u8>>,
    sizes: Vec<(u16, u16)>,
    on_data: Option<PtyOutput>,
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

    fn close_is_settled(&self) -> bool {
        let state = self.0.lock().unwrap();
        state.closes > 0 && state.settles_on_close_failure
    }

    fn close(&self) -> PtyFuture<'_, std::io::Result<()>> {
        let mut state = self.0.lock().unwrap();
        state.closes += 1;
        let result = if state.close_failures > 0 {
            state.close_failures -= 1;
            Err(std::io::Error::other(
                "injected transient PTY close failure",
            ))
        } else {
            Ok(())
        };
        Box::pin(async move { result })
    }
}

struct RecordingPtySpawner(Arc<Mutex<RecordingPtyState>>);

impl PtySpawner for RecordingPtySpawner {
    fn spawn(
        &self,
        request: crate::terminal::pty::PtyRequest,
        check: Arc<dyn crate::subprocess::LaunchCheck>,
        on_data: PtyOutput,
        on_exit: Arc<dyn Fn(crate::terminal::pty::PtyExit) + Send + Sync>,
    ) -> PtyFuture<'_, Result<Arc<dyn PtyHandle>, crate::terminal::pty::PtyError>> {
        let state = Arc::clone(&self.0);
        Box::pin(async move {
            check
                .check()
                .map_err(crate::terminal::pty::PtyError::LaunchDenied)?;
            {
                let mut state = state.lock().unwrap();
                state.launches.push((request.program, request.args));
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

async fn finish_close_jobs(service: &Arc<Service>) {
    let mut jobs = tokio::task::JoinSet::new();
    service.schedule_closes(&mut jobs);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while let Some(result) = jobs.join_next().await {
            result.expect("terminal cleanup task completes");
        }
    })
    .await
    .expect("expected terminal cleanup to settle within two seconds");
}

fn open_params() -> OpenParams {
    OpenParams {
        session_id: "terminal-1".into(),
        shell: Some(RuntimeShellKind::Bash),
        login_target: None,
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
    let entry = fake_entry("one", Arc::new(FakePtyHandle { closes }));
    *service.sessions.lock().unwrap() = HashMap::from([("one".into(), Slot::Live(entry))]);
    service
}

fn fake_entry(id: &str, handle: Arc<dyn PtyHandle>) -> Arc<Entry> {
    Arc::new(Entry {
        session_id: id.into(),
        shell: RuntimeShellKind::Bash,
        cwd: "/tmp".into(),
        size: Mutex::new((80, 24)),
        flow: Arc::new(Mutex::new(TerminalFlow::new(64).unwrap())),
        handle,
        operation: tokio::sync::Mutex::new(()),
        closed: std::sync::atomic::AtomicBool::new(false),
        close_scheduled: std::sync::atomic::AtomicBool::new(false),
        close_result: tokio::sync::Mutex::new(None),
        consent_revoked: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    })
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

/// The terminal offers exactly the shells `detect_shells` may advertise:
/// PowerShell only on Windows, even with `pwsh` on a non-Windows `PATH`.
#[cfg(unix)]
#[test]
fn terminal_offers_powershell_only_on_windows() {
    use super::shell_program;
    use std::os::unix::fs::PermissionsExt;
    let dir = crate::test_support::scratch_dir("terminal-shell-parity");
    for name in ["pwsh", "powershell"] {
        let path = dir.join(name);
        std::fs::write(&path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    for platform in ["linux", "darwin", "win32"] {
        let host = PathEnv {
            platform: platform.into(),
            home_dir: dir.to_string_lossy().into_owned(),
            env: HashMap::from([("PATH".into(), dir.to_string_lossy().into_owned())]),
        };
        let program = shell_program(RuntimeShellKind::Powershell, &host).ok();
        assert_eq!(
            program.is_some(),
            platform == "win32",
            "expected terminal powershell only on win32 | received: {program:?} on {platform}"
        );
    }
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
    let service = Arc::new(service);
    service.revoke_entries(true);
    finish_close_jobs(&service).await;
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

    let service = Arc::new(service);
    let mut jobs = tokio::task::JoinSet::new();
    service.poll_consent(&mut jobs).await;
    while let Some(result) = jobs.join_next().await {
        result.unwrap();
    }

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

    let service = Arc::new(service);
    let mut jobs = tokio::task::JoinSet::new();
    service.poll_consent(&mut jobs).await;
    while let Some(result) = jobs.join_next().await {
        result.unwrap();
    }

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

    tokio::time::timeout(std::time::Duration::from_millis(100), async {
        let service = Arc::new(service);
        service.revoke_entries(true);
        finish_close_jobs(&service).await;
    })
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
    on_data(b"hello");
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

/// A host on `platform` whose `PATH` is one scratch directory holding a fake of each `shells`
/// name. Files without an extension resolve on every OS, so these run on every CI host.
fn host_with_shells(label: &str, platform: &str, shells: &[&str]) -> (ScratchDir, PathEnv) {
    let scratch = ScratchDir::created(label);
    for name in shells {
        let path = scratch.join(name);
        std::fs::write(&path, b"fake shell").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    let path = scratch.to_string_lossy().into_owned();
    let host = PathEnv {
        platform: platform.into(),
        home_dir: path.clone(),
        env: HashMap::from([("PATH".into(), path)]),
    };
    (scratch, host)
}

#[tokio::test]
async fn a_duplicate_terminal_session_id_is_refused() {
    let (_scratch, service, state) = prepared_service();
    service
        .open(open_params(), fake_session(), CancellationToken::new())
        .await
        .unwrap();
    let error = service
        .open(open_params(), fake_session(), CancellationToken::new())
        .await
        .expect_err("expected a second open of terminal-1 to be refused | received a session");
    assert_eq!(
        (
            error.code.as_str(),
            error.details.as_ref().map(|d| d["kind"].clone())
        ),
        (codes::INTERNAL, Some(serde_json::json!("tool_argument"))),
        "expected a tool_argument refusal | received {error:?}"
    );
    assert!(
        error.message.contains("\"terminal-1\"") && error.message.contains("fresh"),
        "expected the refusal to name the id and ask for a fresh one | received {:?}",
        error.message
    );
    assert_eq!(
        service.list().unwrap()["sessions"].as_array().map(Vec::len),
        Some(1),
        "expected the first session to stay the only one"
    );
    assert_eq!(
        state.lock().unwrap().closes,
        0,
        "expected the live session left open"
    );
}

#[test]
fn windows_prefers_powershell_over_a_path_bash_and_falls_back_to_bash() {
    let (_all, mut host) =
        host_with_shells("terminal-win-shells", "win32", &["bash", "zsh", "pwsh"]);
    host.env.insert("SHELL".into(), "/usr/bin/bash".into());
    let chosen = default_shell(&host);
    assert_eq!(
        chosen,
        RuntimeShellKind::Powershell,
        "expected PowerShell on win32 even with bash on PATH | received {chosen:?}"
    );
    let (_bash, host) = host_with_shells("terminal-win-bash", "win32", &["bash"]);
    let chosen = default_shell(&host);
    assert_eq!(
        chosen,
        RuntimeShellKind::Bash,
        "expected bash on win32 without PowerShell | received {chosen:?}"
    );
}

#[test]
fn an_unavailable_explicit_shell_is_refused() {
    let (_scratch, host) = host_with_shells("terminal-no-zsh", "linux", &["bash"]);
    for shell in [RuntimeShellKind::Zsh, RuntimeShellKind::Powershell] {
        let mut params = open_params();
        params.shell = Some(shell);
        let Err(error) = prepare(params, host.clone()) else {
            panic!("expected an unavailable {shell:?} to be refused | received a launch request");
        };
        let wire = serde_json::to_value(shell).unwrap();
        let expected = format!(
            "The \"{}\" shell is not available on this system.",
            wire.as_str().unwrap()
        );
        assert_eq!(
            error.message, expected,
            "expected {expected:?} | received {:?}",
            error.message
        );
        assert_eq!(
            error.details.unwrap()["kind"],
            "shell_execution",
            "expected kind shell_execution for {shell:?}"
        );
    }
}

#[test]
fn the_session_env_layers_terminal_markers_and_caller_env_and_drops_secrets() {
    let (_scratch, mut host) = host_with_shells("terminal-env", "linux", &["bash"]);
    host.env.insert("ANTHROPIC_API_KEY".into(), "secret".into());
    host.env.insert("TERM".into(), "dumb".into());
    let mut params = open_params();
    params.env = Some(std::collections::BTreeMap::from([(
        "CUSTOM".into(),
        "value".into(),
    )]));
    let prepared = prepare(params, host.clone()).unwrap();
    let env = prepared
        .request
        .env
        .expect("a terminal replaces the environment");
    let get = |key: &str| env.get(std::ffi::OsStr::new(key)).and_then(|v| v.to_str());
    for (key, expected) in [
        ("PATH", host.env["PATH"].as_str()),
        ("TERM", "xterm-256color"),
        ("COLORTERM", "truecolor"),
        ("MANGOSTUDIO_TERMINAL", "1"),
        ("CUSTOM", "value"),
    ] {
        assert_eq!(
            get(key),
            Some(expected),
            "expected {key}={expected:?} in the terminal env | received {:?}",
            get(key)
        );
    }
    assert_eq!(
        get("ANTHROPIC_API_KEY"),
        None,
        "expected the provider secret dropped from the terminal env"
    );
}

#[test]
fn darwin_launches_a_login_shell_and_other_platforms_do_not() {
    for (platform, expected) in [("darwin", vec!["-l"]), ("linux", vec![])] {
        let (_scratch, host) = host_with_shells("terminal-login", platform, &["bash"]);
        let prepared = prepare(open_params(), host).unwrap();
        let args: Vec<_> = prepared
            .request
            .args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args, expected,
            "expected bash args {expected:?} on {platform} | received {args:?}"
        );
    }
}

#[tokio::test]
async fn descriptor_login_reaches_fake_pty_without_a_shell_or_credentials() {
    let (scratch, service, state) = prepared_service_with(|service| {
        service.shell_read = Arc::new(|| true);
    });
    let program = scratch.join(if cfg!(windows) { "codex.exe" } else { "codex" });
    std::fs::copy(
        scratch.join(if cfg!(windows) { "bash.exe" } else { "bash" }),
        &program,
    )
    .unwrap();
    let mut params = open_params();
    params.shell = None;
    params.login_target = Some("codex".into());
    // The freshness check reads the real consent fixture, exactly as a shell launch does.
    let session = fake_session();
    service
        .open(params, session.clone(), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        state.lock().unwrap().launches,
        vec![(program, vec![std::ffi::OsString::from("login")])]
    );
    let on_data = state.lock().unwrap().on_data.clone().unwrap();
    on_data(b"first prompt");
    let attached = service
        .attach(SessionParams {
            session_id: "terminal-1".into(),
        })
        .unwrap();
    assert_eq!(attached["scrollback"], "Zmlyc3QgcHJvbXB0");
    service
        .close(SessionParams {
            session_id: "terminal-1".into(),
        })
        .await
        .unwrap();
}

#[test]
fn login_refuses_shell_or_environment_overrides_and_unknown_targets() {
    let (_scratch, host) = host_with_shells("login-refusals", "linux", &["bash"]);
    let mut params = open_params();
    params.login_target = Some("codex".into());
    assert!(prepare(params, host.clone()).is_err());
    let mut params = open_params();
    params.shell = None;
    params.login_target = Some("codex".into());
    params.env_policy.deny.push("CODEX_HOME".into());
    let Err(error) = prepare(params, host.clone()) else {
        panic!("expected login to refuse an environment override");
    };
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details["kind"].as_str()),
        Some("tool_argument"),
        "expected a login environment override to fail validation | received {error:?}"
    );
    assert!(
        error
            .message
            .contains("without shell or environment overrides")
    );
    let mut params = open_params();
    params.shell = None;
    params.login_target = Some("codex; touch marker".into());
    assert!(prepare(params, host).is_err());
}

#[tokio::test]
async fn stalled_login_expiry_does_not_block_consent_revocation() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    use tokio::sync::Notify;

    let closes = Arc::new(Mutex::new(0));
    let mut service = service_with_live_entry(Arc::clone(&closes));
    let granted = Arc::new(AtomicBool::new(true));
    service.shell_read = {
        let granted = Arc::clone(&granted);
        Arc::new(move || granted.load(Ordering::Acquire))
    };
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let login = fake_entry(
        "login",
        Arc::new(StalledClosePtyHandle {
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
            settled: std::sync::atomic::AtomicBool::new(false),
            fail_on_release: false,
        }),
    );
    {
        let mut flow = login.flow.lock().unwrap();
        flow.enable_login();
        flow.on_data(&vec![b'x'; 64 * 1024 + 1], &mut |_| panic!("no viewer"));
    }
    service
        .sessions
        .lock()
        .unwrap()
        .insert("login".into(), Slot::Live(login));
    let service = Arc::new(service);
    let options = |role: &str| {
        SessionOptions::new(PeerInfo {
            name: "terminal-watcher-test".into(),
            version: "0.1.0".into(),
            role: role.into(),
        })
    };
    let (runtime_port, hub_port) = port_pair();
    let (runtime, _runtime_driver) = Session::spawn(runtime_port, options("runtime"));
    let (_hub, _hub_driver) = Session::spawn(hub_port, options("hub"));
    runtime
        .ready()
        .await
        .expect("terminal watcher test handshake");
    service.start_watcher(runtime);
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .expect("expected watcher to attempt closing the overflowed login");
    granted.store(false, Ordering::Release);

    let revoked = tokio::time::timeout(Duration::from_secs(2), async {
        while *closes.lock().unwrap() == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    release.notify_waiters();
    assert!(
        revoked.is_ok(),
        "expected consent withdrawal to close the ordinary terminal while login cleanup is stalled | received {} close attempts",
        *closes.lock().unwrap()
    );
}

#[tokio::test]
async fn login_overflow_refuses_pty_operations_before_the_watcher_closes() {
    let (scratch, service, state) = prepared_service_with(|service| {
        service.shell_read = Arc::new(|| true);
        service
            .watcher_started
            .store(true, std::sync::atomic::Ordering::Release);
    });
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    std::fs::copy(
        scratch.join(format!("bash{suffix}")),
        scratch.join(format!("codex{suffix}")),
    )
    .unwrap();
    let mut params = open_params();
    params.shell = None;
    params.login_target = Some("codex".into());
    service
        .open(params, fake_session(), CancellationToken::new())
        .await
        .unwrap();
    let on_data = state.lock().unwrap().on_data.clone().unwrap();
    on_data(&vec![b'x'; 64 * 1024 + 1]);

    let attached = service.attach(SessionParams {
        session_id: "terminal-1".into(),
    });
    let written = service
        .write(WriteParams {
            session_id: "terminal-1".into(),
            data: "eA==".into(),
        })
        .await;
    let resized = service
        .resize(ResizeParams {
            session_id: "terminal-1".into(),
            cols: 90.0,
            rows: 25.0,
        })
        .await;

    state.lock().unwrap().close_failures = 1;
    let mut closes = tokio::task::JoinSet::new();
    service.schedule_closes(&mut closes);
    closes.join_next().await.unwrap().unwrap();
    assert!(
        service.sessions.lock().unwrap().contains_key("terminal-1"),
        "expected expiry to retain the handle after a transient close failure"
    );
    assert!(service.require("terminal-1").is_err());
    service.schedule_closes(&mut closes);
    closes.join_next().await.unwrap().unwrap();
    for (method, result) in [
        ("attach", attached),
        ("write", written),
        ("resize", resized),
    ] {
        let error = result.expect_err(&format!(
            "expected terminal.{method} to refuse an expired login"
        ));
        assert_eq!(error.details.unwrap()["kind"], "terminal_not_found");
    }
    let state = state.lock().unwrap();
    assert_eq!(
        (state.writes.len(), state.sizes.len(), state.closes),
        (0, 0, 2)
    );
    assert_eq!(service.list().unwrap()["sessions"], serde_json::json!([]));
}

#[test]
fn windows_login_resolves_native_executable_with_mixed_case_path() {
    let (scratch, mut host) = host_with_shells(
        "terminal-win-login",
        "win32",
        &["codex", "codex.cmd", "codex.exe"],
    );
    let path = host.env.remove("PATH").unwrap();
    host.env.insert("Path".into(), path);
    let mut params = open_params();
    params.shell = None;
    params.login_target = Some("codex".into());
    let launch = prepare(params, host.clone()).expect("expected Path to locate codex.exe");
    assert_eq!(launch.request.program, scratch.join("codex.exe"));

    std::fs::remove_file(scratch.join("codex.exe")).unwrap();
    let mut params = open_params();
    params.shell = None;
    params.login_target = Some("codex".into());
    let Err(error) = prepare(params, host) else {
        panic!("expected login to refuse bare and batch shims on Windows");
    };
    assert_eq!(error.code, codes::UNAVAILABLE);
    assert!(error.message.contains("Copy the command instead."));
}

#[cfg(unix)]
#[test]
fn relative_login_path_is_pinned_before_changing_working_directory() {
    let (scratch, mut host) = host_with_shells("terminal-relative-login", "linux", &["codex"]);
    let current = std::env::current_dir().unwrap();
    let relative: PathBuf = current.components().skip(1).map(|_| "..").collect();
    let relative = relative.join(scratch.strip_prefix("/").unwrap());
    host.env
        .insert("PATH".into(), relative.to_string_lossy().into_owned());
    let mut params = open_params();
    params.shell = None;
    params.login_target = Some("codex".into());
    let launch = prepare(params, host).expect("expected relative PATH to locate codex");
    assert!(
        launch.request.program.is_absolute(),
        "expected the located executable pinned before chdir | received {:?}",
        launch.request.program
    );
    assert_eq!(
        launch.request.program.canonicalize().unwrap(),
        scratch.join("codex").canonicalize().unwrap()
    );
}

#[tokio::test]
async fn failed_terminal_close_retries_the_same_handle_and_blocks_input() {
    let state = Arc::new(Mutex::new(RecordingPtyState {
        close_failures: 1,
        ..Default::default()
    }));
    let service = service_with_live_entry(Arc::new(Mutex::new(0)));
    service.sessions.lock().unwrap().insert(
        "one".into(),
        Slot::Live(fake_entry(
            "one",
            Arc::new(RecordingPtyHandle(Arc::clone(&state))),
        )),
    );
    let params = || SessionParams {
        session_id: "one".into(),
    };

    let error = service
        .close(params())
        .await
        .expect_err("first native close fails");
    assert!(
        error
            .message
            .contains("injected transient PTY close failure")
    );
    assert!(
        service.attach(params()).is_err(),
        "closing terminal refuses attachment"
    );
    assert!(
        service
            .write(WriteParams {
                session_id: "one".into(),
                data: "eA==".into()
            })
            .await
            .is_err()
    );

    service
        .close(params())
        .await
        .expect("retry closes the same child");
    let state = state.lock().unwrap();
    assert_eq!(
        state.closes, 2,
        "expected the close retry to reach the retained PTY handle"
    );
    assert!(state.writes.is_empty());
    assert!(service.sessions.lock().unwrap().is_empty());
}

#[tokio::test]
async fn failed_consent_revocation_retains_the_handle_for_cleanup() {
    let state = Arc::new(Mutex::new(RecordingPtyState {
        close_failures: 1,
        ..Default::default()
    }));
    let service = service_with_live_entry(Arc::new(Mutex::new(0)));
    service.sessions.lock().unwrap().insert(
        "one".into(),
        Slot::Live(fake_entry(
            "one",
            Arc::new(RecordingPtyHandle(Arc::clone(&state))),
        )),
    );

    let service = Arc::new(service);
    service.revoke_entries(true);
    finish_close_jobs(&service).await;
    assert!(
        service.require("one").is_err(),
        "revoked terminal refuses effects"
    );
    service
        .close(SessionParams {
            session_id: "one".into(),
        })
        .await
        .unwrap();
    assert_eq!(
        state.lock().unwrap().closes,
        2,
        "expected a cleanup retry to reach the native handle after consent withdrawal"
    );
    assert!(service.sessions.lock().unwrap().is_empty());
}

#[tokio::test]
async fn concurrent_terminal_closes_wait_for_one_native_settlement() {
    use futures_util::FutureExt;
    use std::pin::pin;
    use tokio::sync::Notify;

    for fail_on_release in [false, true] {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let service = service_with_live_entry(Arc::new(Mutex::new(0)));
        service.sessions.lock().unwrap().insert(
            "one".into(),
            Slot::Live(fake_entry(
                "one",
                Arc::new(StalledClosePtyHandle {
                    entered: Arc::clone(&entered),
                    release: Arc::clone(&release),
                    settled: std::sync::atomic::AtomicBool::new(false),
                    fail_on_release,
                }),
            )),
        );
        let params = || SessionParams {
            session_id: "one".into(),
        };
        let mut first = pin!(service.close(params()));
        assert!(futures_util::poll!(&mut first).is_pending());
        entered.notified().await;
        let mut duplicate = pin!(service.close(params()));
        assert!(
            futures_util::poll!(&mut duplicate).is_pending(),
            "expected duplicate close to wait until the retained handle settles"
        );
        release.notify_waiters();
        for result in [first.await, duplicate.await] {
            assert_eq!(
                result.is_err(),
                fail_on_release,
                "concurrent callers share the native result"
            );
            if let Err(error) = result {
                assert!(error.message.contains("injected settled PTY close failure"));
            }
        }
        assert!(
            entered.notified().now_or_never().is_none(),
            "expected one native close"
        );
    }
}
#[tokio::test]
async fn cancelled_terminal_open_keeps_a_spawned_handle_when_cleanup_fails() {
    let cancel = CancellationToken::new();
    let cancel_in_read = cancel.clone();
    let (_scratch, service, state) = prepared_service_with(move |service| {
        service
            .watcher_started
            .store(true, std::sync::atomic::Ordering::Release);
        service.shell_read = Arc::new(move || {
            cancel_in_read.cancel();
            true
        });
    });
    state.lock().unwrap().close_failures = 1;

    let refused = service
        .open(open_params(), fake_session(), cancel)
        .await
        .expect_err("open cancelled after the PTY spawned");
    assert!(
        refused
            .message
            .contains("injected transient PTY close failure")
    );
    assert_eq!(service.list().unwrap()["sessions"], serde_json::json!([]));

    service
        .close(SessionParams {
            session_id: "terminal-1".into(),
        })
        .await
        .unwrap();
    assert_eq!(
        state.lock().unwrap().closes,
        2,
        "expected cleanup retry to reach the spawned but unadmitted terminal"
    );
}

#[tokio::test]
async fn expired_terminal_releases_its_slot_after_a_settled_cleanup_error() {
    let state = Arc::new(Mutex::new(RecordingPtyState {
        close_failures: usize::MAX,
        settles_on_close_failure: true,
        ..Default::default()
    }));
    let service = Arc::new(service_with_live_entry(Arc::new(Mutex::new(0))));
    let entry = fake_entry("one", Arc::new(RecordingPtyHandle(Arc::clone(&state))));
    {
        let mut flow = entry.flow.lock().unwrap();
        flow.enable_login();
        flow.on_data(&vec![b'x'; 64 * 1024 + 1], &mut |_| panic!("no viewer"));
    }
    service
        .sessions
        .lock()
        .unwrap()
        .insert("one".into(), Slot::Live(entry));
    let mut jobs = tokio::task::JoinSet::new();

    service.schedule_closes(&mut jobs);
    jobs.join_next().await.unwrap().unwrap();
    assert!(service.sessions.lock().unwrap().is_empty());
    service.schedule_closes(&mut jobs);
    assert!(jobs.is_empty());
    assert_eq!(state.lock().unwrap().closes, 1);
}

#[tokio::test]
async fn disconnected_watcher_keeps_retrying_after_transport_drops_the_service() {
    use std::time::Duration;

    let state = Arc::new(Mutex::new(RecordingPtyState {
        close_failures: 1,
        ..Default::default()
    }));
    let mut service = service_with_live_entry(Arc::new(Mutex::new(0)));
    service.shell_read = Arc::new(|| true);
    let service = Arc::new(service);
    service.sessions.lock().unwrap().insert(
        "one".into(),
        Slot::Live(fake_entry(
            "one",
            Arc::new(RecordingPtyHandle(Arc::clone(&state))),
        )),
    );
    let options = |role: &str| {
        SessionOptions::new(PeerInfo {
            name: "terminal-disconnect-test".into(),
            version: "0.1.0".into(),
            role: role.into(),
        })
    };
    let (runtime_port, hub_port) = port_pair();
    let (runtime, _runtime_driver) = Session::spawn(runtime_port, options("runtime"));
    let (hub, _hub_driver) = Session::spawn(hub_port, options("hub"));
    runtime
        .ready()
        .await
        .expect("terminal watcher test handshake");
    service.start_watcher(runtime);
    hub.close_now(1000, Some("test disconnect"));
    let wait_for_closes = |count| {
        let state = &state;
        async move {
            while state.lock().unwrap().closes < count {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
    };

    tokio::time::timeout(Duration::from_secs(2), wait_for_closes(1))
        .await
        .expect("disconnect initiates PTY cleanup");
    let weak = Arc::downgrade(&service);
    drop(service);
    tokio::time::timeout(Duration::from_secs(2), wait_for_closes(2))
        .await
        .expect("disconnect cleanup retries after the transport loses its handle");
    tokio::time::timeout(Duration::from_secs(2), async {
        while weak.upgrade().is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("cleanup releases the disconnected service after settlement");
}
