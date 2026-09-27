//! Fresh `mcp` consent for effects that happen after a call was authorized.
//!
//! The registry authorizes each call when it arrives, but a stdio server launches later, and a
//! session outlives the call that opened it. Both re-read the machine's consent here: at launch,
//! immediately before the OS effect, and on the revocation poll that tears live sessions down.

use std::sync::Arc;

use mango_protocol::error::RemoteError;

use crate::consent::source::ConsentSource;
use crate::ports::authorization::consent_denial;
use crate::subprocess::LaunchCheck;

/// Reads whether this machine currently grants `mcp`.
pub(crate) trait McpConsent: Send + Sync {
    /// Re-reads stored consent; `false` means the capability is withdrawn now.
    fn granted(&self) -> bool;
    /// The same `DENIED` error the registry returns for a call without `mcp`.
    fn denial(&self, method: &str) -> RemoteError;
}

impl McpConsent for ConsentSource {
    fn granted(&self) -> bool {
        self.refresh().mcp
    }

    fn denial(&self, method: &str) -> RemoteError {
        consent_denial(method, &["mcp".to_owned()], self.slot().as_str())
    }
}

/// Launch check that refuses a stdio server once `mcp` is withdrawn.
///
/// # Example
/// ```ignore
/// let check = FreshMcpLaunch(consent.clone());
/// check.check()?;
/// ```
pub(crate) struct FreshMcpLaunch(pub Arc<dyn McpConsent>);

impl LaunchCheck for FreshMcpLaunch {
    fn check(&self) -> Result<(), RemoteError> {
        if self.0.granted() {
            return Ok(());
        }
        Err(self.0.denial("mcp.connect"))
    }
}

#[cfg(test)]
pub(crate) mod fakes {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::time::Duration;

    use mango_protocol::error::codes;

    use super::*;

    /// Named fake whose grant a test flips to model revocation, and whose reads a test can
    /// stall to model a slow or contended consent store.
    pub(crate) struct SwitchableConsent {
        granted: AtomicBool,
        stall_ms: AtomicU64,
    }

    impl SwitchableConsent {
        pub(crate) fn granted() -> Arc<Self> {
            Arc::new(Self {
                granted: AtomicBool::new(true),
                stall_ms: AtomicU64::new(0),
            })
        }

        pub(crate) fn revoke(&self) {
            self.granted.store(false, Ordering::SeqCst);
        }

        /// Makes every later read block for `stall` before answering.
        pub(crate) fn stall(&self, stall: Duration) {
            let millis = u64::try_from(stall.as_millis()).unwrap_or(u64::MAX);
            self.stall_ms.store(millis, Ordering::SeqCst);
        }
    }

    impl McpConsent for SwitchableConsent {
        fn granted(&self) -> bool {
            let stall = self.stall_ms.load(Ordering::SeqCst);
            if stall > 0 {
                std::thread::sleep(Duration::from_millis(stall));
            }
            self.granted.load(Ordering::SeqCst)
        }

        fn denial(&self, method: &str) -> RemoteError {
            RemoteError::new(codes::DENIED, format!("{method} needs mcp"))
                .with_detail("kind", "consent_denied")
        }
    }
}

#[cfg(test)]
mod tests {
    use mango_protocol::error::codes;

    use super::fakes::SwitchableConsent;
    use super::*;

    #[test]
    fn launch_check_follows_the_current_grant() {
        let consent = SwitchableConsent::granted();
        let check = FreshMcpLaunch(consent.clone());
        assert!(check.check().is_ok(), "expected a granted launch to pass");
        consent.revoke();
        let error = check
            .check()
            .expect_err("expected a revoked launch to be refused");
        assert_eq!(error.code, codes::DENIED);
        assert_eq!(error.message, "mcp.connect needs mcp");
    }
}
