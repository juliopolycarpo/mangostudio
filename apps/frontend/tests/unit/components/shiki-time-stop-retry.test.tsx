import { afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';

import type { GitDiffResponse } from '@mangostudio/shared/git';

import { initHighlighter, preloadCodeLanguages } from '@/lib/shiki';

import { flushAsyncRender, render } from '../../support/harness/render';
import { FakeIdleScheduler } from '../../support/mocks/fake-idle-scheduler';
import { frozenTokenizerClock, withTokenizerClock } from '../../support/mocks/fake-tokenizer-clock';

const git = { diff: undefined as GitDiffResponse | undefined };

function useFakeGitDiff() {
  return { data: git.diff, isLoading: false, error: null };
}

void mock.module('../../../src/features/workspace/hooks/use-git-state', () => ({
  useGitDiff: useFakeGitDiff,
}));

const { MarkdownContentRenderer } = await import('../../../src/components/MarkdownContentRenderer');
const { DiffViewer } = await import('../../../src/features/workspace/DiffViewer');

const THEME = 'one-dark-pro';

let highlighter: Awaited<ReturnType<typeof initHighlighter>>;
let restore: (() => void) | undefined;
let idle: FakeIdleScheduler | undefined;

beforeAll(async () => {
  await preloadCodeLanguages(['ts'], THEME);
  highlighter = await initHighlighter();
  // Rules compiled under a frozen clock, so only the fake below decides what stops.
  withTokenizerClock(frozenTokenizerClock, () => {
    highlighter.codeToHtml('const value = 42;', { lang: 'typescript', theme: THEME });
  });
});

afterEach(() => {
  restore?.();
  restore = undefined;
  idle?.restore();
  idle = undefined;
});

/**
 * Reports `stoppedEarly` for the first `stops` tokenizer calls and lets the rest finish: a
 * cold grammar that stops the block that pays for its compile and not the ones after it.
 */
class ColdGrammar {
  calls = 0;

  constructor(private readonly stops: number) {}

  install(): this {
    const grammar = highlighter.getLanguage('typescript');
    const original = grammar.tokenizeLine2;
    const tokenizer = spyOn(grammar, 'tokenizeLine2').mockImplementation(
      (...args: Parameters<typeof original>) => {
        this.calls++;
        return { ...original.apply(grammar, args), stoppedEarly: this.calls <= this.stops };
      }
    );
    restore = () => tokenizer.mockRestore();
    return this;
  }
}

function installIdleScheduler(): FakeIdleScheduler {
  idle = new FakeIdleScheduler().install();
  return idle;
}

function fence(source: string): string {
  return `\`\`\`typescript\n${source}\n\`\`\``;
}

function fencedBlock(container: HTMLElement): Element | null {
  return container.querySelector('pre[data-lang="typescript"]');
}

function showDiff(source: string) {
  git.diff = { path: 'retry.ts', binary: false, diff: `@@ -0,0 +1 @@\n+${source}\n` };
  return render(
    <DiffViewer
      chatId="chat-highlight-retry"
      selection={{ path: 'retry.ts', staged: false, title: 'View diff for retry.ts' }}
      onClose={mock()}
    />
  );
}

/** Lets the highlighter load and the first draw, stop included, happen. */
async function settleFirstDraw(): Promise<void> {
  await flushAsyncRender();
  await flushAsyncRender();
}

describe('a code block stopped by a cold grammar', () => {
  it('is coloured by one retry after yielding', async () => {
    const scheduler = installIdleScheduler();
    const grammar = new ColdGrammar(1).install();
    const { container } = render(
      <MarkdownContentRenderer content={fence('const coldFirstBlock = 1;')} />
    );
    await settleFirstDraw();

    expect(grammar.calls, 'tokenize attempts before the retry').toBe(1);
    expect(fencedBlock(container), 'block drawn after the stop').not.toHaveClass('shiki');
    expect(scheduler.pending, 'retries waiting for an idle moment').toBe(1);

    await scheduler.runIdle();
    expect(grammar.calls, 'tokenize attempts after the retry').toBe(2);
    expect(fencedBlock(container), 'block drawn after the retry').toHaveClass('shiki');
    expect(scheduler.pending, 'retries left after the block was coloured').toBe(0);
  });

  it('stays plain, and is not tried a third time, when the retry stops too', async () => {
    const scheduler = installIdleScheduler();
    const grammar = new ColdGrammar(2).install();
    const { container } = render(
      <MarkdownContentRenderer content={fence('const pathologicalBlock = 2;')} />
    );
    await settleFirstDraw();
    await scheduler.runIdle();
    await settleFirstDraw();

    expect(grammar.calls, 'tokenize attempts for a block that stops twice').toBe(2);
    expect(fencedBlock(container), 'block drawn after two stops').not.toHaveClass('shiki');
    expect(container.querySelector('code')?.textContent).toBe('const pathologicalBlock = 2;');
    expect(scheduler.pending, 'retries scheduled after the second stop').toBe(0);
  });

  it('cancels the pending retry on unmount', async () => {
    const scheduler = installIdleScheduler();
    const grammar = new ColdGrammar(1).install();
    const { unmount } = render(
      <MarkdownContentRenderer content={fence('const unmountedBlock = 3;')} />
    );
    await settleFirstDraw();
    expect(scheduler.pending, 'retries pending before unmount').toBe(1);

    unmount();
    expect(scheduler.pending, 'retries pending after unmount').toBe(0);
    await scheduler.runIdle();
    expect(grammar.calls, 'tokenize attempts after unmount').toBe(1);
  });

  it('cancels the pending retry when the content changes', async () => {
    const scheduler = installIdleScheduler();
    const grammar = new ColdGrammar(1).install();
    const { container, rerender } = render(
      <MarkdownContentRenderer content={fence('const replacedBlock = 4;')} />
    );
    await settleFirstDraw();
    expect(scheduler.pending, 'retries pending before the change').toBe(1);

    rerender(<MarkdownContentRenderer content={fence('const replacement = 5;')} />);
    await settleFirstDraw();
    expect(grammar.calls, 'tokenize attempts for the old and the new content').toBe(2);
    expect(scheduler.pending, 'retries pending for content that finished').toBe(0);
    expect(fencedBlock(container), 'replacement block').toHaveClass('shiki');
  });

  it('does not retry while the message is streaming, and does once it ends', async () => {
    const scheduler = installIdleScheduler();
    const grammar = new ColdGrammar(1).install();
    const content = fence('const streamedBlock = 6;');
    const { container, rerender } = render(
      <MarkdownContentRenderer content={content} isStreaming />
    );
    await settleFirstDraw();
    expect(scheduler.pending, 'retries scheduled while streaming').toBe(0);
    expect(fencedBlock(container)).not.toHaveClass('shiki');

    rerender(<MarkdownContentRenderer content={content} isStreaming={false} />);
    await settleFirstDraw();
    expect(scheduler.pending, 'retries scheduled after the stream ended').toBe(1);
    await scheduler.runIdle();
    expect(grammar.calls).toBe(2);
    expect(fencedBlock(container), 'block drawn after the retry').toHaveClass('shiki');
  });

  it('does not retry a block the size limit refused', async () => {
    const scheduler = installIdleScheduler();
    const grammar = new ColdGrammar(0).install();
    const { container } = render(
      <MarkdownContentRenderer content={fence(`const refused = "${'x'.repeat(16_384)}";`)} />
    );
    await settleFirstDraw();

    expect(grammar.calls, 'tokenize attempts for an over-limit block').toBe(0);
    expect(scheduler.pending, 'retries scheduled for an over-limit block').toBe(0);
    expect(fencedBlock(container)).not.toHaveClass('shiki');
  });
});

describe('a diff line stopped by a cold grammar', () => {
  it('is coloured by one retry after yielding', async () => {
    const scheduler = installIdleScheduler();
    const grammar = new ColdGrammar(1).install();
    const { container } = showDiff('const coldDiffLine = 7;');
    await settleFirstDraw();

    expect(grammar.calls, 'tokenize attempts before the retry').toBe(1);
    expect(container.querySelector('code span'), 'spans in the stopped line').toBeNull();
    expect(scheduler.pending, 'retries waiting for an idle moment').toBe(1);

    await scheduler.runIdle();
    expect(grammar.calls, 'tokenize attempts after the retry').toBeGreaterThanOrEqual(2);
    expect(
      container.querySelectorAll('code span').length,
      'token spans after the retry'
    ).toBeGreaterThan(1);
  });

  it('stays plain, and is not tried a third time, when the retry stops too', async () => {
    const scheduler = installIdleScheduler();
    const grammar = new ColdGrammar(2).install();
    const { container, unmount } = showDiff('const pathologicalDiffLine = 8;');
    await settleFirstDraw();
    await scheduler.runIdle();
    await settleFirstDraw();

    expect(grammar.calls, 'tokenize attempts for a line that stops twice').toBe(2);
    expect(container.querySelector('code span'), 'spans after two stops').toBeNull();
    expect(scheduler.pending, 'retries scheduled after the second stop').toBe(0);
    unmount();
  });

  it('cancels the pending retry on unmount', async () => {
    const scheduler = installIdleScheduler();
    const grammar = new ColdGrammar(1).install();
    const { unmount } = showDiff('const unmountedDiffLine = 9;');
    await settleFirstDraw();
    expect(scheduler.pending, 'retries pending before unmount').toBe(1);

    unmount();
    expect(scheduler.pending, 'retries pending after unmount').toBe(0);
    await scheduler.runIdle();
    expect(grammar.calls, 'tokenize attempts after unmount').toBe(1);
  });
});
