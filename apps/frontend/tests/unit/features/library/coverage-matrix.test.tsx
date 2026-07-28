/**
 * CoverageMatrix: one column per target, and a cell nobody has to decode.
 *
 * The accessible name is asserted alongside the glyph because colour or symbol
 * alone is not an answer — a user who cannot tell ⧉ from ⚠ still has to be able
 * to read the state.
 */

import { en } from '@mangostudio/shared/i18n';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CoverageMatrix } from '../../../../src/features/library/components/CoverageMatrix';
import { render, screen, within } from '../../../support/harness/render';
import { renderWithRouter } from '../../../support/harness/render-with-router';
import { fullCoverage, instance, location, resource, TARGETS } from './fixtures';

/**
 * jsdom reports every element as zero-sized, and the row virtualizer measures
 * the scroll container with `offsetHeight`. Without a height it computes an
 * empty window and renders no rows, so the box is stubbed for this file only.
 */
const VIEWPORT_HEIGHT_PX = 600;
let offsetHeightDescriptor: PropertyDescriptor | undefined;

beforeAll(() => {
  offsetHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => VIEWPORT_HEIGHT_PX,
  });
});

afterAll(() => {
  if (offsetHeightDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeightDescriptor);
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

    const headers = screen.getAllByRole('columnheader').map((header) => header.textContent);

    expect(headers).toEqual([
      '',
      en.library.matrix.resourceColumn,
      en.library.targets.mangostudio,
      en.library.targets.claude,
      en.library.targets.codex,
      en.library.targets.cursor,
    ]);
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

    for (const state of ['present', 'absent', 'shadowed', 'divergent', 'only-here'] as const) {
      expect(screen.getByText(en.library.cellState[state])).toBeInTheDocument();
    }
  });
});
