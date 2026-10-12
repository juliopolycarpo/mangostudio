//! ACP turn outcomes that 0.6.0 of the SDK changed, observed through the product seams: an
//! agent's own prompt error keeps the session, a refusal before queueing is safe to resend, and a
//! tool call is named by what the agent called it.
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use mango_agent_acp::testing::FakeAcpAgent;
use mango_external_agents::testing::{FakeLauncher, FakeProcess};
use serde_json::{Value, json};

use super::backend::{Backend, ProductHarnesses};
use super::test_support::{self as fixtures, Rig};
use crate::external_agents::port::{AgentBackend, CloseCause, Dispatch, TurnRequest};
use crate::external_agents::wire;
use crate::test_support::ScratchDir;

/// An ACP agent that answers its first `session/prompt` with a JSON-RPC error of its own and every
/// later one with a short reply: the agent refused one prompt and is otherwise healthy.
struct RefusingFirstPromptAgent {
    prompts: AtomicUsize,
}

impl RefusingFirstPromptAgent {
    const REFUSAL_CODE: i64 = -32603;
    const REFUSAL_MESSAGE: &'static str = "synthetic agent refusal";
    const REPLY: &'static str = "second turn answered";

    fn process() -> FakeProcess {
        let agent = Self {
            prompts: AtomicUsize::new(0),
        };
        FakeProcess::responding(move |line| agent.answer(line))
    }

    fn answer(&self, line: &str) -> Vec<String> {
        let frame: Value = serde_json::from_str(line).expect("a JSON-RPC frame");
        let (Some(method), id) = (frame["method"].as_str(), frame.get("id")) else {
            return Vec::new();
        };
        let Some(id) = id else { return Vec::new() };
        let result = |value: Value| json!({"jsonrpc":"2.0","id":id,"result":value}).to_string();
        match method {
            "initialize" => vec![result(json!({
                "protocolVersion": 1,
                "agentInfo": {"name": "refusing-first-prompt", "version": "1.0.0"},
                "agentCapabilities": {
                    "loadSession": false,
                    "mcpCapabilities": {"http": false},
                    "promptCapabilities": {"image": true, "embeddedContext": true},
                    "sessionCapabilities": {},
                },
                "authMethods": [],
            }))],
            "session/new" => vec![result(json!({"sessionId": "sess_refusing"}))],
            "session/prompt" if self.prompts.fetch_add(1, Ordering::SeqCst) == 0 => vec![
                json!({"jsonrpc":"2.0","id":id,"error":{
                    "code": Self::REFUSAL_CODE,
                    "message": Self::REFUSAL_MESSAGE,
                }})
                .to_string(),
            ],
            "session/prompt" => vec![
                json!({"jsonrpc":"2.0","method":"session/update","params":{
                    "sessionId": "sess_refusing",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": Self::REPLY},
                    },
                }})
                .to_string(),
                result(json!({"stopReason": "end_turn"})),
            ],
            _ => vec![
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"method not found"}})
                    .to_string(),
            ],
        }
    }
}

/// Whether a refusal is the session's busy answer, the only one worth waiting out.
fn is_busy(error: &mango_protocol::error::RemoteError) -> bool {
    error
        .details
        .as_ref()
        .is_some_and(|details| details["kind"] == "external_agent_busy")
}

/// Starts a turn, retrying only while the previous turn's slot is still being released: the
/// terminal is published a moment before the slot is, so an immediate start may be told it is busy.
async fn start_when_released(rig: &Rig, prefix: &str) -> Result<wire::TurnResult, String> {
    let mut last = String::new();
    for attempt in 0..100 {
        match rig.turn(&format!("{prefix}-{attempt}")).await {
            Ok(started) => return Ok(started),
            Err(error) if is_busy(&error) => last = error.message,
            Err(error) => return Err(error.message),
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Err(last)
}

#[tokio::test]
async fn an_agents_prompt_error_ends_one_turn_and_the_next_turn_runs_on_the_same_session() {
    let launcher = Arc::new(FakeLauncher::new());
    launcher.push(RefusingFirstPromptAgent::process());
    let mut rig = Rig::new(launcher.clone(), wire::TargetId::Cursor, fixtures::limits()).await;
    rig.open().await;

    rig.turn("refused").await.expect("the first turn starts");
    let first = rig.through("error").await;
    let error = &first
        .iter()
        .find(|event| event["event"]["type"] == "error")
        .unwrap_or_else(|| {
            panic!(
                "expected an error event from the agent's refusal | received {:?}",
                fixtures::shape(&first)
            )
        })["event"]["error"];
    assert_eq!(
        (error["code"].as_str(), error["vendorCode"].as_str()),
        (Some("acp-request-failed"), Some("-32603")),
        "expected the agent's own refusal to be reported as acp-request-failed with its code | received {error}"
    );
    assert_eq!(
        launcher.live_children(),
        1,
        "expected the agent to stay alive after answering one prompt with an error"
    );

    let second = start_when_released(&rig, "answered").await;
    assert!(
        second.is_ok(),
        "expected a second turn on the same session after an agent error | received {second:?}"
    );
    let events = rig.through("completed").await;
    let text: String = events
        .iter()
        .filter(|event| event["event"]["type"] == "text_delta")
        .filter_map(|event| event["event"]["text"].as_str())
        .collect();
    assert_eq!(
        (text.as_str(), launcher.launches().len()),
        (RefusingFirstPromptAgent::REPLY, 1),
        "expected the reply on the original child, with no relaunch | received {:?}",
        fixtures::shape(&events)
    );
    rig.close().await;
    fixtures::reaped(&launcher).await;
}

#[tokio::test]
async fn a_turn_on_a_closed_session_was_not_submitted_and_the_hub_may_resend_it() {
    let launcher = Arc::new(FakeLauncher::new());
    launcher.push(FakeAcpAgent::new().process());
    let backend = Backend::new(
        launcher.clone(),
        Arc::new(ProductHarnesses),
        fixtures::limits(),
        Duration::from_secs(2),
    );
    let workspace = ScratchDir::created("acp-closed-session-workspace");
    let params = wire::OpenParams {
        session_id: "closed-session".into(),
        target_id: wire::TargetId::Cursor,
        workspace_path: workspace.path().to_string_lossy().into_owned(),
        configuration: fixtures::configuration(),
        resume_ref: None,
        resume_mode: wire::ResumeMode::Fallback,
        timeout_ms: 5_000,
        toolchain: None,
    };
    let session = backend
        .open(
            wire::TargetId::Cursor,
            "/synthetic/cursor".into(),
            fixtures::host(workspace.path().to_path_buf()),
            &params,
        )
        .await
        .expect("the ACP session opens");
    session
        .close(CloseCause::Requested)
        .await
        .expect("the session closes");

    let configuration = fixtures::configuration();
    let Err(failure) = session
        .start_turn(TurnRequest {
            turn_id: "after-close".into(),
            input: "synthetic input".into(),
            attachments: Vec::new(),
            configuration: &configuration,
        })
        .await
    else {
        panic!("expected a turn on a closed ACP session to be refused | received a started turn");
    };

    let received = (
        failure.dispatch,
        failure.remote.code.clone(),
        failure.remote.details.clone().map(Value::Object),
    );
    assert_eq!(
        received,
        (
            Some(Dispatch::NotSubmitted),
            "UNAVAILABLE".to_owned(),
            Some(json!({"kind": "external_agent_closed", "dispatch": "not-submitted"})),
        ),
        "expected the closed-session refusal the hub reads as safe to resend | received {received:?}"
    );
}

#[tokio::test]
async fn an_acp_tool_call_is_named_by_the_agent_when_it_sends_a_name_and_by_its_title_otherwise() {
    let launcher = Arc::new(FakeLauncher::new());
    launcher.push(
        FakeAcpAgent::new()
            .with_updates(vec![
                json!({"sessionUpdate":"tool_call","toolCallId":"named","title":"Read the file","kind":"read","status":"completed","name":"read_file"}),
                json!({"sessionUpdate":"tool_call","toolCallId":"unnamed","title":"Run tests","kind":"execute","status":"completed"}),
            ])
            .process(),
    );
    let mut rig = Rig::new(launcher.clone(), wire::TargetId::Cursor, fixtures::limits()).await;
    rig.open().await;
    rig.turn("names").await.expect("the turn starts");
    let events = rig.through("completed").await;
    let names: Vec<&str> = events
        .iter()
        .filter(|event| event["event"]["type"] == "activity_started")
        .map(|event| {
            event["event"]["activity"]["name"]
                .as_str()
                .unwrap_or_default()
        })
        .collect();
    assert_eq!(
        names,
        ["read_file", "Run tests"],
        "expected the agent's own name where it sent one and the title otherwise"
    );
    rig.close().await;
    fixtures::reaped(&launcher).await;
}
