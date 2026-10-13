//! The resume mode the hub sends for each target (`apps/api/.../external-resume-policy.ts`) is a
//! fact about the target's harness, so each row is pinned against the real harness here. The
//! Claude row (strict only) is pinned in `claude_stop_tests`; these cover the two rows that send
//! `fallback`. If an SDK release starts refusing a mode the hub sends, a test here fails by name
//! instead of every reopen of that target failing in production.
use std::sync::Arc;

use mango_external_agents::testing::{FakeLauncher, FakeProcess};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::test_support::{self as fixtures, Rig, THREAD};
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
