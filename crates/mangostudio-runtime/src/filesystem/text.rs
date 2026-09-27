//! Byte-preserving text operations shared by filesystem handlers.

const MAX_LINE_CHARS: usize = 2_000;
const MAX_WINDOW_BYTES: usize = 256 * 1024;
const WINDOW_NOTICE: &str = "\n\n[truncated: use startLine/maxLines to read more]";

pub(super) fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8 * 1024).any(|byte| *byte == 0)
}

pub(super) fn total_lines(bytes: &[u8]) -> usize {
    bytes.iter().filter(|byte| **byte == b'\n').count()
        + usize::from(!bytes.is_empty() && bytes.last() != Some(&b'\n'))
}

pub(super) struct Window {
    pub content: String,
    pub end_line: usize,
    pub truncated: bool,
}

/// Formats the requested one-based window exactly as the TS text reader does.
pub(super) fn format_window(bytes: &[u8], start_line: usize, max_lines: usize) -> Window {
    let total = total_lines(bytes);
    let mut content = String::new();
    let mut end_line = start_line - 1;
    let mut truncated = false;
    let lines = bytes.split_inclusive(|byte| *byte == b'\n');
    for (offset, line) in lines.enumerate().skip(start_line - 1).take(max_lines) {
        let line = line.strip_suffix(b"\n").unwrap_or(line);
        // TextDecoder strips a leading BOM from each decoded window, not each line.
        let line = if offset == start_line - 1 {
            line.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(line)
        } else {
            line
        };
        let decoded = String::from_utf8_lossy(line);
        let (body, shortened) = truncate_utf16(&decoded, MAX_LINE_CHARS);
        let marker = if shortened { "…[truncated]" } else { "" };
        truncated |= shortened;
        let numbered = format!("{:>6}\t{body}{marker}", offset + 1);
        let separator = usize::from(!content.is_empty());
        if content.len() + separator + numbered.len() > MAX_WINDOW_BYTES {
            truncated = true;
            break;
        }
        if separator != 0 {
            content.push('\n');
        }
        content.push_str(&numbered);
        end_line = offset + 1;
    }
    if end_line < start_line {
        return Window {
            content: WINDOW_NOTICE.trim_start().to_owned(),
            end_line,
            truncated: true,
        };
    }
    truncated |= end_line < total;
    if truncated {
        content.push_str(WINDOW_NOTICE);
    }
    Window {
        content,
        end_line,
        truncated,
    }
}

fn truncate_utf16(text: &str, max_units: usize) -> (&str, bool) {
    let mut units = 0;
    for (index, character) in text.char_indices() {
        units += character.len_utf16();
        if units > max_units {
            return (&text[..index], true);
        }
    }
    (text, false)
}

/// Counts non-overlapping byte matches, stopping at `limit`.
///
/// # Example
///
/// ```ignore
/// assert_eq!(count_matches_up_to(b"aaaa", b"aa", 2), 2);
/// ```
pub(super) fn count_matches_up_to(source: &[u8], needle: &[u8], limit: usize) -> usize {
    assert!(!needle.is_empty(), "match needle must not be empty");
    let mut cursor = 0;
    let mut count = 0;
    while count < limit {
        let Some(relative) = source[cursor..]
            .windows(needle.len())
            .position(|part| part == needle)
        else {
            break;
        };
        count += 1;
        cursor += relative + needle.len();
    }
    count
}

/// Replaces non-overlapping byte matches, retaining invalid UTF-8 and BOM bytes.
pub(super) fn replace_matches(
    source: &[u8],
    old: &[u8],
    new: &[u8],
    all: bool,
) -> (Vec<u8>, usize, usize) {
    assert!(!old.is_empty(), "replacement needle must not be empty");
    let mut output = Vec::new();
    let mut cursor = 0;
    let mut count = 0;
    let mut first_line = 0;
    while let Some(relative) = source[cursor..]
        .windows(old.len())
        .position(|part| part == old)
    {
        let offset = cursor + relative;
        if count == 0 {
            first_line = 1 + source[..offset]
                .iter()
                .filter(|byte| **byte == b'\n')
                .count();
        }
        output.extend_from_slice(&source[cursor..offset]);
        output.extend_from_slice(new);
        count += 1;
        cursor = offset + old.len();
        if !all {
            break;
        }
    }
    output.extend_from_slice(&source[cursor..]);
    (output, count, first_line)
}

/// Splices an inclusive line range, preserving the original final newline.
pub(super) fn replace_range(
    source: &[u8],
    start: usize,
    end: usize,
    replacement: &[u8],
) -> Vec<u8> {
    let source_lines = split_lines(source);
    let replacements = split_lines(replacement);
    let lines: Vec<&[u8]> = source_lines[..start - 1]
        .iter()
        .chain(replacements.iter())
        .chain(source_lines[end..].iter())
        .copied()
        .collect();
    let mut output = lines.join(&b'\n');
    if !lines.is_empty() && source.last() == Some(&b'\n') {
        output.push(b'\n');
    }
    output
}

fn split_lines(bytes: &[u8]) -> Vec<&[u8]> {
    bytes
        .split_inclusive(|byte| *byte == b'\n')
        .map(|line| line.strip_suffix(b"\n").unwrap_or(line))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_counts_do_not_invent_a_line_after_the_final_newline() {
        for (bytes, expected) in [(b"".as_slice(), 0), (b"\n", 1), (b"a\n", 1), (b"a\nb", 2)] {
            assert_eq!(total_lines(bytes), expected);
        }
    }

    #[test]
    fn binary_sniff_stops_at_the_ts_boundary() {
        let mut bytes = vec![b'a'; 8193];
        bytes[8192] = 0;
        assert!(!looks_binary(&bytes));
        bytes[8191] = 0;
        assert!(looks_binary(&bytes));
    }

    #[test]
    fn window_preserves_cr_and_strips_only_the_window_bom() {
        let window = format_window(b"\xef\xbb\xbfa\r\n\xef\xbb\xbfb\n", 1, 2);
        assert_eq!(window.content, "     1\ta\r\n     2\t\u{feff}b");
        assert_eq!(window.end_line, 2);
        assert!(!window.truncated);
        assert_eq!(
            format_window(b"a\n\xef\xbb\xbfb\n", 2, 1).content,
            "     2\tb"
        );
    }

    #[test]
    fn window_caps_utf16_without_splitting_a_surrogate_pair() {
        let text = format!("{}😀", "a".repeat(1999));
        let window = format_window(text.as_bytes(), 1, 1);
        assert!(window.truncated);
        assert_eq!(
            window.content,
            format!("     1\t{}…[truncated]{WINDOW_NOTICE}", "a".repeat(1999))
        );
        assert_eq!(truncate_utf16("😀b", 2), ("😀", true));
    }

    #[test]
    fn window_reports_actual_last_line_at_byte_budget() {
        let bytes = "x".repeat(2000) + "\n";
        let window = format_window(bytes.repeat(200).as_bytes(), 1, 200);
        assert!(window.truncated);
        assert!(window.end_line < 200);
        assert!(window.content.len() <= MAX_WINDOW_BYTES + WINDOW_NOTICE.len());
        assert!(
            format_window(b"a\nb\n", 1, 1)
                .content
                .ends_with(WINDOW_NOTICE)
        );
    }

    #[test]
    fn literal_edit_retains_bytes_and_uses_nonoverlapping_matches() {
        assert_eq!(count_matches_up_to(b"aaaa", b"aa", usize::MAX), 2);
        assert_eq!(count_matches_up_to(b"aaaa", b"aa", 1), 1);
        assert_eq!(count_matches_up_to(b"aaaa", b"z", 2), 0);
        assert_eq!(
            replace_matches(b"\xff\r\naaaa", b"aa", b"X", true),
            (b"\xff\r\nXX".to_vec(), 2, 2)
        );
        assert_eq!(
            replace_matches(b"aaaa", b"aa", b"X", false),
            (b"Xaa".to_vec(), 1, 1)
        );
        assert_eq!(
            replace_matches(b"a", b"z", b"X", true),
            (b"a".to_vec(), 0, 0)
        );
    }

    #[test]
    fn range_splice_preserves_raw_lines_and_final_newline() {
        assert_eq!(
            replace_range(b"\xff\r\nb\r\nc\r\n", 2, 2, b"X"),
            b"\xff\r\nX\nc\r\n"
        );
        assert_eq!(replace_range(b"a\nb", 2, 2, b"X\n"), b"a\nX");
        assert_eq!(replace_range(b"a\n", 1, 1, b""), b"");
        assert_eq!(split_lines(b"\n"), vec![b"".as_slice()]);
    }
}
