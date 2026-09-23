//! A per-runtime-session MCP registry. The SDK stays behind `McpConnector`.

use std::collections::HashMap;
use std::sync::Arc;

use mango_protocol::error::{RemoteError, codes};
use mango_protocol::session::CallContext;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::client::{McpClient, McpConfig, McpConnector, McpSecrets, StdioConnector};
use crate::registry::Registry;

#[derive(Deserialize)]
struct ConnectParams {
    config: McpConfig,
    #[serde(default)]
    secrets: McpSecrets,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerParams {
    server_id: String,
}

struct Service {
    connector: Arc<dyn McpConnector>,
    sessions: Mutex<HashMap<String, Box<dyn McpClient>>>,
}

impl Service {
    fn new(connector: Arc<dyn McpConnector>) -> Self {
        Self {
            connector,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    async fn connect(
        &self,
        params: ConnectParams,
        cancel: &CancellationToken,
    ) -> Result<Value, RemoteError> {
        let config = params.config;
        let mut sessions = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(cancelled("mcp.connect")),
            sessions = self.sessions.lock() => sessions,
        };
        if cancel.is_cancelled() {
            return Err(cancelled("mcp.connect"));
        }
        if let Some(mut old) = sessions.remove(&config.id) {
            let _ = old.close().await;
        }
        let client = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(cancelled("mcp.connect")),
            result = self.connector.connect(&config, &params.secrets) => result,
        }
        .map_err(|message| failure("mcp_connection", &config.id, message))?;
        if cancel.is_cancelled() {
            let mut client = client;
            let _ = client.close().await;
            return Err(cancelled("mcp.connect"));
        }
        let caps = client.capabilities();
        sessions.insert(config.id, client);
        Ok(json!({ "capabilities": {
            "tools": caps.tools,
            "resources": caps.resources,
            "prompts": caps.prompts,
        }}))
    }

    async fn list_tools(
        &self,
        params: ServerParams,
        cancel: &CancellationToken,
    ) -> Result<Value, RemoteError> {
        let sessions = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(cancelled("mcp.list-tools")),
            sessions = self.sessions.lock() => sessions,
        };
        let client = sessions
            .get(&params.server_id)
            .ok_or_else(|| missing(&params.server_id))?;
        let tools = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(cancelled("mcp.list-tools")),
            result = client.list_tools() => result,
        }
        .map_err(|message| failure("mcp_call", &params.server_id, message))?;
        Ok(json!({ "tools": tools.into_iter().map(|tool| json!({
            "name": tool.name,
            "description": tool.description,
            "inputSchema": tool.input_schema,
        })).collect::<Vec<_>>() }))
    }

    async fn disconnect(&self, params: ServerParams) -> Value {
        let mut sessions = self.sessions.lock().await;
        if let Some(mut client) = sessions.remove(&params.server_id) {
            let _ = client.close().await;
        }
        json!({ "ok": true })
    }
}

fn cancelled(method: &str) -> RemoteError {
    RemoteError::new(codes::CANCELLED, format!("{method} was cancelled"))
}

fn missing(server_id: &str) -> RemoteError {
    failure(
        "mcp_session_missing",
        server_id,
        format!("No MCP session is open for server \"{server_id}\" on this runtime."),
    )
}

fn failure(kind: &str, server_id: &str, message: String) -> RemoteError {
    RemoteError::new(codes::INTERNAL, message)
        .with_detail("kind", kind)
        .with_detail("serverId", server_id)
}

/// Registers the three working MCP methods. `mcp` stays absent from the
/// manifest until every catalog method in the family has a handler.
///
/// # Example
/// ```ignore
/// let registry = register(Registry::new(), "0.1.1");
/// assert_eq!(registry.classify("mcp.connect"), Classification::Implemented);
/// ```
pub(crate) fn register(registry: Registry, runtime_version: &str) -> Registry {
    register_with_connector(registry, Arc::new(StdioConnector::new(runtime_version)))
}

fn register_with_connector(registry: Registry, connector: Arc<dyn McpConnector>) -> Registry {
    let service = Arc::new(Service::new(connector));
    let connect = Arc::clone(&service);
    let registry = registry.implement(
        "mcp.connect",
        move |params: ConnectParams, context: CallContext| {
            let service = Arc::clone(&connect);
            async move { service.connect(params, context.cancel()).await }
        },
    );
    let list = Arc::clone(&service);
    let registry = registry.implement(
        "mcp.list-tools",
        move |params: ServerParams, context: CallContext| {
            let service = Arc::clone(&list);
            async move { service.list_tools(params, context.cancel()).await }
        },
    );
    registry.implement(
        "mcp.disconnect",
        move |params: ServerParams, _context: CallContext| {
            let service = Arc::clone(&service);
            async move { Ok::<_, RemoteError>(service.disconnect(params).await) }
        },
    )
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use super::*;
    use crate::manifest::build_features;
    use crate::mcp::client::{ClientFuture, ServerCapabilities, ToolDescriptor};
    use crate::registry::Classification;
    use mangostudio_runtime_contract::manifest::RuntimeCapabilityAllow;

    struct FakeClient {
        closes: Arc<AtomicUsize>,
    }

    impl McpClient for FakeClient {
        fn capabilities(&self) -> ServerCapabilities {
            ServerCapabilities {
                tools: true,
                resources: false,
                prompts: false,
            }
        }

        fn list_tools(&self) -> ClientFuture<'_, Vec<ToolDescriptor>> {
            Box::pin(async {
                Ok(vec![ToolDescriptor {
                    name: "inspect".into(),
                    description: "Read state".into(),
                    input_schema: json!({ "type": "object" }),
                }])
            })
        }

        fn close(&mut self) -> ClientFuture<'_, ()> {
            self.closes.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }
    }

    struct FakeConnector {
        closes: Arc<AtomicUsize>,
    }

    impl McpConnector for FakeConnector {
        fn connect<'a>(
            &'a self,
            _config: &'a McpConfig,
            _secrets: &'a McpSecrets,
        ) -> ClientFuture<'a, Box<dyn McpClient>> {
            let closes = Arc::clone(&self.closes);
            Box::pin(async move { Ok(Box::new(FakeClient { closes }) as Box<dyn McpClient>) })
        }
    }

    struct BlockingConnector {
        closes: Arc<AtomicUsize>,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }

    impl McpConnector for BlockingConnector {
        fn connect<'a>(
            &'a self,
            config: &'a McpConfig,
            _secrets: &'a McpSecrets,
        ) -> ClientFuture<'a, Box<dyn McpClient>> {
            Box::pin(async move {
                if config.id == "server-2" {
                    self.entered.notify_one();
                    self.release.notified().await;
                }
                Ok(Box::new(FakeClient {
                    closes: Arc::clone(&self.closes),
                }) as Box<dyn McpClient>)
            })
        }
    }

    fn params() -> ConnectParams {
        ConnectParams {
            config: McpConfig {
                id: "server-1".into(),
                slug: "local".into(),
                transport: "stdio".into(),
                command: Some("fixture".into()),
                args: vec![],
                env: Default::default(),
                timeout_ms: None,
            },
            secrets: McpSecrets::default(),
        }
    }

    #[tokio::test]
    async fn session_connect_lists_tools_replaces_and_disconnects() {
        let closes = Arc::new(AtomicUsize::new(0));
        let service = Service::new(Arc::new(FakeConnector {
            closes: Arc::clone(&closes),
        }));
        let cancel = CancellationToken::new();
        assert_eq!(
            service.connect(params(), &cancel).await.unwrap(),
            json!({"capabilities": {"tools": true, "resources": false, "prompts": false}})
        );
        assert_eq!(
            service
                .list_tools(
                    ServerParams {
                        server_id: "server-1".into()
                    },
                    &cancel
                )
                .await
                .unwrap(),
            json!({"tools": [{"name": "inspect", "description": "Read state", "inputSchema": {"type": "object"}}]})
        );
        service.connect(params(), &cancel).await.unwrap();
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        assert_eq!(
            service
                .disconnect(ServerParams {
                    server_id: "server-1".into()
                })
                .await,
            json!({"ok": true})
        );
        assert_eq!(closes.load(Ordering::SeqCst), 2);
        assert_eq!(
            service
                .disconnect(ServerParams {
                    server_id: "server-1".into()
                })
                .await,
            json!({"ok": true})
        );
        assert_eq!(closes.load(Ordering::SeqCst), 2);
        let missing = service
            .list_tools(
                ServerParams {
                    server_id: "server-1".into(),
                },
                &cancel,
            )
            .await
            .unwrap_err();
        assert_eq!(
            missing.details.as_ref().and_then(|value| value.get("kind")),
            Some(&json!("mcp_session_missing"))
        );
    }

    #[tokio::test]
    async fn cancelled_reconnect_keeps_the_existing_session() {
        let closes = Arc::new(AtomicUsize::new(0));
        let service = Service::new(Arc::new(FakeConnector {
            closes: Arc::clone(&closes),
        }));
        let active = CancellationToken::new();
        service.connect(params(), &active).await.unwrap();

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let error = service.connect(params(), &cancelled).await.unwrap_err();
        assert_eq!(error.code, codes::CANCELLED);
        assert_eq!(closes.load(Ordering::SeqCst), 0);
        assert!(
            service
                .list_tools(
                    ServerParams {
                        server_id: "server-1".into()
                    },
                    &active
                )
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn cancelled_list_does_not_wait_behind_another_servers_connect() {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let connector = BlockingConnector {
            closes: Arc::new(AtomicUsize::new(0)),
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
        };
        let service = Arc::new(Service::new(Arc::new(connector)));
        let active = CancellationToken::new();
        service.connect(params(), &active).await.unwrap();

        let waiting = entered.notified();
        let connecting = Arc::clone(&service);
        let task = tokio::spawn(async move {
            let mut second = params();
            second.config.id = "server-2".into();
            connecting.connect(second, &CancellationToken::new()).await
        });
        waiting.await;

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let result = tokio::time::timeout(
            Duration::from_millis(100),
            service.list_tools(
                ServerParams {
                    server_id: "server-1".into(),
                },
                &cancelled,
            ),
        )
        .await;
        release.notify_one();
        task.await.unwrap().unwrap();
        let error = result
            .expect("cancelled list must not wait for an unrelated connect")
            .unwrap_err();
        assert_eq!(error.code, codes::CANCELLED);
    }

    #[test]
    fn partial_family_is_registered_but_never_advertised_as_mcp() {
        let registry = register_with_connector(
            Registry::new(),
            Arc::new(FakeConnector {
                closes: Arc::new(AtomicUsize::new(0)),
            }),
        );
        for method in ["mcp.connect", "mcp.list-tools", "mcp.disconnect"] {
            assert_eq!(registry.classify(method), Classification::Implemented);
        }
        for method in [
            "mcp.call-tool",
            "mcp.list-resources",
            "mcp.read-resource",
            "mcp.list-prompts",
            "mcp.get-prompt",
            "mcp.elicit-response",
        ] {
            assert_eq!(
                registry.classify(method),
                Classification::KnownUnimplemented
            );
        }
        let allow = RuntimeCapabilityAllow {
            fs_read: false,
            fs_write: false,
            shell: false,
            git: false,
            probing: false,
            mcp: true,
            library: false,
            checkpoints: false,
            update: false,
            external_agents: None,
        };
        assert!(!build_features(&registry, &allow, true).mcp);
    }
}
