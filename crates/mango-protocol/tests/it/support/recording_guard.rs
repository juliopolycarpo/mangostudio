//! A `Guard` fake that records every method/capabilities pair it sees, and
//! optionally denies a call whose capabilities include one it was told to.

use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;

use mango_protocol::contract::Guard;
use mango_protocol::error::{RemoteError, codes};
use mango_protocol::session::CallContext;
use serde_json::Value;

/// Records `[method, ...capabilities]` for every call it sees, mirroring
/// the shape `packages/protocol/tests/contract.test.ts`'s guard test
/// asserts on (`seen: string[][]`).
pub struct RecordingGuard {
    seen: Mutex<Vec<Vec<String>>>,
    denies_capability: Option<String>,
}

impl RecordingGuard {
    /// A guard that records every call and denies none of them.
    pub fn new() -> Self {
        Self {
            seen: Mutex::new(Vec::new()),
            denies_capability: None,
        }
    }

    /// A guard that denies any call whose capabilities include `capability`.
    pub fn denying(capability: impl Into<String>) -> Self {
        Self {
            seen: Mutex::new(Vec::new()),
            denies_capability: Some(capability.into()),
        }
    }

    /// Every `[method, ...capabilities]` entry recorded so far.
    pub fn seen(&self) -> Vec<Vec<String>> {
        self.seen
            .lock()
            .expect("the mutex is never held across a panic in this test")
            .clone()
    }
}

impl Guard for RecordingGuard {
    fn check<'a>(
        &'a self,
        method: &'a str,
        _params: &'a Value,
        capabilities: &'a [String],
        _context: &'a CallContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RemoteError>> + Send + 'a>> {
        Box::pin(async move {
            let mut entry = vec![method.to_string()];
            entry.extend(capabilities.iter().cloned());
            self.seen
                .lock()
                .expect("the mutex is never held across a panic in this test")
                .push(entry);
            if let Some(capability) = &self.denies_capability
                && capabilities.iter().any(|granted| granted == capability)
            {
                return Err(RemoteError::new(
                    codes::DENIED,
                    format!("{capability} was not granted"),
                )
                .with_detail("capability", capability.clone()));
            }
            Ok(())
        })
    }
}
