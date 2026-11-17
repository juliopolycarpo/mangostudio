//! Parity tests for the literal prefilter of `fs.grep`.
//!
//! The oracle is the same matcher with its prefilter removed: QuickJS tests
//! every line, so its answer is what ECMAScript says. A prefiltered scan must
//! return exactly that, whatever the pattern, the file and the limits. A
//! literal-extraction bug is a silently missing match, so these tests are the
//! only thing standing between the prefilter and a false negative.

use super::*;
use crate::filesystem::grep_prefilter::required_literals;
use crate::test_support::scratch_dir;

/// The backslash, spelled out so a test source never contains a `\u` escape
/// followed by four hex digits, which some editors decode into the character.
const BACKSLASH: char = '\\';

fn token() -> CancellationToken {
    CancellationToken::new()
}

fn grep_params(root: &Path, pattern: &str) -> GrepParams {
    GrepParams {
        pattern: pattern.to_owned(),
        input_path: ".".to_owned(),
        resolved_path: root.to_path_buf(),
        glob: None,
        case_insensitive: false,
        max_results: 100,
        max_matches_per_file: 10,
        max_file_size_bytes: 1024 * 1024,
        include_dotfiles: false,
        path_policy: PathPolicy::default(),
    }
}

/// xorshift64*: a fixed seed reproduces a failing case without a new
/// dev-dependency.
struct SeededRandom(u64);

impl SeededRandom {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }

    fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }
}

/// Line fragments: ASCII text near the corpus literals, case variants, the
/// characters non-Unicode case folding treats specially (`ſ`, the Kelvin
/// sign, dotless and dotted `i`, final sigma, `ß`), and every kind of line
/// terminator the engine knows (only `\n` splits a file into lines).
const TEXT_FRAGMENTS: &[&str] = &[
    "needle",
    "Needle",
    "NEEDLE",
    "-needle",
    "id=",
    "12",
    "345",
    "-",
    "foo",
    "FOO",
    "bar",
    "Bar",
    "baz",
    "ab",
    "abc",
    "ABC",
    "a",
    "A",
    "b",
    "c",
    "d",
    "x",
    "y",
    "k",
    "K",
    "kiss",
    "KISS",
    "ss",
    "SS",
    "s",
    "i",
    "I",
    ".",
    "\\",
    "/",
    "(",
    ")",
    "[",
    "]",
    "{",
    "}",
    "|",
    "?",
    "*",
    "+",
    "$",
    "^",
    " ",
    "  ",
    "\t",
    "\r",
    "\u{1}",
    "\u{b}",
    "\u{c}",
    "\u{85}",
    "\u{a0}",
    "\u{feff}",
    "é",
    "É",
    "e\u{301}",
    "ß",
    "\u{17f}",
    "\u{212a}",
    "\u{131}",
    "\u{130}",
    "ς",
    "σ",
    "Σ",
    "😀",
    "\u{2028}",
    "\u{2029}",
    "\u{fffd}",
    "brown fox",
    "_",
    "p{L}",
    "u{41}",
    "kfoo",
    "a{,5}",
    "a{1",
];

/// Pattern atoms for generated expressions. QuickJS refuses invalid
/// combinations and the generator skips them. The atoms cover the extractor's
/// escape whitelist, every escape it refuses, lookarounds with and without a
/// literal, and the Annex B readings of `{`, `}` and `]`.
const PATTERN_ATOMS: &[&str] = &[
    "needle",
    "foo",
    "bar",
    "ab",
    "a",
    "b",
    "c",
    "x",
    "k",
    "kiss",
    "KISS",
    "ss",
    "s",
    "I",
    "é",
    "ß",
    "σ",
    "😀",
    "id=",
    "-",
    " ",
    "\\d",
    "\\d+",
    "\\w",
    "\\W",
    "\\s",
    "\\.",
    "\\\\",
    "\\-",
    "\\_",
    "\\/",
    "\\$",
    "\\(",
    "\\<",
    "[a-c]",
    "[^a]",
    "[]",
    "[^]",
    "[)(]",
    "[\\]x]",
    "(?:foo|bar)",
    "(foo)",
    "(?<g>ab)",
    "(?<=id=)",
    "(?<=needle)",
    "(?<!x)",
    "(?<!needle)",
    "(?=b)",
    "(?=needle)",
    "(?!c)",
    "(?!needle)",
    "(?i:ab)",
    "(?-i:ab)",
    ".",
    "^",
    "$",
    "\\b",
    "\\B",
    "(a|)",
    "\u{fffd}",
    "\\t",
    "\\r",
    "\\n",
];

/// Atoms the extractor refuses to read: escapes whose meaning depends on
/// context, and the Annex B literal readings of `{`, `}` and `]`. Any of them
/// in a pattern turns the prefilter off, so they are mixed in sparingly to
/// keep most generated patterns prefiltered.
const REFUSED_ATOMS: &[&str] = &[
    "\\x41", "\\cA", "\\cJ", "\\0", "\\101", "\\1", "\\k<g>", "\\k", "\\a", "\\p{L}", "\\P{L}",
    "\\é", "{", "}", "]", "a{,5}", "a{1",
];

/// Refused atoms spelled with a `\u` escape, built at run time (see
/// [`BACKSLASH`]).
fn unicode_escape_atoms() -> Vec<String> {
    vec![
        format!("{BACKSLASH}u00e9"),
        format!("{BACKSLASH}u0041"),
        format!("{BACKSLASH}u{{41}}"),
        format!("{BACKSLASH}u{{1F600}}"),
        format!("{BACKSLASH}u2028"),
        format!("{BACKSLASH}ud83d"),
    ]
}

const QUANTIFIERS: &[&str] = &[
    "", "", "", "", "?", "*", "+", "{0,2}", "{1}", "{2,}", "??", "+?", "*?", "{0}",
];

fn generated_pattern(random: &mut SeededRandom, unicode_escapes: &[String]) -> String {
    let alternatives = 1 + random.below(3);
    let mut pattern = String::new();
    for alternative in 0..alternatives {
        if alternative > 0 {
            pattern.push('|');
        }
        for _ in 0..random.below(5) {
            if random.chance(8) {
                let refused = REFUSED_ATOMS.len() + unicode_escapes.len();
                let index = random.below(refused);
                match REFUSED_ATOMS.get(index) {
                    Some(atom) => pattern.push_str(atom),
                    None => pattern.push_str(&unicode_escapes[index - REFUSED_ATOMS.len()]),
                }
            } else {
                pattern.push_str(random.pick(PATTERN_ATOMS));
            }
            pattern.push_str(random.pick(QUANTIFIERS));
        }
        // Most alternatives get a plain literal so the prefilter is active
        // for a good share of the patterns.
        if random.chance(70) {
            pattern.push_str(random.pick(PLAIN_LITERALS));
        }
    }
    pattern
}

const PLAIN_LITERALS: &[&str] = &[
    "needle", "foo", "bar", "ab", "kiss", "KISS", "x", "id=", "-",
];

/// A file of short lines mixing [`TEXT_FRAGMENTS`], slices of the pattern's
/// own source and its required literals with flipped case, so many lines
/// nearly match.
fn generated_content(random: &mut SeededRandom, pattern: &str) -> Vec<u8> {
    let source: Vec<char> = pattern.chars().collect();
    let literals = required_literals(pattern, "").unwrap_or_default();
    let mut content = Vec::new();
    for line in 0..random.below(30) {
        if line > 0 {
            content.extend_from_slice(if random.chance(10) { b"\r\n" } else { b"\n" });
        }
        for _ in 0..random.below(7) {
            let roll = random.below(10);
            if roll < 2 && !source.is_empty() {
                let start = random.below(source.len());
                let end = start + random.below(source.len() - start + 1);
                let slice: String = source[start..end].iter().collect();
                content.extend_from_slice(slice.as_bytes());
            } else if roll < 4 && !literals.is_empty() {
                let literal: String = random
                    .pick(&literals)
                    .chars()
                    .map(|character| match random.below(3) {
                        0 => character.to_ascii_uppercase(),
                        1 => character.to_ascii_lowercase(),
                        _ => character,
                    })
                    .collect();
                content.extend_from_slice(literal.as_bytes());
            } else {
                content.extend_from_slice(random.pick(TEXT_FRAGMENTS).as_bytes());
            }
        }
        if random.chance(3) {
            // Invalid UTF-8 the reader turns into U+FFFD.
            content.push(0xff);
        }
    }
    if random.chance(50) {
        content.push(b'\n');
    }
    // A NUL in the first 8 KiB makes the file binary and skips it for both
    // matchers; none of the fragments holds one.
    content
}

/// Tallies of one parity run, asserted so a run that never exercises the
/// prefilter cannot pass vacuously.
#[derive(Default, Debug)]
struct ParityTally {
    compared_scans: usize,
    prefiltered_scans: usize,
    prefiltered_scans_with_matches: usize,
    reference_matches: usize,
    truncated_scans: usize,
}

/// One parity case: file content and `(earlier results, max matches per
/// file, max results)`.
type ParityCase = (Vec<u8>, (usize, usize, usize));

/// A matcher whose prefilter is removed: the per-line scan every file got
/// before the prefilter existed.
fn reference_matcher(pattern: &str, case_insensitive: bool) -> GrepMatcher {
    let mut reference = GrepMatcher::new(pattern, case_insensitive, token()).unwrap();
    reference.prefilter = None;
    reference
}

/// Scans each case with the prefilter and with the per-line engine alone,
/// under the same limits and earlier results, and asserts both agree. A
/// pattern QuickJS refuses is skipped.
fn assert_prefilter_parity(
    pattern: &str,
    case_insensitive: bool,
    cases: &[ParityCase],
    tally: &mut ParityTally,
) {
    let Ok(mut filtered) = GrepMatcher::new(pattern, case_insensitive, token()) else {
        return;
    };
    let mut reference = reference_matcher(pattern, case_insensitive);
    let flags = regexp_flags(case_insensitive);
    for (content, (earlier, max_matches_per_file, max_results)) in cases {
        let mut params = grep_params(Path::new("."), pattern);
        params.case_insensitive = case_insensitive;
        params.max_matches_per_file = *max_matches_per_file;
        params.max_results = *max_results;
        let prior: Vec<Value> = (0..*earlier)
            .map(|line| json!({ "file": "earlier.txt", "line": line + 1, "text": "x" }))
            .collect();
        let run = |matcher: &mut GrepMatcher| {
            let mut matches = prior.clone();
            let incomplete = scan_bytes(
                content.clone(),
                "file.txt",
                &params,
                matcher,
                &token(),
                &mut matches,
            )
            .unwrap();
            (incomplete, matches)
        };
        let expected = run(&mut reference);
        let received = run(&mut filtered);
        assert_eq!(
            received,
            expected,
            "pattern {pattern:?} (flags {flags:?}, literals {:?}, earlier {earlier}, per file \
             {max_matches_per_file}, results {max_results}) over {:?}: expected the prefiltered \
             scan to equal the per-line scan",
            required_literals(pattern, flags),
            String::from_utf8_lossy(content),
        );
        let new_matches = expected.1.len() - prior.len();
        tally.compared_scans += 1;
        tally.reference_matches += new_matches;
        tally.truncated_scans += usize::from(expected.0);
        if filtered.prefilter.is_some() {
            tally.prefiltered_scans += 1;
            tally.prefiltered_scans_with_matches += usize::from(new_matches > 0);
        }
    }
}

fn random_limits(random: &mut SeededRandom) -> (usize, usize, usize) {
    let earlier = random.below(3);
    if random.chance(60) {
        (earlier, 1_000, 1_000)
    } else {
        (earlier, 1 + random.below(4), earlier + random.below(5))
    }
}

#[test]
fn prefiltered_grep_equals_the_per_line_scan_on_a_regex_corpus() {
    let escaped_unicode = format!("{BACKSLASH}u00e9");
    let corpus: Vec<&str> = vec![
        r"(?<=id=)(\d+)-needle$",
        r"(\d+)-needle$",
        r"(\d+)-NEEDLE$",
        "needle_absent",
        "brown fox",
        "absent_one|(\\d+)-needle$",
        "Absent_One|-NEEDLE",
        "foo|bar",
        "fo+o",
        "ab?c",
        "ab*c",
        "ab??c",
        "a(b|c)d",
        r"\bfoo\b",
        r"foo\.bar",
        "[a-z]+id=",
        "[)]foo",
        "k",
        "kiss",
        "KISS",
        "ss",
        "s",
        "I",
        "i",
        "σ",
        "é",
        "ß",
        "😀",
        "😀?x",
        "x😀+",
        "^$",
        "x{2}y",
        "id=\\d{2,}",
        r"(?<n>ab)\k<n>",
        r"(a)\1",
        &escaped_unicode,
        r"\x41",
        "foo$|^bar",
        r"\\",
        r"\/",
        "\u{fffd}",
        "\r",
        r"a\r?$",
        "(?:foo|bar)baz",
        "foo(?=bar)",
        "(?<!\\$)12",
    ];
    let mut random = SeededRandom(0x9e37_79b9_7f4a_7c15);
    let mut tally = ParityTally::default();
    for pattern in corpus {
        for case_insensitive in [false, true] {
            let cases: Vec<ParityCase> = (0..12)
                .map(|_| {
                    (
                        generated_content(&mut random, pattern),
                        random_limits(&mut random),
                    )
                })
                .collect();
            assert_prefilter_parity(pattern, case_insensitive, &cases, &mut tally);
        }
    }
    assert!(
        tally.compared_scans >= 1_000
            && tally.prefiltered_scans >= 700
            && tally.prefiltered_scans_with_matches >= 150
            && tally.reference_matches >= 1_000,
        "expected a corpus run that exercises the prefilter (>= 1000 scans, >= 700 \
         prefiltered, >= 150 prefiltered with matches, >= 1000 matches) | received: {tally:?}"
    );
}

#[test]
fn prefiltered_grep_equals_the_per_line_scan_on_generated_patterns() {
    let unicode_escapes = unicode_escape_atoms();
    let mut random = SeededRandom(0xd1b5_4a32_d192_ed03);
    let mut tally = ParityTally::default();
    let mut patterns = 0usize;
    while patterns < 2_000 {
        let pattern = generated_pattern(&mut random, &unicode_escapes);
        if GrepMatcher::new(&pattern, false, token()).is_err() {
            continue;
        }
        patterns += 1;
        let case_insensitive = random.chance(40);
        let cases: Vec<ParityCase> = (0..3)
            .map(|_| {
                (
                    generated_content(&mut random, &pattern),
                    random_limits(&mut random),
                )
            })
            .collect();
        assert_prefilter_parity(&pattern, case_insensitive, &cases, &mut tally);
    }
    // About half of the generated patterns have a literal in every
    // alternative (3,201 of 6,000 scans at the time of writing); the rest
    // check that bailing out changes nothing.
    assert!(
        tally.compared_scans >= 5_000
            && tally.prefiltered_scans >= 2_000
            && tally.prefiltered_scans_with_matches >= 1_000
            && tally.reference_matches >= 10_000,
        "expected generated patterns that exercise the prefilter (>= 5000 scans, >= 2000 \
         prefiltered, >= 1000 prefiltered with matches, >= 10000 matches) | received: {tally:?}"
    );
}

/// A pattern, the file it runs over and what the per-line engine must say.
struct NamedCase {
    name: &'static str,
    pattern: String,
    case_insensitive: bool,
    content: Vec<u8>,
    /// One-based lines QuickJS matches; asserted on the per-line scan, so a
    /// mistake in this table is not mistaken for a prefilter bug.
    matching_lines: Vec<u64>,
    /// What the extractor must return; `None` means "no prefilter".
    literals: Option<Vec<&'static str>>,
}

fn named(
    name: &'static str,
    pattern: impl Into<String>,
    content: impl AsRef<[u8]>,
    matching_lines: &[u64],
    literals: Option<&[&'static str]>,
) -> NamedCase {
    NamedCase {
        name,
        pattern: pattern.into(),
        case_insensitive: false,
        content: content.as_ref().to_vec(),
        matching_lines: matching_lines.to_vec(),
        literals: literals.map(<[_]>::to_vec),
    }
}

fn named_ignoring_case(
    name: &'static str,
    pattern: impl Into<String>,
    content: impl AsRef<[u8]>,
    matching_lines: &[u64],
    literals: Option<&[&'static str]>,
) -> NamedCase {
    NamedCase {
        case_insensitive: true,
        ..named(name, pattern, content, matching_lines, literals)
    }
}

fn lines_matched(matcher: &mut GrepMatcher, case: &NamedCase) -> Vec<u64> {
    let mut params = grep_params(Path::new("."), &case.pattern);
    params.case_insensitive = case.case_insensitive;
    params.max_results = 1_000;
    params.max_matches_per_file = 1_000;
    let mut matches = Vec::new();
    let incomplete = scan_bytes(
        case.content.clone(),
        "file.txt",
        &params,
        matcher,
        &token(),
        &mut matches,
    )
    .unwrap();
    assert!(
        !incomplete,
        "case {:?}: expected a complete scan | received: incomplete",
        case.name
    );
    matches
        .iter()
        .map(|entry| entry["line"].as_u64().unwrap())
        .collect()
}

fn assert_named_cases(cases: Vec<NamedCase>) {
    for case in cases {
        let flags = regexp_flags(case.case_insensitive);
        let literals = required_literals(&case.pattern, flags);
        let expected_literals: Option<Vec<String>> = case
            .literals
            .as_ref()
            .map(|literals| literals.iter().map(ToString::to_string).collect());
        assert_eq!(
            literals, expected_literals,
            "case {:?}: pattern {:?} flags {flags:?}: expected literals {expected_literals:?}",
            case.name, case.pattern
        );

        let mut reference = reference_matcher(&case.pattern, case.case_insensitive);
        let reference_lines = lines_matched(&mut reference, &case);
        assert_eq!(
            reference_lines,
            case.matching_lines,
            "case {:?}: pattern {:?} flags {flags:?} over {:?}: expected QuickJS to match lines \
             {:?}",
            case.name,
            case.pattern,
            String::from_utf8_lossy(&case.content),
            case.matching_lines
        );

        let mut filtered = GrepMatcher::new(&case.pattern, case.case_insensitive, token()).unwrap();
        assert_eq!(
            filtered.prefilter.is_some(),
            case.literals.is_some(),
            "case {:?}: expected the prefilter to be active only when literals are extracted",
            case.name
        );
        let filtered_lines = lines_matched(&mut filtered, &case);
        assert_eq!(
            filtered_lines,
            reference_lines,
            "case {:?}: pattern {:?} flags {flags:?} over {:?}: expected the prefiltered scan to \
             match the lines the per-line scan matches",
            case.name,
            case.pattern,
            String::from_utf8_lossy(&case.content)
        );
    }
}

#[test]
fn alternation_is_split_at_group_depth_zero_only() {
    assert_named_cases(vec![
        named(
            "one literal per top-level alternative",
            "foo|bar",
            "foo\nbaz\nbar\n",
            &[1, 3],
            Some(&["bar", "foo"]),
        ),
        named(
            "a group-only alternative leaves no literal",
            "(foo|bar)",
            "foo\nbaz\nbar",
            &[1, 3],
            None,
        ),
        named(
            "alternation inside a group is not top level",
            "(?:foo|bar)baz",
            "foobaz\nbarbaz\nbaz\nfoo",
            &[1, 2],
            Some(&["baz"]),
        ),
        named(
            "a group alternative beside a literal alternative",
            "foo|(bar)baz",
            "foo\nbarbaz\nbaz\nbar",
            &[1, 2],
            Some(&["baz", "foo"]),
        ),
        named(
            "a trailing empty alternative matches every line",
            "needle|",
            "a\nneedle\n\nb",
            &[1, 2, 3, 4],
            None,
        ),
        named(
            "a leading empty alternative matches every line",
            "|needle",
            "a\nneedle\n\nb",
            &[1, 2, 3, 4],
            None,
        ),
        named(
            "alternation inside a lookbehind",
            "(?<=a|b)c",
            "ac\nbc\ncc\nc",
            &[1, 2],
            Some(&["c"]),
        ),
        named(
            "escaped parentheses open no group",
            r"\(foo\)|bar",
            "(foo)\nfoo\nbar",
            &[1, 3],
            Some(&["(foo)", "bar"]),
        ),
        named(
            "a parenthesis in a class opens no group",
            "[(]x|y",
            "(x\nx\ny\n(",
            &[1, 3],
            Some(&["x", "y"]),
        ),
        named(
            "a bar in a class is no alternative",
            "[|]x",
            "|x\nx\n|",
            &[1],
            Some(&["x"]),
        ),
    ]);
}

#[test]
fn a_literal_inside_a_lookaround_is_never_required() {
    assert_named_cases(vec![
        named(
            "negative lookbehind before the literal",
            "(?<!foo)bar",
            "foo bar\nxbar\nbar\nfoobar",
            &[1, 2, 3],
            Some(&["bar"]),
        ),
        named(
            "a pattern of one negative lookahead",
            "(?!needle)",
            "a\nneedle",
            &[1, 2],
            None,
        ),
        named(
            "negative lookahead after the literal",
            "x(?!needle)",
            "xneedle\nxn\nxneedl\nx",
            &[2, 3, 4],
            Some(&["x"]),
        ),
        named(
            "positive lookahead after the literal",
            "a(?=needle)",
            "aneedle\nab\nneedle",
            &[1],
            Some(&["a"]),
        ),
        named(
            "a pattern of one lookbehind",
            "(?<=needle)",
            "needle\nx",
            &[1],
            None,
        ),
        named(
            "named group around the only literal",
            "(?<word>needle)",
            "needle\nneed",
            &[1],
            None,
        ),
    ]);
}

#[test]
fn a_character_that_may_be_absent_is_never_required() {
    assert_named_cases(vec![
        named(
            "question mark",
            "ab?c",
            "ac\nabc\nbc\nabbc",
            &[1, 2],
            Some(&["a"]),
        ),
        named("star", "ab*c", "ac\nabbc\nxc", &[1, 2], Some(&["a"])),
        named(
            "zero repetitions",
            "fo{0}bar",
            "fbar\nfoobar\nfobar",
            &[1],
            Some(&["bar"]),
        ),
        named(
            "zero to two repetitions",
            "ab{0,2}c",
            "ac\nabbc\nabbbc",
            &[1, 2],
            Some(&["a"]),
        ),
        named(
            "exactly two repetitions",
            "ab{2}c",
            "abbc\nabc",
            &[1],
            Some(&["a"]),
        ),
        named(
            "plus keeps the character",
            "ab+c",
            "abbc\nac",
            &[1],
            Some(&["ab"]),
        ),
        named(
            "optional group between two literals",
            "ab(cd)?ef",
            "abef\nabcdef\nabcef",
            &[1, 2],
            Some(&["ab"]),
        ),
        named(
            "a group repeated zero times",
            "(?:abc){0}x",
            "x\nabcx",
            &[1, 2],
            Some(&["x"]),
        ),
        named("only optional characters", "a?b?", "zzz", &[1], None),
        // Without the `u` flag the `?` applies to the low surrogate alone, so
        // the high surrogate is required; dropping the whole character is
        // the safe side of that.
        named(
            "an astral character is two code units",
            "x😀?yz",
            "xyz\nx😀yz\nyz",
            &[2],
            Some(&["yz"]),
        ),
    ]);
}

#[test]
fn escapes_are_literal_only_when_their_meaning_is_certain() {
    let hex = named("hex escape", r"\x41bc", "Abc\nabc", &[1], None);
    let hex_between_literals = named(
        "hex escape between literals",
        r"A\x42c",
        "ABc\nAbc",
        &[1],
        None,
    );
    let unicode_escape = named(
        "four digit unicode escape",
        format!("{BACKSLASH}u0041bc"),
        "Abc\nabc",
        &[1],
        None,
    );
    // Without the `u` flag `\u` is `u` and `{41}` a quantifier.
    let braced_unicode_escape = named(
        "braced unicode escape without the u flag",
        format!("{BACKSLASH}u{{41}}bc"),
        format!("{}bc\nAbc", "u".repeat(41)),
        &[1],
        None,
    );
    let control_escape = named(
        "control letter escape",
        r"\cAx",
        "\u{1}x\nx\ncAx",
        &[1],
        None,
    );
    let octal_escape = named("octal escape", r"\101bc", "Abc\nabc", &[1], None);
    let backreference = named("numbered backreference", r"(a)\1", "aa\na", &[1], None);
    let named_backreference = named(
        "named backreference",
        r"(?<n>a)\k<n>b",
        "aab\nab",
        &[1],
        None,
    );
    // With no named group, `\k` is the letter `k`.
    let letter_k_escape = named(
        "k escape without a group",
        r"\kfoo",
        "kfoo\nfoo",
        &[1],
        None,
    );
    let property_escape = named(
        "property escape without the u flag",
        r"\p{L}",
        "p{L}\nx",
        &[1],
        None,
    );
    let letter_identity_escape = named(
        "identity escape of a letter",
        r"x\ay",
        "xay\nx\\ay",
        &[1],
        None,
    );
    let non_ascii_identity_escape = named("identity escape of é", r"\éx", "éx\nx", &[1], None);
    assert_named_cases(vec![
        hex,
        hex_between_literals,
        unicode_escape,
        braced_unicode_escape,
        control_escape,
        octal_escape,
        backreference,
        named_backreference,
        letter_k_escape,
        property_escape,
        letter_identity_escape,
        non_ascii_identity_escape,
        named("escaped slash", r"a\/b", "a/b\naxb", &[1], Some(&["a/b"])),
        named("escaped dash", r"x\-y", "x-y\nxy", &[1], Some(&["x-y"])),
        named(
            "escaped underscore",
            r"x\_y",
            "x_y\nxy",
            &[1],
            Some(&["x_y"]),
        ),
        named("escaped dot", r"a\.b", "a.b\naxb", &[1], Some(&["a.b"])),
        named(
            "escaped bar is no alternative",
            r"a\|b",
            "a|b\na\nb",
            &[1],
            Some(&["a|b"]),
        ),
        named(
            "escaped braces are no quantifier",
            r"a\{2\}",
            "a{2}\naa",
            &[1],
            Some(&["a{2}"]),
        ),
        named(
            "escaped brackets are no class",
            r"\[x\]",
            "[x]\nx",
            &[1],
            Some(&["[x]"]),
        ),
        named(
            "escaped anchors are plain characters",
            r"\^a\$",
            "^a$\na",
            &[1],
            Some(&["^a$"]),
        ),
        named(
            "escaped star, plus and question mark",
            r"a\*b\+c\?",
            "a*b+c?\nabc",
            &[1],
            Some(&["a*b+c?"]),
        ),
        named(
            "escaped backslash",
            r"a\\b",
            "a\\b\nab",
            &[1],
            Some(&["a\\b"]),
        ),
        named(
            "word boundary",
            r"\bfoo\b",
            "foo\nfoobar\nx foo y",
            &[1, 3],
            Some(&["foo"]),
        ),
        named("non-boundary", r"\Bfoo", "xfoo\nfoo", &[1], Some(&["foo"])),
        named(
            "class escape between literals",
            r"a\db",
            "a1b\nab\na12b",
            &[1],
            Some(&["a"]),
        ),
        named(
            "whitespace class includes line terminators",
            r"a\sb",
            "a b\na\tb\nab\na\u{2028}b",
            &[1, 2, 4],
            Some(&["a"]),
        ),
    ]);
}

#[test]
fn braces_and_brackets_that_are_not_syntax_are_never_guessed() {
    assert_named_cases(vec![
        named(
            "a class contributes no literal",
            "[abc]def",
            "adef\nzdef\ndef",
            &[1],
            Some(&["def"]),
        ),
        named(
            "an escaped bracket in a class",
            r"[\]]ab",
            "]ab\nab",
            &[1],
            Some(&["ab"]),
        ),
        named("empty class", "[]a|b", "a\nb\n[]a", &[2], Some(&["a", "b"])),
        named(
            "negated empty class",
            "[^]a",
            "xa\na\nxb",
            &[1],
            Some(&["a"]),
        ),
        named("lone closing bracket", "a]b", "a]b\nab", &[1], None),
        named("lone closing brace", "a}b", "a}b\nab", &[1], None),
        named("lone opening brace", "a{b", "a{b\nab", &[1], None),
        named(
            "brace without a lower bound",
            "a{,5}b",
            "a{,5}b\nab",
            &[1],
            None,
        ),
        named("unterminated brace quantifier", "a{1", "a{1\na", &[1], None),
    ]);
}

#[test]
fn ignore_case_folds_ascii_only_and_never_trusts_a_non_ascii_literal() {
    assert_named_cases(vec![
        named_ignoring_case(
            "ascii case variants",
            "needle",
            "NEEDLE\nNeEdLe\nneedle\nneedl",
            &[1, 2, 3],
            Some(&["needle"]),
        ),
        // U+212A KELVIN SIGN and U+017F LONG S fold to `k` and `s` only
        // under `u` plus `i`.
        named_ignoring_case(
            "kelvin sign and long s stay out of non-unicode folding",
            "kiss",
            "KISS\n\u{212a}iss\nki\u{17f}\u{17f}\nkiss\nKiSs",
            &[1, 4, 5],
            Some(&["kiss"]),
        ),
        named_ignoring_case(
            "dotless i does not fold to ascii i",
            "I",
            "\u{131}\ni\nI",
            &[2, 3],
            Some(&["I"]),
        ),
        named_ignoring_case(
            "long s does not fold to ascii s",
            "s",
            "\u{17f}\nS\ns",
            &[2, 3],
            Some(&["s"]),
        ),
        named_ignoring_case(
            "a non-ascii letter folds among non-ascii letters",
            "σ",
            "σ\nΣ\nς",
            &[1, 2, 3],
            None,
        ),
        named_ignoring_case(
            "ascii runs around a non-ascii letter",
            "abécd",
            "ABÉCD\nabécd\nabecd",
            &[1, 2],
            Some(&["ab"]),
        ),
        named_ignoring_case(
            "sharp s has no single-character upper case",
            "straße",
            "STRASSE\nstraße\nSTRAßE",
            &[2, 3],
            Some(&["stra"]),
        ),
        named(
            "case matters without the flag",
            "Needle",
            "needle\nNeedle",
            &[2],
            Some(&["Needle"]),
        ),
    ]);
}

#[test]
fn only_a_line_feed_splits_lines_and_every_other_terminator_stays_inside() {
    assert_named_cases(vec![
        named(
            "carriage return stays in the line",
            "^needle$",
            "needle\nneedle\r\n xneedle\nneedle",
            &[1, 4],
            Some(&["needle"]),
        ),
        named(
            "dot refuses carriage return and line separators but not next line",
            "needle.",
            "needle\r\nneedle\u{2028}\nneedle\u{85}\nneedlex",
            &[3, 4],
            Some(&["needle"]),
        ),
        named(
            "a line separator does not end the line for dollar",
            "needle$",
            "needle\u{2028}x\nneedle",
            &[2],
            Some(&["needle"]),
        ),
        named(
            "empty lines and no trailing newline",
            "b",
            "\n\nb\n\nb",
            &[3, 5],
            Some(&["b"]),
        ),
        named(
            "a raw line feed in the pattern never matches",
            "a\nb",
            "a\nb",
            &[],
            Some(&["a"]),
        ),
        named(
            "an escaped line feed never matches",
            r"a\nb",
            "a\nb",
            &[],
            Some(&["a"]),
        ),
        named(
            "an escaped carriage return",
            r"a\rb",
            "a\rb\nab",
            &[1],
            Some(&["a"]),
        ),
    ]);
}

#[test]
fn invalid_utf8_is_searched_as_the_replacement_character_the_engine_sees() {
    assert_named_cases(vec![
        named(
            "dot matches the replacement character",
            "needle.",
            b"needle\xff\nneedle\n".as_slice(),
            &[1],
            Some(&["needle"]),
        ),
        named(
            "a literal holding the replacement character",
            "\u{fffd}x",
            b"\xffx\nx".as_slice(),
            &[1],
            Some(&["\u{fffd}x"]),
        ),
        named(
            "a truncated sequence becomes one replacement character",
            "b\u{fffd}\\(",
            b"ab\xc3(\nab(".as_slice(),
            &[1],
            Some(&["b\u{fffd}("]),
        ),
    ]);
}

/// Evaluates `new RegExp(pattern, flags).test(text)` in a bare QuickJS.
fn quickjs_regexp_test(pattern: &str, flags: &str, text: &str) -> bool {
    let runtime = Runtime::new().unwrap();
    let context = regexp_context(&runtime).unwrap();
    let json = |value: &str| serde_json::to_string(value).unwrap();
    context.with(|ctx| {
        ctx.eval::<bool, _>(format!(
            "new RegExp({}, {}).test({})",
            json(pattern),
            json(flags),
            json(text)
        ))
        .catch(&ctx)
        .unwrap_or_else(|error| panic!("pattern {pattern:?} flags {flags:?}: {error}"))
    })
}

/// The prefilter folds case with ASCII rules only. That is sound exactly when
/// the engine never folds a non-ASCII character to an ASCII one, which holds
/// without the `u` flag and not with it; this pins both facts so an engine
/// upgrade that moves either one fails here.
#[test]
fn quickjs_folds_non_ascii_to_ascii_only_under_the_unicode_flag() {
    for (pattern, flags, text, expected) in [
        ("k", "i", "\u{212a}", false),
        ("s", "i", "\u{17f}", false),
        ("i", "i", "\u{131}", false),
        ("I", "i", "\u{131}", false),
        ("k", "i", "K", true),
        ("k", "iu", "\u{212a}", true),
        ("s", "iu", "\u{17f}", true),
        ("\u{212a}", "i", "K", false),
        ("σ", "i", "ς", true),
    ] {
        let received = quickjs_regexp_test(pattern, flags, text);
        assert_eq!(
            received, expected,
            "pattern {pattern:?} flags {flags:?} text {text:?}: expected test() = {expected}"
        );
    }
}

/// Unicode property escapes and set operations are not reachable through
/// `fs.grep` (it never passes `u` or `v`), but they must not depend on an
/// intrinsic the slim context dropped, or a future flag would fail only there.
#[test]
fn unicode_property_escapes_run_in_the_regexp_only_context() {
    for (pattern, flags, text, expected) in [
        (r"^\p{L}+$", "u", "\u{e9}t\u{e9}", true),
        (r"^\p{L}+$", "u", "a1", false),
        (r"^\p{Script=Greek}$", "u", "\u{3c3}", true),
        (r"^[\p{L}--[a-z]]$", "v", "\u{e9}", true),
        (r"^[\p{L}--[a-z]]$", "v", "a", false),
        (r"^\u{1F600}$", "u", "\u{1f600}", true),
    ] {
        let received = quickjs_regexp_test(pattern, flags, text);
        assert_eq!(
            received, expected,
            "pattern {pattern:?} flags {flags:?} text {text:?}: expected test() = {expected}"
        );
    }
}

#[test]
fn only_the_flags_grep_compiles_with_get_a_prefilter() {
    for flags in ["m", "s", "y", "g", "d", "u", "v", "iu", "iv", "im", "ii"] {
        assert_eq!(
            required_literals("needle", flags),
            None,
            "flags {flags:?}: expected no prefilter for a flag grep never passes"
        );
    }
    assert_eq!(
        required_literals("needle", ""),
        Some(vec!["needle".to_owned()])
    );
    assert_eq!(
        required_literals("needle", "i"),
        Some(vec!["needle".to_owned()])
    );
}

#[test]
fn prefiltered_grep_skips_lines_without_a_literal_and_keeps_line_numbers() {
    let root = scratch_dir("filesystem-grep-prefilter-lines");
    let mut content = String::new();
    for line in 1..=5_000 {
        if line % 1_000 == 0 {
            content.push_str(&format!("entry id={line}-needle\n"));
        } else {
            content.push_str("filler id=7 needle\n");
        }
    }
    fs::write(root.join("big.txt"), &content).unwrap();
    fs::write(root.join("none.txt"), "filler id=7 needle\n".repeat(100)).unwrap();
    let mut params = grep_params(&root, r"(?<=id=)(\d+)-needle$");
    params.max_matches_per_file = 3;
    let result = grep(params, &token()).unwrap();
    assert_eq!(result["filesScanned"], 2);
    assert_eq!(result["truncated"], true);
    assert_eq!(
        result["matches"],
        json!([
            { "file": "big.txt", "line": 1000, "text": "entry id=1000-needle" },
            { "file": "big.txt", "line": 2000, "text": "entry id=2000-needle" },
            { "file": "big.txt", "line": 3000, "text": "entry id=3000-needle" },
        ])
    );
}

/// The behaviour change the prefilter brings: a line the engine would spend
/// its whole file budget on is never handed to it when it lacks the literal.
#[test]
fn a_file_that_exhausted_the_budget_per_line_now_completes_with_its_matches() {
    // `(a+)+b` backtracks catastrophically on a long run of `a`, and `b` is
    // the literal the line lacks.
    let content = format!("{}\naab\n", "a".repeat(50_000));
    let pattern = r"^(a+)+b$";
    let params = grep_params(Path::new("."), pattern);
    let scan_with = |mut matcher: GrepMatcher| {
        let mut matches = Vec::new();
        let incomplete = scan_bytes(
            content.clone().into_bytes(),
            "file.txt",
            &params,
            &mut matcher,
            &token(),
            &mut matches,
        )
        .unwrap();
        (incomplete, matches)
    };
    let budgeted = |prefilter: bool| {
        let mut matcher =
            GrepMatcher::with_file_budget(pattern, false, token(), Duration::from_millis(300))
                .unwrap();
        if !prefilter {
            matcher.prefilter = None;
        }
        matcher
    };

    let (per_line_incomplete, per_line_matches) = scan_with(budgeted(false));
    assert!(
        per_line_incomplete && per_line_matches.is_empty(),
        "expected the per-line scan to run out of its budget with no match | received: \
         incomplete={per_line_incomplete} matches={per_line_matches:?}"
    );

    let (incomplete, matches) = scan_with(budgeted(true));
    assert!(
        !incomplete,
        "expected the prefiltered scan to complete | received: incomplete, matches={matches:?}"
    );
    assert_eq!(
        matches,
        vec![json!({ "file": "file.txt", "line": 2, "text": "aab" })]
    );
}

#[test]
fn a_file_without_a_literal_still_reports_a_cancelled_grep() {
    let cancel = token();
    let params = grep_params(Path::new("."), "needle");
    let mut matcher = GrepMatcher::new("needle", false, cancel.clone()).unwrap();
    assert!(
        matcher.prefilter.is_some(),
        "fixture needs a prefiltered pattern"
    );
    cancel.cancel();
    let outcome = scan_bytes(
        b"hay\nstack\n".to_vec(),
        "hay.txt",
        &params,
        &mut matcher,
        &cancel,
        &mut Vec::new(),
    );
    let code = outcome.as_ref().err().map(|error| error.code.clone());
    assert_eq!(
        code.as_deref(),
        Some(codes::CANCELLED),
        "expected a cancelled scan refused as {} | received: {outcome:?}",
        codes::CANCELLED
    );
}
