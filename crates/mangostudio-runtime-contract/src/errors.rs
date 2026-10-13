//! The error vocabulary the hub and the runtime share, on top of the ten
//! codes `mango-protocol` reserves.
//!
//! Mirrors `apps/shared/src/runtime-contract/errors.ts`. The ten reserved
//! `err.code` values are never retyped here — they are
//! [`mango_protocol::error::codes`], re-exported as [`RESERVED_ERROR_CODES`]
//! so a caller reaches them through this crate without a second import — and
//! [`RUNTIME_SERVICE_ERROR_KINDS`] mirrors `details.kind`'s vocabulary, the
//! second half of the error contract, which the protocol crate has no reason
//! to know about.

use mango_protocol::error::codes;

/// Carried in `details.kind` for a consent refusal, as opposed to a fault.
pub const CONSENT_DENIED_KIND: &str = "consent_denied";

/// Application error code: a live binary transfer was unsafe, malformed,
/// busy, or out of sequence.
pub const RUNTIME_UPDATE_REFUSED: &str = "RUNTIME_UPDATE_REFUSED";

/// The ten `err.code` values the wire specification itself reserves.
///
/// Re-exported from [`mango_protocol::error::codes::RESERVED`] rather than
/// retyped: the runtime contract adds one application code on top
/// ([`RUNTIME_UPDATE_REFUSED`]), it does not restate the protocol's own ten.
pub const RESERVED_ERROR_CODES: [&str; 10] = codes::RESERVED;

/// Every value `details.kind` can carry: `err.code` says what class of
/// refusal a response is, `details.kind` says which one.
///
/// The tuple is the source; [`narrow_runtime_error_code`] and every consumer
/// downstream reads only this array, so a kind added to
/// `apps/shared/src/runtime-contract/errors.ts` and this array either match
/// or a test in this module fails naming the mismatch.
pub const RUNTIME_SERVICE_ERROR_KINDS: [&str; 29] = [
    CONSENT_DENIED_KIND,
    "path_access",
    "tool_argument",
    "grep_pattern",
    "file_not_read",
    "partial_read",
    "stale_file",
    "stale_line_numbers",
    "unobserved_line_numbers",
    "shell_execution",
    "terminal_not_found",
    "terminal_exited",
    "git_execution",
    "gh_execution",
    "workspace_browser",
    "workspace_containment",
    "workdir_validation",
    "snapshot_conflict",
    "snapshot_too_large",
    "runtime_update_refused",
    "runtime_service_unsupported",
    "runtime_service_no_session_bus",
    "runtime_service_setup_pending",
    "runtime_service_unconfigured",
    "runtime_service_binary_missing",
    "library_backup_missing",
    "mcp_connection",
    "mcp_call",
    "mcp_session_missing",
];

/// The `details` key an external-agent turn refusal uses to say the session cannot run the turn.
///
/// Mirrors `EXTERNAL_AGENT_SESSION_DETAIL` in `apps/shared/src/runtime-contract/errors.ts`.
pub const EXTERNAL_AGENT_SESSION_DETAIL: &str = "session";

/// The vendor's process ended or the SDK sealed the session; the conversation is intact.
pub const EXTERNAL_AGENT_SESSION_CLOSED: &str = "closed";

/// The SDK refuses every later turn on the vendor session; the conversation cannot be trusted.
pub const EXTERNAL_AGENT_SESSION_NONRESUMABLE: &str = "nonresumable";

/// Every value [`EXTERNAL_AGENT_SESSION_DETAIL`] can carry, in the order
/// `EXTERNAL_AGENT_SESSION_STATES` lists them in the TypeScript contract.
pub const EXTERNAL_AGENT_SESSION_STATES: [&str; 2] = [
    EXTERNAL_AGENT_SESSION_CLOSED,
    EXTERNAL_AGENT_SESSION_NONRESUMABLE,
];

/// The error codes a Claude turn ends with when the vendor itself finished it and reported a
/// failure. Every other code on a failed turn may mean the child was killed under it.
///
/// Mirrors `EXTERNAL_AGENT_FINISHED_TURN_ERROR_CODES` in
/// `apps/shared/src/runtime-contract/errors.ts`; the runtime holds it to the SDK's own codes.
pub const EXTERNAL_AGENT_FINISHED_TURN_ERROR_CODES: [&str; 5] = [
    "claude-error",
    "claude-error_during_execution",
    "claude-error_max_turns",
    "claude-error_max_budget_usd",
    "claude-error_max_structured_output_retries",
];

/// Maps a wire error code onto the known union, mirroring
/// `narrowRuntimeErrorCode` in `apps/shared/src/runtime-contract/errors.ts`.
///
/// A code this build has never heard of is a policy refusal from a newer
/// peer (or a typo), not a protocol violation — narrowing it to
/// [`mango_protocol::error::codes::INTERNAL`] surfaces a state instead of
/// dropping the connection.
///
/// # Example
///
/// ```
/// use mangostudio_runtime_contract::errors::narrow_runtime_error_code;
///
/// assert_eq!(narrow_runtime_error_code("DENIED"), "DENIED");
/// assert_eq!(narrow_runtime_error_code("WHAT_IS_THIS"), "INTERNAL");
/// ```
#[must_use]
pub fn narrow_runtime_error_code(code: &str) -> &'static str {
    if code == RUNTIME_UPDATE_REFUSED {
        return RUNTIME_UPDATE_REFUSED;
    }
    codes::RESERVED
        .into_iter()
        .find(|&known| known == code)
        .unwrap_or(codes::INTERNAL)
}

#[cfg(test)]
mod tests {
    use super::{
        CONSENT_DENIED_KIND, EXTERNAL_AGENT_SESSION_DETAIL, EXTERNAL_AGENT_SESSION_STATES,
        RESERVED_ERROR_CODES, RUNTIME_SERVICE_ERROR_KINDS, RUNTIME_UPDATE_REFUSED,
        narrow_runtime_error_code,
    };
    use crate::strings::errors_document;

    #[test]
    fn narrows_a_reserved_code_to_itself() {
        assert_eq!(narrow_runtime_error_code("DENIED"), "DENIED");
        assert_eq!(
            narrow_runtime_error_code("INVALID_PARAMS"),
            "INVALID_PARAMS"
        );
    }

    #[test]
    fn narrows_the_application_code_to_itself() {
        assert_eq!(
            narrow_runtime_error_code(RUNTIME_UPDATE_REFUSED),
            RUNTIME_UPDATE_REFUSED
        );
    }

    #[test]
    fn narrows_an_unknown_code_to_internal() {
        assert_eq!(narrow_runtime_error_code("WHAT_IS_THIS"), "INTERNAL");
        assert_eq!(narrow_runtime_error_code(""), "INTERNAL");
    }

    #[test]
    fn the_consent_denied_kind_and_update_refused_code_mirror_strings_json() {
        let document = errors_document();
        assert_eq!(
            CONSENT_DENIED_KIND,
            document["consentDeniedKind"].as_str().unwrap()
        );
        assert_eq!(
            RUNTIME_UPDATE_REFUSED,
            document["updateRefusedCode"].as_str().unwrap()
        );
    }

    /// The regression this whole module exists for: a kind added on the
    /// TypeScript side without a matching entry here must fail this test by
    /// name, not pass silently because the two lists happen to be the same
    /// length.
    #[test]
    fn the_service_error_kinds_mirror_strings_json_exactly() {
        let document = errors_document();
        let expected: Vec<&str> = document["serviceErrorKinds"]
            .as_array()
            .expect("an array")
            .iter()
            .map(|value| value.as_str().expect("a string"))
            .collect();
        assert_eq!(RUNTIME_SERVICE_ERROR_KINDS.to_vec(), expected);
    }

    /// The hub reads this key and these values off the wire, so a spelling that drifts on either
    /// side would turn a reopen into a lost session without any test noticing.
    #[test]
    fn the_finished_turn_error_codes_mirror_strings_json() {
        let document = errors_document();
        let codes: Vec<&str> = document["externalAgentFinishedTurnErrorCodes"]
            .as_array()
            .expect("an array")
            .iter()
            .map(|value| value.as_str().expect("a string"))
            .collect();
        assert_eq!(
            super::EXTERNAL_AGENT_FINISHED_TURN_ERROR_CODES.to_vec(),
            codes,
            "expected the Rust finished-turn error codes to match strings.json"
        );
    }

    #[test]
    fn the_external_agent_session_detail_and_states_mirror_strings_json() {
        let document = errors_document();
        let states: Vec<&str> = document["externalAgentSessionStates"]
            .as_array()
            .expect("an array")
            .iter()
            .map(|value| value.as_str().expect("a string"))
            .collect();
        assert_eq!(
            (
                EXTERNAL_AGENT_SESSION_DETAIL,
                EXTERNAL_AGENT_SESSION_STATES.to_vec()
            ),
            (
                document["externalAgentSessionDetail"].as_str().unwrap(),
                states
            ),
            "expected the Rust session detail key and states to match strings.json"
        );
    }

    #[test]
    fn the_reserved_codes_mirror_the_protocol_crate() {
        assert_eq!(
            RESERVED_ERROR_CODES.to_vec(),
            mango_protocol::error::codes::RESERVED.to_vec()
        );
    }
}
