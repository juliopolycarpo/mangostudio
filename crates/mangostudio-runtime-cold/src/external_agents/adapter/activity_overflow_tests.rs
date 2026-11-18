//! A turn that holds more than 1,024 activities open ends with the SDK's named overflow failure
//! (SDK 0.11.0). Real harnesses over named fakes, observed on the product event topic: every start
//! the hub saw is closed, the error keeps the harness's own code and its message naming the limit
//! and the count, and nothing in it reads as a runtime or unknown failure.
use std::sync::Arc;

use mango_agent_acp::testing::FakeAcpAgent;
use mango_agent_claude::testing::{FakeClaudeCli, HELP_WITH_JSON_SCHEMA, Run};
use mango_external_agents::testing::{Announcer, FakeLauncher};
use mango_external_agents::{ExitStatus, Limits};
use serde_json::{Value, json};

use super::test_support::{self as fixtures, CodexPeer, Rig};
use crate::external_agents::wire;

/// The most activities a turn may hold open at once, on all three harnesses.
const OPEN_ACTIVITY_BOUND: usize = 1_024;

/// Room for every start, every close and the terminal, so the turn queue is not what ends the turn.
fn roomy_limits() -> Limits {
    Limits {
        turn_channel_capacity: 4 * OPEN_ACTIVITY_BOUND,
        ..fixtures::limits()
    }
}

/// Checks the wire events of a turn that overflowed: `OPEN_ACTIVITY_BOUND` starts, each closed with
/// `closed_as`, then one error whose code is `code`.
fn assert_named_overflow(events: &[Value], code: &str, closed_as: &str) {
    let count_of = |kind: &str| {
        events
            .iter()
            .filter(|event| event["event"]["type"] == kind)
            .count()
    };
    let closes: Vec<&str> = events
        .iter()
        .filter(|event| event["event"]["type"] == "activity_completed")
        .map(|event| event["event"]["result"]["status"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(
        (
            count_of("activity_started"),
            closes.len(),
            closes.iter().all(|status| *status == closed_as),
        ),
        (OPEN_ACTIVITY_BOUND, OPEN_ACTIVITY_BOUND, true),
        "expected (starts, closes, every close {closed_as}) before the overflow error of {code} | received {} events",
        events.len()
    );
    let error = &events.last().expect("a non-empty turn")["event"];
    assert_eq!(
        error["type"], "error",
        "expected the turn to end on its overflow error | received {error}"
    );
    let error = &error["error"];
    assert_eq!(
        error["code"], code,
        "expected the harness's own overflow code to reach the hub | received {error}"
    );
    let message = error["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("1024") && message.contains("1025"),
        "expected a message naming the limit 1024 and the count 1025 | received {message:?}"
    );
    assert_eq!(
        error["retryable"], false,
        "expected a runaway turn to be reported as not retryable | received {error}"
    );
}

#[tokio::test]
async fn a_runaway_acp_turn_ends_as_acp_activity_overflow_after_closing_its_calls_as_failed() {
    let updates: Vec<Value> = (0..=OPEN_ACTIVITY_BOUND)
        .map(|index| {
            json!({
                "sessionUpdate": "tool_call",
                "toolCallId": format!("call-{index}"),
                "title": "Run tests",
                "kind": "execute",
                "status": "in_progress",
            })
        })
        .collect();
    let launcher = Arc::new(FakeLauncher::new());
    launcher.push(FakeAcpAgent::new().with_updates(updates).process());
    let mut rig = Rig::new(launcher.clone(), wire::TargetId::Cursor, roomy_limits()).await;
    rig.open().await;
    rig.turn("acp-overflow").await.expect("the turn starts");
    let events = rig.through("error").await;
    assert_named_overflow(&events, "acp-activity-overflow", "failed");
    rig.close().await;
    fixtures::reaped(&launcher).await;
}

#[tokio::test]
async fn a_runaway_codex_turn_ends_as_codex_activity_overflow_after_closing_its_calls_as_failed() {
    let start_frames: Vec<Value> = (0..=OPEN_ACTIVITY_BOUND)
        .map(|index| {
            fixtures::item(
                "item/started",
                json!({
                    "type": "commandExecution",
                    "id": format!("command-{index}"),
                    "command": "git status",
                    "status": "inProgress",
                }),
            )
        })
        .collect();
    let launcher = Arc::new(FakeLauncher::new());
    launcher.push(
        CodexPeer {
            start_frames,
            ..Default::default()
        }
        .process(Announcer::new()),
    );
    let mut rig = Rig::new(launcher.clone(), wire::TargetId::Codex, roomy_limits()).await;
    rig.open().await;
    rig.turn("codex-overflow").await.expect("the turn starts");
    let events = rig.through("error").await;
    assert_named_overflow(&events, "codex-activity-overflow", "failed");
    rig.close().await;
    fixtures::reaped(&launcher).await;
}

/// Claude closes the open calls as cancelled, not failed: its failure path always stops the child
/// and cancels the run's open calls.
#[tokio::test]
async fn a_runaway_claude_turn_ends_as_claude_activity_overflow_after_cancelling_its_calls() {
    let lines: Vec<String> = (0..=OPEN_ACTIVITY_BOUND)
        .map(|index| {
            format!(
                r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"toolu_{index}","name":"Bash","input":{{"command":"sleep 600"}}}}]}}}}"#
            )
        })
        .collect();
    let launcher = Arc::new(
        FakeClaudeCli::new()
            .with_help(HELP_WITH_JSON_SCHEMA)
            .with_turn(Run::Transcript {
                lines,
                exit: ExitStatus {
                    code: Some(0),
                    signal: None,
                },
            }),
    );
    let mut rig = Rig::new(
        Arc::clone(&launcher) as _,
        wire::TargetId::Claude,
        roomy_limits(),
    )
    .await;
    rig.open().await;
    rig.turn("claude-overflow").await.expect("the turn starts");
    let events = rig.through("error").await;
    assert_named_overflow(&events, "claude-activity-overflow", "cancelled");
    rig.close().await;
}
