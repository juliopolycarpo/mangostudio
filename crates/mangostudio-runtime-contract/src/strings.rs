//! The contracts between a hub and a runtime that are not schemas: values a
//! peer in another language would otherwise have to type again by hand.
//!
//! Mirrors `apps/shared/src/runtime-contract/generated/strings.json`, which is
//! itself emitted from `apps/shared/src/runtime-contract/strings.ts`. The
//! constants below exist so the dispatcher in `crates/mangostudio-runtime` and
//! its transports have a typed, documented home for these values; a test in
//! this module asserts every one against the embedded JSON so the mirror
//! cannot drift silently.

// Small constants have drift assertions below. GraphQL documents are loaded
// directly so a new shared query never needs a second hand-maintained copy.
use std::sync::OnceLock;

use serde_json::Value;

/// `strings.json`, exactly as `bun run contracts:emit` wrote it.
const STRINGS_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../apps/shared/src/runtime-contract/generated/strings.json"
));

static STRINGS: OnceLock<Value> = OnceLock::new();

/// Parses the embedded document once for typed accessors and drift assertions.
fn document() -> &'static Value {
    STRINGS.get_or_init(|| {
        serde_json::from_str(STRINGS_JSON).expect("strings.json is well-formed JSON")
    })
}

/// Returns the GraphQL documents the product permits through `gh api graphql`.
/// The generated artifact derives these from the shared TypeScript source.
///
/// # Example
///
/// ```
/// assert!(!mangostudio_runtime_contract::strings::github_graphql_documents().is_empty());
/// ```
pub fn github_graphql_documents() -> &'static [String] {
    static DOCUMENTS: OnceLock<Vec<String>> = OnceLock::new();
    DOCUMENTS.get_or_init(|| {
        serde_json::from_value(document()["githubGraphqlDocuments"].clone())
            .expect("generated GitHub GraphQL documents are strings")
    })
}

/// What a runtime prints to stderr when nobody on its machine has answered
/// the consent question yet.
pub const RUNTIME_SETUP_PENDING_SIGNATURE: &str = "runtime setup is pending on this machine";

/// Exit code marking an intentional restart for a live binary update, distinct
/// from ordinary process failure.
pub const RUNTIME_UPDATE_EXIT_CODE: u8 = 75;

/// Prefix marking a runtime pairing token in a paste or a bug report.
pub const RUNTIME_PAIRING_TOKEN_PREFIX: &str = "mrt_";

/// How a `serve` runtime tells one environment record reconnecting from a
/// second record pointing at the same runtime.
///
/// A hub sends an opaque binding key in the [`binding::HEADER`] upgrade
/// request header, beside its bearer token. While a live connection holds a
/// key, a connection with a different key is refused with
/// [`binding::ALREADY_BOUND_CLOSE_CODE`] before either side's `hello`.
pub mod binding {
    /// The upgrade request header the hub's binding key rides in.
    pub const HEADER: &str = "x-mangostudio-hub-binding";
    /// Exact length of a binding key: a SHA-256 digest in lowercase hex.
    pub const LENGTH: usize = 64;
    /// Close code refusing a connection for a different binding key. Unnamed
    /// by the protocol, so application-owned; 423 is HTTP's "Locked".
    pub const ALREADY_BOUND_CLOSE_CODE: u16 = 4423;
    /// The reason sent with [`ALREADY_BOUND_CLOSE_CODE`].
    pub const ALREADY_BOUND_REASON: &str = "runtime already bound to another environment";
}

/// Directory and file names under a runtime-home slot, and the slots
/// themselves.
pub mod runtime_home {
    /// The three runtime-home slots, in `strings.json` order.
    pub const SLOTS: [&str; 3] = ["host", "wsl", "remote"];
    /// The directory a runtime keeps all of its state under, in the user's home.
    pub const HOME_DIR_NAME: &str = ".mango";
    /// The directory one runtime slot's install lives under, inside [`HOME_DIR_NAME`].
    pub const RUNTIME_DIR_NAME: &str = "runtime";
    /// The link (or junction, on Windows) naming the active install.
    pub const CURRENT_LINK_NAME: &str = "current";
    /// The file holding one slot's `runtime.json` configuration.
    pub const CONFIG_FILE_NAME: &str = "runtime.json";
    /// The lock file guarding concurrent writers to [`CONFIG_FILE_NAME`].
    pub const CONFIG_LOCK_FILE_NAME: &str = "runtime.lock";
    /// The file holding one slot's stored credentials.
    pub const CREDENTIALS_FILE_NAME: &str = "credentials.json";
    /// The file one slot appends its audit trail to.
    pub const AUDIT_LOG_FILE_NAME: &str = "audit.log";
    /// The runtime binary's file name, before any platform-specific extension.
    pub const BINARY_BASENAME: &str = "mangostudio-runtime";
}

/// Re-exported so [`crate::errors`]'s tests can assert its own mirror against
/// the same parsed document without embedding `strings.json` a second time.
#[cfg(test)]
pub(crate) fn errors_document() -> &'static Value {
    &document()["errors"]
}

#[cfg(test)]
mod tests {
    use super::{
        RUNTIME_PAIRING_TOKEN_PREFIX, RUNTIME_SETUP_PENDING_SIGNATURE, RUNTIME_UPDATE_EXIT_CODE,
        binding, document, github_graphql_documents, runtime_home,
    };

    #[test]
    fn the_already_bound_code_is_an_unnamed_non_fatal_protocol_close_code() {
        use mango_protocol::close::{
            MAX_CLOSE_CODE, MIN_CLOSE_CODE, close_code_name, is_fatal_close_code,
        };
        let code = binding::ALREADY_BOUND_CLOSE_CODE;
        assert!(
            (MIN_CLOSE_CODE..=MAX_CLOSE_CODE).contains(&code),
            "expected a close code in {MIN_CLOSE_CODE}..={MAX_CLOSE_CODE} | received: {code}"
        );
        assert_eq!(
            close_code_name(code),
            None,
            "expected a code the protocol does not name | received: {code} named {:?}",
            close_code_name(code)
        );
        assert!(
            !is_fatal_close_code(code),
            "expected a retryable (non-fatal) close code | received: fatal {code}"
        );
    }

    #[test]
    fn github_documents_are_loaded_from_the_shared_artifact() {
        let documents = github_graphql_documents();
        assert!(!documents.is_empty());
        assert_eq!(
            serde_json::json!(documents),
            document()["githubGraphqlDocuments"]
        );
        assert!(documents.iter().all(|query| query.starts_with("query(")));
    }

    #[test]
    fn the_setup_pending_signature_mirrors_strings_json() {
        assert_eq!(
            RUNTIME_SETUP_PENDING_SIGNATURE,
            document()["setupPendingSignature"]
                .as_str()
                .expect("a string")
        );
    }

    #[test]
    fn the_update_exit_code_mirrors_strings_json() {
        assert_eq!(
            u64::from(RUNTIME_UPDATE_EXIT_CODE),
            document()["updateExitCode"].as_u64().expect("a number")
        );
    }

    #[test]
    fn the_pairing_token_prefix_mirrors_strings_json() {
        assert_eq!(
            RUNTIME_PAIRING_TOKEN_PREFIX,
            document()["pairingTokenPrefix"].as_str().expect("a string")
        );
    }

    #[test]
    fn the_binding_constants_mirror_strings_json() {
        let binding_document = &document()["binding"];
        assert_eq!(
            binding::HEADER,
            binding_document["header"].as_str().expect("a string")
        );
        assert_eq!(
            binding::LENGTH as u64,
            binding_document["length"].as_u64().expect("a number")
        );
        assert_eq!(
            u64::from(binding::ALREADY_BOUND_CLOSE_CODE),
            binding_document["alreadyBoundCloseCode"]
                .as_u64()
                .expect("a number")
        );
        assert_eq!(
            binding::ALREADY_BOUND_REASON,
            binding_document["alreadyBoundReason"]
                .as_str()
                .expect("a string")
        );
    }

    #[test]
    fn the_runtime_home_names_mirror_strings_json() {
        let home = &document()["runtimeHome"];
        let slots: Vec<&str> = home["slots"]
            .as_array()
            .expect("an array")
            .iter()
            .map(|value| value.as_str().expect("a string"))
            .collect();
        assert_eq!(runtime_home::SLOTS.to_vec(), slots);
        assert_eq!(
            runtime_home::HOME_DIR_NAME,
            home["homeDirName"].as_str().unwrap()
        );
        assert_eq!(
            runtime_home::RUNTIME_DIR_NAME,
            home["runtimeDirName"].as_str().unwrap()
        );
        assert_eq!(
            runtime_home::CURRENT_LINK_NAME,
            home["currentLinkName"].as_str().unwrap()
        );
        assert_eq!(
            runtime_home::CONFIG_FILE_NAME,
            home["configFileName"].as_str().unwrap()
        );
        assert_eq!(
            runtime_home::CONFIG_LOCK_FILE_NAME,
            home["configLockFileName"].as_str().unwrap()
        );
        assert_eq!(
            runtime_home::CREDENTIALS_FILE_NAME,
            home["credentialsFileName"].as_str().unwrap()
        );
        assert_eq!(
            runtime_home::AUDIT_LOG_FILE_NAME,
            home["auditLogFileName"].as_str().unwrap()
        );
        assert_eq!(
            runtime_home::BINARY_BASENAME,
            home["binaryBasename"].as_str().unwrap()
        );
    }
}
