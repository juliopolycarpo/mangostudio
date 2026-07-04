import type { Connector } from '@mangostudio/shared';
import type { ChatGptUsageSnapshot } from '@mangostudio/shared/connectors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatGptMetricsCard } from '@/features/settings/observability/components/ChatGptMetricsCard';
import { render, screen } from '../../support/harness/render';

const mockGetChatGptUsageHistory = vi.fn();
const mockGetChatGptUsageStats = vi.fn();

vi.mock('@/features/settings/connectors/api', () => ({
  getChatGptUsageHistory: (...args: unknown[]) => mockGetChatGptUsageHistory(...args),
  getChatGptUsageStats: (...args: unknown[]) => mockGetChatGptUsageStats(...args),
}));

function makeConnector(usage: Partial<ChatGptUsageSnapshot> | null): Connector {
  return {
    id: 'connector-1',
    name: 'my-chatgpt',
    provider: 'chatgpt',
    configured: true,
    source: 'bun-secrets',
    accountLabel: 'ada@example.com',
    maskedSuffix: '****...1234',
    planType: 'pro',
    needsReauth: false,
    updatedAt: Date.now(),
    enabledModels: [],
    userId: 'user-1',
    baseUrl: null,
    usage: usage === null ? null : { capturedAt: Date.now(), source: 'endpoint', ...usage },
  } as unknown as Connector;
}

describe('ChatGptMetricsCard', () => {
  beforeEach(() => {
    mockGetChatGptUsageHistory.mockReset();
    mockGetChatGptUsageStats.mockReset();
    mockGetChatGptUsageHistory.mockResolvedValue({ window: 'secondary', days: 7, samples: [] });
    mockGetChatGptUsageStats.mockResolvedValue({ stats: null });
  });

  it('renders identity, quota windows, resets, and account stats from the connector', async () => {
    const now = Date.now();
    mockGetChatGptUsageStats.mockResolvedValue({
      stats: { lifetimeTokens: 123_456, dailyUsage: [{ startDate: '2026-07-01', tokens: 200 }] },
    });

    render(
      <ChatGptMetricsCard
        connector={makeConnector({
          primary: { usedPercent: 42, windowMinutes: 300, resetsAt: now + 3_600_000 },
          secondary: { usedPercent: 10, windowMinutes: 10_080, resetsAt: now + 86_400_000 },
          resetCredits: { availableCount: 2 },
        })}
        onRedeemed={() => undefined}
      />
    );

    expect(screen.getByText('my-chatgpt')).toBeInTheDocument();
    expect(screen.getByText('Pro plan')).toBeInTheDocument();
    expect(screen.getByText('Signed in as ada@example.com')).toBeInTheDocument();
    expect(screen.getByText(/42% used/)).toBeInTheDocument();
    expect(screen.getByText(/2 reset credits/)).toBeInTheDocument();
    expect(await screen.findByText('123,456')).toBeInTheDocument();
  });

  it('shows the empty state when the connector has no usage snapshot', () => {
    render(<ChatGptMetricsCard connector={makeConnector(null)} onRedeemed={() => undefined} />);

    expect(screen.getByText('No usage data available for this account yet.')).toBeInTheDocument();
    expect(screen.queryByText(/% used/)).not.toBeInTheDocument();
  });

  it('offers the reset redeem action when a window is exhausted and a credit is available', () => {
    render(
      <ChatGptMetricsCard
        connector={makeConnector({ limitReached: true, resetCredits: { availableCount: 1 } })}
        onRedeemed={() => undefined}
      />
    );

    expect(screen.getByText('Use a rate-limit reset')).toBeInTheDocument();
  });
});
