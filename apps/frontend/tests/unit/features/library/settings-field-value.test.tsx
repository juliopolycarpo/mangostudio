/**
 * The three presentations a settings field can arrive in (#713).
 *
 * A setting nobody configured never reaches this component — it is simply not
 * in the list. So the row that matters is `omitted`: it exists only to say
 * "there is something here and it is deliberately not shown", and if it reads
 * the same as `redacted`, the marker bought nothing.
 */

import { en, ptBR } from '@mangostudio/shared/i18n';
import type { SettingsField } from '@mangostudio/shared/library';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsFieldValue } from '../../../../src/features/library/components/SettingsComparison';
import { render, screen } from '../../../support/harness/render';

const LOCALE_STORAGE_KEY = 'mangostudio:locale';

afterEach(() => {
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

const omitted: SettingsField = { path: 'authInfo', presentation: 'omitted' };
const redacted: SettingsField = { path: 'apiKey', presentation: 'redacted' };

describe('SettingsFieldValue', () => {
  it('renders a value verbatim under its path', () => {
    render(<SettingsFieldValue field={{ path: 'model', presentation: 'value', value: 'opus' }} />);

    const field = screen.getByTestId('settings-field');
    expect(field).toHaveAttribute('data-presentation', 'value');
    expect(field).toHaveTextContent('model');
    expect(field).toHaveTextContent('opus');
  });

  it('says an omitted subtree is present without saying anything about it', () => {
    render(<SettingsFieldValue field={omitted} />);

    const field = screen.getByTestId('settings-field');
    expect(field).toHaveAttribute('data-presentation', 'omitted');
    expect(field).toHaveTextContent('authInfo');
    expect(field).toHaveTextContent(en.library.settings.presentation.omitted);
  });

  it('reads differently from a redacted value in both locales', () => {
    expect(en.library.settings.presentation.omitted).not.toBe(
      en.library.settings.presentation.redacted
    );
    expect(ptBR.library.settings.presentation.omitted).not.toBe(
      ptBR.library.settings.presentation.redacted
    );

    const { rerender } = render(<SettingsFieldValue field={omitted} />);
    const omittedText = screen.getByTestId('settings-field').textContent;
    rerender(<SettingsFieldValue field={redacted} />);

    expect(screen.getByTestId('settings-field').textContent).not.toBe(omittedText);
  });

  it('renders in pt-BR', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');

    render(<SettingsFieldValue field={omitted} />);

    const field = screen.getByTestId('settings-field');
    expect(field).toHaveTextContent(ptBR.library.settings.presentation.omitted);
    expect(field).not.toHaveTextContent(ptBR.library.settings.presentation.redacted);
  });
});
