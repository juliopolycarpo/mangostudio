/**
 * The English `mangostudio doctor` prints for every section beyond the core
 * checks (Installed via, Update, Cursor connector, ChatGPT, skills, MCP,
 * environments, library), pinned row by row. Each section collector is run
 * against named fakes and its rows compared with the text the command printed
 * while those rows were still built from English prose, so moving a section to
 * keys and params cannot change a character of the terminal output.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentCliStatus,
  RuntimeFinding,
  RuntimeStatus,
  VersionManagerStatus,
} from '@mangostudio/shared/environments';
import type { SecretMetadataRow } from '@mangostudio/shared/types';

import {
  type ChatGptDoctorDeps,
  collectChatGptDoctorChecks,
} from '../../../src/cli/chatgpt-doctor-checks';
import type { CheckResult } from '../../../src/cli/doctor-checks';
import { collectEnvironmentDoctorSection } from '../../../src/cli/environment-doctor-checks';
import {
  collectLibraryDoctorSection,
  type LibraryDoctorDeps,
} from '../../../src/cli/library-doctor-checks';
import { collectMcpDoctorChecks } from '../../../src/cli/mcp-doctor-checks';
import { collectSkillsDoctorChecks } from '../../../src/cli/skills-doctor-checks';
import type { McpServerSelect } from '../../../src/db/types';
import type { MangoConfig } from '../../../src/lib/config';
import {
  CHATGPT_REAUTH_REQUIRED_CODE,
  ChatGptReauthRequiredError,
} from '../../../src/modules/connectors/infrastructure/chatgpt/oauth-client';
import {
  collectDoctorChecks,
  DEFAULT_DOCTOR_COLLECT_OPTIONS,
  type DoctorCollectDeps,
} from '../../../src/modules/machine/application/doctor-service';
import type { InstallOriginProbe } from '../../../src/modules/updates/domain/install-origin';
import { SecretStorageUnavailableError } from '../../../src/services/secret-store/store';
import { makeTokenBundle } from '../../support/chatgpt';
import { FakeProcessController } from '../../support/mocks/fake-process-controller';
import { InMemorySecretStore } from '../../support/mocks/mock-secret-store';

interface EnglishRow {
  readonly label: string;
  readonly status: CheckResult['status'];
  readonly detail: string;
}

interface SectionCase {
  readonly name: string;
  readonly rows: () => CheckResult[] | Promise<CheckResult[]>;
  readonly expected: readonly EnglishRow[];
}

function english(rows: readonly CheckResult[]): EnglishRow[] {
  return rows.map(({ label, status, detail }) => ({ label, status, detail }));
}

// ---------------------------------------------------------------------------
// Installed via, Update, Cursor connector: rows of the doctor service itself.
// ---------------------------------------------------------------------------

const SERVICE_LABELS = new Set(['Installed via', 'Update', 'Cursor connector']);

function selfManagedProbe(overrides: Partial<InstallOriginProbe> = {}): InstallOriginProbe {
  return {
    platform: 'linux',
    env: {},
    execPath: '/home/j/.mango/dist/0.1.1/mangostudio',
    version: '0.1.1',
    standalone: true,
    container: false,
    home: '/home/j',
    readFile: (path) =>
      path === '/home/j/.mango/dist/install-origin.json'
        ? JSON.stringify({ origin: 'installer', channel: 'stable', version: '0.1.1' })
        : null,
    ...overrides,
  };
}

function updatesConfig(check: boolean): MangoConfig {
  return {
    server: { host: 'localhost', port: 3001 },
    auth: { secret: 'x'.repeat(32) },
    database: { path: ':memory:' },
    updates: { check, channel: null },
    configFilePath: '',
  } as MangoConfig;
}

type CachedUpdate = ReturnType<DoctorCollectDeps['checker']['readCached']>;

/** Only the three rows under test, from a doctor run whose every probe is a fake. */
async function serviceRows(
  overrides: Partial<DoctorCollectDeps> & { updatesCheck?: boolean; version?: string } = {}
): Promise<CheckResult[]> {
  const { updatesCheck = true, version = '0.1.1', ...deps } = overrides;
  const previousVersion = process.env.VERSION;
  process.env.VERSION = version;
  try {
    const rows = await collectDoctorChecks(
      { ...DEFAULT_DOCTOR_COLLECT_OPTIONS, sections: [] },
      {
        loadConfig: () => updatesConfig(updatesCheck),
        env: {},
        fs: { exists: () => true, isWritable: () => true },
        frontendDir: () => '/app',
        controller: new FakeProcessController(),
        readState: () => Promise.resolve(null),
        isCursorConfigured: () => false,
        listCursorConnectors: () => [],
        probeRuntimeBinary: () =>
          Promise.resolve({ path: null, present: false, version: null, error: null }),
        probeRuntimeSlots: () => Promise.resolve([]),
        probeSshClient: () => Promise.resolve({ path: null, version: null, error: null }),
        listChatGptConnectors: () => [],
        collectChatGptChecks: () => Promise.resolve([]),
        getBuildInfo: () => ({ gitSha: 'a', gitDirty: false, builtAt: 'dev', buildType: 'dev' }),
        getCheckoutBuildInfo: () => ({
          gitSha: 'a',
          gitDirty: false,
          builtAt: 'dev',
          buildType: 'dev',
        }),
        readFrontendBuildInfo: () => null,
        getEmbeddedFrontend: () => null,
        collectSkillsChecks: () => [],
        listMcpServers: () => [],
        collectMcpChecks: () => Promise.resolve([]),
        collectEnvironmentChecks: () => Promise.resolve([]),
        collectLibraryChecks: () => Promise.resolve([]),
        installOriginProbe: () => selfManagedProbe(),
        checker: { readCached: () => null, check: () => Promise.resolve(null) },
        isTty: () => false,
        now: () => 3 * 3_600_000,
        ...deps,
      }
    );
    return rows.filter((row) => SERVICE_LABELS.has(row.label));
  } finally {
    if (previousVersion === undefined) delete process.env.VERSION;
    else process.env.VERSION = previousVersion;
  }
}

function cachedUpdate(
  overrides: Partial<NonNullable<CachedUpdate>> = {}
): DoctorCollectDeps['checker'] {
  const cached = {
    channel: 'stable',
    currentVersion: '0.1.1',
    updateAvailable: false,
    checkedAt: 0,
    ...overrides,
  } as NonNullable<CachedUpdate>;
  return { readCached: () => cached, check: () => Promise.resolve(cached) };
}

const NOT_CHECKED: EnglishRow = { label: 'Update', status: 'ok', detail: 'not checked yet' };
const INSTALLED_VIA_SCRIPT: EnglishRow = {
  label: 'Installed via',
  status: 'ok',
  detail: 'install script · channel stable',
};

const SERVICE_CASES: readonly SectionCase[] = [
  {
    name: 'an installer install with nothing cached',
    rows: () => serviceRows(),
    expected: [INSTALLED_VIA_SCRIPT, NOT_CHECKED],
  },
  {
    name: 'a self-managed dist root that predates install-origin.json',
    rows: () =>
      serviceRows({ installOriginProbe: () => selfManagedProbe({ readFile: () => null }) }),
    expected: [
      {
        label: 'Installed via',
        status: 'ok',
        detail:
          'install script · channel stable · legacy layout, run mangostudio upgrade to migrate',
      },
      NOT_CHECKED,
    ],
  },
  {
    name: 'update checks switched off',
    rows: () => serviceRows({ updatesCheck: false }),
    expected: [INSTALLED_VIA_SCRIPT, { label: 'Update', status: 'ok', detail: 'checks disabled' }],
  },
  {
    name: 'an opt-out in the environment',
    rows: () => serviceRows({ env: { DO_NOT_TRACK: '1' } }),
    expected: [
      INSTALLED_VIA_SCRIPT,
      { label: 'Update', status: 'ok', detail: 'skipped (NO_UPDATE_NOTIFIER|DO_NOT_TRACK|CI)' },
    ],
  },
  {
    name: 'a development build',
    rows: () => serviceRows({ version: 'dev' }),
    expected: [
      INSTALLED_VIA_SCRIPT,
      { label: 'Update', status: 'ok', detail: 'skipped (development build)' },
    ],
  },
  {
    name: 'a failed check',
    rows: () => serviceRows({ checker: cachedUpdate({ error: 'DNS lookup failed' }) }),
    expected: [
      INSTALLED_VIA_SCRIPT,
      { label: 'Update', status: 'warn', detail: 'check failed (DNS lookup failed)' },
    ],
  },
  {
    name: 'a newer release',
    rows: () =>
      serviceRows({ checker: cachedUpdate({ updateAvailable: true, latestVersion: '0.2.0' }) }),
    expected: [
      INSTALLED_VIA_SCRIPT,
      { label: 'Update', status: 'warn', detail: '0.2.0 available — run: mangostudio upgrade' },
    ],
  },
  {
    name: 'a newer build with no version named',
    rows: () => serviceRows({ checker: cachedUpdate({ updateAvailable: true }) }),
    expected: [
      INSTALLED_VIA_SCRIPT,
      {
        label: 'Update',
        status: 'warn',
        detail: 'a newer build available — run: mangostudio upgrade',
      },
    ],
  },
  {
    name: 'an up-to-date install checked hours ago',
    rows: () => serviceRows({ checker: cachedUpdate() }),
    expected: [
      INSTALLED_VIA_SCRIPT,
      { label: 'Update', status: 'ok', detail: 'up to date (0.1.1, checked 3h ago)' },
    ],
  },
  {
    name: 'a Cursor key still configured',
    rows: () => serviceRows({ isCursorConfigured: () => true }),
    expected: [
      INSTALLED_VIA_SCRIPT,
      NOT_CHECKED,
      {
        label: 'Cursor connector',
        status: 'warn',
        detail:
          'Deprecated provider. Use the Cursor CLI runner in the chat runner selector; this key no longer runs turns.',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// ChatGPT
// ---------------------------------------------------------------------------

const CHATGPT_NOW = 1_750_000_000_000;
const CHATGPT_ACCOUNT = '****....com (plus)';

function chatGptConfig(): MangoConfig {
  return {
    chatgpt: { authBaseUrl: 'https://auth.example.test', apiBaseUrl: 'https://api.example.test' },
  } as MangoConfig;
}

function chatGptConnector(overrides: Partial<SecretMetadataRow> = {}): SecretMetadataRow {
  return {
    id: 'connector-1',
    name: 'chatgpt-main',
    provider: 'chatgpt',
    configured: 1,
    source: 'bun-secrets',
    maskedSuffix: null,
    updatedAt: CHATGPT_NOW,
    lastValidatedAt: null,
    lastValidationError: null,
    enabledModels: '[]',
    userId: 'user-1',
    baseUrl: null,
    ...overrides,
  };
}

function chatGptDeps(overrides: Partial<ChatGptDoctorDeps> = {}): ChatGptDoctorDeps {
  return {
    secretStore: new InMemorySecretStore(),
    readBundle: () => Promise.resolve(makeTokenBundle({ expiresAt: CHATGPT_NOW + 3_660_000 })),
    refreshTokens: () => Promise.resolve(makeTokenBundle({ expiresAt: CHATGPT_NOW + 3_600_000 })),
    isPortFree: () => Promise.resolve(true),
    fetchImpl: () => Promise.resolve(new Response(null, { status: 200 })),
    now: () => CHATGPT_NOW,
    timeoutMs: 200,
    ...overrides,
  };
}

/** A secret store whose read-back differs from what was written. */
class CorruptingSecretStore extends InMemorySecretStore {
  override getSecret(): Promise<string | null> {
    return Promise.resolve('corrupted');
  }
}

/** A secret store that refuses the token-sized write. */
class WriteRefusingSecretStore extends InMemorySecretStore {
  override setSecret(): Promise<void> {
    return Promise.reject(new Error('credential blob too large'));
  }
}

const HEALTHY_TAIL: readonly EnglishRow[] = [
  { label: 'ChatGPT port', status: 'ok', detail: '1455 free (OAuth sign-in callback)' },
  { label: 'ChatGPT auth', status: 'ok', detail: 'https://auth.example.test (HTTP 200)' },
  { label: 'ChatGPT backend', status: 'ok', detail: 'https://api.example.test (HTTP 200)' },
];
const SECRETS_OK: EnglishRow = {
  label: 'ChatGPT secrets',
  status: 'ok',
  detail: 'secret store reachable (token-sized write verified)',
};

const CHATGPT_CASES: readonly SectionCase[] = [
  {
    name: 'a healthy connector',
    rows: () =>
      collectChatGptDoctorChecks(chatGptConfig(), [chatGptConnector()], false, chatGptDeps()),
    expected: [
      SECRETS_OK,
      {
        label: 'ChatGPT tokens',
        status: 'ok',
        detail: `${CHATGPT_ACCOUNT} — access token expires in 1h 1m`,
      },
      ...HEALTHY_TAIL,
    ],
  },
  {
    name: 'an unavailable secret store, a busy port and unreachable endpoints',
    rows: () => {
      const store = new InMemorySecretStore();
      store.available = false;
      return collectChatGptDoctorChecks(
        chatGptConfig(),
        [],
        false,
        chatGptDeps({
          secretStore: store,
          isPortFree: () => Promise.resolve(false),
          fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
        })
      );
    },
    expected: [
      {
        label: 'ChatGPT secrets',
        status: 'fail',
        detail: 'secret store unavailable — stored ChatGPT tokens cannot be read',
      },
      {
        label: 'ChatGPT port',
        status: 'warn',
        detail:
          '1455 in use — new ChatGPT sign-ins will fail until it is released (Codex CLI uses the same port)',
      },
      {
        label: 'ChatGPT auth',
        status: 'fail',
        detail: 'https://auth.example.test (getaddrinfo ENOTFOUND)',
      },
      {
        label: 'ChatGPT backend',
        status: 'fail',
        detail: 'https://api.example.test (getaddrinfo ENOTFOUND)',
      },
    ],
  },
  {
    name: 'a secret store that corrupts a token-sized write',
    rows: () =>
      collectChatGptDoctorChecks(
        chatGptConfig(),
        [],
        false,
        chatGptDeps({ secretStore: new CorruptingSecretStore() })
      ),
    expected: [
      {
        label: 'ChatGPT secrets',
        status: 'fail',
        detail: 'secret store returned corrupted data for a token-sized write',
      },
      ...HEALTHY_TAIL,
    ],
  },
  {
    name: 'a secret store that refuses the write',
    rows: () =>
      collectChatGptDoctorChecks(
        chatGptConfig(),
        [],
        false,
        chatGptDeps({ secretStore: new WriteRefusingSecretStore() })
      ),
    expected: [
      {
        label: 'ChatGPT secrets',
        status: 'fail',
        detail: 'token-sized write failed — credential blob too large',
      },
      ...HEALTHY_TAIL,
    ],
  },
  {
    name: 'an unreadable token bundle, with the refresh probe asked for',
    rows: () =>
      collectChatGptDoctorChecks(
        chatGptConfig(),
        [chatGptConnector()],
        true,
        chatGptDeps({
          readBundle: () =>
            Promise.reject(new SecretStorageUnavailableError('OS secret storage is unavailable')),
        })
      ),
    expected: [
      SECRETS_OK,
      {
        label: 'ChatGPT tokens',
        status: 'fail',
        detail: 'chatgpt-main: OS secret storage is unavailable',
      },
      {
        label: 'ChatGPT refresh',
        status: 'fail',
        detail: 'chatgpt-main: skipped — no readable token bundle',
      },
      ...HEALTHY_TAIL,
    ],
  },
  {
    name: 'a connector flagged for re-auth and an expired access token',
    rows: () =>
      collectChatGptDoctorChecks(
        chatGptConfig(),
        [
          chatGptConnector({ lastValidationError: CHATGPT_REAUTH_REQUIRED_CODE }),
          chatGptConnector({ id: 'connector-2' }),
        ],
        false,
        chatGptDeps({
          readBundle: (connector) =>
            Promise.resolve(
              makeTokenBundle({
                expiresAt: connector.id === 'connector-1' ? CHATGPT_NOW + 1 : CHATGPT_NOW - 180_000,
              })
            ),
        })
      ),
    expected: [
      SECRETS_OK,
      {
        label: 'ChatGPT tokens',
        status: 'fail',
        detail: `${CHATGPT_ACCOUNT} — session expired; sign in with ChatGPT again`,
      },
      {
        label: 'ChatGPT tokens',
        status: 'warn',
        detail: `${CHATGPT_ACCOUNT} — access token expired 3m ago (refreshes on next use)`,
      },
      ...HEALTHY_TAIL,
    ],
  },
  {
    name: 'a rotated refresh token',
    rows: () =>
      collectChatGptDoctorChecks(chatGptConfig(), [chatGptConnector()], true, chatGptDeps()),
    expected: [
      SECRETS_OK,
      {
        label: 'ChatGPT tokens',
        status: 'ok',
        detail: `${CHATGPT_ACCOUNT} — access token expires in 1h 1m`,
      },
      {
        label: 'ChatGPT refresh',
        status: 'ok',
        detail: `${CHATGPT_ACCOUNT} — refresh token rotated; new access token expires in 1h 0m`,
      },
      ...HEALTHY_TAIL,
    ],
  },
  {
    name: 'a refresh rejected with invalid_grant, and one that fails otherwise',
    rows: async () => [
      ...(
        await collectChatGptDoctorChecks(
          chatGptConfig(),
          [chatGptConnector()],
          true,
          chatGptDeps({ refreshTokens: () => Promise.reject(new ChatGptReauthRequiredError()) })
        )
      ).filter((row) => row.label === 'ChatGPT refresh'),
      ...(
        await collectChatGptDoctorChecks(
          chatGptConfig(),
          [chatGptConnector()],
          true,
          chatGptDeps({ refreshTokens: () => Promise.reject(new Error('')) })
        )
      ).filter((row) => row.label === 'ChatGPT refresh'),
    ],
    expected: [
      {
        label: 'ChatGPT refresh',
        status: 'fail',
        detail: 'chatgpt-main: refresh rejected (invalid_grant) — sign in with ChatGPT again',
      },
      { label: 'ChatGPT refresh', status: 'fail', detail: 'chatgpt-main: unknown error' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

describe('skills section, English text', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'doctor-sections-skills-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSkill(dir: string, slug: string, frontmatter: string): void {
    mkdirSync(join(dir, slug), { recursive: true });
    writeFileSync(join(dir, slug, 'SKILL.md'), `---\n${frontmatter}\n---\n\nBody.\n`, 'utf8');
  }

  it('prints every source and skill state as it always has', () => {
    const mango = join(root, 'mango');
    const agents = join(root, 'agents');
    const claude = join(root, 'claude');
    writeSkill(mango, 'alpha', 'name: alpha\ndescription: Alpha');
    writeSkill(mango, 'broken', 'name: nope\ndescription: bad');
    writeSkill(mango, 'muted', 'name: muted\ndescription: off');
    writeSkill(mango, 'shared', 'name: shared\ndescription: mango');
    writeSkill(agents, 'shared', 'name: shared\ndescription: agents');
    // `claude` is a plain file, so the source cannot be read.
    writeFileSync(claude, 'not a directory');

    const rows = collectSkillsDoctorChecks({
      configDir: mango,
      configOrigin: 'toml',
      sourceToggles: { agents: true, claude: true },
      disabledKeys: new Set(['mango:muted']),
      thirdPartyDirs: { agents, claude },
    });

    expect(english(rows)).toEqual([
      { label: 'Skills config', status: 'ok', detail: `${mango} (from toml)` },
      { label: 'Skills mango', status: 'ok', detail: `${mango} — 4 skill(s)` },
      { label: 'Skills agents', status: 'ok', detail: `${agents} — 1 skill(s)` },
      { label: 'Skills claude', status: 'fail', detail: `${claude} (not readable)` },
      {
        label: 'Skill agents:shared',
        status: 'warn',
        detail: 'shadowed by mango source (higher precedence)',
      },
      {
        label: 'Skill mango:broken',
        status: 'fail',
        detail: 'Frontmatter "name" must match the skill directory name.',
      },
      { label: 'Skill mango:muted', status: 'ok', detail: 'disabled in settings' },
    ]);
  });

  it('prints disabled and missing sources, and the other config origins', () => {
    const mango = join(root, 'mango');
    const agents = join(root, 'agents');
    const claude = join(root, 'claude');
    writeFileSync(claude, 'not a directory');

    const fromEnv = collectSkillsDoctorChecks({
      configDir: mango,
      configOrigin: 'env',
      sourceToggles: { agents: false, claude: false },
      disabledKeys: new Set(),
      thirdPartyDirs: { agents, claude },
    });
    const fromDefault = collectSkillsDoctorChecks({
      configDir: mango,
      configOrigin: 'default',
      sourceToggles: { agents: false, claude: false },
      disabledKeys: new Set(),
      thirdPartyDirs: { agents, claude },
    });

    expect(english(fromEnv)).toEqual([
      { label: 'Skills config', status: 'ok', detail: `${mango} (from env)` },
      { label: 'Skills mango', status: 'ok', detail: `${mango} (no skills directory yet)` },
      {
        label: 'Skills agents',
        status: 'ok',
        detail: `${agents} (no skills directory yet) (source disabled)`,
      },
      {
        label: 'Skills claude',
        status: 'warn',
        detail: `${claude} (not readable, source disabled)`,
      },
    ]);
    expect(fromDefault[0]).toEqual(expect.objectContaining({ detail: `${mango} (from default)` }));
  });

  it('prints a populated source that is switched off', () => {
    const mango = join(root, 'mango');
    const agents = join(root, 'agents');
    writeSkill(agents, 'solo', 'name: solo\ndescription: Solo');

    const rows = collectSkillsDoctorChecks({
      configDir: mango,
      configOrigin: 'default',
      sourceToggles: { agents: false, claude: false },
      disabledKeys: new Set(),
      thirdPartyDirs: { agents, claude: join(root, 'claude') },
    });

    expect(english(rows).find((row) => row.label === 'Skills agents')).toEqual({
      label: 'Skills agents',
      status: 'ok',
      detail: `${agents} — 1 skill(s) (source disabled)`,
    });
  });
});

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

function mcpServer(overrides: Partial<McpServerSelect> = {}): McpServerSelect {
  return {
    id: 'server-1',
    userId: 'user-1',
    name: 'GitHub',
    slug: 'github',
    transport: 'stdio',
    environmentId: 'local',
    command: 'uvx',
    argsJson: '[]',
    envJson: '{}',
    url: null,
    enabled: 1,
    timeoutMs: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const MCP_LONG_TOOL = 'y'.repeat(60);

const MCP_CASES: readonly SectionCase[] = [
  {
    name: 'a healthy stdio server, probed, beside a running hub',
    rows: () =>
      collectMcpDoctorChecks(
        [mcpServer()],
        { probe: true, serverRunning: true },
        {
          resolveCommandOnPath: () => true,
          probeServer: () => Promise.resolve({ ok: true, tools: [] }),
        }
      ),
    expected: [
      {
        label: 'MCP probe',
        status: 'warn',
        detail:
          'a MangoStudio server is running; the probe spawns a second stdio child per server (safe for per-client servers)',
      },
      { label: 'MCP github', status: 'ok', detail: 'stdio, enabled' },
      { label: 'MCP github command', status: 'ok', detail: 'uvx resolvable on PATH' },
      { label: 'MCP github probe', status: 'ok', detail: 'connected, 0 tool(s)' },
    ],
  },
  {
    name: 'a command off PATH, a failed probe and overlong tool names',
    rows: () =>
      collectMcpDoctorChecks(
        [mcpServer()],
        { probe: true, serverRunning: false },
        {
          resolveCommandOnPath: () => false,
          probeServer: () =>
            Promise.resolve({
              ok: false,
              reason: 'connection-refused',
              detail: 'connection refused',
            }),
        }
      ),
    expected: [
      { label: 'MCP github', status: 'ok', detail: 'stdio, enabled' },
      {
        label: 'MCP github command',
        status: 'fail',
        detail: 'uvx not found on PATH (spawn would ENOENT)',
      },
      { label: 'MCP github probe', status: 'fail', detail: 'connection refused' },
    ],
  },
  {
    name: 'tool names past the length cap',
    rows: () =>
      collectMcpDoctorChecks(
        [mcpServer()],
        { probe: true, serverRunning: false },
        {
          resolveCommandOnPath: () => true,
          probeServer: () =>
            Promise.resolve({
              ok: true,
              tools: [{ name: MCP_LONG_TOOL, description: '', inputSchema: {} }],
            }),
        }
      ),
    expected: [
      { label: 'MCP github', status: 'ok', detail: 'stdio, enabled' },
      { label: 'MCP github command', status: 'ok', detail: 'uvx resolvable on PATH' },
      { label: 'MCP github probe', status: 'ok', detail: 'connected, 1 tool(s)' },
      {
        label: 'MCP github tools',
        status: 'warn',
        detail: `1 tool name(s) exceed 64 chars and are skipped: mcp__github__${MCP_LONG_TOOL}`,
      },
    ],
  },
  {
    name: 'an enabled stdio server with no command',
    rows: () =>
      collectMcpDoctorChecks(
        [mcpServer({ command: null })],
        { probe: false, serverRunning: false },
        {
          resolveCommandOnPath: () => true,
          probeServer: () => Promise.resolve({ ok: true, tools: [] }),
        }
      ),
    expected: [
      { label: 'MCP github', status: 'ok', detail: 'stdio, enabled' },
      {
        label: 'MCP github command',
        status: 'fail',
        detail: 'no command configured (stdio MCP servers require a command)',
      },
    ],
  },
  {
    name: 'a disabled stdio server with no command',
    rows: () =>
      collectMcpDoctorChecks(
        [mcpServer({ command: '', enabled: 0 })],
        { probe: false, serverRunning: false },
        {
          resolveCommandOnPath: () => true,
          probeServer: () => Promise.resolve({ ok: true, tools: [] }),
        }
      ),
    expected: [
      { label: 'MCP github', status: 'ok', detail: 'stdio, disabled' },
      {
        label: 'MCP github command',
        status: 'warn',
        detail: 'no command configured (stdio MCP servers require a command, server disabled)',
      },
    ],
  },
  {
    name: 'a disabled server whose command is off PATH',
    rows: () =>
      collectMcpDoctorChecks(
        [mcpServer({ enabled: 0 })],
        { probe: false, serverRunning: false },
        {
          resolveCommandOnPath: () => false,
          probeServer: () => Promise.resolve({ ok: true, tools: [] }),
        }
      ),
    expected: [
      { label: 'MCP github', status: 'ok', detail: 'stdio, disabled' },
      {
        label: 'MCP github command',
        status: 'warn',
        detail: 'uvx not found on PATH (server disabled)',
      },
    ],
  },
  {
    name: 'an http server',
    rows: () =>
      collectMcpDoctorChecks(
        [mcpServer({ transport: 'http', command: null, url: 'https://example.test/mcp' })],
        { probe: false, serverRunning: false },
        {
          resolveCommandOnPath: () => true,
          probeServer: () => Promise.resolve({ ok: true, tools: [] }),
        }
      ),
    expected: [{ label: 'MCP github', status: 'ok', detail: 'http, enabled' }],
  },
];

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

function installation(version: string, path: string): NonNullable<RuntimeStatus['effective']> {
  return { path, rawPath: path, version, origin: 'path', effective: true };
}

function runtimeStatus(
  id: RuntimeStatus['id'],
  overrides: Partial<RuntimeStatus> = {}
): RuntimeStatus {
  return {
    id,
    health: 'ok',
    installations: [],
    findings: [],
    installable: true,
    probedAtMs: 0,
    ...overrides,
  };
}

function agentStatus(
  targetId: AgentCliStatus['targetId'],
  overrides: Partial<AgentCliStatus> = {}
): AgentCliStatus {
  return {
    ...runtimeStatus(targetId as RuntimeStatus['id']),
    targetId,
    configHome: `/home/u/.${targetId}`,
    configHomeExists: true,
    authenticated: true,
    authSignal: 'unknown',
    locations: [],
    ...overrides,
  };
}

function managerStatus(
  id: VersionManagerStatus['id'],
  overrides: Partial<VersionManagerStatus> = {}
): VersionManagerStatus {
  return { id, installed: true, versions: [], findings: [], ...overrides };
}

function managedVersion(version: string): VersionManagerStatus['versions'][number] {
  return {
    version,
    path: `/home/u/.nvm/versions/node/v${version}`,
    isDefault: false,
    isCurrent: false,
    ltsStatus: 'current-lts',
  };
}

const NOT_FOUND_NODE: RuntimeFinding = { code: 'not-found', params: { runtime: 'node' } };
const OUTDATED_LTS: RuntimeFinding = {
  code: 'outdated-lts',
  params: { version: '20.1.0', ltsStatus: 'lts-superseded' },
};
const MANAGED_NOT_ON_PATH: RuntimeFinding = {
  code: 'managed-but-not-on-path',
  params: { manager: 'nvm', defaultAlias: 'default', defaultVersion: '22.0.0' },
};

function environmentRows(parts: {
  runtimes?: RuntimeStatus[];
  managers?: VersionManagerStatus[];
  agents?: AgentCliStatus[];
  platform?: NodeJS.Platform;
}): Promise<CheckResult[]> {
  return collectEnvironmentDoctorSection({
    listRuntimes: () => Promise.resolve(parts.runtimes ?? []),
    listVersionManagers: () => Promise.resolve(parts.managers ?? []),
    listAgents: () => Promise.resolve(parts.agents ?? []),
    platform: parts.platform ?? 'linux',
    resolveWslExecutable: () => ({
      path: 'C:\\Windows\\System32\\wsl.exe',
      source: 'program-files',
    }),
  });
}

const ENVIRONMENT_CASES: readonly SectionCase[] = [
  {
    name: 'a runtime with an effective install',
    rows: () =>
      environmentRows({
        runtimes: [
          runtimeStatus('bun', { effective: installation('1.2.3', '/usr/local/bin/bun') }),
          // The hub itself is not a toolchain row.
          runtimeStatus('mangostudio', { effective: installation('0.1.1', '/opt/mangostudio') }),
        ],
      }),
    expected: [{ label: 'Bun', status: 'ok', detail: '1.2.3  /usr/local/bin/bun' }],
  },
  {
    name: 'a missing runtime, by finding and without one',
    rows: () =>
      environmentRows({
        runtimes: [
          runtimeStatus('node', { health: 'missing', findings: [NOT_FOUND_NODE] }),
          runtimeStatus('bun', {
            health: 'warn',
            findings: [
              {
                code: 'shadowed-by-earlier-path',
                params: {
                  shadowedPath: '/a/bun',
                  shadowedPathIndex: '0',
                  effectivePath: '/b/bun',
                  effectivePathIndex: '3',
                },
              },
            ],
          }),
          runtimeStatus('git', { health: 'missing' }),
          runtimeStatus('volta' as RuntimeStatus['id'], { health: 'warn' }),
          runtimeStatus('codex' as RuntimeStatus['id'], { health: 'ok' }),
        ],
      }),
    expected: [
      {
        label: 'Node.js',
        status: 'fail',
        detail: 'Node.js was not found on PATH or in any well-known location.',
      },
      {
        label: 'Bun',
        status: 'warn',
        detail: 'Typing the command runs /a/bun (PATH #1), not /b/bun (PATH #4).',
      },
      { label: 'Git', status: 'fail', detail: 'not detected' },
      { label: 'Volta', status: 'warn', detail: 'needs attention' },
      { label: 'Codex', status: 'ok', detail: 'detected' },
    ],
  },
  {
    name: 'version managers that are missing, plain, and managing versions',
    rows: () =>
      environmentRows({
        managers: [
          managerStatus('fnm', { installed: false }),
          managerStatus('volta', {
            installed: false,
            findings: [{ code: 'not-found', params: { manager: 'volta' } }],
          }),
          managerStatus('nvm', { managerVersion: '0.40.1' }),
          managerStatus('fnm', { managerVersion: '1.37.0', versions: [managedVersion('22.0.0')] }),
          managerStatus('volta', {
            managerVersion: '2.0.0',
            versions: [managedVersion('22.0.0'), managedVersion('20.1.0')],
          }),
          managerStatus('nvm', { versions: [managedVersion('22.0.0')] }),
          managerStatus('nvm'),
        ],
      }),
    expected: [
      { label: 'fnm', status: 'warn', detail: 'not installed' },
      {
        label: 'Volta',
        status: 'fail',
        detail: 'Volta was not found on PATH or in any well-known location.',
      },
      { label: 'nvm', status: 'ok', detail: '0.40.1' },
      { label: 'fnm', status: 'ok', detail: '1.37.0  1 version managed' },
      { label: 'Volta', status: 'ok', detail: '2.0.0  2 versions managed' },
      { label: 'nvm', status: 'ok', detail: 'installed  1 version managed' },
      { label: 'nvm', status: 'ok', detail: 'installed' },
    ],
  },
  {
    name: 'version managers with findings',
    rows: () =>
      environmentRows({
        managers: [
          managerStatus('nvm', { findings: [MANAGED_NOT_ON_PATH] }),
          managerStatus('nvm', { findings: [MANAGED_NOT_ON_PATH, OUTDATED_LTS] }),
          managerStatus('fnm', {
            findings: [{ code: 'not-executable', params: { path: '/home/u/.fnm/fnm' } }],
          }),
        ],
      }),
    expected: [
      {
        label: 'nvm',
        status: 'warn',
        detail: 'The nvm alias default is not on PATH, so its Node does not run in new shells.',
      },
      {
        label: 'nvm',
        status: 'warn',
        detail:
          'The nvm alias default is not on PATH, so its Node does not run in new shells.; Version 20.1.0 is superseded LTS and will stop receiving fixes.',
      },
      {
        label: 'fnm',
        status: 'fail',
        detail: '/home/u/.fnm/fnm exists but did not answer a version query.',
      },
    ],
  },
  {
    name: 'agent CLIs that are installed, missing, and unfinished',
    rows: () =>
      environmentRows({
        agents: [
          agentStatus('claude', { effective: installation('2.1.0', '/usr/bin/claude') }),
          agentStatus('codex', {
            findings: [{ code: 'cli-not-installed', params: { targetId: 'codex' } }],
          }),
          agentStatus('cursor', {
            findings: [{ code: 'not-authenticated', params: { targetId: 'cursor' } }],
          }),
          agentStatus('cursor'),
        ],
      }),
    expected: [
      { label: 'Claude Code', status: 'ok', detail: '2.1.0  /usr/bin/claude' },
      {
        label: 'Codex',
        status: 'fail',
        detail: 'The Codex CLI is not installed, so MangoStudio cannot invoke it.',
      },
      {
        label: 'Cursor',
        status: 'warn',
        detail: 'Cursor is not signed in, so its calls will be rejected.',
      },
      { label: 'Cursor', status: 'fail', detail: 'not installed' },
    ],
  },
  {
    name: 'the WSL executable, on Windows only',
    rows: async () => [
      ...(await environmentRows({ platform: 'win32' })),
      ...(await environmentRows({ platform: 'linux' })),
    ],
    expected: [
      {
        label: 'WSL executable',
        status: 'ok',
        detail: 'C:\\Windows\\System32\\wsl.exe (program-files)',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

type LibraryLocationProbe = ReturnType<LibraryDoctorDeps['listLocations']>[number];

function libraryLocation(id: string, overrides: Partial<LibraryLocationProbe> = {}) {
  return {
    id,
    kind: 'skill',
    scope: 'home',
    path: `/${id}`,
    access: 'read-write',
    exists: true,
    readable: true,
    writable: true,
    targetIds: ['mangostudio'],
    ...overrides,
  } as LibraryLocationProbe;
}

function libraryRows(
  locations: LibraryLocationProbe[],
  leftovers: { locationId: string; path: string }[] = []
): () => Promise<CheckResult[]> {
  return () =>
    collectLibraryDoctorSection({
      listLocations: () => locations,
      listStagedRemovals: () =>
        Promise.resolve(leftovers.map((leftover) => ({ ...leftover, modifiedAtMs: 1 }))),
    });
}

const DIVERGENCE: EnglishRow = {
  label: 'divergence',
  status: 'ok',
  detail: 'run `mangostudio library --divergent` to list resources that differ across locations',
};

const LIBRARY_CASES: readonly SectionCase[] = [
  {
    name: 'every location present and writable',
    rows: libraryRows([libraryLocation('mango-skills'), libraryLocation('claude-skills')]),
    expected: [
      { label: 'locations', status: 'ok', detail: '2 of 2 present, all writable' },
      DIVERGENCE,
    ],
  },
  {
    name: 'a location that is present but read-only, and an interrupted removal',
    rows: libraryRows(
      [
        libraryLocation('mango-skills'),
        libraryLocation('claude-skills', { writable: false }),
        libraryLocation('agents-skills', { exists: false, writable: false }),
      ],
      [{ locationId: 'claude-skills', path: '/home/u/.claude/skills/.gh.abc.removing' }]
    ),
    expected: [
      { label: 'locations', status: 'warn', detail: '2 of 3 present, 1 writable' },
      { label: 'claude-skills', status: 'warn', detail: 'not writable' },
      {
        label: 'claude-skills',
        status: 'warn',
        detail:
          'an interrupted removal left "/home/u/.claude/skills/.gh.abc.removing" behind; inspect it, then delete it by hand',
      },
      DIVERGENCE,
    ],
  },
  {
    name: 'no location present',
    rows: libraryRows([libraryLocation('mango-skills', { exists: false, writable: false })]),
    expected: [
      { label: 'locations', status: 'fail', detail: '0 of 1 present, 0 writable' },
      DIVERGENCE,
    ],
  },
];

// ---------------------------------------------------------------------------

describe('doctor sections beyond the core, English text', () => {
  const groups: ReadonlyArray<readonly [string, readonly SectionCase[]]> = [
    ['Installed via, Update, Cursor connector', SERVICE_CASES],
    ['ChatGPT', CHATGPT_CASES],
    ['MCP', MCP_CASES],
    ['environments', ENVIRONMENT_CASES],
    ['library', LIBRARY_CASES],
  ];

  for (const [group, cases] of groups) {
    describe(group, () => {
      it.each(cases.map((testCase) => [testCase.name, testCase] as const))(
        '%s',
        async (_name, testCase) => {
          expect(english(await testCase.rows())).toEqual([...testCase.expected]);
        }
      );
    });
  }
});
