//! `probe_auth_file`, `probe_config_key` and `directory_exists`, mirroring
//! `apps/shared/src/environments/detection/auth-signal.ts`: presence-only
//! credential signals (a file exists, a config key exists), never a
//! credential's value.
//!
//! # The privacy invariant this module exists to preserve
//!
//! [`probe_config_key`] reads a bounded, non-secret CLI config only to test
//! whether a key is present in it. It never reads, stores, logs or
//! transmits a credential value — only the boolean this module returns
//! ever escapes, and the parsed document is unreachable the instant this
//! function returns. Any change to this module must keep that property
//! exactly; it is a stated product decision in the TypeScript source, not
//! an implementation detail this port is free to relax.
//!
//! # Why a permission error is never read as "absent"
//!
//! [`directory_exists`], [`probe_auth_file`] and [`probe_config_key`] all
//! distinguish "the path is not there" from "something stopped this
//! process from finding out" (a permission error, a transient I/O
//! failure). Reporting the second as the first would turn a directory this
//! process merely cannot see into "create it", or a credential file this
//! process cannot read into "not signed in" — both wrong, and both worse
//! than saying `unknown`.

use super::types::AgentAuthSignal;

/// The bound on how much of a config file [`probe_config_key`] will read,
/// so a large or hostile file cannot turn a health probe into a memory
/// problem.
pub const MAX_AUTH_CONFIG_BYTES: usize = 256 * 1024;

/// The subset of a `stat` result these probes need.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthSignalStat {
    /// Whether the path is a directory.
    pub is_directory: bool,
    /// Whether the path is a regular file.
    pub is_file: bool,
}

/// The filesystem seam every probe in this module needs. Synchronous,
/// mirroring the TypeScript original's synchronous `fs.statSync`/
/// `fs.readFileSync` calls — these probes run on a fast path with no
/// subprocess or network I/O of their own.
pub trait AuthSignalFs: Send + Sync {
    /// Reads `path`'s metadata, or `Err` when it could not be read (a
    /// missing path, or a permission/I/O failure — see
    /// [`is_missing_path_error`] for how a caller tells the two apart).
    fn stat(&self, path: &str) -> Result<AuthSignalStat, std::io::Error>;
    /// Reads `path` as UTF-8 text, bounded at `max_bytes`.
    fn read_file(&self, path: &str, max_bytes: usize) -> Result<String, std::io::Error>;
}

/// What one probe found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthSignalResult {
    /// Whether this probe found a positive credential signal.
    pub authenticated: bool,
    /// The signal this verdict is based on.
    pub auth_signal: AgentAuthSignal,
}

/// True only for "the path is not there", never for a permission or I/O
/// failure — [`std::io::ErrorKind::NotFound`] and
/// [`std::io::ErrorKind::NotADirectory`] (a path segment that should have
/// been a directory was a file instead) are the two shapes "the path
/// genuinely is not there" can take.
#[must_use]
pub fn is_missing_path_error(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    )
}

/// Reports absence only when `path` is genuinely not there. A permission
/// or I/O failure hides the directory rather than proving it missing —
/// see the module docs — and this crate's own callers must not turn
/// `false` into "create it" on the strength of an error that never
/// answered the question.
#[must_use]
pub fn directory_exists(path: &str, fs: &dyn AuthSignalFs) -> bool {
    match fs.stat(path) {
        Ok(stat) => stat.is_directory,
        Err(error) => !is_missing_path_error(&error),
    }
}

/// Credential files are presence-only signals: this checks only that
/// `path` exists as a file, and never reads it.
#[must_use]
pub fn probe_auth_file(
    path: &str,
    unknown_when_missing: bool,
    fs: &dyn AuthSignalFs,
) -> AuthSignalResult {
    match fs.stat(path) {
        Ok(stat) if stat.is_file => {
            return AuthSignalResult {
                authenticated: true,
                auth_signal: AgentAuthSignal::FilePresent,
            };
        }
        Ok(_) => {}
        // A permission or I/O failure says nothing about sign-in state, so
        // it must not become a definite verdict.
        Err(error) if !is_missing_path_error(&error) => {
            return AuthSignalResult {
                authenticated: false,
                auth_signal: AgentAuthSignal::Unknown,
            };
        }
        Err(_) => {}
    }

    AuthSignalResult {
        authenticated: false,
        auth_signal: if unknown_when_missing {
            AgentAuthSignal::Unknown
        } else {
            AgentAuthSignal::FileAbsent
        },
    }
}

/// Cursor exposes sign-in state as a key in its ordinary CLI config. See
/// the module docs for the privacy policy this function follows: it may
/// read a bounded, non-secret config to test whether a key is present,
/// never to learn or carry the credential itself.
#[must_use]
pub fn probe_config_key(path: &str, key: &str, fs: &dyn AuthSignalFs) -> AuthSignalResult {
    match fs.stat(path) {
        Ok(stat) if !stat.is_file => {
            return AuthSignalResult {
                authenticated: false,
                auth_signal: AgentAuthSignal::ConfigKeyAbsent,
            };
        }
        Ok(_) => {}
        // An absent config is a signed-out verdict; a permission or I/O
        // failure is not, so it must not be reported as a definite "not
        // authenticated".
        Err(error) => {
            let auth_signal = if is_missing_path_error(&error) {
                AgentAuthSignal::ConfigKeyAbsent
            } else {
                AgentAuthSignal::Unknown
            };
            return AuthSignalResult {
                authenticated: false,
                auth_signal,
            };
        }
    }

    let Ok(content) = fs.read_file(path, MAX_AUTH_CONFIG_BYTES) else {
        return AuthSignalResult {
            authenticated: false,
            auth_signal: AgentAuthSignal::Unknown,
        };
    };
    match serde_json::from_str::<serde_json::Value>(&content) {
        // A config that parses but is not a JSON object (an array, a bare
        // string) can never carry `key` as an object property; treated
        // the same as an object that parses but lacks the key — the parse
        // itself succeeded, so this is still `config-key-present`, not
        // `unknown`.
        Ok(serde_json::Value::Object(fields)) => AuthSignalResult {
            authenticated: fields.contains_key(key),
            auth_signal: AgentAuthSignal::ConfigKeyPresent,
        },
        Ok(_) => AuthSignalResult {
            authenticated: false,
            auth_signal: AgentAuthSignal::ConfigKeyPresent,
        },
        Err(_) => AuthSignalResult {
            authenticated: false,
            auth_signal: AgentAuthSignal::Unknown,
        },
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::io::{Error, ErrorKind};

    use super::*;

    /// A named fake filesystem for these probes: a map of paths to either
    /// a stat result or file contents, plus an explicit set of paths that
    /// answer with a permission error instead of a missing-path one.
    #[derive(Default)]
    struct FakeAuthSignalFs {
        stats: HashMap<String, AuthSignalStat>,
        files: HashMap<String, String>,
        permission_denied: std::collections::HashSet<String>,
    }

    impl AuthSignalFs for FakeAuthSignalFs {
        fn stat(&self, path: &str) -> Result<AuthSignalStat, Error> {
            if self.permission_denied.contains(path) {
                return Err(Error::from(ErrorKind::PermissionDenied));
            }
            self.stats
                .get(path)
                .copied()
                .ok_or_else(|| Error::from(ErrorKind::NotFound))
        }

        fn read_file(&self, path: &str, _max_bytes: usize) -> Result<String, Error> {
            if self.permission_denied.contains(path) {
                return Err(Error::from(ErrorKind::PermissionDenied));
            }
            self.files
                .get(path)
                .cloned()
                .ok_or_else(|| Error::from(ErrorKind::NotFound))
        }
    }

    fn file_stat() -> AuthSignalStat {
        AuthSignalStat {
            is_directory: false,
            is_file: true,
        }
    }

    fn dir_stat() -> AuthSignalStat {
        AuthSignalStat {
            is_directory: true,
            is_file: false,
        }
    }

    #[test]
    fn directory_exists_is_false_only_when_the_path_is_genuinely_missing() {
        let fs = FakeAuthSignalFs::default();
        assert!(!directory_exists("/nowhere", &fs));
    }

    #[test]
    fn directory_exists_is_true_for_a_real_directory() {
        let fs = FakeAuthSignalFs {
            stats: HashMap::from([("/home/t/.claude".to_string(), dir_stat())]),
            ..Default::default()
        };
        assert!(directory_exists("/home/t/.claude", &fs));
    }

    #[test]
    fn directory_exists_treats_a_permission_error_as_present_not_absent() {
        let fs = FakeAuthSignalFs {
            permission_denied: std::collections::HashSet::from(["/root/.claude".to_string()]),
            ..Default::default()
        };
        assert!(directory_exists("/root/.claude", &fs));
    }

    #[test]
    fn probe_auth_file_reports_file_present_when_the_file_exists() {
        let fs = FakeAuthSignalFs {
            stats: HashMap::from([("/home/t/.credentials.json".to_string(), file_stat())]),
            ..Default::default()
        };
        let result = probe_auth_file("/home/t/.credentials.json", true, &fs);
        assert_eq!(
            result,
            AuthSignalResult {
                authenticated: true,
                auth_signal: AgentAuthSignal::FilePresent
            }
        );
    }

    #[test]
    fn probe_auth_file_reports_unknown_when_missing_and_configured_to() {
        let fs = FakeAuthSignalFs::default();
        let result = probe_auth_file("/home/t/.credentials.json", true, &fs);
        assert_eq!(
            result,
            AuthSignalResult {
                authenticated: false,
                auth_signal: AgentAuthSignal::Unknown
            }
        );
    }

    #[test]
    fn probe_auth_file_reports_file_absent_when_missing_and_not_configured_unknown() {
        let fs = FakeAuthSignalFs::default();
        let result = probe_auth_file("/home/t/auth.json", false, &fs);
        assert_eq!(
            result,
            AuthSignalResult {
                authenticated: false,
                auth_signal: AgentAuthSignal::FileAbsent
            }
        );
    }

    #[test]
    fn probe_auth_file_reports_unknown_on_a_permission_error_even_when_not_configured_unknown_when_missing()
     {
        let fs = FakeAuthSignalFs {
            permission_denied: std::collections::HashSet::from(["/home/t/auth.json".to_string()]),
            ..Default::default()
        };
        let result = probe_auth_file("/home/t/auth.json", false, &fs);
        assert_eq!(
            result,
            AuthSignalResult {
                authenticated: false,
                auth_signal: AgentAuthSignal::Unknown
            }
        );
    }

    #[test]
    fn probe_config_key_reports_absent_when_the_config_file_is_missing() {
        let fs = FakeAuthSignalFs::default();
        let result = probe_config_key("/home/t/cli-config.json", "authInfo", &fs);
        assert_eq!(
            result,
            AuthSignalResult {
                authenticated: false,
                auth_signal: AgentAuthSignal::ConfigKeyAbsent
            }
        );
    }

    #[test]
    fn probe_config_key_reports_unknown_on_a_permission_error() {
        let fs = FakeAuthSignalFs {
            permission_denied: std::collections::HashSet::from([
                "/home/t/cli-config.json".to_string()
            ]),
            ..Default::default()
        };
        let result = probe_config_key("/home/t/cli-config.json", "authInfo", &fs);
        assert_eq!(
            result,
            AuthSignalResult {
                authenticated: false,
                auth_signal: AgentAuthSignal::Unknown
            }
        );
    }

    #[test]
    fn probe_config_key_reports_authenticated_when_the_key_is_present() {
        let fs = FakeAuthSignalFs {
            stats: HashMap::from([("/home/t/cli-config.json".to_string(), file_stat())]),
            files: HashMap::from([(
                "/home/t/cli-config.json".to_string(),
                r#"{"authInfo": {"token": "x"}}"#.to_string(),
            )]),
            ..Default::default()
        };
        let result = probe_config_key("/home/t/cli-config.json", "authInfo", &fs);
        assert_eq!(
            result,
            AuthSignalResult {
                authenticated: true,
                auth_signal: AgentAuthSignal::ConfigKeyPresent
            }
        );
    }

    #[test]
    fn probe_config_key_reports_not_authenticated_when_the_key_is_absent_but_the_config_parses() {
        let fs = FakeAuthSignalFs {
            stats: HashMap::from([("/home/t/cli-config.json".to_string(), file_stat())]),
            files: HashMap::from([(
                "/home/t/cli-config.json".to_string(),
                r#"{"other": true}"#.to_string(),
            )]),
            ..Default::default()
        };
        let result = probe_config_key("/home/t/cli-config.json", "authInfo", &fs);
        assert_eq!(
            result,
            AuthSignalResult {
                authenticated: false,
                auth_signal: AgentAuthSignal::ConfigKeyPresent
            }
        );
    }

    #[test]
    fn probe_config_key_reports_unknown_for_malformed_json() {
        let fs = FakeAuthSignalFs {
            stats: HashMap::from([("/home/t/cli-config.json".to_string(), file_stat())]),
            files: HashMap::from([(
                "/home/t/cli-config.json".to_string(),
                "not json".to_string(),
            )]),
            ..Default::default()
        };
        let result = probe_config_key("/home/t/cli-config.json", "authInfo", &fs);
        assert_eq!(
            result,
            AuthSignalResult {
                authenticated: false,
                auth_signal: AgentAuthSignal::Unknown
            }
        );
    }

    /// Never leaks a credential's actual value into the result: even when
    /// the key's value carries a secret-shaped string, only the boolean
    /// escapes this function.
    #[test]
    fn probe_config_key_never_carries_the_credential_value_in_its_result() {
        let fs = FakeAuthSignalFs {
            stats: HashMap::from([("/home/t/cli-config.json".to_string(), file_stat())]),
            files: HashMap::from([(
                "/home/t/cli-config.json".to_string(),
                r#"{"authInfo": "sk-super-secret-token"}"#.to_string(),
            )]),
            ..Default::default()
        };
        let result = probe_config_key("/home/t/cli-config.json", "authInfo", &fs);
        assert!(result.authenticated);
        // `AuthSignalResult` has exactly two fields — a boolean and an
        // enum — so there is no field the credential value could have
        // ended up in even by accident.
    }
}
