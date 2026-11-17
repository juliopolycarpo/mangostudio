import type { ShikiLanguageId } from '@/lib/code-languages';

/**
 * How much of a code block the highlighter may tokenize before the rest is drawn plain.
 *
 * Tokenizing cannot be interrupted (`tokenizeTimeLimit` is only checked between regex matches),
 * so the cost is bounded before it starts. Measured on Shiki 4.6.0, two things grow it.
 *
 * Shape. Some grammars match one long token with lookaheads that rescan it, so the time grows
 * with the square of its length:
 *
 * - a word run: letters, digits, `_`, `$`, any non-ASCII character, and `.` or `?`, because
 *   `a.b.c` and `a?.b` chain like one word (an identifier, a hex digest, a JWT in a string, a
 *   dotted path, a word in a comment). In the TypeScript family a run costs about 1.5e-4 ms per
 *   square character: 512 characters take 40 ms, 4,096 take 1.7 s. C++ is twice as slow.
 * - a run of spaces or tabs, about half as much.
 * - on YAML and Java, the line itself, whatever it holds: about 1e-5 ms per square character.
 *
 * Punctuation, `/`, `-`, `+` and `=` end a run, so a long URL, a path, minified code or a regular
 * expression is linear and costs nothing extra. Costs add up across lines (twenty 190-character
 * words: 116 ms in TypeScript), so the scan sums a cost per block against `budget`, about 50 ms of
 * the slowest shape. A run shorter than `FREE_RUN_LENGTH` and a line shorter than
 * `FREE_LINE_LENGTH` cost nothing in this sum.
 *
 * Size. Linear cost is unbounded by shape: 5,000 lines of five 31-character words took 10 s in
 * TypeScript. `maxCharacters` caps the characters coloured per block, set from the slowest
 * measured content of the grammar (microseconds per character, ordinary and dense code) so that the
 * coloured part costs about 250 ms: TypeScript family 4.5 us/char, C++ 12, YAML 2.9, JSON 0.4.
 *
 * Both limits end the same way: a block is coloured up to the first line that would pass either,
 * and that line and the rest are drawn plain.
 */
const FREE_RUN_LENGTH = 32;
const FREE_LINE_LENGTH = 256;
const BLANK_COST_DIVISOR = 2;
const LINE_COST_DIVISOR = 16;

interface CostProfile {
  /** Units of cost, roughly 50 ms of tokenizing on the grammar's slowest shape. */
  readonly budget: number;
  /** Characters of source, line breaks included, that may be coloured: about 250 ms. */
  readonly maxCharacters: number;
  readonly countsWordRuns: boolean;
  readonly countsLineLength: boolean;
}

/** TypeScript family and C#: 300,000 units is about 46 ms of the slowest shape. */
const SCRIPT_PROFILE: CostProfile = {
  budget: 300_000,
  maxCharacters: 55_000,
  countsWordRuns: true,
  countsLineLength: false,
};
/** C++ is about twice as slow per unit and drops sharply past 400 characters. */
const CPP_PROFILE: CostProfile = {
  budget: 170_000,
  maxCharacters: 20_000,
  countsWordRuns: true,
  countsLineLength: false,
};
/** YAML and Java: the line is the unit, so a word inside it is not charged twice. */
const LINE_PROFILE: CostProfile = {
  budget: 300_000,
  maxCharacters: 80_000,
  countsWordRuns: false,
  countsLineLength: true,
};
/** Most other grammars measured at least 8x cheaper per unit, and linear in line length. */
const DEFAULT_PROFILE: CostProfile = {
  budget: 2_400_000,
  maxCharacters: 70_000,
  countsWordRuns: true,
  countsLineLength: false,
};
/** JSON and XML: 0.2 to 0.4 us/char, even minified. */
const CHEAP_PROFILE: CostProfile = {
  budget: 2_400_000,
  maxCharacters: 600_000,
  countsWordRuns: true,
  countsLineLength: false,
};

const OWN_PROFILES: Partial<Record<ShikiLanguageId, CostProfile>> = {
  cpp: CPP_PROFILE,
  csharp: SCRIPT_PROFILE,
  javascript: SCRIPT_PROFILE,
  jsx: SCRIPT_PROFILE,
  tsx: SCRIPT_PROFILE,
  typescript: SCRIPT_PROFILE,
  java: LINE_PROFILE,
  yaml: LINE_PROFILE,
  json: CHEAP_PROFILE,
  xml: CHEAP_PROFILE,
};

/**
 * The shipped grammars each grammar loads with it or can switch into, from the `@shikijs/langs`
 * registrations (the grammars they list as embedded, and for markdown the fence languages).
 * A block of one of these runs the others' rules, so it is limited by the strictest of them: a
 * 1,540-character word in a `ts` fence inside markdown took 921 ms. A test re-derives this
 * table from the installed registry, so a Shiki update or a new language fails there.
 */
export const EMBEDDED_LANGUAGES: Partial<Record<ShikiLanguageId, readonly ShikiLanguageId[]>> = {
  cpp: ['c'],
  html: ['css', 'javascript'],
  markdown: [
    'bash',
    'c',
    'cpp',
    'csharp',
    'css',
    'go',
    'html',
    'java',
    'javascript',
    'json',
    'php',
    'powershell',
    'python',
    'ruby',
    'rust',
    'sql',
    'swift',
    'tsx',
    'typescript',
    'xml',
    'yaml',
  ],
  php: ['css', 'html', 'java', 'javascript', 'json', 'sql', 'xml'],
  ruby: [
    'bash',
    'c',
    'cpp',
    'css',
    'html',
    'java',
    'javascript',
    'jsx',
    'markdown',
    'sql',
    'tsx',
    'typescript',
    'xml',
    'yaml',
  ],
  xml: ['java'],
};

const resolvedProfiles = new Map<ShikiLanguageId, CostProfile>();

/** The strictest of a grammar's own profile and those of every grammar it embeds, directly or not. */
function profileOf(language: ShikiLanguageId): CostProfile {
  const known = resolvedProfiles.get(language);
  if (known) return known;

  const seen = new Set<ShikiLanguageId>();
  const pending: ShikiLanguageId[] = [language];
  let profile = OWN_PROFILES[language] ?? DEFAULT_PROFILE;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    pending.push(...(EMBEDDED_LANGUAGES[next] ?? []));
    profile = strictest(profile, OWN_PROFILES[next] ?? DEFAULT_PROFILE);
  }
  resolvedProfiles.set(language, profile);
  return profile;
}

function strictest(left: CostProfile, right: CostProfile): CostProfile {
  return {
    budget: Math.min(left.budget, right.budget),
    maxCharacters: Math.min(left.maxCharacters, right.maxCharacters),
    countsWordRuns: left.countsWordRuns || right.countsWordRuns,
    countsLineLength: left.countsLineLength || right.countsLineLength,
  };
}

/**
 * Returns how many leading lines of `source` fit in the highlight budget: all of them when the
 * whole block does. One linear pass, no regular expression, and it stops at the first line
 * that would exceed a limit. Lines split exactly as Shiki's `splitLines` splits them, on `\n`
 * and `\r\n` only: a lone `\r`, U+2028, a form feed or a vertical tab stay inside their line,
 * because the tokenizer is handed that whole line.
 * Example: countHighlightableLines(`a\n${'x'.repeat(5000)}`, 'typescript') === 1.
 */
export function countHighlightableLines(source: string, language: ShikiLanguageId): number {
  const profile = profileOf(language);
  let spent = 0; // Finished lines.
  let spentCharacters = 0; // Finished lines, line breaks included.
  let lineSpent = 0; // Finished runs of the current line.
  let lineLength = 0;
  let wordLength = 0;
  let blankLength = 0;
  let lineIndex = 0;

  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (code === 13 && source.charCodeAt(index + 1) === 10) continue; // Half of a `\r\n` break.
    if (code === 10) {
      spent +=
        lineSpent + runsCost(wordLength, blankLength, profile) + lineCost(lineLength, profile);
      spentCharacters += lineLength + 1;
      lineSpent = 0;
      lineLength = 0;
      wordLength = 0;
      blankLength = 0;
      lineIndex++;
      continue;
    }

    lineLength++;
    if (isWordCode(code)) {
      wordLength++;
      lineSpent += runsCost(0, blankLength, profile);
      blankLength = 0;
    } else if (code === 32 || code === 9) {
      blankLength++;
      lineSpent += runsCost(wordLength, 0, profile);
      wordLength = 0;
    } else {
      lineSpent += runsCost(wordLength, blankLength, profile);
      wordLength = 0;
      blankLength = 0;
    }

    if (spentCharacters + lineLength > profile.maxCharacters) return lineIndex;
    if (
      wordLength > FREE_RUN_LENGTH ||
      blankLength > FREE_RUN_LENGTH ||
      lineLength > FREE_LINE_LENGTH
    ) {
      const pending =
        lineSpent + runsCost(wordLength, blankLength, profile) + lineCost(lineLength, profile);
      if (spent + pending > profile.budget) return lineIndex;
    }
  }
  return lineIndex + 1;
}

/** The cost of the word run and the blank run in progress; at most one of them is non-zero. */
function runsCost(wordLength: number, blankLength: number, profile: CostProfile): number {
  const word = profile.countsWordRuns && wordLength > FREE_RUN_LENGTH ? wordLength * wordLength : 0;
  const blank =
    blankLength > FREE_RUN_LENGTH ? (blankLength * blankLength) / BLANK_COST_DIVISOR : 0;
  return word + blank;
}

function lineCost(length: number, profile: CostProfile): number {
  if (!profile.countsLineLength || length <= FREE_LINE_LENGTH) return 0;
  return (length * length) / LINE_COST_DIVISOR;
}

/** Letters, digits, `_`, `$`, `.`, `?`; anything outside ASCII counts, because grammars match Unicode letters. */
function isWordCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36 ||
    code === 46 ||
    code === 63 ||
    code > 127
  );
}
