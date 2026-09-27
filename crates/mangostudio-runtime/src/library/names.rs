//! Resource naming rules: which entry names a location matches, how a name
//! becomes a slug, and which slugs the library and each kind accept —
//! `keys.ts`, `kind-rules.ts`, and the naming helpers of
//! `instance-reader.ts`, ported rule for rule.

use crate::probing::locations::ResourceFormat;

/// `LIBRARY_RESOURCE_SLUG_MAX_LENGTH`.
const LIBRARY_RESOURCE_SLUG_MAX_LENGTH: usize = 128;
/// `SKILL_SLUG_MAX_LENGTH`.
const SKILL_SLUG_MAX_LENGTH: usize = 64;

/// `isValidResourceSlug`: `^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$`, at most
/// 128 characters — dot-separated groups, so no separator, `..`, or edge dot.
#[must_use]
pub(crate) fn is_valid_resource_slug(slug: &str) -> bool {
    slug.len() <= LIBRARY_RESOURCE_SLUG_MAX_LENGTH
        && slug.split('.').all(|group| {
            !group.is_empty()
                && group
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
}

/// `isValidKindSlug`: skills additionally need
/// `^[a-z0-9]+(?:-[a-z0-9]+)*$` and at most 64 characters; every other kind
/// takes the library pattern as is.
#[must_use]
pub(crate) fn is_valid_kind_slug(kind: &str, slug: &str) -> bool {
    if kind != "skill" {
        return true;
    }
    slug.len() <= SKILL_SLUG_MAX_LENGTH
        && slug.split('-').all(|group| {
            !group.is_empty()
                && group
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// `path.extname` of a bare entry name: from the last `.`, unless that dot
/// is the name's first character.
#[must_use]
pub(crate) fn extname(name: &str) -> &str {
    match name.rfind('.') {
        Some(index) if index > 0 => &name[index..],
        _ => "",
    }
}

/// `fileSlug`: `basename(name, extname(name))`. Used for every directory
/// layout, so a skill directory named `a.b` is slug `a` exactly as the
/// TypeScript scan names it.
#[must_use]
pub(crate) fn file_slug(name: &str) -> &str {
    let extension = extname(name);
    &name[..name.len() - extension.len()]
}

/// `matchesFormat`: the lowercased extension a `directory-of-files` location
/// scans for.
#[must_use]
pub(crate) fn matches_format(name: &str, format: ResourceFormat) -> bool {
    let extension = extname(name).to_ascii_lowercase();
    match format {
        ResourceFormat::MarkdownFrontmatter => extension == ".md",
        ResourceFormat::Mdc => extension == ".mdc",
        ResourceFormat::TomlAgent | ResourceFormat::TomlSettings => extension == ".toml",
        ResourceFormat::JsonSettings => extension == ".json",
        ResourceFormat::RulesDsl => extension == ".rules",
        ResourceFormat::MarkdownPlain => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_slugs_are_dot_separated_groups() {
        for valid in ["a", "My_Skill", "a.b", "0-9"] {
            assert!(is_valid_resource_slug(valid), "expected {valid:?} valid");
        }
        for invalid in ["", ".a", "a.", "a..b", "a b", "a/b", &"x".repeat(129)] {
            assert!(
                !is_valid_resource_slug(invalid),
                "expected {invalid:?} invalid"
            );
        }
    }

    #[test]
    fn skill_slugs_are_lowercase_hyphen_groups() {
        assert!(is_valid_kind_slug("skill", "my-skill-2"));
        assert!(!is_valid_kind_slug("skill", "My_Skill"));
        assert!(!is_valid_kind_slug("skill", "a--b"));
        assert!(!is_valid_kind_slug("skill", &"a".repeat(65)));
        assert!(is_valid_kind_slug("subagent", "My_Skill"));
    }

    #[test]
    fn names_split_like_node_extname() {
        assert_eq!(file_slug("UPPER.MD"), "UPPER");
        assert_eq!(file_slug("a.b.md"), "a.b");
        assert_eq!(file_slug("noext"), "noext");
        assert_eq!(extname(".hidden"), "");
        assert!(matches_format("x.MD", ResourceFormat::MarkdownFrontmatter));
        assert!(!matches_format(
            "x.txt",
            ResourceFormat::MarkdownFrontmatter
        ));
    }
}
