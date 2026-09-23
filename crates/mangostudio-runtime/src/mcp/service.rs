//! A per-runtime-connection MCP session registry. The SDK stays behind [`McpConnector`].
//!
//! No lock here is ever held across a request to a server: sessions are shared out as `Arc`s
//! under a short synchronous lock, and only connects to the *same* server id are serialized, so
//! one busy or hung server cannot stall another server, a disconnect, or an answer to a question.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use mango_protocol::error::{RemoteError, codes};
use mango_protocol::session::{CallContext, Session};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::client::{ConnectContext, McpClient, McpConnector};
use super::consent::{FreshMcpLaunch, McpConsent};
use super::sdk::SdkConnector;
use super::types::{FailureKind, McpConfig, McpFailure, McpSecrets, RequestOptions, timeout_from};
use crate::consent::source::ConsentSource;
use crate::registry::Registry;

/// Live sessions one runtime connection may hold. The hub keeps one per enabled server row, so
/// this only bounds a misbehaving caller.
pub(crate) const MAX_SESSIONS: usize = 64;

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

/// One open session and the row it was opened for.
struct Entry {
    config: McpConfig,
    client: Arc<dyn McpClient>,
    timeout: Duration,
}

struct Service {
    connector: Arc<dyn McpConnector>,
    consent: Arc<dyn McpConsent>,
    sessions: Mutex<HashMap<String, Arc<Entry>>>,
    /// Serializes connect/replace per server id so concurrent connects cannot leak a session.
    /// Tokio's mutex is fair, so waiters are admitted in arrival order.
    connects: Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>,
    /// Set once the hub session is gone: nothing new may be registered after teardown.
    closed: AtomicBool,
    watcher_started: AtomicBool,
}

impl Service {
    fn new(connector: Arc<dyn McpConnector>, consent: Arc<dyn McpConsent>) -> Self {
        Self {
            connector,
            consent,
            sessions: Mutex::new(HashMap::new()),
            connects: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            watcher_started: AtomicBool::new(false),
        }
    }

    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Entry>>> {
        self.sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn connect_lock(&self, server_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self
            .connects
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(lock) = locks.get(server_id).and_then(Weak::upgrade) {
            return lock;
        }
        locks.retain(|_, lock| lock.strong_count() > 0);
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        locks.insert(server_id.to_owned(), Arc::downgrade(&lock));
        lock
    }

    fn entry(&self, server_id: &str) -> Result<Arc<Entry>, RemoteError> {
        self.sessions()
            .get(server_id)
            .cloned()
            .ok_or_else(|| missing(server_id))
    }

    async fn connect(
        &self,
        params: ConnectParams,
        cancel: &CancellationToken,
    ) -> Result<Value, RemoteError> {
        let config = params.config;
        let lock = self.connect_lock(&config.id);
        let _turn = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(cancelled("mcp.connect")),
            turn = lock.lock() => turn,
        };
        if cancel.is_cancelled() {
            return Err(cancelled("mcp.connect"));
        }
        let timeout = timeout_from(config.timeout_ms, &config.slug).map_err(|message| {
            self.remote("mcp.connect", &config, McpFailure::connection(message))
        })?;
        {
            let sessions = self.sessions();
            if !sessions.contains_key(&config.id) && sessions.len() >= MAX_SESSIONS {
                let failure = McpFailure::connection(format!(
                    "Failed to connect to MCP server \"{}\": this runtime connection already \
                     holds {MAX_SESSIONS} MCP sessions; expected fewer",
                    config.slug
                ));
                return Err(self.remote("mcp.connect", &config, failure));
            }
        }
        // A reconnect with changed config must not leave the old session running.
        let previous = self.sessions().remove(&config.id);
        if let Some(previous) = previous {
            let _ = previous.client.close().await;
        }
        if cancel.is_cancelled() {
            return Err(cancelled("mcp.connect"));
        }
        let context = ConnectContext {
            launch_check: Arc::new(FreshMcpLaunch(Arc::clone(&self.consent))),
            cancel: cancel.clone(),
        };
        let client = self
            .connector
            .connect(&config, &params.secrets, context)
            .await
            .map_err(|failure| self.remote("mcp.connect", &config, failure))?;
        if cancel.is_cancelled() || self.closed.load(Ordering::Acquire) {
            let _ = client.close().await;
            return Err(cancelled("mcp.connect"));
        }
        let capabilities = client.capabilities();
        let entry = Arc::new(Entry {
            config: config.clone(),
            client,
            timeout,
        });
        self.sessions().insert(config.id, entry);
        Ok(json!({ "capabilities": {
            "tools": capabilities.tools,
            "resources": capabilities.resources,
            "prompts": capabilities.prompts,
        }}))
    }

    async fn list_tools(
        &self,
        params: ServerParams,
        cancel: &CancellationToken,
    ) -> Result<Value, RemoteError> {
        let entry = self.entry(&params.server_id)?;
        let tools = entry
            .client
            .list_tools(RequestOptions {
                timeout: entry.timeout,
                cancel: cancel.clone(),
            })
            .await
            .map_err(|failure| self.remote("mcp.list-tools", &entry.config, failure))?;
        Ok(json!({ "tools": tools }))
    }

    async fn disconnect(&self, params: ServerParams) -> Value {
        let entry = self.sessions().remove(&params.server_id);
        if let Some(entry) = entry {
            let _ = entry.client.close().await;
        }
        json!({ "ok": true })
    }

    /// Closes every session and waits for each to release what it owns.
    async fn close_all(&self) {
        let entries = self
            .sessions()
            .drain()
            .map(|(_, entry)| entry)
            .collect::<Vec<_>>();
        let mut closes = tokio::task::JoinSet::new();
        for entry in entries {
            closes.spawn(async move {
                let _ = entry.client.close().await;
            });
        }
        while closes.join_next().await.is_some() {}
    }

    /// Tears every session down once the hub session carrying them ends, so a dropped hub
    /// connection never strands a server process.
    fn watch(self: &Arc<Self>, session: &Session) {
        if self.watcher_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let service = Arc::downgrade(self);
        let session = session.clone();
        tokio::spawn(async move {
            session.closed().await;
            let Some(service) = service.upgrade() else {
                return;
            };
            service.closed.store(true, Ordering::Release);
            service.close_all().await;
        });
    }

    /// Maps a client failure onto the TypeScript host's wire error for `method`.
    fn remote(&self, method: &str, config: &McpConfig, failure: McpFailure) -> RemoteError {
        match failure.kind {
            FailureKind::Connection => RemoteError::new(codes::INTERNAL, failure.message)
                .with_detail("kind", "mcp_connection")
                .with_detail("serverSlug", config.slug.as_str()),
            FailureKind::Call(call) => RemoteError::new(codes::INTERNAL, failure.message)
                .with_detail("kind", "mcp_call")
                .with_detail("serverSlug", config.slug.as_str())
                .with_detail("mcpFailure", call.as_str()),
            FailureKind::Cancelled => cancelled(method),
            FailureKind::Denied => self.consent.denial(method),
        }
    }
}

fn cancelled(method: &str) -> RemoteError {
    RemoteError::new(codes::CANCELLED, format!("{method} was cancelled"))
}

fn missing(server_id: &str) -> RemoteError {
    RemoteError::new(
        codes::INTERNAL,
        format!("No MCP session is open for server \"{server_id}\" on this runtime."),
    )
    .with_detail("kind", "mcp_session_missing")
    .with_detail("serverId", server_id)
}

/// Registers the working MCP methods. The manifest advertises `mcp` only once every catalog
/// method in the family has a handler here.
///
/// # Example
/// ```ignore
/// let registry = register(Registry::new(), "0.1.1", consent);
/// assert_eq!(registry.classify("mcp.connect"), Classification::Implemented);
/// ```
pub(crate) fn register(
    registry: Registry,
    runtime_version: &str,
    consent: ConsentSource,
) -> Registry {
    register_with_connector(
        registry,
        Arc::new(SdkConnector::new(runtime_version)),
        Arc::new(consent),
    )
}

fn register_with_connector(
    registry: Registry,
    connector: Arc<dyn McpConnector>,
    consent: Arc<dyn McpConsent>,
) -> Registry {
    let service = Arc::new(Service::new(connector, consent));
    let connect = Arc::clone(&service);
    let registry = registry.implement(
        "mcp.connect",
        move |params: ConnectParams, context: CallContext| {
            let service = Arc::clone(&connect);
            async move {
                service.watch(context.session());
                service.connect(params, context.cancel()).await
            }
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
    use std::sync::atomic::AtomicUsize;

    use super::*;
    use crate::manifest::build_features;
    use crate::mcp::client::ClientFuture;
    use crate::mcp::consent::fakes::SwitchableConsent;
    use crate::mcp::types::{CallFailure, ServerCapabilities};
    use crate::registry::Classification;
    use mangostudio_runtime_contract::manifest::RuntimeCapabilityAllow;

    /// Named fake session: counts closes and can park `list_tools` until released.
    struct FakeClient {
        closes: Arc<AtomicUsize>,
        hold: Option<Arc<tokio::sync::Notify>>,
    }

    impl McpClient for FakeClient {
        fn capabilities(&self) -> ServerCapabilities {
            ServerCapabilities {
                tools: true,
                resources: false,
                prompts: false,
            }
        }

        fn list_tools(&self, options: RequestOptions) -> ClientFuture<'_, Vec<Value>> {
            let hold = self.hold.clone();
            Box::pin(async move {
                if let Some(hold) = hold {
                    tokio::select! {
                        () = hold.notified() => {}
                        () = options.cancel.cancelled() => {
                            return Err(McpFailure::cancelled("cancelled"));
                        }
                    }
                }
                Ok(vec![json!({
                    "name": "inspect",
                    "description": "Read state",
                    "inputSchema": { "type": "object" },
                })])
            })
        }

        fn close(&self) -> ClientFuture<'_, ()> {
            self.closes.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }
    }

    /// Named fake connector: opens [`FakeClient`]s, optionally parking one server id's connect,
    /// or failing with a fixed [`McpFailure`].
    #[derive(Default)]
    struct FakeConnector {
        closes: Arc<AtomicUsize>,
        connects: Arc<AtomicUsize>,
        park_id: Option<String>,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        hold_lists: Option<Arc<tokio::sync::Notify>>,
        fail: Option<McpFailure>,
    }

    impl McpConnector for FakeConnector {
        fn connect<'a>(
            &'a self,
            config: &'a McpConfig,
            _secrets: &'a McpSecrets,
            _context: ConnectContext,
        ) -> ClientFuture<'a, Arc<dyn McpClient>> {
            Box::pin(async move {
                self.connects.fetch_add(1, Ordering::SeqCst);
                // A real connect always suspends; yielding lets concurrent connects interleave.
                tokio::task::yield_now().await;
                if let Some(failure) = &self.fail {
                    return Err(failure.clone());
                }
                if self.park_id.as_deref() == Some(config.id.as_str()) {
                    self.entered.notify_one();
                    self.release.notified().await;
                }
                Ok(Arc::new(FakeClient {
                    closes: Arc::clone(&self.closes),
                    hold: self.hold_lists.clone(),
                }) as Arc<dyn McpClient>)
            })
        }
    }

    fn params(id: &str) -> ConnectParams {
        ConnectParams {
            config: McpConfig {
                id: id.into(),
                slug: "local".into(),
                transport: "stdio".into(),
                command: Some("fixture".into()),
                args: vec![],
                env: Default::default(),
                url: None,
                timeout_ms: None,
            },
            secrets: McpSecrets::default(),
        }
    }

    fn server(id: &str) -> ServerParams {
        ServerParams {
            server_id: id.into(),
        }
    }

    fn service(connector: FakeConnector) -> Arc<Service> {
        Arc::new(Service::new(
            Arc::new(connector),
            SwitchableConsent::granted(),
        ))
    }

    fn detail<'a>(error: &'a RemoteError, key: &str) -> Option<&'a Value> {
        error.details.as_ref().and_then(|details| details.get(key))
    }

    #[tokio::test]
    async fn session_connect_lists_tools_replaces_and_disconnects() {
        let connector = FakeConnector::default();
        let closes = Arc::clone(&connector.closes);
        let service = service(connector);
        let cancel = CancellationToken::new();
        assert_eq!(
            service.connect(params("server-1"), &cancel).await.unwrap(),
            json!({"capabilities": {"tools": true, "resources": false, "prompts": false}})
        );
        assert_eq!(
            service
                .list_tools(server("server-1"), &cancel)
                .await
                .unwrap(),
            json!({"tools": [{"name": "inspect", "description": "Read state", "inputSchema": {"type": "object"}}]})
        );
        service.connect(params("server-1"), &cancel).await.unwrap();
        assert_eq!(
            closes.load(Ordering::SeqCst),
            1,
            "expected the replaced session closed"
        );
        assert_eq!(
            service.disconnect(server("server-1")).await,
            json!({"ok": true})
        );
        assert_eq!(closes.load(Ordering::SeqCst), 2);
        assert_eq!(
            service.disconnect(server("server-1")).await,
            json!({"ok": true})
        );
        assert_eq!(
            closes.load(Ordering::SeqCst),
            2,
            "expected a repeated disconnect to be a no-op"
        );
    }

    #[tokio::test]
    async fn a_request_for_a_server_it_never_connected_is_refused_as_missing() {
        let service = service(FakeConnector::default());
        let error = service
            .list_tools(server("never-connected"), &CancellationToken::new())
            .await
            .expect_err("expected a missing session");
        assert_eq!(error.code, codes::INTERNAL);
        assert_eq!(detail(&error, "kind"), Some(&json!("mcp_session_missing")));
        assert_eq!(detail(&error, "serverId"), Some(&json!("never-connected")));
        assert_eq!(
            error.message,
            "No MCP session is open for server \"never-connected\" on this runtime."
        );
    }

    #[tokio::test]
    async fn connection_and_call_failures_carry_the_typescript_details() {
        let service = service(FakeConnector {
            fail: Some(McpFailure::connection(
                "Failed to connect to MCP server \"local\": no",
            )),
            ..FakeConnector::default()
        });
        let error = service
            .connect(params("server-1"), &CancellationToken::new())
            .await
            .expect_err("expected a connection failure");
        assert_eq!(error.code, codes::INTERNAL);
        assert_eq!(detail(&error, "kind"), Some(&json!("mcp_connection")));
        assert_eq!(detail(&error, "serverSlug"), Some(&json!("local")));
        assert_eq!(
            detail(&error, "serverId"),
            None,
            "expected no serverId on mcp_connection"
        );

        let config = params("server-1").config;
        let call = service.remote(
            "mcp.list-tools",
            &config,
            McpFailure::call(CallFailure::Timeout, "MCP error -32001: Request timed out"),
        );
        assert_eq!(detail(&call, "kind"), Some(&json!("mcp_call")));
        assert_eq!(detail(&call, "serverSlug"), Some(&json!("local")));
        assert_eq!(detail(&call, "mcpFailure"), Some(&json!("timeout")));
        let denied = service.remote("mcp.connect", &config, McpFailure::denied("revoked"));
        assert_eq!(denied.code, codes::DENIED);
    }

    #[tokio::test]
    async fn cancelled_reconnect_keeps_the_existing_session() {
        let connector = FakeConnector::default();
        let closes = Arc::clone(&connector.closes);
        let service = service(connector);
        let active = CancellationToken::new();
        service.connect(params("server-1"), &active).await.unwrap();

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let error = service
            .connect(params("server-1"), &cancelled)
            .await
            .unwrap_err();
        assert_eq!(error.code, codes::CANCELLED);
        assert_eq!(closes.load(Ordering::SeqCst), 0);
        assert!(
            service
                .list_tools(server("server-1"), &active)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn a_busy_server_does_not_stall_other_servers_or_disconnect() {
        let hold = Arc::new(tokio::sync::Notify::new());
        let connector = FakeConnector {
            hold_lists: Some(Arc::clone(&hold)),
            ..FakeConnector::default()
        };
        let service = service(connector);
        let cancel = CancellationToken::new();
        service.connect(params("busy"), &cancel).await.unwrap();
        service.connect(params("other"), &cancel).await.unwrap();

        let listing = Arc::clone(&service);
        let parked = tokio::spawn(async move {
            listing
                .list_tools(server("busy"), &CancellationToken::new())
                .await
        });
        tokio::task::yield_now().await;
        let answered = tokio::time::timeout(Duration::from_millis(500), async {
            service.connect(params("third"), &cancel).await.unwrap();
            service.disconnect(server("other")).await
        })
        .await;
        assert_eq!(
            answered.expect("expected connect and disconnect while another server is busy"),
            json!({"ok": true})
        );
        hold.notify_waiters();
        parked
            .await
            .unwrap()
            .expect("the parked list completes once released");
    }

    #[tokio::test]
    async fn concurrent_connects_to_one_server_leave_exactly_one_session() {
        let connector = FakeConnector::default();
        let closes = Arc::clone(&connector.closes);
        let connects = Arc::clone(&connector.connects);
        let service = service(connector);
        let cancel = CancellationToken::new();
        let (first, second) = tokio::join!(
            service.connect(params("server-1"), &cancel),
            service.connect(params("server-1"), &cancel),
        );
        first.unwrap();
        second.unwrap();
        assert_eq!(connects.load(Ordering::SeqCst), 2);
        assert_eq!(
            closes.load(Ordering::SeqCst),
            1,
            "expected the first session closed"
        );
        assert_eq!(service.sessions().len(), 1);
    }

    #[tokio::test]
    async fn cancelled_list_does_not_wait_behind_another_servers_connect() {
        let connector = FakeConnector {
            park_id: Some("server-2".into()),
            ..FakeConnector::default()
        };
        let entered = Arc::clone(&connector.entered);
        let release = Arc::clone(&connector.release);
        let service = service(connector);
        service
            .connect(params("server-1"), &CancellationToken::new())
            .await
            .unwrap();
        let waiting = entered.notified();
        let connecting = Arc::clone(&service);
        let task = tokio::spawn(async move {
            connecting
                .connect(params("server-2"), &CancellationToken::new())
                .await
        });
        waiting.await;
        let result = tokio::time::timeout(
            Duration::from_millis(100),
            service.list_tools(server("server-1"), &CancellationToken::new()),
        )
        .await;
        release.notify_one();
        task.await.unwrap().unwrap();
        result
            .expect("expected a list for one server not to wait for another server's connect")
            .expect("the list succeeds");
    }

    #[tokio::test]
    async fn closing_everything_releases_each_session_once() {
        let connector = FakeConnector::default();
        let closes = Arc::clone(&connector.closes);
        let service = service(connector);
        let cancel = CancellationToken::new();
        for id in ["a", "b", "c"] {
            service.connect(params(id), &cancel).await.unwrap();
        }
        service.close_all().await;
        assert_eq!(closes.load(Ordering::SeqCst), 3);
        let error = service.list_tools(server("a"), &cancel).await.unwrap_err();
        assert_eq!(detail(&error, "kind"), Some(&json!("mcp_session_missing")));
    }

    #[tokio::test]
    async fn a_closed_hub_session_tears_every_mcp_session_down() {
        use mango_protocol::close::close_codes;
        use mango_protocol::frame::PeerInfo;
        use mango_protocol::port::port_pair;
        use mango_protocol::session::SessionOptions;

        let connector = FakeConnector::default();
        let closes = Arc::clone(&connector.closes);
        let service = service(connector);
        let peer = |name: &str| PeerInfo {
            name: name.into(),
            version: "0.0.0".into(),
            role: name.into(),
        };
        let (runtime_port, hub_port) = port_pair();
        let (runtime, _runtime_driver) =
            Session::spawn(runtime_port, SessionOptions::new(peer("runtime")));
        let (hub, _hub_driver) = Session::spawn(hub_port, SessionOptions::new(peer("hub")));
        service.watch(&runtime);
        let cancel = CancellationToken::new();
        for id in ["a", "b"] {
            service.connect(params(id), &cancel).await.unwrap();
        }
        hub.close(close_codes::RELEASED, Some("hub gone")).await;
        runtime.closed().await;
        for _ in 0..200 {
            if closes.load(Ordering::SeqCst) == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(
            closes.load(Ordering::SeqCst),
            2,
            "expected both sessions closed after the hub session ended"
        );
        let refused = service.connect(params("late"), &cancel).await.unwrap_err();
        assert_eq!(
            refused.code,
            codes::CANCELLED,
            "expected no registration after teardown"
        );
        assert!(service.sessions().is_empty());
    }

    #[test]
    fn partial_family_is_registered_but_never_advertised_as_mcp() {
        let registry = register_with_connector(
            Registry::new(),
            Arc::new(FakeConnector::default()),
            SwitchableConsent::granted(),
        );
        for method in ["mcp.connect", "mcp.list-tools", "mcp.disconnect"] {
            assert_eq!(registry.classify(method), Classification::Implemented);
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
