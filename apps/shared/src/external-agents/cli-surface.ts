/**
 * Reading a vendor CLI's own `--help` into the options it declares.
 *
 * Shared rather than runtime-owned because two workspaces have to agree about
 * it. The Claude adapter probes this surface at discovery to decide whether the
 * flags its argv names exist, and the vendor-contract capture in `scripts/`
 * records the same surface so a maintainer sees a flag disappear before a user
 * does. Two parsers would eventually disagree about the same help text, and the
 * disagreement would surface as "CI says the contract is fine, the adapter says
 * the binary is broken" — the least debuggable shape this failure has.
 *
 * `@mangostudio/shared/environments/detection` already owns the vendor version
 * banners for the same reason, so CLI output parsing living here is the
 * established seam rather than a new one.
 *
 * Browser-safe: pure string work, no Node builtins.
 */

/** The parsed surface: which long options exist, and what one of them accepts. */
export interface VendorCliSurface {
  /** Long flag names, each including its leading `--`. */
  readonly flags: ReadonlySet<string>;
  /** The choice list of whichever option the caller asked about. */
  readonly choices: ReadonlySet<string>;
}

/**
 * Commander — which Claude Code's CLI uses — indents every option two spaces
 * and wraps descriptions much further, so an option line is the only thing that
 * starts at exactly two spaces followed by a dash.
 *
 * Matching that rather than every `--token` in the text is the whole
 * correctness argument here: `--forward-subagent-text`'s own description names
 * `--output-format=stream-json`, and a parser that scanned the full text would
 * report flags the binary does not offer — which means it could never notice
 * one going away.
 */
const OPTION_LINE = /^ {2}(-\S.*)$/;
const LONG_FLAG = /--[a-zA-Z][\w-]*/g;
const CHOICES_PREFIX = '(choices:';
const QUOTED = /"([^"]+)"/g;

/**
 * The text between `(choices:` and the next `)`, scanned rather than matched.
 *
 * Deliberately not a regular expression. Every unanchored spelling of this —
 * `/\(choices:\s*([^)]*)\)/`, or the same without the `\s*` — is quadratic on
 * an input that repeats `(choices:` without ever closing it: the engine runs
 * the inner scan to the end of the string once per prefix. Two `indexOf` calls
 * do the same job in one pass and cannot backtrack at all.
 *
 * This parses a subprocess's stdout at discovery time, so "the vendor would
 * never print that" is not a property this parser gets to rely on.
 */
function choiceListIn(block: string): string | undefined {
  const start = block.indexOf(CHOICES_PREFIX);
  if (start < 0) return undefined;
  const end = block.indexOf(')', start + CHOICES_PREFIX.length);
  return end < 0 ? undefined : block.slice(start + CHOICES_PREFIX.length, end);
}

/** The flag names declared on one option line, ignoring its description. */
function flagsOnLine(line: string): string[] {
  const declaration = line.split(/\s{2,}/)[0] ?? line;
  return [...declaration.matchAll(LONG_FLAG)].map((match) => match[0]);
}

/**
 * One option's own line plus the wrapped continuation beneath it.
 *
 * A choice list long enough to wrap — Claude's `--permission-mode` is — spans
 * three lines in the middle of a description, so reading only the declaring
 * line would find no choices at all.
 */
function optionBlock(lines: readonly string[], startIndex: number): string {
  const block: string[] = [lines[startIndex] ?? ''];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (OPTION_LINE.test(line)) break;
    // A blank line ends the Options section, and with it this option.
    if (line.trim().length === 0) break;
    block.push(line.trim());
  }
  return block.join(' ');
}

/** Every option the text declares, in order, with the flags on its own line. */
function* declaredOptions(
  lines: readonly string[]
): Generator<{ readonly index: number; readonly declared: readonly string[] }> {
  for (const [index, line] of lines.entries()) {
    const option = OPTION_LINE.exec(line);
    if (!option) continue;
    yield { index, declared: flagsOnLine(option[1] ?? '') };
  }
}

/**
 * Parses help text into its declared long flags, plus the choice list of
 * `choicesFor` when that option declares one.
 *
 * Unknown extra options are simply collected. Nothing here decides whether a
 * surface is acceptable — that is policy, and it belongs with the adapter that
 * knows which flags it passes.
 */
export function parseVendorCliSurface(help: string, choicesFor?: string): VendorCliSurface {
  const lines = help.split(/\r?\n/);
  const flags = new Set<string>();
  const choices = new Set<string>();

  for (const { index, declared } of declaredOptions(lines)) {
    for (const flag of declared) flags.add(flag);
    if (choicesFor === undefined || !declared.includes(choicesFor)) continue;
    const list = choiceListIn(optionBlock(lines, index));
    if (list === undefined) continue;
    for (const quoted of list.matchAll(QUOTED)) {
      if (quoted[1]) choices.add(quoted[1]);
    }
  }

  return { flags, choices };
}

/**
 * One declared option's own text — its line plus the continuations beneath it.
 *
 * `(choices: …)` is the only machine-readable thing commander prints, and a
 * vendor that documents a vocabulary in prose instead leaves a caller nothing
 * to read but the sentence. This hands back that sentence, assembled the same
 * way `parseVendorCliSurface` assembles the one it scans for choices, so the
 * two can never disagree about where an option's text ends.
 *
 * Deliberately no parsing beyond that. What a particular vendor's prose means
 * is that vendor's problem, and encoding one CLI's phrasing here would make
 * every other CLI's rewording look like a bug in this module.
 *
 * `undefined` means the option is not declared. Crucially that is *not* the
 * same as "the text never mentions it": a flag named inside a neighbour's
 * description is not declared, and answering with the neighbour's block would
 * invent a surface the binary does not have.
 *
 * @example
 * vendorCliOptionBlock(help, '--effort');
 * // '  --effort <level>   Effort level for the current session (low, medium, high)'
 */
export function vendorCliOptionBlock(help: string, flag: string): string | undefined {
  const lines = help.split(/\r?\n/);
  for (const { index, declared } of declaredOptions(lines)) {
    if (declared.includes(flag)) return optionBlock(lines, index);
  }
  return undefined;
}
