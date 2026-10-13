//! Converts independent SDK failure facts and settles SDK cleanup handles at the boundary.
use super::super::failure::{
    AgentFailure, CleanupOutcome, FailureCause, FailureContext, RetryAdvice, SessionUsability,
};
use super::super::port::{AgentResult, Dispatch};
use super::map;
use mango_external_agents::{CancelReason, Error};
use std::time::Duration;

pub(super) fn dispatch(dispatch: mango_external_agents::Dispatch) -> Dispatch {
    match dispatch {
        mango_external_agents::Dispatch::NotSubmitted => Dispatch::NotSubmitted,
        mango_external_agents::Dispatch::Accepted => Dispatch::Accepted,
        _ => Dispatch::AcceptanceUnknown,
    }
}
fn observed_dispatch(error: &Error) -> Option<Dispatch> {
    match error {
        Error::Operation {
            dispatch: certainty,
            ..
        } => Some(dispatch(*certainty)),
        Error::CleanupRequired { source, .. } => observed_dispatch(source),
        _ => None,
    }
}
fn spent(error: &Error) -> bool {
    match error {
        Error::Cancelled { .. } | Error::Closed { .. } => true,
        Error::Operation { source, .. } | Error::CleanupRequired { source, .. } => spent(source),
        _ => false,
    }
}
pub(super) fn facts(error: Error) -> AgentFailure {
    let cause = match error.cause() {
        Error::Busy => FailureCause::Busy,
        Error::NotSupported { .. } => FailureCause::Unsupported,
        Error::UnsupportedTransport { .. }
        | Error::HostConfiguration { .. }
        | Error::LimitExceeded { .. } => FailureCause::InvalidRequest,
        Error::VersionGate { .. } => FailureCause::Version,
        Error::AuthRequired { .. } => FailureCause::Authentication,
        Error::Launch { .. } => FailureCause::Launch,
        Error::Link { .. } => FailureCause::Link,
        Error::Closed { .. } => FailureCause::Closed,
        Error::Protocol { .. } | Error::InvalidVendorValue { .. } => FailureCause::Protocol,
        Error::Vendor(_) => FailureCause::Vendor,
        Error::Timeout { .. } => FailureCause::Timeout,
        Error::Cancelled { .. } => FailureCause::Cancelled,
        _ => FailureCause::Other,
    };
    AgentFailure {
        remote: Box::new(map::remote_error(&error)),
        cause,
        context: match error {
            Error::Operation { .. } => FailureContext::Operation,
            Error::CleanupRequired { .. } => FailureContext::Cleanup,
            _ => FailureContext::Direct,
        },
        retry: if error.retryable() {
            RetryAdvice::Retryable
        } else {
            RetryAdvice::DoNotRetry
        },
        dispatch: observed_dispatch(&error),
        session: if spent(&error) {
            SessionUsability::Spent
        } else {
            SessionUsability::Unknown
        },
        cleanup: if error.cleanup_control().is_some() {
            CleanupOutcome::Unconfirmed
        } else {
            CleanupOutcome::NotRequired
        },
        cancelled_by_shutdown: matches!(
            error.cause(),
            Error::Cancelled {
                reason: CancelReason::Shutdown
            }
        ),
        busy_refusal: matches!(error, Error::Busy)
            || matches!(&error, Error::Operation { source, .. } if matches!(**source, Error::Busy)),
    }
}

/// How long the adapter's own kill and wait may take after a failed `close`, out of the
/// supervisor's `cleanup_timeout`.
///
/// The supervisor bounds a whole `close` at the SDK's worst case plus `cleanup_timeout`. A failed
/// `close` that used all of that worst case then spends this long settling its cleanup handle. If
/// this were the whole `cleanup_timeout`, both timers would end at the same instant and the
/// scheduler would pick which failure the caller sees: the adapter's, with the cause, or the
/// supervisor's "did not finish". Half leaves the other half as a strict margin for the scheduling
/// drift between the SDK's last timer and the start of the settle, so the adapter's failure always
/// wins.
///
/// ```ignore
/// let settled = settled(session.close(reason).await, close_settle_bound(cleanup_timeout)).await;
/// ```
pub(super) fn close_settle_bound(cleanup_timeout: Duration) -> Duration {
    cleanup_timeout / 2
}

/// Keeps the SDK error and its process lease until kill/wait settles or the bound expires.
/// The guarded launcher still owns an unconfirmed tree and reaps it on drop/shutdown.
pub(super) async fn settle(error: Error, timeout: Duration) -> AgentFailure {
    let mut settled = false;
    if let Some(control) = error.cleanup_control() {
        let reaped = tokio::time::timeout(timeout, async {
            control.kill(CancelReason::Shutdown).await?;
            control.wait().await.map(|_| ())
        })
        .await;
        settled = matches!(reaped, Ok(Ok(())));
    }
    let mut failure = facts(error);
    if settled {
        failure.cleanup = CleanupOutcome::Settled;
    }
    failure
}

/// Passes an SDK success through, settling any failure's cleanup handle first.
///
/// ```ignore
/// let page = settled(harness.list_sessions(&host, query).await, timeout).await?;
/// ```
pub(super) async fn settled<T>(result: Result<T, Error>, timeout: Duration) -> AgentResult<T> {
    match result {
        Ok(value) => Ok(value),
        Err(error) => Err(settle(error, timeout).await),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusal_facts_do_not_conflate_retry_dispatch_and_session_usability() {
        let invalid = facts(
            Error::HostConfiguration {
                expected: "a nonempty attachment",
                received: "empty".into(),
            }
            .with_dispatch(mango_external_agents::Dispatch::NotSubmitted),
        );
        assert_eq!(invalid.cause, FailureCause::InvalidRequest);
        assert_eq!(invalid.retry, RetryAdvice::DoNotRetry);
        assert_eq!(invalid.dispatch, Some(Dispatch::NotSubmitted));
        assert_eq!(invalid.session, SessionUsability::Unknown);
        assert_eq!(invalid.cleanup, CleanupOutcome::NotRequired);
        assert!(
            invalid.remote.message.contains("empty")
                && invalid.remote.message.contains("nonempty attachment")
        );
        let busy = facts(Error::Busy.with_dispatch(mango_external_agents::Dispatch::NotSubmitted));
        assert!(busy.busy_refusal);
        assert_eq!(busy.retry, RetryAdvice::Retryable);
        assert_eq!(busy.session, SessionUsability::Unknown);
        let closed = facts(
            Error::Closed { subject: "session" }
                .with_dispatch(mango_external_agents::Dispatch::NotSubmitted),
        );
        assert_eq!(closed.session, SessionUsability::Spent);
        assert_eq!(closed.cause, FailureCause::Closed);
        let unobserved = facts(Error::Busy);
        assert_eq!(unobserved.dispatch, None);
        assert_eq!(unobserved.dispatch(), Dispatch::AcceptanceUnknown);
    }

    #[tokio::test]
    async fn failure_without_a_cleanup_handle_remains_without_a_cleanup_obligation() {
        let error = settle(Error::Busy, Duration::from_millis(1)).await;
        assert_eq!(error.cleanup, CleanupOutcome::NotRequired);
        assert!(
            error
                .remote
                .details
                .as_ref()
                .is_some_and(|details| !details.contains_key("cleanupRequired"))
        );
    }
}
