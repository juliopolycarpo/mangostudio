//! The production workspace authority: asks the hub that made the call.
//!
//! A spawned runtime cannot know which directories its owner meant to hand an
//! external agent. The hub can: a chat owned by the connection's user, on this
//! environment, with that exact workdir. So admission sends
//! `hub.workspace.authorize` back over the session the request arrived on,
//! and admits the workspace only on an explicit `{ "authorized": true }`.
//!
//! Everything else is a refusal: a timeout, an older hub answering
//! `METHOD_UNSUPPORTED`, a result outside the embedded hub catalog's closed
//! schema, a closed session, or a path the catalog would not let us send.

use std::path::Path;
use std::time::Duration;

use mango_protocol::session::{RequestOptions, Session};
use mangostudio_runtime_contract::hub::{
    HUB_WORKSPACE_AUTHORIZE, validate_hub_params, validate_hub_result,
};
use serde_json::{Value, json};

use super::supervisor::{PortFuture, WorkspaceAuthority};

/// How long one authorization question may wait for the hub's answer.
pub(crate) const HUB_AUTHORIZE_TIMEOUT: Duration = Duration::from_secs(5);

/// Asks the calling hub, per workspace, with a bounded wait.
///
/// # Example
///
/// ```ignore
/// let authority = HubWorkspaceAuthority::new(HUB_AUTHORIZE_TIMEOUT);
/// let admitted = authority.authorize(context.session(), Path::new("/work")).await;
/// ```
pub(crate) struct HubWorkspaceAuthority {
    timeout: Duration,
}

impl HubWorkspaceAuthority {
    /// An authority whose every question gives up after `timeout`.
    pub(crate) fn new(timeout: Duration) -> Self {
        Self { timeout }
    }

    async fn ask(&self, hub: &Session, canonical: &Path) -> bool {
        // Never a lossy form: a substituted character could name a different
        // stored workdir than the directory that was canonicalised.
        let Some(path) = canonical.to_str() else {
            return false;
        };
        let params = json!({ "canonicalPath": path, "purpose": "external-agent" });
        if validate_hub_params(HUB_WORKSPACE_AUTHORIZE, &params).is_err() {
            return false;
        }
        let options = RequestOptions {
            timeout: Some(self.timeout),
            ..RequestOptions::default()
        };
        eprintln!("DIAG ask: sending {params}");
        let answer = hub
            .request_with(HUB_WORKSPACE_AUTHORIZE, params, options)
            .await;
        eprintln!("DIAG ask: answer {answer:?}");
        let Ok(result) = answer else {
            return false;
        };
        explicitly_authorized(&result)
    }
}

/// True only for a result the hub catalog accepts whose `authorized` is `true`.
fn explicitly_authorized(result: &Value) -> bool {
    validate_hub_result(HUB_WORKSPACE_AUTHORIZE, result).is_ok()
        && result.get("authorized") == Some(&Value::Bool(true))
}

impl WorkspaceAuthority for HubWorkspaceAuthority {
    fn authorize<'a>(&'a self, hub: &'a Session, canonical: &'a Path) -> PortFuture<'a, bool> {
        Box::pin(self.ask(hub, canonical))
    }
}

#[cfg(test)]
#[path = "hub_authority_tests.rs"]
mod tests;
