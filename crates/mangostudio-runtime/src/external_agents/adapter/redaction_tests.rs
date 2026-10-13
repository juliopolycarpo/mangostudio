//! Vendor facts the runtime shows, compares or echoes back after the SDK has redacted its
//! messages and labels. SDK 0.7.0 redacts more shapes (bare tokens, deeply escaped JSON, long
//! numbers under a count name); these tests fail if it starts rewriting a value a real CLI sends
//! for one of those facts, which would break a comparison silently instead of loudly.
use mango_external_agents::normalize::TextLimit;
use mango_external_agents::redact;

/// What `map.rs` reads from the discovery the SDK already redacted: the version label the
/// descriptor shows, the account labels `account_label` compares (`amazon-bedrock`), the login
/// commands the sign-in remedy offers, and the ids a session and a turn are addressed by.
fn vendor_facts() -> Vec<(&'static str, &'static str, TextLimit)> {
    vec![
        (
            "Claude version banner",
            "2.1.296 (Claude Code)",
            TextLimit::AccountLabel,
        ),
        (
            "Codex version banner",
            "codex-cli 0.162.1",
            TextLimit::AccountLabel,
        ),
        (
            "Cursor version",
            "2026.09.10-fd3934a",
            TextLimit::AccountLabel,
        ),
        (
            "Codex Bedrock mode label",
            "amazon-bedrock",
            TextLimit::AccountLabel,
        ),
        (
            "Claude cloud-provider mode label",
            "cloud-provider",
            TextLimit::AccountLabel,
        ),
        (
            "Claude login command",
            "claude auth login",
            TextLimit::Detail,
        ),
        (
            "Codex login command",
            mango_agent_codex::harness::CODEX_LOGIN_HINT,
            TextLimit::Detail,
        ),
        (
            "Cursor login command",
            "cursor-agent login",
            TextLimit::Detail,
        ),
        (
            "ACP sign-in message",
            "authentication required; to sign in: cursor-agent login",
            TextLimit::ErrorMessage,
        ),
        (
            "ACP auth-required code",
            "acp-auth-required",
            TextLimit::VendorId,
        ),
        ("vendor error code", "-32000", TextLimit::VendorId),
        (
            "Codex thread id",
            "0199d2a8-7c3e-7b52-9d1f-4a6e8c0b2f13",
            TextLimit::VendorId,
        ),
        (
            "Claude session id",
            "6f1c0a52-3b7e-4d98-a1f4-2c9e5b7d8a60",
            TextLimit::VendorId,
        ),
        ("Codex plan label", "plus", TextLimit::AccountLabel),
    ]
}

#[test]
fn the_vendor_facts_the_runtime_compares_pass_the_sdks_redaction_unchanged() {
    for (what, text, limit) in vendor_facts() {
        let received = redact::bounded(text, limit).text;
        assert_eq!(
            received, text,
            "expected the {what} to pass the SDK's redaction unchanged | received {received:?}"
        );
    }
}
