//! Independent failure facts for product recovery. Process cleanup stays inside the adapter.
use super::port::Dispatch;
use mango_protocol::error::RemoteError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FailureCause {
    Busy,
    Unsupported,
    InvalidRequest,
    Version,
    Authentication,
    Launch,
    Link,
    Closed,
    Protocol,
    Vendor,
    Timeout,
    Cancelled,
    Other,
}
/// Whether the cause arrived directly or carried separate operation/cleanup facts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FailureContext {
    Direct,
    Operation,
    Cleanup,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RetryAdvice {
    Retryable,
    DoNotRetry,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SessionUsability {
    Unknown,
    Spent,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CleanupOutcome {
    NotRequired,
    Settled,
    Unconfirmed,
}

/// Keeps recovery facts separate from the wire rendering of the failure.
#[derive(Debug)]
pub(crate) struct AgentFailure {
    pub remote: Box<RemoteError>,
    pub cause: FailureCause,
    pub context: FailureContext,
    #[allow(
        dead_code,
        reason = "retained independently for product recovery decisions"
    )]
    pub retry: RetryAdvice,
    pub dispatch: Option<Dispatch>,
    pub session: SessionUsability,
    pub cleanup: CleanupOutcome,
    /// Preserves the existing direct/operation-wrapped busy refusal behavior.
    pub busy_refusal: bool,
}
impl AgentFailure {
    /// Supplies the SDK's conservative default when no operation observed dispatch.
    ///
    /// ```ignore
    /// let replayable = failure.dispatch().is_safe_to_replay();
    /// ```
    pub(crate) fn dispatch(&self) -> Dispatch {
        self.dispatch.unwrap_or(Dispatch::AcceptanceUnknown)
    }
    /// Returns the established wire error after adapter cleanup has settled or been reported.
    ///
    /// ```ignore
    /// return Err(failure.into_remote());
    /// ```
    pub(crate) fn into_remote(self) -> RemoteError {
        let mut remote = *self.remote;
        match self.cleanup {
            CleanupOutcome::NotRequired => {}
            CleanupOutcome::Settled => {
                if let Some(details) = remote.details.as_mut() {
                    details.remove("cleanupRequired");
                }
                if remote
                    .details
                    .as_ref()
                    .is_some_and(serde_json::Map::is_empty)
                {
                    remote.details = None;
                }
            }
            CleanupOutcome::Unconfirmed => {
                remote = remote.with_detail("cleanup", "unconfirmed");
            }
        }
        remote
    }
}
impl std::fmt::Display for AgentFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.remote.message)
    }
}
