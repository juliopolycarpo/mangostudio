//! Catching a panic inside a guard's or a handler's own future before it
//! reaches `mango_protocol`'s session dispatcher.
//!
//! `mango_protocol::session::dispatch` already isolates a panicking handler
//! at the session level — the handler runs inside a `tokio::task::JoinSet`,
//! so one panicking call cannot take the session down — but the panic
//! payload it recovers is put on the wire **verbatim and unredacted** as the
//! `INTERNAL` message. A panic string can carry a file's contents, a token,
//! or an absolute path, so this runtime must never rely on that recovery: it
//! has to stop the panic from reaching the dispatcher at all.
//!
//! `mango_protocol::contract::serve`'s per-request pipeline
//! (`check_params` → `Guard::check` → the registered handler → an optional
//! result check) is one future assembled from private, unexported pieces —
//! there is no seam to wrap it as a whole. This module's [`catch_panics`] is
//! applied twice instead: once inside every [`crate::ports::authorization`]
//! guard adapter's `check`, and once inside every closure
//! [`crate::registry::Registry`] registers on
//! [`mango_protocol::contract::ContractHandlers`]. Together the two catch
//! points cover the whole pipeline a request runs through.

use std::any::Any;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::task::{Context, Poll};

use mango_protocol::error::{RemoteError, codes};

/// What a caller sees instead of a panic's own message: bounded, and never
/// derived from the panic payload. A panic can originate inside a future
/// handling a file's contents, a shell command's output, or a credential —
/// reflecting any fragment of it back onto the wire is the leak this
/// constant exists to refuse.
const REDACTED_PANIC_MESSAGE: &str = "An internal error occurred while handling this request.";

/// Wraps `future` so a panic inside it resolves as `Poll::Ready` carrying the
/// panic payload, instead of unwinding into whatever polled this future.
///
/// The wrapped future is boxed and pinned on the heap so this type can stay
/// `Unpin` regardless of `F`, which is what lets [`CatchPanic::poll`] call
/// [`std::pin::Pin::get_mut`] safely — no `unsafe` needed to project the
/// pinned field.
struct CatchPanic<F: Future> {
    inner: Pin<Box<F>>,
}

impl<F: Future> Future for CatchPanic<F> {
    type Output = Result<F::Output, Box<dyn Any + Send + 'static>>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let inner = &mut this.inner;
        match std::panic::catch_unwind(AssertUnwindSafe(|| inner.as_mut().poll(cx))) {
            Ok(Poll::Ready(output)) => Poll::Ready(Ok(output)),
            Ok(Poll::Pending) => Poll::Pending,
            Err(payload) => Poll::Ready(Err(payload)),
        }
    }
}

/// Runs `future` to completion, converting a panic anywhere inside it into a
/// bounded, redacted `INTERNAL` [`RemoteError`] instead of letting it unwind.
///
/// `future` itself must already resolve to `Result<T, RemoteError>` — this
/// does not change the success or ordinary-error shape of `future`'s output,
/// it only adds a third, panic-shaped failure mode that collapses onto the
/// same `RemoteError` type.
///
/// # Example
///
/// ```
/// use mango_protocol::error::{RemoteError, codes};
/// use mangostudio_runtime::panic::catch_panics;
///
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// let ok: Result<u32, RemoteError> = catch_panics(async { Ok(1) }).await;
/// assert_eq!(ok, Ok(1));
///
/// let caught: Result<u32, RemoteError> =
///     catch_panics(async { panic!("leaks a secret token") }).await;
/// let error = caught.expect_err("a panic becomes an error");
/// assert_eq!(error.code, codes::INTERNAL);
/// assert!(!error.message.contains("secret token"));
/// # }
/// ```
pub async fn catch_panics<T, F>(future: F) -> Result<T, RemoteError>
where
    F: Future<Output = Result<T, RemoteError>>,
{
    let caught = CatchPanic {
        inner: Box::pin(future),
    }
    .await;
    match caught {
        Ok(result) => result,
        Err(_payload) => Err(RemoteError::new(codes::INTERNAL, REDACTED_PANIC_MESSAGE)),
    }
}

#[cfg(test)]
mod tests {
    use mango_protocol::error::{RemoteError, codes};

    use super::catch_panics;

    #[tokio::test]
    async fn a_successful_future_passes_through_unchanged() {
        let result: Result<u32, RemoteError> = catch_panics(async { Ok(42) }).await;
        assert_eq!(result, Ok(42));
    }

    #[tokio::test]
    async fn an_ordinary_error_passes_through_unchanged() {
        let result: Result<u32, RemoteError> =
            catch_panics(async { Err(RemoteError::new(codes::DENIED, "no")) }).await;
        assert_eq!(result, Err(RemoteError::new(codes::DENIED, "no")));
    }

    #[tokio::test]
    async fn a_panic_becomes_a_redacted_internal_error() {
        let result: Result<u32, RemoteError> =
            catch_panics(async { panic!("the file contained /etc/shadow and sk-secret-token") })
                .await;
        let error = result.expect_err("a panic becomes an error, not a propagated unwind");
        assert_eq!(error.code, codes::INTERNAL);
        assert!(!error.message.contains("/etc/shadow"));
        assert!(!error.message.contains("sk-secret-token"));
    }

    #[tokio::test]
    async fn a_panic_after_the_future_has_already_yielded_once_is_still_caught() {
        let result: Result<u32, RemoteError> = catch_panics(async {
            tokio::task::yield_now().await;
            panic!("panicked on the second poll");
        })
        .await;
        assert_eq!(
            result.expect_err("still caught after Pending").code,
            codes::INTERNAL
        );
    }
}
