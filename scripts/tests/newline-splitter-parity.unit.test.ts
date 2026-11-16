import { describe, expect, it } from 'bun:test';

import { DelimitedTextSplitter } from '@mangostudio/shared/utils/delimited-text-splitter';

import { NewlineSplitter } from '../lib/newline-splitter';
import { expected, feed, oracleCases } from './support/newline-oracle';

// `NewlineSplitter` is a copy of `DelimitedTextSplitter` for the one delimiter
// the scripts use (see the header of scripts/lib/newline-splitter.ts for why it
// is a copy). One oracle, run against both, is what stops them drifting.
function sharedSplitterFor(options: {
  readonly maxLineLength: number;
  readonly onOverflow: 'truncate' | 'refuse';
}): DelimitedTextSplitter {
  return new DelimitedTextSplitter('\n', {
    maxRecordLength: options.maxLineLength,
    onOverflow: options.onOverflow,
  });
}

describe('NewlineSplitter and DelimitedTextSplitter with a newline delimiter', () => {
  it('report what the oracle reports, for the same random streams and chunkings', () => {
    for (const { seed, stream, pushes, options } of oracleCases(600)) {
      const copy = feed(new NewlineSplitter(options), pushes);
      const shared = feed(sharedSplitterFor(options), pushes);

      expect({ seed, options, pushes, copy, shared }).toEqual({
        seed,
        options,
        pushes,
        copy: expected(stream, pushes, options),
        shared: expected(stream, pushes, options),
      });
    }
  });
});
