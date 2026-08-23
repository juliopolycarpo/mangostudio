/**
 * The header quota pill against fixture snapshots: quiet with room, warning on
 * low/stale/exhausted, absent while unknown. `nowMs` is always injected — the
 * verdict flips on wall-clock staleness, which no assertion may depend on.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type { ExternalAccountLimits } from '@mangostudio/shared/external-agents';
import { fireEvent, screen } from '@testing-library/react';
import { QuotaPillView } from '../../../src/features/external-agents/HeaderQuotaPill';
import { render } from '../../support/harness/render';

const NOW_MS = 1_787_000_000_000;

function limitsFixture(overrides: Partial<ExternalAccountLimits> = {}): ExternalAccountLimits {
  return {
    targetId: 'codex',
    windows: [{ usedPercent: 40 }],
    observedAtMs: NOW_MS,
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.setItem('mangostudio:locale', 'en');
});

afterEach(() => {
  window.localStorage.clear();
});

describe('QuotaPillView', () => {
  it('renders nothing while the snapshot is unknown', () => {
    render(
      <QuotaPillView limits={undefined} nowMs={NOW_MS} onRefresh={jest.fn()} refreshing={false} />
    );
    expect(screen.queryByTestId('header-quota-pill')).toBeNull();
  });

  it('shows the remaining percentage while the account has room', () => {
    render(
      <QuotaPillView
        limits={limitsFixture()}
        nowMs={NOW_MS}
        onRefresh={jest.fn()}
        refreshing={false}
      />
    );
    const pill = screen.getByTestId('header-quota-pill');
    expect(pill).toHaveTextContent('60% left');
    expect(pill.dataset.verdict).toBe('ok');
  });

  it('warns when the snapshot has gone stale', () => {
    render(
      <QuotaPillView
        limits={limitsFixture({ observedAtMs: NOW_MS - 16 * 60_000 })}
        nowMs={NOW_MS}
        onRefresh={jest.fn()}
        refreshing={false}
      />
    );
    const pill = screen.getByTestId('header-quota-pill');
    expect(pill).toHaveTextContent('Quota outdated');
    expect(pill.dataset.verdict).toBe('stale');
  });

  it('says when an exhausted window resets', () => {
    render(
      <QuotaPillView
        limits={limitsFixture({
          windows: [{ usedPercent: 100, resetsAtMs: NOW_MS + 90 * 60_000 }],
        })}
        nowMs={NOW_MS}
        onRefresh={jest.fn()}
        refreshing={false}
      />
    );
    expect(screen.getByTestId('header-quota-pill')).toHaveTextContent(
      'Quota exhausted · resets in 1h 30m'
    );
  });

  it('refreshes on click and locks while a refresh is in flight', () => {
    const onRefresh = jest.fn();
    const { rerender } = render(
      <QuotaPillView
        limits={limitsFixture()}
        nowMs={NOW_MS}
        onRefresh={onRefresh}
        refreshing={false}
      />
    );
    fireEvent.click(screen.getByTestId('header-quota-pill'));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rerender(
      <QuotaPillView
        limits={limitsFixture()}
        nowMs={NOW_MS}
        onRefresh={onRefresh}
        refreshing={true}
      />
    );
    expect(screen.getByTestId<HTMLButtonElement>('header-quota-pill').disabled).toBe(true);
  });
});
