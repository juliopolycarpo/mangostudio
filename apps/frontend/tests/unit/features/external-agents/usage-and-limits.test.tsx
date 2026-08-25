import { describe, expect, it } from 'bun:test';
import type { ExternalAccountLimits, ExternalUsage } from '@mangostudio/shared/external-agents';
import { ExternalAccountLimitsChip } from '@/features/external-agents/ExternalAccountLimitsChip';
import { ExternalUsageDisplay } from '@/features/external-agents/ExternalUsageDisplay';
import { render } from '../../../support/harness/render';

const NOW = 1_700_000_000_000;

describe('ExternalUsageDisplay', () => {
  it('renders only reported fields and never invents a total', () => {
    const turn: ExternalUsage = { inputTokens: 1200, outputTokens: 80 };
    const { container, queryByText } = render(
      <ExternalUsageDisplay turn={turn} thread={{ total: { totalTokens: 50_000 } }} />
    );
    expect(container.querySelector('[data-testid="external-usage-turn"]')?.textContent).toContain(
      '1.2k'
    );
    expect(container.querySelector('[data-testid="external-usage-thread"]')?.textContent).toContain(
      '50k'
    );
    // No computed sum of input+output.
    expect(queryByText(/1280|1\.3k/)).toBeNull();
  });

  it('draws the ring from the last request against the reported window', () => {
    const { container } = render(
      <ExternalUsageDisplay
        turn={{ inputTokens: 29_000, outputTokens: 1_200, totalTokens: 30_000 }}
        thread={{
          last: { inputTokens: 29_000, outputTokens: 1_200, totalTokens: 30_000 },
          total: { totalTokens: 118_000 },
          contextWindowTokens: 272_000,
        }}
      />
    );
    const indicator = container.querySelector('[data-testid="external-usage-indicator"]');
    // 30k of 272k — the cumulative 118k must not reach the denominator.
    expect(indicator?.getAttribute('data-percent')).toBe('11');
    expect(indicator?.querySelector('svg')).toBeTruthy();
    expect(
      container.querySelector('[data-testid="external-usage-context"]')?.textContent
    ).toContain('30k/272k');
  });

  it('keeps the figures out of the strip until the indicator is hovered or focused', () => {
    const { container } = render(
      <ExternalUsageDisplay
        turn={{ totalTokens: 30_000 }}
        thread={{ last: { totalTokens: 30_000 }, contextWindowTokens: 272_000 }}
      />
    );
    const panel = container.querySelector('[data-testid="external-usage-turn"]')?.parentElement
      ?.parentElement;
    expect(panel?.className).toContain('invisible');
    expect(panel?.className).toContain('group-hover:visible');
    expect(panel?.className).toContain('group-focus-within:visible');
  });

  it('falls back to a total instead of a percentage when no window is reported', () => {
    const { container } = render(
      <ExternalUsageDisplay
        turn={{ totalTokens: 30_000 }}
        thread={{ total: { totalTokens: 118_000 } }}
      />
    );
    const indicator = container.querySelector('[data-testid="external-usage-indicator"]');
    expect(indicator?.getAttribute('data-percent')).toBeNull();
    expect(indicator?.querySelector('svg')).toBeNull();
    expect(indicator?.textContent).toContain('118k');
  });

  it('renders cumulative totals from threadUsage when mounted', () => {
    const threadUsage = {
      last: { inputTokens: 100, outputTokens: 40 },
      total: { inputTokens: 10_000, outputTokens: 2_500, totalTokens: 12_500 },
    };
    const { container } = render(
      <ExternalUsageDisplay turn={threadUsage.last} thread={threadUsage} />
    );
    expect(container.querySelector('[data-testid="external-usage"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="external-usage-turn"]')?.textContent).toMatch(
      /100/
    );
    expect(container.querySelector('[data-testid="external-usage-thread"]')?.textContent).toMatch(
      /13k|12\.5k/
    );
  });

  it('renders nothing when no usage has been reported', () => {
    const { container } = render(<ExternalUsageDisplay turn={null} thread={null} />);
    expect(container.querySelector('[data-testid="external-usage"]')).toBeNull();
    expect(container.querySelector('[data-testid="external-usage-unknown"]')).toBeNull();
    expect(container.textContent).toBe('');
  });
});

describe('ExternalAccountLimitsChip', () => {
  it('shows reset time when genuinely exhausted', () => {
    const limits: ExternalAccountLimits = {
      targetId: 'codex',
      windows: [{ usedPercent: 100, resetsAtMs: NOW + 3_600_000 }],
      observedAtMs: NOW,
      reachedType: 'rate_limit_reached',
    };
    const { container } = render(<ExternalAccountLimitsChip limits={limits} nowMs={NOW} />);
    expect(container.querySelector('[data-exhausted="true"]')).toBeTruthy();
    expect(container.textContent).toMatch(/1h/);
  });

  it('does not mark exhausted when a secondary window remains', () => {
    const limits: ExternalAccountLimits = {
      targetId: 'codex',
      windows: [
        { usedPercent: 100, resetsAtMs: NOW + 60_000 },
        { usedPercent: 20, resetsAtMs: NOW + 86_400_000 },
      ],
      observedAtMs: NOW,
    };
    const { container } = render(<ExternalAccountLimitsChip limits={limits} nowMs={NOW} />);
    expect(container.querySelector('[data-exhausted="false"]')).toBeTruthy();
  });

  it('renders stale as unknown-style copy, not zero', () => {
    const limits: ExternalAccountLimits = {
      targetId: 'codex',
      windows: [{ usedPercent: 99 }],
      observedAtMs: NOW - 20 * 60_000,
    };
    const { container } = render(<ExternalAccountLimitsChip limits={limits} nowMs={NOW} />);
    expect(container.querySelector('[data-verdict="stale"]')).toBeTruthy();
    expect(container.textContent).not.toMatch(/^0%/);
  });
});
