//! Reserved error codes (§6.3), the codec's own refusal type, and the error a
//! requester sees.

use std::fmt;

use serde_json::{Map, Value};

/// The error codes this specification reserves.
///
/// Applications define any other code; an unknown code is preserved as
/// received and never refused.
///
/// # Example
///
/// ```
/// use mango_protocol::error::codes;
///
/// assert_eq!(codes::DENIED, "DENIED");
/// ```
pub mod codes {
    /// The session cannot serve requests: handshake not complete, or closing.
    pub const UNAVAILABLE: &str = "UNAVAILABLE";
    /// Schema-valid but against a protocol rule: duplicate in-flight id, reserved `rpc.` method.
    pub const INVALID_REQUEST: &str = "INVALID_REQUEST";
    /// The responder has no handler for `method`.
    pub const METHOD_UNSUPPORTED: &str = "METHOD_UNSUPPORTED";
    /// `params` failed the contract's schema for this method.
    pub const INVALID_PARAMS: &str = "INVALID_PARAMS";
    /// The method exists but policy refuses it.
    pub const DENIED: &str = "DENIED";
    /// The handler stopped because a `cancel` arrived.
    pub const CANCELLED: &str = "CANCELLED";
    /// A deadline passed, locally or inside the responder.
    pub const TIMEOUT: &str = "TIMEOUT";
    /// The response would exceed the frame limit.
    pub const FRAME_TOO_LARGE: &str = "FRAME_TOO_LARGE";
    /// A request that cannot be served at the effective minor.
    pub const PROTOCOL_MISMATCH: &str = "PROTOCOL_MISMATCH";
    /// Anything else that failed inside the responder.
    pub const INTERNAL: &str = "INTERNAL";

    /// Every reserved code, in the order the specification lists them.
    pub const RESERVED: [&str; 10] = [
        UNAVAILABLE,
        INVALID_REQUEST,
        METHOD_UNSUPPORTED,
        INVALID_PARAMS,
        DENIED,
        CANCELLED,
        TIMEOUT,
        FRAME_TOO_LARGE,
        PROTOCOL_MISMATCH,
        INTERNAL,
    ];
}

/// True when the code is one this specification reserves.
///
/// A consumer narrows unknown codes to its own set; it never refuses them.
///
/// # Example
///
/// ```
/// use mango_protocol::error::is_reserved_error_code;
///
/// assert!(is_reserved_error_code("CANCELLED"));
/// assert!(!is_reserved_error_code("APP_QUOTA_EXHAUSTED"));
/// ```
#[must_use]
pub fn is_reserved_error_code(code: &str) -> bool {
    codes::RESERVED.contains(&code)
}

/// Why a codec refused bytes. Maps one to one onto the fixture corpus reasons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CodecErrorKind {
    /// The bytes are not JSON at all (`invalid-json` in the corpus).
    InvalidJson,
    /// The bytes are JSON but the frame breaks the schema (`schema`).
    Schema,
    /// The frame exceeds the frame limit (`too-large`).
    TooLarge,
    /// A chunk header's format version is not `1` (`chunk-version`).
    ChunkVersion,
    /// A chunk message is shorter than its nine-byte header (`chunk-header`).
    ChunkHeader,
    /// A chunk count is zero, above the bound, or changed mid-frame (`chunk-count`).
    ChunkCount,
    /// A chunk index is out of range or not the expected one (`chunk-index`).
    ChunkIndex,
    /// A chunk carries no payload, or a non-final chunk carries too few bytes (`chunk-dribble`).
    ChunkDribble,
}

impl CodecErrorKind {
    /// The corpus reason string for this kind.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::error::CodecErrorKind;
    ///
    /// assert_eq!(CodecErrorKind::ChunkDribble.reason(), "chunk-dribble");
    /// ```
    #[must_use]
    pub const fn reason(self) -> &'static str {
        match self {
            Self::InvalidJson => "invalid-json",
            Self::Schema => "schema",
            Self::TooLarge => "too-large",
            Self::ChunkVersion => "chunk-version",
            Self::ChunkHeader => "chunk-header",
            Self::ChunkCount => "chunk-count",
            Self::ChunkIndex => "chunk-index",
            Self::ChunkDribble => "chunk-dribble",
        }
    }
}

impl fmt::Display for CodecErrorKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.reason())
    }
}

/// A codec refusal: what went wrong and the received value against the expected shape.
///
/// # Example
///
/// ```
/// use mango_protocol::error::{CodecError, CodecErrorKind};
///
/// let refusal = CodecError::new(CodecErrorKind::TooLarge, "received 5000 bytes, expected 4096");
/// assert_eq!(refusal.kind, CodecErrorKind::TooLarge);
/// assert!(refusal.to_string().starts_with("too-large:"));
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodecError {
    /// Which rule the bytes broke.
    pub kind: CodecErrorKind,
    /// The received value and the expected shape, ready to log.
    pub message: String,
    /// The refused record's `"type"` member, when the codec could read that
    /// much before the record failed. `None` for a record the codec could not
    /// parse as JSON at all, or whose `"type"` member is missing or not a
    /// string.
    pub frame_type: Option<String>,
}

impl CodecError {
    /// Builds a refusal from a kind and a message naming the received value.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::error::{CodecError, CodecErrorKind};
    ///
    /// let refusal = CodecError::new(CodecErrorKind::Schema, "received {}, expected a frame");
    /// assert_eq!(refusal.message, "received {}, expected a frame");
    /// assert_eq!(refusal.frame_type, None);
    /// ```
    #[must_use]
    pub fn new(kind: CodecErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            frame_type: None,
        }
    }

    /// Names the frame type this refusal was about.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::error::{CodecError, CodecErrorKind};
    ///
    /// let refusal = CodecError::new(CodecErrorKind::Schema, "received an incomplete hello")
    ///     .with_frame_type("hello");
    /// assert_eq!(refusal.frame_type.as_deref(), Some("hello"));
    /// ```
    #[must_use]
    pub fn with_frame_type(mut self, frame_type: impl Into<String>) -> Self {
        self.frame_type = Some(frame_type.into());
        self
    }
}

impl fmt::Display for CodecError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.kind, self.message)
    }
}

impl std::error::Error for CodecError {}

/// What a requester receives when its request is answered with an `err`
/// frame, a request cannot be sent, or a session ends before it settles.
///
/// `code` is preserved exactly as received, including a code this crate does
/// not know.
///
/// # Example
///
/// ```
/// use mango_protocol::error::RemoteError;
///
/// let error = RemoteError::new("DENIED", "fsRead was not granted").with_detail("capability", "fsRead");
/// assert_eq!(error.code, "DENIED");
/// assert!(error.to_string().starts_with("DENIED:"));
/// ```
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteError {
    /// The `error.code` member: an application code, or one of [`codes`].
    pub code: String,
    /// A sentence naming the received value and the expected shape.
    pub message: String,
    /// Optional open object for typed detail.
    pub details: Option<Map<String, Value>>,
}

impl RemoteError {
    /// Builds an error with no details.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::error::RemoteError;
    ///
    /// let error = RemoteError::new("TIMEOUT", "Request \"fs.read-file\" timed out after 5000ms.");
    /// assert_eq!(error.details, None);
    /// ```
    #[must_use]
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    /// Replaces the details wholesale.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::error::RemoteError;
    /// use serde_json::{Map, json};
    ///
    /// let mut details = Map::new();
    /// details.insert("method".into(), json!("fs.read-file"));
    /// let error = RemoteError::new("UNAVAILABLE", "closed").with_details(details);
    /// assert_eq!(error.details.unwrap()["method"], json!("fs.read-file"));
    /// ```
    #[must_use]
    pub fn with_details(mut self, details: Map<String, Value>) -> Self {
        self.details = Some(details);
        self
    }

    /// Sets one detail key, creating the details map if this is the first one.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::error::RemoteError;
    /// use serde_json::json;
    ///
    /// let error = RemoteError::new("TIMEOUT", "timed out").with_detail("timeout_ms", 5000);
    /// assert_eq!(error.details.unwrap()["timeout_ms"], json!(5000));
    /// ```
    #[must_use]
    pub fn with_detail(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.details
            .get_or_insert_with(Map::new)
            .insert(key.to_string(), value.into());
        self
    }
}

impl fmt::Display for RemoteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for RemoteError {}

#[cfg(test)]
mod tests {
    use super::{CodecError, CodecErrorKind, RemoteError, codes, is_reserved_error_code};
    use serde_json::json;

    #[test]
    fn every_reserved_code_is_recognised() {
        for code in codes::RESERVED {
            assert!(is_reserved_error_code(code), "{code} should be reserved");
        }
    }

    #[test]
    fn an_application_code_is_not_reserved() {
        assert!(!is_reserved_error_code("APP_QUOTA_EXHAUSTED"));
        assert!(!is_reserved_error_code("denied"));
    }

    #[test]
    fn reserved_codes_match_the_specification_table() {
        assert_eq!(codes::RESERVED.len(), 10);
        assert_eq!(codes::FRAME_TOO_LARGE, "FRAME_TOO_LARGE");
    }

    #[test]
    fn display_names_the_reason_and_the_message() {
        let refusal = CodecError::new(CodecErrorKind::ChunkIndex, "received 3, expected 1");
        assert_eq!(refusal.to_string(), "chunk-index: received 3, expected 1");
    }

    #[test]
    fn every_kind_has_a_distinct_corpus_reason() {
        let kinds = [
            CodecErrorKind::InvalidJson,
            CodecErrorKind::Schema,
            CodecErrorKind::TooLarge,
            CodecErrorKind::ChunkVersion,
            CodecErrorKind::ChunkHeader,
            CodecErrorKind::ChunkCount,
            CodecErrorKind::ChunkIndex,
            CodecErrorKind::ChunkDribble,
        ];
        let mut reasons: Vec<&str> = kinds.iter().map(|kind| kind.reason()).collect();
        reasons.sort_unstable();
        reasons.dedup();
        assert_eq!(reasons.len(), kinds.len());
    }

    #[test]
    fn a_new_remote_error_has_no_details() {
        let error = RemoteError::new("DENIED", "fsRead was not granted");
        assert_eq!(error.code, "DENIED");
        assert_eq!(error.message, "fsRead was not granted");
        assert_eq!(error.details, None);
    }

    #[test]
    fn with_detail_creates_the_map_on_first_use_and_extends_it_after() {
        let error = RemoteError::new("TIMEOUT", "timed out")
            .with_detail("method", "fs.read-file")
            .with_detail("timeout_ms", 5000);
        let details = error.details.expect("has details");
        assert_eq!(details["method"], json!("fs.read-file"));
        assert_eq!(details["timeout_ms"], json!(5000));
    }

    #[test]
    fn with_details_replaces_whatever_was_there() {
        let error = RemoteError::new("TIMEOUT", "timed out")
            .with_detail("stale", true)
            .with_details(serde_json::Map::new());
        assert_eq!(error.details, Some(serde_json::Map::new()));
    }

    #[test]
    fn display_names_the_code_and_the_message() {
        let error = RemoteError::new("DENIED", "fsRead was not granted");
        assert_eq!(error.to_string(), "DENIED: fsRead was not granted");
    }
}
