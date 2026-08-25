/**
 * The full-density list: day headers grouping the compact row markup, plus
 * the "since your last visit" divider dropped in above the boundary. The
 * pure helpers behind both (`group-activity.ts`) already have their own edge
 * cases covered; this is the one place that proves `ActivityFeed` actually
 * wires them into the render instead of just compiling against them.
 *
 * `ActivityFeed` groups off a live `new Date()` rather than an injectable
 * clock, so event timestamps are anchored to today/yesterday at local noon —
 * never a raw millisecond subtraction, which would cross the day boundary
 * (and flake) for a run started between local midnight and 2am.
 */

import { describe, expect, it } from 'bun:test';
import type { ActivityEvent } from '@mangostudio/shared/activity';
import { screen } from '@testing-library/react';
import { ActivityFeed } from '../../../../src/features/activity/ActivityFeed';
import { render } from '../../../support/harness/render';

const NOW = new Date();
const TODAY_NOON = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 12, 0, 0).getTime();
const YESTERDAY_NOON = new Date(
  NOW.getFullYear(),
  NOW.getMonth(),
  NOW.getDate() - 1,
  12,
  0,
  0
).getTime();

function chatCreated(id: string, title: string, createdAt: number): ActivityEvent {
  return {
    id,
    createdAt,
    chatId: null,
    workdir: null,
    environmentId: null,
    targetId: null,
    kind: 'chat_created',
    payload: { title },
  };
}

const EVENTS: ActivityEvent[] = [
  chatCreated('newer-today', 'Newer today', TODAY_NOON + 60_000),
  chatCreated('older-today', 'Older today', TODAY_NOON),
  chatCreated('yesterday', 'From yesterday', YESTERDAY_NOON),
];

describe('ActivityFeed (full density)', () => {
  it('groups rows under a Today and a Yesterday header', () => {
    render(<ActivityFeed events={EVENTS} />);
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
    expect(screen.getByText('Started Newer today')).toBeInTheDocument();
    expect(screen.getByText('Started Older today')).toBeInTheDocument();
    expect(screen.getByText('Started From yesterday')).toBeInTheDocument();
  });

  it('drops exactly one divider, above the first row at or before the last-seen bookmark', () => {
    const { container } = render(<ActivityFeed events={EVENTS} lastSeenAt={TODAY_NOON} />);
    expect(screen.getAllByText('Since your last visit')).toHaveLength(1);

    // Reading order: "Newer today" (still newer than the bookmark) comes
    // before the divider, and both "Older today" (the boundary row, at the
    // bookmark exactly) and "From yesterday" come after it.
    const text = container.textContent ?? '';
    const dividerAt = text.indexOf('Since your last visit');
    expect(dividerAt).toBeGreaterThan(text.indexOf('Started Newer today'));
    expect(dividerAt).toBeLessThan(text.indexOf('Started Older today'));
    expect(dividerAt).toBeLessThan(text.indexOf('Started From yesterday'));
  });

  it('carries the boundary index across day groups rather than resetting it per group', () => {
    // The bookmark falls in the *second* group here (Yesterday), which is
    // also the common real case — you last looked before today. It is the
    // one arrangement a per-group-reset bug cannot pass: with a fresh
    // counter inside each day's `.map()`, the second group never reaches
    // the row index the first group's rows already used, and no divider
    // renders at all.
    const { container } = render(<ActivityFeed events={EVENTS} lastSeenAt={YESTERDAY_NOON} />);
    expect(screen.getAllByText('Since your last visit')).toHaveLength(1);
    const text = container.textContent ?? '';
    const dividerAt = text.indexOf('Since your last visit');
    expect(dividerAt).toBeGreaterThan(text.indexOf('Started Older today'));
    expect(dividerAt).toBeLessThan(text.indexOf('Started From yesterday'));
  });

  it('renders no divider without a last-seen bookmark', () => {
    render(<ActivityFeed events={EVENTS} />);
    expect(screen.queryByText('Since your last visit')).toBeNull();
  });

  it('caps rows with maxRows before grouping', () => {
    render(<ActivityFeed events={EVENTS} maxRows={1} />);
    expect(screen.getByText('Started Newer today')).toBeInTheDocument();
    expect(screen.queryByText('Started Older today')).toBeNull();
    expect(screen.queryByText('Yesterday')).toBeNull();
  });

  it('renders the empty message for no events', () => {
    render(<ActivityFeed events={[]} />);
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
  });
});
