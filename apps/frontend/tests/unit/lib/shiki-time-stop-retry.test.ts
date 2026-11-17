import { afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';

import {
  highlightCode,
  highlightLineTokens,
  initHighlighter,
  isHighlightRetryPending,
  isLineHighlightRetryPending,
  observeTokenizedLines,
  preloadCodeLanguages,
} from '@/lib/shiki';

import {
  frozenTokenizerClock,
  StoppingTokenizerClock,
  withTokenizerClock,
} from '../../support/mocks/fake-tokenizer-clock';

const THEME = 'one-dark-pro';
const LANGUAGE = 'ts';

let highlighter: Awaited<ReturnType<typeof initHighlighter>>;
let restore: (() => void) | undefined;

beforeAll(async () => {
  await preloadCodeLanguages([LANGUAGE], THEME);
  highlighter = await initHighlighter();
});

afterEach(() => {
  restore?.();
  restore = undefined;
});

/** Counts the lines handed to a grammar: one per tokenize attempt of a one-line block. */
class TokenizeAttempts {
  count = 0;
  readonly observe = (): void => {
    this.count++;
  };
}

function countTokenizeAttempts(): TokenizeAttempts {
  const attempts = new TokenizeAttempts();
  observeTokenizedLines(attempts.observe);
  restore = () => observeTokenizedLines(null);
  return attempts;
}

function stoppedBlock(source: string): string | null {
  return withTokenizerClock(new StoppingTokenizerClock().now, () =>
    highlightCode(source, LANGUAGE, THEME)
  );
}

function settledBlock(source: string): string | null {
  return withTokenizerClock(frozenTokenizerClock, () => highlightCode(source, LANGUAGE, THEME));
}

function stoppedLine(source: string): ReturnType<typeof highlightLineTokens> {
  return withTokenizerClock(new StoppingTokenizerClock().now, () =>
    highlightLineTokens(source, LANGUAGE, THEME)
  );
}

function settledLine(source: string): ReturnType<typeof highlightLineTokens> {
  return withTokenizerClock(frozenTokenizerClock, () =>
    highlightLineTokens(source, LANGUAGE, THEME)
  );
}

describe('a block the tokenizer stopped on its time limit', () => {
  it('is pending after the first stop and coloured when asked for again within the limit', () => {
    const source = 'const retriedAfterStop = 1;';
    expect(stoppedBlock(source), 'html of the stopped first attempt').toBeNull();
    expect(isHighlightRetryPending(source, LANGUAGE, THEME), 'retry pending after one stop').toBe(
      true
    );

    const html = settledBlock(source);
    expect(html, 'html of the retry, expected a Shiki block').toContain('class="shiki');
    expect(isHighlightRetryPending(source, LANGUAGE, THEME), 'retry pending after recovery').toBe(
      false
    );
  });

  it('is not tokenized a third time once the retry stops too', () => {
    const attempts = countTokenizeAttempts();
    const source = 'const stoppedTwice = 2;';
    expect(stoppedBlock(source)).toBeNull();
    expect(stoppedBlock(source), 'html of the stopped retry').toBeNull();
    expect(isHighlightRetryPending(source, LANGUAGE, THEME), 'retry pending after two stops').toBe(
      false
    );
    expect(attempts.count, 'tokenize attempts after two stops').toBe(2);

    // Even with a clock that would let it finish, the block is refused without a grammar call.
    expect(settledBlock(source), 'html of a third attempt').toBeNull();
    expect(attempts.count, 'tokenize attempts after a third call').toBe(2);
  });

  it('keeps its stop state per block', () => {
    const stopped = 'const onlyThisStops = 3;';
    const other = 'const neverStopped = 4;';
    stoppedBlock(stopped);
    expect(settledBlock(other)).toContain('class="shiki');
    expect(isHighlightRetryPending(stopped, LANGUAGE, THEME), 'stopped block pending').toBe(true);
    expect(isHighlightRetryPending(other, LANGUAGE, THEME), 'other block pending').toBe(false);
  });

  it('is not pending for a language the highlighter cannot draw', () => {
    expect(isHighlightRetryPending('x', 'not-a-real-language', THEME)).toBe(false);
  });
});

describe('a block that is not a time-limit stop', () => {
  it('is not pending when the size limit refuses it before tokenizing', () => {
    const attempts = countTokenizeAttempts();
    const source = `const refused = "${'x'.repeat(16_384)}";`;
    expect(settledBlock(source), 'html of an over-limit block').toBeNull();
    expect(attempts.count, 'tokenize attempts for an over-limit block').toBe(0);
    expect(isHighlightRetryPending(source, LANGUAGE, THEME), 'retry pending for a refusal').toBe(
      false
    );
  });

  it('is not pending when the engine fails for another reason', () => {
    const grammar = highlighter.getLanguage('typescript');
    const failing = spyOn(grammar, 'tokenizeLine2').mockImplementationOnce(failTokenization);
    restore = () => failing.mockRestore();
    const source = 'const engineFailure = 5;';
    expect(settledBlock(source)).toBeNull();
    expect(isHighlightRetryPending(source, LANGUAGE, THEME), 'retry pending after a throw').toBe(
      false
    );
  });
});

describe('a diff line the tokenizer stopped on its time limit', () => {
  it('is pending after the first stop and coloured when asked for again', () => {
    const line = 'const retriedLine = 6;';
    expect(stoppedLine(line), 'tokens of the stopped first attempt').toBeNull();
    expect(isLineHighlightRetryPending(line, LANGUAGE, THEME), 'line pending after a stop').toBe(
      true
    );
    expect(settledLine(line)?.length, 'tokens of the retry').toBeGreaterThan(1);
    expect(isLineHighlightRetryPending(line, LANGUAGE, THEME), 'line pending after recovery').toBe(
      false
    );
  });

  it('is not tokenized a third time once the retry stops too', () => {
    const attempts = countTokenizeAttempts();
    const line = 'const lineStoppedTwice = 7;';
    stoppedLine(line);
    stoppedLine(line);
    expect(isLineHighlightRetryPending(line, LANGUAGE, THEME), 'line pending after two stops').toBe(
      false
    );
    expect(settledLine(line), 'tokens of a third attempt').toBeNull();
    expect(attempts.count, 'tokenize attempts after three calls').toBe(2);
  });
});

function failTokenization(): never {
  throw new Error('Synthetic regex-engine failure');
}
