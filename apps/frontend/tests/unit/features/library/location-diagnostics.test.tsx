import { afterEach, expect, it } from 'bun:test';

import { en, ptBR } from '@mangostudio/shared/i18n';

import { LocationDiagnostics } from '../../../../src/features/library/components/LocationDiagnostics';
import { render, screen } from '../../../support/harness/render';

afterEach(() => localStorage.removeItem('mangostudio:locale'));

it('renders nothing for a confirmed successful empty scan', () => {
  render(<LocationDiagnostics diagnostics={[]} />);
  expect(screen.queryByText(en.library.scanDiagnostics.heading)).not.toBeInTheDocument();
});

it('warns that legacy results cannot distinguish failure from absence', () => {
  render(<LocationDiagnostics diagnostics={undefined} />);
  expect(document.body).toHaveTextContent(en.library.scanDiagnostics.legacy);
});

for (const [locale, messages] of [
  ['en', en],
  ['pt-BR', ptBR],
] as const) {
  it(`reports each location failure in ${locale}`, () => {
    localStorage.setItem('mangostudio:locale', locale);
    render(
      <LocationDiagnostics
        diagnostics={[
          { locationId: 'mango-skills', reason: 'permission-denied' },
          { locationId: 'claude-commands', reason: 'not-directory' },
          { locationId: 'agents-skills', reason: 'unreadable' },
        ]}
      />
    );
    for (const message of Object.values(messages.library.scanDiagnostics.reason)) {
      expect(document.body).toHaveTextContent(message);
    }
  });
}
