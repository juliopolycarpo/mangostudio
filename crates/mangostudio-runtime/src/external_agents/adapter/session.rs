//! Pull-based session adaptation. Vendor owners remain here until their product handles drop.
use super::super::interactions::{Answer, MappedEvent};
use super::super::port::{self, AgentResult, AgentSession, CancelReason, CloseCause, TurnEvent};
use super::super::wire;
use super::{failure, map, map_events};
use mango_external_agents as sdk;
use std::time::{Duration, SystemTime};

pub(super) struct SessionAdapter {
    inner: Box<dyn sdk::Session>,
    target: wire::TargetId,
    cleanup_timeout: Duration,
}
impl SessionAdapter {
    pub(super) fn new(
        inner: Box<dyn sdk::Session>,
        target: wire::TargetId,
        cleanup_timeout: Duration,
    ) -> Self {
        Self {
            inner,
            target,
            cleanup_timeout,
        }
    }
    async fn result<T>(&self, result: sdk::Result<T>) -> AgentResult<T> {
        match result {
            Ok(value) => Ok(value),
            Err(error) => Err(failure::settle(error, self.cleanup_timeout).await),
        }
    }
}

pub(super) enum SdkAnswer {
    Permission(sdk::PermissionResponse),
    Question(sdk::QuestionResponse),
}
pub(super) fn sdk_answer(answer: Answer) -> SdkAnswer {
    match answer {
        Answer::Permission {
            request_id,
            option_id,
        } => SdkAnswer::Permission(sdk::PermissionResponse::from_user(
            sdk::InteractionId::new(request_id),
            option_id,
        )),
        Answer::Question {
            request_id,
            question_id,
            choice_id,
        } => SdkAnswer::Question(sdk::QuestionResponse::new(
            sdk::InteractionId::new(request_id),
            vec![sdk::Answer::new(
                sdk::QuestionId::new(question_id),
                sdk::AnswerValue::chosen(sdk::QuestionOptionId::new(choice_id)),
            )],
        )),
        Answer::DeclineQuestions {
            request_id,
            question_ids,
        } => SdkAnswer::Question(sdk::QuestionResponse::new(
            sdk::InteractionId::new(request_id),
            question_ids
                .into_iter()
                .map(|id| sdk::Answer::new(sdk::QuestionId::new(id), sdk::AnswerValue::Declined))
                .collect(),
        )),
    }
}

#[async_trait::async_trait]
impl AgentSession for SessionAdapter {
    fn open_result(&self, requested: &wire::Configuration) -> wire::OpenResult {
        map::open_result(requested, &self.inner.snapshot(), None)
    }
    fn native_session_id(&self) -> String {
        self.inner.ids().native_session_id
    }
    fn capabilities(&self) -> wire::Capabilities {
        map::capabilities(self.inner.capabilities().capabilities())
    }
    fn subscribe(&self) -> Box<dyn port::SessionSubscription> {
        Box::new(Subscription(self.inner.subscribe()))
    }
    async fn start_turn(&self, request: port::TurnRequest<'_>) -> AgentResult<port::TurnStream> {
        let attachments = request
            .attachments
            .into_iter()
            .map(|attachment| sdk::Attachment {
                id: attachment.id,
                name: attachment.name,
                mime_type: attachment.mime_type,
                kind: match attachment.kind {
                    wire::AttachmentKind::Image => sdk::AttachmentKind::Image,
                    wire::AttachmentKind::Text => sdk::AttachmentKind::Text,
                    wire::AttachmentKind::Pdf => sdk::AttachmentKind::Pdf,
                    wire::AttachmentKind::Data => sdk::AttachmentKind::Data,
                    wire::AttachmentKind::Unknown => sdk::AttachmentKind::Unknown,
                },
                bytes: attachment.bytes,
            })
            .collect();
        let request = sdk::TurnRequest::new(request.turn_id, request.input)
            .with_attachments(attachments)
            .with_configuration(map::configuration_patch(request.configuration));
        self.result(self.inner.start_turn(request).await)
            .await
            .map(|stream| stream_adapter(stream, self.target))
    }
    async fn start_review(&self, turn_id: String) -> AgentResult<port::ReviewStream> {
        let request = sdk::ReviewRequest {
            turn_id: sdk::TurnId::new(turn_id),
            target: sdk::ReviewTarget::UncommittedChanges,
        };
        self.result(self.inner.start_review(request).await)
            .await
            .map(|review| port::ReviewStream {
                review_thread_id: review.review_thread_id,
                turn: stream_adapter(review.turn, self.target),
            })
    }
    async fn respond(&self, answer: Answer) -> AgentResult<()> {
        let result = match sdk_answer(answer) {
            SdkAnswer::Permission(response) => self.inner.respond(response).await,
            SdkAnswer::Question(response) => self.inner.answer(response).await,
        };
        self.result(result).await
    }
    async fn steer(&self, steer: port::Steer) -> AgentResult<wire::SteerResult> {
        let steer = sdk::Steer {
            turn_id: sdk::TurnId::new(steer.turn_id),
            native_turn_id: steer.native_turn_id,
            input: steer.input,
        };
        self.result(self.inner.steer(steer).await)
            .await
            .map(|outcome| match outcome {
                sdk::SteerOutcome::Accepted => wire::SteerResult::ACCEPTED,
                sdk::SteerOutcome::Rejected {
                    reason: sdk::SteerRejection::TurnAlreadyCompleted,
                } => wire::SteerResult::rejected(wire::SteerRejection::TurnAlreadyCompleted),
                _ => wire::SteerResult::rejected(wire::SteerRejection::TurnNotSteerable),
            })
    }
    async fn cancel(&self, reason: CancelReason) -> AgentResult<()> {
        let reason = match reason {
            CancelReason::Requested => sdk::CancelReason::Requested,
            CancelReason::Timeout => sdk::CancelReason::Timeout,
        };
        self.result(self.inner.cancel(reason).await).await
    }
    async fn close(&self, reason: CloseCause) -> AgentResult<()> {
        let reason = match reason {
            CloseCause::Requested => sdk::CloseReason::Requested,
            CloseCause::ConsentRevoked => sdk::CloseReason::ConsentRevoked,
            CloseCause::Shutdown => sdk::CloseReason::Shutdown,
        };
        self.result(self.inner.close(reason).await).await
    }
    async fn refresh_account_usage(&self) -> AgentResult<wire::RefreshAccountUsageResult> {
        self.result(self.inner.refresh_account_usage().await)
            .await
            .map(|usage| wire::RefreshAccountUsageResult {
                limits: usage
                    .limits
                    .as_ref()
                    .map(|limits| map::account_limits(self.target, limits, SystemTime::now())),
            })
    }
}

struct Subscription(sdk::SessionSubscription);
#[async_trait::async_trait]
impl port::SessionSubscription for Subscription {
    fn current(&self) -> Vec<wire::Command> {
        map_events::commands(&self.0.current().commands)
    }
    async fn changed(&mut self) -> Option<Vec<wire::Command>> {
        self.0
            .changed()
            .await
            .map(|snapshot| map_events::commands(&snapshot.commands))
    }
}

fn stream_adapter(stream: sdk::TurnStream, target: wire::TargetId) -> port::TurnStream {
    let native = stream.native_turn_id();
    let native_id = match sdk::normalize::opaque_id(native, "native turn id") {
        Ok(bounded) if bounded == native => Ok(bounded),
        Ok(received) => Err(map::remote_error(
            &sdk::Error::InvalidVendorValue {
                field: "native turn id",
                received,
            }
            .with_dispatch(stream.dispatch()),
        )),
        Err(error) => Err(map::remote_error(&error.with_dispatch(stream.dispatch()))),
    };
    port::TurnStream {
        dispatch: failure::dispatch(stream.dispatch()),
        native_id: Some(native_id),
        events: Box::new(Events { stream, target }),
    }
}
struct Events {
    stream: sdk::TurnStream,
    target: wire::TargetId,
}
#[async_trait::async_trait]
impl port::EventStream for Events {
    fn native_turn_id(&self) -> &str {
        self.stream.native_turn_id()
    }
    async fn recv(&mut self) -> Option<TurnEvent> {
        let event = self.stream.recv().await?;
        let mapped = map_events::map_event(self.target, &event);
        Some(TurnEvent {
            at_ms: map::epoch_ms(event.at),
            idle_timeout: matches!(
                event.kind,
                sdk::EventKind::Cancelled {
                    reason: sdk::CancelReason::Timeout
                }
            ),
            mapped: MappedEvent {
                wire: mapped.wire,
                opened: mapped.opened,
                closed: mapped.closed,
                unrenderable: mapped.unrenderable,
            },
        })
    }
}
