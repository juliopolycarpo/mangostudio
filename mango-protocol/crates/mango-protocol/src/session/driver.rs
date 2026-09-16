//! `SessionDriver::run` — the `select!` loop that drives one session.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::close::close_codes;
use crate::codec::ndjson::DEFAULT_MAX_FRAME_BYTES;
use crate::error::{RemoteError, codes};
use crate::frame::{Cancel, Frame, Hello, Limits};
use crate::port::{Inbound, PortClosure, PortRx, PortTx, SendOutcome};
use crate::session::DEFAULT_MAX_IN_FLIGHT;
use crate::version::{Negotiation, negotiate};

use super::command::Command;
use super::dispatch::{self, RequestTracking};
use super::handle::{RemotePeer, SessionState};
use super::shared::{Shared, lock};
use super::teardown::{self, SessionClosure, Teardown};

/// One outbound item handed to the [`Writer`] task.
enum Outbound {
    /// A frame to send over the port.
    Frame(Frame),
    /// Finish whatever is queued, then stop and hand the port back.
    Shutdown,
}

/// Owns a port's send half on a dedicated task, so a slow or blocking send
/// never stalls the driver's own `select!` loop.
pub(super) struct Writer<Tx> {
    sender: mpsc::UnboundedSender<Outbound>,
    task: JoinHandle<Tx>,
}

/// Resolves with the first send outcome that was not [`SendOutcome::Sent`],
/// or with `Err` if the writer task itself went away.
pub(super) type SendFailure = oneshot::Receiver<SendOutcome>;

impl<Tx: PortTx> Writer<Tx> {
    /// Spawns the writer task, which owns `tx` until [`Writer::shut_down`],
    /// and hands back the channel on which it reports a frame that never
    /// reached the peer.
    pub(super) fn spawn(mut tx: Tx) -> (Self, SendFailure) {
        let (sender, mut receiver) = mpsc::unbounded_channel::<Outbound>();
        let (report, failure) = oneshot::channel();
        let task = tokio::spawn(async move {
            // Only the first failure is reported: once one frame is lost the
            // driver tears the session down, and every later refusal on the
            // same dying transport says nothing new.
            let mut report = Some(report);
            while let Some(message) = receiver.recv().await {
                match message {
                    Outbound::Frame(frame) => {
                        let outcome = tx.send(frame).await;
                        if !matches!(outcome, SendOutcome::Sent)
                            && let Some(report) = report.take()
                        {
                            let _ = report.send(outcome);
                        }
                    }
                    Outbound::Shutdown => break,
                }
            }
            tx
        });
        (Self { sender, task }, failure)
    }

    /// Queues a frame; never blocks the caller.
    pub(super) fn enqueue(&self, frame: Frame) {
        let _ = self.sender.send(Outbound::Frame(frame));
    }

    /// Flushes whatever is queued, then returns the port's send half, or
    /// `None` if the writer task itself panicked (never expected: its body
    /// has no fallible operation besides an already-ignored send).
    pub(super) async fn shut_down(self) -> Option<Tx> {
        let _ = self.sender.send(Outbound::Shutdown);
        drop(self.sender);
        self.task.await.ok()
    }
}

/// An outbound request this session is waiting on a `res`/`err` for.
pub(super) struct PendingRequest {
    pub(super) method: String,
    pub(super) reply: oneshot::Sender<Result<Value, RemoteError>>,
}

/// Drives one session: owns the port, the command inbox, the outbound
/// requests awaiting an answer, and the inbound requests it is answering.
///
/// Built by [`super::Session::open`]; nothing progresses until this future is
/// polled, typically via [`super::Session::spawn`] or `tokio::spawn(driver.run())`.
pub struct SessionDriver<Tx, Rx> {
    pub(super) shared: Arc<Shared>,
    pub(super) tx: Tx,
    pub(super) rx: Rx,
    pub(super) commands: mpsc::UnboundedReceiver<Command>,
    pub(super) handshake_timeout: Duration,
    pub(super) pending: HashMap<String, PendingRequest>,
    pub(super) tracking: RequestTracking,
    /// `None` disables liveness (TS's `livenessIntervalMs: false`).
    pub(super) liveness_interval: Option<Duration>,
    /// Lazily built the moment the handshake completes, so the first tick is
    /// one full interval after becoming ready, never after construction.
    pub(super) liveness: Option<tokio::time::Interval>,
    /// Set on every ping this side sends, cleared on every pong it receives;
    /// still set when the next tick fires means the peer missed a round trip.
    pub(super) awaiting_pong: bool,
}

impl<Tx: PortTx, Rx: PortRx> SessionDriver<Tx, Rx> {
    /// Sends `hello`, negotiates the handshake, then answers frames and
    /// commands until something ends the session; tears it down and returns
    /// why.
    pub async fn run(mut self) -> SessionClosure {
        let hello = Frame::Hello(self.build_hello());
        // The hello takes the same preflight as every other outbound frame:
        // `PortTx::send` promises its implementors a frame that is already
        // valid and within the ceiling, and a port that trusts that promise —
        // a clone-mode `MemoryPort`, say — would otherwise put an invalid
        // `PeerInfo`, or an oversized capability object, straight on the wire.
        let refusal = match self.shared.assert_fits(&hello, "The hello") {
            Err(error) => Some(error),
            // The transport can also go away between construction and the
            // first send: a peer that refuses the credential closes the socket
            // the moment it opens.
            Ok(()) => refused_hello(self.tx.send(hello).await),
        };
        if let Some(error) = refusal {
            self.shared.settle_ready(Err(error));
            let (writer, _) = Writer::spawn(self.tx);
            return teardown::teardown(
                self.shared,
                self.pending,
                self.tracking,
                Teardown::Local {
                    code: close_codes::RELEASED,
                    reason: Some("hello could not be sent".into()),
                },
                writer,
            )
            .await;
        }

        let (writer, mut send_failed) = Writer::spawn(self.tx);
        let sleep = tokio::time::sleep(self.handshake_timeout);
        tokio::pin!(sleep);

        // self.tx has been moved into the writer, so the rest of this loop
        // only ever borrows individual fields (self.shared, self.rx, ...)
        // rather than `self` as a whole.
        let reason = loop {
            let state = lock(&self.shared.inner).state;
            if self.liveness.is_none()
                && state == SessionState::Ready
                && let Some(period) = self.liveness_interval
            {
                let mut interval =
                    tokio::time::interval_at(tokio::time::Instant::now() + period, period);
                // Coalesce a run of missed ticks (the driver task stalled past
                // a full period) into one, rather than firing back-to-back: a
                // burst would arm `awaiting_pong` on the first tick and see it
                // still armed on the second, closing on a healthy peer that
                // simply never had a chance to answer. JS `setInterval`
                // coalesces the same way, so TS has no such case to guard.
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                self.liveness = Some(interval);
            }
            // `biased` polls these in source order and stops at the first
            // ready branch, so the control plane comes first and inbound last.
            // The peer sets the inbound rate and a port may be unbounded, so
            // an inbound-first order lets a frame flood hold off everything
            // below it: `close()` would not land, a settled handler could not
            // send its `res` until the flood eased, and the handshake deadline
            // would never fire. Everything above inbound is either a timer or
            // bounded by work this side already accepted. The TypeScript SDK
            // has no equivalent coupling — its timers run off the event loop,
            // independent of `onFrame`.
            tokio::select! {
                biased;
                outcome = &mut send_failed => break on_send_failure(outcome),
                () = &mut sleep, if state == SessionState::Handshaking => {
                    break on_handshake_timeout(&self.shared, self.handshake_timeout);
                }
                () = liveness_tick(self.liveness.as_mut()) => {
                    if let Some(reason) = on_liveness_tick(&mut self.awaiting_pong, &writer) {
                        break reason;
                    }
                }
                Some(settled) = self.tracking.tasks.join_next_with_id(), if !self.tracking.tasks.is_empty() => {
                    dispatch::on_handler_settled(
                        &self.shared,
                        &mut self.tracking,
                        &writer,
                        settled,
                    );
                }
                Some(command) = self.commands.recv() => {
                    if let Some(reason) = on_command(command, &mut self.pending, &writer) {
                        break reason;
                    }
                }
                inbound = self.rx.recv() => match inbound {
                    Some(Inbound::Frame(frame)) => {
                        if let Some(reason) = on_frame(
                            &self.shared,
                            &mut self.tracking,
                            &mut self.pending,
                            &mut self.awaiting_pong,
                            &writer,
                            frame,
                        ) {
                            break reason;
                        }
                    }
                    Some(Inbound::Closed(closure)) => break Teardown::Port(closure),
                    None => break Teardown::Port(PortClosure::Closed { code: None, reason: None }),
                },
            }
        };

        teardown::teardown(self.shared, self.pending, self.tracking, reason, writer).await
    }

    fn build_hello(&self) -> Hello {
        Hello {
            protocol: self.shared.local_protocol,
            peer: self.shared.local_peer.clone(),
            capabilities: self.shared.local_capabilities.clone(),
            // Announced whole, never gated on the effective minor: nobody
            // knows it yet, and §4 has a 1.0 peer ignore what it cannot read.
            limits: Some(Limits {
                max_frame_bytes: (self.shared.local_max_frame_bytes < DEFAULT_MAX_FRAME_BYTES)
                    .then(|| self.shared.local_max_frame_bytes as u64),
                max_in_flight: (self.shared.max_in_flight != DEFAULT_MAX_IN_FLIGHT)
                    .then(|| self.shared.max_in_flight as u64),
            })
            .filter(|limits| limits != &Limits::default()),
        }
    }
}

/// The writer reported a frame that never reached the peer, so this session
/// can no longer keep its side of the protocol: a lost `res`/`err` breaks the
/// response guarantee the peer is waiting on, and a lost `req` would sit in
/// `pending` for ever whenever the receive half stays open and liveness is
/// off. Ending the session is what fails those pending calls.
///
/// The TypeScript SDK rejects the one caller instead, because its `port.send`
/// is synchronous and can report back inline. Rust's writer owns the send half
/// on its own task, so there is no caller left to reject by the time an
/// outcome is known — teardown is the nearest equivalent.
fn on_send_failure(outcome: Result<SendOutcome, oneshot::error::RecvError>) -> Teardown {
    let reason = match outcome {
        Ok(SendOutcome::Refused(error)) => format!("the transport refused a frame: {error}"),
        Ok(_) => "the transport is gone".to_string(),
        Err(_) => "the writer task ended".to_string(),
    };
    Teardown::Local {
        code: close_codes::RELEASED,
        reason: Some(reason),
    }
}

/// Why the hello never reached the peer, or `None` when it went out.
fn refused_hello(outcome: SendOutcome) -> Option<RemoteError> {
    let detail = match outcome {
        SendOutcome::Sent => return None,
        SendOutcome::Refused(error) => error.to_string(),
        _ => "the port is already closed".to_string(),
    };
    Some(RemoteError::new(
        codes::UNAVAILABLE,
        format!("The transport refused the hello: {detail}"),
    ))
}

/// Routes one inbound frame. `Some` breaks the main loop with that reason.
///
/// A free function, rather than a method, so it only ever borrows individual
/// fields: by the time the main loop runs, `SessionDriver::tx` has already
/// moved into the `Writer` task, and a `&self`-taking method would need every
/// field, `tx` included, to still be there.
fn on_frame<Tx: PortTx>(
    shared: &Arc<Shared>,
    tracking: &mut RequestTracking,
    pending: &mut HashMap<String, PendingRequest>,
    awaiting_pong: &mut bool,
    writer: &Writer<Tx>,
    frame: Frame,
) -> Option<Teardown> {
    match frame {
        Frame::Hello(hello) => on_hello(shared, hello),
        Frame::Close(close) => Some(Teardown::PeerFrame {
            code: close.code,
            reason: close.reason,
        }),
        Frame::Req(request) => {
            dispatch::on_request(shared, tracking, writer, request);
            None
        }
        Frame::Res(response) => {
            on_response(pending, response.id, Ok(response.result));
            None
        }
        Frame::Err(error_response) => {
            let mut error =
                RemoteError::new(error_response.error.code, error_response.error.message);
            if let Some(details) = error_response.error.details {
                error = error.with_details(details);
            }
            on_response(pending, error_response.id, Err(error));
            None
        }
        Frame::Evt(event) => {
            shared.fan_out_event(event);
            None
        }
        Frame::Cancel(cancel) => {
            dispatch::on_cancel(&tracking.active, &cancel.id);
            None
        }
        Frame::Ping => {
            writer.enqueue(Frame::Pong);
            None
        }
        Frame::Pong => {
            *awaiting_pong = false;
            shared.fan_out_pong();
            None
        }
    }
}

fn on_hello(shared: &Shared, hello: Hello) -> Option<Teardown> {
    if lock(&shared.inner).state != SessionState::Handshaking {
        return Some(Teardown::Local {
            code: close_codes::PROTOCOL_ERROR,
            reason: Some("duplicate hello".into()),
        });
    }
    match negotiate(shared.local_protocol, hello.protocol) {
        Negotiation::Mismatch { close_code } => {
            shared.settle_ready(Err(RemoteError::new(
                codes::PROTOCOL_MISMATCH,
                format!(
                    "Peer \"{}\" speaks wire major {}; this session speaks major {}.",
                    hello.peer.name, hello.protocol.major, shared.local_protocol.major
                ),
            )
            .with_detail("local_major", shared.local_protocol.major)
            .with_detail("remote_major", hello.protocol.major)
            .with_detail("close_code", close_code)));
            Some(Teardown::Local {
                code: close_code,
                reason: Some("protocol version unsupported".into()),
            })
        }
        Negotiation::Compatible { effective_minor } => {
            let remote = Arc::new(RemotePeer {
                peer: hello.peer,
                protocol: hello.protocol,
                capabilities: hello.capabilities,
                limits: hello.limits,
                effective_minor,
            });
            {
                let mut guard = lock(&shared.inner);
                guard.state = SessionState::Ready;
                guard.remote = Some(Arc::clone(&remote));
            }
            shared.settle_ready(Ok((*remote).clone()));
            None
        }
    }
}

/// Settles an outbound request's pending reply. A response for an id nobody
/// is waiting on (already settled, or never sent) is silently ignored.
fn on_response(
    pending: &mut HashMap<String, PendingRequest>,
    id: String,
    result: Result<Value, RemoteError>,
) {
    if let Some(request) = pending.remove(&id) {
        let _ = request.reply.send(result);
    }
}

fn on_command<Tx: PortTx>(
    command: Command,
    pending: &mut HashMap<String, PendingRequest>,
    writer: &Writer<Tx>,
) -> Option<Teardown> {
    match command {
        Command::Close { code, reason } => Some(Teardown::Local { code, reason }),
        Command::Request { frame, reply } => {
            if let Frame::Req(request) = &frame {
                pending.insert(
                    request.id.clone(),
                    PendingRequest {
                        method: request.method.clone(),
                        reply,
                    },
                );
            }
            writer.enqueue(frame);
            None
        }
        Command::Cancel { id, forget } => {
            if !forget {
                pending.remove(&id);
            }
            writer.enqueue(Frame::Cancel(Cancel { id }));
            None
        }
        Command::Send(frame) => {
            writer.enqueue(frame);
            None
        }
    }
}

/// Ticks `interval`, or never resolves if there is none (liveness disabled,
/// or not yet built — see [`SessionDriver::liveness`]).
async fn liveness_tick(interval: Option<&mut tokio::time::Interval>) {
    match interval {
        Some(interval) => {
            interval.tick().await;
        }
        None => std::future::pending().await,
    }
}

/// One liveness interval elapsed. Closes with a liveness timeout if the
/// previous ping never got a pong back — one missed round trip, since the
/// interval is already several times a healthy peer's round trip — otherwise
/// sends a fresh ping and arms the check for the next tick.
fn on_liveness_tick<Tx: PortTx>(awaiting_pong: &mut bool, writer: &Writer<Tx>) -> Option<Teardown> {
    if *awaiting_pong {
        return Some(Teardown::Local {
            code: close_codes::RELEASED,
            reason: Some("liveness timeout".into()),
        });
    }
    *awaiting_pong = true;
    writer.enqueue(Frame::Ping);
    None
}

fn on_handshake_timeout(shared: &Shared, handshake_timeout: Duration) -> Teardown {
    let millis = u64::try_from(handshake_timeout.as_millis()).unwrap_or(u64::MAX);
    shared.settle_ready(Err(RemoteError::new(
        codes::UNAVAILABLE,
        format!("The peer did not send hello within {millis}ms."),
    )
    .with_detail("timeout_ms", millis)));
    Teardown::Local {
        code: close_codes::PROTOCOL_ERROR,
        reason: Some(super::options::HANDSHAKE_TIMEOUT_REASON.into()),
    }
}
