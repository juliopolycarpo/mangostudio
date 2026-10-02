//! Real SDK harnesses over named fake processes; product observations stay on the owned port.
use std::sync::Arc;
use std::time::Duration;

use mango_external_agents::testing::{Announcer, FakeLauncher, FakeProcess};
use mango_external_agents::{Limits, ProcessLauncher};
use mango_protocol::frame::PeerInfo;
use mango_protocol::session::{Session, SessionOptions};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::backend::{Backend, ProductHarnesses};
use crate::external_agents::port::CloseCause;
use crate::external_agents::supervisor::{
    ExecutableResolver, PortFuture, Ports, Supervisor, WorkspaceAuthority,
};
use crate::external_agents::wire;
use crate::test_support::ScratchDir;

pub(super) const THREAD: &str = "sdk-test-thread";
pub(super) const TURN: &str = "sdk-test-turn";

/// A small app-server peer with real Codex request/notification shapes.
#[derive(Clone, Default)]
pub(super) struct CodexPeer {
    pub start_frames: Vec<Value>,
    pub complete: bool,
}
impl CodexPeer {
    pub fn process(&self, announcer: Announcer) -> FakeProcess {
        let peer = self.clone();
        FakeProcess::responding(move |line| peer.answer(line)).announcing(announcer)
    }
    fn answer(&self, line: &str) -> Vec<String> {
        let frame: Value = serde_json::from_str(line).expect("a JSON-RPC frame");
        let result = match frame["method"].as_str() {
            Some("initialize") => {
                json!({"userAgent": "codex/0.154.0", "platformFamily":"unix", "platformOs":"linux"})
            }
            Some("account/read") => {
                json!({"account":{"type":"chatgpt","email":"synthetic@example.test","planType":"plus"},"requiresOpenaiAuth":true})
            }
            Some("thread/start") => {
                json!({"thread":{"id":THREAD,"cwd":frame["params"]["cwd"]},"cwd":frame["params"]["cwd"],"model":"synthetic-model","approvalPolicy":"on-request","sandbox":{"type":"readOnly"}})
            }
            Some("model/list") => json!({"data":[],"nextCursor":null}),
            Some("account/rateLimits/read") => json!({"rateLimits":{}}),
            Some("turn/start") => {
                let mut frames = vec![json!({"id":frame["id"],"result":{"turn":{"id":TURN}}})];
                frames.extend(self.start_frames.clone());
                if self.complete {
                    frames.push(completed("completed"));
                }
                return frames.iter().map(Value::to_string).collect();
            }
            Some("turn/interrupt") => {
                return vec![
                    json!({"id":frame["id"],"result":{}}).to_string(),
                    completed("interrupted").to_string(),
                ];
            }
            Some("initialized") | None => return Vec::new(),
            Some(method) => {
                panic!("unexpected Codex request {method:?}; expected a scripted SDK operation")
            }
        };
        vec![json!({"id":frame["id"],"result":result}).to_string()]
    }
}

pub(super) fn completed(status: &str) -> Value {
    json!({"method":"turn/completed","params":{"threadId":THREAD,"turn":{"id":TURN,"status":status}}})
}
pub(super) fn item(method: &str, item: Value) -> Value {
    json!({"method":method,"params":{"threadId":THREAD,"turnId":TURN,"item":item}})
}
pub(super) fn approval(prefix: Vec<String>) -> Value {
    json!({"id":501,"method":"item/commandExecution/requestApproval","params":{"threadId":THREAD,"turnId":TURN,"itemId":"command-1","command":"git status","proposedExecpolicyAmendment":prefix}})
}

pub(super) fn limits() -> Limits {
    Limits {
        kill_grace: Duration::from_millis(10),
        shutdown_timeout: Duration::from_secs(2),
        cancel_settle_timeout: Duration::from_secs(2),
        ..Limits::default()
    }
}
pub(super) fn configuration() -> wire::Configuration {
    wire::Configuration {
        model: None,
        effort: None,
        level: wire::PermissionLevel::Default,
        routing: wire::ApprovalRouting::User,
        workspace_roots: Vec::new(),
    }
}

struct AuthorizedWorkspace(std::path::PathBuf);
impl WorkspaceAuthority for AuthorizedWorkspace {
    fn authorize<'a>(
        &'a self,
        _hub: &'a Session,
        canonical: &'a std::path::Path,
    ) -> PortFuture<'a, bool> {
        Box::pin(async move { canonical == self.0 })
    }
}
struct InstalledExecutable;
impl ExecutableResolver for InstalledExecutable {
    fn resolve<'a>(
        &'a self,
        _target: wire::TargetId,
        _cancel: &'a CancellationToken,
    ) -> PortFuture<'a, Option<std::path::PathBuf>> {
        Box::pin(async { Some("/synthetic/vendor-agent".into()) })
    }
}

pub(super) struct Rig {
    pub supervisor: Arc<Supervisor>,
    pub runtime: Session,
    _hub: Session,
    pub events: mango_protocol::session::EventStream,
    pub params: wire::OpenParams,
    _dirs: (ScratchDir, ScratchDir),
}
impl Rig {
    pub async fn new(
        launcher: Arc<dyn ProcessLauncher>,
        target: wire::TargetId,
        limits: Limits,
    ) -> Self {
        let workspace = ScratchDir::created("sdk-lifecycle-workspace");
        let canonical = crate::workspace_path::canonical_directory(workspace.path()).unwrap();
        let private = ScratchDir::created("sdk-lifecycle-private");
        let supervisor = Supervisor::new(Ports {
            harnesses: Arc::new(Backend::new(
                launcher,
                Arc::new(ProductHarnesses),
                limits,
                Duration::from_secs(2),
            )),
            workspaces: Arc::new(AuthorizedWorkspace(canonical.clone())),
            executables: Arc::new(InstalledExecutable),
            environment: Arc::new(crate::probing::detection::path_env::PathEnv::default),
            consent: Arc::new(|| true),
            private_root: private.path().to_path_buf(),
            runtime_version: "sdk-test".into(),
            account_key: Arc::new(|| None),
            session_cap: 1,
            consent_poll: Duration::from_secs(60),
            consent_read_timeout: Duration::from_secs(2),
            cleanup_timeout: Duration::from_secs(2),
            hard_turn_timeout: Duration::from_secs(30),
        });
        let (port, peer) = mango_protocol::port::port_pair();
        let info = |role: &str| PeerInfo {
            name: "sdk-lifecycle-test".into(),
            version: "0.0.0".into(),
            role: role.into(),
        };
        let (runtime, _) = Session::spawn(port, SessionOptions::new(info("runtime")));
        let (hub, _) = Session::spawn(peer, SessionOptions::new(info("hub")));
        let (a, b) = tokio::join!(runtime.ready(), hub.ready());
        a.unwrap();
        b.unwrap();
        let events = hub.events();
        Self {
            supervisor,
            runtime,
            _hub: hub,
            events,
            params: wire::OpenParams {
                session_id: "sdk-session".into(),
                target_id: target,
                workspace_path: canonical.to_string_lossy().into_owned(),
                configuration: configuration(),
                resume_ref: None,
                resume_mode: wire::ResumeMode::Fallback,
                timeout_ms: 5_000,
                toolchain: None,
            },
            _dirs: (workspace, private),
        }
    }
    pub async fn open(&self) {
        self.supervisor
            .open(
                self.params.clone(),
                &self.runtime,
                &CancellationToken::new(),
            )
            .await
            .expect("the actual SDK opens");
    }
    pub async fn turn(
        &self,
        message: &str,
    ) -> Result<wire::TurnResult, mango_protocol::error::RemoteError> {
        self.supervisor
            .turn(
                wire::TurnParams {
                    session_id: self.params.session_id.clone(),
                    client_message_id: message.into(),
                    input: "synthetic input".into(),
                    configuration: configuration(),
                    attachments: None,
                },
                &CancellationToken::new(),
            )
            .await
    }
    pub async fn next(&mut self) -> Value {
        let event = tokio::time::timeout(Duration::from_secs(5), self.events.recv())
            .await
            .expect("an event within five seconds")
            .expect("an open product topic");
        assert_eq!(event.topic, "external-agent.event");
        event.payload
    }
    pub async fn through(&mut self, kind: &str) -> Vec<Value> {
        let mut events = Vec::new();
        loop {
            let event = self.next().await;
            let done = event["event"]["type"] == kind;
            events.push(event);
            if done {
                return events;
            }
        }
    }
    pub async fn close(&self) {
        self.supervisor.close_all(CloseCause::Shutdown).await;
        assert_eq!(self.supervisor.live_sessions().0, 0);
    }
}

pub(super) async fn reaped(launcher: &FakeLauncher) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while launcher.live_children() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "expected zero live children, received {}",
            launcher.live_children()
        )
    });
}

pub(super) fn shape(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| {
            let kind = event["event"]["type"].as_str().unwrap();
            (kind != "commands_available").then(|| kind.to_owned())
        })
        .collect()
}
