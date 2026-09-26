//! The project-owned MCP client seam. The service speaks only these traits; `sdk.rs` is the one
//! implementation that depends on `rmcp`, and tests implement them with named fakes.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use super::types::{McpConfig, McpFailure, McpSecrets, RequestOptions, ServerCapabilities};
use crate::subprocess::LaunchCheck;

/// Object-safe future every client operation returns.
pub(crate) type ClientFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, McpFailure>> + Send + 'a>>;

/// A live session with one MCP server. Requests take `&self` so discovery can run in parallel
/// with a tool call; only [`McpClient::close`] ends the session.
pub(crate) trait McpClient: Send + Sync {
    /// Feature areas the server advertised during initialize.
    fn capabilities(&self) -> ServerCapabilities;
    /// Every tool descriptor across all pages, in the hub's `McpToolDescriptor` shape.
    fn list_tools(&self, options: RequestOptions) -> ClientFuture<'_, Vec<Value>>;
    /// Calls one tool; the result is a capped `RuntimeMcpCallResult`. `tool_call_id` is the
    /// hub-minted id a mid-call elicitation is filed under; without one, the server's questions
    /// are cancelled because nothing upstream could own the answer.
    fn call_tool(
        &self,
        name: String,
        arguments: Map<String, Value>,
        tool_call_id: Option<String>,
        options: RequestOptions,
    ) -> ClientFuture<'_, Value>;
    /// Every resource descriptor across all pages (`McpResourceDescriptor`).
    fn list_resources(&self, options: RequestOptions) -> ClientFuture<'_, Vec<Value>>;
    /// The contents of one resource (`RuntimeMcpResourceContents[]`).
    fn read_resource(&self, uri: String, options: RequestOptions) -> ClientFuture<'_, Vec<Value>>;
    /// Every prompt descriptor across all pages (`McpPromptDescriptor`).
    fn list_prompts(&self, options: RequestOptions) -> ClientFuture<'_, Vec<Value>>;
    /// One resolved prompt (`RuntimeMcpPromptResult`).
    fn get_prompt(
        &self,
        name: String,
        arguments: Option<BTreeMap<String, String>>,
        options: RequestOptions,
    ) -> ClientFuture<'_, Value>;
    /// Ends the session and releases everything it owns, including a stdio server's process
    /// tree. Repeated calls are harmless.
    fn close(&self) -> ClientFuture<'_, ()>;
}

/// A hub answer to one form elicitation (`McpElicitationAction` plus its content).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ElicitationAnswer {
    pub action: ElicitationAction,
    pub content: Option<Map<String, Value>>,
}

impl ElicitationAnswer {
    /// The answer every path that cannot reach a human gives: the question is withdrawn.
    pub(crate) fn cancel() -> Self {
        Self {
            action: ElicitationAction::Cancel,
            content: None,
        }
    }
}

/// `McpElicitationAction`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ElicitationAction {
    Accept,
    Decline,
    Cancel,
}

/// One mid-tool-call form request on its way up to the hub.
pub(crate) struct ElicitationRequest {
    pub tool_call_id: String,
    pub message: String,
    pub fields: Vec<Value>,
    /// Cancelled when the tool call is cancelled or the server withdraws the question.
    pub cancel: CancellationToken,
}

/// Records one operator diagnostic: an event name plus id-only detail pairs.
pub(crate) type DiagnosticHook = Arc<dyn Fn(&str, &[(&str, &str)]) + Send + Sync>;

/// Object-safe future answering one elicitation.
pub(crate) type ElicitFuture = Pin<Box<dyn Future<Output = ElicitationAnswer> + Send>>;

/// Callbacks a session raises out of band. Each is bound to the session that raised it, so a
/// superseded session can never touch its replacement.
#[derive(Clone)]
pub(crate) struct SessionHooks {
    /// The session dropped without being closed by the runtime (crash, socket close).
    pub closed: Arc<dyn Fn() + Send + Sync>,
    /// The server sent `notifications/tools/list_changed`.
    pub tool_list_changed: Arc<dyn Fn() + Send + Sync>,
    /// The server asked a form question during a tool call.
    pub elicit: Arc<dyn Fn(ElicitationRequest) -> ElicitFuture + Send + Sync>,
    /// An operator diagnostic (ids only).
    pub diagnostic: DiagnosticHook,
}

#[cfg(test)]
impl SessionHooks {
    /// Hooks that observe nothing and cancel every question.
    pub(crate) fn inert() -> Self {
        Self {
            closed: Arc::new(|| {}),
            tool_list_changed: Arc::new(|| {}),
            elicit: Arc::new(|_| Box::pin(async { ElicitationAnswer::cancel() })),
            diagnostic: Arc::new(|_, _| {}),
        }
    }
}

/// What a connect needs besides the server row: the fresh launch check a stdio child must pass
/// immediately before it executes, the caller's cancellation, and the session's hooks.
pub(crate) struct ConnectContext {
    pub launch_check: Arc<dyn LaunchCheck>,
    pub cancel: CancellationToken,
    pub hooks: SessionHooks,
}

/// Opens sessions. Production dispatches on the row's transport; tests supply named fakes.
pub(crate) trait McpConnector: Send + Sync {
    fn connect<'a>(
        &'a self,
        config: &'a McpConfig,
        secrets: &'a McpSecrets,
        context: ConnectContext,
    ) -> ClientFuture<'a, Arc<dyn McpClient>>;
}
