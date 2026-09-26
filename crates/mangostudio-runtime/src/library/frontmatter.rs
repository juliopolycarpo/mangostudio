//! A port of `apps/shared/src/markdown/frontmatter.ts`'s
//! `parseMarkdownFrontmatter`, limited to the frontmatter half (the body is
//! never read by a scan).
//!
//! The parser is a deliberately tiny YAML subset — scalars, inline arrays,
//! block arrays — and its quirks are part of the wire: a scalar that
//! `Number()` accepts becomes a number, so `name: 1e3` titles a resource
//! `1000`. Every rule below mirrors a line of the TypeScript original.

use std::collections::HashMap;

use super::js::{js_finite_number, js_number_to_string, js_trim};

const FRONTMATTER_BOUNDARY: &str = "---";
const ARRAY_ITEM_PREFIX: &str = "- ";

/// One frontmatter value, as `MarkdownFrontmatterValue` types it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum FrontmatterValue {
    /// A scalar that was neither a boolean nor a finite number.
    Text(String),
    /// A scalar `Number()` accepted as finite.
    Number(f64),
    /// `true` or `false`, exactly.
    Bool(bool),
    /// An inline `[a, b]` or block `- item` array.
    Array(Vec<String>),
}

impl FrontmatterValue {
    /// `scalarString` in `instance-reader.ts`: strings pass through, numbers
    /// and booleans print as `String(value)` would, arrays have no scalar.
    #[must_use]
    pub(crate) fn scalar_string(&self) -> Option<String> {
        match self {
            Self::Text(text) => Some(text.clone()),
            Self::Number(value) => Some(js_number_to_string(*value)),
            Self::Bool(value) => Some(value.to_string()),
            Self::Array(_) => None,
        }
    }
}

/// The frontmatter of `markdown`, keyed by name; empty when the document has
/// no complete `---` block.
///
/// # Example
///
/// ```ignore
/// let frontmatter = parse_frontmatter("---\nname: 1e3\n---\nbody");
/// assert_eq!(frontmatter["name"].scalar_string().as_deref(), Some("1000"));
/// ```
#[must_use]
pub(crate) fn parse_frontmatter(markdown: &str) -> HashMap<String, FrontmatterValue> {
    let normalized = markdown.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    if lines.first().map(|line| js_trim(line)) != Some(FRONTMATTER_BOUNDARY) {
        return HashMap::new();
    }
    let Some(closing) = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, line)| js_trim(line) == FRONTMATTER_BOUNDARY)
        .map(|(index, _)| index)
    else {
        return HashMap::new();
    };
    parse_lines(&lines[1..closing])
}

fn parse_lines(lines: &[&str]) -> HashMap<String, FrontmatterValue> {
    let mut frontmatter = HashMap::new();
    let mut array_key: Option<String> = None;
    for line in lines {
        let trimmed = js_trim(line);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(key) = array_key.as_ref()
            && let Some(item) = trimmed.strip_prefix(ARRAY_ITEM_PREFIX)
        {
            let mut items = match frontmatter.remove(key) {
                Some(FrontmatterValue::Array(items)) => items,
                _ => Vec::new(),
            };
            items.push(unquote(js_trim(item)).to_string());
            frontmatter.insert(key.clone(), FrontmatterValue::Array(items));
            continue;
        }
        array_key = None;
        let Some(separator) = trimmed.find(':') else {
            continue;
        };
        let key = js_trim(&trimmed[..separator]);
        let raw = js_trim(&trimmed[separator + 1..]);
        if key.is_empty() {
            continue;
        }
        if raw.is_empty() {
            frontmatter.insert(key.to_string(), FrontmatterValue::Array(Vec::new()));
            array_key = Some(key.to_string());
            continue;
        }
        frontmatter.insert(key.to_string(), parse_scalar(raw));
    }
    frontmatter
}

fn parse_scalar(raw: &str) -> FrontmatterValue {
    if raw.len() >= 2 && raw.starts_with('[') && raw.ends_with(']') {
        let items = raw[1..raw.len() - 1]
            .split(',')
            .map(|item| unquote(js_trim(item)).to_string())
            .filter(|item| !item.is_empty())
            .collect();
        return FrontmatterValue::Array(items);
    }
    match raw {
        "true" => return FrontmatterValue::Bool(true),
        "false" => return FrontmatterValue::Bool(false),
        _ => {}
    }
    if let Some(value) = js_finite_number(raw) {
        return FrontmatterValue::Number(value);
    }
    FrontmatterValue::Text(unquote(raw).to_string())
}

/// `unquote`: strips one matching pair of `"` or `'`. A lone quote character
/// both starts and ends with itself, and `slice(1, -1)` makes it empty.
fn unquote(value: &str) -> &str {
    let quoted = (value.starts_with('"') && value.ends_with('"'))
        || (value.starts_with('\'') && value.ends_with('\''));
    if !quoted {
        return value;
    }
    if value.len() < 2 {
        return "";
    }
    &value[1..value.len() - 1]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lone_quote_unquotes_to_empty_like_slice() {
        assert_eq!(unquote("\""), "");
        assert_eq!(unquote("'a'"), "a");
        assert_eq!(unquote("\"a'"), "\"a'");
    }

    #[test]
    fn block_arrays_attach_to_the_key_that_opened_them() {
        let parsed = parse_frontmatter("---\ntools:\n  - read\n  - \"write\"\nname: x\n---\n");
        assert_eq!(
            parsed.get("tools"),
            Some(&FrontmatterValue::Array(vec![
                "read".into(),
                "write".into()
            ]))
        );
        assert_eq!(
            parsed.get("name"),
            Some(&FrontmatterValue::Text("x".into()))
        );
    }

    #[test]
    fn an_unterminated_block_is_no_frontmatter() {
        assert!(parse_frontmatter("---\nname: x\n").is_empty());
        assert!(parse_frontmatter("name: x\n---\n").is_empty());
    }
}
