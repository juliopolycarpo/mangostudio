import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';

import { render } from '@testing-library/react';
import { useRef } from 'react';

import {
  LIST_END_ATTRIBUTE,
  useLoadMoreOnVisible,
} from '@/features/sidebar/hooks/use-load-more-on-visible';

import { act } from '../../support/harness/render';
import {
  type FakeIntersectionObserverHandle,
  installFakeIntersectionObserver,
} from '../../support/mocks/fake-intersection-observer';

interface ListProps {
  readonly enabled: boolean;
  readonly loadedKey: number;
  readonly onVisible: () => void;
}

function List({ enabled, loadedKey, onVisible }: ListProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useLoadMoreOnVisible({ rootRef, sentinelRef, enabled, loadedKey, onVisible });
  return (
    <div ref={rootRef}>
      <div ref={sentinelRef} {...{ [LIST_END_ATTRIBUTE]: '' }} />
    </div>
  );
}

describe('useLoadMoreOnVisible', () => {
  let fake: FakeIntersectionObserverHandle;

  beforeEach(() => {
    fake = installFakeIntersectionObserver();
  });

  afterEach(() => {
    fake.restore();
  });

  it('calls back when the sentinel is in view', () => {
    const onVisible = jest.fn();
    render(<List enabled loadedKey={1} onVisible={onVisible} />);

    act(() => fake.setInView([''], LIST_END_ATTRIBUTE));

    expect(onVisible).toHaveBeenCalledTimes(1);
  });

  it('watches nothing while disabled', () => {
    render(<List enabled={false} loadedKey={1} onVisible={jest.fn()} />);

    expect(fake.liveObserverCount(), 'expected no live observer for a disabled hook').toBe(0);
  });

  it('observes again after a load, so a sentinel still in view asks for the next page', () => {
    const onVisible = jest.fn();
    const { rerender } = render(<List enabled loadedKey={1} onVisible={onVisible} />);
    act(() => fake.setInView([''], LIST_END_ATTRIBUTE));
    expect(onVisible).toHaveBeenCalledTimes(1);

    // A page landed: a new observer reports the sentinel's current visibility,
    // where the old one would stay silent about a state that did not change.
    rerender(<List enabled loadedKey={2} onVisible={onVisible} />);
    act(() => fake.setInView([''], LIST_END_ATTRIBUTE));

    expect(onVisible).toHaveBeenCalledTimes(2);
    expect(fake.liveObserverCount()).toBe(1);
  });

  it('does nothing without IntersectionObserver', () => {
    fake.restore();
    const previous = globalThis.IntersectionObserver;
    // @ts-expect-error -- Removing the global is the case under test.
    delete globalThis.IntersectionObserver;
    const onVisible = jest.fn();
    try {
      render(<List enabled loadedKey={1} onVisible={onVisible} />);
      expect(onVisible).not.toHaveBeenCalled();
    } finally {
      globalThis.IntersectionObserver = previous;
    }
  });

  it('disconnects its observer on unmount', () => {
    const { unmount } = render(<List enabled loadedKey={1} onVisible={jest.fn()} />);
    expect(fake.liveObserverCount()).toBe(1);

    unmount();

    expect(fake.liveObserverCount()).toBe(0);
  });
});
