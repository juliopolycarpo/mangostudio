/**
 * The flow's own behaviour, as a person meets it.
 *
 * Three properties are worth pinning here and are invisible from the shared
 * resume rules: where the wizard opens is decided once and then left alone,
 * skipping the whole thing records completion without sending anything, and a
 * step that cannot be acted on from this browser is not something the flow
 * stops at.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { DEFAULT_APP_SETTINGS, onboardingFor } from '@mangostudio/shared/app-settings';
import { en } from '@mangostudio/shared/i18n';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

mock.module('@/lib/realtime/realtime-client', () => ({
  bindRealtimeClientToUser: jest.fn(),
  resetRealtimeClient: jest.fn(),
  getRealtimeClient: () => ({ subscribe: () => () => undefined }),
}));

const { OnboardingWizard } = await import('@/features/onboarding/OnboardingWizard');

const scenario = createFetchScenario();

/**
 * The scenario's own responder, taken before any test swaps it. A test that
 * needs a request left hanging replaces the implementation on a mock the whole
 * file shares, so `afterEach` has to be able to put this one back.
 */
const respondFromScenario = scenario.fetchMock.getMockImplementation();

/** A machine with nothing on it, so every step's fact is a definite "no". */
function emptyMachine() {
  scenario
    .respondWithJson('GET', '/api/environments', { body: [] })
    .respondWithJson('GET', '/api/environments/runtimes', { body: [] })
    .respondWithJson('GET', '/api/environments/install-recipes', { body: [] })
    .respondWithJson('GET', '/api/external-agents', { body: { agents: [] } })
    .respondWithJson('GET', '/api/settings/models', {
      body: {
        configured: false,
        status: 'unconfigured',
        allModels: [],
        textModels: [],
        imageModels: [],
        discoveredTextModels: [],
        discoveredImageModels: [],
      },
    })
    .respondWithJson('GET', '/api/machine/status', { body: machineStatus() });
}

function machineStatus() {
  return {
    hub: {
      running: true,
      pid: 1,
      host: '127.0.0.1',
      port: 3001,
      launch: 'foreground',
      uptimeMs: 1,
    },
    service: {
      installed: false,
      enabled: false,
      running: false,
      platform: 'linux',
      unitName: 'mangostudio',
      error: null,
      errorCode: null,
    },
    runtimeBinary: { kind: 'binary', path: '/usr/bin/mangostudio', version: '0.1.1' },
    hostSlot: { present: false, profile: 'full', directory: '', error: null },
    platform: 'linux',
    standalone: true,
    container: false,
    homeDir: '/home/dev/.mango',
    logsDir: '/home/dev/.mango/logs',
    configFile: null,
    actions: {
      guard: { allowed: false, reasons: ['client-not-loopback'] },
      restart: { available: false, command: 'mangostudio restart', reason: 'guard' },
      installService: { available: false, command: 'mangostudio service install', reason: 'guard' },
      uninstallService: {
        available: false,
        command: 'mangostudio service uninstall',
        reason: 'guard',
      },
    },
  };
}

/** Leave every settings write open, so the window a guard covers stays open too. */
function hangEveryPut(): void {
  if (!respondFromScenario) throw new Error('scenario fetch mock has no implementation');
  const respond = respondFromScenario;
  scenario.fetchMock.mockImplementation((input, init) => {
    if (String(init?.method).toUpperCase() === 'PUT') return new Promise<Response>(() => undefined);
    return respond(input, init);
  });
}

function settingsWith(onboarding: Record<string, unknown>) {
  return {
    ...DEFAULT_APP_SETTINGS,
    profileSettings: {
      default: {
        ...DEFAULT_APP_SETTINGS.profileSettings.default,
        onboarding: { ...onboardingFor(DEFAULT_APP_SETTINGS), ...onboarding },
      },
    },
  };
}

beforeEach(() => {
  scenario.respondWithJson('GET', '/api/settings/app', { body: DEFAULT_APP_SETTINGS });
  scenario.respondWithJson('PUT', '/api/settings/app', { body: DEFAULT_APP_SETTINGS });
  emptyMachine();
  scenario.install();
});

afterEach(() => {
  if (respondFromScenario) scenario.fetchMock.mockImplementation(respondFromScenario);
  scenario.restore();
});

describe('OnboardingWizard', () => {
  it('opens a brand-new account at the welcome step', async () => {
    render(<OnboardingWizard onDone={() => undefined} />);

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
        /runs coding agents on your own machine/i
      )
    );
  });

  it('records completion and returns without sending anything when the whole flow is skipped', async () => {
    const onDone = jest.fn();
    render(<OnboardingWizard onDone={onDone} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-skip-all')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('onboarding-skip-all'));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const put = scenario.fetchMock.mock.calls.find(
      (call) => String(call[1]?.method).toUpperCase() === 'PUT'
    );
    const body = JSON.parse(String(put?.[1]?.body)) as {
      profileSettings: { default: { onboarding: { completedAt?: number } } };
    };
    expect(body.profileSettings.default.onboarding.completedAt).toBeGreaterThan(0);

    // Nothing about a chat: skipping is not a send.
    expect(
      scenario.fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/respond/stream'))
    ).toBe(false);
  });

  it('reopens a resumed flow at the first step the machine cannot satisfy', async () => {
    scenario.respondWithJson('GET', '/api/settings/app', {
      body: settingsWith({
        welcomeAcknowledged: true,
        workdir: '/home/dev/project',
        environmentId: 'local',
      }),
    });
    scenario.respondWithJson('GET', '/api/environments', {
      body: [
        {
          id: 'local',
          name: 'Local',
          kind: 'local',
          transportKind: 'local',
          status: { state: 'connected' },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    render(<OnboardingWizard onDone={() => undefined} />);

    // Folder is satisfied — the environment exists and a path is stored — so
    // the toolchain is the first real question left.
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/toolchain/i)
    );
  });

  it('says a step is not available here rather than leaving it looking unfinished', async () => {
    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-step-service')).toBeInTheDocument());

    await waitFor(() =>
      expect(
        screen.getByTestId('onboarding-step-service').querySelector('[data-status]')
      ).toHaveAttribute('data-status', 'unavailable')
    );
  });

  it('keeps the way out reachable while the machine has not answered', async () => {
    // A refused probe reads as `unknown` for as long as it keeps failing, and
    // resume will not guess past it. That must not take the page with it: skip
    // and sign out are the only exits a half-configured account has.
    scenario.respondWithJson('GET', '/api/settings/app', {
      body: settingsWith({ welcomeAcknowledged: true }),
    });
    scenario.respondWithJson('GET', '/api/environments', { body: {}, status: 500 });

    render(<OnboardingWizard onDone={() => undefined} />);

    await waitFor(() => expect(screen.getByTestId('onboarding-deciding')).toBeInTheDocument());
    expect(screen.getByTestId('onboarding-skip-all')).toBeInTheDocument();
    expect(screen.getByTestId('logout-button')).toBeInTheDocument();
    expect(
      screen.getByTestId('onboarding-step-folder').querySelector('[data-status]')
    ).toHaveAttribute('data-status', 'unknown');
  });

  it('opens the step a person picks out of the list while the machine is still quiet', async () => {
    scenario.respondWithJson('GET', '/api/settings/app', {
      body: settingsWith({ welcomeAcknowledged: true }),
    });
    scenario.respondWithJson('GET', '/api/environments', { body: {}, status: 500 });

    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-step-toolchain')).toBeInTheDocument()
    );

    await userEvent.click(screen.getByTestId('onboarding-step-toolchain'));

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/toolchain/i)
    );
  });

  it('finishes the run before sending someone to the chat it created', async () => {
    // `/` is behind the gate that sent this person here. Leaving for it without
    // recording completion is a round trip straight back into this wizard, and
    // it is the escape hatch a turn that failed server-side depends on.
    const onDone = jest.fn();
    scenario.respondWithJson('GET', '/api/settings/app', {
      body: settingsWith({
        welcomeAcknowledged: true,
        workdir: '/home/dev/project',
        chatId: 'chat-1',
      }),
    });
    scenario.respondWithJson('GET', '/api/chats/chat-1/messages?limit=50', {
      body: { messages: [], nextCursor: null },
    });

    render(<OnboardingWizard onDone={onDone} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-step-chat')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('onboarding-step-chat'));
    await waitFor(() => expect(screen.getByTestId('onboarding-open-chat')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('onboarding-open-chat'));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith('/'));
    const put = scenario.fetchMock.mock.calls.find(
      (call) => String(call[1]?.method).toUpperCase() === 'PUT'
    );
    expect(put).toBeDefined();
    const body = JSON.parse(String(put?.[1]?.body)) as {
      profileSettings: { default: { onboarding: { completedAt?: number } } };
    };
    expect(body.profileSettings.default.onboarding.completedAt).toBeGreaterThan(0);
  });

  it('says the machine could not be asked rather than that it has no agent CLIs', async () => {
    // A refused probe and a machine with nothing installed both arrive as an
    // empty list. Only one of them is an answer, and telling somebody who has
    // Claude Code and Codex on this box that none were found sends them to
    // install what they already have.
    scenario.respondWithJson('GET', '/api/external-agents', { body: {}, status: 500 });

    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-step-agents')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('onboarding-step-agents'));

    await waitFor(() => expect(screen.getByTestId('onboarding-agents-failed')).toBeInTheDocument());
    expect(screen.queryByText(en.onboarding.agents.noneFound)).not.toBeInTheDocument();
  });

  it('refuses a second skip while the first write is still open', async () => {
    // Every write is built on the cached record, and nothing is cached until
    // the server answers: a second click during the first PUT would send the
    // state from before it, dropping the skip that is already in flight.
    hangEveryPut();

    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-skip-step')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('onboarding-skip-step'));

    await waitFor(() => expect(screen.getByTestId('onboarding-skip-step')).toBeDisabled());
    expect(screen.getByTestId('onboarding-skip-all')).toBeDisabled();
  });

  it('says the machine could not be asked rather than that it has no runtimes', async () => {
    // The same lie the agents step stopped telling: a refused probe and a
    // machine with neither runtime both arrive as an empty list, and only one
    // of them is grounds for offering to install Node.
    scenario.respondWithJson('GET', '/api/environments/runtimes', { body: {}, status: 500 });

    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-step-toolchain')).toBeInTheDocument()
    );
    await userEvent.click(screen.getByTestId('onboarding-step-toolchain'));

    await waitFor(() =>
      expect(screen.getByTestId('onboarding-toolchain-failed')).toBeInTheDocument()
    );
    expect(screen.queryByTestId('onboarding-runtime-node')).not.toBeInTheDocument();
  });

  it('refuses to open the folder picker while a write is still open', async () => {
    // The picker writes the chosen path onto the record it was opened against,
    // so a path chosen during an earlier write would be built on the state that
    // write is replacing.
    hangEveryPut();
    scenario.respondWithJson('GET', '/api/settings/app', {
      body: settingsWith({ welcomeAcknowledged: true }),
    });

    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-step-folder')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('onboarding-step-folder'));
    await waitFor(() => expect(screen.getByTestId('onboarding-choose-folder')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('onboarding-skip-step'));

    await waitFor(() => expect(screen.getByTestId('onboarding-choose-folder')).toBeDisabled());
  });

  it('advances past a skipped step and remembers the skip', async () => {
    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-skip-step')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('onboarding-skip-step'));

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/folder/i)
    );
    const put = scenario.fetchMock.mock.calls.find(
      (call) => String(call[1]?.method).toUpperCase() === 'PUT'
    );
    const body = JSON.parse(String(put?.[1]?.body)) as {
      profileSettings: { default: { onboarding: { skippedSteps: string[] } } };
    };
    expect(body.profileSettings.default.onboarding.skippedSteps).toEqual(['welcome']);
  });
});
