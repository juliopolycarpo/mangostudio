//! What stops a running mutation at its next safe boundary.
//!
//! A mutation that has started is never abandoned mid-effect: the owner
//! (the blocking worker holding the backup root's lock) keeps running until
//! the boundary between two operations, then turns the interruption into
//! the same failure-and-compensation path an ordinary failure takes, so the
//! disk ends up matching what the result reports. `cancellation.ts` does
//! this for the hub's cancel; withdrawn consent is handled the same way,
//! locally, without depending on a further RPC.

/// Why the loop stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Interrupt {
    /// The request's cancellation token fired (a hub cancel or session loss).
    Cancelled,
    /// A capability the method needs is no longer granted.
    ConsentWithdrawn,
}

impl Interrupt {
    /// The failure message a result row carries. The cancellation text is
    /// `LibraryWriteCancelledError`'s, verbatim.
    pub(crate) const fn message(self) -> &'static str {
        match self {
            Self::Cancelled => "The library write was cancelled before this operation ran.",
            Self::ConsentWithdrawn => {
                "Library write consent was withdrawn before this operation ran."
            }
        }
    }
}
