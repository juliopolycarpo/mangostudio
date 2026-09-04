import { describe, expect, it } from 'bun:test';
import type {
  ExternalAgentDescriptor,
  ExternalAgentSettings,
} from '@mangostudio/shared/external-agents';
import {
  DEFAULT_EXTERNAL_AGENT_SETTINGS,
  NO_EXTERNAL_AGENT_CAPABILITIES,
} from '@mangostudio/shared/external-agents';
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
      ...NO_EXTERNAL_AGENT_CAPABILITIES,
      structuredStreaming: true,
      resume: true,
      cancellation: true,
      usageReporting: true,
      modelCatalog: true,
    },
    supportedConfigurations: [
      { level: 'default', routing: 'user', supported: true, unattended: false },
    ],
    models: CATALOG,
    environmentId: 'local',
    ...overrides,
  };
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

  /**
   * The send is a pair, so a model with no effort means "no effort for this
   * model".
   *
   * The composer clears the effort in the same event that changes the model —
   * the vocabulary belongs to the model — and the row is written as a pair for
   * the same reason. Filling the missing half from the row would rebuild here
   * the one combination neither side ever stores: the new model carrying the
   * previous model's effort.
   */
  it("does not fill the send's missing half from the row", async () => {
    const configuration = await resolve(DEFAULT_EXTERNAL_AGENT_SETTINGS, {
      ...BASE,
      chat: chat({ model: 'opus', effort: 'high' }),
      request: { model: 'sonnet' },
    });

    expect(configuration.model).toBe('sonnet');
    expect(configuration.effort).toBeUndefined();
  });

  /** The target default is not a pair anyone picked, so it still fills in per field. */
  it("still takes the target's default effort under a send that named only a model", async () => {
    const configuration = await resolve(
      { ...DEFAULT_EXTERNAL_AGENT_SETTINGS, defaults: { claude: { effort: 'low' } } },
      { ...BASE, chat: chat({ model: 'opus', effort: 'high' }), request: { model: 'sonnet' } }
    );

    expect(configuration.model).toBe('sonnet');
    expect(configuration.effort).toBe('low');
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
   * An effort with no model still travels, as long as every entry in the
   * catalog accepts it.
   *
   * This is Claude's whole shape: `--effort` is session-scoped there, so the
   * levels ride on every model, and nothing is marked default on purpose.
   * Scoping the effort to a model that resolved to nothing would drop an
   * explicitly asked-for `max` in silence — reachable from an External API
   * body, from a per-target settings default, and from a `PUT /chats/:id` that
   * writes an effort without a model.
   */
  it('sends an effort with no model when the whole catalog accepts it', async () => {
    const configuration = await resolve(DEFAULT_EXTERNAL_AGENT_SETTINGS, {
      ...BASE,
      chat: chat(),
      request: { effort: 'high' },
    });

    expect(configuration.model).toBeUndefined();
    expect(configuration.effort).toBe('high');
  });

  /**
   * The other half of that rule. With no model resolved, the vendor picks one —
   * so an effort only *some* entries offer could land on an entry that does not
   * offer it, which on a command line is read as a new flag rather than as
   * `--effort`'s value.
   */
  it('drops an effort with no model when one catalog entry does not offer it', async () => {
    // Hidden counts as an entry: `pickModel` skips it when choosing a default,
    // but the vendor's own fallback may well be it.
    const resolver = resolverWith(
      DEFAULT_EXTERNAL_AGENT_SETTINGS,
      descriptor({
        models: [
          { id: 'opus', supportedReasoningEfforts: [{ id: 'low' }, { id: 'high' }] },
          { id: 'legacy', hidden: true, supportedReasoningEfforts: [{ id: 'low' }] },
        ],
      })
    );

    const resolution = await resolver({ ...BASE, chat: chat(), request: { effort: 'high' } });

    if (!resolution.ok) throw new Error(resolution.message);
    expect(resolution.configuration.effort).toBeUndefined();
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
