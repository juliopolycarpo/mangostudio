//! The path-form rule every manifest path follows, with an injected probe so
//! it runs identically on every OS: symlinks are followed, 8.3 short names
//! and other spellings are kept exactly as TypeScript's `realpathSync`
//! keeps them.

use std::collections::HashMap;

use super::*;

/// A fake disk: `links` maps a path to its link target; every path under
/// `existing` is a plain entry; anything else is missing.
fn probe<'a>(
    existing: &'a [&'a str],
    links: &'a HashMap<&'a str, &'a str>,
) -> impl Fn(&str) -> std::io::Result<SegmentEntry> + 'a {
    move |candidate| {
        if let Some(target) = links.get(candidate) {
            return Ok(SegmentEntry::Link((*target).to_string()));
        }
        if existing.contains(&candidate) {
            return Ok(SegmentEntry::Plain);
        }
        Ok(SegmentEntry::Missing)
    }
}

/// The CI failure: the runner's `TEMP` is `C:\Users\RUNNER~1\…`. TypeScript
/// keeps that spelling; canonicalizing to `runneradmin` broke containment.
#[test]
fn an_8_3_short_name_keeps_its_spelling() {
    let existing = [
        r"C:\Users",
        r"C:\Users\RUNNER~1",
        r"C:\Users\RUNNER~1\Temp",
        r"C:\Users\RUNNER~1\Temp\home",
        r"C:\Users\RUNNER~1\Temp\home\.cursor",
        r"C:\Users\RUNNER~1\Temp\home\.cursor\skills",
    ];
    let links = HashMap::new();
    let resolved = resolve_like_node(
        "win32",
        r"C:\Users\RUNNER~1\Temp\home\.cursor\skills\gh",
        &probe(&existing, &links),
    );
    assert_eq!(
        resolved.as_deref(),
        Some(r"C:\Users\RUNNER~1\Temp\home\.cursor\skills\gh"),
        "expected the short-name spelling TypeScript records | received the long form"
    );
}

#[test]
fn symlinks_are_followed_and_missing_tails_are_kept() {
    let existing = ["/private", "/private/tmp", "/private/tmp/home"];
    let links = HashMap::from([("/tmp", "private/tmp")]);
    assert_eq!(
        resolve_like_node(
            "darwin",
            "/tmp/home/.claude/CLAUDE.md",
            &probe(&existing, &links)
        )
        .as_deref(),
        Some("/private/tmp/home/.claude/CLAUDE.md"),
        "a relative link target resolves against the link's directory"
    );
    let links = HashMap::from([(r"D:\home\skills", r"E:\dotfiles\skills")]);
    let existing = [r"D:\home", r"E:\dotfiles", r"E:\dotfiles\skills"];
    assert_eq!(
        resolve_like_node("win32", r"D:\home\skills\gh", &probe(&existing, &links)).as_deref(),
        Some(r"E:\dotfiles\skills\gh")
    );
}

#[test]
fn a_symlink_loop_cannot_be_verified() {
    let links = HashMap::from([("/a", "/b"), ("/b", "/a")]);
    assert_eq!(
        resolve_like_node("linux", "/a/x", &probe(&[], &links)),
        None
    );
}

#[test]
fn an_uninspectable_segment_cannot_be_verified() {
    let denied = |_: &str| Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
    assert_eq!(resolve_like_node("linux", "/locked/x", &denied), None);
}
