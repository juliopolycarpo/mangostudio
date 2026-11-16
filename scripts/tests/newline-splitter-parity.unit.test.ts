import { describe, expect, it } from 'bun:test';

import { DelimitedTextSplitter } from '@mangostudio/shared/utils/delimited-text-splitter';

import { NewlineSplitter } from '../lib/newline-splitter';
import { expected, feed, oracleCases, type RefusalTiming } from './support/newline-oracle';

// `NewlineSplitter` is a copy of `DelimitedTextSplitter` for the one delimiter
// the scripts use (see the header of scripts/lib/newline-splitter.ts for why it
// is a copy). One oracle, run against both, is what stops them drifting.
//
// The only intended difference: a read that completes lines and then overflows
// returns the lines first in the copy, and raises at once, losing them, in the
// shared splitter. When the shared splitter changes to match, change this to
// 'deferred' and drop the exception from the header of the copy.
const SHARED_REFUSAL: RefusalTiming = 'immediate';

describe('NewlineSplitter and DelimitedTextSplitter with a newline delimiter', () => {
  it('report what the oracle reports, for the same random streams and chunkings', () => {
    for (const { seed, stream, pushes, options } of oracleCases(600)) {
      const copy = feed(new NewlineSplitter(options), pushes);
      const shared = feed(
        new DelimitedTextSplitter('\n', {
          maxRecordLength: options.maxLineLength,
          onOverflow: options.onOverflow,
        }),
        pushes
      );

      expect({ seed, options, pushes, copy, shared }).toEqual({
        seed,
        options,
        pushes,
        copy: expected(stream, pushes, options, 'deferred'),
        shared: expected(stream, pushes, options, SHARED_REFUSAL),
      });
    }
  });

  it('agree exactly where nothing overflows or the cap truncates', () => {
    for (const { seed, pushes, options } of oracleCases(600)) {
      if (options.onOverflow === 'refuse') continue;
      const copy = feed(new NewlineSplitter(options), pushes);
      const shared = feed(
        new DelimitedTextSplitter('\n', {
          maxRecordLength: options.maxLineLength,
          onOverflow: 'truncate',
        }),
        pushes
      );

      expect({ seed, pushes, copy }).toEqual({ seed, pushes, copy: shared });
    }
  });
});
