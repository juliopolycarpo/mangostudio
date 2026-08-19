/**
 * SettingsSourcePanel: the files behind the comparison, and the only screen an
 * `omitted` marker can reach.
 *
 * The concept comparison keeps the handful of paths its concepts name, and no
 * key the snapshot refuses to walk is one of them — so if this panel dropped the
 * markers too, the API would be reporting them to nobody.
 */

import { en, ptBR } from '@mangostudio/shared/i18n';
import type { SettingsSnapshot } from '@mangostudio/shared/library';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsSourcePanel } from '../../../../src/features/library/components/SettingsComparison';
import { render, screen, within } from '../../../support/harness/render';

const LOCALE_STORAGE_KEY = 'mangostudio:locale';

afterEach(() => {
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

const label = (locationId: string) => `~/.config/${locationId}`;

const snapshot: SettingsSnapshot = {
  targetId: 'claude',
  sources: [
    {
      locationId: 'claude-settings',
      kind: 'setting',
      present: true,
      parsed: true,
      sizeBytes: 128,
      fields: [
        { path: 'model', presentation: 'value', value: 'opus' },
        { path: 'apiKeyHelper', presentation: 'redacted' },
        { path: 'authInfo', presentation: 'omitted' },
        { path: 'projects.~/mango.sessionState', presentation: 'omitted' },
      ],
    },
    {
      locationId: 'claude-hooks',
      kind: 'hook',
      present: false,
      parsed: false,
      fields: [],
    },
  ],
};

describe('SettingsSourcePanel', () => {
  it('renders nothing when no target read a settings file', () => {
    render(
      <SettingsSourcePanel
        snapshots={[{ targetId: 'cursor', sources: [] }]}
        locationLabel={label}
      />
    );

    expect(screen.queryByTestId('settings-sources')).not.toBeInTheDocument();
  });

  it('shows every omitted subtree the comparison would have filtered away', () => {
    render(<SettingsSourcePanel snapshots={[snapshot]} locationLabel={label} />);

    const source = screen.getByTestId('settings-sources');
    const omitted = within(source)
      .getAllByTestId('settings-field')
      .filter((field) => field.dataset.presentation === 'omitted');

    expect(omitted).toHaveLength(2);
    expect(omitted[0]).toHaveTextContent('authInfo');
    expect(omitted[1]).toHaveTextContent('projects.~/mango.sessionState');
    for (const field of omitted) {
      expect(field).toHaveTextContent(en.library.settings.presentation.omitted);
    }
  });

  it('leaves values and redactions to the comparison above it', () => {
    render(<SettingsSourcePanel snapshots={[snapshot]} locationLabel={label} />);

    const source = screen.getByTestId('settings-sources');
    expect(source).not.toHaveTextContent('opus');
    expect(source).not.toHaveTextContent(en.library.settings.presentation.redacted);
  });

  it('names a file that does not exist rather than hiding the row', () => {
    render(<SettingsSourcePanel snapshots={[snapshot]} locationLabel={label} />);

    const rows = screen.getAllByTestId('settings-source');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveAttribute('data-location-id', 'claude-hooks');
    expect(rows[1]).toHaveTextContent('~/.config/claude-hooks');
    expect(rows[1]).toHaveTextContent(en.library.settings.sourceAbsent);
  });

  it('reports why a present file could not be parsed', () => {
    render(
      <SettingsSourcePanel
        snapshots={[
          {
            targetId: 'codex',
            sources: [
              {
                locationId: 'codex-settings',
                kind: 'setting',
                present: true,
                parsed: false,
                failureReason: 'invalid-toml',
                fields: [],
              },
            ],
          },
        ]}
        locationLabel={label}
      />
    );

    const row = screen.getByTestId('settings-source');
    expect(row).toHaveTextContent(en.library.settings.parseFailure['invalid-toml']);
    expect(row).not.toHaveTextContent(en.library.settings.sourceAbsent);
  });

  it('renders in pt-BR', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');

    render(<SettingsSourcePanel snapshots={[snapshot]} locationLabel={label} />);

    const source = screen.getByTestId('settings-sources');
    expect(source).toHaveTextContent(ptBR.library.settings.sourceHeading);
    expect(source).toHaveTextContent(ptBR.library.settings.presentation.omitted);
  });
});
