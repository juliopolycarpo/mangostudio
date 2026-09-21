//! Context-anchored application of structured V4A hunks.
//!
//! This module has no filesystem access. Callers resolve and authorize paths,
//! read UTF-8 source text, then use [`apply_update_hunks`] to prepare a mutation
//! before writing it. The Hub parses raw V4A text before calling this host.

use std::fmt;

use serde::Deserialize;

/// A context-anchored update hunk.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(super) struct V4aUpdateHunk {
    #[serde(default)]
    pub marker: Option<String>,
    pub lines: Vec<V4aHunkLine>,
}

/// A line in an update hunk, retaining the payload line ending supplied by the patch.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(super) struct V4aHunkLine {
    #[serde(rename = "type")]
    pub kind: V4aHunkLineKind,
    pub content: String,
    pub ending: LineEnding,
}

/// The role a hunk line plays when matching and applying a patch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum V4aHunkLineKind {
    Context,
    Add,
    Delete,
}

/// A supported source or patch line ending.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub(super) enum LineEnding {
    #[serde(rename = "")]
    None,
    #[serde(rename = "\n")]
    Lf,
    #[serde(rename = "\r\n")]
    Crlf,
}

impl LineEnding {
    fn as_str(self) -> &'static str {
        match self {
            Self::None => "",
            Self::Lf => "\n",
            Self::Crlf => "\r\n",
        }
    }
}

/// Why an update hunk cannot be applied to its source text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct V4aHunkApplyError(String);

impl fmt::Display for V4aHunkApplyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for V4aHunkApplyError {}

/// The text prepared by [`apply_update_hunks`], plus the still-valid source-line prefix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct AppliedUpdate {
    pub content: String,
    pub line_numbers_valid_through_line: usize,
}

/// Applies ordered hunks to UTF-8 `source` using exact, then trailing-whitespace-tolerant matching.
pub(super) fn apply_update_hunks(
    source: &str,
    hunks: &[V4aUpdateHunk],
    input_path: &str,
) -> Result<AppliedUpdate, V4aHunkApplyError> {
    let original = split_text_lines(source);
    let mut lines = original.clone();
    for (index, hunk) in hunks.iter().enumerate() {
        let location = locate_hunk(&lines, hunk, input_path, index + 1)?;
        lines = apply_hunk_at(&lines, hunk, location);
    }
    let content = lines
        .iter()
        .map(|line| format!("{}{}", line.content, line.ending.as_str()))
        .collect();
    Ok(AppliedUpdate {
        content,
        line_numbers_valid_through_line: unchanged_prefix_length(&original, &lines),
    })
}

/// Refuses patch results that would turn a text mutation into a binary file.
pub(super) fn assert_text_content(
    content: &str,
    input_path: &str,
) -> Result<(), V4aHunkApplyError> {
    if !content.contains('\0') {
        return Ok(());
    }
    Err(V4aHunkApplyError(format!(
        "Refusing to patch \"{input_path}\": the result contains a NUL byte and would not be a text file."
    )))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TextLine {
    content: String,
    ending: LineEnding,
}

fn split_text_lines(input: &str) -> Vec<TextLine> {
    split_lines(input)
}

fn split_lines(input: &str) -> Vec<TextLine> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (index, byte) in input.bytes().enumerate() {
        if byte != b'\n' {
            continue;
        }
        let is_crlf = index > start && input.as_bytes()[index - 1] == b'\r';
        let content_end = if is_crlf { index - 1 } else { index };
        lines.push(TextLine {
            content: input[start..content_end].to_owned(),
            ending: if is_crlf {
                LineEnding::Crlf
            } else {
                LineEnding::Lf
            },
        });
        start = index + 1;
    }
    if start < input.len() {
        lines.push(TextLine {
            content: input[start..].to_owned(),
            ending: LineEnding::None,
        });
    }
    lines
}

fn unchanged_prefix_length(before: &[TextLine], after: &[TextLine]) -> usize {
    before
        .iter()
        .zip(after)
        .take_while(|(left, right)| left == right)
        .count()
}

fn locate_hunk(
    source: &[TextLine],
    hunk: &V4aUpdateHunk,
    input_path: &str,
    hunk_number: usize,
) -> Result<usize, V4aHunkApplyError> {
    let exact = find_hunk_candidates(source, hunk, false);
    if exact.len() == 1 {
        return Ok(exact[0]);
    }
    if exact.len() > 1 {
        return Err(ambiguous_hunk_error(input_path, hunk_number));
    }

    let lenient = find_hunk_candidates(source, hunk, true);
    if lenient.len() == 1 {
        return Ok(lenient[0]);
    }
    if lenient.len() > 1 {
        return Err(ambiguous_hunk_error(input_path, hunk_number));
    }
    Err(V4aHunkApplyError(format!(
        "Hunk {hunk_number} for \"{input_path}\": context not found. Re-read the file and regenerate the patch."
    )))
}

fn find_hunk_candidates(
    source: &[TextLine],
    hunk: &V4aUpdateHunk,
    ignore_trailing_whitespace: bool,
) -> Vec<usize> {
    let old_lines: Vec<&str> = hunk
        .lines
        .iter()
        .filter(|line| line.kind != V4aHunkLineKind::Add)
        .map(|line| line.content.as_str())
        .collect();
    let windows = find_marker_windows(source, hunk.marker.as_deref(), ignore_trailing_whitespace);
    if old_lines.is_empty() {
        return windows.into_iter().map(|window| window.start).collect();
    }

    let mut candidates = Vec::new();
    for window in windows {
        for start in window.start..=window.end.saturating_sub(old_lines.len()) {
            if start + old_lines.len() > window.end {
                continue;
            }
            if old_lines.iter().enumerate().all(|(index, line)| {
                lines_equal(
                    &source[start + index].content,
                    line,
                    ignore_trailing_whitespace,
                )
            }) && !candidates.contains(&start)
            {
                candidates.push(start);
            }
        }
    }
    candidates
}

#[derive(Debug, Clone, Copy)]
struct MarkerWindow {
    start: usize,
    end: usize,
}

fn find_marker_windows(
    source: &[TextLine],
    marker: Option<&str>,
    ignore_trailing_whitespace: bool,
) -> Vec<MarkerWindow> {
    let Some(marker) = marker else {
        return vec![MarkerWindow {
            start: 0,
            end: source.len(),
        }];
    };
    let indexes: Vec<_> = source
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            lines_equal(&line.content, marker, ignore_trailing_whitespace).then_some(index)
        })
        .collect();
    indexes
        .iter()
        .enumerate()
        .map(|(index, marker_index)| MarkerWindow {
            start: marker_index + 1,
            end: indexes.get(index + 1).copied().unwrap_or(source.len()),
        })
        .collect()
}

fn lines_equal(left: &str, right: &str, ignore_trailing_whitespace: bool) -> bool {
    if ignore_trailing_whitespace {
        left.trim_end() == right.trim_end()
    } else {
        left == right
    }
}

fn apply_hunk_at(source: &[TextLine], hunk: &V4aUpdateHunk, location: usize) -> Vec<TextLine> {
    let mut replacement = Vec::new();
    let mut cursor = location;
    for line in &hunk.lines {
        match line.kind {
            V4aHunkLineKind::Add => replacement.push(TextLine {
                content: line.content.clone(),
                ending: line.ending,
            }),
            V4aHunkLineKind::Context => {
                replacement.push(source[cursor].clone());
                cursor += 1;
            }
            V4aHunkLineKind::Delete => cursor += 1,
        }
    }
    let mut output = Vec::with_capacity(source.len() + replacement.len());
    output.extend_from_slice(&source[..location]);
    output.extend(replacement);
    output.extend_from_slice(&source[cursor..]);
    output
}

fn ambiguous_hunk_error(input_path: &str, hunk_number: usize) -> V4aHunkApplyError {
    V4aHunkApplyError(format!(
        "Hunk {hunk_number} for \"{input_path}\": context matches multiple locations. Add more surrounding context or an @@ marker."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Compact test notation builds only the structured hunk the wire carries.
    fn update_operation(patch: &str) -> V4aUpdateHunk {
        let mut hunk = V4aUpdateHunk {
            marker: None,
            lines: Vec::new(),
        };
        for line in split_lines(patch) {
            if let Some(marker) = line.content.strip_prefix("@@ ") {
                hunk.marker = Some(marker.to_owned());
                continue;
            }
            let kind = match line.content.as_bytes().first() {
                Some(b' ') => V4aHunkLineKind::Context,
                Some(b'+') => V4aHunkLineKind::Add,
                Some(b'-') => V4aHunkLineKind::Delete,
                _ => continue,
            };
            hunk.lines.push(V4aHunkLine {
                kind,
                content: line.content[1..].to_owned(),
                ending: line.ending,
            });
        }
        hunk
    }

    #[test]
    fn applies_update_and_deletion_hunks_and_tracks_the_unchanged_prefix() {
        let first = update_operation(
            "*** Begin Patch\n*** Update File: lines.txt\n a\n-b\n c\n*** End Patch",
        );
        let second =
            update_operation("*** Begin Patch\n*** Update File: lines.txt\n d\n+e\n*** End Patch");
        let applied = apply_update_hunks("a\nb\nc\nd\n", &[first, second], "lines.txt").unwrap();
        assert_eq!(applied.content, "a\nc\nd\ne\n");
        assert_eq!(applied.line_numbers_valid_through_line, 1);
    }

    #[test]
    fn preserves_source_context_endings_and_added_line_endings() {
        let hunk = update_operation(
            "*** Begin Patch\r\n*** Update File: x\r\n old\r\n-old value\r\n+new value\r\n*** End Patch",
        );
        let applied = apply_update_hunks("old\r\nold value\r\nlast\n", &[hunk], "x").unwrap();
        assert_eq!(applied.content, "old\r\nnew value\r\nlast\n");
    }

    #[test]
    fn tolerates_trailing_whitespace_only_after_exact_matching_fails() {
        let hunk = update_operation(
            "*** Begin Patch\n*** Update File: spaces.ts\n-const value = 1;\n+const value = 2;\n*** End Patch",
        );
        let applied = apply_update_hunks("const value = 1;   \n", &[hunk], "spaces.ts").unwrap();
        assert_eq!(applied.content, "const value = 2;\n");
    }

    #[test]
    fn uses_markers_to_choose_between_repeated_contexts() {
        let hunk = update_operation(
            "*** Begin Patch\n*** Update File: markers.ts\n@@ function second() {\n-  return false;\n+  return true;\n*** End Patch",
        );
        let applied = apply_update_hunks(
            "function first() {\n  return false;\n}\nfunction second() {\n  return false;\n}\n",
            &[hunk],
            "markers.ts",
        )
        .unwrap();
        assert_eq!(
            applied.content,
            "function first() {\n  return false;\n}\nfunction second() {\n  return true;\n}\n"
        );
    }

    #[test]
    fn refuses_ambiguous_and_missing_hunk_context() {
        let ambiguous = update_operation(
            "*** Begin Patch\n*** Update File: ambiguous.txt\n-same\n+changed\n*** End Patch",
        );
        assert_eq!(
            apply_update_hunks("same\nmiddle\nsame\n", &[ambiguous], "ambiguous.txt")
                .unwrap_err()
                .to_string(),
            "Hunk 1 for \"ambiguous.txt\": context matches multiple locations. Add more surrounding context or an @@ marker."
        );

        let missing = update_operation(
            "*** Begin Patch\n*** Update File: missing.txt\n-absent\n+present\n*** End Patch",
        );
        assert_eq!(
            apply_update_hunks("first\nsecond\n", &[missing], "missing.txt")
                .unwrap_err()
                .to_string(),
            "Hunk 1 for \"missing.txt\": context not found. Re-read the file and regenerate the patch."
        );
    }

    #[test]
    fn refuses_nul_text_content() {
        let error = assert_text_content("safe\0unsafe", "binary.txt").unwrap_err();
        assert_eq!(
            error.to_string(),
            "Refusing to patch \"binary.txt\": the result contains a NUL byte and would not be a text file."
        );
    }
}
