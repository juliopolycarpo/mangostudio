//! An [`Audit`] fake that records every entry it sees, for tests to assert
//! against.

use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;

use mangostudio_runtime::ports::audit::{Audit, AuditEntry, lock};

/// Records every [`AuditEntry`] it is given, in order.
#[derive(Default)]
pub struct RecordingAudit {
    entries: Mutex<Vec<AuditEntry>>,
}

impl RecordingAudit {
    /// A sink with no entries recorded yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// Every entry recorded so far, in order.
    pub fn entries(&self) -> Vec<AuditEntry> {
        lock(&self.entries).clone()
    }
}

impl Audit for RecordingAudit {
    fn record<'a>(&'a self, entry: AuditEntry) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            lock(&self.entries).push(entry);
        })
    }
}
