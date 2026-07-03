import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatGptUsageStatsPanel } from '@/features/settings/connectors/components/ChatGptUsageStatsPanel';
import { fireEvent, render, screen, waitFor } from '../../support/harness/render';

const mockGetChatGptUsageStats = vi.fn();

vi.mock('@/features/settings/connectors/api', () => ({
  getChatGptUsageStats: (...args: unknown[]) => mockGetChatGptUsageStats(...args),
}));

describe('ChatGptUsageStatsPanel', () => {
  beforeEach(() => {
    mockGetChatGptUsageStats.mockReset();
  });

  it('fetches lazily when the panel is opened and renders counters plus the chart', async () => {
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
    expect(mockGetChatGptUsageStats).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /usage stats/i }));

    await waitFor(() => expect(mockGetChatGptUsageStats).toHaveBeenCalledWith('connector-1'));
    expect(await screen.findByText('Lifetime tokens')).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: /usage stats/i }));

    expect(
      await screen.findByText('No usage stats available for this account.')
    ).toBeInTheDocument();
  });
});
