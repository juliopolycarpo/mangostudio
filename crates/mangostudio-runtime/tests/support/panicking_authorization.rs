//! An [`Authorization`] fake that panics inside `missing_capabilities`, to
//! prove `AuthorizationGuard` still records an audit entry (and never
//! answers anything but a redacted `INTERNAL`) when the port itself misbehaves.

use std::future::Future;
use std::pin::Pin;

use mangostudio_runtime::ports::authorization::Authorization;

/// Panics every time `missing_capabilities` is called.
#[derive(Debug, Clone, Copy, Default)]
pub struct PanickingAuthorization;

impl Authorization for PanickingAuthorization {
    fn missing_capabilities<'a>(
        &'a self,
        _method: &'a str,
        _capabilities: &'a [String],
    ) -> Pin<Box<dyn Future<Output = Vec<String>> + Send + 'a>> {
        Box::pin(async { panic!("PanickingAuthorization always panics in missing_capabilities()") })
    }
}
