/**
 * The two lists on a resource's detail page, which read the same facts the
 * matrix does and must not contradict it.
 *
 * Coverage draws a state the way the matrix cell does — a toned glyph and the
 * word — so Shadowed and Absent are not the same grey dot; the rows share a
 * column grid so the where-from text starts at one x. Content counts copies in
 * words ("1 copy"), not a bare "×1".
 */

import { describe, expect, it } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import { ContentGroupList } from '../../../../src/features/library/components/ContentGroupList';
import { CoverageList } from '../../../../src/features/library/components/CoverageList';
import { libraryKindPath } from '../../../../src/features/library/format';
import { render, screen, within } from '../../../support/harness/render';
import { fullCoverage, sourceGroup } from './fixtures';

const labelOf = (locationId: string) => `/home/dev/${locationId}`;

function renderCoverage() {
  render(
    <CoverageList
      locationLabel={labelOf}
      coverage={fullCoverage({
        mangostudio: {
          state: 'shadowed',
          effectiveLocationId: 'agents-skills',
          shadowedLocationIds: ['claude-skills'],
        },
        claude: { state: 'present', effectiveLocationId: 'claude-skills' },
      })}
    />
  );
  const row = (targetId: string) =>
    screen
      .getAllByTestId('coverage-row')
      .find((candidate) => candidate.dataset.targetId === targetId) as HTMLElement;
  return { row };
}

describe('CoverageList', () => {
  it('draws each state with the matrix glyph and its word, so no two states share a look', () => {
    const { row } = renderCoverage();

    const drawn = (targetId: string) => {
      const glyph = row(targetId).querySelector('[aria-hidden="true"]') as HTMLElement;
      return { glyph: glyph.textContent, tone: glyph.className, row: row(targetId) };
    };
    const present = drawn('claude');
    const shadowed = drawn('mangostudio');
    const absent = drawn('codex');

    expect(present.glyph).toBe('✓');
    expect(shadowed.glyph).toBe('⧉');
    expect(absent.glyph).toBe('—');
    expect(new Set([present.tone, shadowed.tone, absent.tone]).size).toBe(3);
    // The glyph is decoration; the word is what a reader gets.
    expect(within(present.row).getByText(en.library.coverage.present)).toBeInTheDocument();
    expect(within(shadowed.row).getByText(en.library.coverage.shadowed)).toBeInTheDocument();
    expect(within(absent.row).getByText(en.library.coverage.absent)).toBeInTheDocument();
  });

  it('keeps where-from and also-in in one cell, and gives an absent row none', () => {
    const { row } = renderCoverage();

    // Agent, state, details: the third cell is the one that wraps.
    const shadowed = row('mangostudio');
    expect(shadowed.children).toHaveLength(3);
    const details = shadowed.children[2] as HTMLElement;
    expect(details).toHaveTextContent('via /home/dev/agents-skills');
    expect(details).toHaveTextContent('also in /home/dev/claude-skills, identical');

    // No empty third cell: it would add a blank grid row on a phone.
    expect(row('codex').children).toHaveLength(2);
    expect(row('cursor').children).toHaveLength(2);
  });
});

describe('ContentGroupList', () => {
  it('counts copies in words, singular and plural', () => {
    render(
      <ContentGroupList
        groups={[
          sourceGroup({ contentHash: 'a3f9c1', instanceCount: 2 }),
          sourceGroup({ contentHash: '7c21e8', instanceCount: 1 }),
        ]}
      />
    );

    const [many, one] = screen.getAllByTestId('content-group');
    expect(many).toHaveTextContent('2 copies · modified');
    expect(one).toHaveTextContent('1 copy · modified');
    expect(screen.queryByText(/×/)).not.toBeInTheDocument();
  });
});

describe('libraryKindPath', () => {
  it('sends every kind to the tab that lists it, with settings and hooks sharing one', () => {
    expect(libraryKindPath('skill')).toBe('/environments/library/skills');
    expect(libraryKindPath('subagent')).toBe('/environments/library/subagents');
    expect(libraryKindPath('command')).toBe('/environments/library/commands');
    expect(libraryKindPath('instruction')).toBe('/environments/library/instructions');
    expect(libraryKindPath('setting')).toBe('/environments/library/settings');
    expect(libraryKindPath('hook')).toBe('/environments/library/settings');
  });
});
