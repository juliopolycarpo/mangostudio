import userEvent from '@testing-library/user-event';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '../../../src/components/SettingsPage';
import { EMPTY_GEMINI_MODEL_CATALOG } from '../../../src/utils/gemini-models';
import { render, screen, waitFor } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

function createDefaultProps() {
  return {
    textSystemPrompt: '',
    setTextSystemPrompt: vi.fn(),
    imageSystemPrompt: '',
    setImageSystemPrompt: vi.fn(),
    imageQuality: 'balanced',
    setImageQuality: vi.fn(),
    textModel: '',
    setTextModel: vi.fn(),
    imageModel: '',
    setImageModel: vi.fn(),
    geminiModelCatalog: EMPTY_GEMINI_MODEL_CATALOG,
    reloadGeminiModelCatalog: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SettingsPage', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  it('loads the Gemini secret status and saves a new API key', async () => {
    const props = createDefaultProps();
    const user = userEvent.setup();

    fetchScenario
      .respondWithJson('GET', '/api/settings/secrets/gemini', {
        body: {
          provider: 'gemini',
          configured: false,
          source: 'none',
          storageAvailable: true,
        },
      })
      .respondWithJson('PUT', '/api/settings/secrets/gemini', {
        body: {
          provider: 'gemini',
          configured: true,
          source: 'bun-secrets',
          storageAvailable: true,
          maskedSuffix: '1234',
        },
      });

    render(<SettingsPage {...props} />);

    await screen.findByText('Not Configured');

    await user.type(screen.getByPlaceholderText('Paste a Gemini API key'), 'test-key-1234');
    await user.click(screen.getByRole('button', { name: /save key/i }));

    await screen.findByText('Gemini API key saved securely.');
    await waitFor(() => expect(props.reloadGeminiModelCatalog).toHaveBeenCalledTimes(1));

    expect(screen.getByText('Stored Securely')).toBeInTheDocument();
    expect(screen.getByText('****1234')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Paste a Gemini API key')).toHaveValue('');
    expect(fetchScenario.fetchMock).toHaveBeenCalledTimes(2);
  });
});
