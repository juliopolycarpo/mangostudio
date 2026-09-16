//! Close reason codes (§10) and the fatal set.

use crate::error::{CodecError, CodecErrorKind};

/// The reason codes the specification names. Any other code in `4000..=4999` is valid too.
///
/// # Example
///
/// ```
/// use mango_protocol::close::close_codes;
///
/// assert_eq!(close_codes::PROTOCOL_MISMATCH, 4426);
/// ```
pub mod close_codes {
    /// The sender let the connection go: shutdown, rotation, liveness timeout.
    pub const RELEASED: u16 = 4000;
    /// A frame or chunk the decoder refused; also the handshake timeout.
    pub const PROTOCOL_ERROR: u16 = 4400;
    /// The credential presented at the transport is missing, unknown or revoked.
    pub const UNAUTHORIZED: u16 = 4401;
    /// The credential is valid but its subject is disabled or gone.
    pub const FORBIDDEN: u16 = 4403;
    /// Another connection for the same subject took over.
    pub const SUPERSEDED: u16 = 4409;
    /// Wire majors differ.
    pub const PROTOCOL_MISMATCH: u16 = 4426;
    /// Too many connections from this source.
    pub const RATE_LIMITED: u16 = 4429;
    /// The sender failed while setting the connection up.
    pub const INTERNAL: u16 = 4500;
}

/// The lowest close code the specification allows.
pub const MIN_CLOSE_CODE: u16 = 4000;
/// The highest close code the specification allows.
pub const MAX_CLOSE_CODE: u16 = 4999;

/// Codes after which redialling cannot change the outcome.
const FATAL: [u16; 4] = [
    close_codes::UNAUTHORIZED,
    close_codes::FORBIDDEN,
    close_codes::SUPERSEDED,
    close_codes::PROTOCOL_MISMATCH,
];

/// True for the fatal set: a peer MUST NOT retry automatically after one of these.
///
/// # Example
///
/// ```
/// use mango_protocol::close::is_fatal_close_code;
///
/// assert!(is_fatal_close_code(4401));
/// assert!(!is_fatal_close_code(4000));
/// ```
#[must_use]
pub fn is_fatal_close_code(code: u16) -> bool {
    FATAL.contains(&code)
}

/// The specification's name for a code, or `None` for an unlisted one.
///
/// # Example
///
/// ```
/// use mango_protocol::close::close_code_name;
///
/// assert_eq!(close_code_name(4409), Some("SUPERSEDED"));
/// assert_eq!(close_code_name(4777), None);
/// ```
#[must_use]
pub fn close_code_name(code: u16) -> Option<&'static str> {
    match code {
        close_codes::RELEASED => Some("RELEASED"),
        close_codes::PROTOCOL_ERROR => Some("PROTOCOL_ERROR"),
        close_codes::UNAUTHORIZED => Some("UNAUTHORIZED"),
        close_codes::FORBIDDEN => Some("FORBIDDEN"),
        close_codes::SUPERSEDED => Some("SUPERSEDED"),
        close_codes::PROTOCOL_MISMATCH => Some("PROTOCOL_MISMATCH"),
        close_codes::RATE_LIMITED => Some("RATE_LIMITED"),
        close_codes::INTERNAL => Some("INTERNAL"),
        _ => None,
    }
}

/// The close code a decoder uses when it refuses a peer's bytes with `error`.
///
/// A `hello` frame the decoder cannot read closes with [`close_codes::PROTOCOL_MISMATCH`]
/// rather than [`close_codes::PROTOCOL_ERROR`], since the peer likely speaks a wire major
/// this side cannot parse at all — retrying the same connection cannot help. Every other
/// refusal, including a schema failure on any other frame type, closes with
/// `PROTOCOL_ERROR`.
///
/// # Example
///
/// ```
/// use mango_protocol::close::{close_code_for_codec_error, close_codes};
/// use mango_protocol::error::{CodecError, CodecErrorKind};
///
/// let unreadable_hello =
///     CodecError::new(CodecErrorKind::Schema, "missing peer").with_frame_type("hello");
/// assert_eq!(close_code_for_codec_error(&unreadable_hello), close_codes::PROTOCOL_MISMATCH);
///
/// let bad_request = CodecError::new(CodecErrorKind::Schema, "bad method name");
/// assert_eq!(close_code_for_codec_error(&bad_request), close_codes::PROTOCOL_ERROR);
/// ```
#[must_use]
pub fn close_code_for_codec_error(error: &CodecError) -> u16 {
    if error.kind == CodecErrorKind::Schema && error.frame_type.as_deref() == Some("hello") {
        return close_codes::PROTOCOL_MISMATCH;
    }
    close_codes::PROTOCOL_ERROR
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_CLOSE_CODE, MIN_CLOSE_CODE, close_code_for_codec_error, close_code_name, close_codes,
        is_fatal_close_code,
    };
    use crate::error::{CodecError, CodecErrorKind};

    #[test]
    fn the_fatal_set_is_exactly_the_four_listed_codes() {
        for code in [4401, 4403, 4409, 4426] {
            assert!(is_fatal_close_code(code), "{code} is fatal");
        }
        for code in [4000, 4400, 4429, 4500, 4777] {
            assert!(!is_fatal_close_code(code), "{code} is not fatal");
        }
    }

    #[test]
    fn every_named_code_round_trips_through_its_name() {
        let named = [
            (close_codes::RELEASED, "RELEASED"),
            (close_codes::PROTOCOL_ERROR, "PROTOCOL_ERROR"),
            (close_codes::UNAUTHORIZED, "UNAUTHORIZED"),
            (close_codes::FORBIDDEN, "FORBIDDEN"),
            (close_codes::SUPERSEDED, "SUPERSEDED"),
            (close_codes::PROTOCOL_MISMATCH, "PROTOCOL_MISMATCH"),
            (close_codes::RATE_LIMITED, "RATE_LIMITED"),
            (close_codes::INTERNAL, "INTERNAL"),
        ];
        for (code, name) in named {
            assert_eq!(close_code_name(code), Some(name));
        }
    }

    #[test]
    fn an_unlisted_code_in_range_has_no_name() {
        assert_eq!(close_code_name(4777), None);
    }

    #[test]
    fn the_allowed_range_is_the_private_websocket_range() {
        assert_eq!((MIN_CLOSE_CODE, MAX_CLOSE_CODE), (4000, 4999));
    }

    #[test]
    fn an_unreadable_hello_closes_with_protocol_mismatch() {
        let error =
            CodecError::new(CodecErrorKind::Schema, "missing peer").with_frame_type("hello");
        assert_eq!(
            close_code_for_codec_error(&error),
            close_codes::PROTOCOL_MISMATCH
        );
    }

    #[test]
    fn a_schema_refusal_of_any_other_frame_type_closes_with_protocol_error() {
        let error =
            CodecError::new(CodecErrorKind::Schema, "bad method name").with_frame_type("req");
        assert_eq!(
            close_code_for_codec_error(&error),
            close_codes::PROTOCOL_ERROR
        );
    }

    #[test]
    fn a_schema_refusal_with_no_frame_type_closes_with_protocol_error() {
        let error = CodecError::new(CodecErrorKind::Schema, "not an object");
        assert_eq!(
            close_code_for_codec_error(&error),
            close_codes::PROTOCOL_ERROR
        );
    }

    #[test]
    fn a_non_schema_refusal_of_hello_still_closes_with_protocol_error() {
        let error =
            CodecError::new(CodecErrorKind::InvalidJson, "not json").with_frame_type("hello");
        assert_eq!(
            close_code_for_codec_error(&error),
            close_codes::PROTOCOL_ERROR
        );
    }
}
