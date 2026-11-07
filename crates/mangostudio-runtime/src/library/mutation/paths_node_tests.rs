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

#[test]
fn posix_parent_steps_follow_symlinks_in_input_and_target_text() {
    let existing = ["/safe", "/outside", "/outside/child"];
    let links = HashMap::from([
        ("/safe/redirect", "/outside/child"),
        ("/safe/relative", "redirect/../entry"),
        ("/safe/absolute", "/safe/redirect/../entry"),
    ]);
    for input in [
        "/safe/redirect/../entry",
        "/safe/relative",
        "/safe/absolute",
    ] {
        assert_eq!(
            resolve_like_node("linux", input, &probe(&existing, &links)).as_deref(),
            Some("/outside/entry"),
            "expected the parent of the symlink target while resolving {input:?}"
        );
    }
    for input in [
        "/safe/missing/../redirect/../entry",
        "/safe/missing/child/../entry",
        "/safe/missing/..",
    ] {
        assert_eq!(
            resolve_like_node("linux", input, &probe(&existing, &links)),
            None,
            "expected parent traversal after a missing component to be refused for {input:?}"
        );
    }
}

#[test]
fn win32_preserves_lexical_parent_steps_and_unc_spelling() {
    let existing = [r"\\Host\Share\RUNNER~1"];
    let links = HashMap::from([(r"\\Host\Share\RUNNER~1\redirect", r"D:\other\child")]);
    assert_eq!(
        resolve_like_node(
            "win32",
            r"//Host/Share/RUNNER~1/redirect/../entry",
            &probe(&existing, &links),
        )
        .as_deref(),
        Some(r"\\Host\Share\RUNNER~1\entry")
    );
}

#[cfg(unix)]
#[test]
fn a_real_relative_link_target_uses_the_redirects_physical_parent() {
    use std::os::unix::fs::symlink;

    let scratch = crate::test_support::scratch_dir("library-ordered-symlink");
    let safe = scratch.join("safe");
    let outside = scratch.join("outside");
    std::fs::create_dir_all(&safe).unwrap();
    std::fs::create_dir_all(outside.join("child")).unwrap();
    std::fs::write(outside.join("existing"), "physical resource").unwrap();
    std::fs::write(safe.join("existing"), "lexical resource").unwrap();
    symlink(outside.join("child"), safe.join("redirect")).unwrap();
    symlink("redirect/../existing", safe.join("entry")).unwrap();
    symlink("redirect/../missing", safe.join("dangling")).unwrap();

    let entry = safe.join("entry");
    let physical = std::fs::canonicalize(&entry).unwrap();
    assert_eq!(
        std::fs::read_to_string(&entry).unwrap(),
        "physical resource"
    );
    assert_eq!(
        resolve_through_existing_ancestor(&path_string(&entry)),
        Some(path_string(&physical))
    );
    assert_eq!(
        resolve_through_existing_ancestor(&path_string(&safe.join("dangling"))),
        Some(path_string(&physical.with_file_name("missing")))
    );
    let through_file = safe.join("existing").join("..").join("entry");
    assert_eq!(
        std::fs::metadata(&through_file).unwrap_err().kind(),
        std::io::ErrorKind::NotADirectory
    );
    assert_eq!(
        resolve_through_existing_ancestor(&path_string(&through_file)),
        None,
        "parent traversal cannot pass through a file"
    );
}

#[cfg(unix)]
#[test]
fn a_library_write_cannot_cancel_a_missing_posix_parent() {
    use crate::library::mutation::disk::write_library_file_atomic;
    use std::os::unix::fs::symlink;

    let scratch = crate::test_support::scratch_dir("library-write-missing-parent");
    let safe = scratch.join("safe");
    let outside = scratch.join("outside");
    std::fs::create_dir_all(&safe).unwrap();
    std::fs::create_dir_all(outside.join("nested")).unwrap();
    let sentinel = outside.join("secret.txt");
    std::fs::write(&sentinel, "outside sentinel").unwrap();
    symlink(outside.join("nested"), safe.join("deep")).unwrap();
    let target = "missing/../deep/../secret.txt";
    let entry = safe.join("entry");
    symlink(target, &entry).unwrap();

    for path in [
        safe.join(target),
        entry,
        safe.join("missing/child/../created"),
    ] {
        assert_eq!(
            std::fs::metadata(&path).unwrap_err().kind(),
            std::io::ErrorKind::NotFound
        );
        let write = write_library_file_atomic(&path_string(&path), b"replacement");
        assert_eq!(
            std::fs::read_to_string(&sentinel).unwrap(),
            "outside sentinel",
            "write through {path:?} changed the outside file: {write:?}"
        );
        assert_eq!(
            write.unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        assert!(!safe.join("missing").exists());
    }
    let ordinary = safe.join("missing/child/created");
    write_library_file_atomic(&path_string(&ordinary), b"ordinary write").unwrap();
    assert_eq!(std::fs::read(&ordinary).unwrap(), b"ordinary write");
}
