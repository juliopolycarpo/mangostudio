/**
 * `terminal-panel-request.ts`'s latch: a fire-and-forget channel between the
 * command palette and whichever `TerminalRailPanel` happens to be mounted.
 * The non-obvious part is the latch itself, since the two can race — a
 * request fired before the panel subscribes must not be lost, but it must
 * also not replay to more than the one subscriber that consumes it.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import {
  onNewTerminalSessionRequest,
  requestNewTerminalSession,
} from '../../../../src/features/terminal/terminal-panel-request';

// The channel is module-level state shared across every test in this file;
// each test tracks its own subscriptions so a listener it adds never leaks
// into the next test.
let unsubscribes: Array<() => void> = [];

function subscribe(listener: () => void): void {
  unsubscribes.push(onNewTerminalSessionRequest(listener));
}

function noop(): void {
  // Only here to be a listener the drain below can subscribe and drop.
}

beforeEach(() => {
  // Drains any latch a previous file's import-time ordering could have left
  // pending, so every test starts from a known "nothing latched" state.
  onNewTerminalSessionRequest(noop)();
});

afterEach(() => {
  for (const unsubscribe of unsubscribes) unsubscribe();
  unsubscribes = [];
});

describe('terminal-panel-request', () => {
  it('latches a request made with no listener subscribed', () => {
    const listener = jest.fn();

    requestNewTerminalSession();
    subscribe(listener);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('replays a latched request to only the first subscriber', () => {
    const first = jest.fn();
    const second = jest.fn();

    requestNewTerminalSession();
    subscribe(first);
    subscribe(second);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('delivers a request with a live listener without latching it', () => {
    const listener = jest.fn();
    subscribe(listener);

    requestNewTerminalSession();

    expect(listener).toHaveBeenCalledTimes(1);

    // Nothing latched: a listener subscribing afterwards, with no new
    // request, gets no replay of the one already delivered above.
    for (const unsubscribe of unsubscribes) unsubscribe();
    unsubscribes = [];
    const late = jest.fn();
    subscribe(late);

    expect(late).not.toHaveBeenCalled();
  });

  it('notifies every currently-subscribed listener, not just one', () => {
    const first = jest.fn();
    const second = jest.fn();
    subscribe(first);
    subscribe(second);

    requestNewTerminalSession();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
