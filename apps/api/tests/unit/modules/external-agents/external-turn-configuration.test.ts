import { describe, expect, it } from 'bun:test';
import type {
  ExternalAgentDescriptor,
  ExternalAgentSettings,
} from '@mangostudio/shared/external-agents';
import { DEFAULT_EXTERNAL_AGENT_SETTINGS } from '@mangostudio/shared/external-agents';
import type { OwnedChatRecord } from '../../../../src/modules/chats/infrastructure/chat-repository';
import { createExternalTurnConfigurationResolver } from '../../../../src/modules/external-agents/application/external-turn-configuration';

/**
 * Which model a turn runs as, resolved server-side.
 *
 * The chain is request → chat → settings default → the vendor's catalog
 * default, and each step exists because the one below it is wrong on its own: a
 * per-send override must beat a stored choice, a stored choice must survive a
 * reload, and a per-vendor default must save picking the same model in every
 * new chat.
 */

const CATALOG: ExternalAgentDescriptor['models'] = [
  { id: 'opus', supportedReasoningEfforts: [{ id: 'low' }, { id: 'high' }] },
  { id: 'sonnet', supportedReasoningEfforts: [{ id: 'low' }, { id: 'high' }] },
];

function descriptor(overrides: Partial<ExternalAgentDescriptor> = {}): ExternalAgentDescriptor {
  return {
    targetId: 'claude',
    installed: true,
    authState: 'signed-in',
    capabilities: {
      structuredStreaming: true,
      reasoningStream: false,
      resume: true,
      cancellation: true,
      usageReporting: true,
      interactiveApprovals: false,
      images: false,
      steering: false,
      sessionListing: false,
      nativeReview: false,
      accountUsage: false,
      modelCatalog: true,
      commandCatalog: false,
    },
    supportedConfigurations: [{ level: 'default', routing: 'user', supported: true }],
    models: CATALOG,
    environmentId: 'local',
    ...overrides,
  } as ExternalAgentDescriptor;
}

function chat(selection: OwnedChatRecord['runnerModelSelection'] = {}): OwnedChatRecord {
  return {
    runner: { kind: 'external', targetId: 'claude' },
    runnerPermissions: { level: 'default', routing: 'user' },
    runnerModelSelection: selection,
    workdir: '/work/repo',
    environmentId: 'local',
    restrictToolsToWorkdir: null,
  };
}

type Dependencies = Parameters<typeof createExternalTurnConfigurationResolver>[0];

/**
 * The four ports the resolver reads, each answering the one question this
 * suite is not about.
 *
 * A class rather than four inline literals so the casts stay in one place: the
 * runtime client and the isolation registry both have surfaces far wider than
 * the two properties read here, and restating either in full would make this
 * file a maintenance cost for changes that have nothing to do with model
 * resolution.
 */
class FakeConfigurationPorts {
  constructor(
    private readonly settings: ExternalAgentSettings,
    private readonly agent: ExternalAgentDescriptor
  ) {}

  dependencies(): Dependencies {
    return {
      discovery: {
        describeExternalAgents: () =>
          Promise.resolve([{ descriptor: this.agent, adapterAnswered: true }]),
      } as NonNullable<Dependencies>['discovery'],
      resolveRuntimeClient: (() =>
        Promise.resolve({
          paths: { canonical: (path: string) => path },
          manifest: { identityIsolation: { kind: 'os-account' } },
        })) as unknown as NonNullable<Dependencies>['resolveRuntimeClient'],
      isolationRegistry: {
        resolve: () => ({ credentialHomeFingerprint: 'fp' }),
      } as unknown as NonNullable<Dependencies>['isolationRegistry'],
      readExternalAgentSettings: () => Promise.resolve(this.settings),
    };
  }
}

function resolverWith(settings: ExternalAgentSettings, agent = descriptor()) {
  return createExternalTurnConfigurationResolver(
    new FakeConfigurationPorts(settings, agent).dependencies()
  );
}

async function resolve(
  settings: ExternalAgentSettings,
  input: Parameters<ReturnType<typeof createExternalTurnConfigurationResolver>>[0]
) {
  const resolution = await resolverWith(settings)(input);
  if (!resolution.ok) throw new Error(`expected a resolved configuration: ${resolution.message}`);
  return resolution.configuration;
}

const BASE = {
  userId: 'user-1',
  targetId: 'claude' as const,
  workdir: '/work/repo',
};

describe('the model a turn resolves to', () => {
  it("prefers the send's own choice over everything stored", async () => {
    const configuration = await resolve(
      { ...DEFAULT_EXTERNAL_AGENT_SETTINGS, defaults: { claude: { model: 'sonnet' } } },
      { ...BASE, chat: chat({ model: 'opus' }), request: { model: 'sonnet' } }
    );

    expect(configuration.model).toBe('sonnet');
  });

  it('falls back to the model the chat stored', async () => {
    const configuration = await resolve(DEFAULT_EXTERNAL_AGENT_SETTINGS, {
      ...BASE,
      chat: chat({ model: 'opus', effort: 'high' }),
    });

    expect(configuration.model).toBe('opus');
    expect(configuration.effort).toBe('high');
  });

  it("falls back to the target's default when the chat chose nothing", async () => {
    const configuration = await resolve(
      { ...DEFAULT_EXTERNAL_AGENT_SETTINGS, defaults: { claude: { model: 'sonnet' } } },
      { ...BASE, chat: chat() }
    );

    expect(configuration.model).toBe('sonnet');
  });

  /**
   * A catalog with no `isDefault` — which is exactly Claude's, since its help
   * declares no default model — must resolve to nothing rather than to the
   * first entry. Picking one would put `--model` on every argv and override
   * whatever default the account itself is on.
   */
  it('resolves to nothing when nothing chose and the catalog names no default', async () => {
    const configuration = await resolve(DEFAULT_EXTERNAL_AGENT_SETTINGS, {
      ...BASE,
      chat: chat(),
    });

    expect(configuration.model).toBeUndefined();
    expect(configuration.effort).toBeUndefined();
  });

  /**
   * A stored model the vendor no longer lists is dropped, not refused: catalogs
   * are per-account and change between the render that filled the picker and
   * the send. Failing a turn over a stale dropdown is worse than running on the
   * vendor's own default.
   */
  it('drops a stored model the catalog no longer lists', async () => {
    const configuration = await resolve(DEFAULT_EXTERNAL_AGENT_SETTINGS, {
      ...BASE,
      chat: chat({ model: 'retired-model' }),
    });

    expect(configuration.model).toBeUndefined();
  });

  /**
   * The settings row sits at the bottom of the chain, so it is read only when
   * something above it is still unanswered.
   *
   * A database round trip plus a full `normalizeAppSettings`, on the one path a
   * user is watching, for a value the `??` chain then discards.
   */
  it('does not read the settings when the request already decided both halves', async () => {
    let reads = 0;
    const resolver = createExternalTurnConfigurationResolver({
      ...new FakeConfigurationPorts(DEFAULT_EXTERNAL_AGENT_SETTINGS, descriptor()).dependencies(),
      readExternalAgentSettings: () => {
        reads += 1;
        return Promise.resolve(DEFAULT_EXTERNAL_AGENT_SETTINGS);
      },
    });

    const resolution = await resolver({
      ...BASE,
      chat: chat(),
      request: { model: 'opus', effort: 'high' },
    });

    expect(resolution.ok).toBe(true);
    expect(reads).toBe(0);
  });

  it('reads the settings when only one half was decided above them', async () => {
    let reads = 0;
    const resolver = createExternalTurnConfigurationResolver({
      ...new FakeConfigurationPorts(DEFAULT_EXTERNAL_AGENT_SETTINGS, descriptor()).dependencies(),
      readExternalAgentSettings: () => {
        reads += 1;
        return Promise.resolve({
          ...DEFAULT_EXTERNAL_AGENT_SETTINGS,
          defaults: { claude: { effort: 'high' } },
        });
      },
    });

    const resolution = await resolver({ ...BASE, chat: chat(), request: { model: 'opus' } });

    expect(reads).toBe(1);
    if (!resolution.ok) throw new Error(resolution.message);
    expect(resolution.configuration.effort).toBe('high');
  });
});
