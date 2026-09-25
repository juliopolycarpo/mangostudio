//! Tests for the event mapper. Every mapped wire event is checked twice: as
//! exact JSON, and against the embedded catalog's `external-agent.event`
//! payload schema inside an envelope.

use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use jsonschema::Validator;
use mango_external_agents as sdk;
use serde_json::{Value, json};

use super::*;
use crate::result_check::{check_result, compile_result_schema};

// ---------------------------------------------------------------------------
// Named fixtures
// ---------------------------------------------------------------------------

const EVENT_AT_MS: u64 = 1_790_000_000_000;
const EXPIRES_AT_MS: u64 = 1_790_000_060_000;
const DETAIL_CAP: usize = 4_096;

fn epoch_plus_ms(ms: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(ms)
}

/// An SDK event around `kind`. `AgentEvent` is non-exhaustive with no public
/// constructor, so it is built through its own serde shape.
fn agent_event(kind: sdk::EventKind) -> sdk::AgentEvent {
    serde_json::from_value(json!({
        "sessionId": "session-1",
        "turnId": "turn-1",
        "attempt": serde_json::to_value(sdk::AttemptId::FIRST).expect("attempt serializes"),
        "at": serde_json::to_value(epoch_plus_ms(EVENT_AT_MS)).expect("time serializes"),
        "kind": serde_json::to_value(kind).expect("kind serializes"),
    }))
    .expect("expected a well-formed AgentEvent fixture")
}

fn map(kind: sdk::EventKind) -> MappedEvent {
    map_event(TargetId::Codex, &agent_event(kind))
}

fn event_validator() -> &'static Validator {
    static VALIDATOR: OnceLock<Validator> = OnceLock::new();
    VALIDATOR.get_or_init(|| {
        let topic = mangostudio_runtime_contract::catalog::event("external-agent.event")
            .expect("expected external-agent.event in the embedded catalog");
        compile_result_schema(&topic.payload)
    })
}

fn assert_valid_event(event: &wire::Event) {
    let envelope = wire::EventEnvelope {
        session_id: String::from("session-1"),
        native_turn_id: Some(String::from("turn-1")),
        sequence: 1,
        emitted_at_ms: EVENT_AT_MS,
        event: event.clone(),
    };
    let payload = serde_json::to_value(&envelope).expect("envelope serializes");
    if let Err(error) = check_result("external-agent.event", event_validator(), &payload) {
        panic!("expected a valid external-agent.event payload | received {error}: {payload}");
    }
}

/// Maps `kind`, asserts its wire JSON is exactly `expected`, and validates it.
fn assert_wire(kind: sdk::EventKind, expected: &Value) -> MappedEvent {
    let mapped = map(kind);
    let event = mapped
        .wire
        .as_ref()
        .unwrap_or_else(|| panic!("expected wire event {expected} | received none"));
    let received = serde_json::to_value(event).expect("event serializes");
    assert_eq!(
        &received, expected,
        "expected wire event {expected} | received {received}"
    );
    assert_valid_event(event);
    mapped
}

fn assert_nothing_else(mapped: &MappedEvent) {
    assert_eq!(mapped.opened, None, "expected no interaction opened");
    assert_eq!(mapped.closed, None, "expected no interaction closed");
    assert!(
        mapped.unrenderable.is_none(),
        "expected no unrenderable question"
    );
}

fn interaction(id: &str, kind: sdk::InteractionKind) -> sdk::Interaction {
    sdk::Interaction::new(
        sdk::InteractionId::new(id),
        kind,
        sdk::SessionId::new("session-1"),
        epoch_plus_ms(EXPIRES_AT_MS),
    )
}

/// The four options Codex's command approval offers, as `mango-agent-codex` builds them.
fn codex_command_options() -> Vec<sdk::PermissionOption> {
    use sdk::{PermissionEffect as Effect, PermissionScope as Scope};
    vec![
        sdk::PermissionOption::new("accept", Effect::Allow)
            .with_label("Allow once")
            .with_scope(Scope::Once),
        sdk::PermissionOption::new("acceptForSession", Effect::Allow)
            .with_label("Allow for this session")
            .with_scope(Scope::Session),
        sdk::PermissionOption::new("decline", Effect::Reject)
            .with_label("Deny")
            .with_scope(Scope::Once),
        sdk::PermissionOption::new("cancel", Effect::Other)
            .with_label("Deny and stop the turn")
            .with_risk(sdk::PermissionRisk::Destructive),
    ]
}

fn codex_command_approval() -> sdk::PermissionRequest {
    sdk::PermissionRequest::new(
        interaction("item-7", sdk::InteractionKind::Permission),
        sdk::ActivityKind::Command,
        "rm -rf build",
        codex_command_options(),
    )
    .with_detail("in /work")
}

fn choice(id: &str, label: &str) -> sdk::QuestionOption {
    sdk::QuestionOption::new(sdk::QuestionOptionId::new(id)).with_label(label)
}

fn single_choice(options: Vec<sdk::QuestionOption>) -> sdk::QuestionForm {
    sdk::QuestionForm::Choice {
        options,
        multi_select: false,
    }
}

/// Codex's `requestUserInput` with one multiple-choice question, as `mango-agent-codex` builds it:
/// the question text as the prompt, the header as its detail, the label as each choice id.
fn branch_question() -> sdk::QuestionRequest {
    let question = sdk::Question::new(
        sdk::QuestionId::new("q-branch"),
        "Which branch should I use?",
        single_choice(vec![choice("main", "main"), choice("develop", "develop")]),
    )
    .with_detail("Branch");
    sdk::QuestionRequest::new(
        interaction("round-1", sdk::InteractionKind::Question),
        vec![question],
    )
}

fn question_round(questions: Vec<sdk::Question>) -> sdk::QuestionRequest {
    sdk::QuestionRequest::new(
        interaction("round-2", sdk::InteractionKind::Question),
        questions,
    )
}

fn free_text_question(id: &str) -> sdk::Question {
    sdk::Question::new(
        sdk::QuestionId::new(id),
        "Name the release",
        sdk::QuestionForm::FreeText { placeholder: None },
    )
}

// ---------------------------------------------------------------------------
// One test per event kind
// ---------------------------------------------------------------------------

#[test]
fn turn_started_puts_nothing_on_the_wire() {
    let mapped = map(sdk::EventKind::TurnStarted {
        native_turn_id: String::from("native-1"),
    });
    assert_eq!(mapped, MappedEvent::default(), "expected an empty mapping");
}

#[test]
fn text_delta_maps_one_to_one() {
    let mapped = assert_wire(
        sdk::EventKind::TextDelta {
            text: String::from("hello"),
        },
        &json!({ "type": "text_delta", "text": "hello" }),
    );
    assert_nothing_else(&mapped);
}

#[test]
fn reasoning_events_map_one_to_one() {
    assert_wire(
        sdk::EventKind::ReasoningStarted,
        &json!({ "type": "reasoning_started" }),
    );
    assert_wire(
        sdk::EventKind::ReasoningDelta {
            text: String::from("thinking"),
        },
        &json!({ "type": "reasoning_delta", "text": "thinking" }),
    );
    assert_wire(
        sdk::EventKind::ReasoningEnded,
        &json!({ "type": "reasoning_ended" }),
    );
}

#[test]
fn activity_started_carries_the_view_and_the_sdk_detail() {
    let activity = sdk::Activity::new("commandExecution", sdk::ActivityKind::Command, "cargo test")
        .with_detail("exit 0")
        .with_content(sdk::ActivityContent::Output {
            text: String::from("ignored: detail wins"),
        });
    assert_wire(
        sdk::EventKind::ActivityStarted {
            call_id: String::from("call-1"),
            activity,
        },
        &json!({
            "type": "activity_started",
            "callId": "call-1",
            "activity": {
                "name": "commandExecution",
                "kind": "command",
                "title": "cargo test",
                "detail": "exit 0",
            },
        }),
    );
}

#[test]
fn activity_started_without_a_name_is_named_by_its_kind() {
    assert_wire(
        sdk::EventKind::ActivityStarted {
            call_id: String::from("call-2"),
            activity: sdk::Activity::new("", sdk::ActivityKind::WebSearch, "search"),
        },
        &json!({
            "type": "activity_started",
            "callId": "call-2",
            "activity": { "name": "web-search", "kind": "web-search", "title": "search" },
        }),
    );
}

#[test]
fn every_sdk_activity_kind_has_its_wire_kind() {
    let kinds = [
        (sdk::ActivityKind::Command, "command"),
        (sdk::ActivityKind::FileChange, "file-change"),
        (sdk::ActivityKind::Mcp, "mcp"),
        (sdk::ActivityKind::Subagent, "subagent"),
        (sdk::ActivityKind::WebSearch, "web-search"),
        (sdk::ActivityKind::Image, "image"),
        (sdk::ActivityKind::Plan, "plan"),
        (sdk::ActivityKind::Review, "review"),
        (sdk::ActivityKind::Compaction, "compaction"),
        (sdk::ActivityKind::Other, "other"),
    ];
    for (kind, expected) in kinds {
        let received = serde_json::to_value(activity_kind(kind)).expect("kind serializes");
        assert_eq!(
            received,
            json!(expected),
            "expected kind {expected} | received {received}"
        );
    }
}

#[test]
fn activity_updated_carries_title_and_detail() {
    assert_wire(
        sdk::EventKind::ActivityUpdated {
            call_id: String::from("call-1"),
            update: sdk::ActivityUpdate::new()
                .with_title("cargo test --lib")
                .with_detail("running"),
        },
        &json!({
            "type": "activity_updated",
            "callId": "call-1",
            "update": { "title": "cargo test --lib", "detail": "running" },
        }),
    );
}

#[test]
fn activity_completed_maps_each_status() {
    let statuses = [
        (sdk::ActivityStatus::Completed, "completed"),
        (sdk::ActivityStatus::Failed, "failed"),
        (sdk::ActivityStatus::Cancelled, "cancelled"),
    ];
    for (status, expected) in statuses {
        assert_wire(
            sdk::EventKind::ActivityCompleted {
                call_id: String::from("call-1"),
                result: sdk::ActivityResult::new(status).with_detail("done"),
            },
            &json!({
                "type": "activity_completed",
                "callId": "call-1",
                "result": { "status": expected, "detail": "done" },
            }),
        );
    }
}

#[test]
fn approval_requested_becomes_a_card_and_opens_an_approval() {
    let mapped = assert_wire(
        sdk::EventKind::ApprovalRequested {
            request: codex_command_approval(),
        },
        &json!({
            "type": "approval_requested",
            "request": {
                "requestId": "item-7",
                "kind": "command",
                "title": "rm -rf build",
                "detail": "in /work",
                "options": [
                    { "id": "accept", "labelKey": "externalAgents.approval.option.accept", "isDestructive": false },
                    { "id": "acceptForSession", "labelKey": "externalAgents.approval.option.acceptForSession", "isDestructive": true },
                    { "id": "decline", "labelKey": "externalAgents.approval.option.decline", "isDestructive": false },
                    { "id": "cancel", "rawLabel": "Deny and stop the turn", "isDestructive": true },
                ],
                "expiresAtMs": EXPIRES_AT_MS,
            },
        }),
    );
    assert_eq!(
        mapped.opened,
        Some(PendingInteraction::Approval {
            request_id: String::from("item-7"),
            option_ids: ["accept", "acceptForSession", "decline", "cancel"]
                .map(String::from)
                .to_vec(),
            expires_at_ms: EXPIRES_AT_MS,
        }),
        "expected the approval recorded with its option ids unchanged"
    );
    assert_eq!(mapped.closed, None, "expected nothing closed");
}

#[test]
fn approval_resolved_maps_each_source_and_closes_the_request() {
    let sources = [
        (sdk::DecisionSource::User, "user"),
        (sdk::DecisionSource::AutoReview, "auto-review"),
        (sdk::DecisionSource::Expired, "expired"),
        (sdk::DecisionSource::Cancelled, "cancelled"),
    ];
    let option = &codex_command_options()[0];
    for (source, expected) in sources {
        let mapped = assert_wire(
            sdk::EventKind::ApprovalResolved {
                interaction_id: sdk::InteractionId::new("item-7"),
                decision: sdk::ApprovalDecision::from_option(option, source),
            },
            &json!({
                "type": "approval_resolved",
                "requestId": "item-7",
                "decision": { "optionId": "accept", "source": expected },
            }),
        );
        assert_eq!(
            mapped.closed.as_deref(),
            Some("item-7"),
            "expected item-7 closed for source {expected}"
        );
    }
}

#[test]
fn question_asked_becomes_a_card_whose_options_are_the_choices() {
    let mapped = assert_wire(
        sdk::EventKind::QuestionAsked {
            request: branch_question(),
        },
        &json!({
            "type": "approval_requested",
            "request": {
                "requestId": "round-1",
                "kind": "other",
                "title": "Branch",
                "detail": "Which branch should I use?",
                "options": [
                    { "id": "main", "rawLabel": "main", "isDestructive": false },
                    { "id": "develop", "rawLabel": "develop", "isDestructive": false },
                ],
                "expiresAtMs": EXPIRES_AT_MS,
            },
        }),
    );
    assert_eq!(
        mapped.opened,
        Some(PendingInteraction::Question {
            request_id: String::from("round-1"),
            question_id: String::from("q-branch"),
            choices: vec![
                (String::from("main"), String::from("main")),
                (String::from("develop"), String::from("develop")),
            ],
            expires_at_ms: EXPIRES_AT_MS,
        }),
        "expected the card recorded as a question, never as an approval"
    );
    assert!(
        mapped.unrenderable.is_none(),
        "expected a renderable question"
    );
}

#[test]
fn question_card_prefers_the_round_title_and_keeps_the_rest_as_detail() {
    let mapped = map(sdk::EventKind::QuestionAsked {
        request: branch_question().with_title("Pick a branch"),
    });
    let Some(wire::Event::ApprovalRequested { request }) = mapped.wire else {
        panic!("expected an approval card | received {:?}", mapped.wire);
    };
    assert_eq!(request.title, "Pick a branch", "expected the round title");
    assert_eq!(
        request.detail.as_deref(),
        Some("Which branch should I use?\n\nBranch"),
        "expected the prompt, then the header"
    );
}

#[test]
fn question_resolved_maps_each_outcome_and_closes_the_request() {
    let answered = sdk::QuestionOutcome::Answered {
        answers: vec![sdk::Answer::new(
            sdk::QuestionId::new("q-branch"),
            sdk::AnswerValue::chosen(sdk::QuestionOptionId::new("develop")),
        )],
    };
    let declined = sdk::QuestionOutcome::Answered {
        answers: vec![sdk::Answer::new(
            sdk::QuestionId::new("q-branch"),
            sdk::AnswerValue::Declined,
        )],
    };
    let refused = sdk::QuestionOutcome::Refused {
        reason: sdk::UnsupportedQuestion::SecretCollection,
    };
    let cases = [
        (answered, "develop", "user"),
        (declined, NO_ANSWER_OPTION_ID, "user"),
        (
            sdk::QuestionOutcome::Expired,
            NO_ANSWER_OPTION_ID,
            "expired",
        ),
        (
            sdk::QuestionOutcome::Cancelled,
            NO_ANSWER_OPTION_ID,
            "cancelled",
        ),
        (refused, NO_ANSWER_OPTION_ID, "cancelled"),
    ];
    for (outcome, option_id, source) in cases {
        let mapped = assert_wire(
            sdk::EventKind::QuestionResolved {
                interaction_id: sdk::InteractionId::new("round-1"),
                outcome,
            },
            &json!({
                "type": "approval_resolved",
                "requestId": "round-1",
                "decision": { "optionId": option_id, "source": source },
            }),
        );
        assert_eq!(
            mapped.closed.as_deref(),
            Some("round-1"),
            "expected round-1 closed for {source}/{option_id}"
        );
    }
}

#[test]
fn usage_preserves_absent_versus_zero() {
    let usage = sdk::Usage {
        input_tokens: Some(0),
        output_tokens: Some(12),
        reasoning_tokens: Some(3),
        ..sdk::Usage::default()
    };
    assert_wire(
        sdk::EventKind::Usage { usage },
        &json!({
            "type": "usage",
            "usage": { "inputTokens": 0, "outputTokens": 12, "reasoningTokens": 3 },
        }),
    );
    assert_wire(
        sdk::EventKind::Usage {
            usage: sdk::Usage::default(),
        },
        &json!({ "type": "usage", "usage": {} }),
    );
}

#[test]
fn thread_usage_maps_one_to_one() {
    let usage = sdk::ThreadUsage {
        last: Some(sdk::Usage {
            total_tokens: Some(0),
            ..sdk::Usage::default()
        }),
        total: None,
        context_window_tokens: Some(200_000),
    };
    assert_wire(
        sdk::EventKind::ThreadUsage { usage },
        &json!({
            "type": "thread_usage",
            "usage": { "last": { "totalTokens": 0 }, "contextWindowTokens": 200_000 },
        }),
    );
}

#[test]
fn account_limits_go_through_the_session_mapper() {
    let limits = sdk::AccountLimits {
        windows: vec![sdk::RateLimitWindow {
            label: Some(String::from("5h")),
            used_percent: 42.5,
            window_duration_minutes: Some(300),
            resets_at: Some(epoch_plus_ms(EXPIRES_AT_MS)),
        }],
        plan_type: Some(String::from("pro")),
        observed_at: epoch_plus_ms(EVENT_AT_MS),
    };
    assert_wire(
        sdk::EventKind::AccountLimits { limits },
        &json!({
            "type": "account_limits",
            "limits": {
                "targetId": "codex",
                "windows": [{
                    "label": "5h",
                    "usedPercent": 42.5,
                    "windowDurationMins": 300,
                    "resetsAtMs": EXPIRES_AT_MS,
                }],
                "planType": "pro",
                "observedAtMs": EVENT_AT_MS,
            },
        }),
    );
}

#[test]
fn cancelled_is_a_marker_and_completed_is_the_terminal() {
    for reason in [
        sdk::CancelReason::Requested,
        sdk::CancelReason::ConsentRevoked,
        sdk::CancelReason::Timeout,
        sdk::CancelReason::Shutdown,
    ] {
        assert_wire(
            sdk::EventKind::Cancelled { reason },
            &json!({ "type": "cancelled" }),
        );
    }
    assert_wire(sdk::EventKind::Completed, &json!({ "type": "completed" }));
}

#[test]
fn error_carries_code_message_vendor_code_request_id_and_retryable() {
    let mut error = sdk::VendorError::new(
        sdk::ErrorCode::from_static("codex-turn-failed"),
        "the model is overloaded",
    );
    error.vendor_code = Some(String::from("-32001"));
    error.request_id = Some(String::from("req-9"));
    error.retryable = true;
    assert_wire(
        sdk::EventKind::Error { error },
        &json!({
            "type": "error",
            "error": {
                "code": "codex-turn-failed",
                "message": "the model is overloaded",
                "requestId": "req-9",
                "retryable": true,
                "vendorCode": "-32001",
            },
        }),
    );
}

#[test]
fn an_error_message_past_the_cap_is_cut_and_marked() {
    let error = sdk::VendorError::new(sdk::ErrorCode::new(""), "e".repeat(3_000));
    let mapped = map(sdk::EventKind::Error { error });
    let Some(wire::Event::Error { error }) = &mapped.wire else {
        panic!("expected an error event | received {:?}", mapped.wire);
    };
    assert_eq!(
        error.code, "external_agent_vendor",
        "expected the fallback code"
    );
    assert_eq!(
        error.message.chars().count(),
        2_048,
        "expected the message cut at 2048"
    );
    assert_eq!(error.truncated, Some(true), "expected the cut marked");
    assert_valid_event(mapped.wire.as_ref().expect("checked above"));
}

// ---------------------------------------------------------------------------
// Approval labels
// ---------------------------------------------------------------------------

const ACCEPT: Option<&str> = Some("externalAgents.approval.option.accept");
const GRANT_TURN: Option<&str> = Some("externalAgents.approval.option.grantTurn");
const FOR_SESSION: Option<&str> = Some("externalAgents.approval.option.acceptForSession");
const DECLINE: Option<&str> = Some("externalAgents.approval.option.decline");

/// `(effect, scope, policy_changing, labelKey, isDestructive)`.
type LabelRow = (
    sdk::PermissionEffect,
    Option<sdk::PermissionScope>,
    bool,
    Option<&'static str>,
    bool,
);

/// `(effect, scope, policy_changing) -> (labelKey, isDestructive)`, every combination.
#[test]
fn the_approval_label_table_is_pinned() {
    use sdk::{PermissionEffect as E, PermissionScope as S};
    #[rustfmt::skip]
    let table: [LabelRow; 30] = [
        (E::Allow,  Some(S::Once),       false, ACCEPT,      false),
        (E::Allow,  Some(S::Turn),       false, GRANT_TURN,  false),
        (E::Allow,  Some(S::Session),    false, FOR_SESSION, true),
        (E::Allow,  Some(S::Persistent), false, None,        true),
        (E::Allow,  None,                false, None,        true),
        (E::Allow,  Some(S::Once),       true,  None,        true),
        (E::Allow,  Some(S::Turn),       true,  None,        true),
        (E::Allow,  Some(S::Session),    true,  None,        true),
        (E::Allow,  Some(S::Persistent), true,  None,        true),
        (E::Allow,  None,                true,  None,        true),
        (E::Reject, Some(S::Once),       false, DECLINE,     false),
        (E::Reject, Some(S::Turn),       false, None,        false),
        (E::Reject, Some(S::Session),    false, None,        false),
        (E::Reject, Some(S::Persistent), false, None,        false),
        (E::Reject, None,                false, None,        false),
        (E::Reject, Some(S::Once),       true,  None,        false),
        (E::Reject, Some(S::Turn),       true,  None,        false),
        (E::Reject, Some(S::Session),    true,  None,        false),
        (E::Reject, Some(S::Persistent), true,  None,        false),
        (E::Reject, None,                true,  None,        false),
        (E::Other,  Some(S::Once),       false, None,        false),
        (E::Other,  Some(S::Turn),       false, None,        false),
        (E::Other,  Some(S::Session),    false, None,        false),
        (E::Other,  Some(S::Persistent), false, None,        false),
        (E::Other,  None,                false, None,        false),
        (E::Other,  Some(S::Once),       true,  None,        false),
        (E::Other,  Some(S::Turn),       true,  None,        false),
        (E::Other,  Some(S::Session),    true,  None,        false),
        (E::Other,  Some(S::Persistent), true,  None,        false),
        (E::Other,  None,                true,  None,        false),
    ];
    for (effect, scope, policy_changing, key, destructive) in table {
        let mut option = sdk::PermissionOption::new("opt", effect).with_label("Vendor words");
        option.scope = scope;
        option.policy_changing = policy_changing;
        let (received, _) = approval_option(&option);
        let row = format!("({effect:?}, {scope:?}, policy_changing={policy_changing})");
        assert_eq!(
            received.label_key.as_deref(),
            key,
            "expected labelKey {key:?} for {row} | received {:?}",
            received.label_key
        );
        let expected_raw = key.is_none().then_some("Vendor words");
        assert_eq!(
            received.raw_label.as_deref(),
            expected_raw,
            "expected rawLabel {expected_raw:?} for {row} | received {:?}",
            received.raw_label
        );
        assert_eq!(
            received.is_destructive, destructive,
            "expected isDestructive {destructive} for {row}"
        );
        assert_eq!(
            received.id, "opt",
            "expected the option id unchanged for {row}"
        );
    }
}

#[test]
fn a_policy_changing_allow_never_gets_a_session_or_any_other_key() {
    use sdk::PermissionScope as S;
    for scope in [
        None,
        Some(S::Once),
        Some(S::Turn),
        Some(S::Session),
        Some(S::Persistent),
    ] {
        // ACP's `allow_always`: remembered, reach unstated.
        let mut option = sdk::PermissionOption::new("allow-always", sdk::PermissionEffect::Allow)
            .with_label("Always allow")
            .policy_changing();
        option.scope = scope;
        let (received, _) = approval_option(&option);
        assert_eq!(
            received.label_key, None,
            "expected no labelKey for a policy-changing allow with scope {scope:?} | received {:?}",
            received.label_key
        );
        assert_eq!(
            received.raw_label.as_deref(),
            Some("Always allow"),
            "expected the vendor's words"
        );
        assert!(
            received.is_destructive,
            "expected a standing allow marked destructive"
        );
    }
}

#[test]
fn a_destructive_risk_marks_any_option_destructive() {
    let option = sdk::PermissionOption::new("decline", sdk::PermissionEffect::Reject)
        .with_scope(sdk::PermissionScope::Once)
        .with_risk(sdk::PermissionRisk::Destructive);
    let (received, _) = approval_option(&option);
    assert!(
        received.is_destructive,
        "expected the vendor's destructive risk kept"
    );
}

#[test]
fn an_unlabelled_option_without_a_key_is_labelled_by_its_id() {
    let option = sdk::PermissionOption::new("reject_always", sdk::PermissionEffect::Reject)
        .policy_changing();
    let (received, _) = approval_option(&option);
    assert_eq!(
        received.raw_label.as_deref(),
        Some("reject_always"),
        "expected the id as the label | received {:?}",
        received.raw_label
    );
}

#[test]
fn an_overlong_option_label_is_cut_and_marks_the_card() {
    let options = vec![
        sdk::PermissionOption::new("x", sdk::PermissionEffect::Other).with_label("l".repeat(200)),
    ];
    let request = sdk::PermissionRequest::new(
        interaction("item-8", sdk::InteractionKind::Permission),
        sdk::ActivityKind::Other,
        "t".repeat(300),
        options,
    );
    let mapped = map(sdk::EventKind::ApprovalRequested { request });
    let Some(wire::Event::ApprovalRequested { request }) = &mapped.wire else {
        panic!("expected an approval card | received {:?}", mapped.wire);
    };
    assert_eq!(
        request.title.chars().count(),
        256,
        "expected the title cut at 256"
    );
    let label = request.options[0].raw_label.as_deref().unwrap_or_default();
    assert_eq!(label.chars().count(), 128, "expected the label cut at 128");
    assert_eq!(
        request.truncated,
        Some(true),
        "expected the card marked truncated"
    );
    assert_valid_event(mapped.wire.as_ref().expect("checked above"));
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

#[test]
fn a_question_round_trips_as_a_question_response() {
    let request = branch_question();
    let mapped = map(sdk::EventKind::QuestionAsked {
        request: request.clone(),
    });
    let Some(wire::Event::ApprovalRequested { request: card }) = &mapped.wire else {
        panic!("expected an approval card | received {:?}", mapped.wire);
    };
    let card_ids: Vec<&str> = card
        .options
        .iter()
        .map(|option| option.id.as_str())
        .collect();
    assert_eq!(
        card_ids,
        ["main", "develop"],
        "expected the card ids to be the choice ids"
    );
    let pending = mapped.opened.expect("expected a pending question");

    let response = match answer(&pending, "develop") {
        Ok(Answer::Question(response)) => response,
        other => panic!("expected a QuestionResponse | received {other:?}"),
    };
    assert_eq!(
        response,
        sdk::QuestionResponse::new(
            sdk::InteractionId::new("round-1"),
            vec![sdk::Answer::new(
                sdk::QuestionId::new("q-branch"),
                sdk::AnswerValue::chosen(sdk::QuestionOptionId::new("develop")),
            )],
        ),
        "expected the chosen id sent as the question's answer"
    );
    if let Err(error) = request.validate(&response) {
        panic!("expected the SDK to accept the answer | received {error}");
    }
}

#[test]
fn a_question_never_answers_as_a_permission() {
    let pending = map(sdk::EventKind::QuestionAsked {
        request: branch_question(),
    })
    .opened
    .expect("expected a pending question");
    for option_id in ["main", "develop"] {
        let received = answer(&pending, option_id);
        assert!(
            matches!(received, Ok(Answer::Question(_))),
            "expected Answer::Question for {option_id} | received {received:?}"
        );
    }
}

#[test]
fn an_approval_answers_as_a_permission_response() {
    let pending = map(sdk::EventKind::ApprovalRequested {
        request: codex_command_approval(),
    })
    .opened
    .expect("expected a pending approval");
    let received = answer(&pending, "decline");
    assert_eq!(
        received.ok(),
        Some(Answer::Permission(sdk::PermissionResponse::from_user(
            sdk::InteractionId::new("item-7"),
            "decline",
        ))),
        "expected a user permission response naming decline"
    );
}

#[test]
fn an_unknown_option_is_refused_by_name() {
    let question = map(sdk::EventKind::QuestionAsked {
        request: branch_question(),
    })
    .opened
    .expect("expected a pending question");
    let approval = map(sdk::EventKind::ApprovalRequested {
        request: codex_command_approval(),
    })
    .opened
    .expect("expected a pending approval");
    for (pending, offered) in [
        (&question, "\"main\", \"develop\""),
        (&approval, "\"accept\""),
    ] {
        let error = answer(pending, "release").expect_err("expected an unknown option refused");
        assert!(
            error.message.contains("\"release\"") && error.message.contains(offered),
            "expected a message naming \"release\" and {offered} | received {}",
            error.message
        );
        let kind = error
            .details
            .as_ref()
            .and_then(|details| details.get("kind"));
        assert_eq!(
            kind,
            Some(&json!("tool_argument")),
            "expected a tool_argument error | received {kind:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// Unrenderable questions
// ---------------------------------------------------------------------------

fn assert_declined(request: &sdk::QuestionRequest, reason: &str) {
    let mapped = map(sdk::EventKind::QuestionAsked {
        request: request.clone(),
    });
    assert_eq!(mapped.wire, None, "expected no wire event for: {reason}");
    assert_eq!(mapped.opened, None, "expected nothing opened for: {reason}");
    let (response, received_reason) = mapped
        .unrenderable
        .unwrap_or_else(|| panic!("expected an unrenderable decline for: {reason}"));
    assert_eq!(received_reason, reason, "expected the reason named");
    let expected = sdk::QuestionResponse::new(
        request.interaction.id.clone(),
        request
            .questions
            .iter()
            .map(|question| sdk::Answer::new(question.id.clone(), sdk::AnswerValue::Declined))
            .collect(),
    );
    assert_eq!(
        response, expected,
        "expected every question declined for: {reason}"
    );
    if let Err(error) = request.validate(&response) {
        panic!("expected the SDK to accept the decline for: {reason} | received {error}");
    }
}

#[test]
fn several_questions_are_declined() {
    let request = question_round(vec![free_text_question("q-1"), free_text_question("q-2")]);
    assert_declined(&request, unrenderable::SEVERAL_QUESTIONS);
}

#[test]
fn a_free_text_question_is_declined() {
    assert_declined(
        &question_round(vec![free_text_question("q-1")]),
        unrenderable::FREE_TEXT,
    );
}

#[test]
fn a_multi_select_question_is_declined() {
    let question = sdk::Question::new(
        sdk::QuestionId::new("q-1"),
        "Which files?",
        sdk::QuestionForm::Choice {
            options: vec![choice("a", "a"), choice("b", "b")],
            multi_select: true,
        },
    );
    assert_declined(&question_round(vec![question]), unrenderable::MULTI_SELECT);
}

#[test]
fn a_question_without_choices_is_declined() {
    let question = sdk::Question::new(sdk::QuestionId::new("q-1"), "Pick", single_choice(vec![]));
    assert_declined(&question_round(vec![question]), unrenderable::NO_OPTIONS);
}

#[test]
fn a_question_with_more_choices_than_a_card_carries_is_declined() {
    let choices = (0..17)
        .map(|index| choice(&format!("c{index}"), "c"))
        .collect();
    let question = sdk::Question::new(sdk::QuestionId::new("q-1"), "Pick", single_choice(choices));
    assert_declined(
        &question_round(vec![question]),
        unrenderable::TOO_MANY_OPTIONS,
    );
}

/// The option ids of a mapped card, in wire order.
fn card_option_ids(mapped: &MappedEvent) -> Vec<String> {
    let Some(wire::Event::ApprovalRequested { request }) = &mapped.wire else {
        panic!("expected an approval card | received {:?}", mapped.wire);
    };
    request
        .options
        .iter()
        .map(|option| option.id.clone())
        .collect()
}

/// Sixteen is the cap itself, not past it: a card with exactly
/// `APPROVAL_MAX_OPTIONS` choices is shown, never declined.
#[test]
fn a_question_with_exactly_the_maximum_choices_is_a_card() {
    assert_eq!(
        APPROVAL_MAX_OPTIONS, 16,
        "expected the card cap the wire carries"
    );
    let ids: Vec<String> = (0..APPROVAL_MAX_OPTIONS)
        .map(|index| format!("c{index}"))
        .collect();
    let choices = ids.iter().map(|id| choice(id, id)).collect();
    let question = sdk::Question::new(sdk::QuestionId::new("q-1"), "Pick", single_choice(choices));
    let mapped = map(sdk::EventKind::QuestionAsked {
        request: question_round(vec![question]),
    });
    assert!(
        mapped.unrenderable.is_none(),
        "expected 16 choices shown, not declined | received {:?}",
        mapped.unrenderable.as_ref().map(|(_, reason)| reason)
    );
    assert_eq!(
        card_option_ids(&mapped),
        ids,
        "expected every one of the 16 choices on the card"
    );
    assert_valid_event(mapped.wire.as_ref().expect("a card"));
}

/// The same cap for a vendor approval: all 16 options reach the card and
/// the pending approval, and the envelope fits the wire schema.
#[test]
fn an_approval_with_exactly_the_maximum_options_is_a_card() {
    let ids: Vec<String> = (0..APPROVAL_MAX_OPTIONS)
        .map(|index| format!("o{index}"))
        .collect();
    let options = ids
        .iter()
        .map(|id| {
            sdk::PermissionOption::new(id.clone(), sdk::PermissionEffect::Other).with_label(id)
        })
        .collect();
    let request = sdk::PermissionRequest::new(
        interaction("item-16", sdk::InteractionKind::Permission),
        sdk::ActivityKind::Command,
        "pick one of sixteen",
        options,
    );
    let mapped = map(sdk::EventKind::ApprovalRequested { request });
    assert_eq!(
        card_option_ids(&mapped),
        ids,
        "expected every one of the 16 options on the card"
    );
    assert_eq!(
        mapped.opened,
        Some(PendingInteraction::Approval {
            request_id: String::from("item-16"),
            option_ids: ids,
            expires_at_ms: EXPIRES_AT_MS,
        }),
        "expected the approval pending with all 16 option ids"
    );
    assert_valid_event(mapped.wire.as_ref().expect("a card"));
}

#[test]
fn a_round_with_no_questions_is_declined() {
    assert_declined(&question_round(Vec::new()), unrenderable::NO_QUESTIONS);
}

/// Pins a supervisor-facing fact: the SDK refuses a Declined answer to a
/// required question, so an unrenderable required round cannot be declined
/// and must be left to expire or the turn cancelled.
#[test]
fn the_sdk_refuses_to_decline_a_required_question() {
    let request = question_round(vec![free_text_question("q-1").required()]);
    let (response, _) = map(sdk::EventKind::QuestionAsked {
        request: request.clone(),
    })
    .unrenderable
    .expect("expected an unrenderable decline");
    let received = request.validate(&response);
    assert!(
        received.is_err(),
        "expected the SDK to refuse declining a required question | received {received:?}"
    );
}

// ---------------------------------------------------------------------------
// Content rendering
// ---------------------------------------------------------------------------

fn update_detail(update: sdk::ActivityUpdate) -> Value {
    let mapped = map(sdk::EventKind::ActivityUpdated {
        call_id: String::from("call-1"),
        update,
    });
    let event = mapped.wire.expect("expected an activity update");
    assert_valid_event(&event);
    serde_json::to_value(event).expect("event serializes")["update"].clone()
}

#[test]
fn a_plan_renders_as_its_steps() {
    let plan = sdk::ActivityContent::Plan {
        steps: vec![
            sdk::PlanStep::new("read the reducer").with_status(sdk::PlanStepStatus::Completed),
            sdk::PlanStep::new("write the test").with_status(sdk::PlanStepStatus::InProgress),
            sdk::PlanStep::new("ship it"),
        ],
    };
    assert_eq!(
        update_detail(sdk::ActivityUpdate::new().with_content(plan)),
        json!({ "detail": "[completed] read the reducer\n[in progress] write the test\n[pending] ship it" }),
    );
}

#[test]
fn a_diff_renders_as_a_file_summary_without_bodies() {
    let diff = sdk::ActivityContent::Diff {
        files: vec![
            sdk::FileChange::new("src/lib.rs")
                .with_kind(sdk::FileChangeKind::Modified)
                .with_line_counts(3, 1)
                .with_unified_diff("@@ -1 +1 @@\n-secret body\n+other"),
            sdk::FileChange::new("new.rs").moved_from("old.rs"),
            sdk::FileChange::new("notes.md").with_new_text("hello"),
        ],
    };
    assert_eq!(
        update_detail(sdk::ActivityUpdate::new().with_content(diff)),
        json!({ "detail": "modified src/lib.rs (+3 -1)\nrenamed old.rs → new.rs\nchanged notes.md" }),
    );
}

#[test]
fn output_renders_as_its_text_and_is_cut_at_the_detail_cap() {
    assert_eq!(
        update_detail(
            sdk::ActivityUpdate::new().with_content(sdk::ActivityContent::Output {
                text: String::from("ok\n"),
            })
        ),
        json!({ "detail": "ok\n" }),
    );
    let long = "é".repeat(DETAIL_CAP + 10);
    let update = update_detail(
        sdk::ActivityUpdate::new().with_content(sdk::ActivityContent::Output { text: long }),
    );
    let detail = update["detail"].as_str().unwrap_or_default();
    assert_eq!(
        detail.chars().count(),
        DETAIL_CAP,
        "expected detail cut at {DETAIL_CAP}"
    );
    assert_eq!(update["truncated"], json!(true), "expected the cut marked");
}

#[test]
fn an_uncut_detail_is_not_marked_truncated() {
    let update = update_detail(sdk::ActivityUpdate::new().with_content(
        sdk::ActivityContent::Output {
            text: "x".repeat(DETAIL_CAP),
        },
    ));
    assert_eq!(
        update.get("truncated"),
        None,
        "expected no truncated flag at exactly the cap"
    );
}

#[test]
fn keep_and_clear_are_distinct_on_the_wire() {
    let cases = [
        (
            "keep: no detail, no content",
            sdk::ActivityUpdate::new(),
            json!({}),
        ),
        (
            "clear: empty content",
            sdk::ActivityUpdate::new().with_content(sdk::ActivityContent::Empty),
            json!({ "detail": "" }),
        ),
        (
            "clear: ACP's empty detail with empty content",
            sdk::ActivityUpdate::new()
                .with_detail("")
                .with_content(sdk::ActivityContent::Empty),
            json!({ "detail": "" }),
        ),
        (
            "sdk detail wins over content",
            sdk::ActivityUpdate::new()
                .with_detail("from the harness")
                .with_content(sdk::ActivityContent::Output {
                    text: String::from("from content"),
                }),
            json!({ "detail": "from the harness" }),
        ),
    ];
    for (case, update, expected) in cases {
        let received = update_detail(update);
        assert_eq!(
            received, expected,
            "expected {expected} for {case} | received {received}"
        );
    }
}

#[test]
fn a_completed_activity_with_empty_content_clears_its_detail() {
    assert_wire(
        sdk::EventKind::ActivityCompleted {
            call_id: String::from("call-1"),
            result: sdk::ActivityResult::new(sdk::ActivityStatus::Completed)
                .with_content(sdk::ActivityContent::Empty),
        },
        &json!({
            "type": "activity_completed",
            "callId": "call-1",
            "result": { "status": "completed", "detail": "" },
        }),
    );
}

#[test]
fn request_id_names_either_pending_kind() {
    let approval = map(sdk::EventKind::ApprovalRequested {
        request: codex_command_approval(),
    })
    .opened
    .expect("expected a pending approval");
    let question = map(sdk::EventKind::QuestionAsked {
        request: branch_question(),
    })
    .opened
    .expect("expected a pending question");
    assert_eq!(
        approval.request_id(),
        "item-7",
        "expected the approval's request id"
    );
    assert_eq!(
        question.request_id(),
        "round-1",
        "expected the question's request id"
    );
}

// ---------------------------------------------------------------------------
// Command catalog
// ---------------------------------------------------------------------------

/// A description that is empty or only whitespace says nothing, so the row
/// carries none rather than a blank the picker would render.
#[test]
fn a_blank_command_description_is_omitted() {
    let catalog = commands(&[
        sdk::Command::new("review").with_description("   \n\t "),
        sdk::Command::new("plan").with_description(""),
        sdk::Command::new("fix").with_description("Fixes the build"),
    ]);
    let received = serde_json::to_value(&catalog).expect("catalog serializes");
    assert_eq!(
        received,
        json!([
            { "name": "review" },
            { "name": "plan" },
            { "name": "fix", "description": "Fixes the build" },
        ]),
        "expected blank descriptions omitted and a real one kept | received {received}"
    );
    assert_valid_event(&wire::Event::CommandsAvailable { commands: catalog });
}

/// An empty catalog is a fact (the vendor offers nothing to type), so it is
/// an empty list on the wire, not a swallowed event. The SDK's catalog is a
/// typed `Vec`, so the TypeScript "non-list" case cannot reach this mapper.
#[test]
fn an_empty_command_catalog_is_an_empty_list_on_the_wire() {
    let catalog = commands(&[]);
    assert!(
        catalog.is_empty(),
        "expected an empty catalog | received {catalog:?}"
    );
    let event = wire::Event::CommandsAvailable { commands: catalog };
    assert_eq!(
        serde_json::to_value(&event).expect("event serializes"),
        json!({ "type": "commands_available", "commands": [] }),
        "expected an empty commands list, not an absent one"
    );
    assert_valid_event(&event);
}
