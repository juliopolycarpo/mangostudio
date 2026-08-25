/**
 * The MangoStudio runner's context chip reads like the external one: a ring on
 * the strip, the figures behind it. It used to spell `context: 9.6k/1.0M` onto
 * a wrapped line while an external agent next to it drew a ring.
 */

import { describe, expect, it } from 'bun:test';
import { ContextBadge } from '@/features/chat/components/ContextBadge';
import type { ContextInfo } from '@/features/generation/types';
import { render } from '../../support/harness/render';

function info(overrides: Partial<ContextInfo> = {}): ContextInfo {
  return {
    estimatedInputTokens: 9_600,
    contextLimit: 1_000_000,
    estimatedUsageRatio: 0.0096,
    mode: 'stateful',
    severity: 'normal',
    ...overrides,
  };
}

describe('ContextBadge', () => {
  it('draws the ring from the tracker ratio rather than spelling out the figures', () => {
    const { container } = render(<ContextBadge info={info()} />);

    const indicator = container.querySelector('[data-testid="context-badge-indicator"]');
    expect(indicator?.querySelector('svg')).toBeTruthy();
    expect(indicator?.getAttribute('data-percent')).toBe('1');
    // The strip carries the ring alone; `9.6k/1.0M` is not on it.
    expect(indicator?.textContent).not.toContain('1.0M');
  });

  it('keeps the exact counts and the continuation mode in the panel', () => {
    const { container } = render(<ContextBadge info={info({ mode: 'stateless-loop' })} />);

    expect(container.querySelector('[data-testid="context-badge-tokens"]')?.textContent).toContain(
      '9,600 / 1,000,000'
    );
    // Named, not leaked as its id.
    expect(container.querySelector('[data-testid="context-badge-mode"]')?.textContent).toContain(
      'Stateless loop'
    );
  });

  it('escalates through the severity the tracker already decided', () => {
    const { container } = render(
      <ContextBadge info={info({ estimatedUsageRatio: 0.95, severity: 'danger' })} />
    );

    expect(container.querySelector('[data-severity="danger"]')).toBeTruthy();
    expect(container.querySelector('svg circle:last-child')?.getAttribute('class')).toContain(
      'stroke-error'
    );
  });
});
