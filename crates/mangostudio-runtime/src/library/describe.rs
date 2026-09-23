//! `describeInstance` from `instance-reader.ts`: the title, description and
//! metadata validity a scan derives from an instance's entrypoint text.
//!
//! Known parser gaps, recorded rather than hidden: JSON validity uses
//! `serde_json` (depth-limited at 128 and strict about unpaired `\uD800`
//! escapes, both of which `JSON.parse` accepts), and TOML validity uses the
//! `toml` crate (TOML 1.1) where the TypeScript host uses `smol-toml`. A
//! document that only one parser accepts reports `invalid-metadata` on one
//! host and valid on the other; nothing in the corpus does.

use super::cache::Display;
use super::frontmatter::parse_frontmatter;
use super::js::js_trim;
use super::types::InvalidReason;
use crate::probing::locations::{LocationDefinition, ResourceFormat};

/// Display metadata for one instance. `text` is `None` only for a directory
/// instance with no entrypoint at all.
///
/// # Example
///
/// ```ignore
/// let display = describe_instance(location, "alpha", Some("---\nname: alpha\n---\n"));
/// assert_eq!(display.title.as_deref(), Some("alpha"));
/// ```
#[must_use]
pub(crate) fn describe_instance(
    location: &LocationDefinition,
    slug: &str,
    text: Option<&str>,
) -> Display {
    let Some(text) = text else {
        return Display {
            title: Some(slug.to_string()),
            description: None,
            invalid_reason: Some(InvalidReason::MissingEntrypoint),
        };
    };
    match location.format {
        ResourceFormat::MarkdownFrontmatter | ResourceFormat::Mdc => {
            describe_markdown(location.kind, slug, text)
        }
        ResourceFormat::JsonSettings => {
            let object = matches!(
                serde_json::from_str::<serde_json::Value>(text),
                Ok(serde_json::Value::Object(_))
            );
            titled(
                slug,
                None,
                (!object).then_some(InvalidReason::InvalidMetadata),
            )
        }
        ResourceFormat::TomlAgent | ResourceFormat::TomlSettings => {
            describe_toml(location.format, slug, text)
        }
        ResourceFormat::MarkdownPlain | ResourceFormat::RulesDsl => titled(slug, None, None),
    }
}

fn titled(title: &str, description: Option<String>, invalid: Option<InvalidReason>) -> Display {
    Display {
        title: Some(title.to_string()),
        description,
        invalid_reason: invalid,
    }
}

fn describe_markdown(kind: &str, slug: &str, text: &str) -> Display {
    let frontmatter = parse_frontmatter(text);
    let scalar = |key: &str| {
        frontmatter
            .get(key)
            .and_then(super::frontmatter::FrontmatterValue::scalar_string)
            .map(|value| js_trim(&value).to_string())
    };
    let title = scalar("name")
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| slug.to_string());
    let description = scalar("description");
    let described = description
        .as_deref()
        .is_some_and(|value| !value.is_empty());
    let invalid = (kind == "skill" && (title != slug || !described))
        .then_some(InvalidReason::InvalidMetadata);
    Display {
        title: Some(title),
        description,
        invalid_reason: invalid,
    }
}

fn describe_toml(format: ResourceFormat, slug: &str, text: &str) -> Display {
    let Ok(table) = text.parse::<toml::Table>() else {
        return titled(slug, None, Some(InvalidReason::InvalidMetadata));
    };
    if format != ResourceFormat::TomlAgent {
        return titled(slug, None, None);
    }
    let string = |key: &str| {
        table
            .get(key)
            .and_then(toml::Value::as_str)
            .map(|value| js_trim(value).to_string())
    };
    let title = string("name")
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| slug.to_string());
    titled(&title, string("description"), None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probing::locations::location_by_id;

    #[test]
    fn a_skill_whose_name_is_not_its_slug_is_invalid_metadata() {
        let skills = location_by_id("mango-skills").unwrap();
        let display = describe_instance(
            skills,
            "beta",
            Some("---\nname: other\ndescription: d\n---\n"),
        );
        assert_eq!(display.invalid_reason, Some(InvalidReason::InvalidMetadata));
        assert_eq!(display.title.as_deref(), Some("other"));
    }

    #[test]
    fn a_skill_without_description_is_invalid_but_a_subagent_is_not() {
        let text = Some("---\nname: alpha\n---\n");
        let skill = describe_instance(location_by_id("mango-skills").unwrap(), "alpha", text);
        assert_eq!(skill.invalid_reason, Some(InvalidReason::InvalidMetadata));
        let agent = describe_instance(location_by_id("claude-agents").unwrap(), "alpha", text);
        assert_eq!(agent.invalid_reason, None);
    }

    #[test]
    fn json_settings_must_be_an_object() {
        let settings = location_by_id("claude-settings").unwrap();
        assert_eq!(
            describe_instance(settings, "settings", Some("[1]")).invalid_reason,
            Some(InvalidReason::InvalidMetadata)
        );
        assert_eq!(
            describe_instance(settings, "settings", Some("{\"a\":1}")).invalid_reason,
            None
        );
        assert_eq!(
            describe_instance(settings, "settings", Some("{,}")).invalid_reason,
            Some(InvalidReason::InvalidMetadata)
        );
    }

    #[test]
    fn toml_agents_title_from_a_string_name_only() {
        let agents = location_by_id("codex-agents").unwrap();
        let named = describe_instance(agents, "a", Some("name = \" Agent \"\ndescription = \"d\""));
        assert_eq!(named.title.as_deref(), Some("Agent"));
        assert_eq!(named.description.as_deref(), Some("d"));
        let typed = describe_instance(agents, "a", Some("name = 5"));
        assert_eq!(typed.title.as_deref(), Some("a"));
        let broken = describe_instance(agents, "a", Some("name = \"open"));
        assert_eq!(broken.invalid_reason, Some(InvalidReason::InvalidMetadata));
    }
}
