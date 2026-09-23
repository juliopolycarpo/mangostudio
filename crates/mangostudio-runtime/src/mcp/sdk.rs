//! The only module that depends on `rmcp`: it opens SDK sessions and maps every SDK result and
//! error onto the project types in [`super::types`].

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use rmcp::model::{
    CallToolRequest, CallToolRequestParams, CancelledNotificationParam, ClientCapabilities,
    ClientConfig, ClientRequest, ElicitRequestParams, ElicitResult,
    ElicitationAction as RmcpElicitationAction, ErrorData, GetPromptRequest,
    GetPromptRequestParams, Implementation, ListPromptsRequest, ListResourcesRequest,
    ListToolsRequest, PaginatedRequestParams, ProtocolVersion, ReadResourceRequest,
    ReadResourceRequestParams, ServerResult,
};
use rmcp::service::{
    ClientInitializeError, Peer, PeerRequestOptions, RunningService, ServiceError,
};
use rmcp::service::{NotificationContext, RequestContext, RunningServiceCancellationToken};
use rmcp::transport::IntoTransport;
use rmcp::transport::streamable_http_client::{
    StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
};
use rmcp::{ClientHandler, RoleClient, ServiceExt};
use serde_json::{Map, Value, json};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::client::{
    ClientFuture, ConnectContext, ElicitationAction, ElicitationAnswer, ElicitationRequest,
    McpClient, McpConnector, SessionHooks,
};
use super::content;
use super::elicitation_order::{ObservedLines, SchemaOrder};
use super::elicitation_schema::flatten_elicitation_schema;
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

type SdkService = RunningService<RoleClient, Handler>;

/// The tool call a session is currently running, which owns any question the server asks.
#[derive(Clone)]
struct ActiveCall {
    id: String,
    cancel: CancellationToken,
}

type Active = Arc<std::sync::Mutex<Option<ActiveCall>>>;

/// The SDK-facing side of one session: answers server requests and forwards notifications.
struct Handler {
    info: ClientConfig,
    slug: String,
    hooks: SessionHooks,
    active: Active,
    order: Arc<SchemaOrder>,
}

impl ClientHandler for Handler {
    fn get_info(&self) -> ClientConfig {
        self.info.clone()
    }

    /// Mirrors the TypeScript host's `ElicitRequestSchema` handler: only form mode, only inside a
    /// tool call with a hub-minted id, and the hub's answer (or a withdrawal) goes back as-is.
    async fn create_elicitation(
        &self,
        request: ElicitRequestParams,
        context: RequestContext<RoleClient>,
    ) -> Result<ElicitResult, ErrorData> {
        let order = serde_json::to_string(&context.id)
            .ok()
            .and_then(|id| self.order.take(&id));
        let ElicitRequestParams::FormElicitationParams {
            message,
            requested_schema,
            ..
        } = request
        else {
            (self.hooks.diagnostic)(
                "mcp_elicitation_unsupported_mode",
                &[("serverSlug", &self.slug), ("mode", "url")],
            );
            return Ok(ElicitResult::new(RmcpElicitationAction::Cancel));
        };
        let active = self
            .active
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        let Some(active) = active else {
            (self.hooks.diagnostic)(
                "mcp_elicitation_outside_tool_call",
                &[("serverSlug", &self.slug)],
            );
            return Ok(ElicitResult::new(RmcpElicitationAction::Cancel));
        };
        let schema = serde_json::to_value(&requested_schema).unwrap_or(Value::Null);
        let cancel = active.cancel.child_token();
        let mut answer = (self.hooks.elicit)(ElicitationRequest {
            tool_call_id: active.id,
            message,
            fields: flatten_elicitation_schema(&schema, order.as_deref()),
            cancel: cancel.clone(),
        });
        let answer = tokio::select! {
            answer = &mut answer => answer,
            // The server withdrew the question (`notifications/cancelled`) or the session ended:
            // cancel the parked entry and let it settle once through the same path.
            () = context.ct.cancelled() => {
                cancel.cancel();
                answer.await
            }
        };
        Ok(elicit_result(answer))
    }

    async fn on_tool_list_changed(&self, _context: NotificationContext<RoleClient>) {
        (self.hooks.tool_list_changed)();
    }
}

fn elicit_result(answer: ElicitationAnswer) -> ElicitResult {
    match answer.action {
        ElicitationAction::Accept => ElicitResult::new(RmcpElicitationAction::Accept)
            .with_content(Value::Object(answer.content.unwrap_or_default())),
        ElicitationAction::Decline => ElicitResult::new(RmcpElicitationAction::Decline),
        ElicitationAction::Cancel => ElicitResult::new(RmcpElicitationAction::Cancel),
    }
}

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

    /// The client identity and capabilities the TypeScript host declares: form elicitation only.
    fn handler(
        &self,
        config: &McpConfig,
        hooks: &SessionHooks,
        order: &Arc<SchemaOrder>,
    ) -> Handler {
        let capabilities: ClientCapabilities =
            serde_json::from_value(json!({ "elicitation": { "form": {} } })).unwrap_or_default();
        Handler {
            info: ClientConfig::new(
                capabilities,
                Implementation::new("mangostudio", &self.runtime_version),
            )
            .with_protocol_version(PROTOCOL_VERSION),
            slug: config.slug.clone(),
            hooks: hooks.clone(),
            active: Arc::default(),
            order: Arc::clone(order),
        }
    }

    /// Runs the MCP `initialize` handshake over `transport`, bounded by the row's timeout and
    /// the caller's cancellation. The inner result is the SDK's own, so the HTTP path can decide
    /// whether a refusal means "retry over SSE".
    async fn initialize<T, E, A>(
        handler: Handler,
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
            result = tokio::time::timeout(timeout, handler.serve(transport)) => {
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
        let order = Arc::new(SchemaOrder::default());
        let stdout = ObservedLines::new(owned.stdout, Arc::clone(&order));
        let handler = self.handler(config, &context.hooks, &order);
        let initialized = Self::initialize(
            handler,
            config,
            timeout,
            &context.cancel,
            (stdout, owned.stdin),
        )
        .await
        .and_then(|result| result.map_err(|error| connect_failure(config)(error.to_string())));
        match initialized {
            Ok(service) => finish(config, service, Some(process), context.hooks).await,
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
        let order = Arc::new(SchemaOrder::default());
        let streamable = StreamableHttpClientTransport::with_client(
            McpHttp::new(client.clone(), Arc::clone(&order)),
            StreamableHttpClientTransportConfig::with_uri(url.as_str())
                .custom_headers(headers.clone())
                .reinit_on_expired_session(false),
        );
        let handler = self.handler(config, &context.hooks, &order);
        match Self::initialize(handler, config, timeout, &context.cancel, streamable).await? {
            Ok(service) => return finish(config, service, None, context.hooks).await,
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
            opened = tokio::time::timeout(
                timeout,
                LegacySse::open(client, url, headers, Arc::clone(&order)),
            ) => opened,
        };
        let legacy = opened
            .map_err(|_| {
                connect_failure(config)(format!(
                    "the server did not open its SSE stream within {} ms",
                    timeout.as_millis()
                ))
            })?
            .map_err(|error| connect_failure(config)(error.0))?;
        let handler = self.handler(config, &context.hooks, &order);
        let service = Self::initialize(handler, config, timeout, &context.cancel, legacy)
            .await?
            .map_err(|error| connect_failure(config)(error.to_string()))?;
        finish(config, service, None, context.hooks).await
    }
}

/// Wraps an initialized SDK session in the project-owned client and starts watching for the
/// session to end on its own.
async fn finish(
    config: &McpConfig,
    service: SdkService,
    process: Option<ProcessOwner>,
    hooks: SessionHooks,
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
    let active = Arc::clone(&service.service().active);
    let stop = service.cancellation_token();
    let closed_by_us = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&closed_by_us);
    // Only a session that ends without the runtime asking reports `closed`: a server crash, a
    // dropped socket. A close the runtime started is its own caller's business.
    let watcher = tokio::spawn(async move {
        let _ = service.waiting().await;
        if !flag.load(Ordering::Acquire) {
            (hooks.closed)();
        }
    });
    Ok(Arc::new(SdkClient {
        peer,
        active,
        stop: Mutex::new(Some(stop)),
        watcher: Mutex::new(Some(watcher)),
        closed_by_us,
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
    active: Active,
    stop: Mutex<Option<RunningServiceCancellationToken>>,
    watcher: Mutex<Option<tokio::task::JoinHandle<()>>>,
    closed_by_us: Arc<AtomicBool>,
    process: Option<ProcessOwner>,
    capabilities: ServerCapabilities,
}

impl McpClient for SdkClient {
    fn capabilities(&self) -> ServerCapabilities {
        self.capabilities
    }

    fn list_tools(&self, options: RequestOptions) -> ClientFuture<'_, Vec<Value>> {
        Box::pin(paginate(
            &self.peer,
            options,
            "tools/list",
            |cursor| {
                let params = PaginatedRequestParams::default().with_cursor(cursor);
                ClientRequest::ListToolsRequest(ListToolsRequest::with_param(params))
            },
            |result| match result {
                ServerResult::ListToolsResult(page) => Some((
                    page.tools
                        .into_iter()
                        .map(|tool| {
                            json!({
                                "name": tool.name,
                                "description": tool.description.as_deref().unwrap_or_default(),
                                "inputSchema": Value::Object((*tool.input_schema).clone()),
                            })
                        })
                        .collect(),
                    page.next_cursor,
                )),
                _ => None,
            },
        ))
    }

    fn call_tool(
        &self,
        name: String,
        arguments: Map<String, Value>,
        tool_call_id: Option<String>,
        options: RequestOptions,
    ) -> ClientFuture<'_, Value> {
        Box::pin(async move {
            let params = CallToolRequestParams::new(name).with_arguments(arguments);
            let request = ClientRequest::CallToolRequest(CallToolRequest::new(params));
            // The service's FIFO gate runs one call per session at a time, so the active call is
            // unambiguous; it is cleared on every exit path by the guard below.
            let _active = ActiveGuard::set(&self.active, tool_call_id, &options.cancel);
            // Anything but a well-formed tool result is a failed call, as the TypeScript SDK's
            // result validation makes it; the result's content is then normalized, not trusted.
            let ServerResult::CallToolResult(result) =
                request_once(&self.peer, request, &options).await?
            else {
                return Err(unexpected("tools/call"));
            };
            Ok(content::call_result(&as_json(&result)))
        })
    }

    fn list_resources(&self, options: RequestOptions) -> ClientFuture<'_, Vec<Value>> {
        Box::pin(paginate(
            &self.peer,
            options,
            "resources/list",
            |cursor| {
                let params = PaginatedRequestParams::default().with_cursor(cursor);
                ClientRequest::ListResourcesRequest(ListResourcesRequest::with_param(params))
            },
            |result| match result {
                ServerResult::ListResourcesResult(page) => Some((
                    page.resources
                        .iter()
                        .map(|resource| content::resource_descriptor(&as_json(resource)))
                        .collect(),
                    page.next_cursor,
                )),
                _ => None,
            },
        ))
    }

    fn read_resource(&self, uri: String, options: RequestOptions) -> ClientFuture<'_, Vec<Value>> {
        Box::pin(async move {
            let request = ClientRequest::ReadResourceRequest(ReadResourceRequest::new(
                ReadResourceRequestParams::new(uri),
            ));
            let ServerResult::ReadResourceResult(result) =
                request_once(&self.peer, request, &options).await?
            else {
                return Err(unexpected("resources/read"));
            };
            Ok(result
                .contents
                .iter()
                .map(|entry| content::resource_contents(&as_json(entry)))
                .collect())
        })
    }

    fn list_prompts(&self, options: RequestOptions) -> ClientFuture<'_, Vec<Value>> {
        Box::pin(paginate(
            &self.peer,
            options,
            "prompts/list",
            |cursor| {
                let params = PaginatedRequestParams::default().with_cursor(cursor);
                ClientRequest::ListPromptsRequest(ListPromptsRequest::with_param(params))
            },
            |result| match result {
                ServerResult::ListPromptsResult(page) => Some((
                    page.prompts
                        .iter()
                        .map(|prompt| content::prompt_descriptor(&as_json(prompt)))
                        .collect(),
                    page.next_cursor,
                )),
                _ => None,
            },
        ))
    }

    fn get_prompt(
        &self,
        name: String,
        arguments: Option<BTreeMap<String, String>>,
        options: RequestOptions,
    ) -> ClientFuture<'_, Value> {
        Box::pin(async move {
            let mut params = GetPromptRequestParams::new(name);
            if let Some(arguments) = arguments {
                params = params.with_arguments(
                    arguments
                        .into_iter()
                        .map(|(key, value)| (key, Value::String(value)))
                        .collect(),
                );
            }
            let request = ClientRequest::GetPromptRequest(GetPromptRequest::new(params));
            let ServerResult::GetPromptResult(result) =
                request_once(&self.peer, request, &options).await?
            else {
                return Err(unexpected("prompts/get"));
            };
            Ok(content::prompt_result(&as_json(&result)))
        })
    }

    fn close(&self) -> ClientFuture<'_, ()> {
        Box::pin(async move {
            // Stopping the SDK drops its transport, which closes a stdio child's stdin: that EOF
            // is the server's first chance to exit before its owner escalates.
            self.closed_by_us.store(true, Ordering::Release);
            if let Some(stop) = self.stop.lock().await.take() {
                stop.cancel();
            }
            let watcher = self.watcher.lock().await.take();
            if let Some(watcher) = watcher {
                let _ = watcher.await;
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

/// Marks a tool call active for elicitation routing and clears it when the call ends.
struct ActiveGuard<'a>(&'a Active);

impl<'a> ActiveGuard<'a> {
    fn set(active: &'a Active, id: Option<String>, cancel: &CancellationToken) -> Self {
        let id = id
            .map(|id| id.trim().to_owned())
            .filter(|id| !id.is_empty());
        *active.lock().unwrap_or_else(|poison| poison.into_inner()) = id.map(|id| ActiveCall {
            id,
            cancel: cancel.clone(),
        });
        Self(active)
    }
}

impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) {
        *self.0.lock().unwrap_or_else(|poison| poison.into_inner()) = None;
    }
}

/// Serializes an SDK model back to the JSON the server sent, so mapping stays SDK-free.
fn as_json<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// Reads every page of a list method, refusing a repeated cursor or more than [`MAX_PAGES`].
async fn paginate(
    peer: &Peer<RoleClient>,
    options: RequestOptions,
    method: &'static str,
    request: impl Fn(Option<String>) -> ClientRequest,
    page: impl Fn(ServerResult) -> Option<(Vec<Value>, Option<String>)>,
) -> Result<Vec<Value>, McpFailure> {
    let mut items = Vec::new();
    let mut cursor = None;
    let mut seen = HashSet::new();
    for _ in 0..MAX_PAGES {
        let result = request_once(peer, request(cursor), &options).await?;
        let (entries, next) = page(result).ok_or_else(|| unexpected(method))?;
        items.extend(entries);
        let Some(next) = next else {
            return Ok(items);
        };
        if !seen.insert(next.clone()) {
            return Err(McpFailure::call(
                CallFailure::Other,
                format!("MCP {method} repeated cursor \"{next}\"; expected a new cursor"),
            ));
        }
        cursor = Some(next);
    }
    Err(McpFailure::call(
        CallFailure::Other,
        format!("MCP {method} exceeded {MAX_PAGES} pages; expected a final page"),
    ))
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
    use crate::mcp::types::FailureKind;
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
            hooks: SessionHooks::inert(),
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
                resources: true,
                prompts: true
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

    /// The stdio fixture with its message log enabled.
    fn logged_fixture(
        name: &str,
    ) -> (
        McpConfig,
        std::path::PathBuf,
        crate::test_support::ScratchDir,
    ) {
        let directory = crate::test_support::scratch_dir(&format!("mcp-sdk-{name}"));
        let log = directory.join("received.jsonl");
        let mut config = fixture_config();
        config
            .env
            .insert("MCP_FIXTURE_LOG".into(), log.to_string_lossy().into_owned());
        (config, log, directory)
    }

    fn received(log: &std::path::Path) -> Vec<Value> {
        std::fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).expect("the fixture logs JSON lines"))
            .collect()
    }

    async fn wait_for_received(
        log: &std::path::Path,
        what: &str,
        found: impl Fn(&Value) -> bool,
    ) -> Value {
        for _ in 0..300 {
            if let Some(message) = received(log).into_iter().find(|message| found(message)) {
                return message;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "expected the server to receive {what} | received {:?}",
            received(log)
        );
    }

    async fn connected(config: &McpConfig) -> Arc<dyn McpClient> {
        SdkConnector::new("1.2.3")
            .connect(config, &McpSecrets::default(), allowed())
            .await
            .unwrap_or_else(|failure| panic!("expected a connected fixture | received {failure:?}"))
    }

    #[tokio::test]
    async fn the_handshake_is_a_legacy_initialize_pinned_to_the_typescript_revision() {
        let (config, log, _dir) = logged_fixture("initialize");
        let client = connected(&config).await;
        let first = received(&log)
            .into_iter()
            .next()
            .expect("the server received a first frame");
        assert_eq!(
            first["method"],
            json!("initialize"),
            "expected initialize, not server/discover"
        );
        assert_eq!(first["params"]["protocolVersion"], json!("2025-11-25"));
        assert_eq!(
            first["params"]["clientInfo"],
            json!({ "name": "mangostudio", "version": "1.2.3" })
        );
        client.close().await.expect("closes");
    }

    #[tokio::test]
    async fn tools_resources_and_prompts_round_trip_over_stdio() {
        let (config, _log, _dir) = logged_fixture("round-trip");
        let client = connected(&config).await;
        let echo = client
            .call_tool(
                "echo".into(),
                serde_json::from_value(json!({ "text": "hi" })).unwrap(),
                None,
                options(),
            )
            .await
            .expect("echo succeeds");
        assert_eq!(
            echo,
            json!({ "contentText": "hi", "isError": false, "rawContentKinds": ["text"], "content": [{ "type": "text", "text": "hi" }] })
        );
        let big = client
            .call_tool("big".into(), Map::new(), None, options())
            .await
            .expect("big succeeds");
        let text = big["contentText"].as_str().expect("text");
        assert!(
            text.ends_with(content::MCP_RESULT_TRUNCATION_MARKER),
            "expected the truncation marker"
        );
        assert!(
            text.len() < 70 * 1024,
            "expected a capped result | received {} bytes",
            text.len()
        );
        let boom = client
            .call_tool("boom".into(), Map::new(), None, options())
            .await
            .expect("boom answers");
        assert_eq!(
            (boom["isError"].clone(), boom["contentText"].clone()),
            (json!(true), json!("tool exploded"))
        );
        let unusual = client
            .call_tool("unusual".into(), Map::new(), None, options())
            .await
            .expect_err("expected a malformed result refused like the SDK's validation");
        assert_eq!(unusual.kind, FailureKind::Call(CallFailure::Other));
        let unknown = client
            .call_tool("missing".into(), Map::new(), None, options())
            .await
            .expect_err("expected the server's JSON-RPC error");
        assert_eq!(unknown.message, "MCP error -32602: Unknown tool: missing");
        assert_eq!(
            client
                .list_resources(options())
                .await
                .expect("resources/list"),
            vec![
                json!({ "uri": "file:///one", "name": "One" }),
                json!({ "uri": "file:///two", "name": "two", "mimeType": "text/plain", "sizeBytes": 3 }),
            ]
        );
        assert_eq!(
            client
                .read_resource("file:///one".into(), options())
                .await
                .expect("resources/read"),
            vec![
                json!({ "uri": "file:///one", "mimeType": "text/plain", "text": "content of file:///one" })
            ]
        );
        assert_eq!(
            client.list_prompts(options()).await.expect("prompts/list"),
            vec![
                json!({ "name": "greet", "description": "Say hi", "arguments": [{ "name": "who", "required": true }] })
            ]
        );
        assert_eq!(
            client
                .get_prompt(
                    "greet".into(),
                    Some(BTreeMap::from([("who".into(), "Ada".into())])),
                    options()
                )
                .await
                .expect("prompts/get"),
            json!({ "description": "Greeting", "messages": [{ "role": "user", "text": "Hello Ada" }] })
        );
        client.close().await.expect("closes");
    }

    #[tokio::test]
    async fn a_timed_out_call_reports_timeout_and_tells_the_server() {
        let (config, log, _dir) = logged_fixture("timeout");
        let client = connected(&config).await;
        let failure = client
            .call_tool(
                "hang".into(),
                Map::new(),
                None,
                RequestOptions {
                    timeout: Duration::from_millis(200),
                    cancel: CancellationToken::new(),
                },
            )
            .await
            .expect_err("expected a timeout");
        assert_eq!(
            failure,
            McpFailure::call(CallFailure::Timeout, "MCP error -32001: Request timed out")
        );
        let notice = wait_for_received(&log, "a cancellation notice", |message| {
            message["method"] == "notifications/cancelled"
        })
        .await;
        assert_eq!(notice["params"]["reason"], json!("request timeout"));
        client.close().await.expect("closes");
    }

    #[tokio::test]
    async fn a_cancelled_call_settles_once_and_tells_the_server() {
        let (config, log, _dir) = logged_fixture("cancel");
        let client = connected(&config).await;
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            trigger.cancel();
        });
        let failure = client
            .call_tool(
                "hang".into(),
                Map::new(),
                None,
                RequestOptions {
                    timeout: Duration::from_secs(10),
                    cancel,
                },
            )
            .await
            .expect_err("expected a cancellation");
        assert_eq!(failure.kind, FailureKind::Cancelled);
        let notice = wait_for_received(&log, "a cancellation notice", |message| {
            message["method"] == "notifications/cancelled"
        })
        .await;
        assert_eq!(notice["params"]["reason"], json!("cancelled"));
        // The session outlives one cancelled call.
        let echo = client
            .call_tool(
                "echo".into(),
                serde_json::from_value(json!({ "text": "again" })).unwrap(),
                None,
                options(),
            )
            .await
            .expect("the session still answers");
        assert_eq!(echo["contentText"], json!("again"));
        client.close().await.expect("closes");
    }

    #[tokio::test]
    async fn losing_the_server_mid_call_is_server_closed_and_cleanup_still_completes() {
        let (config, _log, _dir) = logged_fixture("crash");
        let client = connected(&config).await;
        let failure = client
            .call_tool("crash".into(), Map::new(), None, options())
            .await
            .expect_err("expected the call to fail with the server");
        assert_eq!(failure.kind, FailureKind::Call(CallFailure::ServerClosed));
        assert_eq!(failure.message, "MCP error -32000: Connection closed");
        client
            .close()
            .await
            .expect("cleanup of an exited server succeeds");
    }

    /// Named recording hooks: every elicitation, list change, loss, and diagnostic, with a fixed
    /// answer for every question.
    #[derive(Default)]
    struct HookLog {
        questions: std::sync::Mutex<Vec<(String, String, Vec<Value>)>>,
        closed: std::sync::atomic::AtomicUsize,
        list_changed: std::sync::atomic::AtomicUsize,
        diagnostics: std::sync::Mutex<Vec<String>>,
    }

    fn recording(answer: ElicitationAnswer) -> (SessionHooks, Arc<HookLog>) {
        let log = Arc::new(HookLog::default());
        let hooks = SessionHooks {
            closed: {
                let log = Arc::clone(&log);
                Arc::new(move || {
                    log.closed.fetch_add(1, Ordering::SeqCst);
                })
            },
            tool_list_changed: {
                let log = Arc::clone(&log);
                Arc::new(move || {
                    log.list_changed.fetch_add(1, Ordering::SeqCst);
                })
            },
            elicit: {
                let log = Arc::clone(&log);
                Arc::new(move |request: ElicitationRequest| {
                    log.questions.lock().unwrap().push((
                        request.tool_call_id,
                        request.message,
                        request.fields,
                    ));
                    let answer = answer.clone();
                    Box::pin(async move { answer }) as super::super::client::ElicitFuture
                })
            },
            diagnostic: {
                let log = Arc::clone(&log);
                Arc::new(move |event: &str, _detail: &[(&str, &str)]| {
                    log.diagnostics.lock().unwrap().push(event.to_owned());
                })
            },
        };
        (hooks, log)
    }

    async fn connected_with(config: &McpConfig, hooks: SessionHooks) -> Arc<dyn McpClient> {
        SdkConnector::new("1.2.3")
            .connect(
                config,
                &McpSecrets::default(),
                ConnectContext {
                    launch_check: Arc::new(AlwaysAllow),
                    cancel: CancellationToken::new(),
                    hooks,
                },
            )
            .await
            .unwrap_or_else(|failure| panic!("expected a connected fixture | received {failure:?}"))
    }

    fn accept_pro() -> ElicitationAnswer {
        ElicitationAnswer {
            action: ElicitationAction::Accept,
            content: Some(serde_json::from_value(json!({ "tier": "pro" })).unwrap()),
        }
    }

    #[tokio::test]
    async fn the_client_declares_form_elicitation_only() {
        let (config, log, _dir) = logged_fixture("capabilities");
        let client = connected(&config).await;
        let first = received(&log)
            .into_iter()
            .next()
            .expect("an initialize frame");
        assert_eq!(
            first["params"]["capabilities"],
            json!({ "elicitation": { "form": {} } })
        );
        client.close().await.expect("closes");
    }

    #[tokio::test]
    async fn a_form_elicitation_reaches_the_hook_and_the_answer_reaches_the_server() {
        let (config, _log, _dir) = logged_fixture("elicit");
        let (hooks, log) = recording(accept_pro());
        let client = connected_with(&config, hooks).await;
        let result = client
            .call_tool("ask".into(), Map::new(), Some(" call-1 ".into()), options())
            .await
            .expect("the elicitation round trip completes");
        assert_eq!(
            result["contentText"],
            json!(r#"{"action":"accept","content":{"tier":"pro"}}"#)
        );
        let questions = log.questions.lock().unwrap().clone();
        assert_eq!(
            questions,
            vec![(
                "call-1".to_owned(),
                "Pick a tier".to_owned(),
                vec![
                    json!({ "name": "tier", "required": true, "kind": "enum", "options": [{ "value": "free", "label": "Free" }, { "value": "pro", "label": "Pro" }] })
                ],
            )]
        );
        client.close().await.expect("closes");
    }

    #[tokio::test]
    async fn the_servers_field_order_survives_the_sdk() {
        let (config, _log, _dir) = logged_fixture("elicit-order");
        let (hooks, log) = recording(ElicitationAnswer {
            action: ElicitationAction::Decline,
            content: None,
        });
        let client = connected_with(&config, hooks).await;
        client
            .call_tool(
                "ask-order".into(),
                Map::new(),
                Some("call-2".into()),
                options(),
            )
            .await
            .expect("the ordered question round-trips");
        let names = log.questions.lock().unwrap()[0]
            .2
            .iter()
            .map(|field| field["name"].clone())
            .collect::<Vec<_>>();
        assert_eq!(names, vec![json!("zeta"), json!("alpha"), json!("mid")]);
        client.close().await.expect("closes");
    }

    #[tokio::test]
    async fn url_mode_and_questions_outside_a_tool_call_are_cancelled_with_diagnostics() {
        let (config, _log, _dir) = logged_fixture("elicit-refused");
        let (hooks, log) = recording(accept_pro());
        let client = connected_with(&config, hooks).await;
        let url = client
            .call_tool(
                "ask-url".into(),
                Map::new(),
                Some("call-3".into()),
                options(),
            )
            .await
            .expect("the url question is answered");
        assert_eq!(url["contentText"], json!(r#"{"action":"cancel"}"#));
        let outside = client
            .call_tool("ask".into(), Map::new(), Some("   ".into()), options())
            .await
            .expect("the unowned question is answered");
        assert_eq!(outside["contentText"], json!(r#"{"action":"cancel"}"#));
        assert!(
            log.questions.lock().unwrap().is_empty(),
            "expected no question relayed"
        );
        assert_eq!(
            *log.diagnostics.lock().unwrap(),
            vec![
                "mcp_elicitation_unsupported_mode",
                "mcp_elicitation_outside_tool_call"
            ]
        );
        client.close().await.expect("closes");
    }

    #[tokio::test]
    async fn list_changes_and_server_loss_reach_the_hooks_but_our_own_close_does_not() {
        let (config, _log, _dir) = logged_fixture("hooks");
        let (hooks, log) = recording(accept_pro());
        let client = connected_with(&config, hooks.clone()).await;
        client
            .call_tool("notify".into(), Map::new(), None, options())
            .await
            .expect("notify");
        wait_for(
            || log.list_changed.load(Ordering::SeqCst) == 1,
            "a list-changed hook",
        )
        .await;
        client.close().await.expect("closes");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            log.closed.load(Ordering::SeqCst),
            0,
            "expected no closed hook for our own close"
        );

        let (config, _log, _dir) = logged_fixture("hooks-crash");
        let (hooks, log) = recording(accept_pro());
        let client = connected_with(&config, hooks).await;
        let _ = client
            .call_tool("crash".into(), Map::new(), None, options())
            .await;
        wait_for(
            || log.closed.load(Ordering::SeqCst) == 1,
            "a closed hook after the crash",
        )
        .await;
        client.close().await.expect("cleanup after loss");
        assert_eq!(
            log.closed.load(Ordering::SeqCst),
            1,
            "expected the loss reported once"
        );
    }

    #[tokio::test]
    async fn a_question_the_server_withdraws_is_cancelled_through_the_hook() {
        let (config, _log, _dir) = logged_fixture("withdraw");
        let withdrawn = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (mut hooks, _log) = recording(accept_pro());
        hooks.elicit = {
            let withdrawn = Arc::clone(&withdrawn);
            Arc::new(move |request: ElicitationRequest| {
                let withdrawn = Arc::clone(&withdrawn);
                Box::pin(async move {
                    request.cancel.cancelled().await;
                    withdrawn.fetch_add(1, Ordering::SeqCst);
                    ElicitationAnswer::cancel()
                }) as super::super::client::ElicitFuture
            })
        };
        let client = connected_with(&config, hooks).await;
        let result = client
            .call_tool(
                "ask-withdraw".into(),
                Map::new(),
                Some("call-4".into()),
                options(),
            )
            .await
            .expect("the call completes after withdrawing its question");
        assert_eq!(result["contentText"], json!("withdrawn"));
        wait_for(
            || withdrawn.load(Ordering::SeqCst) == 1,
            "the withdrawal to reach the hook",
        )
        .await;
        client.close().await.expect("closes");
    }

    async fn wait_for(done: impl Fn() -> bool, what: &str) {
        for _ in 0..300 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("expected {what} within three seconds | received a timeout");
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
