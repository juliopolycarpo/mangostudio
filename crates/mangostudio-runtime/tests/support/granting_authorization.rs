//! An [`Authorization`] fake that grants every capability a method
//! declares — the opposite default from [`DenyingAuthorization`], needed so
//! a test can reach a handler behind a capability-bearing method without
//! that capability's absence being the only reason
//! [`super::PartiallyGrantingAuthorization`] or `DenyingAuthorization` would
//! have refused it.

use std::future::Future;
use std::pin::Pin;

use mangostudio_runtime::ports::authorization::Authorization;

/// Reports nothing as missing, ever: every capability a method declares is
/// treated as granted.
#[derive(Debug, Clone, Copy, Default)]
pub struct GrantingAuthorization;

impl Authorization for GrantingAuthorization {
    fn missing_capabilities<'a>(
        &'a self,
        _method: &'a str,
        _capabilities: &'a [String],
    ) -> Pin<Box<dyn Future<Output = Vec<String>> + Send + 'a>> {
        Box::pin(async { Vec::new() })
    }
}
