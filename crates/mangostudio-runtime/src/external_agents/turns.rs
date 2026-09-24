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

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
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
/// One steer's input digest and outcome, for answering its repeats.
struct SteerReceipt {
    input: [u8; 32],
    outcome: watch::Receiver<Option<Result<SteerResult, RemoteError>>>,
}

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
    sequence: Mutex<u64>,
    /// Set once the hub session refused an event; final for this session.
    unobserved: AtomicBool,
    active: Mutex<Option<ActiveTurn>>,
    receipts: Mutex<HashMap<String, Receipt>>,
    interactions: Mutex<HashMap<String, PendingInteraction>>,
    /// Each steer of the running turn by its id: a repeat with the same input
    /// answers what the first answered; other input under the id is refused.
    steers: Mutex<HashMap<String, SteerReceipt>>,
}

impl TurnState {
    /// No turn yet; events go to `hub`.
    pub(crate) fn new(hub: HubSession) -> Self {
        Self {
            hub,
            sequence: Mutex::new(0),
            unobserved: AtomicBool::new(false),
            active: Mutex::new(None),
            receipts: Mutex::new(HashMap::new()),
            interactions: Mutex::new(HashMap::new()),
            steers: Mutex::new(HashMap::new()),
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

    /// Publishes one event, until the hub stops taking them, when its
    /// envelope fits in `remaining` bytes. Answers whether it reached a hub.
    ///
    /// The sequence number is taken and the frame sent under one lock, and a
    /// number is spent only on a frame that was sent: the hub's sequencer
    /// reads a reordered or skipped number as a gap and ends the turn.
    fn emit(
        &self,
        session_id: &str,
        native_turn_id: Option<&str>,
        emitted_at_ms: u64,
        event: Event,
        remaining: usize,
    ) -> Emitted {
        if self.unobserved.load(Ordering::Acquire) {
            return Emitted::Unobserved;
        }
        let mut sequence = lock(&self.sequence);
        let envelope = EventEnvelope {
            session_id: session_id.to_owned(),
            native_turn_id: native_turn_id.map(str::to_owned),
            sequence: *sequence + 1,
            emitted_at_ms,
            event,
        };
        let Ok(payload) = serde_json::to_value(&envelope) else {
            return Emitted::Invalid;
        };
        let bytes = serde_json::to_vec(&payload).map_or(usize::MAX, |bytes| bytes.len());
        if bytes > remaining {
            return Emitted::OverBudget;
        }
        let input = EventInput {
            topic: EVENT_TOPIC.to_owned(),
            payload,
            stream_id: Some(session_id.to_owned()),
            end: false,
        };
        match crate::event_check::checked_emit(&self.hub, input) {
            Ok(true) => {
                *sequence += 1;
                Emitted::Delivered(bytes)
            }
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
    OverBudget,
}

impl Supervisor {
    /// `external-agent.turn`.
    ///
    /// A repeated `clientMessageId` with the same input answers what the first
    /// answered; with different input it is refused. One turn at a time.
    pub(crate) async fn turn(
        self: &Arc<Self>,
        params: TurnParams,
        _cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<TurnResult, RemoteError> {
        let live = self.require_live(&params.session_id)?;
        super::supervisor::refuse_unoffered_configuration(live.target, &params.configuration)?;
        // Decoded before the session's one turn slot is taken, so a malformed
        // attachment refuses this call and leaves the session idle.
        let attachments = sdk_attachments(params.attachments.as_deref().unwrap_or_default())?;
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
            .with_attachments(attachments)
            .with_configuration(map::configuration_patch(&params.configuration));
        // Not raced against the hub's request cancel: the hub reconciles a
        // lost reply by sending this same id again, and the receipt has to
        // hold what really happened, not that the first caller stopped waiting.
        let result = match live.session.start_turn(request).await {
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
        _cancel: &tokio_util::sync::CancellationToken,
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
        // Not raced against the caller's cancel either, for the same reason
        // as a turn: a resend under the same id is answered from the receipt.
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
    ///
    /// The session's slash-command catalog travels here too, under this
    /// turn's id: the hub listens to a session only while a turn runs, and
    /// drops an event that names no turn once one has begun.
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
            let mut relay = Relay {
                live: Arc::clone(&live),
                tasks: this.tasks.clone(),
                native: native.clone(),
                spent: 0,
                failed: false,
                shown_commands: None,
            };
            let mut subscription = live.session.subscribe();
            relay.commands(&subscription.current().commands);
            let mut facts_open = true;
            loop {
                tokio::select! {
                    biased;
                    event = stream.recv() => {
                        let Some(event) = event else { break };
                        relay.event(&event).await;
                    }
                    changed = subscription.changed(), if facts_open => match changed {
                        Some(snapshot) => relay.commands(&snapshot.commands),
                        None => facts_open = false,
                    },
                }
            }
            lock(&live.turns.interactions).clear();
            lock(&live.turns.steers).clear();
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
        let input = fingerprint(&params.input);
        let seen = {
            let mut steers = lock(&live.turns.steers);
            match steers.get(&params.client_message_id) {
                Some(receipt) if receipt.input != input => {
                    return Ok(SteerResult::rejected(SteerRejection::IdReused));
                }
                Some(receipt) => Err(receipt.outcome.clone()),
                None => {
                    let (publish, outcome) = watch::channel(None);
                    steers.insert(
                        params.client_message_id.clone(),
                        SteerReceipt { input, outcome },
                    );
                    Ok(publish)
                }
            }
        };
        let publish = match seen {
            Ok(publish) => publish,
            Err(outcome) => return await_steer(&live, &params.client_message_id, outcome).await,
        };
        let steer = Steer {
            turn_id: mango_external_agents::TurnId::new(turn_id),
            native_turn_id: native,
            input: params.input,
        };
        let result = match live.session.steer(steer).await {
            Ok(SteerOutcome::Accepted) => SteerResult::ACCEPTED,
            Ok(SteerOutcome::Rejected { reason }) => SteerResult::rejected(match reason {
                SdkSteerRejection::TurnAlreadyCompleted => SteerRejection::TurnAlreadyCompleted,
                SdkSteerRejection::TurnNotSteerable => SteerRejection::TurnNotSteerable,
                // A refusal this build does not know yet is still a refusal.
                _ => SteerRejection::TurnNotSteerable,
            }),
            Ok(_) => SteerResult::rejected(SteerRejection::TurnNotSteerable),
            Err(SdkError::NotSupported { .. }) => {
                SteerResult::rejected(SteerRejection::NotSupported)
            }
            Err(error) => {
                // A duplicate that arrives before the failure is known, even
                // while a child is being reaped, gets the same failure; after
                // it, the id may be sent again.
                let failure = self.sdk_failure(error).await;
                publish.send_replace(Some(Err(failure.clone())));
                lock(&live.turns.steers).remove(&params.client_message_id);
                return Err(failure);
            }
        };
        publish.send_replace(Some(Ok(result)));
        Ok(result)
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

/// One turn's relay state: what it has spent of the persisted budget,
/// whether it already ended the turn with its own error, and the command
/// catalog it last showed.
struct Relay {
    live: Arc<LiveSession>,
    tasks: tokio_util::task::TaskTracker,
    native: String,
    spent: usize,
    failed: bool,
    shown_commands: Option<Vec<super::wire::Command>>,
}

impl Relay {
    fn remaining(&self) -> usize {
        (TURN_PAYLOAD_MAX_BYTES - TURN_ERROR_RESERVE_BYTES).saturating_sub(self.spent)
    }

    /// Shows the catalog when it differs from what this turn last showed.
    fn commands(&mut self, commands: &[mango_external_agents::Command]) {
        let commands = map_events::commands(commands);
        if self.failed || self.shown_commands.as_ref() == Some(&commands) {
            return;
        }
        let at = epoch_ms(SystemTime::now());
        self.shown_commands = Some(commands.clone());
        self.publish(at, Event::CommandsAvailable { commands });
    }

    async fn event(&mut self, event: &mango_external_agents::AgentEvent) {
        let live = Arc::clone(&self.live);
        let mapped = map_events::map_event(live.target, event);
        if let Some(pending) = mapped.opened {
            lock(&live.turns.interactions).insert(pending.request_id().to_owned(), pending);
        }
        // A round that was declined without a card resolves in the SDK too;
        // the hub never saw it opened, so it hears nothing.
        let never_shown = mapped
            .closed
            .as_ref()
            .is_some_and(|request_id| lock(&live.turns.interactions).remove(request_id).is_none());
        let at = map::epoch_ms(event.at).unwrap_or_else(|| epoch_ms(SystemTime::now()));
        if let Some((response, reason)) = mapped.unrenderable {
            // A form the product cannot show is declined by name, so the
            // vendor is not left waiting on nobody. A required question cannot
            // be declined; that turn fails explicitly rather than hanging
            // until the question expires.
            if live.session.answer(response).await.is_err() && !self.failed {
                self.fail(
                    at,
                    "unsupported-question",
                    &format!(
                        "The agent asked a question MangoStudio cannot show ({reason}), and it could not be declined."
                    ),
                    CancelReason::Requested,
                );
                return;
            }
        }
        let wire = match mapped.wire {
            Some(Event::ApprovalResolved { .. }) if never_shown => return,
            Some(wire) => wire,
            None => return,
        };
        if self.failed {
            return;
        }
        self.publish(at, wire);
    }

    /// Sends one event within the budget; past it, or for an envelope the
    /// schema refuses, ends the turn with this relay's own error instead.
    fn publish(&mut self, at: u64, wire: Event) {
        match self.live.turns.emit(
            &self.live.session_id,
            Some(&self.native),
            at,
            wire,
            self.remaining(),
        ) {
            Emitted::Delivered(bytes) => self.spent = self.spent.saturating_add(bytes),
            Emitted::Unobserved => {}
            Emitted::OverBudget => {
                self.overflow("External-agent turn exceeded its persisted payload limit.")
            }
            Emitted::Invalid => {
                self.overflow("External-agent adapter produced an invalid event envelope.")
            }
        }
    }

    fn overflow(&mut self, message: &str) {
        self.failed = true;
        self.error(epoch_ms(SystemTime::now()), "adapter-stream", message);
        let stopping = Arc::clone(&self.live);
        self.tasks.spawn(async move {
            let _ = stopping.session.cancel(CancelReason::Timeout).await;
        });
    }

    fn fail(&mut self, at: u64, code: &str, message: &str, reason: CancelReason) {
        self.failed = true;
        self.error(at, code, message);
        let stopping = Arc::clone(&self.live);
        self.tasks.spawn(async move {
            let _ = stopping.session.cancel(reason).await;
        });
    }

    /// The error that is the whole record of how this turn ended. The budget
    /// reserve exists so it always fits.
    fn error(&self, at: u64, code: &str, message: &str) {
        let _ = self.live.turns.emit(
            &self.live.session_id,
            Some(&self.native),
            at,
            Event::Error {
                error: AgentError {
                    code: code.to_owned(),
                    message: message.to_owned(),
                    request_id: None,
                    retryable: Some(false),
                    vendor_code: None,
                    truncated: None,
                },
            },
            usize::MAX,
        );
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

/// Answers a duplicate steer with its first attempt's outcome. A first attempt
/// that ended without recording one (its request was dropped) is forgotten, so
/// the same id can be sent again, and this duplicate is told to retry.
async fn await_steer(
    live: &LiveSession,
    client_message_id: &str,
    mut outcome: watch::Receiver<Option<Result<SteerResult, RemoteError>>>,
) -> Result<SteerResult, RemoteError> {
    if let Ok(recorded) = outcome.wait_for(Option::is_some).await {
        return recorded
            .clone()
            .expect("wait_for returned a recorded steer");
    }
    let mut steers = lock(&live.turns.steers);
    if steers
        .get(client_message_id)
        .is_some_and(|receipt| receipt.outcome.same_channel(&outcome))
    {
        steers.remove(client_message_id);
    }
    Err(RemoteError::new(
        codes::UNAVAILABLE,
        format!(
            "The first steer under clientMessageId \"{client_message_id}\" ended without an outcome; send it again."
        ),
    ))
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use mango_protocol::frame::PeerInfo;
    use mango_protocol::port::port_pair;
    use mango_protocol::session::{Session as HubSession, SessionOptions};

    use super::{Emitted, TurnState};
    use crate::external_agents::wire::{ActivityKind, ApprovalRequest, Event};

    async fn pair() -> (HubSession, HubSession) {
        let (port, peer) = port_pair();
        let info = |role: &str| PeerInfo {
            name: "turn-state-test".into(),
            version: "0.1.0".into(),
            role: role.into(),
        };
        let (runtime, _) = HubSession::spawn(port, SessionOptions::new(info("runtime")));
        let (hub, _) = HubSession::spawn(peer, SessionOptions::new(info("hub")));
        let (a, b) = tokio::join!(runtime.ready(), hub.ready());
        a.expect("runtime handshake");
        b.expect("hub handshake");
        (runtime, hub)
    }

    fn text(n: usize) -> Event {
        Event::TextDelta {
            text: format!("chunk {n}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_emitters_never_reorder_or_skip_a_sequence() {
        let (runtime, hub) = pair().await;
        let mut events = hub.events();
        let state = Arc::new(TurnState::new(runtime));
        let mut senders = Vec::new();
        for sender in 0..4 {
            let state = Arc::clone(&state);
            senders.push(tokio::spawn(async move {
                for n in 0..50 {
                    let emitted = state.emit("s", Some("t"), 0, text(sender * 100 + n), usize::MAX);
                    assert!(
                        matches!(emitted, Emitted::Delivered(_)),
                        "expected every frame delivered"
                    );
                    tokio::task::yield_now().await;
                }
            }));
        }
        for sender in senders {
            sender.await.unwrap();
        }
        let mut received = Vec::new();
        while received.len() < 200 {
            let event = events.recv().await.expect("expected 200 frames");
            received.push(event.payload["sequence"].as_u64().unwrap());
        }
        assert_eq!(
            received,
            (1..=200).collect::<Vec<_>>(),
            "expected sequences in arrival order, gap-free"
        );
    }

    #[tokio::test]
    async fn a_refused_frame_spends_no_sequence() {
        let (runtime, hub) = pair().await;
        let mut events = hub.events();
        let state = TurnState::new(runtime);
        // No options: the schema requires at least one, so the frame is refused.
        let invalid = Event::ApprovalRequested {
            request: ApprovalRequest {
                request_id: "r".into(),
                kind: ActivityKind::Other,
                title: "t".into(),
                detail: None,
                options: Vec::new(),
                expires_at_ms: 0,
                truncated: None,
            },
        };
        assert!(matches!(
            state.emit("s", Some("t"), 0, invalid, usize::MAX),
            Emitted::Invalid
        ));
        assert!(matches!(
            state.emit("s", Some("t"), 0, text(1), 8),
            Emitted::OverBudget
        ));
        assert!(matches!(
            state.emit("s", Some("t"), 0, text(2), usize::MAX),
            Emitted::Delivered(_)
        ));
        let event = events.recv().await.expect("expected the delivered frame");
        assert_eq!(
            event.payload["sequence"],
            serde_json::json!(1),
            "expected refused and over-budget frames to spend no sequence number"
        );
    }
}
