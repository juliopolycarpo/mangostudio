/**
 * Unit tests for SkillsSettingsPage component.
 */

import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_LIBRARY_LOCATION_SETTINGS,
  withLibraryLocations,
} from '@mangostudio/shared/app-settings';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsSettingsPage } from '../../../src/features/settings/skills/components/SkillsSettingsPage';
import { render, screen } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const SKILLS_RESPONSE = {
  skills: [
    {
      key: 'mango:pdf-tools',
      slug: 'pdf-tools',
      name: 'pdf-tools',
      description: 'Work with PDF files',
      source: 'mango',
      path: '/home/user/.mango/skills/pdf-tools',
      valid: true,
      enabled: true,
      shadowed: false,
    },
    {
      key: 'claude:pdf-tools',
      slug: 'pdf-tools',
      name: 'pdf-tools',
      description: 'Claude copy of the same skill',
      source: 'claude',
      path: '/home/user/.claude/skills/pdf-tools',
      valid: true,
      enabled: true,
      shadowed: true,
    },
    {
      key: 'mango:broken',
      slug: 'broken',
      name: 'broken',
      description: '',
      source: 'mango',
      path: '/home/user/.mango/skills/broken',
      valid: false,
      enabled: true,
      shadowed: false,
      error: 'SKILL.md not found in the skill directory.',
    },
  ],
  sources: {
    agents: { enabled: false, path: '/home/user/.agents/skills', exists: false },
    claude: { enabled: true, path: '/home/user/.claude/skills', exists: true },
  },
};

describe('SkillsSettingsPage', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  it('shows loading state', () => {
    render(<SkillsSettingsPage />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows error state with retry button', async () => {
    fetchScenario.respondWithJson('GET', '/api/skills', {
      status: 500,
      body: { error: 'Failed to load skills' },
    });

    render(<SkillsSettingsPage />);

    const retryButton = await screen.findByText(/retry/i);
    expect(retryButton).toBeInTheDocument();
  });

  it('renders source toggles and skill cards with badges', async () => {
    fetchScenario.respondWithJson('GET', '/api/skills', { body: SKILLS_RESPONSE });

    render(<SkillsSettingsPage />);

    await screen.findAllByText('pdf-tools');
    expect(screen.getByText('Skill sources')).toBeInTheDocument();
    expect(screen.getByText('/home/user/.agents/skills')).toBeInTheDocument();
    expect(screen.getByText(/directory not found/i)).toBeInTheDocument();

    expect(screen.getAllByText('pdf-tools')).toHaveLength(2);
    expect(screen.getByText('Shadowed')).toBeInTheDocument();
    expect(screen.getByText('Invalid')).toBeInTheDocument();
    expect(screen.getByText('SKILL.md not found in the skill directory.')).toBeInTheDocument();
  });

  it('shows the empty state when no skills are discovered', async () => {
    fetchScenario.respondWithJson('GET', '/api/skills', {
      body: { skills: [], sources: SKILLS_RESPONSE.sources },
    });

    render(<SkillsSettingsPage />);

    expect(await screen.findByText(/no skills installed/i)).toBeInTheDocument();
  });

  it('calls PUT endpoint when toggling a skill', async () => {
    const user = userEvent.setup();

    fetchScenario.respondWithJson('GET', '/api/skills', { body: SKILLS_RESPONSE });
    fetchScenario.respondWithJson('PUT', '/api/skills/mango:pdf-tools', {
      body: { ...SKILLS_RESPONSE.skills[0], enabled: false },
    });
    fetchScenario.respondWithJson('PUT', '/api/skills/mango%3Apdf-tools', {
      body: { ...SKILLS_RESPONSE.skills[0], enabled: false },
    });

    render(<SkillsSettingsPage />);

    await screen.findAllByText('pdf-tools');
    // Two cards share the name (mango winner + shadowed claude copy); the
    // mango copy renders first because the API sorts by key.
    const [checkbox] = screen.getAllByLabelText('pdf-tools', { selector: 'input' });
    await user.click(checkbox);

    await vi.waitFor(() => {
      const putCalls = fetchScenario.fetchMock.mock.calls.filter((call: unknown[]) => {
        const input = call[0];
        const init = call[1] as RequestInit | undefined;
        const method = input instanceof Request ? input.method : init?.method;
        const url = input instanceof Request ? input.url : String(input);
        const pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname);
        return method === 'PUT' && pathname === '/api/skills/mango:pdf-tools';
      });
      expect(putCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('writes source toggles through the app-settings endpoint', async () => {
    const user = userEvent.setup();

    fetchScenario.respondWithJson('GET', '/api/skills', { body: SKILLS_RESPONSE });
    fetchScenario.respondWithJson('GET', '/api/settings/app', { body: DEFAULT_APP_SETTINGS });
    fetchScenario.respondWithJson('PUT', '/api/settings/app', {
      body: withLibraryLocations(DEFAULT_APP_SETTINGS, DEFAULT_PROFILE_ID, {
        ...DEFAULT_LIBRARY_LOCATION_SETTINGS,
        home: {
          ...DEFAULT_LIBRARY_LOCATION_SETTINGS.home,
          'agents-skills': true,
          'claude-skills': true,
        },
      }),
    });

    render(<SkillsSettingsPage />);

    await screen.findAllByText('pdf-tools');
    const agentsToggle = screen.getByLabelText('Agents', { selector: 'input' });
    await user.click(agentsToggle);

    await vi.waitFor(() => {
      const putCalls = fetchScenario.fetchMock.mock.calls.filter((call: unknown[]) => {
        const input = call[0];
        const init = call[1] as RequestInit | undefined;
        const method = input instanceof Request ? input.method : init?.method;
        const url = input instanceof Request ? input.url : String(input);
        return (
          method === 'PUT' && new URL(url, 'http://localhost').pathname === '/api/settings/app'
        );
      });
      expect(putCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('forces a library rescan from the visible refresh control', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/skills', { body: SKILLS_RESPONSE });
    fetchScenario.respondWithJson('POST', '/api/library/rescan', {
      body: { resources: [], unreadableEntries: [] },
    });

    render(<SkillsSettingsPage />);

    await screen.findAllByText('pdf-tools');
    await user.click(screen.getByRole('button', { name: 'Refresh library' }));

    await vi.waitFor(() => {
      const postCalls = fetchScenario.fetchMock.mock.calls.filter((call: unknown[]) => {
        const input = call[0];
        const init = call[1] as RequestInit | undefined;
        const method = input instanceof Request ? input.method : init?.method;
        const url = input instanceof Request ? input.url : String(input);
        return (
          method === 'POST' && new URL(url, 'http://localhost').pathname === '/api/library/rescan'
        );
      });
      expect(postCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});
