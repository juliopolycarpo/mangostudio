//! Admission and physical writes through Backend, ProductHarnesses and the selected registry SDK.
#[path = "prompt_budget_support.rs"]
mod fixtures;

use std::sync::Arc;

use base64::Engine as _;
use mango_external_agents::{CancelToken, Limits};
use mango_protocol::codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, encode_frame_bytes};
use mango_protocol::frame::{Frame, Request};
use serde_json::json;

use crate::external_agents::failure::{CleanupOutcome, SessionUsability};
use crate::external_agents::port::{AgentSession, CancelReason, CloseCause, Dispatch};
use crate::external_agents::wire;
use fixtures::{Peer, Rig};

#[test]
fn prompt_budget_shared_fixture_matches_sdk_and_incoming_limits() {
    let product = fixtures::product_limits();
    let rig = Rig::new([]);
    let host = rig
        .backend
        .host(fixtures::host(std::env::temp_dir()), CancelToken::new())
        .unwrap();
    assert_eq!(
        product.attachment_bytes,
        mango_external_agents::session::ATTACHMENT_MAX_BYTES
    );
    assert_eq!(
        product.attachments,
        mango_external_agents::session::TURN_MAX_ATTACHMENTS
    );
    assert!(include_str!("../supervisor.rs").contains(&format!(
        "const DEFAULT_SESSION_CAP: usize = {};",
        product.sessions
    )));
    assert_eq!(product.protocol_frame_bytes, DEFAULT_MAX_FRAME_BYTES);
    assert_eq!(host.limits().turn_buffer_bytes, product.incoming_bytes);
    assert_eq!(host.outbound_buffer_bytes(), product.outbound_bytes);
    assert_eq!(super::ACP_OUTBOUND_BUFFER_BYTES, product.outbound_bytes);
    assert_eq!(
        host.limits().line.max_line_bytes,
        product.incoming_line_bytes
    );
    assert_eq!(
        host.limits().line.max_buffered_bytes,
        Limits::default().line.max_buffered_bytes
    );
    assert_eq!(
        host.limits().max_pending_requests,
        Limits::default().max_pending_requests
    );
    assert_eq!(
        host.limits().request_timeout,
        Limits::default().request_timeout
    );
    assert_eq!(host.limits().idle_timeout, Limits::default().idle_timeout);
    assert_eq!(host.limits().kill_grace, Limits::default().kill_grace);
    assert_eq!(
        host.limits().approval_timeout,
        Limits::default().approval_timeout
    );
    assert_eq!(
        host.limits().turn_channel_capacity,
        Limits::default().turn_channel_capacity
    );
}

#[tokio::test]
async fn prompt_budget_all_five_attachment_kinds_reach_the_actual_acp_frame() {
    for kind in [
        wire::AttachmentKind::Image,
        wire::AttachmentKind::Text,
        wire::AttachmentKind::Pdf,
        wire::AttachmentKind::Data,
        wire::AttachmentKind::Unknown,
    ] {
        let rig = Rig::new([Peer {
            capture_small_frames: true,
            ..Peer::default()
        }]);
        let session = rig.open("all-kinds").await;
        let stream = fixtures::start(
            &*session,
            "controls:\0\u{1}\"\\\n\t世界🦀".into(),
            vec![fixtures::attachment(kind, 3)],
        )
        .await
        .expect("a supported attachment reaches ACP");
        fixtures::complete(stream).await;
        let frames = rig.launcher.frames.records("session/prompt");
        assert_eq!(frames.len(), 1);
        let value = frames[0].value.as_ref().unwrap();
        assert_eq!(frames[0].bytes, serde_json::to_vec(value).unwrap().len());
        assert_eq!(
            value["params"]["prompt"][0]["text"],
            "controls:\0\u{1}\"\\\n\t世界🦀"
        );
        let block = &value["params"]["prompt"][1];
        match kind {
            wire::AttachmentKind::Image => {
                assert_eq!(block["type"], "image");
                assert_eq!(block["data"], "AAAA");
            }
            wire::AttachmentKind::Text => {
                assert_eq!(block["resource"]["text"], "\0\0\0");
            }
            _ => {
                assert_eq!(block["resource"]["blob"], "AAAA");
            }
        }
        session.close(CloseCause::Requested).await.unwrap();
        rig.assert_closed();
    }
}

#[tokio::test]
async fn prompt_budget_maximum_images_and_blobs_are_not_refused_by_the_incoming_budget() {
    let limits = fixtures::product_limits();
    for kind in [
        wire::AttachmentKind::Image,
        wire::AttachmentKind::Pdf,
        wire::AttachmentKind::Data,
        wire::AttachmentKind::Unknown,
    ] {
        let rig = Rig::new([Peer::default()]);
        let session = rig.open("max-binary").await;
        let attachments = (0..limits.attachments)
            .map(|index| {
                let mut attachment = fixtures::attachment(kind, limits.attachment_bytes);
                attachment.id.push_str(&index.to_string());
                attachment
            })
            .collect();
        let stream = fixtures::start(
            &*session,
            "\0".repeat(limits.http_prompt_units),
            attachments,
        )
        .await
        .expect("four maximum product attachments start through the actual SDK");
        fixtures::complete(stream).await;
        let frame = &rig.launcher.frames.records("session/prompt")[0];
        let base64_bytes = limits.attachments * 4 * limits.attachment_bytes.div_ceil(3);
        assert!(frame.bytes >= base64_bytes + limits.http_prompt_units * 6);
        assert!(frame.bytes > limits.incoming_bytes);
        assert!(frame.bytes < limits.outbound_bytes);
        session.close(CloseCause::Requested).await.unwrap();
        rig.assert_closed();
    }
}

#[tokio::test]
async fn prompt_budget_maximum_escaped_text_and_metadata_start_for_both_prompt_contracts() {
    let limits = fixtures::product_limits();
    for prompt_units in [limits.http_prompt_units, limits.runtime_prompt_units] {
        let rig = Rig::new([Peer {
            native_id: "\0".repeat(limits.native_session_id_units),
            ..Peer::default()
        }]);
        let session = rig.open("max-text").await;
        let stream = fixtures::start(
            &*session,
            "\0".repeat(prompt_units),
            fixtures::maximum_text_attachments(),
        )
        .await
        .expect("maximum escaped Text resources and metadata start through the SDK");
        fixtures::complete(stream).await;
        let frame = &rig.launcher.frames.records("session/prompt")[0];
        let variable_bytes = (limits.attachment_bytes * limits.attachments
            + prompt_units
            + limits.attachments
                * (limits.attachment_id_units
                    + limits.attachment_name_units
                    + limits.attachment_mime_units)
            + limits.native_session_id_units)
            * 6;
        assert!(frame.bytes > variable_bytes);
        assert!(
            frame.bytes - variable_bytes < 1024,
            "only bounded ACP literals and the 36-byte request UUID remain"
        );
        assert!(
            limits.outbound_bytes - frame.bytes > 512 * 1024,
            "the maximum schema shape leaves at least 512KiB for small controls"
        );
        session.close(CloseCause::Requested).await.unwrap();
        rig.assert_closed();
    }
}

#[tokio::test]
async fn prompt_budget_a_largest_wire_admitted_turn_is_distinct_from_direct_schema_stress() {
    let limits = fixtures::product_limits();
    let attachments = fixtures::maximum_text_attachments();
    let wire_attachments: Vec<_> = attachments
        .iter()
        .map(|attachment| {
            json!({
                "id":attachment.id,"originalName":attachment.name,"mimeType":attachment.mime_type,
                "kind":"text","sizeBytes":attachment.bytes.len(),
                "bytesBase64":base64::engine::general_purpose::STANDARD.encode(&attachment.bytes)
            })
        })
        .collect();
    let mut frame = Frame::Req(Request {
        id: "synthetic-wire-request".into(),
        method: "external-agent.turn".into(),
        params: json!({"sessionId":"wire-session", "clientMessageId":"wire-turn", "input":"",
            "configuration":fixtures::configuration(),"attachments":wire_attachments}),
    });
    let fixed = encode_frame_bytes(&frame, DEFAULT_MAX_FRAME_BYTES)
        .unwrap()
        .len();
    let remaining = DEFAULT_MAX_FRAME_BYTES - fixed;
    let input = format!(
        "{}{}",
        "\0".repeat(remaining / 6),
        "a".repeat(remaining % 6)
    );
    assert!(input.len() > limits.http_prompt_units && input.len() < limits.runtime_prompt_units);
    let Frame::Req(request) = &mut frame else {
        unreachable!()
    };
    request.params["input"] = input.clone().into();
    assert_eq!(
        encode_frame_bytes(&frame, DEFAULT_MAX_FRAME_BYTES)
            .unwrap()
            .len(),
        DEFAULT_MAX_FRAME_BYTES
    );
    let rig = Rig::new([Peer::default()]);
    let session = rig.open("wire-session").await;
    fixtures::complete(
        fixtures::start(&*session, input, attachments)
            .await
            .unwrap(),
    )
    .await;
    session.close(CloseCause::Requested).await.unwrap();
    rig.assert_closed();
    let Frame::Req(request) = &mut frame else {
        unreachable!()
    };
    request.params["input"] = "\0".repeat(limits.runtime_prompt_units).into();
    assert_eq!(
        encode_frame_bytes(&frame, DEFAULT_MAX_FRAME_BYTES)
            .unwrap_err()
            .kind,
        mango_protocol::error::CodecErrorKind::TooLarge
    );
}

#[tokio::test]
async fn prompt_budget_exact_outbound_limit_and_one_over_keep_the_session_healthy() {
    let rig = Rig::new([Peer::default()]);
    let session = rig.open("exact-budget").await;
    fixtures::complete(
        fixtures::start(
            &*session,
            "hello".into(),
            vec![fixtures::attachment(wire::AttachmentKind::Text, 1)],
        )
        .await
        .unwrap(),
    )
    .await;
    let baseline = rig.launcher.frames.records("session/prompt")[0].bytes;
    let limit = fixtures::product_limits().outbound_bytes;
    // Synthetic metadata outside the product schema fills the adapter/SDK budget exactly.
    // Product-admitted metadata is covered separately above and never needs this much padding.
    let mut exact = fixtures::attachment(wire::AttachmentKind::Text, 1);
    exact.name.push_str(&"a".repeat(limit - baseline));
    fixtures::complete(
        fixtures::start(&*session, "hello".into(), vec![exact])
            .await
            .expect("a frame exactly at the outbound budget is accepted"),
    )
    .await;
    assert_eq!(
        rig.launcher.frames.records("session/prompt")[1].bytes,
        limit
    );
    let mut over = fixtures::attachment(wire::AttachmentKind::Text, 1);
    over.name.push_str(&"a".repeat(limit - baseline + 1));
    let failure = fixtures::start(&*session, "hello".into(), vec![over])
        .await
        .err()
        .expect("one byte over is refused");
    assert_eq!(failure.dispatch, Some(Dispatch::NotSubmitted));
    assert_eq!(failure.session, SessionUsability::Unknown);
    assert_eq!(failure.cleanup, CleanupOutcome::NotRequired);
    assert!(
        failure.remote.message.contains(&(limit + 1).to_string()),
        "the refusal names the actual invalid frame size"
    );
    assert_eq!(rig.launcher.frames.records("session/prompt").len(), 2);
    assert_eq!(rig.launcher.fake.live_children(), 1);
    fixtures::complete(
        fixtures::start(&*session, "healthy recovery".into(), Vec::new())
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(rig.launcher.fake.launches().len(), 1);
    session.close(CloseCause::Requested).await.unwrap();
    rig.assert_closed();
}

#[tokio::test]
async fn prompt_budget_count_per_file_utf8_and_missing_capability_refusals_are_unchanged() {
    let limits = fixtures::product_limits();
    for case in [
        "count",
        "per-file",
        "utf8",
        "image-capability",
        "embedded-capability",
    ] {
        let rig = Rig::new([Peer {
            image: case != "image-capability",
            embedded_context: case != "embedded-capability",
            ..Peer::default()
        }]);
        let session = rig.open(case).await;
        let attachments = match case {
            "count" => (0..=limits.attachments)
                .map(|_| fixtures::attachment(wire::AttachmentKind::Text, 1))
                .collect(),
            "per-file" => vec![fixtures::attachment(
                wire::AttachmentKind::Text,
                limits.attachment_bytes + 1,
            )],
            "utf8" => {
                let mut invalid = fixtures::attachment(wire::AttachmentKind::Text, 1);
                invalid.bytes[0] = 0xff;
                vec![invalid]
            }
            "image-capability" => vec![fixtures::attachment(wire::AttachmentKind::Image, 1)],
            _ => vec![fixtures::attachment(wire::AttachmentKind::Text, 1)],
        };
        let failure = fixtures::start(&*session, "refusal".into(), attachments)
            .await
            .err()
            .expect("invalid input or missing capability is refused");
        let expected = match case {
            "count" => "expected at most 4 attachments on one turn, received 5",
            "per-file" => "expected at most 2097152 bytes in one attachment, received 2097153",
            "utf8" => "valid UTF-8 in a text attachment",
            "image-capability" => "images",
            _ => "advertising the embedded context prompt capability",
        };
        assert!(
            failure.remote.message.contains(expected),
            "{case}: {}",
            failure.remote.message
        );
        assert_eq!(failure.dispatch, Some(Dispatch::NotSubmitted), "{case}");
        assert_eq!(failure.cleanup, CleanupOutcome::NotRequired, "{case}");
        assert_eq!(
            rig.launcher.frames.records("session/prompt").len(),
            0,
            "{case}"
        );
        fixtures::complete(
            fixtures::start(&*session, "next send".into(), Vec::new())
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(rig.launcher.fake.launches().len(), 1, "{case}");
        session.close(CloseCause::Requested).await.unwrap();
        rig.assert_closed();
    }
}

#[tokio::test]
async fn prompt_budget_raw_vendor_ids_are_distinct_from_successful_product_open_ids() {
    let limits = fixtures::product_limits();
    let native_id = "a".repeat(limits.incoming_line_bytes - 512);
    let rig = Rig::new([Peer {
        native_id: native_id.clone(),
        ..Peer::default()
    }]);
    let session = rig.open("raw-sdk-open").await;
    assert_eq!(
        session
            .open_result(&fixtures::configuration())
            .native_session_id,
        native_id
    );
    assert!(
        native_id.len() > limits.native_session_id_units,
        "this is outside the successful Hub open schema"
    );
    fixtures::complete(
        fixtures::start(
            &*session,
            "\0".repeat(limits.http_prompt_units),
            fixtures::maximum_text_attachments(),
        )
        .await
        .expect("a raw SDK ID near the incoming line cap fits the HTTP prompt stress envelope"),
    )
    .await;
    assert!(rig.launcher.frames.records("session/prompt")[0].bytes < limits.outbound_bytes);
    session.close(CloseCause::Requested).await.unwrap();
    rig.assert_closed();
    let oversized = Rig::new([Peer {
        native_id: "a".repeat(limits.incoming_line_bytes),
        ..Peer::default()
    }]);
    use crate::external_agents::port::AgentBackend;
    let failure = oversized
        .backend
        .open(
            wire::TargetId::Cursor,
            "/synthetic/cursor-agent".into(),
            fixtures::host(std::env::temp_dir()),
            &wire::OpenParams {
                session_id: "oversized-open".into(),
                target_id: wire::TargetId::Cursor,
                workspace_path: std::env::temp_dir().to_string_lossy().into_owned(),
                configuration: fixtures::configuration(),
                resume_ref: None,
                resume_mode: wire::ResumeMode::Strict,
                timeout_ms: 120_000,
                toolchain: None,
            },
        )
        .await
        .err()
        .expect("the unchanged incoming line cap refuses the oversized reply");
    assert_eq!(failure.cleanup, CleanupOutcome::NotRequired);
    oversized.assert_closed();
}

#[tokio::test]
async fn prompt_budget_small_cancel_control_fits_beside_a_maximum_prompt() {
    let limits = fixtures::product_limits();
    let rig = Rig::new([Peer {
        hold_prompts: true,
        native_id: "\0".repeat(limits.native_session_id_units),
        ..Peer::default()
    }]);
    let session = rig.open("control-headroom").await;
    let stream = fixtures::start(
        &*session,
        "\0".repeat(limits.runtime_prompt_units),
        fixtures::maximum_text_attachments(),
    )
    .await
    .unwrap();
    rig.launcher.frames.wait_for("session/prompt", 1).await;
    session
        .cancel(CancelReason::Requested)
        .await
        .expect("a small control is accepted while the prompt write is held");
    rig.launcher.frames.release_prompts(1);
    let events = fixtures::drain(stream).await;
    assert!(
        events
            .iter()
            .any(|event| matches!(event, wire::Event::Cancelled))
    );
    assert_eq!(rig.launcher.frames.records("session/cancel").len(), 1);
    let prompt = rig.launcher.frames.records("session/prompt")[0].bytes;
    let cancel = rig.launcher.frames.records("session/cancel")[0].bytes;
    let outbound = rig
        .backend
        .host(fixtures::host(std::env::temp_dir()), CancelToken::new())
        .unwrap()
        .outbound_buffer_bytes();
    assert!(
        prompt + cancel < outbound,
        "the actual outbound allowance includes the held prompt and its control frame"
    );
    assert!(cancel < 2048);
    assert_eq!(rig.launcher.fake.live_children(), 1);
    fixtures::complete(
        fixtures::start(&*session, "after cancellation".into(), Vec::new())
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(rig.launcher.fake.launches().len(), 1);
    session.close(CloseCause::Requested).await.unwrap();
    rig.assert_closed();
}

async fn concurrent_prompt_probe(sessions: usize, text: bool, require_acceptance: bool) {
    let limits = fixtures::product_limits();
    let rig = Rig::new((0..sessions).map(|_| Peer {
        hold_prompts: true,
        native_id: "\0".repeat(limits.native_session_id_units),
        ..Peer::default()
    }));
    let mut children: Vec<Arc<dyn AgentSession>> = Vec::new();
    for index in 0..sessions {
        children.push(rig.open(&format!("memory-{index}")).await.into());
    }
    let mut starts = tokio::task::JoinSet::new();
    for session in &children {
        let session = Arc::clone(session);
        starts.spawn(async move {
            let attachments = if text {
                fixtures::maximum_text_attachments()
            } else {
                let limits = fixtures::product_limits();
                (0..limits.attachments)
                    .map(|index| {
                        let mut attachment = fixtures::attachment(
                            wire::AttachmentKind::Image,
                            limits.attachment_bytes,
                        );
                        attachment.id.push_str(&index.to_string());
                        attachment
                    })
                    .collect()
            };
            let limits = fixtures::product_limits();
            let prompt_units = if text {
                limits.runtime_prompt_units
            } else {
                limits.http_prompt_units
            };
            fixtures::start(&*session, "\0".repeat(prompt_units), attachments).await
        });
    }
    let mut streams = Vec::new();
    let mut refusals = 0;
    while let Some(result) = starts.join_next().await {
        match result.unwrap() {
            Ok(stream) => streams.push(stream),
            Err(failure) => {
                assert_eq!(failure.dispatch, Some(Dispatch::NotSubmitted));
                refusals += 1;
            }
        }
    }
    rig.launcher
        .frames
        .wait_for("session/prompt", streams.len())
        .await;
    if require_acceptance {
        assert_eq!(
            streams.len(),
            sessions,
            "every admitted session starts its maximum prompt"
        );
        assert_eq!(refusals, 0);
    }
    assert_eq!(rig.launcher.fake.live_children(), sessions);
    assert_eq!(rig.launcher.fake.launches().len(), sessions);
    assert!(rig.launcher.fake.written().is_empty());
    assert!(
        rig.launcher
            .frames
            .records("session/prompt")
            .iter()
            .all(|frame| frame.value.is_none())
    );
    #[cfg(target_os = "linux")]
    let hwm = Some(fixtures::vm_hwm_kib());
    #[cfg(not(target_os = "linux"))]
    let hwm: Option<usize> = None;
    assert!(hwm.is_none_or(|value| value > 0));
    let outbound_bytes = rig
        .backend
        .host(fixtures::host(std::env::temp_dir()), CancelToken::new())
        .unwrap()
        .outbound_buffer_bytes();
    let frames: Vec<_> = rig
        .launcher
        .frames
        .records("session/prompt")
        .iter()
        .map(|frame| frame.bytes)
        .collect();
    println!(
        "PROMPT_BUDGET_MEMORY {}",
        json!({"sessions":sessions,"kind":if text {"direct-schema-escaped-text"} else {"http-image"},
        "promptUnits":if text {limits.runtime_prompt_units} else {limits.http_prompt_units},
        "accepted":streams.len(),"refusedNotSubmitted":refusals,"vmHwmKiB":hwm,"frameBytes":frames,
        "incomingBytes":limits.incoming_bytes,"outboundBytes":outbound_bytes,
        "captureRetainedBytes":0,"launcher":"non-retaining-sdk-fake","childrenLiveAtSample":rig.launcher.fake.live_children()})
    );
    rig.launcher.frames.release_prompts(streams.len());
    for session in &children {
        session.cancel(CancelReason::Requested).await.unwrap();
    }
    for stream in streams {
        let events = fixtures::drain(stream).await;
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, wire::Event::Completed))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, wire::Event::Cancelled))
                .count(),
            1
        );
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, wire::Event::Error { .. }))
        );
    }
    if require_acceptance {
        for session in &children {
            fixtures::complete(
                fixtures::start(&**session, "next send".into(), Vec::new())
                    .await
                    .unwrap(),
            )
            .await;
        }
        assert_eq!(rig.launcher.fake.launches().len(), sessions);
    }
    for session in children {
        session.close(CloseCause::Requested).await.unwrap();
    }
    rig.assert_closed();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn prompt_budget_four_concurrent_maximum_sessions_settle_without_orphans() {
    concurrent_prompt_probe(fixtures::product_limits().sessions, true, true).await;
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "non-gating fresh-process Linux memory receipt"]
async fn prompt_budget_memory_one_image() {
    concurrent_prompt_probe(1, false, false).await;
}
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "non-gating fresh-process Linux memory receipt"]
async fn prompt_budget_memory_four_images() {
    concurrent_prompt_probe(4, false, false).await;
}
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "non-gating fresh-process Linux memory receipt"]
async fn prompt_budget_memory_one_text() {
    concurrent_prompt_probe(1, true, false).await;
}
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "non-gating fresh-process Linux memory receipt"]
async fn prompt_budget_memory_four_texts() {
    concurrent_prompt_probe(fixtures::product_limits().sessions, true, false).await;
}
