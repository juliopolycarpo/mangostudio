/**
 * The two lists on a resource's detail page, which read the same facts the
 * matrix does and must not contradict it.
 *
 * Coverage draws a state the way the matrix cell does — a toned icon and the
 * word — so Shadowed and Absent are not the same grey dot; the rows share a
 * column grid so the where-from text starts at one x. Content counts copies in
 * words ("1 copy"), not a bare "×1".
 */

import { describe, expect, it } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import type { LibraryResource } from '@mangostudio/shared/library';
import { ContentGroupList } from '../../../../src/features/library/components/ContentGroupList';
import { CoverageList } from '../../../../src/features/library/components/CoverageList';
import {
  libraryKindPath,
  resourceKeyLabel,
  resourceTitle,
} from '../../../../src/features/library/format';
import { render, screen, within } from '../../../support/harness/render';
import { fullCoverage, instance, resource, sourceGroup } from './fixtures';

const labelOf = (locationId: string) => `/home/dev/${locationId}`;

const COVERAGE = fullCoverage({
  mangostudio: {
    state: 'shadowed',
    effectiveLocationId: 'agents-skills',
    shadowedLocationIds: ['claude-skills'],
  },
  claude: { state: 'present', effectiveLocationId: 'claude-skills' },
});

/**
 * MangoStudio reads agents-skills over claude-skills, and Claude Code reads
 * claude-skills. `claudeHash` is what claude-skills holds; agents-skills holds
 * `a3f9c1`, so the default is two identical copies.
 */
function renderCoverage({
  claudeHash = 'a3f9c1',
  divergence,
}: {
  readonly claudeHash?: string;
  readonly divergence?: LibraryResource['divergence'];
} = {}) {
  const instances = [
    instance({ locationId: 'agents-skills', contentHash: 'a3f9c1' }),
    instance({ locationId: 'claude-skills', contentHash: claudeHash }),
  ];
  render(
    <CoverageList
      locationLabel={labelOf}
      resource={resource({
        instances,
        coverage: COVERAGE,
        divergence: divergence ?? (claudeHash === 'a3f9c1' ? 'uniform' : 'divergent'),
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
      const icon = glyph.querySelector('svg');
      return { icon: icon?.getAttribute('class') ?? '', tone: glyph.className, row: row(targetId) };
    };
    const present = drawn('claude');
    const shadowed = drawn('mangostudio');
    const absent = drawn('codex');

    // Lucide icons, never Unicode symbols: each character had its own width,
    // so the words after them did not line up.
    expect(present.icon).toContain('lucide-check');
    expect(shadowed.icon).toContain('lucide-layers');
    expect(absent.icon).toContain('lucide-minus');
    expect(new Set([present.tone, shadowed.tone, absent.tone]).size).toBe(3);
    // The glyph is decoration; the word is what a reader gets.
    expect(within(present.row).getByText(en.library.cellStateShort.present)).toBeInTheDocument();
    expect(within(shadowed.row).getByText(en.library.cellStateShort.shadowed)).toBeInTheDocument();
    expect(within(absent.row).getByText(en.library.cellStateShort.absent)).toBeInTheDocument();
  });

  // The detail page and the matrix read the same facts; when the two copies
  // differ, the detail must say so for both agents, exactly as the matrix row does.
  it('reads each state the way the matrix does, not from the raw coverage state', () => {
    const { row } = renderCoverage({ claudeHash: 'c3d457' });

    for (const targetId of ['mangostudio', 'claude']) {
      expect(row(targetId)).toHaveAttribute('data-state', 'divergent');
      // The second cell is the state: the matrix's glyph and its word.
      const state = row(targetId).children[1] as HTMLElement;
      expect(state).toHaveTextContent(en.library.cellStateShort.divergent);
      expect(state).not.toHaveTextContent(en.library.cellStateShort.present);
    }
  });

  it('badges a shadowed copy by comparing its hash with the copy the agent reads', () => {
    const { row } = renderCoverage({ claudeHash: 'c3d457' });

    const shadow = within(row('mangostudio')).getByTestId('coverage-shadow');
    expect(shadow).toHaveAttribute('data-comparison', 'differs');
    expect(within(shadow).getByText(en.library.detail.shadowCopy.differs)).toBeInTheDocument();
    expect(within(shadow).queryByText(en.library.detail.shadowCopy.identical)).toBeNull();
  });

  it('never claims two copies are identical when it cannot compare them', () => {
    const { row } = renderCoverage({ divergence: 'incomparable' });

    const shadow = within(row('mangostudio')).getByTestId('coverage-shadow');
    expect(shadow).toHaveAttribute('data-comparison', 'unknown');
    expect(within(shadow).getByText(en.library.detail.shadowCopy.unknown)).toBeInTheDocument();
  });

  it('keeps where-from and also-in in one cell, and gives an absent row none', () => {
    const { row } = renderCoverage();

    // Agent, state, details: the third cell is the one that wraps.
    const shadowed = row('mangostudio');
    expect(shadowed.children).toHaveLength(3);
    const details = shadowed.children[2] as HTMLElement;
    expect(details).toHaveTextContent(en.library.detail.via);
    expect(details).toHaveTextContent('/home/dev/agents-skills');
    expect(details).toHaveTextContent(en.library.detail.alsoIn);
    expect(details).toHaveTextContent('/home/dev/claude-skills');
    // A badge, not a trailing word that can wrap onto a line of its own.
    expect(within(details).getByText(en.library.detail.shadowCopy.identical)).toBeInTheDocument();

    // No empty third cell: it would add a blank grid row on a phone.
    expect(row('codex').children).toHaveLength(2);
    expect(row('cursor').children).toHaveLength(2);
  });

  // The content cards above already set a path in mono; a section of the same
  // page that sets the same kind of text in the interface font disagrees with them.
  it('sets each path in mono on a line of its own, and the words around it in the interface font', () => {
    const { row } = renderCoverage();

    const details = row('mangostudio').children[2] as HTMLElement;
    const paths = [...details.querySelectorAll('.font-mono')];
    expect(paths.map((path) => path.textContent)).toEqual([
      '/home/dev/agents-skills',
      '/home/dev/claude-skills',
    ]);
    // A path is a block, so it never shares a line with the words that introduce it.
    for (const path of paths) expect(path.className).toContain('block');
    expect(details.querySelector('p')?.textContent).toBe(en.library.detail.via);
  });
});

describe('resource keys in words', () => {
  // `skill:release` is an internal id; the kind in front of the name is what keeps
  // it apart from `command:release`.
  it('names a resource by its kind and its name, never the internal id', () => {
    expect(resourceKeyLabel('skill:release', en.library.kinds)).toBe('Skill release');
    expect(resourceKeyLabel('command:release', en.library.kinds)).toBe('Command release');
  });

  it('fills a title with the kind inside the sentence and the name after it', () => {
    expect(resourceTitle(en.library.wizard.titleOne, en.library.kindsInline, 'skill:gh')).toBe(
      'Propagate skill gh'
    );
    expect(
      resourceTitle(en.library.removal.titleOne, en.library.kindsInline, 'subagent:planner')
    ).toBe('Remove subagent planner');
  });

  it('keeps a key that is not one as it came, without a gap where the kind would be', () => {
    expect(resourceKeyLabel('nonsense', en.library.kinds)).toBe('nonsense');
    expect(resourceTitle(en.library.wizard.titleOne, en.library.kindsInline, 'nonsense')).toBe(
      'Propagate nonsense'
    );
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
