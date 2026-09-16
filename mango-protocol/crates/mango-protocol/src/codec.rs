//! Framing: how whole frames are carved out of a transport's bytes.
//!
//! [`ndjson`] is the line framing of the stdio, local socket and spawn
//! transports. [`chunk`] is the binary message framing of the WebSocket
//! transport, which reuses an NDJSON line as its reassembled payload.

pub mod chunk;
pub mod limits;
pub mod ndjson;
