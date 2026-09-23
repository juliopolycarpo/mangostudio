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
    use std::sync::atomic::{AtomicBool, Ordering};

    use mango_protocol::error::codes;

    use super::*;

    /// Named fake whose grant a test flips to model revocation.
    pub(crate) struct SwitchableConsent(pub AtomicBool);

    impl SwitchableConsent {
        pub(crate) fn granted() -> Arc<Self> {
            Arc::new(Self(AtomicBool::new(true)))
        }

        pub(crate) fn revoke(&self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }

    impl McpConsent for SwitchableConsent {
        fn granted(&self) -> bool {
            self.0.load(Ordering::SeqCst)
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
