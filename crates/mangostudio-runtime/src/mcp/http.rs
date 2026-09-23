//! The HTTP half of the runtime → MCP server boundary.
//!
//! [`McpHttp`] implements the SDK's streamable-HTTP client trait over a project-configured
//! `reqwest` client, so this module — not the SDK — decides three things:
//!
//! - **TLS**: a `ring` rustls config with the webpki root store, the same policy
//!   `mango-protocol`'s WebSocket dialler uses; never a process-default provider.
//! - **Status**: a failed pre-session POST (the `initialize`) always surfaces as
//!   [`HttpError::Status`], which is what the legacy HTTP+SSE fallback keys on, exactly as the
//!   TypeScript SDK's `StreamableHTTPError` does.
//! - **Headers**: the row's secret headers go to the row's URL on every request, as the
//!   TypeScript host sends them. This boundary has no loopback rule of its own: whether a secret
//!   may leave the hub at all is decided hub-side before `mcp.connect`, and redirects follow the
//!   same rules `fetch` does (at most 20 hops; credentials are dropped on a cross-host hop).
//!   Proxies come from the standard `HTTP(S)_PROXY`/`NO_PROXY` variables, as Bun's `fetch`
//!   honours them.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll};

use bytes::Bytes;
use futures_util::stream::{BoxStream, Stream, StreamExt};
use http::{HeaderName, HeaderValue};
use rmcp::model::{ClientJsonRpcMessage, JsonRpcMessage, ServerJsonRpcMessage};
use rmcp::service::ClientInitializeError;
use rmcp::transport::common::http_header::{
    EVENT_STREAM_MIME_TYPE, HEADER_LAST_EVENT_ID, HEADER_SESSION_ID, JSON_MIME_TYPE,
};
use rmcp::transport::streamable_http_client::{
    SseError, StreamableHttpClient, StreamableHttpError, StreamableHttpPostResponse,
};
use sse_stream::{Sse, SseStream};

/// Largest single SSE event accepted from a server (the SDK's own default bound).
pub(crate) const MAX_SSE_EVENT_BYTES: usize = 16 * 1024 * 1024;
/// Redirect hops followed, matching the Fetch standard's limit.
const MAX_REDIRECTS: usize = 20;
/// Header names the transport owns; a row header with one of these names is not sent, just as
/// the TypeScript SDK's own protocol headers override a caller's.
const PROTOCOL_HEADERS: [&str; 4] = ["accept", "content-type", "mcp-session-id", "last-event-id"];

/// Why an HTTP exchange failed below the MCP layer.
#[derive(Debug)]
pub(crate) enum HttpError {
    /// The server answered with a non-success status.
    Status { status: u16, body: String },
    /// The request could not be sent or its response could not be read.
    Request(reqwest::Error),
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Status { status, body } if body.is_empty() => write!(formatter, "HTTP {status}"),
            Self::Status { status, body } => write!(formatter, "HTTP {status}: {body}"),
            Self::Request(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for HttpError {}

impl From<reqwest::Error> for HttpError {
    fn from(error: reqwest::Error) -> Self {
        Self::Request(error)
    }
}

type HttpResult<T> = Result<T, StreamableHttpError<HttpError>>;

/// The shared HTTP client both MCP HTTP transports use.
///
/// # Example
/// ```ignore
/// let client = http_client()?;
/// let response = client.get(url).send().await?;
/// ```
pub(crate) fn http_client() -> Result<reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT.get_or_init(build_client).clone()
}

fn build_client() -> Result<reqwest::Client, String> {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    // Named rather than installed as the process default, so this module never decides the
    // provider for anything else linked into the binary.
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| format!("the TLS provider refused the protocol versions: {error}"))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
        .build()
        .map_err(|error| format!("the MCP HTTP client could not be built: {error}"))
}

/// Parses a row's URL, accepting only `http` and `https`.
///
/// # Example
/// ```ignore
/// assert!(endpoint_url("ftp://example.test/").is_err());
/// ```
pub(crate) fn endpoint_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw)
        .map_err(|error| format!("URL \"{raw}\" is not a valid URL ({error}); expected an absolute http:// or https:// URL"))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        other => Err(format!(
            "URL scheme \"{other}\" is not supported; expected an http:// or https:// URL"
        )),
    }
}

/// Converts the row's secret headers for the wire. A refusal names the header, never its value.
///
/// # Example
/// ```ignore
/// let headers = header_map(&BTreeMap::from([("Authorization".into(), "Bearer t".into())]))?;
/// ```
pub(crate) fn header_map(
    headers: &BTreeMap<String, String>,
) -> Result<HashMap<HeaderName, HeaderValue>, String> {
    let mut map = HashMap::with_capacity(headers.len());
    for (name, value) in headers {
        let header = HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
            format!(
                "header name \"{name}\" is not a valid HTTP header name; expected an RFC 9110 token"
            )
        })?;
        if PROTOCOL_HEADERS.contains(&header.as_str()) {
            continue;
        }
        let mut value = HeaderValue::from_str(value).map_err(|_| {
            format!(
                "header \"{name}\" has a value that is not a valid HTTP header value; expected \
                 visible ASCII without line breaks"
            )
        })?;
        value.set_sensitive(true);
        map.insert(header, value);
    }
    Ok(map)
}

/// Whether a failed streamable-HTTP connect should retry over legacy HTTP+SSE.
///
/// The MCP backwards-compatibility recipe, as the TypeScript host applies it: a modern client
/// detects an SSE-only server by its `initialize` POST failing with a 4xx status. Transport
/// failures (refused connections, TLS errors) and 5xx answers do not fall back.
pub(crate) fn should_fall_back_to_sse(error: &ClientInitializeError) -> bool {
    let ClientInitializeError::TransportError { error, .. } = error else {
        return false;
    };
    matches!(
        error.error.downcast_ref::<StreamableHttpError<HttpError>>(),
        Some(StreamableHttpError::Client(HttpError::Status { status, .. })) if (400..500).contains(status)
    )
}

/// The SDK's streamable-HTTP client trait over the shared [`http_client`].
#[derive(Clone)]
pub(crate) struct McpHttp {
    client: reqwest::Client,
}

impl McpHttp {
    pub(crate) fn new(client: reqwest::Client) -> Self {
        Self { client }
    }
}

fn apply(
    mut request: reqwest::RequestBuilder,
    headers: HashMap<HeaderName, HeaderValue>,
    auth: Option<String>,
) -> reqwest::RequestBuilder {
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(token) = auth {
        request = request.bearer_auth(token);
    }
    request
}

async fn status_error(response: reqwest::Response) -> StreamableHttpError<HttpError> {
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    StreamableHttpError::Client(HttpError::Status { status, body })
}

fn content_type(response: &reqwest::Response) -> Option<String> {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
}

fn expects_no_reply(message: &ClientJsonRpcMessage) -> bool {
    matches!(
        message,
        JsonRpcMessage::Notification(_) | JsonRpcMessage::Response(_) | JsonRpcMessage::Error(_)
    )
}

impl StreamableHttpClient for McpHttp {
    type Error = HttpError;

    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> HttpResult<StreamableHttpPostResponse> {
        self.post_message_with_max_sse_event_size(
            uri,
            message,
            session_id,
            auth_header,
            custom_headers,
            MAX_SSE_EVENT_BYTES,
        )
        .await
    }

    async fn post_message_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        max_sse_event_size: usize,
    ) -> HttpResult<StreamableHttpPostResponse> {
        let body = serde_json::to_vec(&message)?;
        let mut request = apply(self.client.post(uri.as_ref()), custom_headers, auth_header)
            .header(reqwest::header::CONTENT_TYPE, JSON_MIME_TYPE)
            .header(
                reqwest::header::ACCEPT,
                format!("{JSON_MIME_TYPE}, {EVENT_STREAM_MIME_TYPE}"),
            );
        let session_attached = session_id.is_some();
        if let Some(session) = session_id {
            request = request.header(HEADER_SESSION_ID, session.as_ref());
        }
        let response = request
            .body(body)
            .send()
            .await
            .map_err(|error| StreamableHttpError::Client(error.into()))?;
        let status = response.status();
        let session = response
            .headers()
            .get(HEADER_SESSION_ID)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        if status == reqwest::StatusCode::ACCEPTED || status == reqwest::StatusCode::NO_CONTENT {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        if !status.is_success() {
            if !session_attached {
                // The TypeScript SDK throws `StreamableHTTPError(status)` for every failed POST;
                // before a session exists that status is what decides the SSE fallback.
                return Err(status_error(response).await);
            }
            if status == reqwest::StatusCode::NOT_FOUND {
                return Err(StreamableHttpError::SessionExpired);
            }
            let is_json =
                content_type(&response).is_some_and(|value| value.starts_with(JSON_MIME_TYPE));
            if !is_json {
                return Err(status_error(response).await);
            }
            let text = response.text().await.unwrap_or_default();
            return match serde_json::from_str::<ServerJsonRpcMessage>(&text) {
                Ok(error @ JsonRpcMessage::Error(_)) => {
                    Ok(StreamableHttpPostResponse::Json(error, session))
                }
                _ => Err(StreamableHttpError::Client(HttpError::Status {
                    status: status.as_u16(),
                    body: text,
                })),
            };
        }
        if expects_no_reply(&message) && response.content_length() == Some(0) {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        match content_type(&response) {
            Some(value) if value.starts_with(EVENT_STREAM_MIME_TYPE) => Ok(
                StreamableHttpPostResponse::Sse(bounded_sse(response, max_sse_event_size), session),
            ),
            Some(value) if value.starts_with(JSON_MIME_TYPE) => {
                let bytes = response
                    .bytes()
                    .await
                    .map_err(|error| StreamableHttpError::Client(error.into()))?;
                match serde_json::from_slice::<ServerJsonRpcMessage>(&bytes) {
                    Ok(parsed) => Ok(StreamableHttpPostResponse::Json(parsed, session)),
                    Err(_) if expects_no_reply(&message) => {
                        Ok(StreamableHttpPostResponse::Accepted)
                    }
                    Err(error) => Err(StreamableHttpError::UnexpectedServerResponse(Cow::Owned(
                        format!("response is not JSON-RPC: {error}"),
                    ))),
                }
            }
            other if expects_no_reply(&message) && other.is_none() => {
                Ok(StreamableHttpPostResponse::Accepted)
            }
            other => Err(StreamableHttpError::UnexpectedContentType(other)),
        }
    }

    async fn delete_session(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> HttpResult<()> {
        let response = apply(
            self.client.delete(uri.as_ref()),
            custom_headers,
            auth_header,
        )
        .header(HEADER_SESSION_ID, session_id.as_ref())
        .send()
        .await
        .map_err(|error| StreamableHttpError::Client(error.into()))?;
        let status = response.status();
        if status.is_success() || status == reqwest::StatusCode::METHOD_NOT_ALLOWED {
            return Ok(());
        }
        Err(status_error(response).await)
    }

    async fn get_stream(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> HttpResult<BoxStream<'static, Result<Sse, SseError>>> {
        self.get_stream_with_max_sse_event_size(
            uri,
            session_id,
            last_event_id,
            auth_header,
            custom_headers,
            MAX_SSE_EVENT_BYTES,
        )
        .await
    }

    async fn get_stream_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        max_sse_event_size: usize,
    ) -> HttpResult<BoxStream<'static, Result<Sse, SseError>>> {
        let mut request = apply(self.client.get(uri.as_ref()), custom_headers, auth_header)
            .header(reqwest::header::ACCEPT, EVENT_STREAM_MIME_TYPE);
        if let Some(session) = session_id {
            request = request.header(HEADER_SESSION_ID, session.as_ref());
        }
        if let Some(last) = last_event_id {
            request = request.header(HEADER_LAST_EVENT_ID, last);
        }
        let response = request
            .send()
            .await
            .map_err(|error| StreamableHttpError::Client(error.into()))?;
        if response.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED {
            return Err(StreamableHttpError::ServerDoesNotSupportSse);
        }
        if !response.status().is_success() {
            return Err(status_error(response).await);
        }
        match content_type(&response) {
            Some(value) if value.starts_with(EVENT_STREAM_MIME_TYPE) => {
                Ok(bounded_sse(response, max_sse_event_size))
            }
            other => Err(StreamableHttpError::UnexpectedContentType(other)),
        }
    }
}

/// Parses a response body as SSE, refusing any single event larger than `max_event_bytes`.
pub(crate) fn bounded_sse(
    response: reqwest::Response,
    max_event_bytes: usize,
) -> BoxStream<'static, Result<Sse, SseError>> {
    let bytes = BoundedEvents {
        inner: response.bytes_stream().boxed(),
        limit: EventLimit::new(max_event_bytes),
        failed: false,
    };
    SseStream::from_bytes_stream(bytes).boxed()
}

/// Counts the bytes of the event being received; a blank line ends an event.
struct EventLimit {
    max: usize,
    event: usize,
    line_empty: bool,
    after_cr: bool,
}

impl EventLimit {
    fn new(max: usize) -> Self {
        Self {
            max,
            event: 0,
            line_empty: true,
            after_cr: false,
        }
    }

    fn observe(&mut self, chunk: &[u8]) -> Result<(), usize> {
        for &byte in chunk {
            if std::mem::take(&mut self.after_cr) && byte == b'\n' {
                continue;
            }
            if byte == b'\r' || byte == b'\n' {
                self.after_cr = byte == b'\r';
                if self.line_empty {
                    self.event = 0;
                }
                self.line_empty = true;
                continue;
            }
            self.line_empty = false;
            self.event += 1;
            if self.event > self.max {
                return Err(self.max);
            }
        }
        Ok(())
    }
}

/// Why an SSE body stopped: the connection failed, or one event outgrew the bound.
#[derive(Debug)]
enum BodyError {
    Read(reqwest::Error),
    TooLarge(usize),
}

impl std::fmt::Display for BodyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read(error) => write!(formatter, "{error}"),
            Self::TooLarge(max) => write!(
                formatter,
                "SSE event exceeded {max} bytes; expected smaller events"
            ),
        }
    }
}

impl std::error::Error for BodyError {}

struct BoundedEvents {
    inner: BoxStream<'static, Result<Bytes, reqwest::Error>>,
    limit: EventLimit,
    failed: bool,
}

impl Stream for BoundedEvents {
    type Item = Result<Bytes, BodyError>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.failed {
            return Poll::Ready(None);
        }
        match self.inner.poll_next_unpin(context) {
            Poll::Ready(Some(Ok(chunk))) => match self.limit.observe(&chunk) {
                Ok(()) => Poll::Ready(Some(Ok(chunk))),
                Err(max) => {
                    self.failed = true;
                    Poll::Ready(Some(Err(BodyError::TooLarge(max))))
                }
            },
            Poll::Ready(Some(Err(error))) => {
                self.failed = true;
                Poll::Ready(Some(Err(BodyError::Read(error))))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_and_https_urls_are_accepted() {
        assert!(endpoint_url("http://127.0.0.1:9/mcp").is_ok());
        assert!(endpoint_url("https://mcp.example.test/mcp").is_ok());
        // Plain HTTP to a public host is allowed here: that decision belongs to the hub.
        assert!(endpoint_url("http://mcp.example.test/mcp").is_ok());
        let scheme = endpoint_url("ftp://example.test/").expect_err("expected ftp refused");
        assert!(
            scheme.contains("\"ftp\"") && scheme.contains("expected an http:// or https:// URL"),
            "expected the refusal to name the value and the expected shape | received {scheme}"
        );
        let invalid = endpoint_url("not a url").expect_err("expected a parse refusal");
        assert!(
            invalid.contains("\"not a url\"") && invalid.contains("expected an absolute"),
            "expected the refusal to name the value and the expected shape | received {invalid}"
        );
    }

    #[test]
    fn header_refusals_name_the_header_but_never_the_value() {
        let bad_value = BTreeMap::from([("X-Token".to_owned(), "secret\nvalue".to_owned())]);
        let error = header_map(&bad_value).expect_err("expected a refused value");
        assert!(
            error.contains("\"X-Token\""),
            "expected the header named | received {error}"
        );
        assert!(
            !error.contains("secret"),
            "expected no secret in the refusal | received {error}"
        );
        let bad_name = BTreeMap::from([("bad name".to_owned(), "v".to_owned())]);
        assert!(header_map(&bad_name).is_err());
    }

    #[test]
    fn protocol_headers_are_owned_by_the_transport() {
        let headers = BTreeMap::from([
            ("Accept".to_owned(), "text/html".to_owned()),
            ("Mcp-Session-Id".to_owned(), "forged".to_owned()),
            ("Authorization".to_owned(), "Bearer token".to_owned()),
        ]);
        let map = header_map(&headers).expect("valid headers");
        assert_eq!(
            map.len(),
            1,
            "expected only Authorization kept | received {map:?}"
        );
        let value = map
            .get(&HeaderName::from_static("authorization"))
            .expect("Authorization is forwarded");
        assert!(
            value.is_sensitive(),
            "expected secret headers marked sensitive"
        );
    }

    #[test]
    fn event_limit_counts_one_event_at_a_time() {
        let mut limit = EventLimit::new(8);
        assert_eq!(limit.observe(b"data: 1\n\ndata: 2\n\n"), Ok(()));
        assert_eq!(limit.observe(b"data: 1\r\n\r\ndata: 2\r\n\r\n"), Ok(()));
        let mut limit = EventLimit::new(8);
        assert_eq!(limit.observe(b"data: 1\ndata: 2\n"), Err(8));
    }
}
