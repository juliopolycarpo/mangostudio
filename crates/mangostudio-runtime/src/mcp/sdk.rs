//! The only module that depends on `rmcp`: it opens SDK sessions and maps every SDK result and
//! error onto the project types in [`super::types`].

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use rmcp::model::{
    CancelledNotificationParam, ClientCapabilities, ClientConfig, ClientRequest, Implementation,
    ListToolsRequest, PaginatedRequestParams, ProtocolVersion, ServerResult,
};
use rmcp::service::{
    ClientInitializeError, Peer, PeerRequestOptions, RunningService, ServiceError,
};
use rmcp::transport::IntoTransport;
use rmcp::transport::streamable_http_client::{
    StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
};
use rmcp::{RoleClient, ServiceExt};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::client::{ClientFuture, ConnectContext, McpClient, McpConnector};
use super::http::{McpHttp, endpoint_url, header_map, http_client, should_fall_back_to_sse};
use super::process::{GuardedStdioSpawner, ProcessOwner, StartError, StdioSpawner};
use super::sse::LegacySse;
use super::stdio::stdio_launch;
use super::types::{
    CallFailure, McpConfig, McpFailure, McpSecrets, RequestOptions, ServerCapabilities,
    timeout_from,
};

/// Upper bound on list pages, so a server that never stops paginating cannot hold a request.
const MAX_PAGES: usize = 256;
/// Bound on delivering a `notifications/cancelled` after a caller gives up.
const CANCEL_NOTICE_TIMEOUT: Duration = Duration::from_secs(1);
/// The MCP revision this client advertises, pinned to what the TypeScript SDK 1.30 host sends
/// so moving to the Rust runtime never silently changes what servers are told.
const PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion::V_2025_11_25;

type SdkService = RunningService<RoleClient, ClientConfig>;

/// Opens sessions through the pinned SDK: stdio children are owned by the shared guardian or Job
/// supervisor rather than by the SDK, and HTTP rows use [`McpHttp`] with the legacy SSE fallback.
///
/// # Example
/// ```ignore
/// let connector = SdkConnector::new("0.1.1");
/// let client = connector.connect(&config, &secrets, context).await?;
/// ```
pub(crate) struct SdkConnector {
    runtime_version: String,
    spawner: Arc<dyn StdioSpawner>,
}

impl SdkConnector {
    pub(crate) fn new(runtime_version: impl Into<String>) -> Self {
        Self {
            runtime_version: runtime_version.into(),
            spawner: Arc::new(GuardedStdioSpawner::default()),
        }
    }

    fn client_config(&self) -> ClientConfig {
        ClientConfig::new(
            ClientCapabilities::default(),
            Implementation::new("mangostudio", &self.runtime_version),
        )
        .with_protocol_version(PROTOCOL_VERSION)
    }

    /// Runs the MCP `initialize` handshake over `transport`, bounded by the row's timeout and
    /// the caller's cancellation. The inner result is the SDK's own, so the HTTP path can decide
    /// whether a refusal means "retry over SSE".
    async fn initialize<T, E, A>(
        &self,
        config: &McpConfig,
        timeout: Duration,
        cancel: &CancellationToken,
        transport: T,
    ) -> Result<Result<SdkService, ClientInitializeError>, McpFailure>
    where
        T: IntoTransport<RoleClient, E, A>,
        E: std::error::Error + Send + Sync + 'static,
    {
        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(McpFailure::cancelled(format!(
                "MCP server \"{}\" connect was cancelled during initialize",
                config.slug
            ))),
            result = tokio::time::timeout(timeout, self.client_config().serve(transport)) => {
                result.map_err(|_| connect_failure(config)(format!(
                    "the server did not initialize within {} ms",
                    timeout.as_millis()
                )))
            }
        }
    }

    async fn connect_stdio(
        &self,
        config: &McpConfig,
        secrets: &McpSecrets,
        context: ConnectContext,
    ) -> Result<Arc<dyn McpClient>, McpFailure> {
        let timeout =
            timeout_from(config.timeout_ms, &config.slug).map_err(connect_failure(config))?;
        let launch = stdio_launch(config, secrets, &crate::config::ProcessEnv)
            .map_err(connect_failure(config))?;
        let command = launch.program.to_string_lossy().into_owned();
        let owned = self
            .spawner
            .start(launch, context.launch_check, context.cancel.clone())
            .await
            .map_err(|error| start_failure(config, &command, error))?;
        let process = owned.process.clone();
        let initialized = self
            .initialize(
                config,
                timeout,
                &context.cancel,
                (owned.stdout, owned.stdin),
            )
            .await
            .and_then(|result| result.map_err(|error| connect_failure(config)(error.to_string())));
        match initialized {
            Ok(service) => finish(config, service, Some(process)).await,
            Err(failure) => {
                // The SDK transport, and with it stdin, is already gone on every error path; the
                // process tree is not until its owner proves it.
                let _ = process.close().await;
                Err(failure)
            }
        }
    }

    /// Streamable HTTP first; a 4xx answer to its `initialize` retries over legacy HTTP+SSE.
    async fn connect_http(
        &self,
        config: &McpConfig,
        secrets: &McpSecrets,
        context: ConnectContext,
    ) -> Result<Arc<dyn McpClient>, McpFailure> {
        let Some(raw) = config.url.as_deref().filter(|url| !url.trim().is_empty()) else {
            return Err(McpFailure::connection(format!(
                "MCP server \"{}\" has no URL configured.",
                config.slug
            )));
        };
        let timeout =
            timeout_from(config.timeout_ms, &config.slug).map_err(connect_failure(config))?;
        let url = endpoint_url(raw).map_err(connect_failure(config))?;
        let headers = header_map(&secrets.headers).map_err(connect_failure(config))?;
        let client = http_client().map_err(connect_failure(config))?;
        let streamable = StreamableHttpClientTransport::with_client(
            McpHttp::new(client.clone()),
            StreamableHttpClientTransportConfig::with_uri(url.as_str())
                .custom_headers(headers.clone())
                .reinit_on_expired_session(false),
        );
        match self
            .initialize(config, timeout, &context.cancel, streamable)
            .await?
        {
            Ok(service) => return finish(config, service, None).await,
            Err(error) if should_fall_back_to_sse(&error) => {}
            Err(error) => return Err(connect_failure(config)(error.to_string())),
        }
        let opened = tokio::select! {
            biased;
            () = context.cancel.cancelled() => {
                return Err(McpFailure::cancelled(format!(
                    "MCP server \"{}\" connect was cancelled during initialize",
                    config.slug
                )));
            }
            opened = tokio::time::timeout(timeout, LegacySse::open(client, url, headers)) => opened,
        };
        let legacy = opened
            .map_err(|_| {
                connect_failure(config)(format!(
                    "the server did not open its SSE stream within {} ms",
                    timeout.as_millis()
                ))
            })?
            .map_err(|error| connect_failure(config)(error.0))?;
        let service = self
            .initialize(config, timeout, &context.cancel, legacy)
            .await?
            .map_err(|error| connect_failure(config)(error.to_string()))?;
        finish(config, service, None).await
    }
}

/// Wraps an initialized SDK session in the project-owned client.
async fn finish(
    config: &McpConfig,
    service: SdkService,
    process: Option<ProcessOwner>,
) -> Result<Arc<dyn McpClient>, McpFailure> {
    let Some(server) = service.peer_info() else {
        let _ = service.cancel().await;
        if let Some(process) = process {
            let _ = process.close().await;
        }
        return Err(connect_failure(config)(
            "the server returned no initialize information".to_owned(),
        ));
    };
    let capabilities = ServerCapabilities {
        tools: server.capabilities.tools.is_some(),
        resources: server.capabilities.resources.is_some(),
        prompts: server.capabilities.prompts.is_some(),
    };
    let peer = service.peer().clone();
    Ok(Arc::new(SdkClient {
        peer,
        service: Mutex::new(Some(service)),
        process,
        capabilities,
    }))
}

impl McpConnector for SdkConnector {
    fn connect<'a>(
        &'a self,
        config: &'a McpConfig,
        secrets: &'a McpSecrets,
        context: ConnectContext,
    ) -> ClientFuture<'a, Arc<dyn McpClient>> {
        Box::pin(async move {
            match config.transport.as_str() {
                "stdio" => self.connect_stdio(config, secrets, context).await,
                "http" => self.connect_http(config, secrets, context).await,
                other => Err(connect_failure(config)(format!(
                    "transport \"{other}\" is not supported; expected stdio or http"
                ))),
            }
        })
    }
}

/// The TypeScript host's connection message: `Failed to connect to MCP server "<slug>": ...`.
fn connect_failure(config: &McpConfig) -> impl Fn(String) -> McpFailure + '_ {
    move |detail| {
        McpFailure::connection(format!(
            "Failed to connect to MCP server \"{}\": {detail}",
            config.slug
        ))
    }
}

fn start_failure(config: &McpConfig, command: &str, error: StartError) -> McpFailure {
    let detail = match error {
        StartError::Cancelled => {
            return McpFailure::cancelled(format!(
                "MCP server \"{}\" connect was cancelled before launch",
                config.slug
            ));
        }
        StartError::LaunchDenied(error) => return McpFailure::denied(error.message),
        StartError::LimitExceeded => format!(
            "{} stdio MCP servers are already running; expected a free slot",
            super::process::MAX_MCP_CHILDREN
        ),
        StartError::Spawn(error) => format!("command \"{command}\" could not start: {error}"),
        StartError::Unavailable => "the launch owner stopped before reporting a result".to_owned(),
    };
    connect_failure(config)(detail)
}

/// A connected SDK session plus, for stdio, the owner of its process tree.
struct SdkClient {
    peer: Peer<RoleClient>,
    service: Mutex<Option<SdkService>>,
    process: Option<ProcessOwner>,
    capabilities: ServerCapabilities,
}

impl McpClient for SdkClient {
    fn capabilities(&self) -> ServerCapabilities {
        self.capabilities
    }

    fn list_tools(&self, options: RequestOptions) -> ClientFuture<'_, Vec<Value>> {
        Box::pin(async move {
            let mut tools = Vec::new();
            let mut cursor = None;
            let mut seen = HashSet::new();
            for _ in 0..MAX_PAGES {
                let params = PaginatedRequestParams::default().with_cursor(cursor);
                let request = ClientRequest::ListToolsRequest(ListToolsRequest::with_param(params));
                let ServerResult::ListToolsResult(page) =
                    request_once(&self.peer, request, &options).await?
                else {
                    return Err(unexpected("tools/list"));
                };
                tools.extend(page.tools.into_iter().map(|tool| {
                    json!({
                        "name": tool.name,
                        "description": tool.description.as_deref().unwrap_or_default(),
                        "inputSchema": Value::Object((*tool.input_schema).clone()),
                    })
                }));
                let Some(next) = page.next_cursor else {
                    return Ok(tools);
                };
                if !seen.insert(next.clone()) {
                    return Err(McpFailure::call(
                        CallFailure::Other,
                        format!("MCP tools/list repeated cursor \"{next}\"; expected a new cursor"),
                    ));
                }
                cursor = Some(next);
            }
            Err(McpFailure::call(
                CallFailure::Other,
                format!("MCP tools/list exceeded {MAX_PAGES} pages; expected a final page"),
            ))
        })
    }

    fn close(&self) -> ClientFuture<'_, ()> {
        Box::pin(async move {
            // Stopping the SDK drops its transport, which closes a stdio child's stdin: that EOF
            // is the server's first chance to exit before its owner escalates.
            let service = self.service.lock().await.take();
            if let Some(service) = service {
                let _ = service.cancel().await;
            }
            if let Some(process) = &self.process {
                process
                    .close()
                    .await
                    .map_err(|message| McpFailure::call(CallFailure::Other, message))?;
            }
            Ok(())
        })
    }
}

/// Sends one request, racing the caller's cancellation and the request bound against the reply.
///
/// Exactly one outcome settles: a reply, a timeout, or a cancellation. The latter two also tell
/// the server with `notifications/cancelled`, as the TypeScript SDK does on abort and timeout.
async fn request_once(
    peer: &Peer<RoleClient>,
    request: ClientRequest,
    options: &RequestOptions,
) -> Result<ServerResult, McpFailure> {
    if options.cancel.is_cancelled() {
        return Err(McpFailure::cancelled("the MCP request was cancelled"));
    }
    let handle = peer
        .send_cancellable_request(request, PeerRequestOptions::no_options())
        .await
        .map_err(service_failure)?;
    let id = handle.id.clone();
    let notifier = handle.peer.clone();
    let (reason, failure) = tokio::select! {
        biased;
        () = options.cancel.cancelled() => (
            "cancelled",
            McpFailure::cancelled("the MCP request was cancelled"),
        ),
        reply = tokio::time::timeout(options.timeout, handle.await_response()) => match reply {
            Ok(reply) => return reply.map_err(service_failure),
            Err(_) => (
                "request timeout",
                McpFailure::call(CallFailure::Timeout, "MCP error -32001: Request timed out"),
            ),
        },
    };
    let notice = CancelledNotificationParam::new(Some(id), Some(reason.to_owned()));
    let _ = tokio::time::timeout(CANCEL_NOTICE_TIMEOUT, notifier.notify_cancelled(notice)).await;
    Err(failure)
}

/// Maps an SDK failure onto the hub's classification, with the TypeScript SDK's message text.
fn service_failure(error: ServiceError) -> McpFailure {
    match error {
        ServiceError::McpError(error) => McpFailure::call(
            CallFailure::Other,
            format!("MCP error {}: {}", error.code.0, error.message),
        ),
        ServiceError::TransportClosed
        | ServiceError::TransportSend(_)
        | ServiceError::Cancelled { .. } => McpFailure::call(
            CallFailure::ServerClosed,
            "MCP error -32000: Connection closed",
        ),
        ServiceError::Timeout { .. } => {
            McpFailure::call(CallFailure::Timeout, "MCP error -32001: Request timed out")
        }
        other => McpFailure::call(CallFailure::Other, other.to_string()),
    }
}

fn unexpected(method: &str) -> McpFailure {
    McpFailure::call(
        CallFailure::Other,
        format!("MCP server answered {method} with an unexpected result shape"),
    )
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::mcp::fake_http::{FakeHttpMcpServer, Mode, Recorded};
    use crate::subprocess::AlwaysAllow;

    fn fixture_config() -> McpConfig {
        let fixture =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcp_server.mjs");
        McpConfig {
            id: "fixture".into(),
            slug: "fixture".into(),
            transport: "stdio".into(),
            command: Some("bun".into()),
            args: vec![fixture.to_string_lossy().into_owned()],
            env: BTreeMap::new(),
            url: None,
            timeout_ms: Some(10_000.0),
        }
    }

    fn allowed() -> ConnectContext {
        ConnectContext {
            launch_check: Arc::new(AlwaysAllow),
            cancel: CancellationToken::new(),
        }
    }

    fn options() -> RequestOptions {
        RequestOptions {
            timeout: Duration::from_secs(10),
            cancel: CancellationToken::new(),
        }
    }

    #[tokio::test]
    async fn stdio_connector_initializes_and_reads_every_tool_page() {
        let client = SdkConnector::new("1.2.3")
            .connect(&fixture_config(), &McpSecrets::default(), allowed())
            .await
            .unwrap_or_else(|failure| {
                panic!("expected a connected fixture | received {failure:?}")
            });
        assert_eq!(
            client.capabilities(),
            ServerCapabilities {
                tools: true,
                resources: false,
                prompts: false
            }
        );
        let tools = client
            .list_tools(options())
            .await
            .expect("both tool pages succeed");
        assert_eq!(
            tools,
            vec![
                json!({"name": "first", "description": "First page", "inputSchema": {"type": "object"}}),
                json!({"name": "second", "description": "Second page", "inputSchema": {"type": "object"}}),
            ]
        );
        client.close().await.expect("the stdio child closes");
    }

    #[tokio::test]
    async fn an_unknown_transport_is_a_typed_connection_failure() {
        let mut config = fixture_config();
        config.transport = "carrier-pigeon".into();
        let failure = SdkConnector::new("1.2.3")
            .connect(&config, &McpSecrets::default(), allowed())
            .await
            .err()
            .expect("expected a refused transport");
        assert_eq!(failure.kind, super::super::types::FailureKind::Connection);
        assert!(
            failure.message.starts_with(
                "Failed to connect to MCP server \"fixture\": transport \"carrier-pigeon\""
            ),
            "expected the TypeScript connection message shape | received {}",
            failure.message
        );
    }

    fn http_config(url: &str) -> McpConfig {
        McpConfig {
            id: "remote".into(),
            slug: "remote".into(),
            transport: "http".into(),
            command: None,
            args: vec![],
            env: BTreeMap::new(),
            url: Some(url.to_owned()),
            timeout_ms: Some(10_000.0),
        }
    }

    fn secret_headers() -> McpSecrets {
        McpSecrets {
            headers: BTreeMap::from([
                ("Authorization".to_owned(), "Bearer row-token".to_owned()),
                ("X-Api-Key".to_owned(), "row-key".to_owned()),
            ]),
            ..McpSecrets::default()
        }
    }

    fn assert_row_headers(request: &Recorded) {
        assert_eq!(
            (
                request.headers.get("authorization").map(String::as_str),
                request.headers.get("x-api-key").map(String::as_str),
            ),
            (Some("Bearer row-token"), Some("row-key")),
            "expected both row headers on {} {} | received {:?}",
            request.method,
            request.path,
            request.headers
        );
    }

    async fn connect_http(config: &McpConfig) -> Result<Arc<dyn McpClient>, McpFailure> {
        SdkConnector::new("1.2.3")
            .connect(config, &secret_headers(), allowed())
            .await
    }

    #[tokio::test]
    async fn streamable_http_lists_tools_with_row_headers_on_every_request() {
        let server = FakeHttpMcpServer::start(Mode::Streamable).await;
        let client = connect_http(&http_config(&server.url))
            .await
            .unwrap_or_else(|failure| {
                panic!("expected a streamable session | received {failure:?}")
            });
        let tools = client
            .list_tools(options())
            .await
            .expect("tools/list succeeds");
        assert_eq!(tools[0]["name"], json!("http-tool"));
        client.close().await.expect("the HTTP session closes");
        let requests = server.recorded();
        let posts: Vec<_> = requests.iter().filter(|r| r.method == "POST").collect();
        assert!(
            posts.len() >= 3,
            "expected initialize, initialized, and tools/list POSTs | received {requests:?}"
        );
        for request in &requests {
            assert_row_headers(request);
        }
        assert_eq!(
            posts[1].headers.get("mcp-session-id").map(String::as_str),
            Some("fake-session"),
            "expected the session id echoed after initialize"
        );
    }

    #[tokio::test]
    async fn a_4xx_initialize_falls_back_to_legacy_sse() {
        for post_status in [400, 401, 403, 404, 405] {
            let server = FakeHttpMcpServer::start(Mode::LegacySse {
                post_status,
                cross_origin: false,
            })
            .await;
            let client = connect_http(&http_config(&server.url))
                .await
                .unwrap_or_else(|failure| {
                    panic!(
                        "expected an SSE session after HTTP {post_status} | received {failure:?}"
                    )
                });
            let tools = client
                .list_tools(options())
                .await
                .expect("tools/list over SSE");
            assert_eq!(tools[0]["name"], json!("http-tool"));
            client.close().await.expect("the SSE session closes");
            let requests = server.recorded();
            let stream = requests
                .iter()
                .find(|r| r.method == "GET" && r.path == "/mcp")
                .unwrap_or_else(|| {
                    panic!("expected the SSE GET after HTTP {post_status} | received {requests:?}")
                });
            assert_eq!(
                stream.headers.get("accept").map(String::as_str),
                Some("text/event-stream")
            );
            let posts: Vec<_> = requests
                .iter()
                .filter(|r| r.method == "POST" && r.path.starts_with("/messages"))
                .collect();
            assert!(
                !posts.is_empty(),
                "expected message POSTs to the endpoint | received {requests:?}"
            );
            for request in &requests {
                assert_row_headers(request);
            }
        }
    }

    #[tokio::test]
    async fn a_5xx_initialize_does_not_fall_back() {
        let server = FakeHttpMcpServer::start(Mode::Status(500)).await;
        let failure = connect_http(&http_config(&server.url))
            .await
            .err()
            .expect("expected HTTP 500 to fail the connect");
        assert_eq!(failure.kind, super::super::types::FailureKind::Connection);
        assert!(
            failure
                .message
                .starts_with("Failed to connect to MCP server \"remote\":")
                && failure.message.contains("HTTP 500"),
            "expected the status in the connection message | received {}",
            failure.message
        );
        let requests = server.recorded();
        assert!(
            requests.iter().all(|r| r.method == "POST"),
            "expected no SSE GET after a 5xx | received {requests:?}"
        );
    }

    #[tokio::test]
    async fn a_refused_connection_does_not_fall_back() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let url = format!("http://{}/mcp", listener.local_addr().expect("address"));
        drop(listener);
        let failure = connect_http(&http_config(&url))
            .await
            .err()
            .expect("expected a refused connection to fail");
        assert_eq!(failure.kind, super::super::types::FailureKind::Connection);
    }

    #[tokio::test]
    async fn a_cross_origin_sse_endpoint_is_refused() {
        let server = FakeHttpMcpServer::start(Mode::LegacySse {
            post_status: 404,
            cross_origin: true,
        })
        .await;
        let failure = connect_http(&http_config(&server.url))
            .await
            .err()
            .expect("expected a cross-origin endpoint refused");
        assert!(
            failure.message.contains(
                "Endpoint origin does not match connection origin: http://attacker.invalid"
            ),
            "expected the origin refusal | received {}",
            failure.message
        );
        assert!(
            server
                .recorded()
                .iter()
                .all(|r| !r.path.starts_with("/messages")),
            "expected nothing posted to the foreign endpoint"
        );
    }

    #[tokio::test]
    async fn an_http_row_without_a_url_uses_the_typescript_message() {
        let mut config = http_config("http://127.0.0.1:9/mcp");
        config.url = None;
        let failure = connect_http(&config)
            .await
            .err()
            .expect("expected a refusal");
        assert_eq!(
            failure,
            McpFailure::connection("MCP server \"remote\" has no URL configured.")
        );
    }

    #[test]
    fn sdk_failures_map_onto_the_hub_classification() {
        let closed = service_failure(ServiceError::TransportClosed);
        assert_eq!(
            closed,
            McpFailure::call(
                CallFailure::ServerClosed,
                "MCP error -32000: Connection closed"
            )
        );
        let timeout = service_failure(ServiceError::Timeout {
            timeout: Duration::from_secs(1),
        });
        assert_eq!(
            timeout.kind,
            super::super::types::FailureKind::Call(CallFailure::Timeout)
        );
        let remote = service_failure(ServiceError::McpError(rmcp::model::ErrorData::new(
            rmcp::model::ErrorCode(-32602),
            "bad params",
            None,
        )));
        assert_eq!(
            remote,
            McpFailure::call(CallFailure::Other, "MCP error -32602: bad params")
        );
    }
}
