//! Project-owned MCP shapes: what the hub sends, what a client returns, and how it fails.
//!
//! Nothing here names an SDK type, so the service and its tests stay independent of `rmcp`.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::Deserialize;
use tokio_util::sync::CancellationToken;

/// Request cap applied when neither the call nor the server row sets one
/// (`DEFAULT_MCP_TIMEOUT_MS` in `@mangostudio/shared/mcp`).
pub(crate) const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// A server configuration on the runtime wire. Sensitive values live in [`McpSecrets`].
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpConfig {
    pub id: String,
    pub slug: String,
    pub transport: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub timeout_ms: Option<f64>,
}

/// Write-only values delivered with a connect request and held only in memory.
#[derive(Clone, Default, Deserialize)]
pub(crate) struct McpSecrets {
    /// stdio: secret child environment variables, merged over the row's `env`.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// Server feature bits from the initialize response.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ServerCapabilities {
    pub tools: bool,
    pub resources: bool,
    pub prompts: bool,
}

/// Per-request bounds a client applies against its server.
#[derive(Clone, Debug)]
pub(crate) struct RequestOptions {
    pub timeout: Duration,
    pub cancel: CancellationToken,
}

/// Why a call to the server failed, as the hub branches on it (`details.mcpFailure`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CallFailure {
    Timeout,
    ServerClosed,
    Other,
}

impl CallFailure {
    /// The wire spelling the hub's `classifyMcpCallFailure` reads back.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::ServerClosed => "server_closed",
            Self::Other => "other",
        }
    }
}

/// The class of an MCP failure; the service maps each onto its wire error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FailureKind {
    /// The server could not be reached or rejected the handshake.
    Connection,
    /// A request to a live session failed.
    Call(CallFailure),
    /// The hub cancelled the request.
    Cancelled,
    /// Fresh `mcp` consent refused a launch the registry had already authorized.
    Denied,
}

/// A failed MCP operation with the message the hub shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct McpFailure {
    pub kind: FailureKind,
    pub message: String,
}

impl McpFailure {
    pub(crate) fn connection(message: impl Into<String>) -> Self {
        Self {
            kind: FailureKind::Connection,
            message: message.into(),
        }
    }

    pub(crate) fn call(failure: CallFailure, message: impl Into<String>) -> Self {
        Self {
            kind: FailureKind::Call(failure),
            message: message.into(),
        }
    }

    pub(crate) fn denied(message: impl Into<String>) -> Self {
        Self {
            kind: FailureKind::Denied,
            message: message.into(),
        }
    }

    pub(crate) fn cancelled(message: impl Into<String>) -> Self {
        Self {
            kind: FailureKind::Cancelled,
            message: message.into(),
        }
    }
}

/// Resolves a millisecond count from the wire into a request bound.
///
/// # Example
/// ```ignore
/// assert_eq!(timeout_from(Some(1500.0), "fixture")?, Duration::from_millis(1500));
/// ```
pub(crate) fn timeout_from(raw: Option<f64>, slug: &str) -> Result<Duration, String> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_TIMEOUT);
    };
    if !raw.is_finite() || raw < 1.0 || raw > u64::MAX as f64 {
        return Err(format!(
            "MCP server \"{slug}\" has timeoutMs {raw}; expected a positive finite millisecond count"
        ));
    }
    Ok(Duration::from_millis(raw as u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_rejects_invalid_values_with_expected_shape() {
        for raw in [-1.0, 0.0, f64::NAN, f64::INFINITY] {
            let error = timeout_from(Some(raw), "fixture").expect_err("expected a refusal");
            assert!(
                error.contains("expected a positive finite millisecond count"),
                "expected the refusal to name the expected shape | received {error}"
            );
        }
        assert_eq!(timeout_from(None, "fixture"), Ok(DEFAULT_TIMEOUT));
        assert_eq!(
            timeout_from(Some(1500.0), "fixture"),
            Ok(Duration::from_millis(1500))
        );
    }

    #[test]
    fn call_failures_use_the_hub_spelling() {
        assert_eq!(
            [
                CallFailure::Timeout,
                CallFailure::ServerClosed,
                CallFailure::Other
            ]
            .map(CallFailure::as_str),
            ["timeout", "server_closed", "other"]
        );
    }
}
