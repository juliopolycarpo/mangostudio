/**
 * Mounts `TerminalView` under happy-dom.
 *
 * xterm.js measures glyphs with real canvas/DOM APIs happy-dom only partly
 * implements, and the WebGL addon needs a `webgl2` context happy-dom has
 * none of — this is the test that proves both degrade instead of throwing,
 * before anything (`TerminalRailPanel`, the routes) is built on top of it.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { TERMINAL_SOCKET_CLOSE_CODES } from '@mangostudio/shared/terminal';
import { act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminalView } from '../../../../src/features/terminal/TerminalView';
import { render, screen } from '../../../support/harness/render';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = 0;
  binaryType = '';
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  sent: Uint8Array[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  drop(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }
}

describe('TerminalView', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  it('mounts xterm over a container without throwing', () => {
    expect(() =>
      render(
        <TerminalView
          sessionId="session-1"
          createSocket={(url) => new FakeWebSocket(url) as unknown as WebSocket}
          resolveUrl={() => 'ws://terminal.test/api/terminal/session-1'}
        />
      )
    ).not.toThrow();
  });

  it('renders its container', () => {
    const { getByTestId } = render(
      <TerminalView
        sessionId="session-1"
        createSocket={(url) => new FakeWebSocket(url) as unknown as WebSocket}
        resolveUrl={() => 'ws://terminal.test/api/terminal/session-1'}
      />
    );

    expect(getByTestId('terminal-view')).toBeTruthy();
  });

  it('unmounts cleanly (disposes xterm and its ResizeObserver)', () => {
    const { unmount } = render(
      <TerminalView
        sessionId="session-1"
        createSocket={(url) => new FakeWebSocket(url) as unknown as WebSocket}
        resolveUrl={() => 'ws://terminal.test/api/terminal/session-1'}
      />
    );

    expect(unmount).not.toThrow();
  });

  it('shows a take-over overlay when another window replaces this session, and reconnects on click', async () => {
    const user = userEvent.setup();
    render(
      <TerminalView
        sessionId="session-1"
        createSocket={(url) => new FakeWebSocket(url) as unknown as WebSocket}
        resolveUrl={() => 'ws://terminal.test/api/terminal/session-1'}
      />
    );

    const first = FakeWebSocket.instances[0];
    act(() => first?.open());
    act(() => first?.drop(TERMINAL_SOCKET_CLOSE_CODES.REPLACED));

    const takeOver = await screen.findByRole('button', { name: 'Bring it here' });
    expect(screen.getByText('This terminal is open in another window.')).toBeVisible();

    await user.click(takeOver);

    // Reconnecting opens a second socket instead of retrying the first.
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
