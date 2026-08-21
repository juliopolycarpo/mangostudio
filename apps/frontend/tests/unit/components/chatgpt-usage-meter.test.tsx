import { describe, expect, it, jest, mock } from 'bun:test';
import type { ChatGptUsageSnapshot } from '@mangostudio/shared/connectors';
import { render, screen } from '../../support/harness/render';

const actual = await import('@/hooks/use-i18n');

mock.module('@/hooks/use-i18n', () => {
  return {
    ...actual,
    useI18n: () => ({
      t: {
        settings: {
          connectors: {
            chatgptUsageWindowHours: '{hours}h limit',
            chatgptUsageWindowDays: '{days}-day limit',
            chatgptUsagePrimaryFallback: 'Session limit',
            chatgptUsageSecondaryFallback: 'Weekly limit',
            chatgptUsageUsed: '{percent}% used',
            chatgptUsageResets: 'resets in {time}',
            chatgptUsageLimitReached: 'Limit reached',
            chatgptUsageResetCredits: '{count} reset credits',
            chatgptUsageResetCreditsNextExpiry: 'next expires in {time}',
            chatgptUsageCreditsBalance: 'Credits: {balance}',
            chatgptUsageCreditsUnlimited: 'Unlimited credits',
            chatgptUsageUpdated: 'updated {time} ago',
          },
        },
      },
      locale: 'en',
      setLocale: jest.fn(),
    }),
  };
});

// After the mock, never before: a static import is evaluated first and would
// bind the meter to the real i18n hook.
const { ChatGptUsageMeter, formatCompactDuration } = await import(
  '@/features/settings/connectors/components/ChatGptUsageMeter'
);

function freshSnapshot(overrides: Partial<ChatGptUsageSnapshot> = {}): ChatGptUsageSnapshot {
  return {
    capturedAt: Date.now(),
    source: 'endpoint',
    primary: { usedPercent: 42, windowMinutes: 300, resetsAt: Date.now() + 3_600_000 },
    secondary: { usedPercent: 91, windowMinutes: 10_080 },
    ...overrides,
  };
}

describe('ChatGptUsageMeter', () => {
  it('renders window bars with labels, percentages, and reset countdown', () => {
    render(<ChatGptUsageMeter usage={freshSnapshot()} />);

    expect(screen.getByText('5h limit')).toBeInTheDocument();
    expect(screen.getByText('7-day limit')).toBeInTheDocument();
    expect(screen.getByText(/42% used · resets in 1h/)).toBeInTheDocument();
    expect(screen.getByText('91% used')).toBeInTheDocument();

    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(2);
    expect(bars[0]).toHaveAttribute('aria-valuenow', '42');
    expect(bars[1]).toHaveAttribute('aria-valuenow', '91');
  });

  it('falls back to generic window labels when window minutes are unknown', () => {
    render(
      <ChatGptUsageMeter
        usage={freshSnapshot({
          primary: { usedPercent: 10 },
          secondary: { usedPercent: 20 },
        })}
      />
    );

    expect(screen.getByText('Session limit')).toBeInTheDocument();
    expect(screen.getByText('Weekly limit')).toBeInTheDocument();
  });

  it('shows reset credits with the next expiry when present', () => {
    render(
      <ChatGptUsageMeter
        usage={freshSnapshot({
          resetCredits: { availableCount: 2, nextExpiresAt: Date.now() + 2 * 86_400_000 },
        })}
      />
    );

    expect(screen.getByText(/2 reset credits · next expires in 2d/)).toBeInTheDocument();
  });

  it('omits the reset-credit line when no credits are available', () => {
    render(<ChatGptUsageMeter usage={freshSnapshot({ resetCredits: { availableCount: 0 } })} />);

    expect(screen.queryByText(/reset credits/)).not.toBeInTheDocument();
  });

  it('shows the credits balance, preferring unlimited over a balance', () => {
    const { unmount } = render(
      <ChatGptUsageMeter usage={freshSnapshot({ credits: { hasCredits: true, balance: 12.5 } })} />
    );
    expect(screen.getByText(/Credits: 12.5/)).toBeInTheDocument();
    unmount();

    render(
      <ChatGptUsageMeter usage={freshSnapshot({ credits: { unlimited: true, balance: 3 } })} />
    );
    expect(screen.getByText(/Unlimited credits/)).toBeInTheDocument();
  });

  it('flags limit reached and hints at stale snapshots', () => {
    render(
      <ChatGptUsageMeter
        usage={freshSnapshot({ limitReached: true, capturedAt: Date.now() - 30 * 60_000 })}
      />
    );

    expect(screen.getByText('Limit reached')).toBeInTheDocument();
    expect(screen.getByText(/updated 30m ago/)).toBeInTheDocument();
  });

  it('renders nothing but the footer when no windows were reported', () => {
    render(
      <ChatGptUsageMeter
        usage={{
          capturedAt: Date.now(),
          source: 'headers',
          resetCredits: { availableCount: 1 },
        }}
      />
    );

    expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
    expect(screen.getByText(/1 reset credits/)).toBeInTheDocument();
  });
});

describe('formatCompactDuration', () => {
  it('formats minutes, hours, and days compactly', () => {
    expect(formatCompactDuration(30_000)).toBe('1m');
    expect(formatCompactDuration(42 * 60_000)).toBe('42m');
    expect(formatCompactDuration(3 * 3_600_000 + 20 * 60_000)).toBe('3h 20m');
    expect(formatCompactDuration(6 * 86_400_000 + 4 * 3_600_000)).toBe('6d 4h');
  });
});
