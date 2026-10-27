/**
 * The filter bar says what each control chooses.
 *
 * With only the value on screen, "Everything" and "Name" read as two settings
 * nobody explained, and "Name" looked like a filter value rather than a sort
 * order. Each select wears its question in front of it, as a `key: value` pair.
 */

import { describe, expect, it, jest } from 'bun:test';

import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';

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

  // The matrix is the point of the page: on a phone only the search stays in
  // view, and one button reveals the rest, counting what is set away from default.
  it('folds every control but the search behind one Filters button on a phone', async () => {
    const onChange = jest.fn();
    const user = userEvent.setup();
    render(
      <MatrixFilters
        filters={{ ...DEFAULT_LIBRARY_FILTERS, show: 'divergent', groupByLocation: true }}
        targets={TARGETS}
        locations={[location()]}
        onChange={onChange}
      />
    );

    const toggle = screen.getByRole('button', { name: new RegExp(en.library.filters.toggle) });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('matrix-filters-count')).toHaveTextContent('2');

    const panel = screen.getByTestId('matrix-filters-panel');
    expect(toggle).toHaveAttribute('aria-controls', panel.id);
    expect(panel.className).toContain('hidden');
    // The search is outside the panel, so it never leaves the first row.
    expect(panel.contains(document.querySelector('input[type="search"]'))).toBe(false);

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(panel.className).toContain('grid-cols-2');
    expect(panel.className).not.toContain('hidden');
    // The location, whose options are whole paths, takes a row of its own.
    expect(
      screen.getByRole('combobox', { name: en.library.filters.location }).closest('.col-span-2')
    ).not.toBeNull();
  });

  it('shows no count while every filter is at its default', () => {
    renderFilters();

    expect(screen.queryByTestId('matrix-filters-count')).toBeNull();
  });
});
