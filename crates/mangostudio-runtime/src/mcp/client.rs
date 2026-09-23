//! The only module that depends on `rmcp`. The service speaks project types.

use std::collections::{BTreeMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::time::Duration;

use rmcp::model::{ClientCapabilities, ClientConfig, Implementation, PaginatedRequestParams};
use rmcp::service::RunningService;
use rmcp::transport::{TokioChildProcess, which_command};
use rmcp::{RoleClient, ServiceExt};
use serde::Deserialize;
use serde_json::Value;

use crate::config::EnvSource;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_TOOL_PAGES: usize = 256;

/// A server configuration on the runtime wire. Sensitive values live in `McpSecrets`.
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

/// Write-only values delivered with a connect request.
#[derive(Clone, Default, Deserialize)]
pub(crate) struct McpSecrets {
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// One descriptor returned to the hub by `mcp.list-tools`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ToolDescriptor {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// Server feature bits from the initialize response.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ServerCapabilities {
    pub tools: bool,
    pub resources: bool,
    pub prompts: bool,
}

pub(crate) type ClientFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

/// Project-owned connection. The service never stores an SDK type directly.
pub(crate) trait McpClient: Send {
    fn capabilities(&self) -> ServerCapabilities;
    fn list_tools(&self) -> ClientFuture<'_, Vec<ToolDescriptor>>;
    fn close(&mut self) -> ClientFuture<'_, ()>;
}

/// Injectable connector for test sessions and the real stdio transport.
pub(crate) trait McpConnector: Send + Sync {
    fn connect<'a>(
        &'a self,
        config: &'a McpConfig,
        secrets: &'a McpSecrets,
    ) -> ClientFuture<'a, Box<dyn McpClient>>;
}

/// Connects local stdio servers through the pinned SDK.
///
/// # Example
/// ```ignore
/// let connector = StdioConnector::new("0.1.1");
/// let client = connector.connect(&config, &secrets).await?;
/// ```
pub(crate) struct StdioConnector {
    runtime_version: String,
}

impl StdioConnector {
    pub(crate) fn new(runtime_version: impl Into<String>) -> Self {
        Self {
            runtime_version: runtime_version.into(),
        }
    }
}

impl McpConnector for StdioConnector {
    fn connect<'a>(
        &'a self,
        config: &'a McpConfig,
        secrets: &'a McpSecrets,
    ) -> ClientFuture<'a, Box<dyn McpClient>> {
        Box::pin(async move {
            if config.transport != "stdio" {
                return Err(format!(
                    "MCP server \"{}\" uses transport \"{}\"; expected stdio for this runtime build",
                    config.slug, config.transport
                ));
            }
            let command = config
                .command
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    format!(
                        "MCP server \"{}\" has command {:?}; expected a non-empty stdio command",
                        config.slug, config.command
                    )
                })?;
            let timeout = timeout_for(config)?;
            let mut process = which_command(command).map_err(|error| {
                format!(
                    "MCP server \"{}\" command \"{command}\" was not found: {error}",
                    config.slug
                )
            })?;
            process.args(&config.args);
            process.env_clear();
            process.envs(child_env(
                &crate::config::ProcessEnv,
                &config.env,
                &secrets.env,
            ));
            let (transport, _) = TokioChildProcess::builder(process)
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| {
                    format!("Failed to start MCP server \"{}\": {error}", config.slug)
                })?;
            let info = ClientConfig::new(
                ClientCapabilities::default(),
                Implementation::new("mangostudio", &self.runtime_version),
            );
            let client = tokio::time::timeout(timeout, info.serve(transport))
                .await
                .map_err(|_| {
                    format!(
                        "MCP server \"{}\" did not initialize within {} ms",
                        config.slug,
                        timeout.as_millis()
                    )
                })?
                .map_err(|error| {
                    format!(
                        "MCP server \"{}\" rejected initialize: {error}",
                        config.slug
                    )
                })?;
            let server = client.peer_info().ok_or_else(|| {
                format!(
                    "MCP server \"{}\" returned no initialize information",
                    config.slug
                )
            })?;
            let caps = ServerCapabilities {
                tools: server.capabilities.tools.is_some(),
                resources: server.capabilities.resources.is_some(),
                prompts: server.capabilities.prompts.is_some(),
            };
            Ok(Box::new(RmcpClient {
                client,
                caps,
                timeout,
            }) as Box<dyn McpClient>)
        })
    }
}

struct RmcpClient {
    client: RunningService<RoleClient, ClientConfig>,
    caps: ServerCapabilities,
    timeout: Duration,
}

impl McpClient for RmcpClient {
    fn capabilities(&self) -> ServerCapabilities {
        self.caps
    }

    fn list_tools(&self) -> ClientFuture<'_, Vec<ToolDescriptor>> {
        Box::pin(async move {
            let mut tools = Vec::new();
            let mut cursor = None;
            let mut seen = HashSet::new();
            for _ in 0..MAX_TOOL_PAGES {
                let params = PaginatedRequestParams::default().with_cursor(cursor);
                let page = tokio::time::timeout(self.timeout, self.client.list_tools(Some(params)))
                    .await
                    .map_err(|_| {
                        format!("MCP tools/list exceeded {} ms", self.timeout.as_millis())
                    })?
                    .map_err(|error| format!("MCP tools/list failed: {error}"))?;
                tools.extend(page.tools.into_iter().map(|tool| {
                    ToolDescriptor {
                        name: tool.name.into_owned(),
                        description: tool
                            .description
                            .map_or_else(String::new, |value| value.into_owned()),
                        input_schema: Value::Object((*tool.input_schema).clone()),
                    }
                }));
                let Some(next) = page.next_cursor else {
                    return Ok(tools);
                };
                if !seen.insert(next.clone()) {
                    return Err(format!(
                        "MCP tools/list repeated cursor \"{next}\"; expected a new cursor"
                    ));
                }
                cursor = Some(next);
            }
            Err(format!(
                "MCP tools/list exceeded {MAX_TOOL_PAGES} pages; expected a final page"
            ))
        })
    }

    fn close(&mut self) -> ClientFuture<'_, ()> {
        Box::pin(async move {
            self.client
                .close_with_timeout(Duration::from_secs(3))
                .await
                .map_err(|error| format!("MCP stdio client cleanup failed: {error}"))?;
            Ok(())
        })
    }
}

fn timeout_for(config: &McpConfig) -> Result<Duration, String> {
    let Some(raw) = config.timeout_ms else {
        return Ok(DEFAULT_TIMEOUT);
    };
    if !raw.is_finite() || raw < 1.0 || raw > u64::MAX as f64 {
        return Err(format!(
            "MCP server \"{}\" has timeoutMs {raw}; expected a positive finite millisecond count",
            config.slug
        ));
    }
    Ok(Duration::from_millis(raw as u64))
}

fn child_env(
    source: &dyn EnvSource,
    configured: &BTreeMap<String, String>,
    secrets: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    #[cfg(windows)]
    const KEYS: &[&str] = &[
        "APPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PROCESSOR_ARCHITECTURE",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "USERNAME",
        "USERPROFILE",
        "PROGRAMFILES",
    ];
    #[cfg(not(windows))]
    const KEYS: &[&str] = &[
        "HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "TMPDIR", "LANG", "LC_ALL",
    ];
    let mut env = BTreeMap::new();
    for &key in KEYS {
        if let Some(value) = source.var(key).filter(|value| !value.starts_with("()")) {
            env.insert(key.to_owned(), value);
        }
    }
    env.extend(configured.clone());
    env.extend(secrets.clone());
    env
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::MapEnv;

    #[test]
    fn child_environment_only_inherits_allowlisted_keys_and_explicit_overrides() {
        let source = MapEnv::from([
            ("HOME", "/home/owner"),
            ("PATH", "/usr/bin"),
            ("API_SECRET", "hidden"),
            ("SHELL", "() { bad; }"),
        ]);
        let configured = BTreeMap::from([("PATH".into(), "/custom/bin".into())]);
        let secrets = BTreeMap::from([("MCP_TOKEN".into(), "provided".into())]);
        let env = child_env(&source, &configured, &secrets);
        assert_eq!(env.get("PATH").map(String::as_str), Some("/custom/bin"));
        assert_eq!(env.get("MCP_TOKEN").map(String::as_str), Some("provided"));
        assert!(!env.contains_key("API_SECRET"));
        assert!(!env.contains_key("SHELL"));
    }

    #[test]
    fn timeout_rejects_invalid_values_with_expected_shape() {
        let config = McpConfig {
            id: "one".into(),
            slug: "test".into(),
            transport: "stdio".into(),
            command: Some("fixture".into()),
            args: vec![],
            env: BTreeMap::new(),
            timeout_ms: Some(-1.0),
        };
        assert!(
            timeout_for(&config)
                .unwrap_err()
                .contains("timeoutMs -1; expected a positive finite millisecond count")
        );
    }

    #[tokio::test]
    async fn stdio_connector_initializes_and_reads_every_tool_page() {
        let fixture =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcp_server.mjs");
        let config = McpConfig {
            id: "fixture".into(),
            slug: "fixture".into(),
            transport: "stdio".into(),
            command: Some("bun".into()),
            args: vec![fixture.to_string_lossy().into_owned()],
            env: BTreeMap::new(),
            timeout_ms: Some(10_000.0),
        };
        let mut client = StdioConnector::new("1.2.3")
            .connect(&config, &McpSecrets::default())
            .await
            .expect("the local fixture answers initialize");
        assert_eq!(
            client.capabilities(),
            ServerCapabilities {
                tools: true,
                resources: false,
                prompts: false
            }
        );
        let tools = client.list_tools().await.expect("both tool pages succeed");
        assert_eq!(
            tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        assert_eq!(tools[1].input_schema, serde_json::json!({"type": "object"}));
        client.close().await.expect("the stdio child closes");
    }
}
