//! The only module that depends on `rmcp`: it opens SDK sessions and maps every SDK result and
//! error onto the project types in [`super::types`].

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use rmcp::model::{
    CancelledNotificationParam, ClientCapabilities, ClientConfig, ClientRequest, Implementation,
    ListToolsRequest, PaginatedRequestParams, ProtocolVersion, ServerResult,
};
use rmcp::service::{Peer, PeerRequestOptions, RunningService, ServiceError};
use rmcp::{RoleClient, ServiceExt};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::client::{ClientFuture, ConnectContext, McpClient, McpConnector};
use super::process::{GuardedStdioSpawner, ProcessOwner, StartError, StdioSpawner};
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

/// Opens stdio sessions through the pinned SDK, with every child owned by the shared guardian or
/// Job supervisor rather than by the SDK.
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
        let serving = self.client_config().serve((owned.stdout, owned.stdin));
        let initialized = tokio::select! {
            biased;
            () = context.cancel.cancelled() => Err(McpFailure::cancelled(format!(
                "MCP server \"{}\" connect was cancelled during initialize",
                config.slug
            ))),
            result = tokio::time::timeout(timeout, serving) => initialized(config, timeout, result),
        };
        let service = match initialized {
            Ok(service) => service,
            Err(failure) => {
                // The SDK transport, and with it stdin, is already gone on every error path; the
                // process tree is not until its owner proves it.
                let _ = process.close().await;
                return Err(failure);
            }
        };
        let Some(server) = service.peer_info() else {
            let _ = service.cancel().await;
            let _ = process.close().await;
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
            process: Some(process),
            capabilities,
        }))
    }
}

impl McpConnector for SdkConnector {
    fn connect<'a>(
        &'a self,
        config: &'a McpConfig,
        secrets: &'a McpSecrets,
        context: ConnectContext,
    ) -> ClientFuture<'a, Arc<dyn McpClient>> {
        Box::pin(async move {
            if config.transport != "stdio" {
                return Err(connect_failure(config)(format!(
                    "transport \"{}\" is not supported by this runtime build; expected stdio",
                    config.transport
                )));
            }
            self.connect_stdio(config, secrets, context).await
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

fn initialized(
    config: &McpConfig,
    timeout: Duration,
    result: Result<
        Result<SdkService, rmcp::service::ClientInitializeError>,
        tokio::time::error::Elapsed,
    >,
) -> Result<SdkService, McpFailure> {
    match result {
        Ok(Ok(service)) => Ok(service),
        Ok(Err(error)) => Err(connect_failure(config)(error.to_string())),
        Err(_) => Err(connect_failure(config)(format!(
            "the server did not initialize within {} ms",
            timeout.as_millis()
        ))),
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
    async fn a_non_stdio_row_is_a_typed_connection_failure() {
        let mut config = fixture_config();
        config.transport = "carrier-pigeon".into();
        let failure = SdkConnector::new("1.2.3")
            .connect(&config, &McpSecrets::default(), allowed())
            .await
            .err()
            .expect("expected a refused transport");
        assert_eq!(failure.kind, super::super::types::FailureKind::Connection);
        assert!(
            failure
                .message
                .starts_with("Failed to connect to MCP server \"fixture\": transport"),
            "expected the TypeScript connection message shape | received {}",
            failure.message
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
