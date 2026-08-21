import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import type { ChatGptUsageStats } from '@mangostudio/shared/connectors';
import { render, screen } from '../../support/harness/render';

const mockGetChatGptUsageStats = jest.fn();

mock.module('@/features/settings/connectors/api', () => ({
  getChatGptUsageStats: (...args: unknown[]) => mockGetChatGptUsageStats(...args),
}));

// After the mock, never before: a static import is evaluated first and would
// bind the panel to the real connectors API.
const { ChatGptUsageStatsPanel } = await import(
  '@/features/settings/connectors/components/ChatGptUsageStatsPanel'
);

describe('ChatGptUsageStatsPanel', () => {
  beforeEach(() => {
    mockGetChatGptUsageStats.mockReset();
  });

  it('fetches eagerly and renders counters plus the chart', async () => {
    mockGetChatGptUsageStats.mockResolvedValue({
      stats: {
        lifetimeTokens: 123_456,
        peakDailyTokens: 8_000,
        longestRunningTurnSec: 3_920,
        currentStreakDays: 4,
        longestStreakDays: 12,
        dailyUsage: [
          { startDate: '2026-07-01', tokens: 200 },
          { startDate: '2026-07-02', tokens: 8_000 },
        ],
      },
    });

    render(<ChatGptUsageStatsPanel connectorId="connector-1" />);

    expect(await screen.findByText('Lifetime tokens')).toBeInTheDocument();
    expect(mockGetChatGptUsageStats).toHaveBeenCalledWith('connector-1');
    expect(screen.getByText('123,456')).toBeInTheDocument();
    expect(screen.getByText('Peak day')).toBeInTheDocument();
    expect(screen.getByText('8,000')).toBeInTheDocument();
    expect(screen.getByText('Longest turn')).toBeInTheDocument();
    expect(screen.getByText('1h 5m')).toBeInTheDocument();
    expect(screen.getByText('Current streak')).toBeInTheDocument();
    expect(screen.getByText('4 days')).toBeInTheDocument();
    expect(screen.getByText('Longest streak')).toBeInTheDocument();
    expect(screen.getByText('12 days')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Tokens per day — last 30 days' })).toBeInTheDocument();
    expect(screen.getByText('Jul 2: 8,000 tokens')).toBeInTheDocument();
  });

  it('renders the empty state when the backend reports no stats', async () => {
    mockGetChatGptUsageStats.mockResolvedValue({ stats: null });

    render(<ChatGptUsageStatsPanel connectorId="connector-empty" />);

    expect(
      await screen.findByText('No usage stats available for this account.')
    ).toBeInTheDocument();
  });

  it('renders and sorts numeric daily bucket start dates without crashing', async () => {
    mockGetChatGptUsageStats.mockResolvedValue({
      stats: {
        dailyUsage: [
          { startDate: 20260702, tokens: 300 },
          { startDate: 20260701, tokens: 200 },
        ] as unknown as ChatGptUsageStats['dailyUsage'],
      },
    });

    render(<ChatGptUsageStatsPanel connectorId="connector-numeric-date" />);

    expect(
      await screen.findByRole('img', { name: 'Tokens per day — last 30 days' })
    ).toBeInTheDocument();
    expect(screen.getByText('20260701: 200 tokens')).toBeInTheDocument();
    expect(screen.getByText('20260702: 300 tokens')).toBeInTheDocument();
  });
});
