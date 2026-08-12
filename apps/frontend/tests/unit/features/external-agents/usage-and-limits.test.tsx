/**
 * @vitest-environment jsdom
 */
import type { ExternalAccountLimits, ExternalUsage } from '@mangostudio/shared/external-agents';
import { describe, expect, it } from 'vitest';
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
