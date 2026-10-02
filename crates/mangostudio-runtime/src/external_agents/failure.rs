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
    /// Recognizes a deterministic start refusal with proven absence and no recovery obligation.
    /// Busy, uncertain dispatch, spent sessions and settled cleanup retain their own outcomes.
    ///
    /// ```ignore
    /// if failure.is_deterministic_start_refusal() { report_input_refusal(); }
    /// ```
    pub(crate) fn is_deterministic_start_refusal(&self) -> bool {
        matches!(
            self.cause,
            FailureCause::InvalidRequest | FailureCause::Unsupported
        ) && self.dispatch == Some(Dispatch::NotSubmitted)
            && self.session != SessionUsability::Spent
            && self.cleanup == CleanupOutcome::NotRequired
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A proven invalid input failure using independent product facts only.
    fn input_refusal() -> AgentFailure {
        AgentFailure {
            remote: Box::new(RemoteError::new(
                "INTERNAL",
                "Invalid empty input; expected text.",
            )),
            cause: FailureCause::InvalidRequest,
            context: FailureContext::Operation,
            retry: RetryAdvice::DoNotRetry,
            dispatch: Some(Dispatch::NotSubmitted),
            session: SessionUsability::Unknown,
            cleanup: CleanupOutcome::NotRequired,
            busy_refusal: false,
        }
    }

    #[test]
    fn deterministic_start_refusal_requires_every_independent_recovery_fact() {
        for cause in [
            FailureCause::Busy,
            FailureCause::Version,
            FailureCause::Authentication,
            FailureCause::Launch,
            FailureCause::Link,
            FailureCause::Closed,
            FailureCause::Protocol,
            FailureCause::Vendor,
            FailureCause::Timeout,
            FailureCause::Cancelled,
            FailureCause::Other,
        ] {
            let mut failure = input_refusal();
            failure.cause = cause;
            assert!(
                !failure.is_deterministic_start_refusal(),
                "{cause:?} is not an input refusal"
            );
        }
        for certainty in [
            None,
            Some(Dispatch::Accepted),
            Some(Dispatch::AcceptanceUnknown),
        ] {
            let mut failure = input_refusal();
            failure.dispatch = certainty;
            assert!(
                !failure.is_deterministic_start_refusal(),
                "{certainty:?} does not prove absence"
            );
        }
        let mut spent = input_refusal();
        spent.session = SessionUsability::Spent;
        assert!(!spent.is_deterministic_start_refusal());
        for cleanup in [CleanupOutcome::Settled, CleanupOutcome::Unconfirmed] {
            let mut failure = input_refusal();
            failure.cleanup = cleanup;
            assert!(
                !failure.is_deterministic_start_refusal(),
                "{cleanup:?} carried a cleanup obligation"
            );
        }
        for cause in [FailureCause::InvalidRequest, FailureCause::Unsupported] {
            for context in [
                FailureContext::Direct,
                FailureContext::Operation,
                FailureContext::Cleanup,
            ] {
                for retry in [RetryAdvice::Retryable, RetryAdvice::DoNotRetry] {
                    let mut failure = input_refusal();
                    failure.cause = cause;
                    failure.context = context;
                    failure.retry = retry;
                    assert!(failure.is_deterministic_start_refusal());
                }
            }
        }
    }
}
