//! A per-runtime-connection MCP session registry. The SDK stays behind [`McpConnector`].
//!
//! No lock here is ever held across a request to a server: sessions are shared out as `Arc`s
//! under a short synchronous lock, and only connects to the *same* server id are serialized, so
//! one busy or hung server cannot stall another server, a disconnect, or an answer to a question.
//!
//! The registry also owns every parked elicitation. Each one settles exactly once — answered,
//! withdrawn by the server, cancelled with its tool call, or cancelled because its session ended
//! (disconnect, server loss, consent revocation, or the hub session going away) — so no waiter
//! outlives what it was waiting on.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use mango_protocol::error::{RemoteError, codes};
use mango_protocol::session::{CallContext, Session};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::client::{
    ConnectContext, ElicitationAction, ElicitationAnswer, ElicitationRequest, McpClient,
    McpConnector, SessionHooks,
};
use super::consent::{FreshMcpLaunch, McpConsent};
use super::events::{ELICITATION_TOPIC, McpEvents, SESSION_TOPIC, SessionEvents};
use super::sdk::SdkConnector;
use super::types::{
    CallFailure, FailureKind, McpConfig, McpFailure, McpSecrets, RequestOptions, timeout_from,
};
use crate::blocking::run_blocking;
use crate::consent::source::ConsentSource;
use crate::registry::Registry;

/// Live sessions one runtime connection may hold. The hub keeps one per enabled server row, so
/// this only bounds a misbehaving caller.
pub(crate) const MAX_SESSIONS: usize = 64;
/// Parked elicitations one runtime connection may hold; a further question is cancelled.
pub(crate) const MAX_PENDING_ELICITATIONS: usize = 64;
/// How often live sessions re-read `mcp` consent, matching the terminal service's poll.
const CONSENT_POLL: Duration = Duration::from_millis(100);
/// Bound on one consent read; a read that cannot finish is treated as a withdrawal, as the
/// terminal service treats it.
const CONSENT_READ_TIMEOUT: Duration = Duration::from_secs(2);

/// Every method [`register`] installs; the manifest attests them as one unit.
#[cfg(test)]
const MCP_METHODS: [&str; 9] = [
    "mcp.connect",
    "mcp.list-tools",
    "mcp.call-tool",
    "mcp.list-resources",
    "mcp.read-resource",
    "mcp.list-prompts",
    "mcp.get-prompt",
    "mcp.elicit-response",
    "mcp.disconnect",
];

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallToolParams {
    server_id: String,
    tool_name: String,
    args: Map<String, Value>,
    #[serde(default)]
    tool_call_id: Option<String>,
    #[serde(default)]
    timeout_ms: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadResourceParams {
    server_id: String,
    uri: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetPromptParams {
    server_id: String,
    prompt_name: String,
    #[serde(default)]
    args: Option<BTreeMap<String, String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ElicitResponseParams {
    request_id: String,
    action: ElicitationAction,
    #[serde(default)]
    content: Option<Map<String, Value>>,
}

/// One fair async lock per key, dropped from the map once nobody holds or awaits it.
#[derive(Default)]
struct KeyedLocks(Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>);

impl KeyedLocks {
    fn get(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.0.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
            return lock;
        }
        locks.retain(|_, lock| lock.strong_count() > 0);
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        locks.insert(key.to_owned(), Arc::downgrade(&lock));
        lock
    }
}

/// One open session and the row it was opened for.
struct Entry {
    /// Distinguishes this session from an earlier or later one under the same server id.
    id: u64,
    config: McpConfig,
    client: Arc<dyn McpClient>,
    timeout: Duration,
}

/// A parked question: which session asked it, and where its single answer goes.
struct Pending {
    entry: u64,
    answer: oneshot::Sender<ElicitationAnswer>,
}

struct Service {
    connector: Arc<dyn McpConnector>,
    consent: Arc<dyn McpConsent>,
    sessions: Mutex<HashMap<String, Arc<Entry>>>,
    /// Serializes connect/replace per server id so concurrent connects cannot leak a session.
    /// Tokio's mutex is fair, so waiters are admitted in arrival order.
    connects: KeyedLocks,
    /// The FIFO gate for `mcp.call-tool` per server id; discovery, resources and prompts stay
    /// parallel, as in the TypeScript host. Keyed by server id, not by session, so a queued call
    /// is answered by whichever session is live when its turn comes.
    calls: KeyedLocks,
    pending: Mutex<HashMap<String, Pending>>,
    next_entry: AtomicU64,
    events: Mutex<Option<Arc<dyn McpEvents>>>,
    /// Set once the hub session is gone: nothing new may be registered after teardown.
    closed: AtomicBool,
    watcher_started: AtomicBool,
    consent_poll: Duration,
}

impl Service {
    fn new(connector: Arc<dyn McpConnector>, consent: Arc<dyn McpConsent>) -> Self {
        Self {
            connector,
            consent,
            sessions: Mutex::new(HashMap::new()),
            connects: KeyedLocks::default(),
            calls: KeyedLocks::default(),
            pending: Mutex::new(HashMap::new()),
            next_entry: AtomicU64::new(1),
            events: Mutex::new(None),
            closed: AtomicBool::new(false),
            watcher_started: AtomicBool::new(false),
            consent_poll: CONSENT_POLL,
        }
    }

    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Entry>>> {
        self.sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<String, Pending>> {
        self.pending
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn events(&self) -> Option<Arc<dyn McpEvents>> {
        self.events
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    fn entry(&self, server_id: &str) -> Result<Arc<Entry>, RemoteError> {
        self.sessions()
            .get(server_id)
            .cloned()
            .ok_or_else(|| missing(server_id))
    }

    /// Whether `entry` is still the session registered under `server_id`.
    fn is_current(&self, server_id: &str, entry: u64) -> bool {
        self.sessions()
            .get(server_id)
            .is_some_and(|current| current.id == entry)
    }

    fn diagnostic(&self, event: &str, detail: &[(&str, &str)]) {
        match self.events() {
            Some(events) => events.diagnostic(event, detail),
            None => eprintln!("{}", super::events::diagnostic_line(event, detail)),
        }
    }

    /// Announces a session change, or records that nobody heard it. Nothing is unwound when the
    /// hub cannot carry it: the event is a notification, and what it describes is owned here.
    fn publish_session(&self, server_id: &str, change: &str) {
        let delivered = self.events().is_some_and(|events| {
            events.emit(
                SESSION_TOPIC,
                json!({ "serverId": server_id, "change": change }),
            )
        });
        if !delivered {
            self.diagnostic(
                "mcp_session_event_unobserved",
                &[("serverId", server_id), ("change", change)],
            );
        }
    }

    /// Hooks bound to one session: a superseded session's callbacks find it no longer current
    /// and do nothing, so its teardown can never drop or notify for its replacement.
    fn hooks(self: &Arc<Self>, config: &McpConfig, entry: u64) -> SessionHooks {
        let closed = {
            let service = Arc::downgrade(self);
            let server_id = config.id.clone();
            Arc::new(move || {
                if let Some(service) = service.upgrade() {
                    service.session_lost(&server_id, entry);
                }
            }) as Arc<dyn Fn() + Send + Sync>
        };
        let tool_list_changed = {
            let service = Arc::downgrade(self);
            let server_id = config.id.clone();
            Arc::new(move || {
                if let Some(service) = service.upgrade()
                    && service.is_current(&server_id, entry)
                {
                    service.publish_session(&server_id, "tool-list-changed");
                }
            }) as Arc<dyn Fn() + Send + Sync>
        };
        let elicit = {
            let service = Arc::downgrade(self);
            let server_id = config.id.clone();
            let slug = config.slug.clone();
            Arc::new(move |request: ElicitationRequest| {
                let service = service.clone();
                let server_id = server_id.clone();
                let slug = slug.clone();
                Box::pin(async move {
                    match service.upgrade() {
                        Some(service) => service.ask(&server_id, &slug, entry, request).await,
                        None => ElicitationAnswer::cancel(),
                    }
                }) as super::client::ElicitFuture
            })
                as Arc<dyn Fn(ElicitationRequest) -> super::client::ElicitFuture + Send + Sync>
        };
        let diagnostic = {
            let service = Arc::downgrade(self);
            Arc::new(move |event: &str, detail: &[(&str, &str)]| {
                if let Some(service) = service.upgrade() {
                    service.diagnostic(event, detail);
                }
            }) as super::client::DiagnosticHook
        };
        SessionHooks {
            closed,
            tool_list_changed,
            elicit,
            diagnostic,
        }
    }

    /// A session ended on its own (crash, dropped socket): forget it, settle its questions,
    /// tell the hub, and still let its owner finish cleaning up its process tree.
    fn session_lost(&self, server_id: &str, entry: u64) {
        let removed = {
            let mut sessions = self.sessions();
            match sessions.get(server_id) {
                Some(current) if current.id == entry => sessions.remove(server_id),
                _ => None,
            }
        };
        let Some(removed) = removed else {
            return;
        };
        self.cancel_elicitations(Some(entry));
        self.publish_session(server_id, "closed");
        tokio::spawn(async move {
            let _ = removed.client.close().await;
        });
    }

    /// Parks one question, publishes it, and waits for its single answer.
    ///
    /// A question nobody received is a question nobody can answer: when the hub session cannot
    /// carry the event, the question is cancelled at once rather than holding the tool call
    /// until its own deadline.
    async fn ask(
        &self,
        server_id: &str,
        slug: &str,
        entry: u64,
        request: ElicitationRequest,
    ) -> ElicitationAnswer {
        if request.cancel.is_cancelled() || !self.is_current(server_id, entry) {
            return ElicitationAnswer::cancel();
        }
        let request_id = new_request_id();
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending();
            if pending.len() >= MAX_PENDING_ELICITATIONS {
                drop(pending);
                self.diagnostic(
                    "mcp_elicitation_limit",
                    &[
                        ("serverId", server_id),
                        ("toolCallId", &request.tool_call_id),
                    ],
                );
                return ElicitationAnswer::cancel();
            }
            pending.insert(
                request_id.clone(),
                Pending {
                    entry,
                    answer: sender,
                },
            );
        }
        let payload = json!({
            "requestId": request_id,
            "serverId": server_id,
            "serverSlug": slug,
            "toolCallId": request.tool_call_id,
            "message": request.message,
            "fields": request.fields,
        });
        let delivered = self
            .events()
            .is_some_and(|events| events.emit(ELICITATION_TOPIC, payload));
        if !delivered {
            // Ids only: the question's text is the user's, not the operator's.
            self.diagnostic(
                "mcp_elicitation_unobserved",
                &[
                    ("serverId", server_id),
                    ("toolCallId", &request.tool_call_id),
                ],
            );
            self.settle(&request_id, ElicitationAnswer::cancel());
        }
        tokio::select! {
            answer = receiver => answer.unwrap_or_else(|_| ElicitationAnswer::cancel()),
            () = request.cancel.cancelled() => {
                self.settle(&request_id, ElicitationAnswer::cancel());
                ElicitationAnswer::cancel()
            }
        }
    }

    /// Delivers the one answer a parked question gets; later answers find nothing to settle.
    fn settle(&self, request_id: &str, answer: ElicitationAnswer) -> bool {
        let Some(pending) = self.pending().remove(request_id) else {
            return false;
        };
        let _ = pending.answer.send(answer);
        true
    }

    /// Cancels the questions of one session, or of every session.
    fn cancel_elicitations(&self, entry: Option<u64>) {
        let stranded = {
            let mut pending = self.pending();
            let ids = pending
                .iter()
                .filter(|(_, parked)| entry.is_none_or(|entry| parked.entry == entry))
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| pending.remove(&id))
                .collect::<Vec<_>>()
        };
        for parked in stranded {
            let _ = parked.answer.send(ElicitationAnswer::cancel());
        }
    }

    async fn connect(
        self: &Arc<Self>,
        params: ConnectParams,
        cancel: &CancellationToken,
    ) -> Result<Value, RemoteError> {
        let config = params.config;
        let lock = self.connects.get(&config.id);
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
            self.cancel_elicitations(Some(previous.id));
            let _ = previous.client.close().await;
        }
        if cancel.is_cancelled() {
            return Err(cancelled("mcp.connect"));
        }
        let entry_id = self.next_entry.fetch_add(1, Ordering::Relaxed);
        let context = ConnectContext {
            launch_check: Arc::new(FreshMcpLaunch(Arc::clone(&self.consent))),
            cancel: cancel.clone(),
            hooks: self.hooks(&config, entry_id),
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
            id: entry_id,
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

    fn options(entry: &Entry, cancel: &CancellationToken) -> RequestOptions {
        RequestOptions {
            timeout: entry.timeout,
            cancel: cancel.clone(),
        }
    }

    async fn list_tools(
        &self,
        params: ServerParams,
        cancel: &CancellationToken,
    ) -> Result<Value, RemoteError> {
        let entry = self.entry(&params.server_id)?;
        let tools = entry
            .client
            .list_tools(Self::options(&entry, cancel))
            .await
            .map_err(|failure| self.remote("mcp.list-tools", &entry.config, failure))?;
        Ok(json!({ "tools": tools }))
    }

    async fn call_tool(
        &self,
        params: CallToolParams,
        cancel: &CancellationToken,
    ) -> Result<Value, RemoteError> {
        // Resolved up front so a call for a server with no session fails immediately rather than
        // after waiting out the queue.
        self.entry(&params.server_id)?;
        let lock = self.calls.get(&params.server_id);
        // A caller that gives up while queued leaves at once; it never reaches the server, and
        // the queue only advances when the call ahead of it has actually finished — even when
        // that call is parked on a question only a human can answer.
        let _turn = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(cancelled("mcp.call-tool")),
            turn = lock.lock() => turn,
        };
        if cancel.is_cancelled() {
            return Err(cancelled("mcp.call-tool"));
        }
        // Re-read rather than reusing the entry resolved above: a disconnect or a reconnect while
        // this call sat in the queue must not be answered by a closed or superseded session.
        let entry = self.entry(&params.server_id)?;
        let timeout = match params.timeout_ms {
            Some(raw) => timeout_from(Some(raw), &entry.config.slug).map_err(|message| {
                self.remote(
                    "mcp.call-tool",
                    &entry.config,
                    McpFailure::call(CallFailure::Other, message),
                )
            })?,
            None => entry.timeout,
        };
        entry
            .client
            .call_tool(
                params.tool_name,
                params.args,
                params.tool_call_id,
                RequestOptions {
                    timeout,
                    cancel: cancel.clone(),
                },
            )
            .await
            .map_err(|failure| self.remote("mcp.call-tool", &entry.config, failure))
    }

    async fn list_resources(
        &self,
        params: ServerParams,
        cancel: &CancellationToken,
    ) -> Result<Value, RemoteError> {
        let entry = self.entry(&params.server_id)?;
        let resources = entry
            .client
            .list_resources(Self::options(&entry, cancel))
            .await
            .map_err(|failure| self.remote("mcp.list-resources", &entry.config, failure))?;
        Ok(json!({ "resources": resources }))
    }

    async fn read_resource(
        &self,
        params: ReadResourceParams,
        cancel: &CancellationToken,
    ) -> Result<Value, RemoteError> {
        let entry = self.entry(&params.server_id)?;
        let contents = entry
            .client
            .read_resource(params.uri, Self::options(&entry, cancel))
            .await
            .map_err(|failure| self.remote("mcp.read-resource", &entry.config, failure))?;
        Ok(json!({ "contents": contents }))
    }

    async fn list_prompts(
        &self,
        params: ServerParams,
        cancel: &CancellationToken,
    ) -> Result<Value, RemoteError> {
        let entry = self.entry(&params.server_id)?;
        let prompts = entry
            .client
            .list_prompts(Self::options(&entry, cancel))
            .await
            .map_err(|failure| self.remote("mcp.list-prompts", &entry.config, failure))?;
        Ok(json!({ "prompts": prompts }))
    }

    async fn get_prompt(
        &self,
        params: GetPromptParams,
        cancel: &CancellationToken,
    ) -> Result<Value, RemoteError> {
        let entry = self.entry(&params.server_id)?;
        entry
            .client
            .get_prompt(
                params.prompt_name,
                params.args,
                Self::options(&entry, cancel),
            )
            .await
            .map_err(|failure| self.remote("mcp.get-prompt", &entry.config, failure))
    }

    /// Answers one parked question. A late or duplicate answer is not an error: the question may
    /// already have been cancelled by the tool call ending underneath it.
    fn respond(&self, params: ElicitResponseParams) -> Value {
        let answer = match params.action {
            ElicitationAction::Accept => ElicitationAnswer {
                action: ElicitationAction::Accept,
                content: Some(params.content.unwrap_or_default()),
            },
            action => ElicitationAnswer {
                action,
                content: None,
            },
        };
        self.settle(&params.request_id, answer);
        json!({ "ok": true })
    }

    async fn disconnect(&self, params: ServerParams) -> Value {
        let entry = self.sessions().remove(&params.server_id);
        if let Some(entry) = entry {
            self.cancel_elicitations(Some(entry.id));
            let _ = entry.client.close().await;
        }
        json!({ "ok": true })
    }

    /// Closes every session and waits for each to release what it owns. With `announce`, each
    /// closed server is reported to the hub (revocation); without it the hub is already gone.
    async fn close_all(&self, announce: bool) {
        let entries = self
            .sessions()
            .drain()
            .map(|(_, entry)| entry)
            .collect::<Vec<_>>();
        self.cancel_elicitations(None);
        let mut closes = tokio::task::JoinSet::new();
        for entry in entries {
            if announce {
                self.publish_session(&entry.config.id, "closed");
            }
            closes.spawn(async move {
                let _ = entry.client.close().await;
            });
        }
        while closes.join_next().await.is_some() {}
    }

    /// Starts, once per connection, the task that tears every session down when the hub session
    /// ends or `mcp` consent is withdrawn, and binds events to that hub session.
    fn watch(self: &Arc<Self>, session: &Session) {
        if self.watcher_started.swap(true, Ordering::AcqRel) {
            return;
        }
        {
            let mut events = self
                .events
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if events.is_none() {
                *events = Some(Arc::new(SessionEvents(session.clone())));
            }
        }
        let service = Arc::downgrade(self);
        let session = session.clone();
        let poll = self.consent_poll;
        tokio::spawn(async move { watch_connection(service, session, poll).await });
    }

    /// Re-reads `mcp` consent off the executor; a read that cannot finish counts as withdrawn.
    async fn consent_granted(&self) -> bool {
        let consent = Arc::clone(&self.consent);
        tokio::time::timeout(
            CONSENT_READ_TIMEOUT,
            run_blocking(move || consent.granted()),
        )
        .await
        .unwrap_or(false)
    }

    fn has_work(&self) -> bool {
        !self.sessions().is_empty() || !self.pending().is_empty()
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

async fn watch_connection(service: Weak<Service>, session: Session, poll: Duration) {
    let mut ticks = tokio::time::interval(poll);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticks.tick().await;
    loop {
        tokio::select! {
            _ = session.closed() => {
                if let Some(service) = service.upgrade() {
                    service.closed.store(true, Ordering::Release);
                    service.close_all(false).await;
                }
                return;
            }
            _ = ticks.tick() => {
                let Some(service) = service.upgrade() else { return; };
                if service.has_work() && !service.consent_granted().await {
                    // Revocation cannot depend on an RPC the hub would now be denied: close
                    // here, settle every question, and tell the hub each session is gone.
                    service.close_all(true).await;
                }
            }
        }
    }
}

/// A random UUID-v4-shaped id, like the TypeScript host's `crypto.randomUUID()`.
fn new_request_id() -> String {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).expect("the operating system's CSPRNG must be available");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
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

type Handled =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, RemoteError>> + Send>>;

/// Installs one request handler that shares `service`, binds its events to the caller's hub
/// session, and passes the call's cancellation.
fn serve<P>(
    registry: Registry,
    service: &Arc<Service>,
    method: &'static str,
    handle: fn(Arc<Service>, P, CancellationToken) -> Handled,
) -> Registry
where
    P: serde::de::DeserializeOwned + Send + 'static,
{
    let service = Arc::clone(service);
    registry.implement(method, move |params: P, context: CallContext| {
        service.watch(context.session());
        handle(Arc::clone(&service), params, context.cancel().clone())
    })
}

/// Registers the nine `mcp.*` methods. The manifest advertises `mcp` because every catalog
/// method in the family has a handler here, and only while consent grants it.
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
    let registry = serve(
        registry,
        &service,
        "mcp.connect",
        |service, params, cancel| Box::pin(async move { service.connect(params, &cancel).await }),
    );
    let registry = serve(
        registry,
        &service,
        "mcp.list-tools",
        |service, params, cancel| {
            Box::pin(async move { service.list_tools(params, &cancel).await })
        },
    );
    let registry = serve(
        registry,
        &service,
        "mcp.call-tool",
        |service, params, cancel| Box::pin(async move { service.call_tool(params, &cancel).await }),
    );
    let registry = serve(
        registry,
        &service,
        "mcp.list-resources",
        |service, params, cancel| {
            Box::pin(async move { service.list_resources(params, &cancel).await })
        },
    );
    let registry = serve(
        registry,
        &service,
        "mcp.read-resource",
        |service, params, cancel| {
            Box::pin(async move { service.read_resource(params, &cancel).await })
        },
    );
    let registry = serve(
        registry,
        &service,
        "mcp.list-prompts",
        |service, params, cancel| {
            Box::pin(async move { service.list_prompts(params, &cancel).await })
        },
    );
    let registry = serve(
        registry,
        &service,
        "mcp.get-prompt",
        |service, params, cancel| {
            Box::pin(async move { service.get_prompt(params, &cancel).await })
        },
    );
    let registry = serve(
        registry,
        &service,
        "mcp.elicit-response",
        |service, params, _| Box::pin(async move { Ok(service.respond(params)) }),
    );
    serve(
        registry,
        &service,
        "mcp.disconnect",
        |service, params, _| Box::pin(async move { Ok(service.disconnect(params).await) }),
    )
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;
    use crate::manifest::build_features;
    use crate::mcp::client::ClientFuture;
    use crate::mcp::consent::fakes::SwitchableConsent;
    use crate::mcp::events::fakes::RecordingEvents;
    use crate::mcp::types::ServerCapabilities;
    use crate::registry::Classification;
    use mangostudio_runtime_contract::manifest::RuntimeCapabilityAllow;

    /// Named fake session: counts closes, records tool calls in the order the "server" received
    /// them, and can park `list_tools` or every `call_tool` until a test releases it.
    struct FakeClient {
        generation: usize,
        hooks: SessionHooks,
        closes: Arc<AtomicUsize>,
        hold: Option<Arc<tokio::sync::Notify>>,
        calls: Arc<Mutex<Vec<String>>>,
        timeouts: Arc<Mutex<Vec<Duration>>>,
        gate: Option<Arc<tokio::sync::Semaphore>>,
        closed: CancellationToken,
    }

    impl McpClient for FakeClient {
        fn capabilities(&self) -> ServerCapabilities {
            ServerCapabilities {
                tools: true,
                resources: true,
                prompts: true,
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

        fn call_tool(
            &self,
            name: String,
            _arguments: Map<String, Value>,
            tool_call_id: Option<String>,
            options: RequestOptions,
        ) -> ClientFuture<'_, Value> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(name.clone());
                if name == "ask" {
                    // The fake server asks one question mid-call, like the TypeScript fixture.
                    let answer = (self.hooks.elicit)(ElicitationRequest {
                        tool_call_id: tool_call_id.unwrap_or_default(),
                        message: "Pick one".into(),
                        fields: vec![
                            json!({ "name": "tier", "required": false, "kind": "string" }),
                        ],
                        cancel: options.cancel.child_token(),
                    })
                    .await;
                    if options.cancel.is_cancelled() {
                        return Err(McpFailure::cancelled("cancelled"));
                    }
                    return Ok(json!({ "contentText": format!("{:?}", answer.action) }));
                }
                self.timeouts.lock().unwrap().push(options.timeout);
                if let Some(gate) = &self.gate {
                    tokio::select! {
                        permit = gate.acquire() => permit.expect("gate open").forget(),
                        () = options.cancel.cancelled() => {
                            return Err(McpFailure::cancelled("cancelled"));
                        }
                        () = self.closed.cancelled() => {
                            return Err(McpFailure::call(
                                CallFailure::ServerClosed,
                                "MCP error -32000: Connection closed",
                            ));
                        }
                    }
                }
                Ok(json!({ "contentText": format!("{name}@{}", self.generation) }))
            })
        }

        fn list_resources(&self, _options: RequestOptions) -> ClientFuture<'_, Vec<Value>> {
            Box::pin(async { Ok(vec![json!({ "uri": "file:///a", "name": "a" })]) })
        }

        fn read_resource(
            &self,
            uri: String,
            _options: RequestOptions,
        ) -> ClientFuture<'_, Vec<Value>> {
            Box::pin(async move { Ok(vec![json!({ "uri": uri, "text": "body" })]) })
        }

        fn list_prompts(&self, _options: RequestOptions) -> ClientFuture<'_, Vec<Value>> {
            Box::pin(async { Ok(vec![json!({ "name": "greet", "arguments": [] })]) })
        }

        fn get_prompt(
            &self,
            name: String,
            arguments: Option<BTreeMap<String, String>>,
            _options: RequestOptions,
        ) -> ClientFuture<'_, Value> {
            Box::pin(async move {
                let who = arguments
                    .and_then(|arguments| arguments.get("who").cloned())
                    .unwrap_or_default();
                Ok(json!({ "messages": [{ "role": "user", "text": format!("{name} {who}") }] }))
            })
        }

        fn close(&self) -> ClientFuture<'_, ()> {
            self.closes.fetch_add(1, Ordering::SeqCst);
            self.closed.cancel();
            Box::pin(async { Ok(()) })
        }
    }

    /// Named fake connector: opens [`FakeClient`]s, optionally parking one server id's connect,
    /// cancelling the caller mid-connect, or failing with a fixed [`McpFailure`].
    #[derive(Default)]
    struct FakeConnector {
        closes: Arc<AtomicUsize>,
        connects: Arc<AtomicUsize>,
        park_id: Option<String>,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        hold_lists: Option<Arc<tokio::sync::Notify>>,
        calls: Arc<Mutex<Vec<String>>>,
        timeouts: Arc<Mutex<Vec<Duration>>>,
        gate: Option<Arc<tokio::sync::Semaphore>>,
        cancel_during_connect: bool,
        fail: Option<McpFailure>,
        hooks: Arc<Mutex<Vec<SessionHooks>>>,
    }

    impl McpConnector for FakeConnector {
        fn connect<'a>(
            &'a self,
            config: &'a McpConfig,
            _secrets: &'a McpSecrets,
            context: ConnectContext,
        ) -> ClientFuture<'a, Arc<dyn McpClient>> {
            Box::pin(async move {
                let generation = self.connects.fetch_add(1, Ordering::SeqCst) + 1;
                // A real connect always suspends; yielding lets concurrent connects interleave.
                tokio::task::yield_now().await;
                if let Some(failure) = &self.fail {
                    return Err(failure.clone());
                }
                if self.park_id.as_deref() == Some(config.id.as_str()) {
                    self.entered.notify_one();
                    self.release.notified().await;
                }
                if self.cancel_during_connect {
                    context.cancel.cancel();
                }
                self.hooks.lock().unwrap().push(context.hooks.clone());
                Ok(Arc::new(FakeClient {
                    generation,
                    hooks: context.hooks,
                    closes: Arc::clone(&self.closes),
                    hold: self.hold_lists.clone(),
                    calls: Arc::clone(&self.calls),
                    timeouts: Arc::clone(&self.timeouts),
                    gate: self.gate.clone(),
                    closed: CancellationToken::new(),
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
        service_with(connector, Arc::new(RecordingEvents::new(true)))
    }

    fn service_with(connector: FakeConnector, events: Arc<RecordingEvents>) -> Arc<Service> {
        let service = Service::new(Arc::new(connector), SwitchableConsent::granted());
        *service.events.lock().unwrap() = Some(events);
        Arc::new(service)
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
            json!({"capabilities": {"tools": true, "resources": true, "prompts": true}})
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
        settles("the task call", task).await.unwrap().unwrap();
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
        service.close_all(false).await;
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

    fn call(server_id: &str, tool: &str) -> CallToolParams {
        CallToolParams {
            server_id: server_id.into(),
            tool_name: tool.into(),
            args: Map::new(),
            tool_call_id: None,
            timeout_ms: None,
        }
    }

    /// Spawns a call and waits until the fake server has received it (or it is queued behind a
    /// call that has), so tests submit in a known order.
    async fn spawn_call(
        service: &Arc<Service>,
        params: CallToolParams,
        cancel: CancellationToken,
    ) -> tokio::task::JoinHandle<Result<Value, RemoteError>> {
        let service = Arc::clone(service);
        let task = tokio::spawn(async move { service.call_tool(params, &cancel).await });
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        task
    }

    fn gated() -> (
        FakeConnector,
        Arc<tokio::sync::Semaphore>,
        Arc<Mutex<Vec<String>>>,
    ) {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let connector = FakeConnector {
            gate: Some(Arc::clone(&gate)),
            ..FakeConnector::default()
        };
        let calls = Arc::clone(&connector.calls);
        (connector, gate, calls)
    }

    #[tokio::test]
    async fn tool_calls_reach_the_server_one_at_a_time_in_submission_order() {
        let (connector, gate, calls) = gated();
        let service = service(connector);
        service
            .connect(params("server-1"), &CancellationToken::new())
            .await
            .unwrap();
        let mut tasks = Vec::new();
        for tool in ["first", "second", "third"] {
            tasks
                .push(spawn_call(&service, call("server-1", tool), CancellationToken::new()).await);
        }
        assert_eq!(
            *calls.lock().unwrap(),
            vec!["first".to_owned()],
            "expected only the head of the queue at the server"
        );
        for (index, task) in tasks.into_iter().enumerate() {
            gate.add_permits(1);
            let result = settles("the task call", task)
                .await
                .unwrap()
                .expect("each call succeeds in turn");
            assert_eq!(
                result["contentText"],
                json!(format!("{}@1", ["first", "second", "third"][index]))
            );
        }
        assert_eq!(*calls.lock().unwrap(), vec!["first", "second", "third"]);
    }

    #[tokio::test]
    async fn a_queued_call_is_answered_by_the_session_live_when_it_runs() {
        let (connector, _gate, _calls) = gated();
        let service = service(connector);
        service
            .connect(params("server-1"), &CancellationToken::new())
            .await
            .unwrap();
        let held = spawn_call(&service, call("server-1", "held"), CancellationToken::new()).await;
        let queued = spawn_call(
            &service,
            call("server-1", "queued"),
            CancellationToken::new(),
        )
        .await;
        service.disconnect(server("server-1")).await;
        // The in-flight head goes down with the session it was already running on.
        let head = held
            .await
            .unwrap()
            .expect_err("expected the head to fail with its session");
        assert_eq!(detail(&head, "kind"), Some(&json!("mcp_call")));
        assert_eq!(detail(&head, "mcpFailure"), Some(&json!("server_closed")));
        // The queued call never started, so the registry answers it, not a closed session.
        let queued = queued
            .await
            .unwrap()
            .expect_err("expected the queued call refused");
        assert_eq!(detail(&queued, "kind"), Some(&json!("mcp_session_missing")));
    }

    #[tokio::test]
    async fn an_aborted_queued_caller_leaves_while_the_call_ahead_still_runs() {
        let (connector, gate, calls) = gated();
        let service = service(connector);
        service
            .connect(params("server-1"), &CancellationToken::new())
            .await
            .unwrap();
        let held = spawn_call(&service, call("server-1", "held"), CancellationToken::new()).await;
        let abort = CancellationToken::new();
        let queued = spawn_call(&service, call("server-1", "abandoned"), abort.clone()).await;
        abort.cancel();
        let left = tokio::time::timeout(Duration::from_millis(500), queued)
            .await
            .expect("expected the aborted caller answered while the head is still blocked")
            .unwrap()
            .expect_err("expected a cancellation");
        assert_eq!(left.code, codes::CANCELLED);
        assert!(!held.is_finished(), "expected the head still running");
        gate.add_permits(1);
        settles("the held call", held)
            .await
            .unwrap()
            .expect("the head completes");
        assert_eq!(
            *calls.lock().unwrap(),
            vec!["held"],
            "expected the abandoned call never sent"
        );
        gate.add_permits(1);
        let next = service
            .call_tool(call("server-1", "next"), &CancellationToken::new())
            .await
            .expect("the queue still moves");
        assert_eq!(next["contentText"], json!("next@1"));
    }

    #[tokio::test]
    async fn discovery_resources_and_prompts_do_not_wait_behind_a_parked_call() {
        let (connector, gate, _calls) = gated();
        let service = service(connector);
        let cancel = CancellationToken::new();
        service.connect(params("server-1"), &cancel).await.unwrap();
        let held = spawn_call(&service, call("server-1", "held"), CancellationToken::new()).await;
        let parallel = tokio::time::timeout(Duration::from_millis(500), async {
            (
                service
                    .list_tools(server("server-1"), &cancel)
                    .await
                    .unwrap(),
                service
                    .list_resources(server("server-1"), &cancel)
                    .await
                    .unwrap(),
                service
                    .read_resource(
                        ReadResourceParams {
                            server_id: "server-1".into(),
                            uri: "file:///a".into(),
                        },
                        &cancel,
                    )
                    .await
                    .unwrap(),
                service
                    .list_prompts(server("server-1"), &cancel)
                    .await
                    .unwrap(),
                service
                    .get_prompt(
                        GetPromptParams {
                            server_id: "server-1".into(),
                            prompt_name: "greet".into(),
                            args: Some(BTreeMap::from([("who".into(), "you".into())])),
                        },
                        &cancel,
                    )
                    .await
                    .unwrap(),
            )
        })
        .await
        .expect("expected discovery to proceed while a tool call is parked");
        assert_eq!(
            parallel.1,
            json!({ "resources": [{ "uri": "file:///a", "name": "a" }] })
        );
        assert_eq!(
            parallel.2,
            json!({ "contents": [{ "uri": "file:///a", "text": "body" }] })
        );
        assert_eq!(
            parallel.3,
            json!({ "prompts": [{ "name": "greet", "arguments": [] }] })
        );
        assert_eq!(
            parallel.4,
            json!({ "messages": [{ "role": "user", "text": "greet you" }] })
        );
        gate.add_permits(1);
        settles("the held call", held).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn a_call_timeout_overrides_the_row_timeout_and_invalid_values_are_refused() {
        let connector = FakeConnector::default();
        let timeouts = Arc::clone(&connector.timeouts);
        let service = service(connector);
        let cancel = CancellationToken::new();
        let mut row = params("server-1");
        row.config.timeout_ms = Some(2_000.0);
        service.connect(row, &cancel).await.unwrap();
        service
            .call_tool(call("server-1", "default"), &cancel)
            .await
            .unwrap();
        let mut quick = call("server-1", "quick");
        quick.timeout_ms = Some(150.0);
        service.call_tool(quick, &cancel).await.unwrap();
        assert_eq!(
            *timeouts.lock().unwrap(),
            vec![Duration::from_millis(2_000), Duration::from_millis(150)]
        );
        let mut invalid = call("server-1", "invalid");
        invalid.timeout_ms = Some(-5.0);
        let error = service.call_tool(invalid, &cancel).await.unwrap_err();
        assert_eq!(detail(&error, "kind"), Some(&json!("mcp_call")));
        assert!(
            error.message.contains("timeoutMs -5"),
            "expected the value named | received {}",
            error.message
        );
    }

    #[tokio::test]
    async fn a_connect_cancelled_after_the_server_answered_leaves_no_session() {
        let connector = FakeConnector {
            cancel_during_connect: true,
            ..FakeConnector::default()
        };
        let closes = Arc::clone(&connector.closes);
        let service = service(connector);
        let error = service
            .connect(params("server-1"), &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.code, codes::CANCELLED);
        assert_eq!(
            closes.load(Ordering::SeqCst),
            1,
            "expected the late session closed"
        );
        let missing = service
            .list_tools(server("server-1"), &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(
            detail(&missing, "kind"),
            Some(&json!("mcp_session_missing"))
        );
    }

    /// Awaits a spawned call, failing clearly instead of hanging when it never settles.
    async fn settles<T>(
        what: &str,
        task: tokio::task::JoinHandle<T>,
    ) -> Result<T, tokio::task::JoinError> {
        tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap_or_else(|_| {
                panic!("expected {what} to settle within 3 seconds | received a timeout")
            })
    }

    async fn wait_until(what: &str, done: impl Fn() -> bool) {
        for _ in 0..500 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("expected {what} within 2.5 seconds | received a timeout");
    }

    fn asking(server_id: &str, call_id: &str) -> CallToolParams {
        CallToolParams {
            tool_call_id: Some(call_id.into()),
            ..call(server_id, "ask")
        }
    }

    #[tokio::test]
    async fn an_elicitation_event_carries_the_hub_minted_tool_call_id_and_the_answer_returns() {
        let events = Arc::new(RecordingEvents::new(true));
        let service = service_with(FakeConnector::default(), Arc::clone(&events));
        service
            .connect(params("server-1"), &CancellationToken::new())
            .await
            .unwrap();
        let task = spawn_call(
            &service,
            asking("server-1", "call-a"),
            CancellationToken::new(),
        )
        .await;
        wait_until("an elicitation event", || {
            !events.published(ELICITATION_TOPIC).is_empty()
        })
        .await;
        let event = events.published(ELICITATION_TOPIC).remove(0);
        assert_eq!(
            (
                &event["serverId"],
                &event["serverSlug"],
                &event["toolCallId"],
                &event["message"]
            ),
            (
                &json!("server-1"),
                &json!("local"),
                &json!("call-a"),
                &json!("Pick one")
            )
        );
        let request_id = event["requestId"]
            .as_str()
            .expect("a request id")
            .to_owned();
        assert_eq!(
            request_id.len(),
            36,
            "expected a UUID-shaped id | received {request_id}"
        );
        let ack = service.respond(ElicitResponseParams {
            request_id,
            action: ElicitationAction::Decline,
            content: None,
        });
        assert_eq!(ack, json!({ "ok": true }));
        let result = settles("the task call", task)
            .await
            .unwrap()
            .expect("the call completes after the answer");
        assert_eq!(result["contentText"], json!("Decline"));
    }

    #[tokio::test]
    async fn host_teardown_mid_question_strands_nothing() {
        let events = Arc::new(RecordingEvents::new(true));
        let service = service_with(FakeConnector::default(), Arc::clone(&events));
        service
            .connect(params("server-1"), &CancellationToken::new())
            .await
            .unwrap();
        let task = spawn_call(
            &service,
            asking("server-1", "call-b"),
            CancellationToken::new(),
        )
        .await;
        wait_until("an elicitation event", || {
            !events.published(ELICITATION_TOPIC).is_empty()
        })
        .await;
        service.close_all(false).await;
        let settled = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("expected the parked call to settle when the service closed");
        assert_eq!(settled.unwrap().unwrap()["contentText"], json!("Cancel"));
        assert!(
            service.pending().is_empty(),
            "expected no parked question left"
        );
        let missing = service
            .list_tools(server("server-1"), &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(
            detail(&missing, "kind"),
            Some(&json!("mcp_session_missing"))
        );
    }

    #[tokio::test]
    async fn a_question_the_hub_session_cannot_carry_is_cancelled_once_and_recorded() {
        let events = Arc::new(RecordingEvents::new(false));
        let service = service_with(FakeConnector::default(), Arc::clone(&events));
        service
            .connect(params("server-1"), &CancellationToken::new())
            .await
            .unwrap();
        let outcome = tokio::time::timeout(
            Duration::from_millis(500),
            service.call_tool(asking("server-1", "call-d"), &CancellationToken::new()),
        )
        .await
        .expect("expected the call to come back on its own, not stay parked");
        assert_eq!(outcome.unwrap()["contentText"], json!("Cancel"));
        assert_eq!(
            events.published(ELICITATION_TOPIC).len(),
            1,
            "expected the question asked once"
        );
        let diagnostics = events.diagnostics.lock().unwrap().join("\n");
        assert!(
            diagnostics.contains("mcp_elicitation_unobserved") && diagnostics.contains("call-d"),
            "expected a diagnostic naming the call | received {diagnostics}"
        );
        assert!(
            !diagnostics.contains("Pick one"),
            "expected no question text in diagnostics"
        );
    }

    #[tokio::test]
    async fn a_late_answer_to_a_forgotten_question_is_a_no_op() {
        let service = service(FakeConnector::default());
        assert_eq!(
            service.respond(ElicitResponseParams {
                request_id: "gone".into(),
                action: ElicitationAction::Accept,
                content: Some(Map::new()),
            }),
            json!({ "ok": true })
        );
    }

    #[tokio::test]
    async fn a_cancelled_call_withdraws_its_question_and_a_late_answer_changes_nothing() {
        let events = Arc::new(RecordingEvents::new(true));
        let service = service_with(FakeConnector::default(), Arc::clone(&events));
        service
            .connect(params("server-1"), &CancellationToken::new())
            .await
            .unwrap();
        let cancel = CancellationToken::new();
        let task = spawn_call(&service, asking("server-1", "call-e"), cancel.clone()).await;
        wait_until("an elicitation event", || {
            !events.published(ELICITATION_TOPIC).is_empty()
        })
        .await;
        let request_id = events.published(ELICITATION_TOPIC)[0]["requestId"]
            .as_str()
            .unwrap()
            .to_owned();
        cancel.cancel();
        let error = settles("the task call", task)
            .await
            .unwrap()
            .expect_err("expected the cancelled call to fail once");
        assert_eq!(error.code, codes::CANCELLED);
        assert!(
            service.pending().is_empty(),
            "expected the question withdrawn with its call"
        );
        assert!(
            !service.settle(&request_id, ElicitationAnswer::cancel()),
            "expected nothing left to settle"
        );
        assert_eq!(
            service.respond(ElicitResponseParams {
                request_id,
                action: ElicitationAction::Accept,
                content: None
            }),
            json!({ "ok": true })
        );
    }

    #[tokio::test]
    async fn a_superseded_sessions_close_is_ignored_and_the_current_one_is_reported() {
        let events = Arc::new(RecordingEvents::new(true));
        let connector = FakeConnector::default();
        let hooks = Arc::clone(&connector.hooks);
        let closes = Arc::clone(&connector.closes);
        let service = service_with(connector, Arc::clone(&events));
        let cancel = CancellationToken::new();
        service.connect(params("server-1"), &cancel).await.unwrap();
        service.connect(params("server-1"), &cancel).await.unwrap();
        let (first, second) = {
            let hooks = hooks.lock().unwrap();
            (hooks[0].clone(), hooks[1].clone())
        };
        (first.closed)();
        (first.tool_list_changed)();
        assert!(
            events.published(SESSION_TOPIC).is_empty(),
            "expected the old session silent"
        );
        assert!(
            service
                .list_tools(server("server-1"), &cancel)
                .await
                .is_ok()
        );
        (second.tool_list_changed)();
        (second.closed)();
        assert_eq!(
            events.published(SESSION_TOPIC),
            vec![
                json!({ "serverId": "server-1", "change": "tool-list-changed" }),
                json!({ "serverId": "server-1", "change": "closed" }),
            ]
        );
        let missing = service
            .list_tools(server("server-1"), &cancel)
            .await
            .unwrap_err();
        assert_eq!(
            detail(&missing, "kind"),
            Some(&json!("mcp_session_missing"))
        );
        wait_until("the lost session's cleanup", || {
            closes.load(Ordering::SeqCst) == 2
        })
        .await;
    }

    #[tokio::test]
    async fn server_loss_mid_question_settles_the_question() {
        let events = Arc::new(RecordingEvents::new(true));
        let connector = FakeConnector::default();
        let hooks = Arc::clone(&connector.hooks);
        let service = service_with(connector, Arc::clone(&events));
        service
            .connect(params("server-1"), &CancellationToken::new())
            .await
            .unwrap();
        let task = spawn_call(
            &service,
            asking("server-1", "call-f"),
            CancellationToken::new(),
        )
        .await;
        wait_until("an elicitation event", || {
            !events.published(ELICITATION_TOPIC).is_empty()
        })
        .await;
        let lost = hooks.lock().unwrap()[0].clone();
        (lost.closed)();
        let settled = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("expected the call to settle when its server was lost");
        assert_eq!(settled.unwrap().unwrap()["contentText"], json!("Cancel"));
        assert!(service.pending().is_empty());
    }

    #[tokio::test]
    async fn revoked_consent_closes_sessions_settles_questions_and_tells_the_hub() {
        use mango_protocol::frame::PeerInfo;
        use mango_protocol::port::port_pair;
        use mango_protocol::session::SessionOptions;

        let events = Arc::new(RecordingEvents::new(true));
        let consent = SwitchableConsent::granted();
        let connector = FakeConnector::default();
        let closes = Arc::clone(&connector.closes);
        let mut inner = Service::new(Arc::new(connector), consent.clone());
        inner.consent_poll = Duration::from_millis(10);
        *inner.events.lock().unwrap() = Some(Arc::clone(&events) as Arc<dyn McpEvents>);
        let service = Arc::new(inner);
        let peer = |name: &str| PeerInfo {
            name: name.into(),
            version: "0.0.0".into(),
            role: name.into(),
        };
        let (runtime_port, _hub_port) = port_pair();
        let (runtime, _driver) = Session::spawn(runtime_port, SessionOptions::new(peer("runtime")));
        service.watch(&runtime);
        service
            .connect(params("server-1"), &CancellationToken::new())
            .await
            .unwrap();
        let task = spawn_call(
            &service,
            asking("server-1", "call-g"),
            CancellationToken::new(),
        )
        .await;
        wait_until("an elicitation event", || {
            !events.published(ELICITATION_TOPIC).is_empty()
        })
        .await;
        consent.revoke();
        let settled = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("expected revocation to settle the parked call");
        assert_eq!(settled.unwrap().unwrap()["contentText"], json!("Cancel"));
        wait_until("the revoked session closed", || {
            closes.load(Ordering::SeqCst) == 1
        })
        .await;
        assert_eq!(
            events.published(SESSION_TOPIC),
            vec![json!({ "serverId": "server-1", "change": "closed" })]
        );
        assert!(service.sessions().is_empty() && service.pending().is_empty());
    }

    #[tokio::test]
    async fn questions_beyond_the_bound_are_cancelled_with_a_diagnostic() {
        let events = Arc::new(RecordingEvents::new(true));
        let service = service_with(FakeConnector::default(), Arc::clone(&events));
        service
            .connect(params("server-1"), &CancellationToken::new())
            .await
            .unwrap();
        let entry = service.entry("server-1").unwrap().id;
        let mut parked = Vec::new();
        for index in 0..MAX_PENDING_ELICITATIONS {
            let (sender, receiver) = oneshot::channel();
            service.pending().insert(
                format!("filler-{index}"),
                Pending {
                    entry,
                    answer: sender,
                },
            );
            parked.push(receiver);
        }
        let result = service
            .call_tool(asking("server-1", "call-h"), &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result["contentText"], json!("Cancel"));
        assert!(
            events.published(ELICITATION_TOPIC).is_empty(),
            "expected no event past the bound"
        );
        assert!(
            events
                .diagnostics
                .lock()
                .unwrap()
                .iter()
                .any(|line| line.contains("mcp_elicitation_limit"))
        );
    }

    #[test]
    fn the_whole_family_is_registered_and_mcp_follows_consent() {
        let registry = register_with_connector(
            Registry::new(),
            Arc::new(FakeConnector::default()),
            SwitchableConsent::granted(),
        );
        for method in MCP_METHODS {
            assert_eq!(
                registry.classify(method),
                Classification::Implemented,
                "expected {method} implemented"
            );
        }
        let mut allow = RuntimeCapabilityAllow {
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
        assert!(
            build_features(&registry, &allow, true).mcp,
            "expected mcp advertised when granted"
        );
        allow.mcp = false;
        assert!(
            !build_features(&registry, &allow, true).mcp,
            "expected mcp withheld when revoked"
        );
    }
}
