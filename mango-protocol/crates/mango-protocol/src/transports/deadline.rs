//! The deadline every dialling transport connects under, and the one error
//! type they all fail with.
//!
//! An attempt nobody completes would otherwise stay in flight for as long as
//! the process lives: a listener whose accept queue no one drains, a named
//! pipe whose server stopped answering, an upgrade a proxy never finishes. A
//! [`ConnectDeadline`] bounds it with a timeout, a [`CancellationToken`], or
//! both, and whatever the attempt opened is dropped — and so closed — on
//! every path that abandons it.
//!
//! Mirrors `packages/protocol/src/transports/deadline.ts`, whose
//! `AbortSignal` and `timeoutMs` compose into the one signal an attempt has
//! to watch. Cancellation takes precedence over the timeout there and here: a
//! caller that has already given up is told so rather than made to wait out
//! a budget it no longer cares about.

use std::fmt;
use std::future::Future;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

/// The two ways a caller bounds a connection attempt.
///
/// The default bounds nothing: an attempt runs until the operating system
/// settles it.
///
/// # Example
///
/// ```
/// use std::time::Duration;
/// use mango_protocol::transports::deadline::ConnectDeadline;
///
/// let deadline = ConnectDeadline::default().with_timeout(Duration::from_secs(5));
/// assert_eq!(deadline.timeout, Some(Duration::from_secs(5)));
/// ```
#[derive(Debug, Clone, Default)]
pub struct ConnectDeadline {
    /// Abandons the attempt after this long; no deadline when absent.
    pub timeout: Option<Duration>,
    /// Abandons the attempt when this token is cancelled.
    pub cancel: Option<CancellationToken>,
}

impl ConnectDeadline {
    /// Bounds the attempt to `timeout`.
    ///
    /// # Example
    ///
    /// ```
    /// use std::time::Duration;
    /// use mango_protocol::transports::deadline::ConnectDeadline;
    ///
    /// let deadline = ConnectDeadline::default().with_timeout(Duration::from_millis(250));
    /// assert!(deadline.cancel.is_none());
    /// ```
    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// Lets `cancel` abandon the attempt.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::deadline::ConnectDeadline;
    /// use tokio_util::sync::CancellationToken;
    ///
    /// let token = CancellationToken::new();
    /// let deadline = ConnectDeadline::default().with_cancel(token.clone());
    /// token.cancel();
    /// assert!(deadline.cancel.is_some_and(|cancel| cancel.is_cancelled()));
    /// ```
    #[must_use]
    pub fn with_cancel(mut self, cancel: CancellationToken) -> Self {
        self.cancel = Some(cancel);
        self
    }
}

/// Why a connection attempt did not produce a port.
///
/// # Example
///
/// ```
/// use std::time::Duration;
/// use mango_protocol::transports::deadline::ConnectError;
///
/// let timed_out = ConnectError::TimedOut {
///     target: "/run/user/1000/mango-hub.sock".into(),
///     timeout: Duration::from_secs(5),
/// };
/// assert!(timed_out.to_string().contains("5s"));
/// ```
#[derive(Debug)]
#[non_exhaustive]
pub enum ConnectError {
    /// The caller cancelled the attempt.
    Cancelled {
        /// What was being dialled.
        target: String,
    },
    /// The deadline passed before the peer accepted.
    TimedOut {
        /// What was being dialled.
        target: String,
        /// The budget that was spent.
        timeout: Duration,
    },
    /// The operating system refused or lost the connection.
    Io(std::io::Error),
    /// The peer answered, but not as a Mango Protocol peer: an upgrade it
    /// refused, a subprotocol it would not select, a socket it closed before
    /// the session could start.
    Refused {
        /// What was being dialled.
        target: String,
        /// What the peer did instead, and what was expected.
        detail: String,
    },
}

impl fmt::Display for ConnectError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled { target } => {
                write!(formatter, "The connection to {target} was cancelled.")
            }
            Self::TimedOut { target, timeout } => write!(
                formatter,
                "The connection to {target} timed out after {timeout:?}; expected the peer to accept it."
            ),
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Refused { target, detail } => {
                write!(
                    formatter,
                    "The connection to {target} was refused: {detail}"
                )
            }
        }
    }
}

impl std::error::Error for ConnectError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<std::io::Error> for ConnectError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

/// Runs one connection attempt under `deadline`.
///
/// `attempt` is dropped, and with it whatever it had opened, the moment the
/// deadline abandons it. A token that is already cancelled settles before the
/// attempt is polled at all, so a caller that gave up first never opens a
/// socket it would immediately have to close.
///
/// # Example
///
/// ```
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// use std::time::Duration;
/// use mango_protocol::transports::deadline::{ConnectDeadline, ConnectError, connect_within};
///
/// let deadline = ConnectDeadline::default().with_timeout(Duration::from_millis(10));
/// let never = async {
///     std::future::pending::<()>().await;
///     Ok(())
/// };
/// let error = connect_within("example", &deadline, never)
///     .await
///     .expect_err("the deadline passes");
/// assert!(matches!(error, ConnectError::TimedOut { .. }));
/// # }
/// ```
///
/// # Errors
///
/// [`ConnectError::Cancelled`] when the token was cancelled,
/// [`ConnectError::TimedOut`] when the budget ran out, and whatever the
/// attempt itself failed with otherwise.
pub async fn connect_within<T, F>(
    target: &str,
    deadline: &ConnectDeadline,
    attempt: F,
) -> Result<T, ConnectError>
where
    F: Future<Output = Result<T, ConnectError>>,
{
    tokio::pin!(attempt);
    // `biased` polls cancellation first, so a caller that already gave up is
    // told that rather than that the budget ran out — the precedence the
    // TypeScript deadline gets by forwarding the caller's own abort reason.
    tokio::select! {
        biased;
        () = cancelled(deadline.cancel.as_ref()) => Err(ConnectError::Cancelled {
            target: target.to_owned(),
        }),
        () = elapsed(deadline.timeout) => Err(ConnectError::TimedOut {
            target: target.to_owned(),
            timeout: deadline.timeout.unwrap_or_default(),
        }),
        outcome = &mut attempt => outcome,
    }
}

/// Resolves when `cancel` is cancelled, or never when there is no token.
async fn cancelled(cancel: Option<&CancellationToken>) {
    match cancel {
        Some(cancel) => cancel.cancelled().await,
        None => std::future::pending().await,
    }
}

/// Resolves after `timeout`, or never when there is no deadline.
async fn elapsed(timeout: Option<Duration>) {
    match timeout {
        Some(timeout) => tokio::time::sleep(timeout).await,
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use super::{ConnectDeadline, ConnectError, connect_within};
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;

    /// A future that records whether anything ever polled it, so a test can
    /// prove an attempt was abandoned before it opened anything.
    struct NeverSettles<'a> {
        polled: &'a std::cell::Cell<bool>,
    }

    impl Future for NeverSettles<'_> {
        type Output = Result<(), ConnectError>;

        fn poll(
            self: std::pin::Pin<&mut Self>,
            _context: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Self::Output> {
            self.polled.set(true);
            std::task::Poll::Pending
        }
    }

    #[tokio::test]
    async fn an_attempt_that_settles_first_is_the_outcome() {
        let deadline = ConnectDeadline::default().with_timeout(Duration::from_secs(30));
        let connected = connect_within("example", &deadline, async { Ok(7) })
            .await
            .expect("the attempt settles inside the budget");
        assert_eq!(connected, 7);
    }

    #[tokio::test]
    async fn no_deadline_at_all_leaves_the_attempt_alone() {
        let connected = connect_within("example", &ConnectDeadline::default(), async { Ok(7) })
            .await
            .expect("an unbounded attempt still settles");
        assert_eq!(connected, 7);
    }

    #[tokio::test(start_paused = true)]
    async fn the_budget_running_out_names_the_target_and_the_budget() {
        let deadline = ConnectDeadline::default().with_timeout(Duration::from_secs(5));
        let error = connect_within(
            "hub.sock",
            &deadline,
            std::future::pending::<Result<(), ConnectError>>(),
        )
        .await
        .expect_err("the budget runs out");
        match error {
            ConnectError::TimedOut { target, timeout } => {
                assert_eq!(target, "hub.sock");
                assert_eq!(timeout, Duration::from_secs(5));
            }
            other => panic!("expected TimedOut, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_token_cancelled_mid_attempt_abandons_it() {
        let token = CancellationToken::new();
        let deadline = ConnectDeadline::default().with_cancel(token.clone());
        let attempt = async {
            token.cancel();
            std::future::pending::<Result<(), ConnectError>>().await
        };
        let error = connect_within("hub.sock", &deadline, attempt)
            .await
            .expect_err("the cancelled token abandons the attempt");
        assert!(matches!(error, ConnectError::Cancelled { .. }));
    }

    #[tokio::test]
    async fn a_token_cancelled_beforehand_settles_before_anything_is_opened() {
        let token = CancellationToken::new();
        token.cancel();
        let deadline = ConnectDeadline::default()
            .with_cancel(token)
            .with_timeout(Duration::from_secs(30));
        let polled = std::cell::Cell::new(false);

        let error = connect_within("hub.sock", &deadline, NeverSettles { polled: &polled })
            .await
            .expect_err("an attempt nobody wants any more is refused");

        assert!(matches!(error, ConnectError::Cancelled { .. }));
        assert!(!polled.get(), "the attempt was never polled");
    }

    #[tokio::test]
    async fn cancellation_wins_over_a_deadline_that_is_ready_at_the_same_moment() {
        let token = CancellationToken::new();
        token.cancel();
        // A budget of zero is ready on the first poll, exactly as the already
        // cancelled token is: the only thing that separates them is the
        // precedence this function promises.
        let deadline = ConnectDeadline::default()
            .with_cancel(token)
            .with_timeout(Duration::ZERO);

        let error = connect_within(
            "hub.sock",
            &deadline,
            std::future::pending::<Result<(), ConnectError>>(),
        )
        .await
        .expect_err("the attempt is abandoned");

        assert!(
            matches!(error, ConnectError::Cancelled { .. }),
            "the caller's own decision is what it is told about, got {error:?}"
        );
    }

    #[test]
    fn an_operating_system_error_keeps_its_own_message_and_source() {
        let error = ConnectError::from(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no such file or directory",
        ));
        assert_eq!(error.to_string(), "no such file or directory");
        assert!(std::error::Error::source(&error).is_some());
    }

    #[test]
    fn a_refusal_names_the_target_and_what_the_peer_did() {
        let error = ConnectError::Refused {
            target: "wss://hub.example/runtime".into(),
            detail: "selected subprotocol \"\"; expected \"mango.v1\"".into(),
        };
        let message = error.to_string();
        assert!(message.contains("wss://hub.example/runtime"), "{message}");
        assert!(message.contains("mango.v1"), "{message}");
    }
}
