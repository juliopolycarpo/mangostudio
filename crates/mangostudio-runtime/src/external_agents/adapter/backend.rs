//! Concrete harness factory and host/cancellation adaptation.
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use mango_agent_codex::account::{AccountFingerprintKey, CodexAccount};
use mango_external_agents::{
    CancelToken, EnvSource, Harness, HostContext, Limits, ProcessLauncher,
};
use tokio_util::sync::CancellationToken;

use super::super::port::{self, AccountKey, AgentBackend, AgentResult, Host};
use super::super::supervisor::PortFuture;
use super::super::wire::{self, TargetId};
use super::{failure, map, session};

// Four 2MiB UTF-8 Text resources can expand to 48MiB of JSON. The shared runtime
// prompt allows another 6MiB when every unit needs six-byte escaping. 55MiB also
// covers bounded metadata/native IDs and leaves more than 512KiB for small controls.
// Incoming messages/events, line limits, attachment caps and deadlines stay in Limits.
const ACP_OUTBOUND_BUFFER_BYTES: usize = 55 * 1024 * 1024;

#[cfg(test)]
#[path = "prompt_budget_tests.rs"]
mod prompt_budget_tests;

pub(crate) struct TargetDiscovery {
    pub(crate) discovery: mango_external_agents::Discovery,
    pub(crate) account: Option<CodexAccount>,
#[cfg(test)]
#[path = "close_budget_tests.rs"]
mod close_budget_tests;

/// The longest a `target` session's `close` can legitimately take under `limits`, from the
/// worst cases each harness documents in its "Deadlines" table (`docs/harness-<vendor>.md`
/// of the SDK). With `kg` for `kill_grace` and `st` for `shutdown_timeout`:
///
/// | Target | Worst case | Documented path (defaults 2 s / 5 s) |
/// | ------ | ---------- | ------------------------------------ |
/// | Cursor (ACP) | `2 kg + 6 st` | agent exit to `Closed`, 34 s; a plain `close` is `2 kg + 5 st`, 29 s |
/// | Codex | `3 kg + 7 st` | the `3 kg + 6 st` teardown, 36 s, plus one `st` a close joining it after an inbound overflow can wait first, 41 s; that last `st` is a margin read from the SDK's overflow paragraph, not a Deadlines row |
/// | Claude | `2 kg + 4 st` | a close over a launch still pending, 24 s; with a turn active it is `2 kg + 3 st`, 19 s |
///
/// The launcher is the runtime's own, not the SDK's `TokioLauncher`, so the Claude figure is the
/// one the SDK documents for any launcher. Sums saturate, so a limit near `Duration::MAX` stays
/// a bound rather than a panic.
///
/// ```ignore
/// let bound = close_budget(&Limits::default(), TargetId::Cursor); // 34 s
/// ```
pub(super) fn close_budget(limits: &Limits, target: TargetId) -> Duration {
    let (graces, timeouts) = match target {
        TargetId::Cursor => (2, 6),
        TargetId::Codex => (3, 7),
        TargetId::Claude => (2, 4),
    };
    limits
        .kill_grace
        .saturating_mul(graces)
        .saturating_add(limits.shutdown_timeout.saturating_mul(timeouts))
}

}

pub(crate) trait SdkHarnessFactory: Send + Sync {
    fn harness(&self, target: TargetId, executable: Option<PathBuf>) -> Arc<dyn Harness>;
    fn discover<'a>(
        &'a self,
        target: TargetId,
        executable: Option<PathBuf>,
        host: &'a HostContext,
        key: Option<&'a AccountFingerprintKey>,
    ) -> PortFuture<'a, mango_external_agents::Result<TargetDiscovery>>;
}

pub(crate) struct ProductHarnesses;
impl SdkHarnessFactory for ProductHarnesses {
    fn harness(&self, target: TargetId, executable: Option<PathBuf>) -> Arc<dyn Harness> {
        map::harness_for(target, executable)
    }
    fn discover<'a>(
        &'a self,
        target: TargetId,
        executable: Option<PathBuf>,
        host: &'a HostContext,
        key: Option<&'a AccountFingerprintKey>,
    ) -> PortFuture<'a, mango_external_agents::Result<TargetDiscovery>> {
        Box::pin(async move {
            if target != TargetId::Codex {
                return Ok(TargetDiscovery {
                    discovery: map::harness_for(target, executable).discover(host).await?,
                    account: None,
                });
            }
            let found = map::codex_harness(executable)
                .discover_with_account(host, key.unwrap_or_else(|| map::plan_only_key()))
                .await?;
            Ok(TargetDiscovery {
                discovery: found.discovery,
                account: match key {
                    Some(_) => found.account,
                    None => found.account.map(map::plan_only),
                },
            })
        })
    }
}

pub(crate) struct Backend {
    launcher: Arc<dyn ProcessLauncher>,
    harnesses: Arc<dyn SdkHarnessFactory>,
    limits: Limits,
    cleanup_timeout: Duration,
}
impl Backend {
    pub(crate) fn new(
        launcher: Arc<dyn ProcessLauncher>,
        harnesses: Arc<dyn SdkHarnessFactory>,
        limits: Limits,
        cleanup_timeout: Duration,
    ) -> Self {
        Self {
            launcher,
            harnesses,
            limits,
            cleanup_timeout,
        }
    }
    /// Builds the SDK host with its own cancel token, returning the product token to link it to.
    ///
    /// ```ignore
    /// let (cancel, sdk_cancel, host) = self.linked_host(host)?;
    /// ```
    fn linked_host(
        &self,
        host: Host,
    ) -> AgentResult<(CancellationToken, CancelToken, HostContext)> {
        let cancel = host.cancel.clone();
        let sdk_cancel = CancelToken::new();
        let context = self
            .host(host, sdk_cancel.clone())
            .map_err(failure::facts)?;
        Ok((cancel, sdk_cancel, context))
    }
    fn host(&self, host: Host, cancel: CancelToken) -> mango_external_agents::Result<HostContext> {
        let mut builder = HostContext::builder()
            .launcher(Arc::clone(&self.launcher))
            .cwd(host.cwd)
            .environment(EnvSource::from_pairs(host.environment))
            .client_info("mangostudio-runtime", host.runtime_version)
            .cancel(cancel)
            .limits(self.limits)
            .outbound_buffer_bytes(ACP_OUTBOUND_BUFFER_BYTES);
        if let Some(scratch) = host.scratch {
            builder = builder.scratch(scratch);
        }
        builder.build()
    }
}

/// Links cancellation while an operation is polled, then lets the SDK settle the same future.
/// This adds no task, queue or retained watcher to a successfully opened session.
async fn cancellable<T>(
    cancel: CancellationToken,
    sdk_cancel: CancelToken,
    work: impl Future<Output = T>,
) -> T {
    let mut work = std::pin::pin!(work);
    tokio::select! {
        biased;
        () = cancel.cancelled() => { sdk_cancel.cancel(); work.await }
        result = &mut work => result,
    }
}

#[async_trait::async_trait]
impl AgentBackend for Backend {
    fn close_budget(&self, target: TargetId) -> Duration {
        close_budget(&self.limits, target)
    }
    async fn discover(
        &self,
        target: TargetId,
        executable: Option<PathBuf>,
        host: Host,
        key: Option<&AccountKey>,
    ) -> AgentResult<wire::Descriptor> {
        let (cancel, sdk_cancel, host) = self.linked_host(host)?;
        let key = key
            .map(|key| AccountFingerprintKey::new(key.bytes()).expect("the owned key is nonempty"));
        cancellable(cancel, sdk_cancel, async {
            let found = failure::settled(
                self.harnesses
                    .discover(target, executable, &host, key.as_ref())
                    .await,
                self.cleanup_timeout,
            )
            .await?;
            Ok(map::descriptor(
                target,
                &found.discovery,
                found.account.as_ref(),
                crate::ports::wall_clock::epoch_millis(std::time::SystemTime::now()),
            ))
        })
        .await
    }
    async fn open(
        &self,
        target: TargetId,
        executable: PathBuf,
        host: Host,
        params: &wire::OpenParams,
    ) -> AgentResult<Box<dyn port::AgentSession>> {
        let (cancel, sdk_cancel, host) = self.linked_host(host)?;
        let harness = self.harnesses.harness(target, Some(executable));
        let mut request = mango_external_agents::OpenSession::new(params.session_id.clone())
            .with_configuration(map::configuration_patch(&params.configuration));
        if let Some(native) = &params.resume_ref {
            request = request.resuming(
                native.clone(),
                match params.resume_mode {
                    wire::ResumeMode::Strict => mango_external_agents::ResumeMode::Strict,
                    wire::ResumeMode::Fallback => mango_external_agents::ResumeMode::Fallback,
                },
            );
        }
        cancellable(cancel, sdk_cancel, async {
            let inner = failure::settled(
                harness.open_session(&host, request).await,
                self.cleanup_timeout,
            )
            .await?;
            Ok(Box::new(session::SessionAdapter::new(
                inner,
                target,
                self.cleanup_timeout,
            )) as Box<dyn port::AgentSession>)
        })
        .await
    }
    async fn list_sessions(
        &self,
        target: TargetId,
        executable: Option<PathBuf>,
        host: Host,
        query: port::SessionQuery,
    ) -> AgentResult<wire::ListSessionsResult> {
        let (cancel, sdk_cancel, host) = self.linked_host(host)?;
        let harness = self.harnesses.harness(target, executable);
        let query = mango_external_agents::SessionQuery {
            cursor: query.cursor,
            limit: query.limit,
            workspace_path: query.workspace_path,
        };
        cancellable(cancel, sdk_cancel, async {
            let page = failure::settled(
                harness.list_sessions(&host, query).await,
                self.cleanup_timeout,
            )
            .await?;
            Ok(map::native_sessions(target, page))
        })
        .await
    }
}
