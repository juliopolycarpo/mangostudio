//! Product interaction routing. Questions carry information and never grant authority.
use super::wire;
use crate::tool_argument::tool_argument;
use mango_protocol::error::RemoteError;

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

/// An answer to one product-visible interaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Answer {
    Permission {
        request_id: String,
        option_id: String,
    },
    Question {
        request_id: String,
        question_id: String,
        choice_id: String,
    },
    DeclineQuestions {
        request_id: String,
        question_ids: Vec<String>,
    },
}
/// What one mapped native event asks the product relay to retain or publish.
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
    pub unrenderable: Option<(Answer, &'static str)>,
}
/// Validates the chosen product option before routing its distinct response operation.
///
/// ```ignore
/// let response = answer(&pending, "allow-once")?;
/// session.respond(response).await?;
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
            Ok(Answer::Permission {
                request_id: request_id.clone(),
                option_id: option_id.to_owned(),
            })
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
            Ok(Answer::Question {
                request_id: request_id.clone(),
                question_id: question_id.clone(),
                choice_id: choice.clone(),
            })
        }
    }
}

fn unknown_option<'a>(received: &str, offered: impl Iterator<Item = &'a String>) -> RemoteError {
    let offered: Vec<&str> = offered.map(String::as_str).collect();
    tool_argument(format!(
        "optionId \"{received}\" is not an option this request offered; expected one of {offered:?}."
    ))
}
