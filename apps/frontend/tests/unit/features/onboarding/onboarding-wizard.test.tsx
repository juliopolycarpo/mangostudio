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
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { en } from '@mangostudio/shared/i18n';
import { screen, waitFor, within } from '@testing-library/react';
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
    scenario.respondWithJson('GET', '/api/chats/chat-1/messages?limit=50&order=desc', {
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

  it('keeps the reason a runner is unusable readable instead of fading the whole row', async () => {
    scenario.respondWithJson('GET', '/api/external-agents?environmentId=local', {
      body: {
        environmentId: 'local',
        agents: [
          {
            targetId: 'codex',
            environmentId: 'local',
            installed: true,
            discoveryState: 'determined',
            authState: 'signed-out',
            capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
            supportedConfigurations: [],
            discovery: { source: 'live', probedAtMs: 1_790_000_000_000, attempts: 1 },
          },
        ],
      },
    });

    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-step-agents')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('onboarding-step-agents'));

    const row = await screen.findByTestId('onboarding-runner-codex');
    expect(row).toBeDisabled();
    // No opacity anywhere: the status line is the one thing worth reading here.
    expect(row.className).not.toContain('opacity');
    const reason = within(row).getByText(en.onboarding.agents.signedOut);
    expect(reason).toHaveClass('text-fg-subtle');
    expect(reason).not.toHaveClass('truncate');
  });

  it('draws the runners as one hairline list and names the agent a sign-in command is for', async () => {
    scenario.respondWithJson('GET', '/api/external-agents?environmentId=local', {
      body: {
        environmentId: 'local',
        agents: [
          {
            targetId: 'codex',
            environmentId: 'local',
            installed: true,
            discoveryState: 'determined',
            authState: 'signed-in',
            capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
            supportedConfigurations: [],
            discovery: { source: 'live', probedAtMs: 1_790_000_000_000, attempts: 1 },
          },
          {
            targetId: 'claude',
            environmentId: 'local',
            installed: true,
            discoveryState: 'determined',
            authState: 'signed-out',
            loginCommand: 'claude auth login',
            capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
            supportedConfigurations: [],
            discovery: { source: 'live', probedAtMs: 1_790_000_000_000, attempts: 1 },
          },
        ],
      },
    });

    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-step-agents')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('onboarding-step-agents'));

    const claude = await screen.findByTestId('onboarding-runner-claude');
    const codex = screen.getByTestId('onboarding-runner-codex');
    // Rows divided by hairlines, the way the toolchain step lists its runtimes:
    // no bordered box per runner.
    for (const row of [claude, codex]) {
      expect(row).not.toHaveClass('border');
      expect(row).not.toHaveClass('bg-control');
    }
    expect(claude.closest('ul')).toHaveClass('divide-y', 'divide-stroke');
    // Each is led by the runner's own hue.
    expect(claude.querySelector('[data-tone]')).toHaveClass('bg-agent-claude');
    expect(codex.querySelector('[data-tone]')).toHaveClass('bg-agent-codex');

    // The command is nested under the one row it belongs to and says whose it is,
    // although Codex is listed above it.
    const command = screen.getByText('claude auth login');
    expect(claude.closest('li')).toContainElement(command);
    expect(codex.closest('li')).not.toContainElement(command);
    expect(
      screen.getByText(/^Claude Code: sign in from a terminal/, { exact: false })
    ).toBeInTheDocument();
  });

  it('refuses a second skip while the first write is still open', async () => {
    // Every write is built on the cached record, and nothing is cached until
    // the server answers: a second click during the first PUT would send the
    // state from before it, dropping the skip that is already in flight.
    hangEveryPut();
    // Past the welcome step, which has nothing to skip: the first step that is
    // still asking something is the folder.
    scenario.respondWithJson('GET', '/api/settings/app', {
      body: settingsWith({ welcomeAcknowledged: true }),
    });

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

  it('prints every runtime version in one form, without the prefix Node reports', async () => {
    const installation = (version: string) => ({
      path: '/usr/bin/runtime',
      rawPath: '/usr/bin/runtime',
      version,
      origin: 'path',
      effective: true,
    });
    scenario.respondWithJson('GET', '/api/environments/runtimes', {
      body: [
        {
          id: 'node',
          health: 'ok',
          installations: [],
          findings: [],
          effective: installation('v22.22.0'),
        },
        {
          id: 'bun',
          health: 'ok',
          installations: [],
          findings: [],
          effective: installation('1.4.2'),
        },
      ],
    });

    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-step-toolchain')).toBeInTheDocument()
    );
    await userEvent.click(screen.getByTestId('onboarding-step-toolchain'));

    const node = await screen.findByTestId('onboarding-runtime-node');
    await waitFor(() => expect(node).toHaveTextContent('22.22.0'));
    expect(node).not.toHaveTextContent('v22');
    expect(screen.getByTestId('onboarding-runtime-bun')).toHaveTextContent('1.4.2');
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

  it('holds the exits while the first-chat step is storing the chat it created', async () => {
    // The step writes `chatId` built on the record as it read it. A Finish or a
    // Skip landing inside that window would be overwritten, and the account
    // would be bounced back through the gate it just left.
    scenario.respondWithJson('GET', '/api/settings/app', {
      body: settingsWith({ welcomeAcknowledged: true, workdir: '/home/dev/project' }),
    });
    if (!respondFromScenario) throw new Error('scenario fetch mock has no implementation');
    const respond = respondFromScenario;
    scenario.fetchMock.mockImplementation((input, init) => {
      // Chat creation never answers: that is the whole window under test.
      if (String(init?.method).toUpperCase() === 'POST' && String(input).includes('/api/chats')) {
        return new Promise<Response>(() => undefined);
      }
      return respond(input, init);
    });

    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-step-chat')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('onboarding-step-chat'));
    await waitFor(() => expect(screen.getByTestId('onboarding-send-prompt')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('onboarding-send-prompt'));

    await waitFor(() => expect(screen.getByTestId('onboarding-skip-all')).toBeDisabled());
    expect(screen.getByTestId('onboarding-skip-step')).toBeDisabled();
  });

  it('has nothing to go back to on the first step, and a Back control on every other', async () => {
    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-continue')).toBeInTheDocument());
    expect(screen.queryByTestId('onboarding-back')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('onboarding-continue'));

    await waitFor(() => expect(screen.getByTestId('onboarding-back')).toBeEnabled());
  });

  it('draws the whole footer row at one height, so no border sits inside another button', async () => {
    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-continue')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('onboarding-continue'));
    await waitFor(() => expect(screen.getByTestId('onboarding-back')).toBeEnabled());

    for (const id of ['onboarding-back', 'onboarding-skip-step', 'onboarding-continue']) {
      expect(screen.getByTestId(id)).toHaveClass('h-10');
    }
  });

  it('names the step in the progress line, which is all a phone gets of the step list', async () => {
    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-continue')).toBeInTheDocument());
    const welcomeLine = screen.getByText(`Step 1 of 6 · ${en.onboarding.steps.welcome}`, {
      exact: false,
    });
    expect(welcomeLine).toBeInTheDocument();
    // From `sm` up the step list beside the card says the same thing, so the
    // line is for the phone alone.
    expect(welcomeLine).toHaveClass('sm:hidden');

    await userEvent.click(screen.getByTestId('onboarding-continue'));

    await waitFor(() =>
      expect(
        screen.getByText(`Step 2 of 6 · ${en.onboarding.steps.folder}`, { exact: false })
      ).toBeInTheDocument()
    );
    // The list itself is for `sm` and up: it is in the document, behind a class.
    expect(screen.getByRole('navigation', { name: en.onboarding.stepList })).toHaveClass('hidden');
  });

  it('keeps one primary in the folder step: the step\u2019s own until a folder is chosen', async () => {
    scenario.respondWithJson('GET', '/api/settings/app', {
      body: settingsWith({ welcomeAcknowledged: true }),
    });

    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-step-folder')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('onboarding-step-folder'));
    await waitFor(() => expect(screen.getByTestId('onboarding-choose-folder')).toBeInTheDocument());

    expect(screen.getByTestId('onboarding-choose-folder')).toHaveClass('bg-accent');
    expect(screen.getByTestId('onboarding-continue')).not.toHaveClass('bg-accent');
    // Stepping down changes the look and nothing else: setup stays skippable.
    expect(screen.getByTestId('onboarding-continue')).toBeEnabled();
  });

  it('hands the primary to Continue once the folder is chosen', async () => {
    scenario.respondWithJson('GET', '/api/settings/app', {
      body: settingsWith({ welcomeAcknowledged: true, workdir: '/home/dev/project' }),
    });

    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-step-folder')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('onboarding-step-folder'));
    await waitFor(() => expect(screen.getByTestId('onboarding-choose-folder')).toBeInTheDocument());

    expect(screen.getByTestId('onboarding-choose-folder')).not.toHaveClass('bg-accent');
    expect(screen.getByTestId('onboarding-continue')).toHaveClass('bg-accent');
  });

  it('puts Send ahead of Open MangoStudio on the first-chat step until the prompt is answered', async () => {
    scenario.respondWithJson('GET', '/api/settings/app', {
      body: settingsWith({ welcomeAcknowledged: true, workdir: '/home/dev/project' }),
    });

    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-step-chat')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('onboarding-step-chat'));
    await waitFor(() => expect(screen.getByTestId('onboarding-send-prompt')).toBeInTheDocument());

    expect(screen.getByTestId('onboarding-send-prompt')).toHaveClass('bg-accent');
    expect(screen.getByTestId('onboarding-continue')).not.toHaveClass('bg-accent');
  });

  it('advances past a skipped step and remembers the skip', async () => {
    scenario.respondWithJson('GET', '/api/settings/app', {
      body: settingsWith({ welcomeAcknowledged: true }),
    });
    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/folder/i)
    );

    await userEvent.click(screen.getByTestId('onboarding-skip-step'));

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/toolchain/i)
    );
    const put = scenario.fetchMock.mock.calls.find(
      (call) => String(call[1]?.method).toUpperCase() === 'PUT'
    );
    const body = JSON.parse(String(put?.[1]?.body)) as {
      profileSettings: { default: { onboarding: { skippedSteps: string[] } } };
    };
    expect(body.profileSettings.default.onboarding.skippedSteps).toEqual(['folder']);
  });

  it('offers no skip on the welcome step, which asks nothing', async () => {
    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-continue')).toBeInTheDocument());

    expect(screen.getByTestId('onboarding-continue')).toHaveTextContent(
      en.onboarding.welcome.action
    );
    expect(screen.queryByTestId('onboarding-skip-step')).not.toBeInTheDocument();
  });

  it('offers no skip on a step the machine already satisfies', async () => {
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
    // Resume lands on the toolchain, the first step the machine cannot satisfy.
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/toolchain/i)
    );
    expect(screen.getByTestId('onboarding-skip-step')).toBeInTheDocument();

    // The folder is done: the person can look at it, and Continue is the way on.
    await userEvent.click(screen.getByTestId('onboarding-step-folder'));
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/folder/i)
    );
    expect(screen.queryByTestId('onboarding-skip-step')).not.toBeInTheDocument();
    expect(screen.getByTestId('onboarding-continue')).toBeEnabled();
  });

  it('keeps both account-level exits together in the header, off the card', async () => {
    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-skip-all')).toBeInTheDocument());

    const header = screen.getByRole('banner');
    expect(within(header).getByTestId('onboarding-skip-all')).toBeInTheDocument();
    expect(within(header).getByTestId('logout-button')).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-skip-all').parentElement).toBe(
      screen.getByTestId('logout-button').parentElement
    );
    // One title in the header: the step's own headline says the rest.
    expect(within(header).getAllByRole('heading')).toHaveLength(1);
  });

  it('puts a way back to the folder step on the notice that says there is none', async () => {
    scenario.respondWithJson('GET', '/api/settings/app', {
      body: settingsWith({ welcomeAcknowledged: true }),
    });
    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-step-chat')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('onboarding-step-chat'));

    const notice = await screen.findByTestId('onboarding-chat-needs-folder');
    // Nowhere to send a message yet, so the field does not invite one.
    expect(screen.getByTestId('onboarding-prompt')).toBeDisabled();
    expect(screen.getByTestId('onboarding-send-prompt')).toBeDisabled();

    await userEvent.click(
      within(notice).getByRole('button', { name: en.onboarding.chat.goToFolder })
    );

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/folder/i)
    );
  });

  it('lets the first message be written once there is a folder to send it in', async () => {
    scenario.respondWithJson('GET', '/api/settings/app', {
      body: settingsWith({ welcomeAcknowledged: true, workdir: '/home/dev/project' }),
    });
    render(<OnboardingWizard onDone={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-step-chat')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('onboarding-step-chat'));

    await waitFor(() => expect(screen.getByTestId('onboarding-prompt')).toBeEnabled());
    expect(screen.queryByTestId('onboarding-chat-needs-folder')).not.toBeInTheDocument();
  });
});
