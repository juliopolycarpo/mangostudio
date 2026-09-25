//! Every environment variable the Rust runtime host reads, parsed here and
//! nowhere else — the root `AGENTS.md` rule this module exists to satisfy,
//! and the discipline the deleted TypeScript host's `apps/runtime/src/config.ts`
//! kept before it.
//!
//! Mirrors `loadRuntimeConfig` in `apps/runtime/src/config.ts`, with one
//! deliberate omission: `NODE_ENV`. See [`RuntimeConfig`]'s doc comment for
//! why it does not cross over.

use std::path::PathBuf;

use crate::runtime_home::{home_dir, mango_home_dir};

/// A source of environment variables, so parsing can be exercised without
/// touching the real process environment.
///
/// `std::env::var` already returns `Option<String>` for "set to valid
/// Unicode", which is exactly the lookup this module needs — a variable set
/// to invalid Unicode is treated the same as unset, matching Node, which
/// would hand `config.ts` a `string | undefined` either way.
pub trait EnvSource {
    /// The value of `key`, or `None` when it is unset (or not valid Unicode).
    fn var(&self, key: &str) -> Option<String>;
}

/// Reads the real process environment.
///
/// # Example
/// ```
/// use mangostudio_runtime::config::{EnvSource, ProcessEnv};
///
/// // Reads whatever this process actually has, if anything.
/// let _ = ProcessEnv.var("PATH");
/// ```
pub struct ProcessEnv;

impl EnvSource for ProcessEnv {
    fn var(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
}

/// A fixed map of variables, for tests that must not depend on — or leak
/// into — the real process environment.
///
/// # Example
/// ```
/// use mangostudio_runtime::config::{EnvSource, MapEnv};
///
/// let env = MapEnv::from([("MANGO_HOME", "/tmp/example-mango-home")]);
/// assert_eq!(env.var("MANGO_HOME").as_deref(), Some("/tmp/example-mango-home"));
/// assert_eq!(env.var("MISSING"), None);
/// ```
#[derive(Debug, Clone, Default)]
pub struct MapEnv(std::collections::HashMap<String, String>);

impl<K: Into<String>, V: Into<String>, const N: usize> From<[(K, V); N]> for MapEnv {
    fn from(pairs: [(K, V); N]) -> Self {
        Self(
            pairs
                .into_iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect(),
        )
    }
}

impl EnvSource for MapEnv {
    fn var(&self, key: &str) -> Option<String> {
        self.0.get(key).cloned()
    }
}

/// The environment variable name for [`RuntimeConfig::pairing_token`].
pub const MANGOSTUDIO_RUNTIME_TOKEN: &str = "MANGOSTUDIO_RUNTIME_TOKEN";
/// The environment variable name for [`RuntimeConfig::serve_token`].
pub const MANGOSTUDIO_RUNTIME_SERVE_TOKEN: &str = "MANGOSTUDIO_RUNTIME_SERVE_TOKEN";
/// The environment variable name for the `MANGO_HOME` override folded into
/// [`RuntimeConfig::mango_home`].
pub const MANGO_HOME: &str = "MANGO_HOME";
/// The environment variable name for [`RuntimeConfig::setup_profile`].
pub const MANGOSTUDIO_RUNTIME_SETUP: &str = "MANGOSTUDIO_RUNTIME_SETUP";

/// Runtime-owned environment parsing for the Rust host.
///
/// Deliberately carries no `validate_in_process_frames` or
/// `validate_handler_results` field, unlike the TypeScript
/// [`RuntimeConfig`](https://github.com/juliopolycarpo/mangostudio/blob/ef72e2f09cb82a4e73a06c6ea6ef91ff66032992/apps/runtime/src/config.ts):
///
/// - `validateHandlerResults` is `!production` in TypeScript, off in
///   production so an invalid result still reaches a caller who did nothing
///   wrong rather than becoming a 500. That check is unconditional in
///   this Rust host instead — an invalid result must never serialise as
///   success, with no environment escape — so there is no flag left to
///   read here, in either environment.
/// - `validateInProcessFrames` exists only for the hub-embeds-runtime
///   in-process transport, which was a Node concept (the since-deleted
///   `apps/api/src/services/runtime-client/connect-in-process-runtime.ts`).
///   A Rust binary is never embedded in the hub process, so the transport
///   the flag guards does not exist here to guard.
///
/// `NODE_ENV` therefore has nothing left to control on this side and is not
/// read at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeConfig {
    /// Pairing credential for `connect`. Never a command-line argument —
    /// argv is world-readable on every platform this runs on.
    pub pairing_token: Option<String>,
    /// Serve credential for `serve`. Kept distinct from `pairing_token` so a
    /// host that both dials and listens never reuses one credential for two
    /// trust decisions.
    pub serve_token: Option<String>,
    /// Absolute `~/.mango` (or `.mango`-equivalent), or wherever `MANGO_HOME`
    /// points. What every runtime-home path in [`crate::runtime_home`] is
    /// resolved beneath.
    pub mango_home: PathBuf,
    /// A consent answer supplied by the environment instead of by a person.
    ///
    /// Left unvalidated here, exactly as in TypeScript: a later `setup`
    /// surface reports an unusable value rather than this module silently
    /// discarding it.
    pub setup_profile: Option<String>,
}

/// Trims `value`, then folds an all-whitespace or absent result to `None`.
///
/// The one rule every string-valued environment variable in this module
/// follows: `loadRuntimeConfig` trims with `.trim()` and then checks
/// `.length > 0`, and every one of these four variables repeats that pair.
fn trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

impl RuntimeConfig {
    /// Parses the runtime's environment variables out of `env`.
    ///
    /// # Errors
    /// When `MANGO_HOME` is unset (or blank) and [`home_dir`] cannot
    /// resolve a platform default either — see that function's own doc
    /// comment for why this is a `Result` and not a panic.
    ///
    /// # Example
    /// ```
    /// use mangostudio_runtime::config::{MapEnv, RuntimeConfig};
    ///
    /// let env = MapEnv::from([("MANGOSTUDIO_RUNTIME_TOKEN", "  mrt_abc  ")]);
    /// let config = RuntimeConfig::from_env(&env).unwrap();
    /// assert_eq!(config.pairing_token.as_deref(), Some("mrt_abc"));
    /// assert_eq!(config.serve_token, None);
    /// ```
    pub fn from_env(env: &impl EnvSource) -> std::io::Result<Self> {
        let home_override = trimmed(env.var(MANGO_HOME));
        let mango_home = match home_override {
            Some(value) => PathBuf::from(value),
            None => mango_home_dir(&home_dir()?),
        };
        Ok(Self {
            pairing_token: trimmed(env.var(MANGOSTUDIO_RUNTIME_TOKEN)),
            serve_token: trimmed(env.var(MANGOSTUDIO_RUNTIME_SERVE_TOKEN)),
            mango_home,
            setup_profile: trimmed(env.var(MANGOSTUDIO_RUNTIME_SETUP)),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{MapEnv, RuntimeConfig};

    #[test]
    fn trims_and_empties_the_pairing_token() {
        let env = MapEnv::from([("MANGOSTUDIO_RUNTIME_TOKEN", "  mrt_abc  ")]);
        assert_eq!(
            RuntimeConfig::from_env(&env)
                .unwrap()
                .pairing_token
                .as_deref(),
            Some("mrt_abc")
        );

        let blank = MapEnv::from([("MANGOSTUDIO_RUNTIME_TOKEN", "   ")]);
        assert_eq!(RuntimeConfig::from_env(&blank).unwrap().pairing_token, None);
    }

    #[test]
    fn an_absent_token_is_none_not_empty_string() {
        let env = MapEnv::default();
        assert_eq!(RuntimeConfig::from_env(&env).unwrap().pairing_token, None);
    }

    #[test]
    fn the_serve_token_is_independent_of_the_pairing_token() {
        let env = MapEnv::from([
            ("MANGOSTUDIO_RUNTIME_TOKEN", "pairing"),
            ("MANGOSTUDIO_RUNTIME_SERVE_TOKEN", "serve"),
        ]);
        let config = RuntimeConfig::from_env(&env).unwrap();
        assert_eq!(config.pairing_token.as_deref(), Some("pairing"));
        assert_eq!(config.serve_token.as_deref(), Some("serve"));
    }

    #[test]
    fn mango_home_takes_the_trimmed_override_verbatim() {
        let env = MapEnv::from([("MANGO_HOME", "  /srv/mango  ")]);
        assert_eq!(
            RuntimeConfig::from_env(&env).unwrap().mango_home,
            PathBuf::from("/srv/mango")
        );
    }

    #[test]
    fn a_blank_mango_home_override_falls_back_to_the_platform_default() {
        let env = MapEnv::from([("MANGO_HOME", "   ")]);
        let config = RuntimeConfig::from_env(&env).unwrap();
        // Whatever the platform default is, it must not be the literal blank
        // string a naive `.map_or_else` bug would produce.
        assert_ne!(config.mango_home, PathBuf::from(""));
        assert!(config.mango_home.ends_with(".mango"));
    }

    #[test]
    fn the_setup_profile_is_read_verbatim_and_not_validated() {
        // Mirrors config.ts: an unrecognised value is still reported, not
        // discarded here — `setup` is the surface that judges it.
        let env = MapEnv::from([("MANGOSTUDIO_RUNTIME_SETUP", "not-a-real-profile")]);
        assert_eq!(
            RuntimeConfig::from_env(&env)
                .unwrap()
                .setup_profile
                .as_deref(),
            Some("not-a-real-profile")
        );
    }
}
