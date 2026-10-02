//! Private SDK integration. Concrete harnesses, handles, conversions and launcher glue stay here.
mod failure;
mod launcher;
mod map;
mod map_events;
mod session;

mod backend;
#[cfg(test)]
mod lifecycle_tests;
#[cfg(test)]
mod relay_tests;
#[cfg(test)]
mod test_support;
use super::port::AgentBackend;
use crate::subprocess::LaunchCheck;
use mango_external_agents::Limits;
use std::sync::Arc;
use std::time::Duration;

/// Constructs the SDK implementation around MangoStudio's guarded launcher.
///
/// ```ignore
/// let backend = production_backend(consent_check, CLEANUP_TIMEOUT);
/// ```
pub(super) fn production_backend(
    check: Arc<dyn LaunchCheck>,
    cleanup_timeout: Duration,
) -> Arc<dyn AgentBackend> {
    let limits = Limits::default();
    Arc::new(backend::Backend::new(
        Arc::new(launcher::GuardedProcessLauncher::new(check, &limits)),
        Arc::new(backend::ProductHarnesses),
        limits,
        cleanup_timeout,
    ))
}

#[cfg(test)]
pub(super) use backend::{Backend, SdkHarnessFactory, TargetDiscovery};

#[cfg(test)]
pub(super) fn sdk_remote_error(
    error: &mango_external_agents::Error,
) -> mango_protocol::error::RemoteError {
    map::remote_error(error)
}
