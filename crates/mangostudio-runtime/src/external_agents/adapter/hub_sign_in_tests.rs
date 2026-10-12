//! The hub presents a turn the agent refused for authentication as a sign-in prompt, keyed on the
//! SDK's error code and offering the command the hub keeps per target. Both literals live in
//! TypeScript, so these tests tie them to what the SDK sends.
use mango_agent_acp::error::AUTH_REQUIRED_CODE;

const HUB_REMEDIES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../apps/shared/src/external-agents/remedies.ts"
);
const HUB_ADAPTER_DESCRIPTORS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../apps/api/src/modules/external-agents/domain/adapter-descriptors.ts"
);

fn read(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|error| {
        panic!("expected a readable hub source at {path} | received {error}")
    })
}

/// The quoted literal right after `marker` in `source`.
fn literal_after<'a>(source: &'a str, marker: &str) -> Result<&'a str, String> {
    let start = source
        .find(marker)
        .ok_or_else(|| format!("expected the source to contain `{marker}`"))?
        + marker.len();
    let rest = &source[start..];
    let rest = rest.strip_prefix('\'').ok_or_else(|| {
        format!(
            "expected a single-quoted literal after `{marker}` | received {:?}",
            rest.chars().take(24).collect::<String>()
        )
    })?;
    let end = rest
        .find('\'')
        .ok_or_else(|| format!("expected a closing quote after `{marker}`"))?;
    Ok(&rest[..end])
}

#[test]
fn the_literal_after_a_marker_is_read_and_a_missing_marker_is_named() {
    let source = "const CODE = 'a-b'; other: 'c'";
    assert_eq!(literal_after(source, "const CODE = "), Ok("a-b"));
    let missing = literal_after(source, "const NOPE = ");
    assert!(
        matches!(&missing, Err(message) if message.contains("const NOPE = ")),
        "expected a failure naming the missing marker | received {missing:?}"
    );
    let unquoted = literal_after("const CODE = 12;", "const CODE = ");
    assert!(
        matches!(&unquoted, Err(message) if message.contains("single-quoted")),
        "expected a failure about the missing quote | received {unquoted:?}"
    );
}

#[test]
fn the_hubs_signed_out_code_is_the_one_the_sdk_ends_a_refused_prompt_with() {
    let source = read(HUB_REMEDIES);
    let received = literal_after(&source, "export const EXTERNAL_AUTH_REQUIRED_ERROR_CODE = ")
        .unwrap_or_else(|message| panic!("{message} | in {HUB_REMEDIES}"));
    assert_eq!(
        received, AUTH_REQUIRED_CODE,
        "expected EXTERNAL_AUTH_REQUIRED_ERROR_CODE to equal the SDK's AUTH_REQUIRED_CODE | received {received:?}"
    );
}

#[test]
fn the_hubs_cursor_sign_in_command_is_the_one_the_sdk_profile_tells_a_person_to_run() {
    let profile =
        mango_agent_acp::builtin_profile("cursor").expect("the SDK ships the cursor profile");
    let source = read(HUB_ADAPTER_DESCRIPTORS);
    let cursor = source
        .find("targetId: 'cursor',")
        .map(|start| &source[start..])
        .unwrap_or_else(|| panic!("expected a cursor entry in {HUB_ADAPTER_DESCRIPTORS}"));
    let received = literal_after(cursor, "loginCommand: ")
        .unwrap_or_else(|message| panic!("{message} | in {HUB_ADAPTER_DESCRIPTORS}"));
    assert_eq!(
        received,
        profile.login_text(),
        "expected the hub's cursor loginCommand to equal the SDK profile's login text | received {received:?}"
    );
}
