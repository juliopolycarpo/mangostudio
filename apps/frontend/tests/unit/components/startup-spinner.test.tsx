import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { StartupSpinner } from '../../../src/components/layout/StartupSpinner';
import { render, screen } from '../../support/harness/render';

/**
 * The spinner stands in for the dictionary itself, so it cannot ask the i18n
 * context for its name: it renders outside the provider. It reads the startup
 * locale's dictionary from the store, and English until that has landed.
 */
describe('StartupSpinner', () => {
  beforeEach(() => {
    window.localStorage.setItem('mangostudio:locale', 'en');
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('is a named status, so a screen reader hears that the app is starting', () => {
    render(<StartupSpinner />);

    // The status is the spinner itself: it carries the name, so the screen
    // around it is a plain container and there is one live region, not two.
    const status = screen.getByRole('status');
    expect(screen.getByTestId('startup-spinner')).toContainElement(status);
    expect(status).toHaveTextContent('Loading…');
    expect(screen.getByText('Loading…')).toHaveClass('sr-only');
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('falls back to English while the stored language has not loaded', () => {
    // The Portuguese chunk is not preloaded in a unit test, which is exactly
    // the moment the spinner stands in for.
    window.localStorage.setItem('mangostudio:locale', 'pt-BR');

    render(<StartupSpinner />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });
});
