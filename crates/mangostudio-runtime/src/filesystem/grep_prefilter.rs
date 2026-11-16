//! A literal prefilter in front of `fs.grep`'s QuickJS `RegExp#test`.
//!
//! QuickJS tests one line at a time at roughly 30-50 MiB/s, so a large file
//! spends nearly all of its scan inside the engine. Most patterns, however,
//! cannot match without some fixed text: `(?<=id=)(\d+)-needle$` needs
//! `-needle` on the line. [`LinePrefilter`] searches the file once for such
//! required literals with `aho-corasick`, locates the lines around the hits
//! with `memchr`, and hands QuickJS only those lines; every other line is a
//! certain non-match and is never tested.
//!
//! The extraction is deliberately conservative. A literal is only returned
//! when every match of the pattern must contain it, and anything the
//! extractor does not fully understand means no prefilter at all, so the
//! worst case is today's per-line scan.

use aho_corasick::{AhoCorasick, AhoCorasickBuilder, MatchKind};

/// The required literals of one ECMAScript pattern, as text a line must
/// contain before QuickJS is worth calling.
///
/// Built only for patterns QuickJS already compiled, so the extractor never
/// has to reject syntax errors itself.
///
/// # Example
///
/// ```ignore
/// let prefilter = LinePrefilter::for_pattern(r"(?<=id=)(\d+)-needle$", "").unwrap();
/// let lines: Vec<_> = prefilter.candidate_lines("a\nid=1-needle\nb").collect();
/// assert_eq!(lines, [(1, "id=1-needle")]);
/// ```
#[derive(Debug)]
pub(super) struct LinePrefilter {
    automaton: AhoCorasick,
}

impl LinePrefilter {
    /// The prefilter for `pattern` compiled with `flags`, the same string the
    /// engine's `RegExp` is built with, or `None` when the pattern has no
    /// usable literal or the flags are not ones the extractor understands.
    pub(super) fn for_pattern(pattern: &str, flags: &str) -> Option<Self> {
        let literals = required_literals(pattern, flags)?;
        let automaton = AhoCorasickBuilder::new()
            // `required_literals` only accepts "" and "i", and under `i` every
            // literal is ASCII. Non-Unicode ECMAScript case folding never maps
            // a non-ASCII character to an ASCII one, so ASCII folding finds
            // exactly the text the engine could match.
            .ascii_case_insensitive(flags == "i")
            .match_kind(MatchKind::Standard)
            .build(&literals)
            .ok()?;
        Some(Self { automaton })
    }

    /// Start of the first literal at or after byte `from`.
    ///
    /// One automaton serves a single literal and several alike; it searches a
    /// lone literal with `memmem` internally.
    fn find_from(&self, haystack: &[u8], from: usize) -> Option<usize> {
        self.automaton
            .find(&haystack[from..])
            .map(|found| from + found.start())
    }

    /// The lines of `text` (split on `\n`, as the per-line scan splits them)
    /// that contain a required literal, with their zero-based line index, in
    /// file order.
    pub(super) fn candidate_lines<'a>(&'a self, text: &'a str) -> CandidateLines<'a> {
        CandidateLines {
            prefilter: self,
            text,
            line_start: 0,
            line_index: 0,
        }
    }
}

/// Iterator returned by [`LinePrefilter::candidate_lines`].
pub(super) struct CandidateLines<'a> {
    prefilter: &'a LinePrefilter,
    text: &'a str,
    /// Byte offset of the first line not yet searched.
    line_start: usize,
    /// Zero-based index of the line that starts at `line_start`.
    line_index: usize,
}

impl<'a> Iterator for CandidateLines<'a> {
    type Item = (usize, &'a str);

    fn next(&mut self) -> Option<Self::Item> {
        let bytes = self.text.as_bytes();
        if self.line_start > bytes.len() {
            return None;
        }
        let hit = self.prefilter.find_from(bytes, self.line_start)?;
        // Literals never contain `\n` (the extractor ends a run there), so the
        // whole occurrence lies on the line around `hit`.
        let start = memchr::memrchr(b'\n', &bytes[self.line_start..hit])
            .map_or(self.line_start, |offset| self.line_start + offset + 1);
        let index =
            self.line_index + memchr::memchr_iter(b'\n', &bytes[self.line_start..start]).count();
        let end = memchr::memchr(b'\n', &bytes[hit..]).map_or(bytes.len(), |offset| hit + offset);
        self.line_start = end + 1;
        self.line_index = index + 1;
        // `start` and `end` sit next to `\n` bytes or the text's ends, which are
        // always character boundaries.
        Some((index, &self.text[start..end]))
    }
}

/// Literals of which every match of `pattern` (an ECMAScript `RegExp` source
/// with `flags`) contains at least one: one per top-level alternative, the
/// longest fixed run of characters at group depth 0.
///
/// Returns `None`, meaning "no prefilter", whenever that is not certain:
///
/// - any flag other than `i` (`u`, `v`, `s`, `y`, `m`, `g`, `d` change what the
///   source means or how it is applied);
/// - any top-level alternative without a literal (an empty alternative, or one
///   made only of groups, classes and escapes);
/// - escapes whose length or meaning depends on context in Annex B syntax
///   (`\x`, `\u`, `\c`, `\k`, `\p`, digits, letters other than the class and
///   control escapes), a `{` that is not a well-formed quantifier, a lone `]`
///   or `}`, and unbalanced groups or classes.
///
/// A character followed by `?`, `*` or a `{…}` quantifier is dropped, since it
/// may be absent; `+` keeps it. Either way the run ends, because a repeated
/// character breaks the contiguity of what follows. Under `i` only ASCII
/// characters join a run.
///
/// # Example
///
/// ```ignore
/// assert_eq!(required_literals(r"(?<=id=)(\d+)-needle$", ""), Some(vec!["-needle".into()]));
/// assert_eq!(required_literals("foo|bar?", ""), Some(vec!["foo".into(), "ba".into()]));
/// assert_eq!(required_literals("foo|", ""), None);
/// ```
pub(super) fn required_literals(pattern: &str, flags: &str) -> Option<Vec<String>> {
    let case_insensitive = match flags {
        "" => false,
        "i" => true,
        _ => return None,
    };
    let chars: Vec<char> = pattern.chars().collect();
    let mut literals: Vec<String> = Vec::new();
    let mut alternative = LiteralRun::default();
    let mut depth = 0usize;
    let mut position = 0usize;
    while let Some(&character) = chars.get(position) {
        position += 1;
        if depth > 0 {
            match character {
                // Inside a group only nesting matters. An escape is skipped
                // whole so `\(` or `\)` cannot change the depth; no escape body
                // (`\x41`, a 4-digit `\u` escape, `\cA`, `\k<n>`) holds a parenthesis.
                '\\' => position += 1,
                '[' => position = class_end(&chars, position)?,
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
            continue;
        }
        match character {
            '|' => {
                literals.push(alternative.finish()?);
                alternative = LiteralRun::default();
            }
            '(' => {
                alternative.end_run();
                depth = 1;
            }
            '[' => {
                alternative.end_run();
                position = class_end(&chars, position)?;
            }
            '.' | '^' | '$' | '\n' | '\r' | '\u{2028}' | '\u{2029}' => alternative.end_run(),
            '?' | '*' => alternative.drop_last_and_end_run(),
            '+' => alternative.end_run(),
            '{' => {
                position = quantifier_end(&chars, position)?;
                alternative.drop_last_and_end_run();
            }
            ')' | ']' | '}' => return None,
            '\\' => {
                let escaped = *chars.get(position)?;
                position += 1;
                match escaped {
                    escaped if escaped.is_ascii_punctuation() => {
                        alternative.push(escaped, case_insensitive);
                    }
                    'd' | 'D' | 'w' | 'W' | 's' | 'S' | 'b' | 'B' | 't' | 'n' | 'r' | 'f' | 'v' => {
                        alternative.end_run()
                    }
                    _ => return None,
                }
            }
            character if character.is_control() => alternative.end_run(),
            character => alternative.push(character, case_insensitive),
        }
    }
    if depth != 0 {
        return None;
    }
    literals.push(alternative.finish()?);
    literals.sort_unstable();
    literals.dedup();
    Some(literals)
}

/// The fixed runs of one top-level alternative, keeping the longest.
#[derive(Default)]
struct LiteralRun {
    current: String,
    longest: String,
}

impl LiteralRun {
    fn push(&mut self, character: char, case_insensitive: bool) {
        if case_insensitive && !character.is_ascii() {
            self.end_run();
        } else {
            self.current.push(character);
        }
    }

    fn end_run(&mut self) {
        if self.current.len() > self.longest.len() {
            std::mem::swap(&mut self.current, &mut self.longest);
        }
        self.current.clear();
    }

    /// Ends the run without its last character, which a quantifier made
    /// optional. After a group, class or escape the run is already empty and
    /// nothing is dropped.
    fn drop_last_and_end_run(&mut self) {
        self.current.pop();
        self.end_run();
    }

    /// The alternative's literal, or `None` when it has none.
    fn finish(mut self) -> Option<String> {
        self.end_run();
        (!self.longest.is_empty()).then_some(self.longest)
    }
}

/// Position just past the `]` closing the class whose `[` precedes `start`.
///
/// ECMAScript closes a class at its first unescaped `]`, even right after
/// `[` or `[^` (`[]` matches nothing, `[^]` anything).
fn class_end(chars: &[char], start: usize) -> Option<usize> {
    let mut position = start;
    loop {
        match chars.get(position)? {
            '\\' => position += 2,
            ']' => return Some(position + 1),
            _ => position += 1,
        }
    }
}

/// Position just past a well-formed `{n}`, `{n,}` or `{n,m}` quantifier whose
/// `{` precedes `start`. Anything else is a literal brace in Annex B syntax,
/// which the extractor does not try to follow.
fn quantifier_end(chars: &[char], start: usize) -> Option<usize> {
    let digits = |from: usize| {
        chars[from.min(chars.len())..]
            .iter()
            .take_while(|character| character.is_ascii_digit())
            .count()
    };
    let mut position = start;
    let minimum = digits(position);
    if minimum == 0 {
        return None;
    }
    position += minimum;
    if chars.get(position) == Some(&',') {
        position += 1;
        position += digits(position);
    }
    (chars.get(position) == Some(&'}')).then_some(position + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn literals(pattern: &str, flags: &str) -> Option<Vec<String>> {
        required_literals(pattern, flags)
    }

    fn owned(expected: &[&str]) -> Option<Vec<String>> {
        Some(expected.iter().map(ToString::to_string).collect())
    }

    #[test]
    fn extraction_keeps_the_longest_depth_zero_run_of_each_alternative() {
        for (pattern, flags, expected) in [
            (r"(?<=id=)(\d+)-needle$", "", vec!["-needle"]),
            ("needle", "", vec!["needle"]),
            ("brown fox", "", vec!["brown fox"]),
            ("ab(cd)efg", "", vec!["efg"]),
            (r"foo\.bar", "", vec!["foo.bar"]),
            (r"a\\b", "", vec![r"a\b"]),
            (r"x\/y\-z", "", vec!["x/y-z"]),
            ("abc|de", "", vec!["abc", "de"]),
            ("abc|abc", "", vec!["abc"]),
            ("😀x", "", vec!["😀x"]),
            ("café", "", vec!["café"]),
            (r"[)(]foo(?:[)]bar)", "", vec!["foo"]),
            (r"(\))baz", "", vec!["baz"]),
            ("[]ab", "", vec!["ab"]),
            ("[^]ab", "", vec!["ab"]),
            (r"[\]]ab", "", vec!["ab"]),
            ("q\"\\\\\u{2028}x", "", vec!["q\"\\"]),
        ] {
            assert_eq!(
                literals(pattern, flags),
                owned(&expected),
                "pattern {pattern:?} flags {flags:?}: expected literals {expected:?}"
            );
        }
    }

    #[test]
    fn extraction_drops_a_character_made_optional_and_keeps_a_repeated_one() {
        for (pattern, expected) in [
            ("abc?d", vec!["ab"]),
            ("abcd?", vec!["abc"]),
            ("ab*cd", vec!["cd"]),
            ("abc+de", vec!["abc"]),
            ("abc+?d", vec!["abc"]),
            // `+` and `??` end the run; the lazy `?` drops nothing more.
            ("abc??de", vec!["ab"]),
            ("abc{0,2}de", vec!["ab"]),
            ("abc{2}de", vec!["ab"]),
            ("abc{2,}?de", vec!["ab"]),
            ("ab(cd)?ef", vec!["ab"]),
            ("x😀?yz", vec!["yz"]),
            (r"ab\.?cd", vec!["ab"]),
        ] {
            assert_eq!(
                literals(pattern, ""),
                owned(&expected),
                "pattern {pattern:?}: expected literals {expected:?}"
            );
        }
    }

    #[test]
    fn extraction_under_ignore_case_keeps_only_ascii_runs() {
        assert_eq!(literals("Needle", "i"), owned(&["Needle"]));
        assert_eq!(literals("abécdef", "i"), owned(&["cdef"]));
        assert_eq!(literals("straße", "i"), owned(&["stra"]));
        assert_eq!(literals("é", "i"), None);
        assert_eq!(literals("ß|ss", "i"), None);
    }

    #[test]
    fn extraction_bails_out_when_a_literal_is_not_certain() {
        for (pattern, flags) in [
            // An alternative without a literal.
            ("", ""),
            ("foo|", ""),
            ("|foo", ""),
            ("foo|.", ""),
            (r"\d+", ""),
            ("(foo)", ""),
            ("[abc]", ""),
            ("^$", ""),
            ("a?", ""),
            ("a*", ""),
            // Escapes whose meaning depends on context or that span several characters.
            (r"\x41bc", ""),
            ("\\u0041bc", ""),
            (r"\u{41}bc", ""),
            (r"\cJbc", ""),
            (r"(a)\1bc", ""),
            (r"\0bc", ""),
            (r"(?<n>a)\k<n>bc", ""),
            (r"\p{L}bc", ""),
            (r"\abc", ""),
            (r"\é", ""),
            // Braces and brackets that Annex B may read as literals.
            ("a{,5}bc", ""),
            ("a{x}bc", ""),
            ("a{bc", ""),
            ("a}bc", ""),
            ("a]bc", ""),
            // Unbalanced or unterminated syntax.
            ("(abc", ""),
            ("abc)", ""),
            ("[abc", ""),
            ("abc\\", ""),
            // Flags that change the pattern's meaning.
            ("abc", "u"),
            ("abc", "v"),
            ("abc", "s"),
            ("abc", "y"),
            ("abc", "iu"),
            ("abc", "m"),
        ] {
            let found = literals(pattern, flags);
            assert_eq!(
                found, None,
                "pattern {pattern:?} flags {flags:?}: expected no prefilter | received: {found:?}"
            );
        }
    }

    #[test]
    fn candidate_lines_yield_each_line_holding_a_literal_once_with_its_index() {
        let prefilter = LinePrefilter::for_pattern("ab|cd", "").unwrap();
        let text = "ab\nnone\nxxcdab\r\n\n\nlast cd";
        let lines: Vec<_> = prefilter.candidate_lines(text).collect();
        assert_eq!(lines, [(0, "ab"), (2, "xxcdab\r"), (5, "last cd")]);

        let trailing: Vec<_> = prefilter.candidate_lines("ab\n").collect();
        assert_eq!(trailing, [(0, "ab")]);
        assert_eq!(prefilter.candidate_lines("").count(), 0);
        assert_eq!(prefilter.candidate_lines("\n\nzz\n").count(), 0);
    }

    #[test]
    fn candidate_lines_fold_ascii_case_only_under_ignore_case() {
        let prefilter = LinePrefilter::for_pattern("kiss", "i").unwrap();
        let text = "KISS\nKiSs\n\u{212a}iss\nki\u{17f}s\nkıss";
        let lines: Vec<_> = prefilter.candidate_lines(text).collect();
        assert_eq!(lines, [(0, "KISS"), (1, "KiSs")]);
    }
}
