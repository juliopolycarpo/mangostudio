import { describe, expect, it } from 'bun:test';

import { parseVendorCliSurface, vendorCliOptionBlock } from '../../src/external-agents';

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
