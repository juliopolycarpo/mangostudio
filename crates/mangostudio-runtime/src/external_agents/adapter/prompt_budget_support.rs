//! A real ACP harness with a fake child that keeps frame sizes, never large frame bodies.
use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mango_external_agents::testing::{Announcer, FakeLauncher, FakeProcess};
use mango_external_agents::{ByteSink, LaunchSpec, Limits, ManagedProcess, ProcessLauncher};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Notify, Semaphore};
use tokio_util::sync::CancellationToken;

use super::super::{Backend, ProductHarnesses};
use crate::external_agents::port::{self, AgentBackend};
use crate::external_agents::wire;
use crate::test_support::ScratchDir;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProductLimits {
    pub attachment_bytes: usize,
    pub attachments: usize,
    pub attachment_id_units: usize,
    pub attachment_name_units: usize,
    pub attachment_mime_units: usize,
    pub native_session_id_units: usize,
    pub http_prompt_units: usize,
    pub runtime_prompt_units: usize,
    pub sessions: usize,
    pub protocol_frame_bytes: usize,
    pub incoming_bytes: usize,
    pub incoming_line_bytes: usize,
    pub outbound_bytes: usize,
}

pub(super) fn product_limits() -> ProductLimits {
    serde_json::from_str(include_str!("fixtures/prompt-limits.json")).unwrap()
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

pub(super) fn host(cwd: PathBuf) -> port::Host {
    port::Host {
        cwd,
        scratch: None,
        environment: BTreeMap::new(),
        runtime_version: "synthetic-prompt-budget".into(),
        cancel: CancellationToken::new(),
    }
}

pub(super) fn attachment(kind: wire::AttachmentKind, bytes: usize) -> port::Attachment {
    port::Attachment {
        id: "synthetic-id".into(),
        name: "synthetic-file".into(),
        mime_type: "application/octet-stream".into(),
        kind,
        bytes: vec![0; bytes],
    }
}

/// Each metadata field is at its product limit, with the largest JSON escaping per unit.
pub(super) fn maximum_text_attachments() -> Vec<port::Attachment> {
    let limits = product_limits();
    (0..limits.attachments)
        .map(|index| port::Attachment {
            id: format!(
                "{}{}",
                "\0".repeat(limits.attachment_id_units - 1),
                char::from(u8::try_from(index + 1).unwrap())
            ),
            name: "\0".repeat(limits.attachment_name_units),
            mime_type: "\0".repeat(limits.attachment_mime_units),
            kind: wire::AttachmentKind::Text,
            bytes: vec![0; limits.attachment_bytes],
        })
        .collect()
}

#[derive(Clone)]
pub(super) struct Peer {
    pub native_id: String,
    pub image: bool,
    pub embedded_context: bool,
    pub capture_small_frames: bool,
    pub hold_prompts: bool,
}
impl Default for Peer {
    fn default() -> Self {
        Self {
            native_id: "synthetic-budget-session".into(),
            image: true,
            embedded_context: true,
            capture_small_frames: false,
            hold_prompts: false,
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct Frame {
    pub method: String,
    pub bytes: usize,
    pub value: Option<Value>,
}

pub(super) struct Frames {
    records: Mutex<Vec<Frame>>,
    changed: Notify,
    release: Semaphore,
}
impl Default for Frames {
    fn default() -> Self {
        Self {
            records: Mutex::new(Vec::new()),
            changed: Notify::new(),
            release: Semaphore::new(0),
        }
    }
}
impl Frames {
    pub fn records(&self, method: &str) -> Vec<Frame> {
        self.records
            .lock()
            .unwrap()
            .iter()
            .filter(|frame| frame.method == method)
            .cloned()
            .collect()
    }
    pub async fn wait_for(&self, method: &str, count: usize) {
        tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                let changed = self.changed.notified();
                if self.records(method).len() >= count {
                    return;
                }
                changed.await;
            }
        })
        .await
        .expect("expected the scripted physical writes within 60 seconds");
    }
    pub fn release_prompts(&self, count: usize) {
        self.release.add_permits(count);
    }
}

/// The SDK owns each encoded frame until its physical write settles. This fake retains only
/// a small request header and scalar observations; FakeLauncher's recording stdin is bypassed.
pub(super) struct NonRetainingLauncher {
    pub fake: FakeLauncher,
    pub frames: Arc<Frames>,
    peers: Mutex<VecDeque<Peer>>,
}
impl NonRetainingLauncher {
    pub fn new(peers: impl IntoIterator<Item = Peer>) -> Arc<Self> {
        Arc::new(Self {
            fake: FakeLauncher::new(),
            frames: Arc::new(Frames::default()),
            peers: Mutex::new(peers.into_iter().collect()),
        })
    }
}

/// This responder is deliberately unused: writes go through NonRetainingStdin.
fn unused_recording_responder(_line: &str) -> Vec<String> {
    Vec::new()
}

#[async_trait::async_trait]
impl ProcessLauncher for NonRetainingLauncher {
    async fn spawn(&self, spec: LaunchSpec) -> mango_external_agents::Result<ManagedProcess> {
        let peer = self
            .peers
            .lock()
            .unwrap()
            .pop_front()
            .expect("a queued peer");
        let announcer = Announcer::new();
        self.fake.push(
            FakeProcess::responding(unused_recording_responder).announcing(announcer.clone()),
        );
        let mut process = self.fake.spawn(spec).await?;
        process.stdin = Some(Box::new(NonRetainingStdin {
            close: process.stdin.take().expect("ACP requested stdin"),
            announcer,
            peer,
            frames: Arc::clone(&self.frames),
            pending_prompt: None,
        }));
        Ok(process)
    }
}

#[derive(Deserialize)]
struct RequestHeader {
    #[serde(default)]
    id: Option<Value>,
    method: String,
}

struct NonRetainingStdin {
    close: Box<dyn ByteSink>,
    announcer: Announcer,
    peer: Peer,
    frames: Arc<Frames>,
    pending_prompt: Option<Value>,
}
impl NonRetainingStdin {
    fn answer(&self, id: Value, result: Value) {
        self.announcer
            .announce(json!({"jsonrpc":"2.0", "id":id, "result":result}).to_string());
    }
    async fn prompt(&mut self, id: Value, bytes: usize) {
        // Keep only large writes in flight; a refused large call must still recover with a small turn.
        if self.peer.hold_prompts && bytes > 64 * 1024 {
            self.peer.hold_prompts = false;
            self.pending_prompt = Some(id);
            self.frames.release.acquire().await.unwrap().forget();
            return;
        }
        self.answer(id, json!({"stopReason":"end_turn"}));
    }
}

#[async_trait::async_trait]
impl ByteSink for NonRetainingStdin {
    async fn write_all(&mut self, bytes: &[u8]) -> mango_external_agents::Result<()> {
        let header: RequestHeader = serde_json::from_slice(bytes).expect("a JSON-RPC request");
        let value = self
            .peer
            .capture_small_frames
            .then(|| serde_json::from_slice(bytes).unwrap());
        self.frames.records.lock().unwrap().push(Frame {
            method: header.method.clone(),
            bytes: bytes.len() - usize::from(bytes.ends_with(b"\n")),
            value,
        });
        self.frames.changed.notify_one();
        match header.method.as_str() {
            "initialize" => self.answer(
                header.id.unwrap(),
                json!({
                    "protocolVersion":1,
                    "agentInfo":{"name":"synthetic-acp","version":"1.2.3"},
                    "agentCapabilities":{
                        "loadSession":true,
                        "mcpCapabilities":{"http":false},
                        "promptCapabilities":{"image":self.peer.image,"embeddedContext":self.peer.embedded_context},
                        "sessionCapabilities":{}
                    },
                    "authMethods":[]
                }),
            ),
            "session/new" => self.answer(
                header.id.unwrap(),
                json!({"sessionId":self.peer.native_id, "modes":{
                    "currentModeId":"agent", "availableModes":[{"id":"agent","name":"Agent"}]
                }}),
            ),
            "session/set_mode" => self.answer(header.id.unwrap(), json!({})),
            "session/prompt" => self.prompt(header.id.unwrap(), bytes.len()).await,
            "session/cancel" => {
                if let Some(id) = self.pending_prompt.take() {
                    self.answer(id, json!({"stopReason":"cancelled"}));
                }
            }
            method => panic!("received {method:?}; expected a scripted ACP operation"),
        }
        Ok(())
    }
    async fn close(&mut self) -> mango_external_agents::Result<()> {
        self.close.close().await
    }
}

pub(super) struct Rig {
    pub launcher: Arc<NonRetainingLauncher>,
    pub backend: Backend,
    cwd: ScratchDir,
}
impl Rig {
    pub fn new(peers: impl IntoIterator<Item = Peer>) -> Self {
        let launcher = NonRetainingLauncher::new(peers);
        let backend = Backend::new(
            launcher.clone(),
            Arc::new(ProductHarnesses),
            Limits {
                shutdown_timeout: Duration::from_secs(2),
                ..Limits::default()
            },
            Duration::from_secs(2),
        );
        Self {
            launcher,
            backend,
            cwd: ScratchDir::created("sdk-prompt-budget"),
        }
    }
    pub async fn open(&self, id: &str) -> Box<dyn port::AgentSession> {
        self.backend
            .open(
                wire::TargetId::Cursor,
                PathBuf::from("/synthetic/cursor-agent"),
                host(self.cwd.path().to_path_buf()),
                &wire::OpenParams {
                    session_id: id.into(),
                    target_id: wire::TargetId::Cursor,
                    workspace_path: self.cwd.path().to_string_lossy().into_owned(),
                    configuration: configuration(),
                    resume_ref: None,
                    resume_mode: wire::ResumeMode::Strict,
                    timeout_ms: 120_000,
                    toolchain: None,
                },
            )
            .await
            .expect("the actual product ACP harness opens the fake child")
    }
    pub fn assert_closed(&self) {
        assert_eq!(self.launcher.fake.live_children(), 0);
        assert!(
            self.launcher.fake.written().is_empty(),
            "no SDK fake retained an outbound frame"
        );
    }
}

pub(super) async fn start(
    session: &dyn port::AgentSession,
    input: String,
    attachments: Vec<port::Attachment>,
) -> port::AgentResult<port::TurnStream> {
    session
        .start_turn(port::TurnRequest {
            turn_id: "synthetic-budget-turn".into(),
            input,
            attachments,
            configuration: &configuration(),
        })
        .await
}

pub(super) async fn drain(mut stream: port::TurnStream) -> Vec<wire::Event> {
    tokio::time::timeout(Duration::from_secs(60), async move {
        let mut events = Vec::new();
        while let Some(event) = stream.events.recv().await {
            if let Some(event) = event.mapped.wire {
                events.push(event);
            }
        }
        events
    })
    .await
    .expect("the scripted turn settles within 60 seconds")
}

pub(super) async fn complete(stream: port::TurnStream) {
    let events = drain(stream).await;
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, wire::Event::Completed))
            .count(),
        1
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, wire::Event::Error { .. }))
    );
}

#[cfg(target_os = "linux")]
pub(super) fn vm_hwm_kib() -> usize {
    let status = std::fs::read_to_string("/proc/self/status").expect("Linux process memory status");
    status
        .lines()
        .find_map(|line| {
            line.strip_prefix("VmHWM:")
                .and_then(|value| value.split_whitespace().next())
        })
        .expect("VmHWM is available on Linux")
        .parse()
        .expect("VmHWM is a number of KiB")
}
