//! Opt-in measurements of actual text and reasoning event mapping.
use std::hint::black_box;
use std::time::Instant;

use super::{map_owned_event, sdk, wire};

fn fixture(text: String, reasoning: bool) -> sdk::AgentEvent {
    let mut event: sdk::AgentEvent = serde_json::from_value(serde_json::json!({
        "sessionId": "session-bench", "turnId": "turn-bench", "attempt": sdk::AttemptId::FIRST,
        "at": std::time::SystemTime::UNIX_EPOCH,
        "kind": {"type": "completed"},
    }))
    .expect("expected valid SDK event metadata");
    event.kind = if reasoning {
        sdk::EventKind::ReasoningDelta { text }
    } else {
        sdk::EventKind::TextDelta { text }
    };
    event
}

fn measure(reasoning: bool, bytes: usize, slack: bool) {
    let iterations = if bytes == 4096 { 4096 } else { 32 };
    let events: Vec<_> = (0..iterations)
        .map(|_| {
            let mut text = String::with_capacity(if slack { bytes * 4 } else { bytes });
            text.push_str(&"x".repeat(bytes));
            fixture(text, reasoning)
        })
        .collect();
    let started = Instant::now();
    for event in events {
        black_box(map_owned_event(wire::TargetId::Codex, black_box(event)));
    }
    let elapsed_ns = started.elapsed().as_nanos();
    println!(
        "EXTERNAL_AGENT_BOUNDARY_SAMPLE {}",
        serde_json::json!({
            "case": format!("{}-{}{}", if reasoning {"reasoning"} else {"text"}, bytes, if slack {"-slack"} else {""}),
            "operation": "event", "iterations": iterations, "elapsedNs": elapsed_ns,
            "sourceSha": option_env!("MANGOSTUDIO_BENCH_SOURCE_SHA").unwrap_or("unrecorded"),
            "inputBytes": bytes, "encodedAttachmentBytes": 0, "decodedAttachmentBytes": 0,
            "attachmentCount": 0, "serializedBytes": 0, "sourceCapacity": if slack {bytes * 4} else {bytes},
        })
    );
}

macro_rules! measurement {
    ($name:ident, $reasoning:literal, $bytes:literal, $slack:literal) => {
        #[test]
        #[ignore = "non-gating benchmark; run through scripts/bench/external-agent-boundary.ts"]
        fn $name() {
            measure($reasoning, $bytes, $slack);
        }
    };
}
measurement!(text_4096, false, 4096, false);
measurement!(text_1048576, false, 1048576, false);
measurement!(reasoning_4096, true, 4096, false);
measurement!(reasoning_1048576, true, 1048576, false);
measurement!(text_4096_slack, false, 4096, true);
measurement!(reasoning_1048576_slack, true, 1048576, true);

#[test]
fn event_fixture_preserves_the_capacity_under_test() {
    for slack in [false, true] {
        let mut text = String::with_capacity(if slack { 16384 } else { 4096 });
        text.push_str(&"x".repeat(4096));
        let event = fixture(text, false);
        let sdk::EventKind::TextDelta { text } = event.kind else {
            panic!("expected text delta")
        };
        assert_eq!(text.len(), 4096);
        assert_eq!(text.capacity(), if slack { 16384 } else { 4096 });
    }
}

#[test]
#[ignore = "non-gating benchmark; run through scripts/bench/external-agent-boundary.ts"]
fn bounded_text() {
    let raw = "x\0\u{001b}[31m".repeat(512);
    let expected = super::bound(&raw, super::TextLimit::Detail);
    let iterations = 20_000;
    let started = Instant::now();
    for _ in 0..iterations {
        black_box(super::bound(black_box(&raw), super::TextLimit::Detail));
    }
    print_other_sample(
        "bounded-text",
        "re-bound",
        iterations,
        started.elapsed().as_nanos(),
        raw.len(),
        expected.text.len(),
    );
}

#[test]
#[ignore = "non-gating benchmark; run through scripts/bench/external-agent-boundary.ts"]
fn remote_error() {
    let error = sdk::Error::Vendor(sdk::VendorError::new(
        sdk::ErrorCode::from_static("fixture"),
        "sk-live-0123456789 token=abc",
    ))
    .with_dispatch(sdk::Dispatch::AcceptanceUnknown);
    let expected = super::super::map::remote_error(&error);
    assert!(!expected.message.contains("sk-live-0123456789"));
    assert_eq!(
        expected.details.as_ref().unwrap()["dispatch"],
        "acceptance-unknown"
    );
    let iterations = 20_000;
    let started = Instant::now();
    for _ in 0..iterations {
        black_box(super::super::map::remote_error(black_box(&error)));
    }
    print_other_sample(
        "remote-error",
        "remote-error",
        iterations,
        started.elapsed().as_nanos(),
        0,
        0,
    );
}

fn print_other_sample(
    case: &str,
    operation: &str,
    iterations: u32,
    elapsed_ns: u128,
    input_bytes: usize,
    output_bytes: usize,
) {
    println!(
        "EXTERNAL_AGENT_BOUNDARY_SAMPLE {}",
        serde_json::json!({
            "case": case, "operation": operation, "iterations": iterations, "elapsedNs": elapsed_ns,
            "sourceSha": option_env!("MANGOSTUDIO_BENCH_SOURCE_SHA").unwrap_or("unrecorded"),
            "inputBytes": input_bytes, "encodedAttachmentBytes": 0, "decodedAttachmentBytes": 0,
            "attachmentCount": 0, "serializedBytes": output_bytes,
        })
    );
}
