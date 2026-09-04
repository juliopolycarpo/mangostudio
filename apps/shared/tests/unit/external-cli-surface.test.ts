import { describe, expect, it } from 'bun:test';

import {
  parseVendorCliSurface,
  vendorCliBareChoiceList,
  vendorCliOptionBlock,
  vendorCliQuotedExamples,
} from '../../src/external-agents';

/**
 * Commander's own wrapping, reproduced rather than tidied.
 *
 * The two hard cases are both here: a description that names a flag it does
 * not declare (`--forward-subagent-text` mentions `--output-format`), and a
 * description that wraps across four lines mid-sentence (`--model`). A fixture
 * with one option per line would pass a parser that cannot read real output.
 */
const HELP = `Usage: vendor [options]

Options:
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --forward-subagent-text               Forward subagent text (only works with
                                        --print and --output-format=stream-json)
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "manual", "plan")

Commands:
  auth <subcommand>                     Manage authentication
`;

describe('vendorCliOptionBlock', () => {
  it('assembles an option line with the continuations wrapped beneath it', () => {
    expect(vendorCliOptionBlock(HELP, '--model')).toBe(
      "  --model <model>                       Model for the current session. Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5')."
    );
  });

  it('stops at the next option rather than swallowing it', () => {
    const block = vendorCliOptionBlock(HELP, '--effort');
    expect(block).toContain('(low, medium, high, xhigh, max)');
    expect(block).not.toContain('--forward-subagent-text');
  });

  it('reads only declared options, never a flag named inside a description', () => {
    // `--output-format` appears in `--forward-subagent-text`'s prose and is
    // declared nowhere. A parser that scanned the whole text would answer with
    // the neighbouring block and quietly invent a surface the binary lacks.
    expect(vendorCliOptionBlock(HELP, '--output-format')).toBeUndefined();
  });

  it('answers undefined for an option this build does not declare', () => {
    expect(vendorCliOptionBlock(HELP, '--permission-prompts')).toBeUndefined();
  });

  it('agrees with the flag set the surface parser reports', () => {
    const surface = parseVendorCliSurface(HELP, '--permission-mode');
    for (const flag of surface.flags) {
      expect(vendorCliOptionBlock(HELP, flag)).toBeDefined();
    }
    expect(surface.choices).toEqual(new Set(['acceptEdits', 'auto', 'manual', 'plan']));
  });
});

describe('vendorCliBareChoiceList', () => {
  it('reads a vocabulary printed as a bare parenthesised list', () => {
    expect(vendorCliBareChoiceList(HELP, '--effort')).toEqual(
      new Set(['low', 'medium', 'high', 'xhigh', 'max'])
    );
  });

  it('rejects a parenthesised sentence that is not a list', () => {
    // `--forward-subagent-text`'s only group is "(only works with --print and
    // --output-format=stream-json)", which is prose, not a vocabulary.
    expect(vendorCliBareChoiceList(HELP, '--forward-subagent-text')).toBeUndefined();
  });

  it("does not read commander's own quoted choice list as a bare one", () => {
    // The two shapes must stay distinguishable: `parseVendorCliSurface` owns
    // `(choices: …)`, and a reader that also claimed it would report the same
    // vocabulary twice in two spellings.
    expect(vendorCliBareChoiceList(HELP, '--permission-mode')).toBeUndefined();
  });

  it('answers undefined for an undeclared option', () => {
    expect(vendorCliBareChoiceList(HELP, '--permission-prompts')).toBeUndefined();
  });
});

describe('vendorCliQuotedExamples', () => {
  it('reads the quoted values from the first example group', () => {
    expect(vendorCliQuotedExamples(HELP, '--model')).toEqual(new Set(['fable', 'opus', 'sonnet']));
  });

  it('does not close a quote opened by the apostrophe in "model\'s"', () => {
    // The failure this pins is specific: a block-wide scan yields
    // `s full name (e.g. ` as a value, which reads as a plausible id and would
    // travel all the way to the vendor's own command line.
    for (const value of vendorCliQuotedExamples(HELP, '--model') ?? []) {
      expect(value).not.toContain(' ');
    }
  });

  it('stops at the first example group rather than merging the second', () => {
    // The second group is an example of a *full model name*. Merging the two
    // advertises `claude-fable-5` as though the vendor promised to resolve it.
    expect(vendorCliQuotedExamples(HELP, '--model')?.has('claude-fable-5')).toBe(false);
  });

  it('answers undefined for an option that states no examples', () => {
    expect(vendorCliQuotedExamples(HELP, '--effort')).toBeUndefined();
  });
});
