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

/**
 * Every `( … )` group in a block, in order, without its delimiters.
 *
 * Scanned rather than matched, for the reason `choiceListIn` gives above:
 * every unanchored regular expression for this is quadratic on an input that
 * opens a group it never closes.
 */
function* parenGroups(block: string): Generator<string> {
  let cursor = 0;
  while (cursor < block.length) {
    const open = block.indexOf('(', cursor);
    if (open < 0) return;
    const close = block.indexOf(')', open + 1);
    if (close < 0) return;
    yield block.slice(open + 1, close);
    cursor = close + 1;
  }
}

/** A single bare lowercase identifier, anchored so it cannot backtrack. */
const BARE_IDENTIFIER = /^[a-z][a-z0-9-]*$/;

/** The group's contents as a comma-separated identifier list, or nothing. */
function bareIdentifierList(group: string): readonly string[] {
  const parts = group.split(',').map((part) => part.trim());
  return parts.length > 1 && parts.every((part) => BARE_IDENTIFIER.test(part)) ? parts : [];
}

/**
 * An option's vocabulary when it is printed as a bare list rather than as
 * commander's own `(choices: …)`.
 *
 * `(low, medium, high, xhigh, max)` is a real thing a commander CLI prints for
 * an option commander does not know the choices of, and it is invisible to
 * `parseVendorCliSurface`. The first group whose contents are a comma-separated
 * run of bare identifiers wins, which rejects `(only works with --print …)` and
 * `(choices: "host", "none")` by the same rule rather than by special-casing
 * either.
 *
 * `undefined` means the option is not declared or states no such list — never
 * an empty set, so a caller can tell "this build says nothing" from "this build
 * accepts nothing".
 *
 * @example
 * vendorCliBareChoiceList(help, '--effort'); // Set { 'low', 'medium', 'high' }
 */
export function vendorCliBareChoiceList(
  help: string,
  flag: string
): ReadonlySet<string> | undefined {
  const block = vendorCliOptionBlock(help, flag);
  if (block === undefined) return undefined;
  for (const group of parenGroups(block)) {
    const values = bareIdentifierList(group);
    if (values.length > 0) return new Set(values);
  }
  return undefined;
}

/** Marks the group that holds a vendor's own examples. */
const EXAMPLE_PREFIX = 'e.g.';
/** A quoted example: bare, so a quote opened by an apostrophe cannot close on one. */
const QUOTED_EXAMPLE = /'([a-z][a-z0-9.-]*)'/g;

/**
 * The quoted values in an option's **first** `(e.g. …)` group.
 *
 * Bounded to one group, and that bound is the whole correctness argument:
 *
 * - Prose around these lists contains apostrophes ("a model's full name"). A
 *   scan for quoted tokens across the block opens a quote on the apostrophe and
 *   closes it on the next one, inventing a value out of the words in between.
 * - A description with two example groups is describing two *different* things.
 *   Claude's `--model` names its aliases in the first and one full model name in
 *   the second; merging them advertises a specific model as though it were an
 *   alias the vendor promises to resolve.
 *
 * `undefined` for an option that is absent or states no examples, with the same
 * absent-is-not-empty rule as `vendorCliBareChoiceList`.
 *
 * @example
 * vendorCliQuotedExamples(help, '--model'); // Set { 'fable', 'opus', 'sonnet' }
 */
export function vendorCliQuotedExamples(
  help: string,
  flag: string
): ReadonlySet<string> | undefined {
  const block = vendorCliOptionBlock(help, flag);
  if (block === undefined) return undefined;
  for (const group of parenGroups(block)) {
    if (!group.trimStart().startsWith(EXAMPLE_PREFIX)) continue;
    const examples = [...group.matchAll(QUOTED_EXAMPLE)].map(([, value]) => value ?? '');
    return examples.length > 0 ? new Set(examples) : undefined;
  }
  return undefined;
}
