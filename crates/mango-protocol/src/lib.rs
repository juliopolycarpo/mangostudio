//! Mango Protocol: wire types and codec for MangoStudio hubs, runtimes and tools.
//!
//! This crate is the Rust half of one wire contract published three ways: the
//! normative specification under `spec/`, the TypeScript SDK
//! `@mangostudio/protocol`, and this crate. It carries the frame types, the
//! rules a decoder enforces, the two framings a transport needs, and the
//! catalog document. Behind the `tokio` feature it also carries a session
//! (request/response multiplexing, cancel, event streams, liveness, close)
//! over any `port::Port`, a `contract` builder that validates, serves and
//! calls it, and the `transports` the session is opened over.
//!
//! # Example
//!
//! ```
//! use mango_protocol::codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, decode_line, encode_line};
//! use mango_protocol::{Frame, Request};
//! use serde_json::json;
//!
//! let request = Frame::Req(Request {
//!     id: "r-42".into(),
//!     method: "fs.read-file".into(),
//!     params: json!({ "path": "/etc/hosts" }),
//! });
//! let line = encode_line(&request, DEFAULT_MAX_FRAME_BYTES)?;
//! assert_eq!(line.last(), Some(&b'\n'));
//! assert_eq!(decode_line(&line[..line.len() - 1], DEFAULT_MAX_FRAME_BYTES)?, request);
//! # Ok::<(), mango_protocol::CodecError>(())
//! ```
//!
//! # Layout
//!
//! - [`frame`] — the eight frame types and their members.
//! - [`mod@validate`] — the lengths, grammars and ranges serde cannot express.
//! - [`codec`] — NDJSON lines and WebSocket chunk messages.
//! - [`version`] — the wire version and the negotiation rule.
//! - [`close`] and [`error`] — the reserved close codes and error codes.
//! - [`catalog`] — the catalog document that describes an application contract.
//! - `schema` — JSON Schema emission, behind the `schema` feature.
//! - `port` — the transport seam and an in-process pair, behind the `tokio` feature.
//! - `session` — request/response multiplexing, cancel, events, liveness, close; behind `tokio`.
//! - `transports` — the ports a session is opened over; behind `tokio` and its own features.
//! - `contract` — catalog-driven validation, `serve`, typed handlers, a guard; behind `tokio`.
//! - `testing` — the reusable conformance suite, behind the `testing` feature.

pub mod catalog;
pub mod close;
pub mod codec;
pub mod error;
pub mod frame;
pub mod validate;
pub mod version;

#[cfg(feature = "schema")]
pub mod schema;

#[cfg(feature = "tokio")]
pub mod contract;
#[cfg(feature = "tokio")]
pub mod port;
#[cfg(feature = "tokio")]
pub mod session;
#[cfg(feature = "testing")]
pub mod testing;
#[cfg(feature = "tokio")]
pub mod transports;

pub use catalog::{Catalog, CatalogEvent, CatalogMethod};
pub use close::{close_code_name, close_codes, is_fatal_close_code};
pub use codec::chunk::{ChunkReassembler, encode_chunks};
pub use codec::ndjson::{LineDecoder, PushOutcome, decode_line, encode_frame_bytes, encode_line};
pub use error::{CodecError, CodecErrorKind, RemoteError, is_reserved_error_code};
pub use frame::{
    Cancel, Close, End, ErrorPayload, ErrorResponse, Event, Frame, Hello, Limits, PeerInfo,
    Request, Response,
};
pub use validate::{
    RPC_DISCOVER, ValidationError, is_defined_reserved_method, is_reserved_method_name,
    is_valid_method_name, validate,
};
pub use version::{Negotiation, PROTOCOL_VERSION, ProtocolVersion, negotiate};

/// Wire major version this crate speaks. Mirrors [`PROTOCOL_VERSION`].
pub const PROTOCOL_MAJOR: u16 = 1;
/// Highest wire minor version this crate speaks. Mirrors [`PROTOCOL_VERSION`].
pub const PROTOCOL_MINOR: u16 = 2;
/// The wire minor from which a responder writes every frame a handler asked
/// for ahead of that request's answer (spec §6.2). A feature minor, not the
/// current one: it stays `2` when later minors ship.
///
/// ```
/// use mango_protocol::ORDERED_ANSWER_MINOR;
///
/// let effective_minor = 2;
/// assert!(effective_minor >= ORDERED_ANSWER_MINOR);
/// ```
pub const ORDERED_ANSWER_MINOR: u16 = 2;

#[cfg(test)]
mod tests {
    use super::{PROTOCOL_MAJOR, PROTOCOL_MINOR, PROTOCOL_VERSION};

    #[test]
    fn speaks_wire_one_two() {
        assert_eq!(PROTOCOL_MAJOR, 1);
        assert_eq!(PROTOCOL_MINOR, 2);
    }

    #[test]
    fn the_constants_mirror_the_version_struct() {
        assert_eq!(u32::from(PROTOCOL_MAJOR), PROTOCOL_VERSION.major);
        assert_eq!(u32::from(PROTOCOL_MINOR), PROTOCOL_VERSION.minor);
    }
}
