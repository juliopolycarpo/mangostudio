//! Legacy HTTP+SSE (MCP 2024-11-05) client transport.
//!
//! The pinned SDK dropped its SSE client, but existing server rows still point at SSE-only
//! servers, so this narrow project-owned adapter keeps them working. It mirrors the TypeScript
//! SDK's `SSEClientTransport`: a `GET` opens the event stream, the server's `endpoint` event names
//! where to `POST` messages (refused unless it shares the stream's origin), `message` events carry
//! JSON-RPC, and the row's headers go on both the `GET` and every `POST`.
//!
//! One deliberate difference: when the event stream ends, the session ends. The TypeScript
//! transport's `EventSource` would silently reconnect to a fresh server-side session the client
//! never initialized; reporting the session closed lets the hub reconnect properly.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use futures_util::stream::{BoxStream, StreamExt};
use http::{HeaderName, HeaderValue};
use rmcp::RoleClient;
use rmcp::model::{ServerJsonRpcMessage, ServerResult};
use rmcp::service::{RxJsonRpcMessage, TxJsonRpcMessage};
use rmcp::transport::Transport;
use rmcp::transport::common::http_header::{EVENT_STREAM_MIME_TYPE, JSON_MIME_TYPE};
use rmcp::transport::streamable_http_client::SseError;
use sse_stream::Sse;

use super::http::{MAX_SSE_EVENT_BYTES, bounded_sse};

type Events = BoxStream<'static, Result<Sse, SseError>>;

/// A failed legacy SSE exchange, with the TypeScript transport's message text.
#[derive(Debug)]
pub(crate) struct SseTransportError(pub String);

impl std::fmt::Display for SseTransportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for SseTransportError {}

/// An open legacy SSE session: the event stream plus where messages are posted.
pub(crate) struct LegacySse {
    client: reqwest::Client,
    endpoint: reqwest::Url,
    headers: HashMap<HeaderName, HeaderValue>,
    /// The negotiated revision, sent on every `POST` after `initialize` answers.
    protocol: Arc<Mutex<Option<String>>>,
    buffered: VecDeque<ServerJsonRpcMessage>,
    events: Option<Events>,
}

impl LegacySse {
    /// Opens the event stream and waits for the server's `endpoint` event.
    ///
    /// # Example
    /// ```ignore
    /// let transport = LegacySse::open(http_client()?, url, headers).await?;
    /// let session = client_config.serve(transport).await?;
    /// ```
    pub(crate) async fn open(
        client: reqwest::Client,
        url: reqwest::Url,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<Self, SseTransportError> {
        let mut request = client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, EVENT_STREAM_MIME_TYPE);
        for (name, value) in &headers {
            request = request.header(name, value);
        }
        let response = request
            .send()
            .await
            .map_err(|error| SseTransportError(format!("SSE error: {error}")))?;
        let status = response.status();
        if !status.is_success() {
            return Err(SseTransportError(format!(
                "SSE error: Non-200 status code ({})",
                status.as_u16()
            )));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        if !content_type.starts_with(EVENT_STREAM_MIME_TYPE) {
            return Err(SseTransportError(format!(
                "SSE error: Invalid content type \"{content_type}\", expected \"{EVENT_STREAM_MIME_TYPE}\""
            )));
        }
        let mut events = bounded_sse(response, MAX_SSE_EVENT_BYTES);
        let mut buffered = VecDeque::new();
        loop {
            let event = match events.next().await {
                Some(Ok(event)) => event,
                Some(Err(error)) => return Err(SseTransportError(format!("SSE error: {error}"))),
                None => {
                    return Err(SseTransportError(
                        "SSE error: the stream ended before the server sent its endpoint"
                            .to_owned(),
                    ));
                }
            };
            if event.event.as_deref() == Some("endpoint") {
                let endpoint = resolve_endpoint(&url, event.data.as_deref().unwrap_or_default())?;
                return Ok(Self {
                    client,
                    endpoint,
                    headers,
                    protocol: Arc::new(Mutex::new(None)),
                    buffered,
                    events: Some(events),
                });
            }
            if let Some(message) = message_of(&event) {
                buffered.push_back(message);
            }
        }
    }

    fn note_protocol(&self, message: &ServerJsonRpcMessage) {
        let ServerJsonRpcMessage::Response(response) = message else {
            return;
        };
        let ServerResult::InitializeResult(result) = &response.result else {
            return;
        };
        let mut protocol = self
            .protocol
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *protocol = Some(result.protocol_version.to_string());
    }
}

/// Resolves the `endpoint` event against the stream URL and refuses a different origin, as the
/// TypeScript transport does, so a server cannot redirect message posts (and their headers) to
/// another host.
fn resolve_endpoint(base: &reqwest::Url, data: &str) -> Result<reqwest::Url, SseTransportError> {
    let endpoint = base.join(data).map_err(|error| {
        SseTransportError(format!(
            "SSE error: endpoint \"{data}\" is not a valid URL ({error})"
        ))
    })?;
    if endpoint.origin() != base.origin() {
        return Err(SseTransportError(format!(
            "Endpoint origin does not match connection origin: {}",
            endpoint.origin().ascii_serialization()
        )));
    }
    Ok(endpoint)
}

/// A default-typed (`message`) event carrying JSON-RPC; anything else is skipped, as the
/// TypeScript transport reports a malformed message to `onerror` and keeps reading.
fn message_of(event: &Sse) -> Option<ServerJsonRpcMessage> {
    if !matches!(event.event.as_deref(), None | Some("message")) {
        return None;
    }
    serde_json::from_str(event.data.as_deref()?).ok()
}

impl Transport<RoleClient> for LegacySse {
    type Error = SseTransportError;

    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        let client = self.client.clone();
        let endpoint = self.endpoint.clone();
        let headers = self.headers.clone();
        let protocol = self
            .protocol
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        async move {
            let body = serde_json::to_vec(&item)
                .map_err(|error| SseTransportError(format!("message is not JSON: {error}")))?;
            let mut request = client.post(endpoint);
            for (name, value) in headers {
                request = request.header(name, value);
            }
            if let Some(protocol) = protocol {
                request = request.header("mcp-protocol-version", protocol);
            }
            let response = request
                .header(reqwest::header::CONTENT_TYPE, JSON_MIME_TYPE)
                .body(body)
                .send()
                .await
                .map_err(|error| {
                    SseTransportError(format!("Error POSTing to endpoint: {error}"))
                })?;
            let status = response.status();
            if status.is_success() {
                return Ok(());
            }
            let text = response.text().await.unwrap_or_default();
            Err(SseTransportError(format!(
                "Error POSTing to endpoint (HTTP {}): {text}",
                status.as_u16()
            )))
        }
    }

    async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleClient>> {
        if let Some(message) = self.buffered.pop_front() {
            self.note_protocol(&message);
            return Some(message);
        }
        loop {
            let event = match self.events.as_mut()?.next().await {
                Some(Ok(event)) => event,
                Some(Err(_)) | None => {
                    self.events = None;
                    return None;
                }
            };
            if let Some(message) = message_of(&event) {
                self.note_protocol(&message);
                return Some(message);
            }
        }
    }

    fn close(&mut self) -> impl Future<Output = Result<(), Self::Error>> + Send {
        self.events = None;
        std::future::ready(Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> reqwest::Url {
        reqwest::Url::parse("http://127.0.0.1:4000/sse").expect("valid base")
    }

    #[test]
    fn a_relative_endpoint_resolves_against_the_stream_url() {
        let endpoint = resolve_endpoint(&base(), "/messages?sessionId=abc").expect("same origin");
        assert_eq!(
            endpoint.as_str(),
            "http://127.0.0.1:4000/messages?sessionId=abc"
        );
    }

    #[test]
    fn a_cross_origin_endpoint_is_refused() {
        for data in [
            "http://attacker.test/messages",
            "https://127.0.0.1:4000/messages",
            "http://127.0.0.1:4001/messages",
        ] {
            let error = resolve_endpoint(&base(), data).expect_err("expected a refusal");
            assert!(
                error
                    .0
                    .starts_with("Endpoint origin does not match connection origin"),
                "expected the TypeScript origin refusal for {data} | received {}",
                error.0
            );
        }
    }

    #[test]
    fn only_default_or_message_events_carry_json_rpc() {
        let message = |event: Option<&str>, data: &str| Sse {
            event: event.map(str::to_owned),
            data: Some(data.to_owned()),
            id: None,
            retry: None,
        };
        let ping = r#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#;
        assert!(message_of(&message(None, ping)).is_some());
        assert!(message_of(&message(Some("message"), ping)).is_some());
        assert!(message_of(&message(Some("endpoint"), ping)).is_none());
        assert!(message_of(&message(None, "not json")).is_none());
    }
}
