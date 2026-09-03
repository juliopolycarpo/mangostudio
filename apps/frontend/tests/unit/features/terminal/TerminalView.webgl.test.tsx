/**
 * The WebGL renderer's load path, which is the one thing in `TerminalView`
 * that outlives the mount that started it.
 *
 * Its own file: `canUseWebgl()` caches its answer for the page, and every
 * other `TerminalView` test runs under a happy-dom with no `webgl2` at all —
 * sharing a file would cache `false` before this stub is ever consulted.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from '@testing-library/react';
import { TerminalView } from '../../../../src/features/terminal/TerminalView';
import { render } from '../../../support/harness/render';
import { FakeTerminalSocket } from './fake-terminal-socket';

/** Counts activations without needing a GPU: `activate` is all xterm calls. */
class FakeWebglAddon {
  static activations = 0;
  onContextLoss(_listener: () => void): void {
    // The real addon returns a disposable; nothing under test reads it.
  }
  activate(): void {
    FakeWebglAddon.activations += 1;
  }
  dispose(): void {
    // Loaded addons are disposed with the terminal; nothing to release here.
  }
}

mock.module('@xterm/addon-webgl', () => ({ WebglAddon: FakeWebglAddon }));

/**
 * happy-dom answers `null` for every context, so the probe would short-circuit
 * before the load path is reached. Only `webgl2` is faked; xterm measures
 * glyphs through the other ones and must keep the real answers.
 */
const realGetContext = HTMLCanvasElement.prototype.getContext;

beforeEach(() => {
  FakeTerminalSocket.instances = [];
  FakeWebglAddon.activations = 0;
  HTMLCanvasElement.prototype.getContext = function patched(
    this: HTMLCanvasElement,
    contextId: string,
    ...rest: unknown[]
  ) {
    if (contextId === 'webgl2') {
      return { getExtension: () => ({ loseContext: () => undefined }) };
    }
    return (realGetContext as (...args: unknown[]) => unknown).call(this, contextId, ...rest);
  } as typeof realGetContext;
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
});

function renderView() {
  return render(
    <TerminalView
      sessionId="session-1"
      createSocket={(url) => new FakeTerminalSocket(url) as unknown as WebSocket}
      resolveUrl={() => 'ws://terminal.test/api/terminal/session-1'}
    />
  );
}

describe('TerminalView WebGL renderer', () => {
  it('loads the addon when the terminal is still mounted', async () => {
    renderView();

    await act(async () => {
      await Promise.resolve();
    });

    expect(FakeWebglAddon.activations).toBe(1);
  });

  // The rail remounts this view on every tab switch, so a switch during the
  // chunk's import disposes the terminal mid-flight. Activating then takes a
  // real `webgl2` context held by an addon nothing can reach to dispose, and
  // the browser force-loses the oldest context — a visible terminal's — to
  // make room for it.
  it('does not load the addon into a terminal disposed while the chunk loaded', async () => {
    const { unmount } = renderView();

    unmount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(FakeWebglAddon.activations).toBe(0);
  });
});
