import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { useChatDockHeight } from '../../../../src/features/chat/hooks/use-chat-dock-height';
import { act, render, screen } from '../../../support/harness/render';

/**
 * Stands in for the layout engine: `offsetHeight` is whatever the test says,
 * and the observer callback is fired by hand, because the global mock never
 * reports a size.
 */
class ControllableResizeObserver {
  static instances: ControllableResizeObserver[] = [];
  disconnected = false;

  constructor(private readonly callback: () => void) {
    ControllableResizeObserver.instances.push(this);
  }

  observe() {
    // The test fires the callback itself.
  }
  unobserve() {
    // Never called by the hook.
  }
  disconnect() {
    this.disconnected = true;
  }
  fire() {
    this.callback();
  }
}

function Harness() {
  const { hostRef, dockRef } = useChatDockHeight();
  return (
    <div ref={hostRef} data-testid="host">
      <div ref={dockRef} data-testid="dock" />
    </div>
  );
}

describe('useChatDockHeight', () => {
  const originalObserver = globalThis.ResizeObserver;
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetHeight'
  );
  let dockHeight = 0;

  beforeEach(() => {
    dockHeight = 0;
    ControllableResizeObserver.instances = [];
    globalThis.ResizeObserver = ControllableResizeObserver as unknown as typeof ResizeObserver;
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => dockHeight,
    });
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalObserver;
    if (originalOffsetHeight) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
    }
  });

  it('publishes the dock height on the host and follows it as the composer grows', () => {
    dockHeight = 180;
    render(<Harness />);
    const host = screen.getByTestId('host');
    expect(host.style.getPropertyValue('--chat-dock-height')).toBe('180px');

    // A multi-line draft makes the composer taller; the trigger must follow.
    dockHeight = 260;
    act(() => ControllableResizeObserver.instances[0]?.fire());
    expect(host.style.getPropertyValue('--chat-dock-height')).toBe('260px');
  });

  it('leaves the consumer’s fallback in charge until something is laid out', () => {
    render(<Harness />);
    expect(screen.getByTestId('host').style.getPropertyValue('--chat-dock-height')).toBe('');
  });

  it('stops observing and clears the property on unmount', () => {
    dockHeight = 180;
    const view = render(<Harness />);
    const host = screen.getByTestId('host');

    view.unmount();

    expect(ControllableResizeObserver.instances[0]?.disconnected).toBe(true);
    expect(host.style.getPropertyValue('--chat-dock-height')).toBe('');
  });
});
