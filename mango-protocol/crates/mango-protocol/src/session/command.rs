//! The internal command channel between a [`super::handle::Session`] handle
//! and its `SessionDriver`.
//!
//! Handler registration and event sequencing are not commands: both go
//! through [`super::shared::Shared`]'s own lock instead, since a handle needs
//! them to happen synchronously with respect to a concurrent dispatch.

use tokio::sync::oneshot;

use crate::error::RemoteError;
use crate::frame::Frame;
use serde_json::Value;

/// One request from a `Session` handle to its `SessionDriver`.
pub(super) enum Command {
    /// Ends the session with `code`/`reason`, from the vocabulary of the
    /// close-code table.
    Close { code: u16, reason: Option<String> },
    /// Sends an outbound `req` frame and remembers `reply`, so that when the
    /// matching `res`/`err` arrives, the driver can settle it.
    Request {
        frame: Frame,
        reply: oneshot::Sender<Result<Value, RemoteError>>,
    },
    /// Sends a `cancel` frame for `id`. `forget: true` on a user cancel (the
    /// pending entry stays, because that future is still awaiting its reply:
    /// cancel is advisory, so the peer's real `err CANCELLED` — or even a
    /// successful `res` — is what settles it). `forget: false` on a local
    /// timeout or a dropped request future: both have let go of the reply
    /// receiver, so the entry is deleted and a late answer silently ignored.
    Cancel { id: String, forget: bool },
    /// Hands a pre-built frame straight to the writer: a locally built event
    /// (already validated and sequenced under `Shared`'s own lock) or a
    /// manual `ping`.
    Send(Frame),
}
