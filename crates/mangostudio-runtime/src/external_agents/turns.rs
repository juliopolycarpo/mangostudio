//! Turns on a live session: `turn`, `start-review`, `respond`, `steer` and
//! `cancel`, and the relay that carries each turn's events to the hub.
//!
//! The runtime owns the SDK's `TurnStream` and drains it whether or not a hub
//! is listening: a turn edits a workspace, and a viewer leaving is not a reason
//! to abandon it. What decides that a session is busy is the relay, not the
//! caller reading the stream: a turn whose events are all read releases the
//! session, while a turn whose cancellation has not settled keeps it, exactly
//! as long as the SDK keeps it.
//!
//! # Interactions
//!
//! An approval is answered as a `PermissionResponse`. A question the product
//! can show — one single-choice question — travels as an approval card, the
//! way the TypeScript runtime carried it, but is answered as a
//! `QuestionResponse`: a question never grants authority, so answering it
//! never goes through the permission path. Any other question form is
//! declined back to the vendor by name, and nothing reaches the hub.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use mango_external_agents::{
    Attachment as SdkAttachment, AttachmentKind as SdkAttachmentKind, CancelReason, Capability,
    Error as SdkError, ReviewRequest, ReviewTarget as SdkReviewTarget, Steer, SteerOutcome,
    SteerRejection as SdkSteerRejection, TurnRequest, TurnStream,
};
use mango_protocol::error::{RemoteError, codes};
use mango_protocol::session::{EventInput, Session as HubSession};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::watch;

use super::map;
use super::map_events::{self, Answer, PendingInteraction};
use super::supervisor::{LiveSession, Supervisor, argument};
use super::wire::{
    AckResult, AgentError, Attachment, AttachmentKind, CancelParams, Event, EventEnvelope,
    RespondParams, StartReviewParams, StartReviewResult, SteerParams, SteerRejection, SteerResult,
    TurnParams, TurnResult,
};

/// The topic every turn event travels on.
pub(crate) const EVENT_TOPIC: &str = "external-agent.event";
/// `EXTERNAL_TURN_PAYLOAD_MAX_BYTES`: what the hub will persist for one turn.
const TURN_PAYLOAD_MAX_BYTES: usize = 2 * 1024 * 1024;
/// Held back from the budget so the error that reports its overflow still fits.
const TURN_ERROR_RESERVE_BYTES: usize = 4_096;

/// What one accepted `clientMessageId` answered, so a retry is answered
/// rather than run twice. A turn and a review share the id space.
struct Receipt {
    kind: ReceiptKind,
    fingerprint: [u8; 32],
    outcome: watch::Receiver<Option<Result<Value, RemoteError>>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReceiptKind {
    Turn,
    Review,
}

/// The turn a session is running, or reserving while it starts.
struct ActiveTurn {
    /// The hub's id for it, which is also the SDK turn id.
    client_message_id: String,
    /// Set once the SDK accepted the turn.
    native_turn_id: Option<String>,
}

/// Everything a live session keeps about its turns.
pub(crate) struct TurnState {
    hub: HubSession,
    sequence: AtomicU64,
    /// Set once the hub session refused an event; final for this session.
    unobserved: AtomicBool,
    active: Mutex<Option<ActiveTurn>>,
    receipts: Mutex<HashMap<String, Receipt>>,
    interactions: Mutex<HashMap<String, PendingInteraction>>,
    steers: Mutex<HashSet<String>>,
}

impl TurnState {
    /// No turn yet; events go to `hub`.
    pub(crate) fn new(hub: HubSession) -> Self {
        Self {
            hub,
            sequence: AtomicU64::new(0),
            unobserved: AtomicBool::new(false),
            active: Mutex::new(None),
            receipts: Mutex::new(HashMap::new()),
            interactions: Mutex::new(HashMap::new()),
            steers: Mutex::new(HashSet::new()),
        }
    }

    /// Whether a turn is running or starting.
    pub(crate) fn is_busy(&self) -> bool {
        lock(&self.active).is_some()
    }

    fn active_native_turn(&self) -> Option<(String, String)> {
        lock(&self.active).as_ref().and_then(|active| {
            active
                .native_turn_id
                .clone()
                .map(|native| (active.client_message_id.clone(), native))
        })
    }

    /// Publishes one event, until the hub stops taking them. Answers whether
    /// it reached a hub. A refusal silences this session and nothing else.
    fn emit(
        &self,
        session_id: &str,
        native_turn_id: Option<&str>,
        emitted_at_ms: u64,
        event: Event,
    ) -> Emitted {
        if self.unobserved.load(Ordering::Acquire) {
            return Emitted::Unobserved;
        }
        let envelope = EventEnvelope {
            session_id: session_id.to_owned(),
            native_turn_id: native_turn_id.map(str::to_owned),
            sequence: self.sequence.fetch_add(1, Ordering::AcqRel) + 1,
            emitted_at_ms,
            event,
        };
        let Ok(payload) = serde_json::to_value(&envelope) else {
            return Emitted::Invalid;
        };
        let bytes = serde_json::to_vec(&payload).map_or(usize::MAX, |bytes| bytes.len());
        let input = EventInput {
            topic: EVENT_TOPIC.to_owned(),
            payload,
            stream_id: Some(session_id.to_owned()),
            end: false,
        };
        match crate::event_check::checked_emit(&self.hub, input) {
            Ok(true) => Emitted::Delivered(bytes),
            Ok(false) => {
                self.unobserved.store(true, Ordering::Release);
                Emitted::Unobserved
            }
            Err(_) => Emitted::Invalid,
        }
    }
}

enum Emitted {
    Delivered(usize),
    Unobserved,
    Invalid,
}

impl Supervisor {
    /// `external-agent.turn`.
    ///
    /// A repeated `clientMessageId` with the same input answers what the first
    /// answered; with different input it is refused. One turn at a time.
    pub(crate) async fn turn(
        self: &Arc<Self>,
        params: TurnParams,
    ) -> Result<TurnResult, RemoteError> {
        let live = self.require_live(&params.session_id)?;
        for root in &params.configuration.workspace_roots {
            if !live.authorized_roots.contains(root) {
                return Err(argument(format!(
                    "External-agent workspace root {root:?} was not authorized when session {:?} opened; expected one of its opened roots.",
                    params.session_id
                )));
            }
        }
        let fingerprint = fingerprint(&params);
        let publish = match admit(
            &live,
            &params.client_message_id,
            ReceiptKind::Turn,
            fingerprint,
        )? {
            Admitted::Replay(outcome) => return decode_outcome(outcome).await,
            Admitted::Fresh(publish) => publish,
        };
        let request = TurnRequest::new(params.client_message_id.clone(), params.input.clone())
            .with_attachments(sdk_attachments(
                params.attachments.as_deref().unwrap_or_default(),
            )?)
            .with_configuration(map::configuration_patch(&params.configuration));
        let started = live.session.start_turn(request).await;
        let result = match started {
            Ok(stream) => {
                let native = stream.native_turn_id().to_owned();
                self.relay(&live, &params.client_message_id, stream);
                Ok(TurnResult {
                    native_turn_id: native,
                })
            }
            Err(error) => Err(self
                .refused_start(&live, &params.client_message_id, error)
                .await),
        };
        publish.send_replace(Some(result.clone().map(|value| to_value(&value))));
        result
    }

    /// `external-agent.start-review`: a native review on the same session,
    /// under the same one-turn rule and idempotency key as a turn.
    pub(crate) async fn start_review(
        self: &Arc<Self>,
        params: StartReviewParams,
    ) -> Result<StartReviewResult, RemoteError> {
        let live = self.require_live(&params.session_id)?;
        if live
            .session
            .require_capability(Capability::NativeReview)
            .is_err()
        {
            return Err(argument(format!(
                "External-agent target {:?} cannot start a native review; expected a target with native review.",
                live.target.as_str()
            )));
        }
        let fingerprint = fingerprint(&params);
        let publish = match admit(
            &live,
            &params.client_message_id,
            ReceiptKind::Review,
            fingerprint,
        )? {
            Admitted::Replay(outcome) => return decode_outcome(outcome).await,
            Admitted::Fresh(publish) => publish,
        };
        let request = ReviewRequest {
            turn_id: mango_external_agents::TurnId::new(params.client_message_id.clone()),
            target: SdkReviewTarget::UncommittedChanges,
        };
        let result = match live.session.start_review(request).await {
            Ok(review) => {
                let native = review.turn.native_turn_id().to_owned();
                self.relay(&live, &params.client_message_id, review.turn);
                Ok(StartReviewResult {
                    native_turn_id: native,
                    review_thread_id: review.review_thread_id,
                })
            }
            Err(error) => Err(self
                .refused_start(&live, &params.client_message_id, error)
                .await),
        };
        publish.send_replace(Some(result.clone().map(|value| to_value(&value))));
        result
    }

    /// Releases a reservation whose turn never started, and forgets its
    /// receipt when the SDK proves nothing reached the vendor, so the same id
    /// may be tried again.
    async fn refused_start(
        &self,
        live: &LiveSession,
        client_message_id: &str,
        error: SdkError,
    ) -> RemoteError {
        {
            let mut active = lock(&live.turns.active);
            if active
                .as_ref()
                .is_some_and(|turn| turn.client_message_id == client_message_id)
            {
                *active = None;
            }
        }
        if error.dispatch().is_safe_to_replay() {
            lock(&live.turns.receipts).remove(client_message_id);
        }
        if matches!(error, SdkError::Busy)
            || matches!(&error, SdkError::Operation { source, .. } if matches!(**source, SdkError::Busy))
        {
            return argument(format!(
                "External-agent session {:?} already has an active turn; expected an idle session.",
                live.session_id
            ));
        }
        self.sdk_failure(error).await
    }

    /// Drains one turn's stream to the hub, owned by the supervisor's tasks.
    fn relay(
        self: &Arc<Self>,
        live: &Arc<LiveSession>,
        client_message_id: &str,
        mut stream: TurnStream,
    ) {
        let native = stream.native_turn_id().to_owned();
        {
            let mut active = lock(&live.turns.active);
            if let Some(turn) = active
                .as_mut()
                .filter(|turn| turn.client_message_id == client_message_id)
            {
                turn.native_turn_id = Some(native.clone());
            }
        }
        let this = Arc::clone(self);
        let live = Arc::clone(live);
        let client_message_id = client_message_id.to_owned();
        self.tasks.spawn(async move {
            let mut spent = 0_usize;
            let mut failed = false;
            while let Some(event) = stream.recv().await {
                let mapped = map_events::map_event(live.target, &event);
                if let Some(pending) = mapped.opened {
                    lock(&live.turns.interactions).insert(pending.request_id().to_owned(), pending);
                }
                // A round that was declined without a card resolves in the
                // SDK too; the hub never saw it opened, so it hears nothing.
                let never_shown = mapped.closed.as_ref().is_some_and(|request_id| {
                    lock(&live.turns.interactions).remove(request_id).is_none()
                });
                let at = map::epoch_ms(event.at).unwrap_or_else(|| epoch_ms(SystemTime::now()));
                let mut refused_form = None;
                if let Some((response, reason)) = mapped.unrenderable {
                    // A form the product cannot show is declined by name, so
                    // the vendor is not left waiting on nobody. A required
                    // question cannot be declined; that turn fails explicitly
                    // rather than hanging until the question expires.
                    if live.session.answer(response).await.is_err() {
                        refused_form = Some(reason);
                    }
                }
                let wire = match (refused_form, mapped.wire) {
                    (Some(_), _) if failed => continue,
                    (Some(reason), _) => Event::Error {
                        error: AgentError {
                            code: "unsupported-question".to_owned(),
                            message: format!(
                                "The agent asked a question MangoStudio cannot show ({reason}), and it could not be declined."
                            ),
                            request_id: None,
                            retryable: Some(false),
                            vendor_code: None,
                            truncated: None,
                        },
                    },
                    (None, Some(Event::ApprovalResolved { .. })) if never_shown => continue,
                    (None, Some(wire)) => wire,
                    (None, None) => continue,
                };
                if failed {
                    continue;
                }
                let is_refusal = refused_form.is_some();
                let emitted = live.turns.emit(&live.session_id, Some(&native), at, wire);
                if is_refusal {
                    failed = true;
                    let stopping = Arc::clone(&live);
                    this.tasks.spawn(async move {
                        let _ = stopping.session.cancel(CancelReason::Requested).await;
                    });
                    continue;
                }
                let failure = match emitted {
                    Emitted::Delivered(bytes) => {
                        spent = spent.saturating_add(bytes);
                        (spent > TURN_PAYLOAD_MAX_BYTES - TURN_ERROR_RESERVE_BYTES)
                            .then_some("External-agent turn exceeded its persisted payload limit.")
                    }
                    Emitted::Unobserved => None,
                    Emitted::Invalid => Some("External-agent adapter produced an invalid event envelope."),
                };
                if let Some(message) = failure {
                    failed = true;
                    // The error is the whole record that the turn ended badly;
                    // the vendor is then stopped, and its stream still drained.
                    let _ = live.turns.emit(
                        &live.session_id,
                        Some(&native),
                        epoch_ms(SystemTime::now()),
                        Event::Error {
                            error: AgentError {
                                code: "adapter-stream".to_owned(),
                                message: message.to_owned(),
                                request_id: None,
                                retryable: None,
                                vendor_code: None,
                                truncated: None,
                            },
                        },
                    );
                    let stopping = Arc::clone(&live);
                    this.tasks.spawn(async move {
                        let _ = stopping.session.cancel(CancelReason::Timeout).await;
                    });
                }
            }
            lock(&live.turns.interactions).clear();
            let mut active = lock(&live.turns.active);
            if active
                .as_ref()
                .is_some_and(|turn| turn.client_message_id == client_message_id)
            {
                *active = None;
            }
        });
    }

    /// `external-agent.respond`: answers one pending interaction of the
    /// running turn with one of the options it offered.
    pub(crate) async fn respond(&self, params: RespondParams) -> Result<AckResult, RemoteError> {
        let live = self.require_live(&params.session_id)?;
        match live.turns.active_native_turn() {
            Some((_, native)) if native == params.native_turn_id => {}
            _ => {
                return Err(argument(format!(
                    "External-agent turn {:?} is not running on session {:?}; expected the session's running turn.",
                    params.native_turn_id, params.session_id
                )));
            }
        }
        let pending = lock(&live.turns.interactions)
            .get(&params.request_id)
            .cloned();
        let Some(pending) = pending else {
            return Err(argument(format!(
                "External-agent request {:?} is not pending; expected an open approval of the running turn.",
                params.request_id
            )));
        };
        let outcome = match map_events::answer(&pending, &params.option_id)? {
            Answer::Permission(response) => live.session.respond(response).await,
            Answer::Question(response) => live.session.answer(response).await,
        };
        match outcome {
            Ok(()) => Ok(AckResult::OK),
            Err(error) => Err(self.sdk_failure(error).await),
        }
    }

    /// `external-agent.steer`: adds input to the running turn. A target or a
    /// turn that cannot take it is answered, not thrown: a stale capability
    /// cache can reach this mid-turn.
    pub(crate) async fn steer(&self, params: SteerParams) -> Result<SteerResult, RemoteError> {
        let live = self.require_live(&params.session_id)?;
        if live
            .session
            .require_capability(Capability::Steering)
            .is_err()
        {
            return Ok(SteerResult::rejected(SteerRejection::NotSupported));
        }
        let Some((turn_id, native)) = live.turns.active_native_turn() else {
            return Ok(SteerResult::rejected(SteerRejection::TurnAlreadyCompleted));
        };
        if native != params.native_turn_id {
            return Ok(SteerResult::rejected(SteerRejection::TurnAlreadyCompleted));
        }
        if !lock(&live.turns.steers).insert(params.client_message_id.clone()) {
            return Ok(SteerResult::rejected(SteerRejection::IdReused));
        }
        let steer = Steer {
            turn_id: mango_external_agents::TurnId::new(turn_id),
            native_turn_id: native,
            input: params.input,
        };
        match live.session.steer(steer).await {
            Ok(SteerOutcome::Accepted) => Ok(SteerResult::ACCEPTED),
            Ok(SteerOutcome::Rejected { reason }) => Ok(SteerResult::rejected(match reason {
                SdkSteerRejection::TurnAlreadyCompleted => SteerRejection::TurnAlreadyCompleted,
                SdkSteerRejection::TurnNotSteerable => SteerRejection::TurnNotSteerable,
                // A refusal this build does not know yet is still a refusal.
                _ => SteerRejection::TurnNotSteerable,
            })),
            Ok(_) => Ok(SteerResult::rejected(SteerRejection::TurnNotSteerable)),
            Err(SdkError::NotSupported { .. }) => {
                Ok(SteerResult::rejected(SteerRejection::NotSupported))
            }
            Err(error) => Err(self.sdk_failure(error).await),
        }
    }

    /// `external-agent.cancel`: asks the vendor to stop the running turn. The
    /// SDK bounds the settle itself (`Limits::cancel_settle_timeout`); the
    /// session stays busy until the turn's real terminal arrives.
    pub(crate) async fn cancel(&self, params: CancelParams) -> Result<AckResult, RemoteError> {
        let live = self.require_live(&params.session_id)?;
        // A cancel naming a turn that is no longer running is already
        // satisfied; it must never stop the newer turn that replaced it.
        if let Some(named) = &params.native_turn_id
            && live
                .turns
                .active_native_turn()
                .is_none_or(|(_, running)| &running != named)
        {
            return Ok(AckResult::OK);
        }
        match live.session.cancel(CancelReason::Requested).await {
            Ok(()) => Ok(AckResult::OK),
            Err(error) => Err(self.sdk_failure(error).await),
        }
    }
}

impl Supervisor {
    /// Relays the session's slash-command catalog to the hub whenever it
    /// changes. A session fact, not a turn event: it carries no turn id.
    pub(crate) fn relay_session_facts(self: &Arc<Self>, live: &Arc<LiveSession>) {
        let live = Arc::clone(live);
        self.tasks.spawn(async move {
            let mut subscription = live.session.subscribe();
            let mut shown = Vec::new();
            let mut snapshot = Some(subscription.current());
            while let Some(current) = snapshot {
                let commands = map_events::commands(&current.commands);
                if commands != shown {
                    shown.clone_from(&commands);
                    let _ = live.turns.emit(
                        &live.session_id,
                        None,
                        epoch_ms(SystemTime::now()),
                        Event::CommandsAvailable { commands },
                    );
                }
                snapshot = subscription.changed().await;
            }
        });
    }
}

enum Admitted {
    Replay(watch::Receiver<Option<Result<Value, RemoteError>>>),
    Fresh(watch::Sender<Option<Result<Value, RemoteError>>>),
}

/// Answers a repeated id from its receipt, or reserves the session's one turn
/// slot and records a new receipt, all before any await.
fn admit(
    live: &LiveSession,
    client_message_id: &str,
    kind: ReceiptKind,
    fingerprint: [u8; 32],
) -> Result<Admitted, RemoteError> {
    let mut receipts = lock(&live.turns.receipts);
    if let Some(receipt) = receipts.get(client_message_id) {
        if receipt.kind != kind || receipt.fingerprint != fingerprint {
            return Err(argument(format!(
                "clientMessageId {client_message_id:?} was reused with different turn input; expected the input it was first sent with."
            )));
        }
        return Ok(Admitted::Replay(receipt.outcome.clone()));
    }
    let mut active = lock(&live.turns.active);
    if active.is_some() {
        return Err(argument(format!(
            "External-agent session {:?} already has an active turn; expected an idle session.",
            live.session_id
        )));
    }
    *active = Some(ActiveTurn {
        client_message_id: client_message_id.to_owned(),
        native_turn_id: None,
    });
    let (publish, outcome) = watch::channel(None);
    receipts.insert(
        client_message_id.to_owned(),
        Receipt {
            kind,
            fingerprint,
            outcome,
        },
    );
    Ok(Admitted::Fresh(publish))
}

async fn decode_outcome<T: serde::de::DeserializeOwned>(
    mut outcome: watch::Receiver<Option<Result<Value, RemoteError>>>,
) -> Result<T, RemoteError> {
    let recorded = outcome
        .wait_for(Option::is_some)
        .await
        .map_err(|_| {
            RemoteError::new(
                codes::INTERNAL,
                "The external-agent turn ended without an outcome.",
            )
        })?
        .clone()
        .expect("wait_for returned a recorded outcome");
    let value = recorded?;
    serde_json::from_value(value).map_err(|error| {
        RemoteError::new(
            codes::INTERNAL,
            format!("A recorded external-agent result could not be read: {error}"),
        )
    })
}

fn to_value(value: &impl serde::Serialize) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// Identifies one request's input without holding its attachment bytes.
fn fingerprint(params: &impl serde::Serialize) -> [u8; 32] {
    let bytes = serde_json::to_vec(params).unwrap_or_default();
    Sha256::digest(&bytes).into()
}

fn sdk_attachments(attachments: &[Attachment]) -> Result<Vec<SdkAttachment>, RemoteError> {
    attachments
        .iter()
        .map(|attachment| {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&attachment.bytes_base64)
                .map_err(|_| {
                    argument(format!(
                        "Attachment {:?} is not valid base64; expected the bytes the hub encoded.",
                        attachment.id
                    ))
                })?;
            Ok(SdkAttachment {
                id: attachment.id.clone(),
                name: attachment.original_name.clone(),
                mime_type: attachment.mime_type.clone(),
                kind: match attachment.kind {
                    AttachmentKind::Image => SdkAttachmentKind::Image,
                    AttachmentKind::Text => SdkAttachmentKind::Text,
                    AttachmentKind::Pdf => SdkAttachmentKind::Pdf,
                    AttachmentKind::Data => SdkAttachmentKind::Data,
                    AttachmentKind::Unknown => SdkAttachmentKind::Unknown,
                },
                bytes,
            })
        })
        .collect()
}

fn epoch_ms(at: SystemTime) -> u64 {
    at.duration_since(UNIX_EPOCH).map_or(0, |elapsed| {
        u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
    })
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}
