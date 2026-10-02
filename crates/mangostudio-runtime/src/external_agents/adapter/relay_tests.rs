//! SDK 0.3.1 sequences observed through the owned session and product event topic.
use std::sync::Arc;

use mango_agent_acp::testing::FakeAcpAgent;
use mango_external_agents::testing::{Announcer, FakeLauncher};
use serde_json::{Value, json};

use super::test_support::{self as fixtures, CodexPeer, Rig, THREAD, TURN};
use crate::external_agents::wire;

const REJECTED_SECRET: &str = "synthetic-hidden-refusal-value";

fn sdk_event(kind: mango_external_agents::EventKind) -> mango_external_agents::AgentEvent {
    serde_json::from_value(json!({
        "sessionId":"sdk-session", "turnId":"sdk-turn",
        "attempt":mango_external_agents::AttemptId::FIRST,
        "at":std::time::SystemTime::UNIX_EPOCH,"kind":kind
    }))
    .expect("a valid SDK event fixture")
}

#[test]
fn an_overlong_standing_rule_label_is_marked_truncated_at_the_adapter_seam() {
    use mango_external_agents as sdk;
    let prefix = vec!["git".to_owned(), "a".repeat(115)];
    let label = format!(
        "Allow, and always allow commands starting with {}",
        serde_json::to_string(&prefix).unwrap()
    );
    let request = sdk::PermissionRequest::new(
        sdk::Interaction::new(
            sdk::InteractionId::new("rule"),
            sdk::InteractionKind::Permission,
            sdk::SessionId::new("sdk-session"),
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_900_000_000),
        ),
        sdk::ActivityKind::Command,
        "git status",
        vec![
            sdk::PermissionOption::new(
                "acceptWithExecpolicyAmendment",
                sdk::PermissionEffect::Other,
            )
            .with_label(label)
            .policy_changing(),
        ],
    );
    let mapped = super::map_events::map_event(
        wire::TargetId::Codex,
        &sdk_event(sdk::EventKind::ApprovalRequested { request }),
    );
    let Some(wire::Event::ApprovalRequested { request }) = mapped.wire else {
        panic!("expected a bounded approval");
    };
    assert_eq!(
        request.options[0]
            .raw_label
            .as_ref()
            .unwrap()
            .chars()
            .count(),
        128
    );
    assert_eq!(request.truncated, Some(true));
    assert_eq!(request.options[0].label_key, None);
}

#[test]
fn current_nonexhaustive_event_fallback_does_not_fabricate_a_product_terminal() {
    let event = sdk_event(mango_external_agents::EventKind::TurnStarted {
        native_turn_id: "sdk-turn".into(),
    });
    assert_eq!(
        super::map_events::map_event(wire::TargetId::Codex, &event),
        super::map_events::MappedEvent::default()
    );
}

#[tokio::test]
async fn real_codex_network_standing_rule_labels_preserve_the_host_and_allow_or_deny_action() {
    for action in ["allow", "deny"] {
        let launcher = Arc::new(FakeLauncher::new());
        let mut request = fixtures::approval(Vec::new());
        request["params"]["proposedNetworkPolicyAmendments"] =
            json!([{"host":"synthetic.example.test","action":action}]);
        launcher.push(
            CodexPeer {
                start_frames: vec![request],
                ..Default::default()
            }
            .process(Announcer::new()),
        );
        let mut rig = Rig::new(launcher.clone(), wire::TargetId::Codex, fixtures::limits()).await;
        rig.open().await;
        rig.turn("network-rule").await.unwrap();
        let events = rig.through("approval_requested").await;
        let options = events.last().unwrap()["event"]["request"]["options"]
            .as_array()
            .unwrap();
        let option = options
            .iter()
            .find(|option| option["id"] == "applyNetworkPolicyAmendment")
            .expect("the concrete network rule option");
        let label = option["rawLabel"].as_str().unwrap();
        assert!(label.contains(action) && label.contains("synthetic.example.test"));
        assert!(option.get("labelKey").is_none());
        if action == "deny" {
            assert!(!label.to_lowercase().contains("allow"));
        }
        rig.close().await;
        fixtures::reaped(&launcher).await;
    }
}

#[tokio::test]
async fn explicit_sdk_closes_precede_terminal_without_a_second_close_from_terminal_settlement() {
    let launcher = Arc::new(FakeLauncher::new());
    let reasoning = json!({"type":"reasoning","id":"reasoning-1","summary":[],"content":[]});
    let running = json!({"type":"commandExecution","id":"command-1","command":"git status","status":"inProgress"});
    let finished = json!({"type":"commandExecution","id":"command-1","command":"git status","status":"completed","exitCode":0,"aggregatedOutput":"explicit output"});
    let peer = CodexPeer {
        complete: true,
        start_frames: vec![
            fixtures::item("item/started", reasoning.clone()),
            fixtures::item("item/started", running),
            fixtures::item("item/completed", finished),
            fixtures::item("item/completed", reasoning),
        ],
        ..Default::default()
    };
    launcher.push(peer.process(Announcer::new()));
    let mut rig = Rig::new(launcher.clone(), wire::TargetId::Codex, fixtures::limits()).await;
    rig.open().await;
    rig.turn("explicit-closes").await.unwrap();
    let events = rig.through("completed").await;
    for kind in ["activity_completed", "reasoning_ended"] {
        let positions: Vec<_> = events
            .iter()
            .enumerate()
            .filter(|(_, event)| event["event"]["type"] == kind)
            .map(|(i, _)| i)
            .collect();
        assert_eq!(
            positions.len(),
            1,
            "expected exactly one {kind} before terminal: {events:?}"
        );
        assert!(
            positions[0] < events.len() - 1,
            "explicit close must precede completion"
        );
    }
    let activity = events
        .iter()
        .find(|event| event["event"]["type"] == "activity_completed")
        .unwrap();
    assert_eq!(activity["event"]["callId"], "command-1");
    assert_eq!(activity["event"]["result"]["status"], "completed");
    assert!(
        activity["event"]["result"]["detail"]
            .as_str()
            .unwrap()
            .contains("explicit output")
    );
    for pair in events.windows(2) {
        assert_eq!(
            pair[1]["sequence"].as_u64().unwrap(),
            pair[0]["sequence"].as_u64().unwrap() + 1
        );
    }
    rig.close().await;
    fixtures::reaped(&launcher).await;
}

#[tokio::test]
async fn actual_acp_refused_event_closes_existing_work_before_the_bounded_error() {
    let launcher = Arc::new(FakeLauncher::new());
    launcher.push(FakeAcpAgent::new().with_updates(vec![
        json!({"sessionUpdate":"tool_call","toolCallId":"valid-call","title":"Run tests","kind":"execute","status":"in_progress"}),
        json!({"sessionUpdate":"tool_call","toolCallId":format!("{REJECTED_SECRET}{}", "x".repeat(129)),"title":"Run more tests","kind":"execute","status":"in_progress"})
    ]).process());
    let mut rig = Rig::new(launcher.clone(), wire::TargetId::Cursor, fixtures::limits()).await;
    rig.open().await;
    rig.turn("acp-refused").await.unwrap();
    let events = rig.through("error").await;
    assert_eq!(
        fixtures::shape(&events),
        ["activity_started", "activity_completed", "error"]
    );
    assert_eq!(
        events[events.len() - 2]["event"]["result"]["status"],
        "failed"
    );
    assert_refused(&events, "acp-refused-event");
    rig.close().await;
    fixtures::reaped(&launcher).await;
}

#[tokio::test]
async fn actual_codex_refused_event_closes_existing_work_before_the_bounded_error() {
    let launcher = Arc::new(FakeLauncher::new());
    launcher.push(CodexPeer { start_frames:vec![
        fixtures::item("item/started",json!({"type":"commandExecution","id":"valid-call","command":"git status","status":"inProgress"})),
        fixtures::item("item/started",json!({"type":"commandExecution","id":format!("{REJECTED_SECRET}{}", "x".repeat(129)),"command":"git status","status":"inProgress"}))
    ], ..Default::default() }.process(Announcer::new()));
    let mut rig = Rig::new(launcher.clone(), wire::TargetId::Codex, fixtures::limits()).await;
    rig.open().await;
    rig.turn("codex-refused").await.unwrap();
    let events = rig.through("error").await;
    assert_eq!(
        fixtures::shape(&events),
        ["activity_started", "activity_completed", "error"]
    );
    assert_eq!(
        events[events.len() - 2]["event"]["result"]["status"],
        "failed"
    );
    assert_refused(&events, "codex-refused-event");
    rig.close().await;
    fixtures::reaped(&launcher).await;
}
fn assert_refused(events: &[Value], code: &str) {
    let error = &events.last().unwrap()["event"]["error"];
    assert_eq!(error["code"], code);
    let message = error["message"].as_str().unwrap();
    assert!(message.chars().count() <= 2048, "error message is bounded");
    assert!(
        message.contains("activity call id"),
        "expected refusal cause, received {message:?}"
    );
    assert!(
        !message.contains(REJECTED_SECRET),
        "rejected vendor data must not be replayed"
    );
    assert!(
        !events
            .iter()
            .any(|event| event["event"]["type"] == "completed")
    );
}

#[tokio::test]
async fn a_real_codex_standing_rule_preserves_its_prefix_and_withholds_an_unreadable_rule() {
    for (prefix, truncated) in [
        (vec!["git".into(), "status".into()], false),
        (vec!["git".into(), "a".repeat(115)], true),
    ] {
        let launcher = Arc::new(FakeLauncher::new());
        let announcer = Announcer::new();
        launcher.push(
            CodexPeer {
                start_frames: vec![fixtures::approval(prefix.clone())],
                ..Default::default()
            }
            .process(announcer.clone()),
        );
        let mut rig = Rig::new(launcher.clone(), wire::TargetId::Codex, fixtures::limits()).await;
        rig.open().await;
        rig.turn("standing-rule").await.unwrap();
        let events = rig.through("approval_requested").await;
        let card = &events.last().unwrap()["event"]["request"];
        let option = card["options"]
            .as_array()
            .unwrap()
            .iter()
            .find(|option| option["id"] == "acceptWithExecpolicyAmendment");
        if truncated {
            assert!(
                option.is_none(),
                "the SDK withholds a standing rule whose whole label cannot be shown: {card:?}"
            );
            assert!(
                card["detail"]
                    .as_str()
                    .unwrap()
                    .contains(&serde_json::to_string(&prefix).unwrap())
            );
        } else {
            let option = option.expect("the SDK offers the concrete standing rule");
            assert!(
                option.get("labelKey").is_none(),
                "a standing rule has the vendor's authority label"
            );
            let label = option["rawLabel"].as_str().unwrap();
            assert!(label.contains("git"));
            assert!(label.contains(&serde_json::to_string(&prefix).unwrap()));
            assert_ne!(card["truncated"], true);
        }
        announcer.announce(
            json!({"method":"serverRequest/resolved","params":{"threadId":THREAD,"requestId":501}})
                .to_string(),
        );
        rig.through("approval_resolved").await;
        rig.supervisor
            .cancel(wire::CancelParams {
                session_id: rig.params.session_id.clone(),
                native_turn_id: Some(TURN.into()),
            })
            .await
            .unwrap();
        rig.through("completed").await;
        rig.close().await;
        fixtures::reaped(&launcher).await;
    }
}

#[tokio::test]
async fn sdk_withdrawal_precedes_requested_cancel_and_idle_timeout_remains_a_product_error() {
    for timeout in [false, true] {
        let launcher = Arc::new(FakeLauncher::new());
        let announcer = Announcer::new();
        launcher.push(
            CodexPeer {
                start_frames: vec![fixtures::approval(vec!["git".into(), "status".into()])],
                ..Default::default()
            }
            .process(announcer.clone()),
        );
        let mut limits = fixtures::limits();
        if timeout {
            limits.idle_timeout = std::time::Duration::from_millis(150);
        }
        let mut rig = Rig::new(launcher.clone(), wire::TargetId::Codex, limits).await;
        rig.open().await;
        rig.turn("withdrawn").await.unwrap();
        let opened = rig.through("approval_requested").await;
        let request_id = opened.last().unwrap()["event"]["request"]["requestId"]
            .as_str()
            .unwrap()
            .to_owned();
        announcer.announce(
            json!({"method":"serverRequest/resolved","params":{"threadId":THREAD,"requestId":501}})
                .to_string(),
        );
        let resolved = rig.through("approval_resolved").await;
        assert_eq!(resolved.last().unwrap()["event"]["requestId"], request_id);
        let stale = rig
            .supervisor
            .respond(wire::RespondParams {
                session_id: rig.params.session_id.clone(),
                native_turn_id: TURN.into(),
                request_id,
                option_id: "accept".into(),
            })
            .await
            .unwrap_err();
        assert!(stale.message.contains("not pending"));
        if !timeout {
            rig.supervisor
                .cancel(wire::CancelParams {
                    session_id: rig.params.session_id.clone(),
                    native_turn_id: Some(TURN.into()),
                })
                .await
                .unwrap();
        }
        let terminal = rig
            .through(if timeout { "error" } else { "completed" })
            .await;
        if timeout {
            assert_eq!(
                terminal.last().unwrap()["event"]["error"]["code"],
                "adapter-stream"
            );
            assert!(
                terminal.last().unwrap()["event"]["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("idle timeout")
            );
            assert!(
                !terminal
                    .iter()
                    .any(|event| event["event"]["type"] == "cancelled")
            );
        } else {
            assert_eq!(fixtures::shape(&terminal), ["cancelled", "completed"]);
        }
        rig.close().await;
        fixtures::reaped(&launcher).await;
    }
}
