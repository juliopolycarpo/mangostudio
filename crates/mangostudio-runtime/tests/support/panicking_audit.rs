//! An [`Audit`] fake that panics inside `record`, to prove a failing sink
//! cannot alter the wire result of the call it is recording.

use std::future::Future;
use std::pin::Pin;

use mangostudio_runtime::ports::audit::{Audit, AuditEntry};

/// Panics every time `record` is called.
#[derive(Debug, Clone, Copy, Default)]
pub struct PanickingAudit;

impl Audit for PanickingAudit {
    fn record<'a>(&'a self, _entry: AuditEntry) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async { panic!("PanickingAudit always panics in record()") })
    }
}
