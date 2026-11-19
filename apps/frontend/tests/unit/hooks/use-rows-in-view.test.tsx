import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';

import { render } from '@testing-library/react';
import { useRef } from 'react';

import {
  ROW_IN_VIEW_ATTRIBUTE,
  ROWS_IN_VIEW_MARGIN_PX,
  ROWS_IN_VIEW_SETTLE_MS,
  useRowsInView,
} from '@/features/sidebar/hooks/use-rows-in-view';

import { act } from '../../support/harness/render';
import {
  type FakeIntersectionObserverHandle,
  installFakeIntersectionObserver,
} from '../../support/mocks/fake-intersection-observer';

interface ListProps {
  readonly rowIds: readonly string[];
  readonly onChange: (ids: readonly string[]) => void;
}

function List({ rowIds, onChange }: ListProps) {
  const rootRef = useRef<HTMLUListElement>(null);
  useRowsInView({ rootRef, rowsKey: rowIds, onChange });
  return (
    <ul ref={rootRef}>
      {rowIds.map((id) => (
        <li key={id} {...{ [ROW_IN_VIEW_ATTRIBUTE]: id }}>
          {id}
        </li>
      ))}
    </ul>
  );
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ROWS_IN_VIEW_SETTLE_MS + 50));
  });

describe('useRowsInView', () => {
  let fake: FakeIntersectionObserverHandle;

  beforeEach(() => {
    fake = installFakeIntersectionObserver();
  });

  afterEach(() => {
    fake.restore();
  });

  it('reports the sorted ids in view once the window settles', async () => {
    const onChange = jest.fn();
    render(<List rowIds={['c', 'a', 'b']} onChange={onChange} />);

    act(() => fake.setInView(['c', 'a']));
    expect(onChange).not.toHaveBeenCalled();
    await settle();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['a', 'c']);
  });

  it('stays silent when rows are re-read and the window has not moved', async () => {
    const onChange = jest.fn();
    const view = render(<List rowIds={['a', 'b']} onChange={onChange} />);
    act(() => fake.setInView(['a']));
    await settle();
    expect(onChange).toHaveBeenCalledTimes(1);

    view.rerender(<List rowIds={['a', 'b', 'c']} onChange={onChange} />);
    act(() => fake.setInView(['a']));
    await settle();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('drops a row that was removed from the list out of the reported window', async () => {
    const onChange = jest.fn();
    const view = render(<List rowIds={['a', 'b']} onChange={onChange} />);
    act(() => fake.setInView(['a', 'b']));
    await settle();

    view.rerender(<List rowIds={['a']} onChange={onChange} />);
    act(() => fake.setInView(['a', 'b']));
    await settle();

    expect(onChange).toHaveBeenLastCalledWith(['a']);
  });

  it('keeps one observer alive, with lookahead, and disconnects on unmount', () => {
    const view = render(<List rowIds={['a']} onChange={jest.fn()} />);
    expect(fake.liveObserverCount()).toBe(1);
    expect(ROWS_IN_VIEW_MARGIN_PX).toBeGreaterThan(0);

    view.unmount();
    expect(fake.liveObserverCount()).toBe(0);
  });

  it('reports every row when the browser cannot observe intersections', () => {
    fake.restore();
    const unsupported = globalThis.IntersectionObserver;
    // @ts-expect-error -- Simulates a runtime without the API.
    delete globalThis.IntersectionObserver;
    try {
      const onChange = jest.fn();
      render(<List rowIds={['b', 'a']} onChange={onChange} />);
      expect(onChange).toHaveBeenCalledWith(['a', 'b']);
    } finally {
      globalThis.IntersectionObserver = unsupported;
      fake = installFakeIntersectionObserver();
    }
  });
});
