/**
 * CopyCommandBlock's "Enable installs on this machine" affordance: it only
 * appears when the global switch is the entire problem, opens a confirm
 * dialog carrying the threat-model sentence, and reports what the write
 * actually did (applied, or held off by an env override).
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';
import { CopyCommandBlock } from '../../../../src/features/environments/components/CopyCommandBlock';
import { render, screen, waitFor } from '../../../support/harness/render';
import { installRecipe } from './fixtures';

const s = en.environments.install.enableInstalls;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CopyCommandBlock enable-installs affordance', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  it('offers the button only when disabled is the sole guard reason on the local machine', () => {
    const recipe = installRecipe({ guard: { allowed: false, reasons: ['disabled'] } });
    render(<CopyCommandBlock recipe={recipe} />);
    expect(screen.getByTestId('enable-installs-button')).toBeInTheDocument();
  });

  it('hides the button when another guard reason also blocks the recipe', () => {
    const recipe = installRecipe({
      guard: { allowed: false, reasons: ['disabled', 'server-not-loopback'] },
    });
    render(<CopyCommandBlock recipe={recipe} />);
    expect(screen.queryByTestId('enable-installs-button')).not.toBeInTheDocument();
  });

  it('hides the button when a missing requirement also blocks the recipe', () => {
    const recipe = installRecipe({
      guard: { allowed: false, reasons: ['disabled'] },
      missingRequirements: ['nvm'],
    });
    render(<CopyCommandBlock recipe={recipe} />);
    expect(screen.queryByTestId('enable-installs-button')).not.toBeInTheDocument();
  });

  it('hides the button for a remote environment', () => {
    const recipe = installRecipe({ guard: { allowed: false, reasons: ['disabled'] } });
    render(<CopyCommandBlock recipe={recipe} environmentId="dev-box" />);
    expect(screen.queryByTestId('enable-installs-button')).not.toBeInTheDocument();
  });

  it('opens a confirm dialog carrying the exact threat-model sentence', async () => {
    const recipe = installRecipe({ guard: { allowed: false, reasons: ['disabled'] } });
    render(<CopyCommandBlock recipe={recipe} />);
    await userEvent.click(screen.getByTestId('enable-installs-button'));

    expect(screen.getByRole('dialog').textContent).toContain(s.threatModel);
    expect(s.threatModel).toBe(
      'Enable this only for a MangoStudio process running on the same machine as its user. The setting does not override the local-surface checks that still apply.'
    );
  });

  it('writes the config and reports success', async () => {
    fetchMock.mockImplementation((input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/machine/config')) {
        return Promise.resolve(
          json({ applied: true, configFile: '/home/j/.mango/config.toml', installsEnabled: true })
        );
      }
      return Promise.resolve(json({}));
    });

    const recipe = installRecipe({ guard: { allowed: false, reasons: ['disabled'] } });
    render(<CopyCommandBlock recipe={recipe} />);
    await userEvent.click(screen.getByTestId('enable-installs-button'));
    await userEvent.click(screen.getByRole('button', { name: s.confirm }));

    await waitFor(() =>
      expect(screen.getByTestId('enable-installs-result').textContent).toBe(s.success)
    );
    const [configCall] = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/api/machine/config')
    );
    const init = configCall?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({
      environments: { installsEnabled: true },
    });
  });

  it('reports the env-override reason instead of claiming success', async () => {
    fetchMock.mockImplementation((input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/machine/config')) {
        return Promise.resolve(
          json({
            applied: false,
            configFile: '/home/j/.mango/config.toml',
            installsEnabled: false,
            reason: 'env-override',
          })
        );
      }
      return Promise.resolve(json({}));
    });

    const recipe = installRecipe({ guard: { allowed: false, reasons: ['disabled'] } });
    render(<CopyCommandBlock recipe={recipe} />);
    await userEvent.click(screen.getByTestId('enable-installs-button'));
    await userEvent.click(screen.getByRole('button', { name: s.confirm }));

    await waitFor(() =>
      expect(screen.getByTestId('enable-installs-result').textContent).toBe(s.envOverride)
    );
  });
});
