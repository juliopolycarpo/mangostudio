/**
 * CoverageMatrix: one column per target, and a cell nobody has to decode.
 *
 * The accessible name is asserted alongside the glyph because colour or symbol
 * alone is not an answer — a user who cannot tell Shadowed from Differs by its
 * icon still has to be able to read the state.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import { CoverageMatrix } from '../../../../src/features/library/components/CoverageMatrix';
import { render, screen, within } from '../../../support/harness/render';
import { renderWithRouter } from '../../../support/harness/render-with-router';
import { fullCoverage, instance, location, resource, TARGETS } from './fixtures';

/**
 * happy-dom reports every element as zero-sized, and the row virtualizer measures
 * the scroll container with `clientHeight`. Without a height it computes an
 * empty window and renders no rows, so the box is stubbed for this file only.
 */
const VIEWPORT_HEIGHT_PX = 600;
let clientHeightDescriptor: PropertyDescriptor | undefined;

beforeAll(() => {
  clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => VIEWPORT_HEIGHT_PX,
  });
});

afterAll(() => {
  if (clientHeightDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeightDescriptor);
  }
});

function renderMatrix(resources: ReturnType<typeof resource>[]) {
  return renderWithRouter(
    <CoverageMatrix
      groups={[{ locationId: null, resources }]}
      targets={TARGETS}
      locations={[location(), location({ id: 'claude-skills', path: '/home/dev/.claude/skills' })]}
      selected={new Set()}
      onToggleSelected={() => undefined}
      onToggleAll={() => undefined}
      environmentId={LOCAL_ENVIRONMENT_ID}
    />
  );
}

function cellFor(resourceKey: string, targetId: string): HTMLElement {
  const row = screen
    .getAllByTestId('matrix-row')
    .find((candidate) => candidate.getAttribute('data-resource-key') === resourceKey);
  if (!row) throw new Error(`No matrix row for ${resourceKey}`);
  const cell = within(row)
    .getAllByTestId('coverage-cell')
    .find((candidate) => candidate.getAttribute('data-target') === targetId);
  if (!cell) throw new Error(`No ${targetId} cell for ${resourceKey}`);
  return cell;
}

describe('CoverageMatrix', () => {
  it('renders one column per target, in registry order', async () => {
    await renderMatrix([resource()]);

    const headers = screen.getAllByRole('columnheader');

    // Identity comes from the target id rather than the text: each header also
    // renders the target's avatar, and the monogram is part of its textContent.
    expect(headers.map((header) => header.getAttribute('data-target-id'))).toEqual([
      null,
      null,
      'mangostudio',
      'claude',
      'codex',
      'cursor',
    ]);
    expect(headers[1]).toHaveTextContent(en.library.matrix.resourceColumn);
    expect(headers[2]).toHaveTextContent(en.library.targets.mangostudio);
    expect(headers[3]).toHaveTextContent(en.library.targets.claude);
  });

  it('labels every cell with the resource, the target, and the state', async () => {
    await renderMatrix([
      resource({
        instances: [instance({ locationId: 'agents-skills' })],
        coverage: fullCoverage({
          mangostudio: { state: 'present', effectiveLocationId: 'agents-skills' },
        }),
      }),
    ]);

    const cells = screen.getAllByTestId('coverage-cell');

    expect(cells[0]).toHaveAttribute(
      'aria-label',
      `gh on ${en.library.targets.mangostudio}: ${en.library.cellState['only-here']}`
    );
    expect(cells[1]).toHaveAttribute(
      'aria-label',
      `gh on ${en.library.targets.claude}: ${en.library.cellState.absent}`
    );
  });

  // The word printed beside the glyph is short enough for a column that is a
  // fraction of the table; the sentence stays on the cell's name and tooltip.
  it('prints a short word beside the glyph and keeps the sentence in the name', async () => {
    await renderMatrix([
      resource({
        key: 'skill:divergent',
        ref: { kind: 'skill', slug: 'divergent' },
        instances: [
          instance({ locationId: 'agents-skills', contentHash: 'a3f9c1' }),
          instance({ locationId: 'claude-skills', contentHash: 'a3f9c1' }),
          instance({ locationId: 'cursor-skills', contentHash: '7c21e8' }),
        ],
        coverage: fullCoverage({
          mangostudio: { state: 'present', effectiveLocationId: 'agents-skills' },
          claude: { state: 'present', effectiveLocationId: 'claude-skills' },
          cursor: { state: 'present', effectiveLocationId: 'cursor-skills' },
        }),
        divergence: 'divergent',
      }),
    ]);

    const cell = cellFor('skill:divergent', 'cursor');
    expect(cell).toHaveTextContent(en.library.cellStateShort.divergent);
    expect(cell).not.toHaveTextContent(en.library.cellState.divergent);
    expect(cell.getAttribute('aria-label')).toContain(en.library.cellState.divergent);
  });

  it('lays the columns out as a fixed grid, one equal share per agent', async () => {
    await renderMatrix([resource()]);

    const table = screen.getByTestId('coverage-matrix').querySelector('table');
    expect(table).toHaveClass('table-fixed');
    const columns = [...(table?.querySelectorAll('col') ?? [])];
    expect(columns).toHaveLength(TARGETS.length + 2);
    // Only the two leading columns are sized. The agents split what is left, so
    // the same header lands in the same place on every tab and for any count.
    expect(columns.slice(2).map((column) => column.className)).toEqual(TARGETS.map(() => ''));
  });

  // A slug is an identifier: `changelog-writer` broken at its hyphen reads as
  // two words. It stays on one line, and one too long for the column keeps its
  // whole name in the tooltip.
  it('keeps a resource name on one line, with the whole name in its tooltip', async () => {
    await renderMatrix([resource({ ref: { kind: 'skill', slug: 'changelog-writer' } })]);

    const name = screen.getByRole('link', { name: /changelog-writer/ });
    // The slug truncates inside a flex link, so the text centres in a row grown
    // to the 44px touch floor instead of sitting on its top line.
    const slug = within(name).getByText('changelog-writer');
    expect(slug).toHaveClass('truncate');
    expect(slug).not.toHaveClass('break-words');
    expect(name).toHaveClass('items-center');
    expect(name).toHaveAttribute('title', 'changelog-writer');
  });

  it('never calls an absence "missing"', async () => {
    await renderMatrix([resource()]);

    // Absent is frequently correct; the word "missing" would push people into
    // propagating things they never wanted everywhere.
    expect(screen.getAllByTestId('coverage-cell')[1]).toHaveAttribute(
      'aria-label',
      expect.stringContaining(en.library.cellState.absent)
    );
    expect(document.body.textContent).not.toMatch(/missing/i);
  });

  it('renders shadowed and divergent as distinct states', async () => {
    await renderMatrix([
      resource({
        key: 'skill:shadowed',
        ref: { kind: 'skill', slug: 'shadowed' },
        instances: [
          instance({ locationId: 'codex-skills', contentHash: 'same' }),
          instance({ locationId: 'agents-skills', contentHash: 'same' }),
          instance({ locationId: 'claude-skills', contentHash: 'same' }),
        ],
        coverage: fullCoverage({
          mangostudio: { state: 'present', effectiveLocationId: 'agents-skills' },
          claude: { state: 'present', effectiveLocationId: 'claude-skills' },
          codex: {
            state: 'shadowed',
            effectiveLocationId: 'codex-skills',
            shadowedLocationIds: ['agents-skills'],
          },
        }),
        divergence: 'uniform',
      }),
      resource({
        key: 'skill:divergent',
        ref: { kind: 'skill', slug: 'divergent' },
        instances: [
          instance({ locationId: 'agents-skills', contentHash: 'a3f9c1' }),
          instance({ locationId: 'claude-skills', contentHash: 'a3f9c1' }),
          instance({ locationId: 'cursor-skills', contentHash: '7c21e8' }),
        ],
        coverage: fullCoverage({
          mangostudio: { state: 'present', effectiveLocationId: 'agents-skills' },
          claude: { state: 'present', effectiveLocationId: 'claude-skills' },
          cursor: { state: 'present', effectiveLocationId: 'cursor-skills' },
        }),
        divergence: 'divergent',
      }),
    ]);

    // Two identical copies in two of Codex's locations are fine, so they never
    // borrow the divergence glyph.
    expect(cellFor('skill:shadowed', 'codex')).toHaveAttribute('data-state', 'shadowed');
    expect(cellFor('skill:divergent', 'cursor')).toHaveAttribute('data-state', 'divergent');
  });

  it('shows the tooltip facts on a present cell', async () => {
    await renderMatrix([
      resource({
        instances: [
          instance({
            locationId: 'agents-skills',
            path: '/home/dev/.agents/skills/gh',
            contentHash: 'a3f9c1deadbeef',
          }),
        ],
        coverage: fullCoverage({
          mangostudio: { state: 'present', effectiveLocationId: 'agents-skills' },
        }),
      }),
    ]);

    const title = screen.getAllByTestId('coverage-cell')[0].getAttribute('title') ?? '';

    expect(title).toContain('/home/dev/.agents/skills');
    expect(title).toContain('a3f9c1');
  });

  it('keeps every column when there is nothing to show', async () => {
    await renderMatrix([]);

    // A machine with no resources yet, or a filter that matched none, still owes
    // the user the answer to "which agents am I looking at".
    expect(screen.getByTestId('coverage-matrix')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(TARGETS.length + 2);
    expect(screen.queryAllByTestId('matrix-row')).toEqual([]);
  });

  it('explains every glyph in the legend', async () => {
    const { MatrixLegend } = await import(
      '../../../../src/features/library/components/CoverageMatrix'
    );
    render(<MatrixLegend />);

    // The words the cells print themselves: the key is only drawn where the cells
    // are glyphs alone, and the full sentence for each state is its tooltip.
    for (const state of ['present', 'absent', 'shadowed', 'divergent', 'only-here'] as const) {
      expect(screen.getByText(en.library.cellStateShort[state])).toBeInTheDocument();
    }
  });
});
