import type { ShikiLanguageId } from '@/lib/code-languages';

/**
 * How much of a code block the highlighter may tokenize before the rest is drawn plain.
 *
 * Some TextMate grammars match one long token with lookaheads that rescan it, so tokenizing
 * time grows with the square of its length and cannot be interrupted. Measured on Shiki 4.6.0,
 * three shapes are quadratic:
 *
 * - a word run: letters, digits, `_`, `$`, any non-ASCII character, and `.` or `?`, because
 *   `a.b.c` and `a?.b` chain like one word (an identifier, a hex digest, a JWT in a string, a
 *   dotted path, a word in a comment). In the TypeScript family a run costs about 1.5e-4 ms per
 *   square character: 512 characters take 40 ms, 4,096 take 1.7 s. C++ is twice as slow.
 * - a run of spaces or tabs, about 0.4x a word run.
 * - on YAML and Java, the line itself, whatever it holds: about 1e-5 ms per square character.
 *
 * Everything else is linear: punctuation, `/`, `-`, `+` and `=` end a run, so a long URL, a
 * path, minified code or a regular expression costs nothing extra, and an 8 KB URL is fine.
 *
 * Costs add up across lines (twenty 190-character words: 116 ms in TypeScript), so the scan sums
 * a cost per block and a block is highlighted up to the first line that would push the sum past
 * the budget. A run shorter than `FREE_RUN_LENGTH` (and a line shorter than `FREE_LINE_LENGTH`)
 * costs nothing, so ordinary code never spends any of the budget.
 */
const FREE_RUN_LENGTH = 48;
const FREE_LINE_LENGTH = 256;
const BLANK_COST_DIVISOR = 2;
const LINE_COST_DIVISOR = 16;

interface CostProfile {
  /** Units of cost, roughly 50 ms of tokenizing on the grammar's slowest shape. */
  readonly budget: number;
  readonly countsWordRuns: boolean;
  readonly countsLineLength: boolean;
}

/** TypeScript family and C#: 300,000 units is about 46 ms of the slowest shape. */
const SCRIPT_PROFILE: CostProfile = {
  budget: 300_000,
  countsWordRuns: true,
  countsLineLength: false,
};
/** C++ is about twice as slow per unit and drops sharply past 400 characters. */
const CPP_PROFILE: CostProfile = { budget: 170_000, countsWordRuns: true, countsLineLength: false };
/** YAML and Java: the line is the unit, so a word inside it is not charged twice. */
const LINE_PROFILE: CostProfile = {
  budget: 300_000,
  countsWordRuns: false,
  countsLineLength: true,
};
/** Every other grammar measured at least 8x cheaper per unit, and linear in line length. */
const DEFAULT_PROFILE: CostProfile = {
  budget: 2_400_000,
  countsWordRuns: true,
  countsLineLength: false,
};

const PROFILES: Partial<Record<ShikiLanguageId, CostProfile>> = {
  cpp: CPP_PROFILE,
  csharp: SCRIPT_PROFILE,
  javascript: SCRIPT_PROFILE,
  jsx: SCRIPT_PROFILE,
  tsx: SCRIPT_PROFILE,
  typescript: SCRIPT_PROFILE,
  java: LINE_PROFILE,
  yaml: LINE_PROFILE,
};

/**
 * Returns how many leading lines of `source` fit in the highlight budget: all of them when the
 * whole block does. One linear pass, no regular expression, and it stops at the first line
 * that would exceed the budget. Lines split on `\n`, `\r\n` and `\r`, as Shiki splits them.
 * Example: countHighlightableLines(`a\n${'x'.repeat(5000)}`, 'typescript') === 1.
 */
export function countHighlightableLines(source: string, language: ShikiLanguageId): number {
  const profile = PROFILES[language] ?? DEFAULT_PROFILE;
  let spent = 0; // Finished lines.
  let lineSpent = 0; // Finished runs of the current line.
  let lineLength = 0;
  let wordLength = 0;
  let blankLength = 0;
  let lineIndex = 0;

  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (code === 10 || code === 13) {
      spent +=
        lineSpent + runsCost(wordLength, blankLength, profile) + lineCost(lineLength, profile);
      lineSpent = 0;
      lineLength = 0;
      wordLength = 0;
      blankLength = 0;
      lineIndex++;
      if (code === 13 && source.charCodeAt(index + 1) === 10) index++;
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
