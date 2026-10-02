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

pub(crate) struct TargetDiscovery {
    pub(crate) discovery: mango_external_agents::Discovery,
    pub(crate) account: Option<CodexAccount>,
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
    fn host(&self, host: Host, cancel: CancelToken) -> mango_external_agents::Result<HostContext> {
        let mut builder = HostContext::builder()
            .launcher(Arc::clone(&self.launcher))
            .cwd(host.cwd)
            .environment(EnvSource::from_pairs(host.environment))
            .client_info("mangostudio-runtime", host.runtime_version)
            .cancel(cancel)
            .limits(self.limits);
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
    fn close_budget(&self) -> Duration {
        self.limits.kill_grace + self.limits.shutdown_timeout
    }
    async fn discover(
        &self,
        target: TargetId,
        executable: Option<PathBuf>,
        host: Host,
        key: Option<&AccountKey>,
    ) -> AgentResult<wire::Descriptor> {
        let cancel = host.cancel.clone();
        let sdk_cancel = CancelToken::new();
        let host = self
            .host(host, sdk_cancel.clone())
            .map_err(failure::facts)?;
        let key = key
            .map(|key| AccountFingerprintKey::new(key.bytes()).expect("the owned key is nonempty"));
        cancellable(cancel, sdk_cancel, async {
            match self
                .harnesses
                .discover(target, executable, &host, key.as_ref())
                .await
            {
                Ok(found) => Ok(map::descriptor(
                    target,
                    &found.discovery,
                    found.account.as_ref(),
                    crate::ports::wall_clock::epoch_millis(std::time::SystemTime::now()),
                )),
                Err(error) => Err(failure::settle(error, self.cleanup_timeout).await),
            }
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
        let cancel = host.cancel.clone();
        let sdk_cancel = CancelToken::new();
        let host = self
            .host(host, sdk_cancel.clone())
            .map_err(failure::facts)?;
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
            match harness.open_session(&host, request).await {
                Ok(inner) => Ok(Box::new(session::SessionAdapter::new(
                    inner,
                    target,
                    self.cleanup_timeout,
                )) as Box<dyn port::AgentSession>),
                Err(error) => Err(failure::settle(error, self.cleanup_timeout).await),
            }
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
        let cancel = host.cancel.clone();
        let sdk_cancel = CancelToken::new();
        let host = self
            .host(host, sdk_cancel.clone())
            .map_err(failure::facts)?;
        let harness = self.harnesses.harness(target, executable);
        let query = mango_external_agents::SessionQuery {
            cursor: query.cursor,
            limit: query.limit,
            workspace_path: query.workspace_path,
        };
        cancellable(cancel, sdk_cancel, async {
            match harness.list_sessions(&host, query).await {
                Ok(page) => Ok(map::native_sessions(target, page)),
                Err(error) => Err(failure::settle(error, self.cleanup_timeout).await),
            }
        })
        .await
    }
}
