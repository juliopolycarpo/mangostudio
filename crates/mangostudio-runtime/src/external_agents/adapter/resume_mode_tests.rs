//! The resume mode the hub sends for each target (`apps/api/.../external-resume-policy.ts`) is a
//! fact about the target's harness, so each row is pinned against the real harness here. The
//! Claude row (strict only) is pinned in `claude_stop_tests`; these cover the two rows that send
//! `fallback`. If an SDK release starts refusing a mode the hub sends, a test here fails by name
//! instead of every reopen of that target failing in production.
use std::sync::Arc;

use mango_external_agents::testing::{FakeLauncher, FakeProcess};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::test_support::{self as fixtures, CodexPeer, Rig, THREAD};
use crate::external_agents::wire;

/// A Codex app-server that still has the thread the hub names, in the workspace it was opened for.
fn codex_with_thread(workspace: String) -> FakeProcess {
    FakeProcess::responding(move |line| {
        let frame: Value = serde_json::from_str(line).expect("a JSON-RPC frame");
        let thread = json!({"id": THREAD, "cwd": workspace});
        let result = match frame["method"].as_str() {
            Some("initialize") => {
                json!({"userAgent": "codex/0.154.0", "platformFamily":"unix", "platformOs":"linux"})
            }
            Some("account/read") => {
                json!({"account":{"type":"chatgpt","email":"synthetic@example.test","planType":"plus"},"requiresOpenaiAuth":true})
            }
            Some("thread/read") => json!({ "thread": thread }),
            Some("thread/resume") => json!({
                "thread": thread, "cwd": workspace, "model": "synthetic-model",
                "approvalPolicy": "on-request", "sandbox": {"type": "readOnly"},
            }),
            Some("model/list") => json!({"data": [], "nextCursor": null}),
            Some("account/rateLimits/read") => json!({"rateLimits": {}}),
            Some("initialized") | None => return Vec::new(),
            Some(method) => panic!("unexpected Codex request {method:?}; expected a resume open"),
        };
        vec![json!({"id": frame["id"], "result": result}).to_string()]
    })
}

async fn open_resuming(
    rig: &mut Rig,
    native: &str,
    mode: wire::ResumeMode,
) -> Result<wire::OpenResult, mango_protocol::error::RemoteError> {
    rig.params.resume_ref = Some(native.into());
    rig.params.resume_mode = mode;
    let result = rig
        .supervisor
        .open(rig.params.clone(), &rig.runtime, &CancellationToken::new())
        .await;
    if result.is_ok() {
        rig.close().await;
    }
    result
}

/// The hub sends `fallback` for Codex: it resumes the stored thread, or starts a new one and says
/// why. Both modes must open, and a thread that is there is resumed in either.
#[tokio::test]
async fn the_codex_harness_opens_a_resumed_session_in_either_mode() {
    for mode in [wire::ResumeMode::Fallback, wire::ResumeMode::Strict] {
        let launcher = Arc::new(FakeLauncher::new());
        let mut rig = Rig::new(launcher.clone(), wire::TargetId::Codex, fixtures::limits()).await;
        launcher.push(codex_with_thread(rig.params.workspace_path.clone()));

        let opened = open_resuming(&mut rig, THREAD, mode).await;

        let received = match &opened {
            Ok(result) => format!("resumed: {}", result.resumed),
            Err(error) => error.message.clone(),
        };
        assert!(
            matches!(&opened, Ok(result) if result.resumed && result.native_session_id == THREAD),
            "expected a {mode:?} resume of {THREAD} to open resumed | received: {received}"
        );
    }
}

/// The hub sends `fallback` for Cursor. An ACP agent that cannot load a session opens a fresh one
/// and gives the reason in fallback mode, and is refused in strict mode, which is what adoption
/// relies on.
#[tokio::test]
async fn the_acp_harness_falls_back_in_fallback_mode_and_refuses_in_strict_mode() {
    let launcher = Arc::new(FakeLauncher::new());
    launcher.push(agent_that_cannot_load_sessions());
    let mut fallback_rig =
        Rig::new(launcher.clone(), wire::TargetId::Cursor, fixtures::limits()).await;
    let fallback = open_resuming(&mut fallback_rig, "sess_old", wire::ResumeMode::Fallback).await;
    launcher.push(agent_that_cannot_load_sessions());
    let mut strict_rig =
        Rig::new(launcher.clone(), wire::TargetId::Cursor, fixtures::limits()).await;
    let strict = open_resuming(&mut strict_rig, "sess_old", wire::ResumeMode::Strict).await;

    let received = match &fallback {
        Ok(result) => format!(
            "resumed: {}, reason: {:?}",
            result.resumed, result.fallback_reason
        ),
        Err(error) => error.message.clone(),
    };
    assert!(
        matches!(&fallback, Ok(result) if !result.resumed && result.fallback_reason.is_some()),
        "expected a fallback resume to open a new session and say why | received: {received}"
    );
    assert!(
        strict.is_err(),
        "expected a strict resume of a session the agent cannot load to be refused | received: an open session"
    );
}

fn agent_that_cannot_load_sessions() -> FakeProcess {
    FakeProcess::responding(|line| {
        let frame: Value = serde_json::from_str(line).expect("a JSON-RPC frame");
        let (Some(method), Some(id)) = (frame["method"].as_str(), frame.get("id")) else {
            return Vec::new();
        };
        let result = |value: Value| json!({"jsonrpc":"2.0","id":id,"result":value}).to_string();
        match method {
            "initialize" => vec![result(json!({
                "protocolVersion": 1,
                "agentInfo": {"name": "no-load", "version": "1.0.0"},
                "agentCapabilities": {
                    "loadSession": false,
                    "mcpCapabilities": {"http": false},
                    "promptCapabilities": {"image": true, "embeddedContext": true},
                    "sessionCapabilities": {},
                },
                "authMethods": [],
            }))],
            "session/new" => vec![result(json!({"sessionId": "sess_new"}))],
            _ => vec![
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"method not found"}})
                    .to_string(),
            ],
        }
    })
}

/// The codes the SDK's Claude reducer gives a failed result record, one per subtype it names and one
/// it does not.
fn claude_result_error_codes() -> Vec<String> {
    use mango_agent_claude::protocol::StreamRecord;
    use mango_agent_claude::reducer::TurnReducer;
    use mango_external_agents::EventKind;

    [
        "error",
        "error_during_execution",
        "error_max_turns",
        "error_max_budget_usd",
        "error_max_structured_output_retries",
        "error_a_subtype_added_later",
    ]
    .into_iter()
    .map(|subtype| {
        let line = json!({"type": "result", "is_error": true, "subtype": subtype, "result": "x"})
            .to_string();
        let record = StreamRecord::parse(&line).expect("a parseable result record");
        let events = TurnReducer::new().reduce(&record).events;
        events
            .into_iter()
            .find_map(|event| match event {
                EventKind::Error { error } => Some(error.code.to_string()),
                _ => None,
            })
            .unwrap_or_else(|| panic!("expected an error event for result subtype {subtype}"))
    })
    .collect()
}

/// The hub treats a Claude `vendor-error` as a possibly killed turn unless its code is one of the
/// codes the vendor's own failed result gets (`EXTERNAL_AGENT_FINISHED_TURN_ERROR_CODES`). If the
/// SDK renames one of those, or starts giving a failed result a code outside the list, this fails
/// by name instead of the hub wrongly keeping, or wrongly dropping, a conversation.
#[test]
fn the_codes_of_a_failed_claude_result_are_exactly_the_finished_turn_codes() {
    use mangostudio_runtime_contract::errors::EXTERNAL_AGENT_FINISHED_TURN_ERROR_CODES as FINISHED;

    let mut emitted = claude_result_error_codes();
    emitted.sort();
    emitted.dedup();
    let mut expected: Vec<String> = FINISHED.iter().map(|code| (*code).to_owned()).collect();
    expected.sort();

    assert_eq!(
        emitted, expected,
        "expected the SDK's failed-result codes to equal the contract's finished-turn codes"
    );
    for process_death in [
        "claude-stream-broken",
        "claude-no-result",
        "claude-terminated",
        "adapter-stream",
    ] {
        assert!(
            !FINISHED.contains(&process_death),
            "expected {process_death}, which may mean the child was killed, to stay out of the finished-turn codes"
        );
    }
}

/// Whether the hub's policy row says resuming the stored conversation after a killed turn carries
/// on that turn (`continuesKilledTurn`) is a fact about how each harness stops a turn:
///
/// - Claude stops a turn by signalling its child. When the stop cannot be a clean interrupt, the
///   SDK refuses every later turn on the session, because the vendor documents that resuming
///   "continues the turn that SIGTERM left unfinished". The row says true.
/// - Codex and Cursor stop a turn with a protocol request, and the session runs the next turn, so
///   the conversation holds no half-run turn. Their rows say false.
///
/// If the SDK changes how a stop leaves the session, one of the three tests below fails by name.
#[tokio::test]
async fn a_forced_claude_stop_leaves_the_session_refusing_turns_so_its_row_continues_a_killed_turn()
{
    use super::claude_stop_tests::{StubbornClaudeLauncher, backend, open_claude, start};
    use crate::external_agents::failure::FailureCause;
    use crate::external_agents::port::{CancelReason, TurnRequest};

    let launcher = StubbornClaudeLauncher::new([]);
    let backend = backend(launcher);
    let session = open_claude(&backend).await;
    let _turn = start(session.as_ref()).await;
    session
        .cancel(CancelReason::Requested)
        .await
        .map_err(|failure| failure.to_string())
        .expect("expected the stop to settle");
    let configuration = fixtures::configuration();

    let next = session
        .start_turn(TurnRequest {
            turn_id: "after-stop".into(),
            input: "again".into(),
            attachments: Vec::new(),
            configuration: &configuration,
        })
        .await;

    let received = match &next {
        Ok(_) => String::from("a running turn"),
        Err(failure) => format!("{:?}: {failure}", failure.cause),
    };
    assert!(
        matches!(&next, Err(failure) if failure.cause == FailureCause::Cancelled),
        "expected a turn after a forced Claude stop to be refused as cancelled | received: {received}"
    );
}

#[tokio::test]
async fn a_codex_cancel_leaves_the_session_running_turns_so_its_row_does_not() {
    let launcher = Arc::new(FakeLauncher::new());
    launcher.push(CodexPeer::default().process(mango_external_agents::testing::Announcer::new()));
    let rig = Rig::new(launcher.clone(), wire::TargetId::Codex, fixtures::limits()).await;
    rig.open().await;
    rig.turn("running").await.expect("the first turn starts");
    rig.supervisor
        .cancel(wire::CancelParams {
            session_id: rig.params.session_id.clone(),
            native_turn_id: None,
        })
        .await
        .expect("the cancel is accepted");

    let next = turn_when_released(&rig, "after-cancel").await;

    assert!(
        next.is_ok(),
        "expected a Codex turn to start after a cancel | received: {next:?}"
    );
}

#[tokio::test]
async fn a_cursor_cancel_leaves_the_session_running_turns_so_its_row_does_not() {
    let launcher = Arc::new(FakeLauncher::new());
    launcher.push(agent_that_ends_a_prompt_on_cancel());
    let rig = Rig::new(launcher.clone(), wire::TargetId::Cursor, fixtures::limits()).await;
    rig.open().await;
    rig.turn("running").await.expect("the first turn starts");
    // The cancel must follow the prompt on the wire, or there is nothing for the agent to end.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !launcher
            .written()
            .iter()
            .any(|line| line.contains("session/prompt"))
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the prompt reaches the agent");
    rig.supervisor
        .cancel(wire::CancelParams {
            session_id: rig.params.session_id.clone(),
            native_turn_id: None,
        })
        .await
        .expect("the cancel is accepted");

    let next = turn_when_released(&rig, "after-cancel").await;

    assert!(
        next.is_ok(),
        "expected a Cursor turn to start after a cancel | received: {next:?}"
    );
}

/// Starts a turn, retrying only while the cancelled turn's slot is still being released.
async fn turn_when_released(rig: &Rig, prefix: &str) -> Result<wire::TurnResult, String> {
    let mut last = String::new();
    for attempt in 0..100 {
        match rig.turn(&format!("{prefix}-{attempt}")).await {
            Ok(started) => return Ok(started),
            Err(error)
                if error
                    .details
                    .as_ref()
                    .is_some_and(|d| d["kind"] == "external_agent_busy") =>
            {
                last = error.message;
            }
            Err(error) => return Err(error.message),
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    Err(last)
}

/// An ACP agent whose prompt runs until `session/cancel`, which it answers as a real agent does
/// (`stopReason: cancelled`), and which then takes the next prompt.
fn agent_that_ends_a_prompt_on_cancel() -> FakeProcess {
    let pending = std::sync::Mutex::new(None::<Value>);
    FakeProcess::responding(move |line| {
        let frame: Value = serde_json::from_str(line).expect("a JSON-RPC frame");
        let reply =
            |id: &Value, value: Value| json!({"jsonrpc":"2.0","id":id,"result":value}).to_string();
        match (frame["method"].as_str(), frame.get("id")) {
            (Some("session/cancel"), None) => pending
                .lock()
                .unwrap()
                .take()
                .map(|id| vec![reply(&id, json!({"stopReason": "cancelled"}))])
                .unwrap_or_default(),
            (Some("initialize"), Some(id)) => vec![reply(
                id,
                json!({
                    "protocolVersion": 1,
                    "agentInfo": {"name": "cancellable", "version": "1.0.0"},
                    "agentCapabilities": {
                        "loadSession": false,
                        "mcpCapabilities": {"http": false},
                        "promptCapabilities": {"image": true, "embeddedContext": true},
                        "sessionCapabilities": {},
                    },
                    "authMethods": [],
                }),
            )],
            (Some("session/new"), Some(id)) => vec![reply(id, json!({"sessionId": "sess_cancel"}))],
            (Some("session/prompt"), Some(id)) => {
                *pending.lock().unwrap() = Some(id.clone());
                Vec::new()
            }
            (_, Some(id)) => vec![
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"method not found"}})
                    .to_string(),
            ],
            _ => Vec::new(),
        }
    })
}
