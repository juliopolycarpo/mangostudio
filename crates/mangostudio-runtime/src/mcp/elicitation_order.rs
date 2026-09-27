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
            let read = buf.filled()[before..].to_vec();
            self.feed(&read);
        }
        polled
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::AsyncReadExt;

    use super::*;

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
}
