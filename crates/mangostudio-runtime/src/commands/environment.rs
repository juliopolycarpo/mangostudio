//! Explicit child environments; no process-global environment reads here.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use regex::Regex;
use serde::Deserialize;

const COMMON: &[&str] = &[
    "PATH",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "SystemRoot",
    "SYSTEMROOT",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CONFIG_HOME",
    "SSH_AUTH_SOCK",
];
const GIT: &[&str] = &["GIT_CONFIG_GLOBAL", "PROGRAMDATA", "GNUPGHOME", "GPG_TTY"];
const GH: &[&str] = &[
    "APPDATA",
    "GH_CONFIG_DIR",
    "GH_HOST",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
];

/// Exact-name shell overrides. An explicit deny always wins.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct ShellEnvPolicy {
    /// Credential-looking names the operator explicitly allows.
    #[serde(default)]
    pub allow: Vec<String>,
    /// Names withheld even when explicitly allowed.
    #[serde(default)]
    pub deny: Vec<String>,
}

/// Filters a captured environment before invoking a user shell.
///
/// # Example
///
/// ```
/// use std::collections::BTreeMap;
/// use mangostudio_runtime::commands::environment::{shell, ShellEnvPolicy};
/// let source = BTreeMap::from([("API_KEY".into(), "private".into())]);
/// assert!(shell(&source, &ShellEnvPolicy::default()).is_empty());
/// ```
pub fn shell(
    source: &BTreeMap<String, String>,
    policy: &ShellEnvPolicy,
) -> BTreeMap<String, String> {
    source
        .iter()
        .filter(|(key, value)| {
            !policy.deny.contains(key) && (policy.allow.contains(key) || !secret(key, value))
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn secret(key: &str, value: &str) -> bool {
    static KEY: OnceLock<Regex> = OnceLock::new();
    static URL: OnceLock<Regex> = OnceLock::new();
    let key_pattern = KEY.get_or_init(|| {
        Regex::new(
        "(?i:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)"
    ).expect("constant credential-name regex")
    });
    let url_pattern = URL.get_or_init(|| {
        // Match ECMAScript whitespace: it includes BOM and excludes NEL.
        Regex::new(r"(?i)^[a-z][a-z0-9+.-]*://[^/?#@[\s--\u{0085}]\u{feff}]*:[^/?#@[\s--\u{0085}]\u{feff}]*@")
            .expect("constant credential-URL regex")
    });
    key_pattern.is_match(key) || url_pattern.is_match(value)
}

/// Keeps Git's configuration, signing, and SSH context without other credentials.
///
/// # Example
///
/// ```
/// let env = mangostudio_runtime::commands::environment::git(&Default::default());
/// assert_eq!(env["GIT_TERMINAL_PROMPT"], "0");
/// ```
pub fn git(source: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut env = selected(source, GIT);
    env.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
    env.insert("GIT_OPTIONAL_LOCKS".into(), "0".into());
    env
}

/// Keeps GitHub CLI's own login configuration and omits injected token variables.
///
/// # Example
///
/// ```
/// let env = mangostudio_runtime::commands::environment::gh(&Default::default());
/// assert_eq!(env["GH_PROMPT_DISABLED"], "1");
/// ```
pub fn gh(source: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut env = selected(source, GH);
    for key in ["GH_PROMPT_DISABLED", "GH_NO_UPDATE_NOTIFIER", "NO_COLOR"] {
        env.insert(key.into(), "1".into());
    }
    env
}

fn selected(source: &BTreeMap<String, String>, extra: &[&str]) -> BTreeMap<String, String> {
    let mut env: BTreeMap<_, _> = COMMON
        .iter()
        .chain(extra)
        .filter_map(|key| {
            source
                .get(*key)
                .map(|value| ((*key).to_owned(), value.clone()))
        })
        .collect();
    env.insert("LC_ALL".into(), "C".into());
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_removes_credentials_and_applies_exact_overrides() {
        let source = BTreeMap::from([
            ("PATH".into(), "/bin".into()),
            ("API_KEY".into(), "secret".into()),
            (
                "DATABASE_URL".into(),
                "postgres://user:password@host/db".into(),
            ),
            ("BASE_URL".into(), "https://host/".into()),
        ]);
        let sanitized = shell(&source, &ShellEnvPolicy::default());
        assert_eq!(
            sanitized.keys().map(String::as_str).collect::<Vec<_>>(),
            ["BASE_URL", "PATH"]
        );
        let policy = ShellEnvPolicy {
            allow: vec!["API_KEY".into(), "DATABASE_URL".into()],
            deny: vec!["API_KEY".into()],
        };
        let overridden = shell(&source, &policy);
        assert!(!overridden.contains_key("API_KEY"));
        assert_eq!(overridden["DATABASE_URL"], source["DATABASE_URL"]);
    }

    #[test]
    fn fixed_cli_environments_preserve_configuration_but_not_tokens() {
        let source = BTreeMap::from([
            ("PATH".into(), "/bin".into()),
            ("SSH_AUTH_SOCK".into(), "/agent".into()),
            ("GNUPGHOME".into(), "/keys".into()),
            ("APPDATA".into(), "C:\\config".into()),
            ("GH_TOKEN".into(), "private".into()),
            ("GITHUB_TOKEN".into(), "private".into()),
            ("GH_ENTERPRISE_TOKEN".into(), "private".into()),
            ("LC_ALL".into(), "pt_BR".into()),
        ]);
        let git_env = git(&source);
        assert_eq!(git_env["GNUPGHOME"], "/keys");
        assert_eq!(git_env["GIT_OPTIONAL_LOCKS"], "0");
        let gh_env = gh(&source);
        assert_eq!(gh_env["APPDATA"], "C:\\config");
        assert_eq!(gh_env["GH_NO_UPDATE_NOTIFIER"], "1");
        for env in [git_env, gh_env] {
            assert_eq!(env["LC_ALL"], "C");
            assert_eq!(env["SSH_AUTH_SOCK"], "/agent");
            assert!(!env.values().any(|value| value == "private"));
        }
    }

    #[test]
    fn secret_patterns_cover_names_and_credential_urls() {
        for key in [
            "api-key",
            "PASSWORD",
            "private_key",
            "accesskey",
            "credentials",
        ] {
            assert!(secret(key, "value"));
        }
        assert!(secret("DATABASE_URL", "redis://:pw@localhost"));
        assert!(secret("DATABASE_URL", "https://user:pw\u{85}@host"));
        assert!(!secret("DATABASE_URL", "https://user:pw\u{feff}@host"));
        assert!(!secret("HTTP_PROXY", "https://proxy:8080"));
        assert!(!secret("PATH", "/bin"));
    }
}
