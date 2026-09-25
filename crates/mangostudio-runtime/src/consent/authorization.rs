//! The real [`Authorization`]: what `runtime.json` actually grants, re-read
//! on every call through a [`ConsentSource`].
//!
//! Mirrors `consent-gate.ts`'s `missingCapabilities`: the declared
//! capability list a method needs (supplied by
//! [`crate::ports::authorization::AuthorizationGuard`], from the contract
//! itself) filtered down to the ones the freshly-resolved `allow` set does
//! not grant.
//!
//! A read that does not finish within the consent read timeout is inconclusive, not a denial.
//! An effect-producing method still fails closed on it (every declared capability is reported
//! missing), but a stop-only method (listed in `consent::stop_only`) proceeds: it only ends
//! something the live-resource watchers keep alive through the same inconclusive read, so
//! refusing it would leave the caller unable to stop what consent cannot confirm. Reads are coalesced through one
//! `ConsentReader`, so a hung store holds one blocking permit however many calls wait on it.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use crate::consent::presets::ResolvedCapabilityAllow;
use crate::consent::read::{CONSENT_READ_TIMEOUT, ConsentReader};
use crate::consent::source::ConsentSource;
use crate::consent::stop_only::is_stop_only;
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
    slot: RuntimeSlot,
    read: ReadAllow,
    reader: ConsentReader<ResolvedCapabilityAllow>,
    timeout: Duration,
}

/// One fresh read of the resolved `allow` set, run on the blocking pool.
type ReadAllow = Arc<dyn Fn() -> ResolvedCapabilityAllow + Send + Sync>;

impl ConsentAuthorization {
    /// Builds an authorization port over `source`.
    #[must_use]
    pub fn new(source: ConsentSource) -> Self {
        let slot = source.slot();
        Self::with_read(
            slot,
            Arc::new(move || source.refresh()),
            CONSENT_READ_TIMEOUT,
        )
    }

    /// Builds an authorization port over any `read`, bounded by `timeout` — the seam tests use
    /// to stand in a stalled consent store.
    fn with_read(slot: RuntimeSlot, read: ReadAllow, timeout: Duration) -> Self {
        Self {
            slot,
            read,
            reader: ConsentReader::new("consent"),
            timeout,
        }
    }

    /// The slot this authorization's consent is read from — for wiring a
    /// [`crate::ports::authorization::AuthorizationGuard`], which names the
    /// slot in a denial's remediation sentence.
    #[must_use]
    pub fn slot(&self) -> RuntimeSlot {
        self.slot
    }
}

impl Authorization for ConsentAuthorization {
    fn missing_capabilities<'a>(
        &'a self,
        method: &'a str,
        capabilities: &'a [String],
    ) -> Pin<Box<dyn Future<Output = Vec<String>> + Send + 'a>> {
        Box::pin(async move {
            if capabilities.is_empty() {
                return Vec::new();
            }
            let read = Arc::clone(&self.read);
            let Some(allow) = self.reader.read_value(self.timeout, move || read()).await else {
                return missing_when_inconclusive(method, capabilities);
            };
            capabilities
                .iter()
                .filter(|capability| !allow.is_granted(capability))
                .cloned()
                .collect()
        })
    }
}

/// What an inconclusive read reports missing: nothing for a stop-only method, everything the
/// method declares otherwise.
fn missing_when_inconclusive(method: &str, capabilities: &[String]) -> Vec<String> {
    if is_stop_only(method) {
        return Vec::new();
    }
    capabilities.to_vec()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::ConsentAuthorization;
    use crate::consent::source::ConsentSource;
    use crate::ports::authorization::Authorization;
    use crate::runtime_home::{RuntimeSlot, write_runtime_slot_config};
    use crate::test_support::scratch_dir as scratch_home;

    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use crate::consent::presets::consent_preset;
    use crate::consent::read::ConsentReader;
    use crate::consent::stall_gate::StallGate;
    use crate::consent::stop_only::STOP_ONLY_METHODS;
    use mangostudio_runtime_contract::catalog::catalog;

    const BOUND: Duration = Duration::from_millis(50);

    /// A consent store whose every read stays stuck until the store is dropped, counting reads
    /// started. Held by a gate rather than a sleep, so a loaded machine cannot end the stall
    /// mid-test and start a second read.
    struct StalledStore {
        started: Arc<AtomicUsize>,
        gate: StallGate,
    }

    impl StalledStore {
        fn new() -> Self {
            Self {
                started: Arc::new(AtomicUsize::new(0)),
                gate: StallGate::new(),
            }
        }

        fn authorization(&self) -> ConsentAuthorization {
            let started = Arc::clone(&self.started);
            let held = self.gate.handle();
            ConsentAuthorization::with_read(
                RuntimeSlot::Host,
                Arc::new(move || {
                    started.fetch_add(1, Ordering::SeqCst);
                    held.wait();
                    consent_preset(mangostudio_runtime_contract::manifest::ManifestProfile::Full)
                }),
                BOUND,
            )
        }

        fn reads(&self) -> usize {
            self.started.load(Ordering::SeqCst)
        }
    }

    #[tokio::test]
    async fn a_stalled_store_lets_stop_only_methods_stop_what_the_watchers_keep_alive() {
        let store = StalledStore::new();
        let authorization = store.authorization();
        let shell = vec!["shell".to_string()];
        let mcp = vec!["mcp".to_string()];
        let cancel = authorization
            .missing_capabilities("install.cancel", &shell)
            .await;
        let disconnect = authorization
            .missing_capabilities("mcp.disconnect", &mcp)
            .await;
        // The watcher polling the same stalled store keeps the chain/session alive.
        let held = store.gate.handle();
        let watcher = ConsentReader::new("shell")
            .read(BOUND, move || {
                held.wait();
                true
            })
            .await;
        let empty: Vec<String> = Vec::new();
        assert_eq!(
            (cancel.as_slice(), disconnect.as_slice(), watcher.revokes()),
            (empty.as_slice(), empty.as_slice(), false),
            "expected (install.cancel missing, mcp.disconnect missing, watcher revokes) =              ([], [], false) during a stall | received ({cancel:?}, {disconnect:?}, {watcher:?})"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_stalled_store_still_refuses_every_effect_producing_method() {
        let store = StalledStore::new();
        let authorization = Arc::new(store.authorization());
        // Spawned together so every check lands inside the one stalled read.
        let checks: Vec<_> = catalog()
            .methods
            .iter()
            .filter(|method| {
                !method.capabilities.is_empty()
                    && !STOP_ONLY_METHODS.contains(&method.name.as_str())
            })
            .map(|method| {
                let authorization = Arc::clone(&authorization);
                tokio::spawn(async move {
                    let missing = authorization
                        .missing_capabilities(&method.name, &method.capabilities)
                        .await;
                    (method.name.as_str(), missing == method.capabilities)
                })
            })
            .collect();
        let mut admitted = Vec::new();
        for check in checks {
            let (name, refused) = check.await.unwrap();
            if !refused {
                admitted.push(name);
            }
        }
        let reads = store.reads();
        assert_eq!(
            (admitted.as_slice(), reads),
            ([].as_slice(), 1),
            "expected (effect-producing methods admitted, reads started) = ([], 1) on an \
             inconclusive read | received ({admitted:?}, {reads})"
        );
    }

    #[tokio::test]
    async fn an_explicit_denial_still_refuses_a_stop_only_method() {
        let home = scratch_home("stop-only-denied");
        let authorization =
            ConsentAuthorization::new(ConsentSource::new(RuntimeSlot::Remote, home.to_path_buf()));
        let missing = authorization
            .missing_capabilities("install.cancel", &["shell".to_string()])
            .await;
        assert_eq!(
            missing,
            vec!["shell".to_string()],
            "expected a denied read to refuse install.cancel | received {missing:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_guard_checks_against_a_hung_store_share_one_read() {
        let store = StalledStore::new();
        let authorization = Arc::new(store.authorization());
        let calls: Vec<_> = (0..6)
            .map(|_| {
                let authorization = Arc::clone(&authorization);
                tokio::spawn(async move {
                    authorization
                        .missing_capabilities("shell.run", &["shell".to_string()])
                        .await
                })
            })
            .collect();
        for call in calls {
            call.await.unwrap();
        }
        let reads = store.reads();
        assert_eq!(
            reads, 1,
            "expected 6 guard checks during one stall to start 1 consent read | received {reads}"
        );
    }

    #[tokio::test]
    async fn a_zero_capability_method_never_reads_consent() {
        let store = StalledStore::new();
        let missing = store
            .authorization()
            .missing_capabilities("terminal.close", &[])
            .await;
        let reads = store.reads();
        assert_eq!(
            (missing.len(), reads),
            (0, 0),
            "expected (missing, reads) = (0, 0) | received ({}, {reads})",
            missing.len()
        );
    }

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
