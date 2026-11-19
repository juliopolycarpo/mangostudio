/**
 * The rail request channel's delivery rule, and the latches that ride along
 * with it.
 *
 * The command palette awaits `navigate()` and then fires `requestRailPanel`.
 * That promise resolves before the chat surface commits the rail, so a request
 * with no rail yet has to survive a short, bounded gap — and has to take its
 * paired latch with it when it does not.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';

import type { WorkspacePanelId } from '@mangostudio/shared/workspaces';

import {
  onGithubCreatePrRequest,
  requestGithubCreatePr,
} from '../../../../src/features/github/lib/github-panel-request';
import {
  onNewTerminalSessionRequest,
  requestNewTerminalSession,
} from '../../../../src/features/terminal/terminal-panel-request';
import {
  onRailPanelRequest,
  onRailPanelRequestDropped,
  RAIL_PANEL_REQUEST_WINDOW_MS,
  requestRailPanel,
} from '../../../../src/features/workspace/rail/rail-panel-request';
import { advanceTimersByTimeAsync, useFakeTimers } from '../../../support/harness/timers';

describe('rail panel request window', () => {
  const unsubscribers: Array<() => void> = [];

  /** Registers a subscription that the test tears down, so no listener leaks into the next one. */
  function track(unsubscribe: () => void): void {
    unsubscribers.push(unsubscribe);
  }

  beforeEach(() => {
    useFakeTimers();
  });

  afterEach(async () => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    // Whatever a test left held or latched expires, so module state starts clean.
    await advanceTimersByTimeAsync(RAIL_PANEL_REQUEST_WINDOW_MS);
    onGithubCreatePrRequest(() => undefined)();
    onNewTerminalSessionRequest(() => undefined)();
  });

  it('delivers at once to a subscribed rail', () => {
    const received = jest.fn();
    track(onRailPanelRequest(received));

    requestRailPanel('github');

    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith('github');
  });

  it('delivers a request to a rail that subscribes inside the window, once', () => {
    requestRailPanel('github');
    const first = jest.fn();
    const second = jest.fn();

    track(onRailPanelRequest(first));
    track(onRailPanelRequest(second));

    expect(first).toHaveBeenCalledWith('github');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second, 'a replayed request is consumed by the first rail').not.toHaveBeenCalled();
  });

  it('still delivers one tick before the window ends', async () => {
    requestRailPanel('github');
    await advanceTimersByTimeAsync(RAIL_PANEL_REQUEST_WINDOW_MS - 1);

    const received = jest.fn();
    track(onRailPanelRequest(received));

    expect(received).toHaveBeenCalledWith('github');
  });

  it('drops a request no rail claimed within the window', async () => {
    const dropped: WorkspacePanelId[] = [];
    track(onRailPanelRequestDropped((panelId) => dropped.push(panelId)));

    requestRailPanel('github');
    await advanceTimersByTimeAsync(RAIL_PANEL_REQUEST_WINDOW_MS);

    const received = jest.fn();
    track(onRailPanelRequest(received));
    expect(received, 'a rail that arrives after the window').not.toHaveBeenCalled();
    expect(dropped).toEqual(['github']);
  });

  it('does not announce a drop for a request a rail claimed', async () => {
    const dropped = jest.fn();
    track(onRailPanelRequestDropped(dropped));

    requestRailPanel('github');
    track(onRailPanelRequest(jest.fn()));
    await advanceTimersByTimeAsync(RAIL_PANEL_REQUEST_WINDOW_MS * 2);

    expect(dropped).not.toHaveBeenCalled();
  });

  it('holds only the newest request and announces the one it replaced', () => {
    const dropped: WorkspacePanelId[] = [];
    track(onRailPanelRequestDropped((panelId) => dropped.push(panelId)));

    requestRailPanel('github');
    requestRailPanel('terminal');
    const received = jest.fn();
    track(onRailPanelRequest(received));

    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith('terminal');
    expect(dropped).toEqual(['github']);
  });

  describe('paired latches', () => {
    it('keeps the create-pull-request latch for a rail that arrives in time', () => {
      requestRailPanel('github');
      requestGithubCreatePr();

      track(onRailPanelRequest(jest.fn()));
      const createForm = jest.fn();
      track(onGithubCreatePrRequest(createForm));

      expect(createForm).toHaveBeenCalledTimes(1);
    });

    it('clears the create-pull-request latch when its rail request is dropped', async () => {
      requestRailPanel('github');
      requestGithubCreatePr();

      await advanceTimersByTimeAsync(RAIL_PANEL_REQUEST_WINDOW_MS);

      const createForm = jest.fn();
      track(onGithubCreatePrRequest(createForm));
      expect(
        createForm,
        'create form opened by a request whose rail request was dropped'
      ).not.toHaveBeenCalled();
    });

    it('clears the new-terminal-session latch when its rail request is dropped', async () => {
      requestRailPanel('terminal');
      requestNewTerminalSession();

      await advanceTimersByTimeAsync(RAIL_PANEL_REQUEST_WINDOW_MS);

      const newSession = jest.fn();
      track(onNewTerminalSessionRequest(newSession));
      expect(
        newSession,
        'terminal session opened by a request whose rail request was dropped'
      ).not.toHaveBeenCalled();
    });

    it('leaves the other panel latch alone when a rail request is dropped', async () => {
      requestRailPanel('terminal');
      requestGithubCreatePr();

      await advanceTimersByTimeAsync(RAIL_PANEL_REQUEST_WINDOW_MS);

      const createForm = jest.fn();
      track(onGithubCreatePrRequest(createForm));
      expect(createForm, 'a terminal drop must not clear the GitHub latch').toHaveBeenCalledTimes(
        1
      );
    });
  });
});
