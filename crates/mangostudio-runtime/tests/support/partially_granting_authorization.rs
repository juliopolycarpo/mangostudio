//! An [`Authorization`] fake that grants a caller-chosen subset of
//! capabilities and denies the rest, so a test can prove `AuthorizationGuard`
//! actually consults its port's answer per capability, rather than a test
//! only ever exercising a method whose capability list happens to already
//! settle the question (empty, or wholly denied).

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;

use mangostudio_runtime::ports::authorization::Authorization;

/// Denies every capability not in the set given to [`Self::new`].
pub struct PartiallyGrantingAuthorization {
    granted: HashSet<String>,
}

impl PartiallyGrantingAuthorization {
    /// Grants exactly `granted`; every other capability a method declares is
    /// reported missing.
    pub fn new(granted: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            granted: granted.into_iter().map(Into::into).collect(),
        }
    }
}

impl Authorization for PartiallyGrantingAuthorization {
    fn missing_capabilities<'a>(
        &'a self,
        _method: &'a str,
        capabilities: &'a [String],
    ) -> Pin<Box<dyn Future<Output = Vec<String>> + Send + 'a>> {
        Box::pin(async move {
            capabilities
                .iter()
                .filter(|capability| !self.granted.contains(*capability))
                .cloned()
                .collect()
        })
    }
}
