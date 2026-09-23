//! The project-owned MCP client seam. The service speaks only these traits; `sdk.rs` is the one
//! implementation that depends on `rmcp`, and tests implement them with named fakes.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;
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
    /// Ends the session and releases everything it owns, including a stdio server's process
    /// tree. Repeated calls are harmless.
    fn close(&self) -> ClientFuture<'_, ()>;
}

/// What a connect needs besides the server row: the fresh launch check a stdio child must pass
/// immediately before it executes, and the caller's cancellation.
pub(crate) struct ConnectContext {
    pub launch_check: Arc<dyn LaunchCheck>,
    pub cancel: CancellationToken,
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
