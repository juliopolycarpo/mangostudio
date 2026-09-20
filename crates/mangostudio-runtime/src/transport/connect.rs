//! The `connect` transport: this runtime dials the hub, instead of waiting
//! to be dialled. Mirrors `connect.ts`.
//!
//! The WebSocket transport carries no reconnect of its own, so the backoff
//! lives here, and it reads the hub's close code before deciding whether to
//! redial at all — a revoked credential (`UNAUTHORIZED`), a wire mismatch
//! (`PROTOCOL_MISMATCH`), or a takeover by another connection
//! (`SUPERSEDED`) redialling cannot fix, so `classify_closure` marks all
//! three fatal, matching [`mango_protocol::session::SessionClosure::fatal`].
//! This loop is transport maintenance, not the hub's own execution-retry
//! policy: a call in flight when a dial drops is not replayed here, or
//! anywhere in this crate — it simply ends with its session, the same as any
//! other in-flight call when the transport goes away.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use mango_protocol::close::close_codes;
use mango_protocol::contract::Contract;
use mango_protocol::session::{Session, SessionClosure, SessionOptions};
use mango_protocol::transports::deadline::ConnectDeadline;
use mango_protocol::transports::websocket::client::{WebSocketConnectOptions, connect_websocket};
use mangostudio_runtime_contract::catalog::catalog;
use tokio_util::sync::CancellationToken;

use crate::runtime_home::RuntimeSlot;
use crate::supervisor::join_owned;
use crate::transport::{build_host, heartbeat_loop, runtime_peer};

/// Base of the jittered exponential backoff, doubling to [`RECONNECT_MAX_DELAY`].
pub const RECONNECT_BASE_DELAY: Duration = Duration::from_secs(1);
/// The backoff's ceiling, whatever the failure streak.
pub const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(60);
/// Where a rate-limited close restarts the wait from: the wall is real, and
/// worth waiting out on its own schedule rather than the failure-streak one.
pub const RATE_LIMITED_DELAY: Duration = Duration::from_secs(30);
/// Full jitter, so a rack of runtimes reconnecting does not arrive in step.
const JITTER_RATIO: f64 = 0.5;

/// Bounds the WebSocket upgrade itself. Matches
/// [`mango_protocol::session::DEFAULT_HANDSHAKE_TIMEOUT`] in value, used
/// twice over — once as the dial's own deadline, once (separately) as the
/// session's own `hello` timeout — mirroring `connect.ts`'s
/// `HANDSHAKE_TIMEOUT_MS`, which the same way bounds both `connectWebSocket`
/// and `createRuntimeSession`.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// The cadence this runtime tells the hub it is still here. Shared with
/// `serve`'s own heartbeat — see `crate::transport::serve::HEARTBEAT_INTERVAL`.
pub(crate) use crate::transport::serve::HEARTBEAT_INTERVAL;

/// Bounds how long one dial's own teardown (the heartbeat task, the
/// session's driver, the cancellation watcher, in that order) is awaited
/// once each has already been told to stop. `mango_protocol`'s own port
/// bounds its close-frame flush internally, but that is an internal
/// safety net, not a substitute for this transport naming its own outer
/// one — `serve`'s `SHUTDOWN_DRAIN_GRACE` makes exactly the same call for
/// the same reason, and connect had no counterpart to it at all: every
/// `join_owned` below used to be unconditional, so a peer holding a full
/// receive window at exactly the wrong layer had no bound backing it up.
const CONNECT_SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// [`join_owned`], but gives up after [`CONNECT_SHUTDOWN_GRACE`] rather than
/// waiting unconditionally — this dial's own teardown steps are still
/// awaited normally (never aborted) up to that bound; past it, the task is
/// simply left to the process's own exit (or, for a mid-loop teardown, the
/// next dial's fresh state) to reclaim, the same reasoning `cli.rs` applies
/// to a signal watcher whose cancellation no longer matters.
async fn join_owned_with_grace<T>(handle: tokio::task::JoinHandle<T>, log: &impl Fn(&str)) {
    if tokio::time::timeout(CONNECT_SHUTDOWN_GRACE, join_owned(handle))
        .await
        .is_err()
    {
        log("a teardown step outlived its shutdown grace and was left to finish on its own");
    }
}

/// A source of jitter for [`backoff_delay`], `0.0..=1.0`. A trait, not a
/// bare `rand::Rng`, since this crate takes no dependency on a random-number
/// crate: [`RandomJitter`] is a small, dependency-free source good enough
/// for decorrelating reconnect timing, and [`FixedJitter`] is the named test
/// fake standing in for it.
pub trait Jitter: Send + Sync {
    /// A value in `0.0..=1.0`.
    fn unit(&self) -> f64;
}

/// [`Jitter`] good enough to decorrelate a rack of runtimes reconnecting at
/// once: a fresh, OS-seeded [`std::collections::hash_map::RandomState`]
/// hashed with a monotonically increasing counter on every call. Not
/// cryptographic, and does not need to be — only backoff timing depends on
/// it.
#[derive(Default)]
pub struct RandomJitter {
    calls: AtomicU64,
}

impl Jitter for RandomJitter {
    fn unit(&self) -> f64 {
        use std::hash::BuildHasher;
        let call = self.calls.fetch_add(1, Ordering::Relaxed);
        let hashed = std::collections::hash_map::RandomState::new().hash_one(call);
        (hashed as f64) / (u64::MAX as f64)
    }
}

/// A fixed jitter value, for a deterministic test.
pub struct FixedJitter(pub f64);

impl Jitter for FixedJitter {
    fn unit(&self) -> f64 {
        self.0
    }
}

/// Full jitter: uniform over the upper half of each doubled window. Mirrors
/// `connect.ts`'s `backoffDelay` exactly, `jitter.unit()` standing in for
/// `Math.random()`.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::transport::connect::{
///     FixedJitter, RECONNECT_BASE_DELAY, RECONNECT_MAX_DELAY, backoff_delay,
/// };
///
/// // `unit() == 1.0` is the top of the "upper half" range this draws from,
/// // so it scales by exactly `1.0` — the raw doubling window, unclamped.
/// assert_eq!(backoff_delay(1, &FixedJitter(1.0)), RECONNECT_BASE_DELAY);
/// assert_eq!(backoff_delay(2, &FixedJitter(1.0)), RECONNECT_BASE_DELAY * 2);
/// // Capped at the ceiling, however high the failure streak climbs.
/// assert_eq!(backoff_delay(64, &FixedJitter(1.0)), RECONNECT_MAX_DELAY);
/// ```
#[must_use]
pub fn backoff_delay(failures: u32, jitter: &dyn Jitter) -> Duration {
    let exponent = failures.saturating_sub(1).min(31);
    let window_ms = u64::try_from(RECONNECT_BASE_DELAY.as_millis())
        .unwrap_or(u64::MAX)
        .saturating_mul(1u64 << exponent)
        .min(u64::try_from(RECONNECT_MAX_DELAY.as_millis()).unwrap_or(u64::MAX));
    let scaled = (window_ms as f64) * (1.0 - JITTER_RATIO + jitter.unit() * JITTER_RATIO);
    Duration::from_millis(scaled.round() as u64)
}

/// One [`run_one_connection`] outcome.
struct ConnectionAttempt {
    /// False when redialling cannot change the answer.
    retry: bool,
    /// True once the handshake completed before the connection ended.
    served: bool,
    close_code: Option<u16>,
    message: String,
}

/// Why [`run`] stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectOutcome {
    /// `cancel` fired.
    Stopped,
    /// The hub refused in a way redialling cannot change.
    Refused {
        /// What to tell the operator.
        message: String,
    },
}

/// What one `connect` invocation dials with. Bundled into one struct —
/// mirroring `connect.ts`'s own `RuntimeConnectOptions` — rather than
/// threaded through [`run`] and `run_one_connection` as five separate
/// arguments.
pub struct ConnectConfig {
    /// The hub's WebSocket URL.
    pub hub_url: String,
    /// The pairing token presented as the upgrade's bearer credential.
    pub token: String,
    /// Which `runtime.json` this dial's session is authorised against.
    pub slot: RuntimeSlot,
    /// `~/.mango` (or wherever `MANGO_HOME` points).
    pub mango_home: std::path::PathBuf,
    /// Announced in every `hello`.
    pub runtime_version: String,
}

/// Dials, serves, and redials until `cancel` fires or the hub refuses in a
/// way redialling cannot change.
pub async fn run(
    config: ConnectConfig,
    cancel: CancellationToken,
    jitter: &dyn Jitter,
    log: impl Fn(&str),
) -> ConnectOutcome {
    let mut failures: u32 = 0;
    loop {
        if cancel.is_cancelled() {
            return ConnectOutcome::Stopped;
        }
        let attempt = run_one_connection(&config, &cancel, &log).await;
        if !attempt.retry {
            return ConnectOutcome::Refused {
                message: attempt.message,
            };
        }
        if cancel.is_cancelled() {
            return ConnectOutcome::Stopped;
        }

        // A connection that actually served starts the backoff over:
        // whatever went wrong the last few times, this machine has just
        // proved it can reach the hub and be accepted.
        failures = if attempt.served { 1 } else { failures + 1 };
        let delay = if attempt.close_code == Some(close_codes::RATE_LIMITED) {
            RATE_LIMITED_DELAY
        } else {
            backoff_delay(failures, jitter)
        };
        log(&format!(
            "{} Reconnecting in {}s.",
            attempt.message,
            delay.as_secs()
        ));
        tokio::select! {
            biased;
            () = cancel.cancelled() => {}
            () = tokio::time::sleep(delay) => {}
        }
    }
}

/// One dial, from opening the socket to releasing everything it built —
/// unconditionally, on every path out of this function, mirroring
/// `connect.ts`'s `finally`: `session.close_now` then a full driver join
/// happens whether the hub closed the connection, the handshake failed, or
/// `cancel` fired while this was waiting.
async fn run_one_connection(
    config: &ConnectConfig,
    cancel: &CancellationToken,
    log: &impl Fn(&str),
) -> ConnectionAttempt {
    let dial_deadline = ConnectDeadline::default()
        .with_timeout(HANDSHAKE_TIMEOUT)
        .with_cancel(cancel.clone());
    let connect_options = WebSocketConnectOptions::default().with_bearer(&config.token);
    let port = match connect_websocket(&config.hub_url, &connect_options, &dial_deadline).await {
        Ok(port) => port,
        Err(error) => {
            return ConnectionAttempt {
                retry: true,
                served: false,
                close_code: None,
                message: format!("Could not reach the hub: {error}"),
            };
        }
    };

    let host = build_host(config.slot, &config.mango_home);
    let contract = Contract::from_catalog(catalog().clone())
        .expect("the embedded catalog compiles into a contract");
    let options = SessionOptions::new(runtime_peer(&config.runtime_version))
        .with_handshake_timeout(HANDSHAKE_TIMEOUT);
    let (session, driver_handle) = Session::spawn(port, options);
    let guard = crate::serve::serve(
        &contract,
        &session,
        host.registry,
        host.authorization,
        config.slot.as_str(),
    )
    .expect("an empty registry always matches the embedded catalog");
    guard.persist();

    // Owns exactly one job: if `cancel` fires while the connection below is
    // still being awaited, close it. Terminates on its own the moment
    // either that happens or the session ends on its own — never aborted.
    let watcher = {
        let watched = session.clone();
        let watch_cancel = cancel.clone();
        tokio::spawn(async move {
            tokio::select! {
                () = watch_cancel.cancelled() => {
                    watched.close_now(close_codes::RELEASED, Some("Runtime stopping"));
                }
                _closure = watched.closed() => {}
            }
        })
    };

    let attempt = match session.ready().await {
        Err(error) => {
            // A hub that refuses mid-handshake — a disabled environment
            // discovered after the upgrade, a protocol version it will not
            // serve — says so by closing, and that close code is the
            // better answer than the local handshake error, which is only
            // the symptom of it arriving mid-hello. `closed()` (not
            // `closure()`) because teardown may not have published the
            // closure yet at the instant `ready()` failed.
            let closure = session.closed().await;
            let base = classify_closure(Some(&closure), false);
            if base.retry {
                ConnectionAttempt {
                    message: format!("Protocol handshake failed: {error}"),
                    ..base
                }
            } else {
                base
            }
        }
        Ok(_) => {
            let heartbeat_cancel = CancellationToken::new();
            let heartbeat = tokio::spawn(heartbeat_loop(
                session.clone(),
                HEARTBEAT_INTERVAL,
                heartbeat_cancel.clone(),
            ));
            log(&format!("Connected to {}.", config.hub_url));
            let closure = session.closed().await;
            heartbeat_cancel.cancel();
            join_owned_with_grace(heartbeat, log).await;
            classify_closure(Some(&closure), true)
        }
    };

    session.close_now(close_codes::RELEASED, Some("Runtime stopping"));
    join_owned_with_grace(driver_handle, log).await;
    join_owned_with_grace(watcher, log).await;
    attempt
}

/// Reads a closure into a retry decision. Mirrors `connect.ts`'s
/// `classifyClosure` exactly, `closure.fatal` standing in for its
/// `isFatalCloseCode(closure.code)` check — the two are the same table,
/// this crate's own [`SessionClosure::fatal`] having already computed it.
fn classify_closure(closure: Option<&SessionClosure>, served: bool) -> ConnectionAttempt {
    let Some(closure) = closure else {
        return ConnectionAttempt {
            retry: true,
            served,
            close_code: None,
            message: "The connection to the hub ended without a reason.".to_string(),
        };
    };
    let detail = closure
        .reason
        .as_deref()
        .map(|reason| format!(" ({reason})"))
        .unwrap_or_default();
    if closure.fatal {
        return ConnectionAttempt {
            retry: false,
            served,
            close_code: Some(closure.code),
            message: fatal_closure_message(closure.code, &detail),
        };
    }
    if closure.code == close_codes::RATE_LIMITED {
        return ConnectionAttempt {
            retry: true,
            served,
            close_code: Some(closure.code),
            message: "The hub is rate limiting connections from this address.".to_string(),
        };
    }
    ConnectionAttempt {
        retry: true,
        served,
        close_code: Some(closure.code),
        message: format!(
            "Connection to the hub ended ({}{}).",
            closure.code,
            closure
                .reason
                .as_deref()
                .map(|reason| format!(": {reason}"))
                .unwrap_or_default()
        ),
    }
}

/// What to tell the operator about a close that redialling cannot fix. Each
/// one names the single thing that would change the answer — mirrors
/// `connect.ts`'s `fatalClosureMessage`.
fn fatal_closure_message(code: u16, detail: &str) -> String {
    match code {
        close_codes::UNAUTHORIZED => format!(
            "The hub refused this runtime's pairing token{detail}. Issue a new one from the \
             environment card and run \"connect\" again with it."
        ),
        close_codes::PROTOCOL_MISMATCH => format!(
            "The hub speaks a runtime protocol this binary does not{detail}. Update the runtime \
             on this machine, then run \"connect\" again."
        ),
        close_codes::SUPERSEDED => format!(
            "Another runtime took over this environment{detail}. Two machines are sharing one \
             pairing token — stop the one that should not have it, or issue a separate token, \
             then run \"connect\" again."
        ),
        _ => format!(
            "The hub refused this environment{detail}. Enable it in MangoStudio, then run \"connect\" again."
        ),
    }
}

#[cfg(test)]
mod tests {
    use mango_protocol::close::close_codes;
    use mango_protocol::frame::PeerInfo;
    use mango_protocol::port::port_pair;
    use mango_protocol::session::{Session, SessionOptions};

    use super::{
        FixedJitter, Jitter, RandomJitter, backoff_delay, classify_closure, fatal_closure_message,
    };
    use crate::transport::connect::{RECONNECT_BASE_DELAY, RECONNECT_MAX_DELAY};

    fn peer() -> PeerInfo {
        PeerInfo {
            name: "test".into(),
            version: "0.0.0".into(),
            role: "runtime".into(),
        }
    }

    #[test]
    fn backoff_doubles_at_full_jitter_until_the_ceiling() {
        // `unit() == 1.0` scales by exactly `1.0` (the top of the "upper
        // half" range `backoff_delay` draws from), so this is the doubling
        // window itself, unclamped by jitter.
        assert_eq!(backoff_delay(1, &FixedJitter(1.0)), RECONNECT_BASE_DELAY);
        assert_eq!(
            backoff_delay(2, &FixedJitter(1.0)),
            RECONNECT_BASE_DELAY * 2
        );
        assert_eq!(
            backoff_delay(3, &FixedJitter(1.0)),
            RECONNECT_BASE_DELAY * 4
        );
        assert_eq!(backoff_delay(64, &FixedJitter(1.0)), RECONNECT_MAX_DELAY);
    }

    #[test]
    fn full_jitter_stays_within_the_upper_half_of_the_window() {
        let window = RECONNECT_BASE_DELAY * 4; // failures = 3
        let lower = backoff_delay(3, &FixedJitter(0.0));
        let upper = backoff_delay(3, &FixedJitter(1.0));
        assert_eq!(lower, window / 2);
        assert_eq!(upper, window);
    }

    #[test]
    fn a_failure_count_of_zero_behaves_like_one() {
        // `failures.saturating_sub(1)` on `0` must not panic or invert the
        // exponent; the TS source clamps the same way with `Math.max(0, …)`.
        assert_eq!(backoff_delay(0, &FixedJitter(1.0)), RECONNECT_BASE_DELAY);
    }

    #[test]
    fn random_jitter_stays_in_range_and_varies_across_calls() {
        let jitter = RandomJitter::default();
        let first = jitter.unit();
        let second = jitter.unit();
        for value in [first, second] {
            assert!((0.0..=1.0).contains(&value), "{value} out of range");
        }
        assert_ne!(first, second, "two calls must not repeat the same value");
    }

    #[test]
    fn no_closure_at_all_is_retryable() {
        let attempt = classify_closure(None, false);
        assert!(attempt.retry);
        assert!(!attempt.served);
    }

    #[tokio::test]
    async fn a_fatal_close_code_refuses_and_names_the_remediation() {
        let (a, _b) = port_pair();
        let (session, _driver) = Session::spawn(a, SessionOptions::new(peer()));
        let closure = session
            .close(close_codes::UNAUTHORIZED, Some("token revoked"))
            .await;
        let attempt = classify_closure(Some(&closure), false);
        assert!(
            !attempt.retry,
            "UNAUTHORIZED must never be retried automatically"
        );
        assert!(attempt.message.contains("pairing token"));
    }

    #[tokio::test]
    async fn a_superseded_close_refuses_rather_than_trading_the_environment_back_and_forth() {
        let (a, _b) = port_pair();
        let (session, _driver) = Session::spawn(a, SessionOptions::new(peer()));
        let closure = session.close(close_codes::SUPERSEDED, None).await;
        let attempt = classify_closure(Some(&closure), true);
        assert!(!attempt.retry);
        assert!(attempt.message.contains("Another runtime took over"));
    }

    #[tokio::test]
    async fn a_rate_limited_close_retries_with_its_own_reason() {
        let (a, _b) = port_pair();
        let (session, _driver) = Session::spawn(a, SessionOptions::new(peer()));
        let closure = session.close(close_codes::RATE_LIMITED, None).await;
        let attempt = classify_closure(Some(&closure), false);
        assert!(attempt.retry);
        assert_eq!(attempt.close_code, Some(close_codes::RATE_LIMITED));
        assert!(attempt.message.contains("rate limiting"));
    }

    #[tokio::test]
    async fn an_ordinary_release_retries_and_names_the_code() {
        let (a, _b) = port_pair();
        let (session, _driver) = Session::spawn(a, SessionOptions::new(peer()));
        let closure = session
            .close(close_codes::RELEASED, Some("Runtime stopping"))
            .await;
        let attempt = classify_closure(Some(&closure), true);
        assert!(attempt.retry);
        assert!(attempt.message.contains("4000"));
    }

    #[test]
    fn every_fatal_code_names_a_distinct_remediation() {
        let unauthorized = fatal_closure_message(close_codes::UNAUTHORIZED, "");
        let mismatch = fatal_closure_message(close_codes::PROTOCOL_MISMATCH, "");
        let superseded = fatal_closure_message(close_codes::SUPERSEDED, "");
        assert!(unauthorized.contains("pairing token"));
        assert!(mismatch.contains("Update the runtime"));
        assert!(superseded.contains("Two machines are sharing"));
        assert_ne!(unauthorized, mismatch);
        assert_ne!(mismatch, superseded);
    }
}
