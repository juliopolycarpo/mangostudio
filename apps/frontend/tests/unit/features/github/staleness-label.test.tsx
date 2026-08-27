/**
 * The panel's only honest signal that its lists are old.
 *
 * The regression this pins: the label was formatted from `Date.now()` during
 * one render and the panel never polls, so an idle rail kept saying "updated
 * now" long after it stopped being true.
 */

import { describe, expect, it } from 'bun:test';
import { render, screen } from '../../../support/harness/render';
import { advanceTimersByTimeAsync, useFakeTimers } from '../../../support/harness/timers';

const { GithubStaleness } = await import(
  '../../../../src/features/github/components/GithubStaleness'
);

describe('GithubStaleness', () => {
  it('ages the label while the panel sits idle', async () => {
    useFakeTimers();
    render(<GithubStaleness cachedAt={Date.now()} refreshing={false} />);
    expect(screen.getByText(/now|second/i)).toBeTruthy();

    await advanceTimersByTimeAsync(5 * 60_000);

    expect(screen.getByText(/minute/i)).toBeTruthy();
  });

  it('shows the refreshing label instead of a timestamp', () => {
    render(<GithubStaleness cachedAt={Date.now()} refreshing={true} />);
    expect(screen.queryByText(/minute|second|now/i)).toBeNull();
  });
});
