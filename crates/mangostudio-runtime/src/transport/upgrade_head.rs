//! The hub's binding key, read from the WebSocket upgrade request.
//!
//! `serve` decides whether a new connection may take the runtime from an
//! incumbent by the binding key the hub sends in the
//! [`binding::HEADER`] upgrade header, beside its bearer token (see
//! [`mangostudio_runtime_contract::strings::binding`]). `mango_protocol`'s
//! `accept_websocket` hands its `authorize` callback only the bearer and the
//! origin, so the request head is recorded here, as the upgrade reads it,
//! through [`RecordingStream`] — nothing is peeked ahead or read twice, and
//! the decision is made before either side's `hello`.

use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll};

use mangostudio_runtime_contract::strings::binding;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// Most bytes of the upgrade request kept for [`binding_header`]: the same
/// 64 KiB bound tungstenite puts on the request head it will accept, so no
/// head the upgrade admits is cut short here.
const MAX_RECORDED_HEAD_BYTES: usize = 64 * 1024;

/// Where the request head in `bytes` ends — just past the empty line that
/// closes it — or `None` while it has not ended. Accepts the bare-LF line
/// endings `httparse` (and so tungstenite) accepts, not only CRLF.
fn head_end(bytes: &[u8]) -> Option<usize> {
    let mut line_start = 0;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        let line = &bytes[line_start..index];
        if line_start > 0 && line.strip_suffix(b"\r").unwrap_or(line).is_empty() {
            return Some(index + 1);
        }
        line_start = index + 1;
    }
    None
}

/// A stream that keeps a copy of the first bytes read through it — the
/// upgrade request's head — and is otherwise transparent.
pub(crate) struct RecordingStream<S> {
    inner: S,
    head: Arc<Mutex<Vec<u8>>>,
    recording: bool,
}

/// A handle to what a [`RecordingStream`] recorded, readable after the
/// stream itself has moved into the upgrade.
#[derive(Clone)]
pub(crate) struct RecordedHead(Arc<Mutex<Vec<u8>>>);

impl RecordedHead {
    /// The binding key the recorded request carried. See [`binding_header`].
    pub(crate) fn binding(&self) -> BindingHeader {
        let head = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        binding_header(&head)
    }
}

impl<S> RecordingStream<S> {
    pub(crate) fn new(inner: S) -> (Self, RecordedHead) {
        let head = Arc::new(Mutex::new(Vec::new()));
        (
            Self {
                inner,
                head: Arc::clone(&head),
                recording: true,
            },
            RecordedHead(head),
        )
    }

    fn record(&mut self, bytes: &[u8]) {
        let mut head = self.head.lock().unwrap_or_else(PoisonError::into_inner);
        let room = MAX_RECORDED_HEAD_BYTES.saturating_sub(head.len());
        head.extend_from_slice(&bytes[..bytes.len().min(room)]);
        if head.len() >= MAX_RECORDED_HEAD_BYTES || head_end(&head).is_some() {
            self.recording = false;
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for RecordingStream<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        let polled = Pin::new(&mut this.inner).poll_read(cx, buf);
        if this.recording && matches!(polled, Poll::Ready(Ok(()))) {
            let read = buf.filled()[before..].to_vec();
            this.record(&read);
        }
        polled
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for RecordingStream<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

/// What the upgrade request said about its binding key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BindingHeader {
    /// No [`binding::HEADER`]: a hub from before binding keys.
    Absent,
    /// A well-formed key.
    Key(String),
    /// A header that is present but not a key; `why` names what is wrong
    /// with it, never the value itself.
    Malformed(String),
}

/// Reads [`binding::HEADER`] out of a raw request head.
///
/// A key is exactly [`binding::LENGTH`] lowercase hex characters, the shape
/// the hub's `HubBindingKeySchema` declares. A header that is present but is
/// not a key — a wrong length, another charset, repeated, or cut off by a
/// head that did not end within the recorded bytes — is
/// [`BindingHeader::Malformed`], never read as absent: a hub that sent one
/// meant to be bound. A head whose recorded bytes never name the header at
/// all is [`BindingHeader::Absent`], however long it was.
///
/// # Example
///
/// ```ignore
/// let head = b"GET / HTTP/1.1\r\nx-mangostudio-hub-binding: <64 hex>\r\n\r\n";
/// assert!(matches!(binding_header(head), BindingHeader::Key(_)));
/// ```
pub(crate) fn binding_header(head: &[u8]) -> BindingHeader {
    let Some(end) = head_end(head) else {
        return if contains_ignore_ascii_case(head, binding::HEADER.as_bytes()) {
            BindingHeader::Malformed(format!(
                "{} was cut off: the upgrade request head did not end within {MAX_RECORDED_HEAD_BYTES} bytes",
                binding::HEADER
            ))
        } else {
            BindingHeader::Absent
        };
    };
    let mut values = head[..end]
        .split(|byte| *byte == b'\n')
        .skip(1) // the request line
        .filter_map(|line| {
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            let colon = line.iter().position(|byte| *byte == b':')?;
            let (name, value) = (&line[..colon], &line[colon + 1..]);
            name.eq_ignore_ascii_case(binding::HEADER.as_bytes())
                .then(|| value.trim_ascii())
        });
    let Some(value) = values.next() else {
        return BindingHeader::Absent;
    };
    if values.next().is_some() {
        return BindingHeader::Malformed(format!("{} was sent more than once", binding::HEADER));
    }
    if value.len() != binding::LENGTH
        || !value
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return BindingHeader::Malformed(format!(
            "{} must be {} lowercase hex characters, received {} bytes",
            binding::HEADER,
            binding::LENGTH,
            value.len()
        ));
    }
    BindingHeader::Key(String::from_utf8_lossy(value).into_owned())
}

fn contains_ignore_ascii_case(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle))
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::{BindingHeader, RecordingStream, binding_header};

    const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn request(headers: &str) -> Vec<u8> {
        format!("GET / HTTP/1.1\r\nhost: runtime\r\n{headers}\r\n").into_bytes()
    }

    #[test]
    fn a_well_formed_key_is_read_case_insensitively_by_header_name() {
        assert_eq!(
            binding_header(&request(&format!("X-MangoStudio-Hub-Binding:  {KEY} \r\n"))),
            BindingHeader::Key(KEY.to_owned())
        );
    }

    #[test]
    fn no_header_is_absent() {
        assert_eq!(
            binding_header(&request("authorization: Bearer t\r\n")),
            BindingHeader::Absent
        );
    }

    #[test]
    fn a_present_header_that_is_not_a_key_is_malformed_not_absent() {
        let cases = [
            ("empty", String::new()),
            ("one short", KEY[1..].to_owned()),
            ("one long", format!("{KEY}0")),
            ("uppercase", KEY.to_uppercase()),
            ("not hex", "g".repeat(64)),
        ];
        for (why, value) in cases {
            let header =
                binding_header(&request(&format!("x-mangostudio-hub-binding: {value}\r\n")));
            assert!(
                matches!(header, BindingHeader::Malformed(_)),
                "expected a {why} key to be malformed | received {header:?}"
            );
        }
        let repeated = binding_header(&request(&format!(
            "x-mangostudio-hub-binding: {KEY}\r\nx-mangostudio-hub-binding: {KEY}\r\n"
        )));
        assert!(
            matches!(&repeated, BindingHeader::Malformed(why) if why.contains("more than once")),
            "expected a repeated header to be malformed | received {repeated:?}"
        );
    }

    #[test]
    fn a_head_cut_off_inside_the_binding_header_is_malformed() {
        let header = binding_header(b"GET / HTTP/1.1\r\nx-mangostudio-hub-binding: ab");
        assert!(
            matches!(&header, BindingHeader::Malformed(why) if why.contains("cut off")),
            "expected a cut-off binding header to be malformed | received {header:?}"
        );
    }

    #[test]
    fn a_cut_off_head_that_never_names_the_header_is_absent() {
        let header = binding_header(b"GET / HTTP/1.1\r\nhost: runtime\r\nx-other: ab");
        assert_eq!(header, BindingHeader::Absent);
    }

    /// A keyless head past the old 16 KiB cap is an older hub, not a bad key.
    #[tokio::test]
    async fn a_keyless_twenty_kib_head_is_absent() {
        let padding = "p".repeat(20 * 1024);
        let sent = request(&format!("x-padding: {padding}\r\n"));
        assert!(sent.len() > 20 * 1024);
        assert_eq!(recorded(sent.clone()).await, BindingHeader::Absent);
        assert_eq!(binding_header(&sent), BindingHeader::Absent);
    }

    #[tokio::test]
    async fn bare_lf_heads_are_read_like_crlf_heads() {
        let keyless = b"GET / HTTP/1.1\nhost: runtime\n\nafter".to_vec();
        assert_eq!(recorded(keyless).await, BindingHeader::Absent);
        let keyed = format!("GET / HTTP/1.1\nhost: runtime\nx-mangostudio-hub-binding: {KEY}\n\n")
            .into_bytes();
        assert_eq!(recorded(keyed).await, BindingHeader::Key(KEY.to_owned()));
    }

    /// Streams `sent` through a [`RecordingStream`] in small pieces and
    /// returns what its recorded head says about the binding key.
    async fn recorded(sent: Vec<u8>) -> BindingHeader {
        let (mut client, server) = tokio::io::duplex(1024);
        let (mut recording, head) = RecordingStream::new(server);
        let writer = tokio::spawn(async move {
            for piece in sent.chunks(700) {
                client.write_all(piece).await.unwrap();
            }
            client.shutdown().await.unwrap();
        });
        let mut received = Vec::new();
        recording.read_to_end(&mut received).await.unwrap();
        writer.await.unwrap();
        head.binding()
    }

    /// The recording is transparent — the reader sees every byte — and
    /// keeps the head even when it arrives in pieces.
    #[tokio::test]
    async fn the_stream_records_the_head_across_reads_without_consuming_it() {
        let (mut client, server) = tokio::io::duplex(64);
        let (mut recording, head) = RecordingStream::new(server);
        let sent = request(&format!("x-mangostudio-hub-binding: {KEY}\r\n"));
        let writer = {
            let sent = sent.clone();
            tokio::spawn(async move {
                for piece in sent.chunks(7) {
                    client.write_all(piece).await.unwrap();
                }
                client.write_all(b"after").await.unwrap();
                client.shutdown().await.unwrap();
            })
        };
        let mut received = Vec::new();
        recording.read_to_end(&mut received).await.unwrap();
        writer.await.unwrap();

        let mut expected = sent;
        expected.extend_from_slice(b"after");
        assert_eq!(
            received, expected,
            "expected the stream to pass every byte through"
        );
        assert_eq!(head.binding(), BindingHeader::Key(KEY.to_owned()));
    }
}
