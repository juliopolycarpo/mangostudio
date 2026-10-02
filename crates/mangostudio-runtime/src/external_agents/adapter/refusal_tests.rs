//! Actual SDK failures cross the private adapter before product admission classifies them.
use super::*;
use mango_external_agents::{Capability, Dispatch, HarnessId, TransportKind};

#[derive(Clone, Copy, Debug)]
enum Refusal {
    Limit,
    Host,
    Capability,
    Transport,
}

impl Refusal {
    /// Builds a typed deterministic SDK cause without vendor payloads.
    fn error(self) -> SdkError {
        match self {
            Self::Limit => SdkError::LimitExceeded {
                subject: "bytes of ACP session/prompt frame",
                limit: 8_388_608,
                received: 8_388_940,
            },
            Self::Host => SdkError::HostConfiguration {
                expected: "a nonempty attachment",
                received: "empty attachment".into(),
            },
            Self::Capability => SdkError::NotSupported {
                capability: Capability::NativeReview,
            },
            Self::Transport => SdkError::UnsupportedTransport {
                harness: HarnessId::new("fixture").expect("fixture is a valid harness id"),
                transport: TransportKind::WebSocket,
            },
        }
    }
}

/// Enables native review while retaining the same SDK session/adapter and product rig.
async fn review_rig() -> Rig {
    let (_, finish) = watch::channel(true);
    rig(RigOptions {
        open: OpenBehaviour::Scripted(Script::Reviewing {
            thread: None,
            review_turn: "native-review".into(),
            finish,
        }),
        ..RigOptions::default()
    })
    .await
}

/// Calls the actual supervisor entry point with a stable receipt key.
async fn start(
    rig: &Rig,
    review: bool,
    input: &str,
) -> Result<(), mango_protocol::error::RemoteError> {
    start_with_id(rig, review, input, "message").await
}

/// Uses a distinct key when a conservative committed refusal remains in the receipt ledger.
async fn start_with_id(
    rig: &Rig,
    review: bool,
    input: &str,
    id: &str,
) -> Result<(), mango_protocol::error::RemoteError> {
    if review {
        return rig
            .supervisor
            .start_review(rig.review_params("one", id), &CancellationToken::new())
            .await
            .map(|_| ());
    }
    rig.supervisor
        .turn(rig.turn_params("one", id, input), &CancellationToken::new())
        .await
        .map(|_| ())
}

/// Proves one typed refusal retains the live session and forgets only the absent operation.
async fn assert_message_refusal(cause: Refusal, review: bool) {
    let rig = review_rig().await;
    rig.open("one").await.unwrap();
    let failure = cause.error().with_dispatch(Dispatch::NotSubmitted);
    let message = failure.to_string();
    *rig.log.start_failure.lock().unwrap() = Some(failure);
    let error = start(&rig, review, "invalid").await.unwrap_err();
    assert_eq!(error.message, message);
    assert_eq!(error.code, codes::INTERNAL);
    assert_eq!(
        error.details.as_ref().unwrap()["kind"],
        "external_agent_turn_refused",
        "expected a message-local {cause:?} refusal, not a lost session"
    );
    assert_eq!(error.details.as_ref().unwrap()["dispatch"], "not-submitted");
    assert_eq!(error.details.as_ref().unwrap()["retryable"], false);
    assert_eq!(rig.live_count(), 1);
    assert_eq!(rig.state_of("one"), "idle");
    assert!(
        rig.log.closes().is_empty(),
        "a healthy session must not be reaped"
    );
    let calls = if review {
        &rig.log.reviews
    } else {
        &rig.log.start_calls
    };
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // Changed input under the same key must reach the SDK after proven absence;
    // reviews carry no input, so success itself proves the refused receipt was forgotten.
    start(&rig, review, "valid").await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    rig.idle("one", "the next valid request").await;
    assert!(rig.log.closes().is_empty());
    rig.close("one").await;
}

macro_rules! refusal_case {
    ($name:ident, $cause:ident, $review:expr) => {
        #[tokio::test]
        async fn $name() {
            assert_message_refusal(Refusal::$cause, $review).await;
        }
    };
}

refusal_case!(sdk_limit_turn_refusal_is_message_local, Limit, false);
refusal_case!(sdk_host_turn_refusal_is_message_local, Host, false);
refusal_case!(
    sdk_capability_turn_refusal_is_message_local,
    Capability,
    false
);
refusal_case!(
    sdk_transport_turn_refusal_is_message_local,
    Transport,
    false
);
refusal_case!(sdk_limit_review_refusal_is_message_local, Limit, true);
refusal_case!(sdk_host_review_refusal_is_message_local, Host, true);
refusal_case!(
    sdk_capability_review_refusal_is_message_local,
    Capability,
    true
);
refusal_case!(
    sdk_transport_review_refusal_is_message_local,
    Transport,
    true
);

#[tokio::test]
async fn cleanup_wrapped_spent_session_refusals_close_the_session_once() {
    for review in [false, true] {
        for cancelled in [false, true] {
            for unconfirmed in [false, true] {
                let rig = review_rig().await;
                rig.open("one").await.unwrap();
                let control = Arc::new(RefusalCleanup {
                    unconfirmed,
                    ..Default::default()
                });
                let source = if cancelled {
                    SdkError::Cancelled {
                        reason: CancelReason::Requested,
                    }
                } else {
                    SdkError::Closed { subject: "session" }
                };
                *rig.log.start_failure.lock().unwrap() = Some(SdkError::CleanupRequired {
                    source: Box::new(source.with_dispatch(Dispatch::NotSubmitted)),
                    control: Arc::clone(&control) as Arc<dyn ProcessControl>,
                });
                let error = start(&rig, review, "invalid").await.unwrap_err();
                assert_eq!(error.details.as_ref().unwrap()["kind"], "tool_argument");
                assert!(
                    error.message.contains("expected a new session"),
                    "spent session must be replaced: {error:?}"
                );
                assert_eq!(
                    rig.live_count(),
                    0,
                    "cleanup must not hide the spent session fact"
                );
                assert_eq!(rig.log.closes(), vec![CloseReason::Requested]);
                assert_eq!(control.calls.kills.load(Ordering::SeqCst), 1);
                assert_eq!(control.calls.waits.load(Ordering::SeqCst), 1);
            }
        }
    }
}

#[tokio::test]
async fn unproven_and_committed_input_failures_retain_their_receipt_and_error_facts() {
    for review in [false, true] {
        for cause in [
            Refusal::Limit,
            Refusal::Host,
            Refusal::Capability,
            Refusal::Transport,
        ] {
            for certainty in [
                None,
                Some(Dispatch::Accepted),
                Some(Dispatch::AcceptanceUnknown),
            ] {
                let rig = review_rig().await;
                rig.open("one").await.unwrap();
                let failure = certainty.map_or_else(
                    || cause.error(),
                    |dispatch| cause.error().with_dispatch(dispatch),
                );
                let mapped = crate::external_agents::adapter::sdk_remote_error(&failure);
                *rig.log.start_failure.lock().unwrap() = Some(failure);
                let error = start(&rig, review, "same").await.unwrap_err();
                assert_eq!(
                    (&error.code, &error.message, &error.details),
                    (&mapped.code, &mapped.message, &mapped.details)
                );
                let replay = start(&rig, review, "same").await.unwrap_err();
                assert_eq!(
                    (&replay.code, &replay.message, &replay.details),
                    (&error.code, &error.message, &error.details)
                );
                let calls = if review {
                    &rig.log.reviews
                } else {
                    &rig.log.start_calls
                };
                assert_eq!(calls.load(Ordering::SeqCst), 1);
                assert_eq!(rig.live_count(), 1);
                assert!(rig.log.closes().is_empty());
                start_with_id(&rig, review, "valid", "next").await.unwrap();
                assert_eq!(calls.load(Ordering::SeqCst), 2);
                rig.idle("one", "the next operation").await;
                rig.close("one").await;
            }
        }
    }
}

#[tokio::test]
async fn not_submitted_busy_remains_retryable_for_turns_and_reviews() {
    for review in [false, true] {
        let rig = review_rig().await;
        rig.open("one").await.unwrap();
        *rig.log.start_failure.lock().unwrap() =
            Some(SdkError::Busy.with_dispatch(Dispatch::NotSubmitted));
        let error = start(&rig, review, "same").await.unwrap_err();
        let details = error.details.unwrap();
        assert_eq!(details["kind"], "external_agent_busy");
        assert_eq!(details["retryable"], true);
        assert_eq!(details["dispatch"], "not-submitted");
        start(&rig, review, "same").await.unwrap();
        let calls = if review {
            &rig.log.reviews
        } else {
            &rig.log.start_calls
        };
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(rig.log.closes().is_empty());
        rig.idle("one", "the retried busy operation").await;
        rig.close("one").await;
    }
}

#[tokio::test]
async fn busy_with_committed_dispatch_keeps_truthful_facts_and_receipts() {
    for review in [false, true] {
        for certainty in [Dispatch::Accepted, Dispatch::AcceptanceUnknown] {
            let rig = review_rig().await;
            rig.open("one").await.unwrap();
            let failure = SdkError::Busy.with_dispatch(certainty);
            let mapped = crate::external_agents::adapter::sdk_remote_error(&failure);
            *rig.log.start_failure.lock().unwrap() = Some(failure);
            let error = start(&rig, review, "same").await.unwrap_err();
            assert_eq!(
                error.details.as_ref().unwrap()["dispatch"],
                mapped.details.as_ref().unwrap()["dispatch"],
                "Busy retry advice must not invent NotSubmitted"
            );
            assert_eq!(
                (&error.code, &error.message, &error.details),
                (&mapped.code, &mapped.message, &mapped.details)
            );
            let replay = start(&rig, review, "same").await.unwrap_err();
            assert_eq!(
                (&replay.code, &replay.message, &replay.details),
                (&error.code, &error.message, &error.details)
            );
            let calls = if review {
                &rig.log.reviews
            } else {
                &rig.log.start_calls
            };
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert_eq!(rig.live_count(), 1);
            assert!(rig.log.closes().is_empty());
            rig.close("one").await;
        }
    }
}

/// Records cleanup that succeeds or whose wait reports a still-unconfirmed child.
#[derive(Default)]
struct RefusalCleanup {
    calls: CountingControl,
    unconfirmed: bool,
}

#[async_trait::async_trait]
impl ProcessControl for RefusalCleanup {
    fn pid(&self) -> Option<u32> {
        None
    }
    fn stderr_tail(&self) -> String {
        String::new()
    }
    async fn wait(&self) -> mango_external_agents::Result<ExitStatus> {
        self.calls.waits.fetch_add(1, Ordering::SeqCst);
        if self.unconfirmed {
            return Err(SdkError::Closed {
                subject: "cleanup child",
            });
        }
        Ok(ExitStatus {
            code: Some(0),
            signal: None,
        })
    }
    async fn interrupt(
        &self,
        _reason: CancelReason,
    ) -> mango_external_agents::Result<InterruptOutcome> {
        Ok(InterruptOutcome::Unsupported)
    }
    async fn kill(&self, _reason: CancelReason) -> mango_external_agents::Result<()> {
        self.calls.kills.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[tokio::test]
async fn cleanup_bearing_input_errors_keep_adapter_cleanup_and_original_kind() {
    for review in [false, true] {
        for unconfirmed in [false, true] {
            let rig = review_rig().await;
            rig.open("one").await.unwrap();
            let control = Arc::new(RefusalCleanup {
                unconfirmed,
                ..Default::default()
            });
            *rig.log.start_failure.lock().unwrap() = Some(SdkError::CleanupRequired {
                source: Box::new(Refusal::Limit.error().with_dispatch(Dispatch::NotSubmitted)),
                control: Arc::clone(&control) as Arc<dyn ProcessControl>,
            });
            let error = start(&rig, review, "invalid").await.unwrap_err();
            let details = error.details.unwrap();
            assert_eq!(details["kind"], "tool_argument");
            assert_eq!(details["dispatch"], "not-submitted");
            assert_eq!(
                details.get("cleanupRequired"),
                unconfirmed.then(|| json!(true)).as_ref()
            );
            assert_eq!(
                details.get("cleanup"),
                unconfirmed.then(|| json!("unconfirmed")).as_ref()
            );
            assert_eq!(control.calls.kills.load(Ordering::SeqCst), 1);
            assert_eq!(control.calls.waits.load(Ordering::SeqCst), 1);
            assert_eq!(rig.live_count(), 1);
            assert!(rig.log.closes().is_empty());
            start(&rig, review, "valid").await.unwrap();
            rig.idle("one", "the next valid operation").await;
            rig.close("one").await;
            assert_eq!(
                control.calls.kills.load(Ordering::SeqCst),
                1,
                "the session must not stop an already-settled adapter cleanup twice"
            );
        }
    }
}
