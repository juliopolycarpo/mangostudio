//! The one wire shape for a caller mistake: `INTERNAL` carrying
//! `details.kind: "tool_argument"`, one of
//! [`mangostudio_runtime_contract::errors::RUNTIME_SERVICE_ERROR_KINDS`].

use mango_protocol::error::{RemoteError, codes};

/// A caller-mistake error carrying `message` verbatim.
///
/// `tool_argument("Unknown profile \"x\"; expected one of: a, b.")` answers
/// the call with that message under `kind: tool_argument`.
pub(crate) fn tool_argument(message: impl Into<String>) -> RemoteError {
    RemoteError::new(codes::INTERNAL, message).with_detail("kind", "tool_argument")
}

/// A caller-mistake error phrased as `Invalid {value}; expected {expected}.`
///
/// `invalid_argument("cols 0", "a positive integer")` produces
/// `Invalid cols 0; expected a positive integer.`
pub(crate) fn invalid_argument(value: &str, expected: &str) -> RemoteError {
    tool_argument(format!("Invalid {value}; expected {expected}."))
}

#[cfg(test)]
mod tests {
    use mango_protocol::error::codes;

    use super::invalid_argument;

    #[test]
    fn invalid_argument_names_the_value_and_expected_shape() {
        let error = invalid_argument("cols 0", "a positive integer");
        assert_eq!(
            (
                error.code.as_str(),
                error.message.as_str(),
                error
                    .details
                    .as_ref()
                    .map(|details| details["kind"].clone())
            ),
            (
                codes::INTERNAL,
                "Invalid cols 0; expected a positive integer.",
                Some(serde_json::json!("tool_argument"))
            ),
            "expected an INTERNAL tool_argument error | received {error:?}"
        );
    }
}
