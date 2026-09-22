//! The real [`Authorization`]: what `runtime.json` actually grants, re-read
//! on every call through a [`ConsentSource`].
//!
//! Mirrors `consent-gate.ts`'s `missingCapabilities`: the declared
//! capability list a method needs (supplied by
//! [`crate::ports::authorization::AuthorizationGuard`], from the contract
//! itself) filtered down to the ones the freshly-resolved `allow` set does
//! not grant.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use crate::consent::source::ConsentSource;
use crate::ports::authorization::Authorization;
use crate::runtime_home::RuntimeSlot;

/// Asks a [`ConsentSource`] which capabilities `runtime.json` currently
/// grants, fresh on every call.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::consent::authorization::ConsentAuthorization;
/// use mangostudio_runtime::consent::source::ConsentSource;
/// use mangostudio_runtime::ports::authorization::Authorization;
/// use mangostudio_runtime::runtime_home::RuntimeSlot;
///
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// let home = std::env::temp_dir().join("mango-consent-authorization-doctest");
/// let source = ConsentSource::new(RuntimeSlot::Remote, home);
/// let authorization = ConsentAuthorization::new(source);
/// // `remote` starts pending: everything is missing.
/// let missing = authorization
///     .missing_capabilities("shell.run", &["shell".to_string()])
///     .await;
/// assert_eq!(missing, vec!["shell".to_string()]);
/// # }
/// ```
pub struct ConsentAuthorization {
    source: Arc<ConsentSource>,
}

impl ConsentAuthorization {
    /// Builds an authorization port over `source`.
    #[must_use]
    pub fn new(source: ConsentSource) -> Self {
        Self {
            source: Arc::new(source),
        }
    }

    /// The slot this authorization's consent is read from — for wiring a
    /// [`crate::ports::authorization::AuthorizationGuard`], which names the
    /// slot in a denial's remediation sentence.
    #[must_use]
    pub fn slot(&self) -> RuntimeSlot {
        self.source.slot()
    }
}

impl Authorization for ConsentAuthorization {
    fn missing_capabilities<'a>(
        &'a self,
        _method: &'a str,
        capabilities: &'a [String],
    ) -> Pin<Box<dyn Future<Output = Vec<String>> + Send + 'a>> {
        Box::pin(async move {
            let source = Arc::clone(&self.source);
            let read = crate::blocking::run_blocking(move || source.refresh());
            let Ok(allow) = tokio::time::timeout(Duration::from_secs(2), read).await else {
                return capabilities.to_vec();
            };
            capabilities
                .iter()
                .filter(|capability| !allow.is_granted(capability))
                .cloned()
                .collect()
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::ConsentAuthorization;
    use crate::consent::source::ConsentSource;
    use crate::ports::authorization::Authorization;
    use crate::runtime_home::{RuntimeSlot, write_runtime_slot_config};
    use crate::test_support::scratch_dir as scratch_home;

    #[tokio::test]
    async fn a_fully_granted_capability_is_never_reported_missing() {
        let home = scratch_home("granted");
        let authorization =
            ConsentAuthorization::new(ConsentSource::new(RuntimeSlot::Host, home.to_path_buf()));
        let missing = authorization
            .missing_capabilities("terminal.list", &["shell".to_string()])
            .await;
        assert!(missing.is_empty(), "host defaults to full");
    }

    #[tokio::test]
    async fn an_ungranted_capability_is_reported_missing() {
        let home = scratch_home("denied");
        let authorization =
            ConsentAuthorization::new(ConsentSource::new(RuntimeSlot::Remote, home.to_path_buf()));
        let missing = authorization
            .missing_capabilities("terminal.list", &["shell".to_string()])
            .await;
        assert_eq!(missing, vec!["shell".to_string()]);
    }

    #[tokio::test]
    async fn only_the_ungranted_half_of_several_declared_capabilities_is_reported() {
        let home = scratch_home("partial");
        write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[(
                "allow",
                Some(json!({ "checkpoints": true, "fsRead": false })),
            )],
        )
        .unwrap();
        let authorization =
            ConsentAuthorization::new(ConsentSource::new(RuntimeSlot::Host, home.to_path_buf()));
        let missing = authorization
            .missing_capabilities(
                "snapshot.capture",
                &["checkpoints".to_string(), "fsRead".to_string()],
            )
            .await;
        assert_eq!(missing, vec!["fsRead".to_string()]);
    }

    #[tokio::test]
    async fn a_zero_capability_method_is_never_missing_anything() {
        let home = scratch_home("zero-capability");
        let authorization =
            ConsentAuthorization::new(ConsentSource::new(RuntimeSlot::Remote, home.to_path_buf()));
        let missing = authorization
            .missing_capabilities("runtime.health", &[])
            .await;
        assert!(missing.is_empty());
    }

    #[tokio::test]
    async fn consent_is_re_read_on_every_call() {
        let home = scratch_home("re-read");
        let authorization =
            ConsentAuthorization::new(ConsentSource::new(RuntimeSlot::Host, home.to_path_buf()));
        assert!(
            authorization
                .missing_capabilities("terminal.list", &["shell".to_string()])
                .await
                .is_empty(),
            "host starts fully consented"
        );

        write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[("allow", Some(json!({ "shell": false })))],
        )
        .unwrap();

        assert_eq!(
            authorization
                .missing_capabilities("terminal.list", &["shell".to_string()])
                .await,
            vec!["shell".to_string()],
            "a revocation must take effect on the very next call, without reconnecting"
        );
    }
}
