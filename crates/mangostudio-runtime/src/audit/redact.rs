//! Masking secret-shaped text, wherever it might otherwise reach a log.
//!
//! Mirrors `apps/runtime/src/audit-log.ts`'s `redactCredentialShapes`
//! (the same seven patterns, applied in the same order, each working on the
//! previous one's output), `truncate` (redact, then ellipsis-truncate to a
//! bounded length), and `summarizeArgv` (a bounded argv-style list, with a
//! credential-named flag masking the value that follows it). All three are
//! params-shape-agnostic — they work on a string or a list of strings, never
//! on a specific method's params object — which is exactly why they are
//! ported here even though nothing calls them yet.
//!
//! What is *not* ported is `summarizeAuditArgs`'s fixed whitelist of
//! known-safe parameter keys (`path`, `command`, `cols`, …): that part is
//! genuinely params-shape-aware, and this crate has no params shapes to
//! whitelist against yet (see [`crate::ports::audit`]'s module docs for why
//! `AuditEntry` carries no `params` at all: this build implements no
//! methods). Whichever later change implements the first method archetype
//! is what should design that whitelist and call these functions from it.

use std::sync::OnceLock;

use regex::Regex;

/// The most argv-style entries a summarised list keeps. Mirrors
/// `ARGV_SUMMARY_LIMIT`.
pub const ARGV_SUMMARY_LIMIT: usize = 8;

/// The default length a summarised string is truncated to. Mirrors
/// `STRING_SUMMARY_LIMIT`.
pub const STRING_SUMMARY_LIMIT: usize = 256;

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
    /// An argv entry that is *only* a credential-flag name (`--token`,
    /// `--password`, …) — matched wholesale, not for what it contains, so
    /// [`summarize_argv`] can mask the entry that follows it.
    secret_argv_flag: Regex,
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
        secret_argv_flag: Regex::new(
            r"(?i)^--?(?:password|passwd|pwd|token|secret|api-?key|access-?token|auth-?token|authorization|credentials?)$",
        )
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

/// Redacts `value`, then truncates it to `limit` characters if it is still
/// longer, replacing the final character with `…` so the result is never
/// longer than `limit` itself. Mirrors `truncate`.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::audit::redact::truncate;
///
/// assert_eq!(truncate("short", 256), "short");
/// assert_eq!(truncate(&"a".repeat(10), 5), "aaaa…");
/// ```
#[must_use]
pub fn truncate(value: &str, limit: usize) -> String {
    let scrubbed = redact_credential_shapes(value);
    let length = scrubbed.chars().count();
    if length <= limit {
        return scrubbed;
    }
    let kept = limit.saturating_sub(1);
    let mut result: String = scrubbed.chars().take(kept).collect();
    result.push('…');
    result
}

/// Summarises an argv-style list of strings for a log line: at most
/// [`ARGV_SUMMARY_LIMIT`] entries, each passed through [`truncate`], with
/// the value immediately following a credential-named flag (`--token`,
/// `--password`, …) replaced wholesale by `***` rather than merely
/// truncated — a flag's value might not contain a recognisable secret
/// *shape* at all (a token that is just a short opaque string), so masking
/// by position, not by pattern, is what actually keeps it off the wire.
/// Mirrors `summarizeArgv`.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::audit::redact::summarize_argv;
///
/// let argv = vec!["push".to_string(), "--token".to_string(), "x".to_string()];
/// assert_eq!(summarize_argv(&argv), vec!["push", "--token", "***"]);
/// ```
#[must_use]
pub fn summarize_argv(argv: &[String]) -> Vec<String> {
    let patterns = patterns();
    let mut result = Vec::new();
    let mut mask_next = false;
    for entry in argv.iter().take(ARGV_SUMMARY_LIMIT) {
        if mask_next {
            result.push("***".to_string());
            mask_next = false;
            continue;
        }
        if patterns.secret_argv_flag.is_match(entry) {
            mask_next = true;
        }
        result.push(truncate(entry, STRING_SUMMARY_LIMIT));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{ARGV_SUMMARY_LIMIT, STRING_SUMMARY_LIMIT, redact_credential_shapes};

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

    #[test]
    fn truncate_leaves_a_short_string_untouched() {
        assert_eq!(super::truncate("short", STRING_SUMMARY_LIMIT), "short");
    }

    #[test]
    fn truncate_ends_a_long_string_in_an_ellipsis_at_exactly_the_limit() {
        let long = "a".repeat(300);
        let truncated = super::truncate(&long, STRING_SUMMARY_LIMIT);
        assert_eq!(truncated.chars().count(), STRING_SUMMARY_LIMIT);
        assert!(truncated.ends_with('…'));
    }

    #[test]
    fn truncate_redacts_before_measuring_length() {
        // A flag-style secret, once redacted to `***`, is short enough that
        // it must never be truncated a second time on top of that.
        assert_eq!(
            super::truncate("--token=hunter2", STRING_SUMMARY_LIMIT),
            "--token=***"
        );
    }

    #[test]
    fn summarize_argv_masks_the_value_following_a_secret_flag() {
        let argv = vec!["push".to_string(), "--token".to_string(), "x".to_string()];
        assert_eq!(super::summarize_argv(&argv), vec!["push", "--token", "***"]);
    }

    #[test]
    fn summarize_argv_caps_at_the_documented_limit() {
        let argv: Vec<String> = (0..(ARGV_SUMMARY_LIMIT + 1))
            .map(|index| format!("arg{index}"))
            .collect();
        assert_eq!(super::summarize_argv(&argv).len(), ARGV_SUMMARY_LIMIT);
    }

    #[test]
    fn summarize_argv_leaves_ordinary_entries_untouched() {
        let argv = vec!["clone".to_string(), "--depth=1".to_string()];
        assert_eq!(super::summarize_argv(&argv), vec!["clone", "--depth=1"]);
    }
}
