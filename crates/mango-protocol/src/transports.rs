//! The transports a [`crate::session::Session`] is opened over.
//!
//! Every module here produces a [`crate::port::Port`], and nothing below this
//! one knows which: the session's own loop is written against the trait. The
//! byte-oriented transports — stdio, the local socket, the spawn launcher —
//! share [`ndjson`], which owns the framing, the refusal handling and the
//! close sequence once, exactly as `packages/protocol/src/transports/
//! ndjson-port.ts` does for the TypeScript SDK.
//!
//! | Module | Carries frames over |
//! | --- | --- |
//! | [`ndjson`] | any pair of byte streams |
//! | [`stdio`] | standard input and standard output |
//! | [`ipc`] | a Unix domain socket, or a Windows named pipe |
//! | [`spawn`] | a child process's own standard streams |
//! | [`websocket`] | one WebSocket connection, dialled or accepted |
//!
//! [`deadline`] is not a transport but the bound every dialling one connects
//! under, and the one error type they all fail with; [`ssh`] is not one
//! either, but the argv that puts [`spawn`] on the far end of a network.

use std::time::Duration;

/// How long a closing port's farewell has to reach a peer before the port ends
/// anyway.
///
/// Every transport here has the same problem and gives it the same answer: the
/// write that carries a farewell is not bounded — a pipe whose peer stopped
/// reading holds it for as long as it likes, and so does a socket that is not
/// draining — while ending a port is not something a session may be held on.
/// The farewell is best effort, and this is how long "best" lasts.
pub(crate) const CLOSE_FLUSH_GRACE: Duration = Duration::from_secs(2);

pub mod deadline;
pub mod ipc;
pub mod ndjson;
#[cfg(feature = "spawn")]
pub mod spawn;
#[cfg(feature = "spawn")]
pub mod ssh;
pub mod stdio;
#[cfg(feature = "websocket")]
pub mod websocket;

pub use deadline::{ConnectDeadline, ConnectError};
