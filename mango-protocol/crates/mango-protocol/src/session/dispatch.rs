//! Inbound request routing: the five refusal checks, spawning a handler onto
//! the driver's `JoinSet`, and turning what it produced into a wire frame.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use serde_json::Value;
use tokio::task::{Id, JoinError, JoinSet};
use tokio_util::sync::CancellationToken;

use crate::error::{RemoteError, codes};
use crate::frame::{ErrorPayload, ErrorResponse, Frame, Request, Response};
use crate::port::PortTx;
use crate::validate::{is_defined_reserved_method, is_reserved_method_name};

use super::driver::Writer;
use super::handle::{Session, SessionState};
use super::handler::CallContext;
use super::shared::{Shared, lock};

/// One request this session is currently answering.
pub(super) struct ActiveRequest {
    pub(super) cancel: CancellationToken,
    pub(super) method: String,
}

/// The task-output type every handler invocation produces.
pub(super) type HandlerOutcome = Result<Value, RemoteError>;

/// Bookkeeping for every inbound request this driver is currently answering:
/// the spawned handler tasks, the request each is answering (with its
/// cancellation token), and the task-id → request-id reverse lookup a
/// panic-safe settlement needs. Grouped into one type since every one of
/// these fields changes together, on exactly the same two events (a request
/// arrives, a handler settles).
#[derive(Default)]
pub(super) struct RequestTracking {
    pub(super) tasks: JoinSet<HandlerOutcome>,
    pub(super) active: HashMap<String, ActiveRequest>,
    pub(super) by_task_id: HashMap<Id, String>,
}

fn respond_error<Tx: PortTx>(writer: &Writer<Tx>, id: String, error: RemoteError) {
    writer.enqueue(Frame::Err(ErrorResponse {
        id,
        error: ErrorPayload {
            code: error.code,
            message: error.message,
            details: error.details,
        },
    }));
}

/// Routes one inbound `req` frame: the five refusal checks (not ready, past
/// the in-flight ceiling, a duplicate id, a reserved method, no handler), then
/// spawns the matched handler onto `tasks`.
pub(super) fn on_request<Tx: PortTx>(
    shared: &Arc<Shared>,
    tracking: &mut RequestTracking,
    writer: &Writer<Tx>,
    request: Request,
) {
    let Request { id, method, params } = request;

    // Ready and remote are set together (see driver::on_hello), so treating
    // a missing remote the same as "not ready yet" is exact, not a fallback
    // for a state that should be provably unreachable.
    let remote = {
        let guard = lock(&shared.inner);
        (guard.state == SessionState::Ready)
            .then(|| guard.remote.clone())
            .flatten()
    };
    let Some(remote) = remote else {
        respond_error(
            writer,
            id,
            RemoteError::new(
                codes::UNAVAILABLE,
                "The session handshake has not completed; requests are refused until both \
                 hellos have crossed.",
            ),
        );
        return;
    };
    if tracking.active.len() >= shared.max_in_flight {
        // Retryable, and the session stays open: the peer is not misbehaving,
        // it is ahead of what this side agreed to hold (§11.2).
        let limit = shared.max_in_flight;
        let message = format!(
            "This peer is already answering {limit} requests; retry \"{method}\" once one of \
             yours has settled."
        );
        respond_error(
            writer,
            id,
            RemoteError::new(codes::UNAVAILABLE, message)
                .with_detail("kind", super::options::IN_FLIGHT_LIMIT_KIND)
                .with_detail("limit", u64::try_from(limit).unwrap_or(u64::MAX))
                .with_detail("method", method),
        );
        return;
    }
    if tracking.active.contains_key(&id) {
        let message = format!(
            "Request id \"{id}\" is already in flight; expected an id unique among the \
             sender's pending requests."
        );
        respond_error(
            writer,
            id.clone(),
            RemoteError::new(codes::INVALID_REQUEST, message).with_detail("id", id),
        );
        return;
    }
    let effective_minor = remote.effective_minor;
    if is_reserved_method_name(&method) && !is_defined_reserved_method(&method, effective_minor) {
        let message = format!(
            "Method \"{method}\" is reserved; the rpc. segment belongs to the protocol and \
             defines no such method at wire minor {effective_minor}."
        );
        respond_error(
            writer,
            id,
            RemoteError::new(codes::INVALID_REQUEST, message)
                .with_detail("method", method)
                .with_detail("effectiveMinor", u64::from(effective_minor)),
        );
        return;
    }
    let handler = lock(&shared.handlers)
        .get(&method)
        .map(|(_, handler)| Arc::clone(handler));
    let Some(handler) = handler else {
        let message = format!("Method \"{method}\" has no handler on this peer.");
        respond_error(
            writer,
            id,
            RemoteError::new(codes::METHOD_UNSUPPORTED, message).with_detail("method", method),
        );
        return;
    };

    let cancel = CancellationToken::new();
    let context = CallContext {
        id: id.clone(),
        method: method.clone(),
        cancel: cancel.clone(),
        remote,
        session: Session {
            shared: Arc::clone(shared),
        },
    };
    shared.in_flight.fetch_add(1, Ordering::Relaxed);
    let abort_handle = tracking.tasks.spawn(handler.call(params, context));
    tracking.by_task_id.insert(abort_handle.id(), id.clone());
    tracking.active.insert(id, ActiveRequest { cancel, method });
}

/// A `cancel` frame for a request this side is (or was) answering: signals
/// the handler's token. A cancel for an id this side does not recognise (it
/// already settled, or never existed) is silently ignored, mirroring the
/// TypeScript SDK's optional-chained lookup.
pub(super) fn on_cancel(active: &HashMap<String, ActiveRequest>, id: &str) {
    if let Some(request) = active.get(id) {
        request.cancel.cancel();
    }
}

/// What one `JoinSet::join_next_with_id` produced: the settled handler's
/// result, or, on a panic, a message built from it. Turns that into a wire
/// frame and clears the request's bookkeeping.
pub(super) fn on_handler_settled<Tx: PortTx>(
    shared: &Shared,
    tracking: &mut RequestTracking,
    writer: &Writer<Tx>,
    settled: Result<(Id, HandlerOutcome), JoinError>,
) {
    let (task_id, outcome) = match settled {
        Ok((task_id, outcome)) => (task_id, outcome),
        Err(join_error) => {
            let task_id = join_error.id();
            let outcome = Err(RemoteError::new(codes::INTERNAL, panic_message(join_error)));
            (task_id, outcome)
        }
    };
    shared.in_flight.fetch_sub(1, Ordering::Relaxed);
    let Some(id) = tracking.by_task_id.remove(&task_id) else {
        return;
    };
    let Some(active_request) = tracking.active.remove(&id) else {
        return;
    };
    match outcome {
        Ok(value) => respond_result(shared, writer, &active_request.method, id, value),
        Err(error) => respond_error(writer, id, error),
    }
}

fn respond_result<Tx: PortTx>(
    shared: &Shared,
    writer: &Writer<Tx>,
    method: &str,
    id: String,
    value: Value,
) {
    let frame = Frame::Res(Response {
        id: id.clone(),
        result: value,
    });
    match shared.assert_fits(&frame, &format!("The result of \"{method}\"")) {
        Ok(()) => writer.enqueue(frame),
        Err(error) => respond_error(writer, id, error),
    }
}

/// The message a panicking handler's `JoinError` carries, downcast from
/// whatever panic payload it produced.
fn panic_message(join_error: JoinError) -> String {
    let Ok(payload) = join_error.try_into_panic() else {
        return "The handler task was aborted before it could settle.".to_string();
    };
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_string();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    "The handler panicked.".to_string()
}
