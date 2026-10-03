//! Keeps an elicitation form's field order.
//!
//! The pinned SDK parses `requestedSchema.properties` into a sorted map, so by the time the
//! elicitation handler runs the server's field order is gone, and the hub's card would list
//! fields alphabetically instead of in the order the server asked. The TypeScript host keeps the
//! order (`Object.entries`). Each transport therefore shows the raw bytes it receives to a
//! [`SchemaOrder`], which records, per server request id, the property names in wire order; the
//! handler takes them back out by the same id.

use std::collections::VecDeque;
use std::fmt;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use serde::Deserialize;
use serde::de::{IgnoredAny, MapAccess, Visitor};
use serde_json::Value;
use tokio::io::{AsyncRead, ReadBuf};

/// Pending orders kept per session; an elicitation the handler never claims ages out.
const MAX_ORDERS: usize = 32;
/// Longest stdio line inspected; a longer line is passed through unobserved.
const MAX_LINE_BYTES: usize = 1024 * 1024;
const MARKER: &[u8] = b"elicitation/create";

/// Property names per server request id, in the order the server sent them.
#[derive(Default)]
pub(crate) struct SchemaOrder(Mutex<VecDeque<(String, Vec<String>)>>);

impl SchemaOrder {
    /// Records the field order if `raw` is one `elicitation/create` request.
    pub(crate) fn observe(&self, raw: &[u8]) {
        if !raw.windows(MARKER.len()).any(|window| window == MARKER) {
            return;
        }
        let Ok(probe) = serde_json::from_slice::<Probe>(raw) else {
            return;
        };
        let (Some(id), Some("elicitation/create")) = (probe.id, probe.method.as_deref()) else {
            return;
        };
        let Some(names) = probe
            .params
            .and_then(|params| params.requested_schema)
            .and_then(|schema| schema.properties)
        else {
            return;
        };
        let mut orders = self.0.lock().unwrap_or_else(|poison| poison.into_inner());
        if orders.len() == MAX_ORDERS {
            orders.pop_front();
        }
        orders.push_back((id.to_string(), names.0));
    }

    /// Takes the order recorded for the request whose JSON id serializes to `id`.
    pub(crate) fn take(&self, id: &str) -> Option<Vec<String>> {
        let mut orders = self.0.lock().unwrap_or_else(|poison| poison.into_inner());
        let index = orders.iter().position(|(key, _)| key == id)?;
        orders.remove(index).map(|(_, names)| names)
    }
}

#[derive(Deserialize)]
struct Probe {
    id: Option<Value>,
    method: Option<String>,
    params: Option<ProbeParams>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeParams {
    requested_schema: Option<ProbeSchema>,
}

#[derive(Deserialize)]
struct ProbeSchema {
    properties: Option<KeyOrder>,
}

/// An object's keys in document order; values are skipped.
struct KeyOrder(Vec<String>);

impl<'de> Deserialize<'de> for KeyOrder {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Keys;
        impl<'de> Visitor<'de> for Keys {
            type Value = KeyOrder;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an object of schema properties")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<KeyOrder, A::Error> {
                let mut keys = Vec::new();
                while let Some(key) = map.next_key::<String>()? {
                    map.next_value::<IgnoredAny>()?;
                    keys.push(key);
                }
                Ok(KeyOrder(keys))
            }
        }
        deserializer.deserialize_map(Keys)
    }
}

/// Shows every complete line a stdio server writes to a [`SchemaOrder`] on its way to the SDK.
pub(crate) struct ObservedLines<R> {
    inner: R,
    order: Arc<SchemaOrder>,
    line: Vec<u8>,
    overflowed: bool,
}

impl<R> ObservedLines<R> {
    pub(crate) fn new(inner: R, order: Arc<SchemaOrder>) -> Self {
        Self {
            inner,
            order,
            line: Vec::new(),
            overflowed: false,
        }
    }

    fn feed(&mut self, bytes: &[u8]) {
        for chunk in bytes.split_inclusive(|byte| *byte == b'\n') {
            let complete = chunk.last() == Some(&b'\n');
            if !self.overflowed {
                if self.line.len() + chunk.len() > MAX_LINE_BYTES {
                    self.overflowed = true;
                    self.line.clear();
                } else {
                    self.line.extend_from_slice(chunk);
                }
            }
            if complete {
                if !self.overflowed {
                    self.order.observe(&self.line);
                }
                self.line.clear();
                self.overflowed = false;
            }
        }
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for ObservedLines<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let polled = Pin::new(&mut self.inner).poll_read(context, buf);
        if let Poll::Ready(Ok(())) = polled {
            self.feed(&buf.filled()[before..]);
        }
        polled
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::AsyncReadExt;

    use super::*;

    /// Answers its first read with `Pending`, then reads from `inner`.
    struct PendingOnce<R> {
        inner: R,
        polled: bool,
    }

    impl<R: AsyncRead + Unpin> AsyncRead for PendingOnce<R> {
        fn poll_read(
            mut self: Pin<&mut Self>,
            context: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            if !self.polled {
                self.polled = true;
                return Poll::Pending;
            }
            Pin::new(&mut self.inner).poll_read(context, buf)
        }
    }

    /// Fails every read, after writing `garbage` into the buffer it was given.
    struct FailingRead {
        garbage: &'static [u8],
    }

    impl AsyncRead for FailingRead {
        fn poll_read(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            buf.put_slice(self.garbage);
            Poll::Ready(Err(std::io::Error::other("FailingRead: injected failure")))
        }
    }

    fn poll_once<R: AsyncRead + Unpin>(
        reader: &mut ObservedLines<R>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let mut context = Context::from_waker(std::task::Waker::noop());
        Pin::new(reader).poll_read(&mut context, buf)
    }

    fn request(id: usize) -> String {
        REQUEST.replace("\"id\":7", &format!("\"id\":{id}"))
    }

    const REQUEST: &str = r#"{"jsonrpc":"2.0","id":7,"method":"elicitation/create","params":{"message":"m","requestedSchema":{"type":"object","properties":{"zeta":{"type":"string"},"alpha":{"type":"number"},"mid":{"type":"boolean"}}}}}"#;

    #[test]
    fn records_property_names_in_wire_order_by_request_id() {
        let order = SchemaOrder::default();
        order.observe(REQUEST.as_bytes());
        assert_eq!(
            order.take("7"),
            Some(vec!["zeta".into(), "alpha".into(), "mid".into()])
        );
        assert_eq!(order.take("7"), None, "expected an order to be taken once");
    }

    #[test]
    fn ignores_other_messages_and_bounds_what_it_keeps() {
        let order = SchemaOrder::default();
        order.observe(br#"{"jsonrpc":"2.0","id":1,"result":{"note":"elicitation/create"}}"#);
        assert_eq!(order.take("1"), None);
        for id in 0..(MAX_ORDERS + 5) {
            order.observe(
                REQUEST
                    .replace("\"id\":7", &format!("\"id\":\"r{id}\""))
                    .as_bytes(),
            );
        }
        assert_eq!(
            order.take("\"r0\""),
            None,
            "expected the oldest order evicted"
        );
        assert!(order.take(&format!("\"r{}\"", MAX_ORDERS + 4)).is_some());
    }

    #[tokio::test]
    async fn stdio_lines_are_observed_across_split_reads() {
        let order = Arc::new(SchemaOrder::default());
        let bytes = format!("{REQUEST}\n{{\"jsonrpc\":\"2.0\",\"method\":\"x\"}}\n");
        let (left, right) = bytes.as_bytes().split_at(40);
        let stream = tokio_test_chain(left.to_vec(), right.to_vec());
        let mut reader = ObservedLines::new(stream, Arc::clone(&order));
        let mut sink = Vec::new();
        reader.read_to_end(&mut sink).await.expect("reads");
        assert_eq!(
            sink,
            bytes.as_bytes(),
            "expected the bytes passed through untouched"
        );
        assert_eq!(
            order.take("7"),
            Some(vec!["zeta".into(), "alpha".into(), "mid".into()])
        );
    }

    fn tokio_test_chain(first: Vec<u8>, second: Vec<u8>) -> impl AsyncRead + Unpin {
        std::io::Cursor::new(first).chain(std::io::Cursor::new(second))
    }

    #[test]
    fn a_pending_read_shows_nothing_and_the_next_read_still_completes_the_line() {
        let order = Arc::new(SchemaOrder::default());
        let line = format!("{REQUEST}\n");
        let source = PendingOnce {
            inner: std::io::Cursor::new(line.clone().into_bytes()),
            polled: false,
        };
        let mut reader = ObservedLines::new(source, Arc::clone(&order));
        let mut storage = vec![0u8; line.len()];
        let mut buf = ReadBuf::new(&mut storage);

        let first = poll_once(&mut reader, &mut buf);

        assert!(
            first.is_pending() && buf.filled().is_empty() && order.take("7").is_none(),
            "expected Pending with nothing filled or observed | received: {first:?}, filled: {}",
            buf.filled().len()
        );
        let second = poll_once(&mut reader, &mut buf);
        assert!(
            matches!(second, Poll::Ready(Ok(()))) && buf.filled() == line.as_bytes(),
            "expected the whole line passed through | received: {second:?}, filled: {:?}",
            buf.filled()
        );
        assert_eq!(
            order.take("7"),
            Some(vec!["zeta".into(), "alpha".into(), "mid".into()])
        );
    }

    #[test]
    fn a_failed_read_shows_nothing_even_if_the_source_wrote_bytes() {
        let order = Arc::new(SchemaOrder::default());
        let source = FailingRead {
            garbage: b"{\"id\":7,\"method\":\"elicitation/create\"}\n",
        };
        let mut reader = ObservedLines::new(source, Arc::clone(&order));
        let mut storage = [0u8; 128];
        let mut buf = ReadBuf::new(&mut storage);

        let polled = poll_once(&mut reader, &mut buf);

        assert!(
            matches!(polled, Poll::Ready(Err(_))) && reader.line.is_empty(),
            "expected an error and no observed bytes | received: {polled:?}, line: {:?}",
            reader.line
        );
    }

    #[test]
    fn only_the_bytes_this_read_added_are_observed_when_the_buffer_was_already_filled() {
        let order = Arc::new(SchemaOrder::default());
        let line = format!("{REQUEST}\n");
        let mut reader = ObservedLines::new(
            std::io::Cursor::new(line.clone().into_bytes()),
            Arc::clone(&order),
        );
        let mut storage = vec![0u8; line.len() + 64];
        let mut buf = ReadBuf::new(&mut storage);
        buf.put_slice(b"leftover without a newline ");

        let polled = poll_once(&mut reader, &mut buf);

        assert!(matches!(polled, Poll::Ready(Ok(()))));
        assert_eq!(
            buf.filled(),
            [b"leftover without a newline ".as_slice(), line.as_bytes()].concat(),
            "expected the prefilled bytes and the read passed through untouched"
        );
        assert_eq!(
            order.take("7"),
            Some(vec!["zeta".into(), "alpha".into(), "mid".into()]),
            "expected only this read's bytes observed, not the prefilled bytes glued to its line"
        );
    }

    #[tokio::test]
    async fn end_of_stream_leaves_an_unterminated_line_unobserved() {
        let order = Arc::new(SchemaOrder::default());
        let bytes = format!("{}\n{}", request(1), request(2));
        let mut reader = ObservedLines::new(
            std::io::Cursor::new(bytes.clone().into_bytes()),
            Arc::clone(&order),
        );
        let mut sink = Vec::new();

        reader.read_to_end(&mut sink).await.expect("reads");

        assert_eq!(
            sink,
            bytes.as_bytes(),
            "expected the bytes passed through untouched"
        );
        assert!(
            order.take("2").is_none(),
            "expected the line without a newline unobserved at EOF"
        );
        assert!(
            order.take("1").is_some(),
            "expected the terminated line observed"
        );
    }

    #[tokio::test]
    async fn pending_requests_are_kept_in_arrival_order_and_the_oldest_ages_out() {
        let order = Arc::new(SchemaOrder::default());
        let total = MAX_ORDERS + 2;
        let bytes: String = (0..total).map(|id| format!("{}\n", request(id))).collect();
        let mut reader = ObservedLines::new(
            std::io::Cursor::new(bytes.clone().into_bytes()),
            Arc::clone(&order),
        );
        let mut sink = Vec::new();

        reader.read_to_end(&mut sink).await.expect("reads");

        assert_eq!(
            sink,
            bytes.as_bytes(),
            "expected the bytes passed through untouched"
        );
        let kept: Vec<usize> = (0..total)
            .filter(|id| order.take(&id.to_string()).is_some())
            .collect();
        let expected: Vec<usize> = (2..total).collect();
        assert!(
            kept == expected,
            "expected the {MAX_ORDERS} newest ids kept: {expected:?} | received: {kept:?}"
        );
    }
}
