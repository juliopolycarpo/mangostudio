//! Registers the `external-agent.*` methods this build implements.
//!
//! Only the session lifecycle is implemented here: `discover`, `open`,
//! `close`, `list-sessions` and `refresh-account-usage`. The remaining five —
//! turns, answers, steering, reviews and cancellation — are not registered, so
//! the dispatcher answers them `METHOD_UNSUPPORTED` and the manifest keeps
//! `features.externalAgents` off: it is advertised only once every method the
//! capability requires is implemented.

use std::sync::Arc;

use mango_protocol::error::{RemoteError, codes};
use mango_protocol::session::CallContext;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::supervisor::{CloseCause, ExecutableResolver, PortFuture, Supervisor};
use super::wire::TargetId;
use crate::probing::detection::agent_cli_definitions::AgentTargetId;
use crate::registry::Registry;

/// Every method [`register`] installs.
pub(crate) const EXTERNAL_AGENT_METHODS: [&str; 5] = [
    "external-agent.discover",
    "external-agent.open",
    "external-agent.close",
    "external-agent.list-sessions",
    "external-agent.refresh-account-usage",
];

/// Installs [`EXTERNAL_AGENT_METHODS`] on `registry`, all served by one
/// supervisor.
///
/// # Example
///
/// ```ignore
/// let registry = register(registry, Supervisor::new(ports));
/// ```
pub(crate) fn register(mut registry: Registry, supervisor: Arc<Supervisor>) -> Registry {
    for method in EXTERNAL_AGENT_METHODS {
        let supervisor = Arc::clone(&supervisor);
        registry = registry.implement(method, move |params: Value, context: CallContext| {
            let supervisor = Arc::clone(&supervisor);
            async move { call(&supervisor, method, params, &context).await }
        });
    }
    registry
}

async fn call(
    supervisor: &Arc<Supervisor>,
    method: &'static str,
    params: Value,
    context: &CallContext,
) -> Result<Value, RemoteError> {
    let cancel = context.cancel();
    match method {
        "external-agent.discover" => {
            encode(supervisor.discover(decode(method, params)?, cancel).await?)
        }
        "external-agent.open" => encode(
            supervisor
                .open(decode(method, params)?, context.session(), cancel)
                .await?,
        ),
        "external-agent.close" => encode(
            supervisor
                .close_session(decode(method, params)?, CloseCause::Requested)
                .await?,
        ),
        "external-agent.list-sessions" => encode(
            supervisor
                .list_sessions(decode(method, params)?, cancel)
                .await?,
        ),
        "external-agent.refresh-account-usage" => encode(
            supervisor
                .refresh_account_usage(decode(method, params)?, cancel)
                .await?,
        ),
        _ => unreachable!("the external-agent registry names exactly five methods"),
    }
}

fn decode<T: DeserializeOwned>(method: &str, params: Value) -> Result<T, RemoteError> {
    serde_json::from_value(params).map_err(|error| {
        RemoteError::new(
            codes::INTERNAL,
            format!(
                "Runtime method {method:?} received an invalid external-agent payload: {error}; expected its declared object shape."
            ),
        )
        .with_detail("kind", "tool_argument")
    })
}

fn encode(value: impl Serialize) -> Result<Value, RemoteError> {
    serde_json::to_value(value).map_err(|error| {
        RemoteError::new(
            codes::INTERNAL,
            format!("An external-agent result could not be serialized: {error}"),
        )
    })
}

/// The production [`ExecutableResolver`]: the binary `probing.agent-clis`
/// reports as effective for the target.
pub(crate) struct ProbedExecutables;

impl ExecutableResolver for ProbedExecutables {
    fn resolve<'a>(
        &'a self,
        target: TargetId,
        cancel: &'a tokio_util::sync::CancellationToken,
    ) -> PortFuture<'a, Option<std::path::PathBuf>> {
        let target = match target {
            TargetId::Claude => AgentTargetId::Claude,
            TargetId::Codex => AgentTargetId::Codex,
            TargetId::Cursor => AgentTargetId::Cursor,
        };
        Box::pin(crate::probing::methods::resolve_agent_executable(
            target, cancel,
        ))
    }
}
