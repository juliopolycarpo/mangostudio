import type { ChatGptResetCredit } from '@mangostudio/shared/connectors';
import { describe, expect, it } from 'vitest';
import { ChatGptResetCreditList } from '@/features/settings/connectors/components/ChatGptResetCreditList';
import { render, screen } from '../../support/harness/render';

const NOW = Date.now();

function makeCredit(overrides: Partial<ChatGptResetCredit> = {}): ChatGptResetCredit {
  return { id: 'credit-1', status: 'available', ...overrides };
}

describe('ChatGptResetCreditList', () => {
  it('renders title, status, granted date, and expiry countdown for an available credit', () => {
    render(
      <ChatGptResetCreditList
        credits={[
          makeCredit({
            title: 'Promo reset',
            grantedAt: NOW - 3 * 86_400_000,
            expiresAt: NOW + 2 * 86_400_000,
            description: 'Granted for trying Codex',
          }),
        ]}
      />
    );

    expect(screen.getByText('Promo reset')).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText(/granted .+ · expires in 2d/)).toBeInTheDocument();
    expect(screen.getByRole('listitem')).toHaveAttribute('title', 'Granted for trying Codex');
  });

  it('falls back to resetType, then to the generic title', () => {
    render(
      <ChatGptResetCreditList
        credits={[
          makeCredit({ id: 'credit-1', resetType: 'weekly' }),
          makeCredit({ id: 'credit-2' }),
        ]}
      />
    );

    expect(screen.getByText('weekly')).toBeInTheDocument();
    expect(screen.getByText('Rate-limit reset')).toBeInTheDocument();
  });

  it('dims redeemed and expired credits and keeps available ones prominent', () => {
    render(
      <ChatGptResetCreditList
        credits={[
          makeCredit({ id: 'credit-1', title: 'Live' }),
          makeCredit({ id: 'credit-2', title: 'Spent', status: 'redeemed' }),
          makeCredit({ id: 'credit-3', title: 'Gone', status: 'expired' }),
        ]}
      />
    );

    expect(screen.getByText('Redeemed')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();

    const items = screen.getAllByRole('listitem');
    expect(items[0]?.className).not.toContain('text-on-surface-variant/40');
    expect(items[1]?.className).toContain('text-on-surface-variant/40');
    expect(items[2]?.className).toContain('text-on-surface-variant/40');
  });

  it('renders unknown statuses as raw text without an expiry countdown', () => {
    render(
      <ChatGptResetCreditList
        credits={[makeCredit({ status: 'mystery-status', expiresAt: NOW + 86_400_000 })]}
      />
    );

    expect(screen.getByText('mystery-status')).toBeInTheDocument();
    expect(screen.queryByText(/expires in/)).not.toBeInTheDocument();
  });
});
