/**
 * The filter bar says what each control chooses.
 *
 * With only the value on screen, "Everything" and "Name" read as two settings
 * nobody explained, and "Name" looked like a filter value rather than a sort
 * order. Each select wears its question in front of it, as a `key: value` pair.
 */

import { describe, expect, it, jest } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import { MatrixFilters } from '../../../../src/features/library/components/MatrixFilters';
import { DEFAULT_LIBRARY_FILTERS } from '../../../../src/features/library/format';
import { render, screen } from '../../../support/harness/render';
import { location, TARGETS } from './fixtures';

function renderFilters() {
  return render(
    <MatrixFilters
      filters={DEFAULT_LIBRARY_FILTERS}
      targets={TARGETS}
      locations={[location()]}
      onChange={jest.fn()}
    />
  );
}

describe('MatrixFilters', () => {
  it.each([
    ['show', en.library.filters.show, en.library.filters.showAll],
    ['target', en.library.filters.target, en.library.filters.anyTarget],
    ['location', en.library.filters.location, en.library.filters.anyLocation],
    ['sort', en.library.filters.sort, en.library.filters.sortName],
  ] as const)('names the %s select on screen, not only to a screen reader', (_, key, value) => {
    renderFilters();

    // A real label for the control, so the name is announced as well as seen...
    const select = screen.getByRole('combobox', { name: key });
    expect(select).toHaveTextContent(value);
    // ...and drawn: `sr-only` would hide the very words this exists to show.
    const label = screen.getByText(key, { selector: 'label' });
    expect(label.className).not.toContain('sr-only');
  });

  // The question is in front of the answer, so the answer does not repeat it.
  it('words "any" without repeating the question it answers', () => {
    expect(en.library.filters.anyTarget).not.toMatch(/agent/i);
    expect(en.library.filters.anyLocation).not.toMatch(/location/i);
  });

  // Four rows on a phone instead of six: the search and the location, whose
  // options are whole paths, take a row each; the rest pair up.
  it('lays the controls out in two columns on a phone', () => {
    renderFilters();

    const bar = screen.getByTestId('matrix-filters');
    expect(bar.className).toContain('grid-cols-2');
    expect(bar.querySelector('input[type="search"]')?.closest('.col-span-2')).not.toBeNull();
    expect(
      screen.getByRole('combobox', { name: en.library.filters.location }).closest('.col-span-2')
    ).not.toBeNull();
  });
});
