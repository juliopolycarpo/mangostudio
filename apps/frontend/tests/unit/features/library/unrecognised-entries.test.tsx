/**
 * UnrecognisedEntries: the channel for a name that fails the library-wide
 * slug pattern (#705) and can never appear as a resource row.
 */

import { en, ptBR } from '@mangostudio/shared/i18n';
import type { LibraryUnreadableEntry } from '@mangostudio/shared/library';
import { afterEach, describe, expect, it } from 'vitest';
import { UnrecognisedEntries } from '../../../../src/features/library/components/UnrecognisedEntries';
import { render, screen } from '../../../support/harness/render';
import { location } from './fixtures';

const LOCALE_STORAGE_KEY = 'mangostudio:locale';

afterEach(() => {
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

const entry: LibraryUnreadableEntry = {
  locationId: 'agents-skills',
  name: 'my skill',
  reason: 'invalid-name',
};

describe('UnrecognisedEntries', () => {
  it('renders nothing when there are no unreadable entries', () => {
    render(<UnrecognisedEntries entries={[]} locations={[location()]} />);

    expect(screen.queryByTestId('library-unreadable-entries')).not.toBeInTheDocument();
  });

  it('renders the raw name as text and the localized reason, grouped by location', () => {
    render(
      <UnrecognisedEntries
        entries={[entry]}
        locations={[location({ id: 'agents-skills', path: '/home/dev/.agents/skills' })]}
      />
    );

    const section = screen.getByTestId('library-unreadable-entries');
    expect(section).toHaveTextContent('my skill');
    expect(section).toHaveTextContent(en.library.unreadable.reason['invalid-name']);
    expect(section).toHaveTextContent('/home/dev/.agents/skills');
    expect(section).toHaveTextContent(en.library.unreadable.rule);
  });

  it('renders in pt-BR', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');

    render(<UnrecognisedEntries entries={[entry]} locations={[location()]} />);

    const section = screen.getByTestId('library-unreadable-entries');
    expect(section).toHaveTextContent('my skill');
    expect(section).toHaveTextContent(ptBR.library.unreadable.reason['invalid-name']);
    expect(section).toHaveTextContent(ptBR.library.unreadable.heading);
  });
});
