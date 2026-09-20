//! The contracts between a hub and a runtime that are not schemas: values a
//! peer in another language would otherwise have to type again by hand.
//!
//! Mirrors `apps/shared/src/runtime-contract/generated/strings.json`, which is
//! itself emitted from `apps/shared/src/runtime-contract/strings.ts`. The
//! constants below exist so the dispatcher in `crates/mangostudio-runtime` and
//! its transports have a typed, documented home for these values; a test in
//! this module asserts every one against the embedded JSON so the mirror
//! cannot drift silently.

// `strings.json` backs only the drift tests below — every constant a caller
// actually uses is a plain literal, verified against the embedded text
// rather than parsed from it at call time. Kept behind `cfg(test)` so a
// production build carries no unused-in-that-profile warning; `cargo test`
// (part of every gate this crate runs under) still proves the embed is live
// and Cargo's dep-info still tracks it for that target.
#[cfg(test)]
use std::sync::OnceLock;

#[cfg(test)]
use serde_json::Value;

/// `strings.json`, exactly as `bun run contracts:emit` wrote it.
#[cfg(test)]
const STRINGS_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../apps/shared/src/runtime-contract/generated/strings.json"
));

#[cfg(test)]
static STRINGS: OnceLock<Value> = OnceLock::new();

/// The parsed `strings.json` document, for the tests in this crate that
/// assert a Rust constant against it. Not part of the public API: a caller
/// wants the typed constant, not a `Value` to index by hand.
#[cfg(test)]
fn document() -> &'static Value {
    STRINGS.get_or_init(|| {
        serde_json::from_str(STRINGS_JSON).expect("strings.json is well-formed JSON")
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
        document, runtime_home,
    };

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
