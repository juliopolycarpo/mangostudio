//! Masking secret-shaped text, wherever it might otherwise reach a log.
//!
//! Mirrors `apps/runtime/src/audit-log.ts`'s `redactCredentialShapes`
//! exactly: the same seven patterns, applied in the same order, each
//! working on the previous one's output. TypeScript reaches for this from
//! `summarizeAuditArgs`, which additionally picks a fixed whitelist of
//! known-safe parameter keys (`path`, `command`, `cols`, …) before ever
//! calling it — that whitelist is params-shape-aware in a way this crate
//! cannot be honestly yet (see [`crate::ports::audit`]'s module docs for
//! why `AuditEntry` carries no `params` at all: this build implements no
//! methods, so it has no params shapes to whitelist against). This module
//! is deliberately narrower: the redaction pass alone, exercised and ready
//! for whichever later change adds the first params whitelist to call it
//! from.

use std::sync::OnceLock;

use regex::Regex;

/// The seven patterns, compiled once. A `flag`/`kv`/`bearer`/… name per
/// field names which shape it targets, matching the order
/// `redactCredentialShapes` applies them in.
struct Patterns {
    /// `--password=secret`, `--token secret`, `-pwd=secret` and similar
    /// flag-style key/value pairs.
    flag_kv: Regex,
    /// `"token": "secret"` inside a JSON-shaped string.
    json_kv: Regex,
    /// `MY_TOKEN=secret`, `API_KEY=secret` — environment-style assignments
    /// whose key merely *contains* a credential-shaped word.
    env_kv: Regex,
    /// `scheme://user:secret@host` — a URL's embedded userinfo password.
    url_userinfo: Regex,
    /// `X-Api-Key: secret`, `Authorization: secret` — header-style pairs.
    header_kv: Regex,
    /// `Bearer <token>`.
    bearer: Regex,
    /// A GitHub or Stripe-style prefixed token (`ghp_…`, `sk_…`, …), which
    /// looks like a secret regardless of what key (if any) names it.
    prefixed_token: Regex,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| Patterns {
        flag_kv: Regex::new(
            r#"(?i)((?:^|[\s,])(?:--?(?:password|passwd|pwd|token|secret|api-?key|access-?token|authorization|auth))\s*[=:]\s*)([^\s"'\\]+)"#,
        )
        .expect("a fixed, hand-checked pattern"),
        json_kv: Regex::new(
            r#"(?i)("(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?token|authorization)"\s*:\s*")([^"]*)(")"#,
        )
        .expect("a fixed, hand-checked pattern"),
        env_kv: Regex::new(
            r#"(?i)\b([A-Za-z_][A-Za-z0-9_]*(?:password|passwd|token|secret|api_?key|access_?key|credentials?|auth)[A-Za-z0-9_]*)=([^\s"'\\]+)"#,
        )
        .expect("a fixed, hand-checked pattern"),
        url_userinfo: Regex::new(r#"([A-Za-z][A-Za-z0-9+.-]*://[^\s:/@]+):[^\s/@]+@"#)
            .expect("a fixed, hand-checked pattern"),
        header_kv: Regex::new(
            r#"(?i)\b((?:x-)?(?:api[-_]?key|access[-_]?token|auth[-_]?token|private[-_]?token)\s*:\s*)([^\s"',]+)"#,
        )
        .expect("a fixed, hand-checked pattern"),
        bearer: Regex::new(r"(?i)\b(Bearer)\s+\S+").expect("a fixed, hand-checked pattern"),
        prefixed_token: Regex::new(r"\b(?:sk|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+\b")
            .expect("a fixed, hand-checked pattern"),
    })
}

/// Masks every credential-shaped substring of `text`, in the same order
/// `redactCredentialShapes` applies its seven patterns.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::audit::redact::redact_credential_shapes;
///
/// assert_eq!(
///     redact_credential_shapes("--token=sk-secret-9f3a-canary"),
///     "--token=***"
/// );
/// assert_eq!(
///     redact_credential_shapes("Authorization: Bearer abc.def.ghi"),
///     "Authorization: Bearer ***"
/// );
/// ```
#[must_use]
pub fn redact_credential_shapes(text: &str) -> String {
    let patterns = patterns();
    let text = patterns.flag_kv.replace_all(text, "$1***");
    let text = patterns.json_kv.replace_all(&text, "$1***$3");
    let text = patterns.env_kv.replace_all(&text, "$1=***");
    let text = patterns.url_userinfo.replace_all(&text, "$1:***@");
    let text = patterns.header_kv.replace_all(&text, "$1***");
    let text = patterns.bearer.replace_all(&text, "$1 ***");
    let text = patterns.prefixed_token.replace_all(&text, "***");
    text.into_owned()
}

#[cfg(test)]
mod tests {
    use super::redact_credential_shapes;

    #[test]
    fn masks_a_long_flag_style_password() {
        assert_eq!(
            redact_credential_shapes("mysql --password=hunter2 --host=db"),
            "mysql --password=*** --host=db"
        );
    }

    #[test]
    fn masks_a_short_flag_style_token_with_a_colon_separator() {
        // The pattern requires an `=` or `:` between key and value — a bare
        // space (`--token supersecret`, no separator) is deliberately not a
        // match, mirroring the TypeScript pattern's own `\s*[=:]\s*`.
        assert_eq!(
            redact_credential_shapes("curl --token:supersecret"),
            "curl --token:***"
        );
    }

    #[test]
    fn masks_a_json_shaped_secret_value() {
        assert_eq!(
            redact_credential_shapes(r#"{"token": "abc123", "path": "/tmp/x"}"#),
            r#"{"token": "***", "path": "/tmp/x"}"#
        );
    }

    #[test]
    fn masks_an_environment_style_assignment() {
        assert_eq!(
            redact_credential_shapes("MY_API_KEY=abc123 OTHER=fine"),
            "MY_API_KEY=*** OTHER=fine"
        );
    }

    #[test]
    fn masks_a_urls_embedded_userinfo_password() {
        assert_eq!(
            redact_credential_shapes("https://user:hunter2@example.test/repo.git"),
            "https://user:***@example.test/repo.git"
        );
    }

    #[test]
    fn masks_a_header_style_api_key() {
        assert_eq!(
            redact_credential_shapes("X-Api-Key: abc123"),
            "X-Api-Key: ***"
        );
    }

    #[test]
    fn masks_a_bearer_token() {
        assert_eq!(
            redact_credential_shapes("Authorization: Bearer abc.def.ghi"),
            "Authorization: Bearer ***"
        );
    }

    #[test]
    fn masks_a_github_style_prefixed_token_regardless_of_key() {
        assert_eq!(
            redact_credential_shapes("found token ghp_abcdefghijklmnop in the log"),
            "found token *** in the log"
        );
    }

    #[test]
    fn masks_a_stripe_style_prefixed_secret_key() {
        assert_eq!(
            redact_credential_shapes("key=sk_live_abcdefghijklmnop"),
            "key=***"
        );
    }

    #[test]
    fn leaves_ordinary_text_untouched() {
        let text = "reading /home/mango/project/src/main.rs, 128 bytes";
        assert_eq!(redact_credential_shapes(text), text);
    }

    #[test]
    fn masking_is_case_insensitive_for_the_key_name() {
        assert_eq!(
            redact_credential_shapes("--PASSWORD=hunter2"),
            "--PASSWORD=***"
        );
    }
}
