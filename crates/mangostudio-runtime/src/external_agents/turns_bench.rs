//! Opt-in measurements of the production receipt digest and request preparation.
//! Fixtures are prepared before timing; libtest never runs these in normal gates.

use std::hint::black_box;
use std::time::Instant;

use super::{decoded_attachments, fingerprint, turn_request};
use crate::external_agents::wire::{
    ApprovalRouting, Attachment, AttachmentKind, Configuration, PermissionLevel, TurnParams,
};

pub(super) const CASES: [&str; 5] = ["ordinary", "ascii", "control", "images", "combined"];

/// Builds the same input envelope on both revisions, without vendor I/O.
pub(super) fn fixture(case: &str) -> TurnParams {
    let input = match case {
        "ordinary" | "images" => "Review this change.".to_owned(),
        "ascii" => "x".repeat(200_000),
        "control" | "combined" => "\0".repeat(200_000),
        _ => panic!("Invalid benchmark fixture {case:?}; expected one of {CASES:?}."),
    };
    let attachments = matches!(case, "images" | "combined").then(|| {
        use base64::Engine as _;
        let bytes = vec![b'x'; 2 * 1024 * 1024];
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        (0..4)
            .map(|index| Attachment {
                id: format!("image-{index}"),
                original_name: "fixture.png".into(),
                mime_type: "image/png".into(),
                size_bytes: bytes.len() as u64,
                kind: AttachmentKind::Image,
                bytes_base64: encoded.clone(),
            })
            .collect::<Vec<_>>()
    });
    TurnParams {
        session_id: "session-bench".into(),
        client_message_id: "message-bench".into(),
        input,
        configuration: Configuration {
            model: None,
            effort: None,
            level: PermissionLevel::Default,
            routing: ApprovalRouting::User,
            workspace_roots: vec!["/work".into()],
        },
        attachments,
    }
}

fn measure_fingerprint(case: &str) {
    let params = fixture(case);
    let iterations = if case == "ordinary" { 20_000 } else { 40 };
    let started = Instant::now();
    for _ in 0..iterations {
        black_box(fingerprint(black_box(&params)));
    }
    let elapsed_ns = started.elapsed().as_nanos();
    print_sample(case, "fingerprint", &params, iterations, elapsed_ns);
}

fn measure_request(case: &str) {
    let template = fixture(case);
    let iterations = if case == "ordinary" { 10_000 } else { 40 };
    let mut elapsed_ns = 0;
    for _ in 0..iterations {
        let mut params = template.clone();
        let attachments = decoded_attachments(params.attachments.as_deref().unwrap_or_default())
            .expect("expected valid attachment bytes");
        let started = Instant::now();
        let request = turn_request(black_box(&mut params), attachments);
        black_box(&request);
        // Include both revisions' destruction cost. Moving the encoded source's
        // release earlier must not be mistaken for adding work to the Head.
        drop(request);
        drop(params);
        elapsed_ns += started.elapsed().as_nanos();
    }
    print_sample(case, "request", &template, iterations, elapsed_ns);
}

fn print_sample(
    case: &str,
    operation: &str,
    params: &TurnParams,
    iterations: u32,
    elapsed_ns: u128,
) {
    let attachments = params.attachments.as_deref().unwrap_or_default();
    println!(
        "EXTERNAL_AGENT_BOUNDARY_SAMPLE {}",
        serde_json::json!({
            "case": case, "operation": operation, "iterations": iterations,
            "sourceSha": option_env!("MANGOSTUDIO_BENCH_SOURCE_SHA").unwrap_or("unrecorded"),
            "elapsedNs": elapsed_ns, "inputBytes": params.input.len(),
            "encodedAttachmentBytes": attachments.iter().map(|item| item.bytes_base64.len()).sum::<usize>(),
            "decodedAttachmentBytes": attachments.iter().map(|item| item.size_bytes).sum::<u64>(),
            "attachmentCount": attachments.len(),
            "serializedBytes": crate::json_size::serialized_len(params).expect("fixture serializes"),
        })
    );
}

macro_rules! measurements {
    ($function:ident, $(($name:ident, $case:literal)),+ $(,)?) => {
        $(
            #[test]
            #[ignore = "non-gating benchmark; run through scripts/bench/external-agent-boundary.ts"]
            fn $name() { $function($case); }
        )+
    };
}

measurements!(
    measure_fingerprint,
    (fingerprint_ordinary, "ordinary"),
    (fingerprint_ascii, "ascii"),
    (fingerprint_control, "control"),
    (fingerprint_images, "images"),
    (fingerprint_combined, "combined"),
);
measurements!(
    measure_request,
    (request_ordinary, "ordinary"),
    (request_ascii, "ascii"),
    (request_control, "control"),
    (request_images, "images"),
    (request_combined, "combined"),
);

#[test]
fn fixtures_match_the_product_input_and_attachment_limits() {
    for case in CASES {
        let params = fixture(case);
        assert!(params.input.len() <= 200_000);
        let attachments = params.attachments.as_deref().unwrap_or_default();
        assert!(attachments.len() <= 4);
        let decoded = decoded_attachments(attachments).expect("fixture bytes are valid base64");
        assert!(
            decoded
                .iter()
                .all(|item| item.bytes.len() == 2 * 1024 * 1024)
        );
        assert_eq!(attachments.len(), decoded.len());
    }
}

#[test]
#[ignore = "non-gating benchmark; run through scripts/bench/external-agent-boundary.ts"]
fn json_size_large_event() {
    let event = crate::external_agents::wire::Event::TextDelta {
        text: "x".repeat(1024 * 1024),
    };
    let expected = 1024 * 1024 + 31;
    assert_eq!(crate::json_size::serialized_len(&event).unwrap(), expected);
    let iterations = 100;
    let started = Instant::now();
    for _ in 0..iterations {
        black_box(crate::json_size::serialized_len(black_box(&event)).unwrap());
    }
    let elapsed_ns = started.elapsed().as_nanos();
    println!(
        "EXTERNAL_AGENT_BOUNDARY_SAMPLE {}",
        serde_json::json!({
            "case": "large-event", "operation": "json-size", "iterations": iterations, "elapsedNs": elapsed_ns,
            "sourceSha": option_env!("MANGOSTUDIO_BENCH_SOURCE_SHA").unwrap_or("unrecorded"),
            "inputBytes": 1024 * 1024, "encodedAttachmentBytes": 0, "decodedAttachmentBytes": 0,
            "attachmentCount": 0, "serializedBytes": expected,
        })
    );
}
