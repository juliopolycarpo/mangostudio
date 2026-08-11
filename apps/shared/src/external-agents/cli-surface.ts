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
const CHOICES = /\(choices:\s*([^)]*)\)/;
const QUOTED = /"([^"]+)"/g;

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

  for (const [index, line] of lines.entries()) {
    const option = OPTION_LINE.exec(line);
    if (!option) continue;
    const declared = flagsOnLine(option[1] ?? '');
    for (const flag of declared) flags.add(flag);
    if (choicesFor === undefined || !declared.includes(choicesFor)) continue;
    const matched = CHOICES.exec(optionBlock(lines, index));
    if (!matched?.[1]) continue;
    for (const quoted of matched[1].matchAll(QUOTED)) {
      if (quoted[1]) choices.add(quoted[1]);
    }
  }

  return { flags, choices };
}
