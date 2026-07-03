import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatGptUsageHistoryPanel } from '@/features/settings/connectors/components/ChatGptUsageHistoryPanel';
import { fireEvent, render, screen, waitFor } from '../../support/harness/render';

const mockGetChatGptUsageHistory = vi.fn();

vi.mock('@/features/settings/connectors/api', () => ({
  getChatGptUsageHistory: (...args: unknown[]) => mockGetChatGptUsageHistory(...args),
}));

describe('ChatGptUsageHistoryPanel', () => {
  beforeEach(() => {
    mockGetChatGptUsageHistory.mockReset();
  });

  it('fetches lazily on open and renders the weekly sparkline with reset boundaries', async () => {
    const now = Date.now();
    mockGetChatGptUsageHistory.mockResolvedValue({
      window: 'secondary',
      days: 7,
      samples: [
        { usedPercent: 60, sampledAt: now - 3 * 86_400_000 },
        { usedPercent: 95, sampledAt: now - 2 * 86_400_000 },
        // Drop marks a window reset boundary.
        { usedPercent: 5, sampledAt: now - 86_400_000 },
      ],
    });

    render(<ChatGptUsageHistoryPanel connectorId="connector-1" />);
    expect(mockGetChatGptUsageHistory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /usage history/i }));

    await waitFor(() =>
      expect(mockGetChatGptUsageHistory).toHaveBeenCalledWith('connector-1', {
        window: 'secondary',
        days: 7,
      })
    );
    const chart = await screen.findByRole('img', { name: 'Weekly limit — last 7 days' });
    expect(chart).toBeInTheDocument();
    expect(chart.querySelectorAll('circle')).toHaveLength(3);
    expect(chart.querySelectorAll('line')).toHaveLength(1);
    expect(chart.querySelectorAll('polyline')).toHaveLength(1);
    expect(
      screen.getByText(
        'Usage as observed from MangoStudio; other apps burn the same quota between refreshes.'
      )
    ).toBeInTheDocument();
  });

  it('renders a single sample as a point without a line', async () => {
    mockGetChatGptUsageHistory.mockResolvedValue({
      window: 'secondary',
      days: 7,
      samples: [{ usedPercent: 40, sampledAt: Date.now() - 60_000 }],
    });

    render(<ChatGptUsageHistoryPanel connectorId="connector-partial" />);
    fireEvent.click(screen.getByRole('button', { name: /usage history/i }));

    const chart = await screen.findByRole('img', { name: 'Weekly limit — last 7 days' });
    expect(chart.querySelectorAll('circle')).toHaveLength(1);
    expect(chart.querySelectorAll('polyline')).toHaveLength(0);
    expect(chart.querySelectorAll('polygon')).toHaveLength(0);
  });

  it('renders the empty state when nothing was sampled yet', async () => {
    mockGetChatGptUsageHistory.mockResolvedValue({ window: 'secondary', days: 7, samples: [] });

    render(<ChatGptUsageHistoryPanel connectorId="connector-empty" />);
    fireEvent.click(screen.getByRole('button', { name: /usage history/i }));

    expect(await screen.findByText('No usage history recorded yet.')).toBeInTheDocument();
  });
});
