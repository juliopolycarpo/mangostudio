//! Bounded terminal scrollback and credit-gated output.
//!
//! The PTY reader calls [`TerminalFlow::on_data`] with raw bytes. A viewer must
//! attach before any output event is sent. Every emitted data byte consumes
//! credit until [`TerminalFlow::ack`] restores it.

use std::collections::VecDeque;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};

/// Maximum raw bytes in one terminal output event.
pub const CHUNK_MAX_BYTES: usize = 8 * 1024;
/// Maximum unacknowledged bytes sent to a viewer.
pub const INFLIGHT_WINDOW_BYTES: usize = 256 * 1024;
/// Maximum bytes retained for a slow viewer.
pub const PENDING_MAX_BYTES: usize = 1024 * 1024;
/// Maximum scrollback bytes retained for a reconnecting viewer.
pub const SCROLLBACK_MAX_BYTES: usize = 256 * 1024;

/// A terminal output payload and the protocol stream-end flag.
#[derive(Debug, Clone, PartialEq)]
pub struct OutputFrame {
    /// Payload validated against the catalog before publication.
    pub payload: Value,
    /// Only the final exit frame ends the stream.
    pub end: bool,
}

impl OutputFrame {
    fn data(bytes: &[u8]) -> Self {
        Self {
            payload: json!({ "kind": "data", "data": STANDARD.encode(bytes) }),
            end: false,
        }
    }

    fn dropped(bytes: usize) -> Self {
        Self {
            payload: json!({ "kind": "dropped", "bytes": bytes }),
            end: false,
        }
    }

    fn exit(exit_code: Option<i32>, signal: Option<&str>, consent_revoked: bool) -> Self {
        let mut payload = json!({ "kind": "exit", "exitCode": exit_code, "signal": signal });
        if consent_revoked {
            payload["reason"] = json!("consent-revoked");
        }
        Self { payload, end: true }
    }
}

/// A bounded byte queue that discards oldest bytes when full.
#[derive(Debug)]
pub struct ByteRing {
    bytes: VecDeque<u8>,
    capacity: usize,
    dropped: usize,
}

impl ByteRing {
    /// Creates a queue with a positive byte capacity.
    ///
    /// # Example
    ///
    /// ```
    /// use mangostudio_runtime::terminal::flow::ByteRing;
    /// let mut ring = ByteRing::new(2).unwrap();
    /// ring.push(b"abc");
    /// assert_eq!(ring.snapshot(), b"bc");
    /// ```
    pub fn new(capacity: usize) -> Result<Self, String> {
        if capacity == 0 {
            return Err(format!(
                "ByteRing capacity {capacity} is invalid; expected a positive byte count."
            ));
        }
        Ok(Self {
            bytes: VecDeque::new(),
            capacity,
            dropped: 0,
        })
    }

    /// Appends bytes and counts those displaced from the front.
    pub fn push(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        if bytes.len() >= self.capacity {
            self.dropped = self
                .dropped
                .saturating_add(self.bytes.len() + bytes.len() - self.capacity);
            self.bytes.clear();
            self.bytes
                .extend(bytes[bytes.len() - self.capacity..].iter().copied());
            return;
        }
        let excess = self
            .bytes
            .len()
            .saturating_add(bytes.len())
            .saturating_sub(self.capacity);
        self.bytes.drain(..excess);
        self.dropped = self.dropped.saturating_add(excess);
        self.bytes.extend(bytes.iter().copied());
    }

    /// Removes up to `max_bytes` from the front.
    pub fn take(&mut self, max_bytes: usize) -> Vec<u8> {
        self.bytes
            .drain(..max_bytes.min(self.bytes.len()))
            .collect()
    }

    /// Copies the retained bytes without consuming them.
    #[must_use]
    pub fn snapshot(&self) -> Vec<u8> {
        self.bytes.iter().copied().collect()
    }

    /// Returns the retained byte count.
    #[must_use]
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    /// Returns whether no bytes are retained.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// Takes the bytes displaced since the previous call.
    pub fn take_dropped(&mut self) -> usize {
        std::mem::take(&mut self.dropped)
    }

    /// Clears retained bytes and any pending drop count.
    pub fn clear(&mut self) {
        self.bytes.clear();
        self.dropped = 0;
    }
}

/// Native child exit reported by the PTY port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitInfo {
    /// Direct-child exit code, if the platform reported one.
    pub exit_code: Option<i32>,
    /// Native signal name, if the child exited by signal.
    pub signal: Option<String>,
}

/// Status and replay returned by `terminal.attach`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachState {
    /// Last retained output bytes, charged against the new viewer's window.
    pub scrollback: Vec<u8>,
    /// Whether the shell has exited.
    pub exited: bool,
    /// Native exit information, when available.
    pub exit: Option<ExitInfo>,
}

/// One terminal's scrollback, pending output, and viewer credit.
pub struct TerminalFlow {
    scrollback: ByteRing,
    pending: ByteRing,
    inflight: usize,
    attached: bool,
    exit: Option<ExitInfo>,
}

impl TerminalFlow {
    /// Creates bounded flow state; `scrollback_bytes` is clamped to the wire ceiling.
    ///
    /// # Example
    ///
    /// ```
    /// use mangostudio_runtime::terminal::flow::TerminalFlow;
    /// let mut flow = TerminalFlow::new(128).unwrap();
    /// flow.on_data(b"hello", &mut |_| true);
    /// assert_eq!(flow.attach().scrollback, b"hello");
    /// ```
    pub fn new(scrollback_bytes: usize) -> Result<Self, String> {
        Ok(Self {
            scrollback: ByteRing::new(scrollback_bytes.min(SCROLLBACK_MAX_BYTES))?,
            pending: ByteRing::new(PENDING_MAX_BYTES)?,
            inflight: 0,
            attached: false,
            exit: None,
        })
    }

    /// Replays the retained tail and charges it to a fresh viewer's window.
    pub fn attach(&mut self) -> AttachState {
        self.pending.clear();
        self.attached = true;
        let scrollback = self.scrollback.snapshot();
        self.inflight = scrollback.len();
        AttachState {
            scrollback,
            exited: self.exit.is_some(),
            exit: self.exit.clone(),
        }
    }

    /// Removes the viewer without closing the shell.
    pub fn detach(&mut self) {
        self.attached = false;
        self.pending.clear();
    }

    /// Retains PTY bytes and emits only what the viewer's credit permits.
    pub fn on_data(&mut self, bytes: &[u8], emit: &mut impl FnMut(OutputFrame) -> bool) {
        self.scrollback.push(bytes);
        if self.exit.is_some() || !self.attached {
            return;
        }
        self.pending.push(bytes);
        self.drain(emit);
    }

    /// Restores consumed byte credit and resumes pending output.
    pub fn ack(&mut self, bytes: usize, emit: &mut impl FnMut(OutputFrame) -> bool) {
        self.inflight = self.inflight.saturating_sub(bytes);
        if self.attached && self.exit.is_none() {
            self.drain(emit);
        }
    }

    /// Publishes the native exit last and ends this viewer's stream once.
    pub fn on_exit(
        &mut self,
        exit: ExitInfo,
        consent_revoked: bool,
        emit: &mut impl FnMut(OutputFrame) -> bool,
    ) {
        if self.exit.is_some() {
            return;
        }
        self.exit = Some(exit.clone());
        if !self.attached {
            return;
        }
        self.drain(emit);
        let lost = self
            .pending
            .len()
            .saturating_add(self.pending.take_dropped());
        if lost > 0 && self.attached && !emit(OutputFrame::dropped(lost)) {
            self.viewer_gone();
        }
        if self.attached
            && !emit(OutputFrame::exit(
                exit.exit_code,
                exit.signal.as_deref(),
                consent_revoked,
            ))
        {
            self.viewer_gone();
        }
        self.detach();
    }

    /// Returns whether a viewer currently owns the stream.
    #[must_use]
    pub fn attached(&self) -> bool {
        self.attached
    }

    /// Returns native exit information after the shell settles.
    #[must_use]
    pub fn exit(&self) -> Option<&ExitInfo> {
        self.exit.as_ref()
    }

    fn drain(&mut self, emit: &mut impl FnMut(OutputFrame) -> bool) {
        if self.inflight >= INFLIGHT_WINDOW_BYTES || self.pending.is_empty() {
            return;
        }
        let dropped = self.pending.take_dropped();
        if dropped > 0 && !emit(OutputFrame::dropped(dropped)) {
            self.viewer_gone();
            return;
        }
        while self.attached && self.inflight < INFLIGHT_WINDOW_BYTES && !self.pending.is_empty() {
            let room = INFLIGHT_WINDOW_BYTES - self.inflight;
            let chunk = self.pending.take(CHUNK_MAX_BYTES.min(room));
            self.inflight += chunk.len();
            if !emit(OutputFrame::data(&chunk)) {
                self.viewer_gone();
            }
        }
    }

    fn viewer_gone(&mut self) {
        self.attached = false;
        self.pending.clear();
    }
}

#[cfg(test)]
mod tests {
    use base64::Engine;

    use super::{
        ByteRing, ExitInfo, INFLIGHT_WINDOW_BYTES, OutputFrame, PENDING_MAX_BYTES,
        SCROLLBACK_MAX_BYTES, STANDARD, TerminalFlow,
    };

    #[test]
    fn ring_keeps_last_bytes_and_counts_each_displacement() {
        let mut ring = ByteRing::new(4).unwrap();
        ring.push(b"ab");
        ring.push(b"cdef");
        assert_eq!(ring.snapshot(), b"cdef");
        assert_eq!(ring.take_dropped(), 2);
        ring.push(b"123456");
        assert_eq!(ring.take(3), b"345");
        assert_eq!(ring.snapshot(), b"6");
        assert_eq!(ring.take_dropped(), 6);
        ring.clear();
        assert!(ring.is_empty());
        assert_eq!(ring.take_dropped(), 0);
        assert!(ByteRing::new(0).unwrap_err().contains("positive"));
    }

    #[test]
    fn absent_viewer_gets_no_events_and_reconnect_gets_bounded_replay() {
        let mut flow = TerminalFlow::new(SCROLLBACK_MAX_BYTES + 1).unwrap();
        let mut frames = Vec::new();
        flow.on_data(&vec![b'a'; SCROLLBACK_MAX_BYTES + 10], &mut |frame| {
            frames.push(frame);
            true
        });
        assert!(frames.is_empty());
        assert_eq!(flow.attach().scrollback.len(), SCROLLBACK_MAX_BYTES);
        flow.detach();
        flow.on_data(b"z", &mut |frame| {
            frames.push(frame);
            true
        });
        assert!(frames.is_empty());
        assert_eq!(flow.attach().scrollback.last(), Some(&b'z'));
    }

    #[test]
    fn ack_releases_exact_credit_and_overflow_is_reported_before_new_data() {
        let mut flow = TerminalFlow::new(10).unwrap();
        flow.attach();
        let mut frames = Vec::<OutputFrame>::new();
        let mut emit = |frame| {
            frames.push(frame);
            true
        };
        flow.on_data(&vec![b'a'; INFLIGHT_WINDOW_BYTES], &mut emit);
        flow.on_data(&vec![b'b'; PENDING_MAX_BYTES + 7], &mut emit);
        flow.ack(1, &mut emit);
        assert_eq!(frames.last().unwrap().payload["data"], "Yg==");
        assert_eq!(
            frames[32].payload,
            serde_json::json!({ "kind": "dropped", "bytes": 7 })
        );
    }

    #[test]
    fn exit_reports_unflushed_tail_and_never_reopens_the_ended_stream() {
        let mut flow = TerminalFlow::new(64).unwrap();
        flow.attach();
        let mut frames = Vec::new();
        let mut emit = |frame| {
            frames.push(frame);
            true
        };
        flow.on_data(&vec![b'a'; INFLIGHT_WINDOW_BYTES + 3], &mut emit);
        flow.on_exit(
            ExitInfo {
                exit_code: Some(7),
                signal: None,
            },
            false,
            &mut emit,
        );
        flow.ack(INFLIGHT_WINDOW_BYTES, &mut emit);
        flow.on_exit(
            ExitInfo {
                exit_code: Some(8),
                signal: None,
            },
            false,
            &mut emit,
        );
        assert_eq!(
            frames[32].payload,
            serde_json::json!({ "kind": "dropped", "bytes": 3 })
        );
        assert_eq!(frames.last().unwrap().payload["exitCode"], 7);
        assert!(frames.last().unwrap().end);
        assert_eq!(frames.iter().filter(|frame| frame.end).count(), 1);
        assert!(!flow.attached());
    }

    #[test]
    fn an_exit_with_nothing_pending_emits_no_dropped_marker() {
        let mut flow = TerminalFlow::new(64).unwrap();
        flow.attach();
        let mut frames = Vec::new();
        let mut emit = |frame| {
            frames.push(frame);
            true
        };
        flow.on_data(b"done", &mut emit);
        flow.on_exit(
            ExitInfo {
                exit_code: Some(0),
                signal: None,
            },
            false,
            &mut emit,
        );
        let kinds: Vec<_> = frames
            .iter()
            .map(|frame| frame.payload["kind"].clone())
            .collect();
        assert_eq!(
            kinds,
            vec![serde_json::json!("data"), serde_json::json!("exit")],
            "expected data then exit with no dropped marker | received {kinds:?}"
        );
    }

    /// Live data bytes carried by `frames`.
    fn data_bytes(frames: &[OutputFrame]) -> usize {
        frames
            .iter()
            .filter(|frame| frame.payload["kind"] == "data")
            .map(|frame| {
                STANDARD
                    .decode(frame.payload["data"].as_str().unwrap())
                    .unwrap()
                    .len()
            })
            .sum()
    }

    #[test]
    fn replayed_scrollback_is_charged_to_the_inflight_window() {
        let replay = 1024;
        let mut flow = TerminalFlow::new(replay).unwrap();
        flow.on_data(&vec![b'a'; replay], &mut |_| true);
        assert_eq!(flow.attach().scrollback.len(), replay);
        let room = INFLIGHT_WINDOW_BYTES - replay;
        let mut live = Vec::new();
        flow.on_data(&vec![b'b'; room + 5], &mut |frame| {
            live.push(frame);
            true
        });
        assert_eq!(
            data_bytes(&live),
            room,
            "expected only the window left after a {replay}-byte replay | received {} live bytes",
            data_bytes(&live)
        );
        let mut resumed = Vec::new();
        flow.ack(5, &mut |frame| {
            resumed.push(frame);
            true
        });
        assert_eq!(
            data_bytes(&resumed),
            5,
            "expected an ack of 5 to release exactly 5 held bytes | received {}",
            data_bytes(&resumed)
        );
    }

    #[test]
    fn failed_emission_detaches_without_losing_scrollback() {
        let mut flow = TerminalFlow::new(64).unwrap();
        flow.attach();
        flow.on_data(b"hello", &mut |_| false);
        assert!(!flow.attached());
        assert_eq!(flow.attach().scrollback, b"hello");
    }

    #[test]
    fn revoked_exit_carries_a_typed_reason_once() {
        let mut flow = TerminalFlow::new(64).unwrap();
        flow.attach();
        let mut frames = Vec::new();
        flow.on_exit(
            ExitInfo {
                exit_code: None,
                signal: None,
            },
            true,
            &mut |frame| {
                frames.push(frame);
                true
            },
        );
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].payload["reason"], "consent-revoked");
        assert!(frames[0].end);
    }
}
