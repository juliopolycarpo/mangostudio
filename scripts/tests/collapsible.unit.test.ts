import { describe, expect, test } from 'bun:test';
import { COLLAPSE_THRESHOLD, collapseWhenLong } from '../lib/collapsible';

describe('collapseWhenLong', () => {
  test('the shared threshold is five items', () => {
    expect(COLLAPSE_THRESHOLD).toBe(5);
  });

  test.each([0, 1, 5])('leaves %d items expanded', (count) => {
    expect(collapseWhenLong(count, `${count} items`, '- a\n- b')).toBe('- a\n- b');
  });

  test.each([6, 40])('folds %d items behind a details block with blank-line padding', (count) => {
    expect(collapseWhenLong(count, `${count} items`, '- a\n- b')).toBe(
      ['<details>', `<summary>${count} items</summary>`, '', '- a\n- b', '', '</details>'].join(
        '\n'
      )
    );
  });

  test('honours an explicit threshold', () => {
    expect(collapseWhenLong(3, '3 items', 'x', 2)).toContain('<details>');
    expect(collapseWhenLong(2, '2 items', 'x', 2)).toBe('x');
  });

  test.each([-1, 1.5, Number.NaN])('rejects the invalid item count %p', (count) => {
    expect(() => collapseWhenLong(count, 'summary', 'x')).toThrow(
      `collapseWhenLong itemCount must be a non-negative integer, received ${count}`
    );
  });
});
