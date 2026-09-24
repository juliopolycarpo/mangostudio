//! SDK turn events and interactions, as `external-agent.event` wire events.
//!
//! Pure, synchronous and deterministic, like the rest of [`map`](super::map): the
//! supervisor reads one [`sdk::AgentEvent`] off a turn stream, hands it to
//! [`map_event`], and puts whatever comes back on the wire, into its pending
//! map, or back to the SDK. Every time the wire needs comes from the event.
//!
//! Where the wire cannot say what the SDK said, this module picks the reading
//! that claims least, and says so:
//!
//! - **Questions ride the approval card.** The wire has no question event, so
//!   a round of exactly one single-choice question is shown as an approval
//!   whose option ids are the choice ids, as `codex/approvals.ts`'s
//!   `userInputApproval` did. Every other round is declined without reaching
//!   the wire. The card is recorded as a [`PendingInteraction::Question`], so
//!   the answer goes back as a [`sdk::QuestionResponse`] and never as a
//!   permission grant.
//! - **Structured activity content becomes `detail` text.** The SDK's own
//!   `detail` wins when the harness wrote one, because every harness already
//!   renders its content there. Otherwise a plan is its steps, a diff is one
//!   summary line per file and never a body, and output is its text.
//! - **Keep and clear.** An update whose content is `None` keeps what the
//!   host shows, so no `detail` is sent. `Some(ActivityContent::Empty)` clears
//!   it, and the wire's only way to say that is an explicit empty `detail`.
//! - **Labels mean exactly what the option does.** An option gets a
//!   `labelKey` only when its (effect, scope, policy-changing) triple has a
//!   key with that exact meaning. Everything else carries the vendor's own
//!   words as `rawLabel`, so a policy-changing "always allow" is never shown
//!   as "for this session".
//!
//! Ids are passed through unchanged. The SDK already refused an id it could
//! not carry, and an id is echoed back to the vendor, so cutting one here would
//! point it at a different object. Text is bounded again at the wire's caps
//! (`apps/shared/src/external-agents/vendor-text.ts`, the same numbers as
//! [`TextLimit`]); bounding is idempotent, and a cut sets `truncated`.

// TEMPORARY until the supervisor relays turn events; removed once it calls both entry points.
#![allow(dead_code)]

use mango_external_agents as sdk;
use mango_external_agents::normalize::{self, APPROVAL_MAX_OPTIONS, BoundedText, TextLimit};
use mango_protocol::error::RemoteError;

use super::map::{self, argument, epoch_ms};
use super::wire::{self, TargetId};

/// The `optionId` an `approval_resolved` carries for a question that ended
/// without a choice: expired, cancelled, refused or declined.
///
/// The wire requires a non-empty option id, and no choice was made, so this
/// names that fact instead of pretending one of the choices won. The
/// decision's `source` says why. A vendor choice with this exact id would be
/// indistinguishable, which is why it is spelled like no vendor id in use.
pub(crate) const NO_ANSWER_OPTION_ID: &str = "mangostudio:no-answer";

/// The `code` for a vendor error whose own code did not survive bounding.
const VENDOR_ERROR_CODE: &str = "external_agent_vendor";

/// The approval option keys the frontend ships under
/// `externalAgents.approval.option.*`. `deny` and `grantSession` are not used:
/// `decline` and `acceptForSession` already carry those exact meanings, and a
/// triple has one key.
mod keys {
    pub(super) const ACCEPT: &str = "externalAgents.approval.option.accept";
    pub(super) const ACCEPT_FOR_SESSION: &str = "externalAgents.approval.option.acceptForSession";
    pub(super) const DECLINE: &str = "externalAgents.approval.option.decline";
    pub(super) const GRANT_TURN: &str = "externalAgents.approval.option.grantTurn";
}

/// Why a question round cannot be shown. Each is the reason the supervisor logs.
mod unrenderable {
    pub(super) const NO_QUESTIONS: &str = "the round asks no question";
    pub(super) const SEVERAL_QUESTIONS: &str =
        "the round asks several questions; the approval card carries one";
    pub(super) const FREE_TEXT: &str =
        "the question wants free text; the approval card only offers choices";
    pub(super) const MULTI_SELECT: &str =
        "the question allows several choices; the approval card takes one";
    pub(super) const NO_OPTIONS: &str = "the question offers no choices";
    pub(super) const TOO_MANY_OPTIONS: &str =
        "the question offers more choices than an approval card carries";
    pub(super) const UNKNOWN_FORM: &str = "the question uses a form this runtime does not know";
}

/// What the supervisor needs to route a later answer to the right SDK call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PendingInteraction {
    /// A permission request. Answering it grants or refuses authority.
    Approval {
        /// The interaction id, which is also the wire's `requestId`.
        request_id: String,
        /// Every option id the card offered, unchanged.
        option_ids: Vec<String>,
        /// When the SDK stops accepting an answer.
        expires_at_ms: u64,
    },
    /// A single-choice question shown as an approval card: option id -> the question's choice id.
    Question {
        /// The interaction id, which is also the wire's `requestId`.
        request_id: String,
        /// The one question the round asked.
        question_id: String,
        /// `(card option id, question choice id)`, in the vendor's order.
        choices: Vec<(String, String)>,
        /// When the SDK stops accepting an answer.
        expires_at_ms: u64,
    },
}

impl PendingInteraction {
    /// The interaction id either variant was opened under: the wire's
    /// `requestId`, and the key a hub `respond` names.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let pending = map_event(TargetId::Codex, &event).opened.expect("an approval");
    /// interactions.insert(pending.request_id().to_owned(), pending);
    /// ```
    pub(crate) fn request_id(&self) -> &str {
        match self {
            Self::Approval { request_id, .. } | Self::Question { request_id, .. } => request_id,
        }
    }
}

/// What one SDK event means to the supervisor.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct MappedEvent {
    /// What goes on the wire, if anything.
    pub wire: Option<wire::Event>,
    /// A new interaction the supervisor must remember.
    pub opened: Option<PendingInteraction>,
    /// An interaction that has ended (resolved, expired, cancelled).
    ///
    /// The supervisor must drop `wire` when this names an id it never
    /// opened: a question declined as unrenderable still resolves in the SDK,
    /// and the hub never saw a card for it.
    pub closed: Option<String>,
    /// A question the product cannot render. The supervisor must answer it Declined, and the reason is logged.
    pub unrenderable: Option<(sdk::QuestionResponse, &'static str)>,
}

impl MappedEvent {
    fn wire(event: wire::Event) -> Self {
        Self {
            wire: Some(event),
            ..Self::default()
        }
    }
}

/// The SDK answer for one hub `respond`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Answer {
    /// Goes to `Session::respond`: a permission decision.
    Permission(sdk::PermissionResponse),
    /// Goes to `Session::answer`: information, never authority.
    Question(sdk::QuestionResponse),
}

/// Maps one SDK turn event to what the wire and the supervisor need.
///
/// `target` stamps account limits. `TurnStarted` maps to nothing, because the
/// supervisor already holds the native turn id, and an event kind this build
/// does not know maps to nothing rather than to a guess.
///
/// # Example
///
/// ```ignore
/// let mapped = map_event(TargetId::Codex, &event);
/// if let Some(wire) = mapped.wire { sink.emit(wire); }
/// if let Some(pending) = mapped.opened { interactions.insert(pending); }
/// ```
pub(crate) fn map_event(target: TargetId, event: &sdk::AgentEvent) -> MappedEvent {
    use sdk::EventKind as Kind;
    match &event.kind {
        Kind::TextDelta { text } => {
            MappedEvent::wire(wire::Event::TextDelta { text: text.clone() })
        }
        Kind::ReasoningStarted => MappedEvent::wire(wire::Event::ReasoningStarted),
        Kind::ReasoningDelta { text } => {
            MappedEvent::wire(wire::Event::ReasoningDelta { text: text.clone() })
        }
        Kind::ReasoningEnded => MappedEvent::wire(wire::Event::ReasoningEnded),
        Kind::ActivityStarted { call_id, activity } => {
            MappedEvent::wire(activity_started(call_id, activity))
        }
        Kind::ActivityUpdated { call_id, update } => {
            MappedEvent::wire(activity_updated(call_id, update))
        }
        Kind::ActivityCompleted { call_id, result } => {
            MappedEvent::wire(activity_completed(call_id, result))
        }
        Kind::ApprovalRequested { request } => approval_requested(request),
        Kind::ApprovalResolved {
            interaction_id,
            decision,
        } => resolved(
            interaction_id,
            non_empty_or_placeholder(&decision.option_id),
            decision_source(decision.source),
        ),
        Kind::QuestionAsked { request } => question_asked(request),
        Kind::QuestionResolved {
            interaction_id,
            outcome,
        } => question_resolved(interaction_id, outcome),
        Kind::Usage { usage } => MappedEvent::wire(wire::Event::Usage {
            usage: usage_of(usage),
        }),
        Kind::ThreadUsage { usage } => MappedEvent::wire(wire::Event::ThreadUsage {
            usage: wire::ThreadUsage {
                last: usage.last.as_ref().map(usage_of),
                total: usage.total.as_ref().map(usage_of),
                context_window_tokens: usage.context_window_tokens,
            },
        }),
        Kind::AccountLimits { limits } => MappedEvent::wire(wire::Event::AccountLimits {
            limits: map::account_limits(target, limits, limits.observed_at),
        }),
        // A marker: the terminal `Completed` behind it ends the turn.
        Kind::Cancelled { .. } => MappedEvent::wire(wire::Event::Cancelled),
        Kind::Completed => MappedEvent::wire(wire::Event::Completed),
        Kind::Error { error } => MappedEvent::wire(wire::Event::Error {
            error: agent_error(error),
        }),
        _ => MappedEvent::default(),
    }
}

/// The SDK answer for a hub `respond(requestId, optionId)` against a pending interaction.
///
/// A question is answered with its choice id as a [`sdk::QuestionResponse`],
/// never as a [`sdk::PermissionResponse`]: answering a question grants
/// nothing.
///
/// # Errors
///
/// A `tool_argument` error naming the received option and the offered ids
/// when `option_id` is not one the card offered.
///
/// # Example
///
/// ```ignore
/// match answer(&pending, "main")? {
///     Answer::Permission(response) => session.respond(response).await?,
///     Answer::Question(response) => session.answer(response).await?,
/// }
/// ```
pub(crate) fn answer(pending: &PendingInteraction, option_id: &str) -> Result<Answer, RemoteError> {
    match pending {
        PendingInteraction::Approval {
            request_id,
            option_ids,
            ..
        } => {
            if !option_ids.iter().any(|offered| offered == option_id) {
                return Err(unknown_option(option_id, option_ids.iter()));
            }
            Ok(Answer::Permission(sdk::PermissionResponse::from_user(
                sdk::InteractionId::new(request_id),
                option_id,
            )))
        }
        PendingInteraction::Question {
            request_id,
            question_id,
            choices,
            ..
        } => {
            let Some((_, choice)) = choices.iter().find(|(offered, _)| offered == option_id) else {
                return Err(unknown_option(
                    option_id,
                    choices.iter().map(|(offered, _)| offered),
                ));
            };
            Ok(Answer::Question(sdk::QuestionResponse::new(
                sdk::InteractionId::new(request_id),
                vec![sdk::Answer::new(
                    sdk::QuestionId::new(question_id),
                    sdk::AnswerValue::chosen(sdk::QuestionOptionId::new(choice)),
                )],
            )))
        }
    }
}

fn unknown_option<'a>(received: &str, offered: impl Iterator<Item = &'a String>) -> RemoteError {
    let offered: Vec<&str> = offered.map(String::as_str).collect();
    argument(format!(
        "optionId \"{received}\" is not an option this request offered; expected one of {offered:?}."
    ))
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

fn activity_started(call_id: &str, activity: &sdk::Activity) -> wire::Event {
    let kind = activity_kind(activity.kind);
    let name = bound(&activity.name, TextLimit::ActivityName);
    let title = bound(&activity.title, TextLimit::Title);
    let detail = detail_of(activity.detail.as_deref(), activity.content.as_ref());
    let truncated = activity.truncated
        || name.truncated
        || title.truncated
        || detail.as_ref().is_some_and(|detail| detail.truncated);
    let name = if name.is_empty() {
        activity_kind_name(kind).to_owned()
    } else {
        name.text
    };
    wire::Event::ActivityStarted {
        call_id: call_id.to_owned(),
        activity: wire::ActivityView {
            name,
            kind,
            title: title.text,
            detail: detail.map(|detail| detail.text),
            truncated: truncated.then_some(true),
        },
    }
}

fn activity_updated(call_id: &str, update: &sdk::ActivityUpdate) -> wire::Event {
    let title = update
        .title
        .as_deref()
        .map(|title| bound(title, TextLimit::Title));
    let detail = detail_of(update.detail.as_deref(), update.content.as_ref());
    let truncated = update.truncated
        || title.as_ref().is_some_and(|title| title.truncated)
        || detail.as_ref().is_some_and(|detail| detail.truncated);
    wire::Event::ActivityUpdated {
        call_id: call_id.to_owned(),
        update: wire::ActivityUpdate {
            title: title.map(|title| title.text),
            detail: detail.map(|detail| detail.text),
            truncated: truncated.then_some(true),
        },
    }
}

fn activity_completed(call_id: &str, result: &sdk::ActivityResult) -> wire::Event {
    let detail = detail_of(result.detail.as_deref(), result.content.as_ref());
    let truncated = result.truncated || detail.as_ref().is_some_and(|detail| detail.truncated);
    wire::Event::ActivityCompleted {
        call_id: call_id.to_owned(),
        result: wire::ActivityResult {
            status: activity_status(result.status),
            detail: detail.map(|detail| detail.text),
            truncated: truncated.then_some(true),
        },
    }
}

/// The wire `detail` for an SDK `detail`/`content` pair.
///
/// | `detail`  | `content`     | wire `detail`        |
/// |-----------|---------------|----------------------|
/// | `Some(x)` | anything      | `x`                  |
/// | `None`    | `None`        | absent (keep)        |
/// | `None`    | `Empty`       | `""` (clear)         |
/// | `None`    | plan/diff/out | the rendered content |
fn detail_of(detail: Option<&str>, content: Option<&sdk::ActivityContent>) -> Option<BoundedText> {
    if let Some(detail) = detail {
        return Some(bound(detail, TextLimit::Detail));
    }
    render_content(content?).map(|rendered| bound(&rendered, TextLimit::Detail))
}

/// Structured content as the text a person reads. `None` for a content kind
/// this build does not know, which keeps rather than clears.
fn render_content(content: &sdk::ActivityContent) -> Option<String> {
    match content {
        sdk::ActivityContent::Empty => Some(String::new()),
        sdk::ActivityContent::Plan { steps } => Some(
            steps
                .iter()
                .map(|step| format!("[{}] {}", step.status, step.title))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        sdk::ActivityContent::Diff { files } => {
            Some(files.iter().map(file_line).collect::<Vec<_>>().join("\n"))
        }
        sdk::ActivityContent::Output { text } => Some(text.clone()),
        _ => None,
    }
}

/// `modified src/lib.rs (+3 -1)`, `renamed old.rs → new.rs`. Never a diff body.
fn file_line(file: &sdk::FileChange) -> String {
    let kind = file
        .kind
        .map_or_else(|| String::from("changed"), |kind| kind.to_string());
    let path = match &file.previous_path {
        Some(previous) => format!("{previous} → {}", file.path),
        None => file.path.clone(),
    };
    let counts = match (file.added_lines, file.removed_lines) {
        (Some(added), Some(removed)) => format!(" (+{added} -{removed})"),
        (Some(added), None) => format!(" (+{added})"),
        (None, Some(removed)) => format!(" (-{removed})"),
        (None, None) => String::new(),
    };
    format!("{kind} {path}{counts}")
}

fn activity_kind(kind: sdk::ActivityKind) -> wire::ActivityKind {
    match kind {
        sdk::ActivityKind::Command => wire::ActivityKind::Command,
        sdk::ActivityKind::FileChange => wire::ActivityKind::FileChange,
        sdk::ActivityKind::Mcp => wire::ActivityKind::Mcp,
        sdk::ActivityKind::Subagent => wire::ActivityKind::Subagent,
        sdk::ActivityKind::WebSearch => wire::ActivityKind::WebSearch,
        sdk::ActivityKind::Image => wire::ActivityKind::Image,
        sdk::ActivityKind::Plan => wire::ActivityKind::Plan,
        sdk::ActivityKind::Review => wire::ActivityKind::Review,
        sdk::ActivityKind::Compaction => wire::ActivityKind::Compaction,
        _ => wire::ActivityKind::Other,
    }
}

/// The wire spelling, used as an activity's name when the vendor gave none.
fn activity_kind_name(kind: wire::ActivityKind) -> &'static str {
    match kind {
        wire::ActivityKind::Command => "command",
        wire::ActivityKind::FileChange => "file-change",
        wire::ActivityKind::Mcp => "mcp",
        wire::ActivityKind::Subagent => "subagent",
        wire::ActivityKind::WebSearch => "web-search",
        wire::ActivityKind::Image => "image",
        wire::ActivityKind::Plan => "plan",
        wire::ActivityKind::Review => "review",
        wire::ActivityKind::Compaction => "compaction",
        wire::ActivityKind::Other => "other",
    }
}

/// An unknown status is `failed`: `completed` would claim a success nobody saw.
fn activity_status(status: sdk::ActivityStatus) -> wire::ActivityStatus {
    match status {
        sdk::ActivityStatus::Completed => wire::ActivityStatus::Completed,
        sdk::ActivityStatus::Cancelled => wire::ActivityStatus::Cancelled,
        _ => wire::ActivityStatus::Failed,
    }
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

fn approval_requested(request: &sdk::PermissionRequest) -> MappedEvent {
    let request_id = request.id().as_str().to_owned();
    let expires_at_ms = epoch_ms(request.expires_at()).unwrap_or(0);
    let title = bound(&request.title, TextLimit::Title);
    let detail = request
        .detail
        .as_deref()
        .map(|detail| bound(detail, TextLimit::Detail));
    let mut truncated = request.truncated
        || title.truncated
        || detail.as_ref().is_some_and(|detail| detail.truncated);
    let options: Vec<wire::ApprovalOption> = request
        .options
        .iter()
        .map(|option| {
            let (wire_option, cut) = approval_option(option);
            truncated |= cut;
            wire_option
        })
        .collect();
    MappedEvent {
        opened: Some(PendingInteraction::Approval {
            request_id: request_id.clone(),
            option_ids: options.iter().map(|option| option.id.clone()).collect(),
            expires_at_ms,
        }),
        ..MappedEvent::wire(wire::Event::ApprovalRequested {
            request: wire::ApprovalRequest {
                request_id,
                kind: activity_kind(request.kind),
                title: title.text,
                detail: detail.map(|detail| detail.text),
                options,
                expires_at_ms,
                truncated: truncated.then_some(true),
            },
        })
    }
}

/// One option, and whether its label was cut.
fn approval_option(option: &sdk::PermissionOption) -> (wire::ApprovalOption, bool) {
    let is_destructive = option_is_destructive(option);
    if let Some(key) = label_key(option) {
        let wire_option = wire::ApprovalOption {
            id: option.id.clone(),
            label_key: Some(key.to_owned()),
            raw_label: None,
            is_destructive,
        };
        return (wire_option, false);
    }
    let (raw_label, cut) = raw_label(option.label.as_deref(), &option.id);
    let wire_option = wire::ApprovalOption {
        id: option.id.clone(),
        label_key: None,
        raw_label: Some(raw_label),
        is_destructive,
    };
    (wire_option, cut)
}

/// The key whose copy means exactly this option's (effect, scope,
/// policy-changing), or `None` when no key does.
///
/// | effect | scope   | policy-changing | key                |
/// |--------|---------|-----------------|--------------------|
/// | allow  | once    | no              | `accept`           |
/// | allow  | turn    | no              | `grantTurn`        |
/// | allow  | session | no              | `acceptForSession` |
/// | reject | once    | no              | `decline`          |
/// | any other triple                     || none: `rawLabel` |
fn label_key(option: &sdk::PermissionOption) -> Option<&'static str> {
    use sdk::{PermissionEffect as Effect, PermissionScope as Scope};
    if option.policy_changing {
        return None;
    }
    match (option.effect, option.scope?) {
        (Effect::Allow, Scope::Once) => Some(keys::ACCEPT),
        (Effect::Allow, Scope::Turn) => Some(keys::GRANT_TURN),
        (Effect::Allow, Scope::Session) => Some(keys::ACCEPT_FOR_SESSION),
        (Effect::Reject, Scope::Once) => Some(keys::DECLINE),
        _ => None,
    }
}

/// The vendor marked it destructive, or it allows past the turn that asked:
/// policy-changing, session-wide, persistent, or of a reach nobody stated.
/// A reject is never destructive, however sticky, as in `cursor/approvals.ts`.
fn option_is_destructive(option: &sdk::PermissionOption) -> bool {
    use sdk::PermissionScope as Scope;
    if option.is_destructive() {
        return true;
    }
    option.allows()
        && (option.policy_changing || !matches!(option.scope, Some(Scope::Once | Scope::Turn)))
}

/// The vendor's label bounded, or the option id when it gave none.
fn raw_label(label: Option<&str>, id: &str) -> (String, bool) {
    let bounded = label.map(|label| bound(label, TextLimit::ApprovalOptionLabel));
    match bounded {
        Some(bounded) if !bounded.is_empty() => (bounded.text, bounded.truncated),
        _ => (id.to_owned(), false),
    }
}

/// An unknown source is `cancelled`: it claims nobody chose.
fn decision_source(source: sdk::DecisionSource) -> wire::DecisionSource {
    match source {
        sdk::DecisionSource::User => wire::DecisionSource::User,
        sdk::DecisionSource::AutoReview => wire::DecisionSource::AutoReview,
        sdk::DecisionSource::Expired => wire::DecisionSource::Expired,
        _ => wire::DecisionSource::Cancelled,
    }
}

fn resolved(
    interaction_id: &sdk::InteractionId,
    option_id: String,
    source: wire::DecisionSource,
) -> MappedEvent {
    let request_id = interaction_id.as_str().to_owned();
    MappedEvent {
        closed: Some(request_id.clone()),
        ..MappedEvent::wire(wire::Event::ApprovalResolved {
            request_id,
            decision: wire::ApprovalDecision { option_id, source },
        })
    }
}

fn non_empty_or_placeholder(option_id: &str) -> String {
    if option_id.is_empty() {
        return NO_ANSWER_OPTION_ID.to_owned();
    }
    option_id.to_owned()
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

fn question_asked(request: &sdk::QuestionRequest) -> MappedEvent {
    let (question, choices) = match renderable(request) {
        Ok(renderable) => renderable,
        Err(reason) => {
            return MappedEvent {
                unrenderable: Some((declined(request), reason)),
                ..MappedEvent::default()
            };
        }
    };
    let request_id = request.interaction.id.as_str().to_owned();
    let expires_at_ms = epoch_ms(request.interaction.expires_at).unwrap_or(0);
    let (title, detail) = question_card_text(request.title.as_deref(), question);
    let mut truncated = request.truncated
        || title.truncated
        || detail.as_ref().is_some_and(|detail| detail.truncated);
    let options: Vec<wire::ApprovalOption> = choices
        .iter()
        .map(|choice| {
            let (raw_label, cut) = raw_label(choice.label.as_deref(), choice.id.as_str());
            truncated |= cut;
            wire::ApprovalOption {
                id: choice.id.as_str().to_owned(),
                label_key: None,
                raw_label: Some(raw_label),
                is_destructive: false,
            }
        })
        .collect();
    MappedEvent {
        opened: Some(PendingInteraction::Question {
            request_id: request_id.clone(),
            question_id: question.id.as_str().to_owned(),
            choices: choices
                .iter()
                .map(|choice| (choice.id.as_str().to_owned(), choice.id.as_str().to_owned()))
                .collect(),
            expires_at_ms,
        }),
        ..MappedEvent::wire(wire::Event::ApprovalRequested {
            request: wire::ApprovalRequest {
                request_id,
                kind: wire::ActivityKind::Other,
                title: title.text,
                detail: detail.map(|detail| detail.text),
                options,
                expires_at_ms,
                truncated: truncated.then_some(true),
            },
        })
    }
}

/// The one question and its choices, or why the card cannot carry the round.
fn renderable(
    request: &sdk::QuestionRequest,
) -> Result<(&sdk::Question, &[sdk::QuestionOption]), &'static str> {
    let question = match request.questions.as_slice() {
        [] => return Err(unrenderable::NO_QUESTIONS),
        [question] => question,
        _ => return Err(unrenderable::SEVERAL_QUESTIONS),
    };
    let (options, multi_select) = match &question.form {
        sdk::QuestionForm::Choice {
            options,
            multi_select,
        } => (options, *multi_select),
        sdk::QuestionForm::FreeText { .. } => return Err(unrenderable::FREE_TEXT),
        _ => return Err(unrenderable::UNKNOWN_FORM),
    };
    if multi_select {
        return Err(unrenderable::MULTI_SELECT);
    }
    if options.is_empty() {
        return Err(unrenderable::NO_OPTIONS);
    }
    if options.len() > APPROVAL_MAX_OPTIONS {
        return Err(unrenderable::TOO_MANY_OPTIONS);
    }
    Ok((question, options))
}

/// Declines every question in the round, one answer each.
fn declined(request: &sdk::QuestionRequest) -> sdk::QuestionResponse {
    sdk::QuestionResponse::new(
        request.interaction.id.clone(),
        request
            .questions
            .iter()
            .map(|question| sdk::Answer::new(question.id.clone(), sdk::AnswerValue::Declined))
            .collect(),
    )
}

/// The card's title and detail, as `userInputApproval` built them: a short
/// heading as the title and the question itself as the detail.
///
/// The heading is the round's title, else the question's own detail (Codex's
/// `header`), else the prompt. Whatever is not the title goes to the detail.
fn question_card_text(
    round_title: Option<&str>,
    question: &sdk::Question,
) -> (BoundedText, Option<BoundedText>) {
    let prompt = Some(question.prompt.as_str()).filter(|text| !text.is_empty());
    let header = question.detail.as_deref().filter(|text| !text.is_empty());
    let round_title = round_title.filter(|text| !text.is_empty());
    let (title, rest): (&str, Vec<&str>) = match (round_title, header) {
        (Some(title), _) => (title, [prompt, header].into_iter().flatten().collect()),
        (None, Some(header)) => (header, prompt.into_iter().collect()),
        (None, None) => (prompt.unwrap_or_default(), Vec::new()),
    };
    let detail = (!rest.is_empty()).then(|| bound(&rest.join("\n\n"), TextLimit::Detail));
    (bound(title, TextLimit::Title), detail)
}

/// A question's end, as an `approval_resolved` for the same request id.
///
/// Answered is `user` with the chosen id; expired and cancelled keep their
/// names; a refusal is `cancelled`. Any end without exactly one chosen id
/// carries [`NO_ANSWER_OPTION_ID`].
fn question_resolved(
    interaction_id: &sdk::InteractionId,
    outcome: &sdk::QuestionOutcome,
) -> MappedEvent {
    let (option_id, source) = match outcome {
        sdk::QuestionOutcome::Answered { answers } => {
            (chosen_id(answers), wire::DecisionSource::User)
        }
        sdk::QuestionOutcome::Expired => (None, wire::DecisionSource::Expired),
        _ => (None, wire::DecisionSource::Cancelled),
    };
    let option_id = option_id.unwrap_or_else(|| NO_ANSWER_OPTION_ID.to_owned());
    resolved(interaction_id, option_id, source)
}

/// The one chosen id of a single-choice answer, if that is what was answered.
fn chosen_id(answers: &[sdk::Answer]) -> Option<String> {
    let [answer] = answers else {
        return None;
    };
    match &answer.value {
        sdk::AnswerValue::Chosen { option_ids } => match option_ids.as_slice() {
            [chosen] if !chosen.as_str().is_empty() => Some(chosen.as_str().to_owned()),
            _ => None,
        },
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Usage and errors
// ---------------------------------------------------------------------------

fn usage_of(usage: &sdk::Usage) -> wire::Usage {
    wire::Usage {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_write_tokens: usage.cache_write_tokens,
        reasoning_tokens: usage.reasoning_tokens,
        total_tokens: usage.total_tokens,
    }
}

/// The wire error for a vendor failure: the harness's code, the SDK-bounded
/// and redacted message, and the vendor's code, request id and retryability.
fn agent_error(error: &sdk::VendorError) -> wire::AgentError {
    let code = bound(error.code.as_str(), TextLimit::VendorId);
    let message = bound(&error.message, TextLimit::ErrorMessage);
    let optional_id = |value: Option<&str>| {
        value
            .map(|value| bound(value, TextLimit::VendorId).text)
            .filter(|value| !value.is_empty())
    };
    wire::AgentError {
        code: if code.is_empty() {
            VENDOR_ERROR_CODE.to_owned()
        } else {
            code.text
        },
        message: message.text,
        request_id: optional_id(error.request_id.as_deref()),
        retryable: Some(error.retryable),
        vendor_code: optional_id(error.vendor_code.as_deref()),
        truncated: message.truncated.then_some(true),
    }
}

/// The wire's slash-command catalog: at most 256 entries, each name and
/// description bounded, and nameless entries dropped (the wire requires one).
///
/// # Example
///
/// ```ignore
/// let catalog = commands(&session.snapshot().commands);
/// ```
pub(crate) fn commands(commands: &[sdk::Command]) -> Vec<wire::Command> {
    const CATALOG_MAX_ITEMS: usize = 256;
    commands
        .iter()
        .filter_map(|command| {
            let name = bound(&command.name, TextLimit::CommandName).text;
            (!name.is_empty()).then(|| wire::Command {
                name,
                description: command
                    .description
                    .as_deref()
                    .map(|description| bound(description, TextLimit::CommandDescription).text)
                    .filter(|description| !description.is_empty()),
            })
        })
        .take(CATALOG_MAX_ITEMS)
        .collect()
}

fn bound(raw: &str, limit: TextLimit) -> BoundedText {
    normalize::bound_text(raw, limit)
}

#[cfg(test)]
#[path = "map_events_tests.rs"]
mod tests;
