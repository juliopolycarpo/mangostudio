/**
 * The doctor checks as an application service: what the `doctor` command
 * prints and what `GET /api/machine/doctor` serves, collected once here so
 * the two cannot disagree about a finding.
 *
 * Every read is offline and read-only: SQLite is opened read-only, and no
 * probe mutates anything.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { normalizeLibraryLocationSettings } from '@mangostudio/shared/app-settings';
import type { MachineDoctorSection } from '@mangostudio/shared/machine';
import { parseRuntimeEnvFile } from '@mangostudio/shared/runtime-env';
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import { parse as parseToml } from 'smol-toml';
import type { DoctorArgs } from '../../../cli/args';
import { DEFAULT_DOCTOR_ARGS } from '../../../cli/args';
import { collectChatGptDoctorChecks } from '../../../cli/chatgpt-doctor-checks';
import {
  type CheckResult,
  checkAuthSecret,
  checkConfig,
  checkDatabase,
  checkDir,
  checkEmbeddedFrontend,
  checkFrontend,
  checkInstance,
  checkRuntime,
  checkRuntimeBinary,
  checkRuntimeCache,
  checkRuntimeSlot,
  checkSshClient,
  collectBuildIdentityChecks,
  type FsProbe,
  ok,
  warn,
} from '../../../cli/doctor-checks';
import { collectEnvironmentDoctorSection } from '../../../cli/environment-doctor-checks';
import { collectLibraryDoctorSection } from '../../../cli/library-doctor-checks';
import { collectMcpDoctorChecks } from '../../../cli/mcp-doctor-checks';
import { createProcessController, type ProcessController } from '../../../cli/process-control';
import { probeRuntimeBinary, type RuntimeBinaryProbe } from '../../../cli/runtime-binary-probe';
import { probeRuntimeCache } from '../../../cli/runtime-cache-probe';
import { probeRuntimeSlots, type RuntimeSlotProbe } from '../../../cli/runtime-slot-probe';
import { collectSkillsDoctorChecks } from '../../../cli/skills-doctor-checks';
import { probeSshClient, type SshClientProbe } from '../../../cli/ssh-client-probe';
import type { McpServerSelect } from '../../../db/types';
import {
  BUILD_INFO_FILENAME,
  type BuildInfo,
  getBuildInfo,
  getCurrentCheckoutBuildInfo,
  readBuildInfoFile,
  readFrontendBuildInfo,
} from '../../../lib/build-info';
import {
  getConfigEnvFilePath,
  getHomeMangoDir,
  getVersion,
  isReloadableSecretEnvKey,
  loadConfig,
  type MangoConfig,
} from '../../../lib/config';
import { getLogsDir, getRunDir } from '../../../lib/mango-paths';
import { getSourceFrontendDir, isStandaloneExecutable } from '../../../lib/runtime-paths';
import { isStateLive, readState, type ServerState } from '../../../lib/server-state';
import {
  EMBEDDED_FRONTEND_DIR,
  type EmbeddedFrontendFiles,
  getEmbeddedFrontend,
} from '../../../server/embedded-frontend';
import {
  hasProviderSecretEnv,
  hasProviderTomlSecret,
  PROVIDER_SECRET_CONFIG,
} from '../../connectors/domain/connector';
import type { SkillsConfigOrigin } from '../../skills/application/skill-diagnostics';
import { type InstallStatus, resolveInstallStatus } from '../../updates/application/install-status';
import {
  type UpdateChecker,
  updateChecker,
  updateCheckSkipReason,
} from '../../updates/application/update-check';
import type { InstallOriginProbe } from '../../updates/domain/install-origin';
import { describeInstallManager } from '../../updates/domain/install-origin';
import { currentInstallOriginProbe } from './hub-service';

export interface DoctorCollectDeps {
  loadConfig: () => MangoConfig;
  fs: FsProbe;
  frontendDir: () => string;
  controller: ProcessController;
  readState: typeof readState;
  isCursorConfigured: (config: MangoConfig) => boolean;
  probeRuntimeBinary: () => Promise<RuntimeBinaryProbe>;
  probeRuntimeSlots: () => Promise<RuntimeSlotProbe[]>;
  probeSshClient: () => Promise<SshClientProbe>;
  listChatGptConnectors: (config: MangoConfig, userId?: string) => SecretMetadataRow[];
  listCursorConnectors: (config: MangoConfig, userId?: string) => SecretMetadataRow[];
  collectChatGptChecks: (
    config: MangoConfig,
    connectors: readonly SecretMetadataRow[],
    refresh: boolean
  ) => Promise<CheckResult[]>;
  getBuildInfo: () => BuildInfo;
  getCheckoutBuildInfo: () => BuildInfo;
  readFrontendBuildInfo: (frontendDir: string) => BuildInfo | null;
  getEmbeddedFrontend: () => EmbeddedFrontendFiles | null;
  collectSkillsChecks: (config: MangoConfig, userId?: string) => CheckResult[];
  listMcpServers: (config: MangoConfig, userId?: string) => McpServerSelect[];
  collectMcpChecks: (
    rows: readonly McpServerSelect[],
    options: { probe: boolean; serverRunning: boolean }
  ) => Promise<CheckResult[]>;
  collectEnvironmentChecks: () => Promise<CheckResult[]>;
  collectLibraryChecks: () => Promise<CheckResult[]>;
  installOriginProbe: () => InstallOriginProbe;
  checker: Pick<UpdateChecker, 'readCached' | 'check'>;
  /**
   * Whether this run may talk to the network for the Update row. False for
   * the API's `GET /api/machine/doctor` and for every test default; only the
   * `doctor` CLI command, with a real terminal attached, sets it true — a
   * CLI-only user is otherwise never shown a check that ran.
   */
  isTty: () => boolean;
  now: () => number;
}

/**
 * What to collect. The CLI flags keep their meaning; `sections`, when given,
 * decides the optional sections outright, which is how the API asks for core
 * checks alone.
 */
export interface DoctorCollectOptions extends Omit<DoctorArgs, 'json'> {
  sections?: readonly MachineDoctorSection[];
  /**
   * Whose per-account rows to read. The API sets it to the signed-in user, so
   * one account's page never names another's MCP servers or connectors. The CLI
   * leaves it out: it runs on the machine's own keyboard and reports on the
   * whole install.
   */
  userId?: string;
}

// Derived rather than hand-copied: a sixth doctor flag added to `args.ts`
// otherwise reaches the CLI and silently misses the API's defaults.
const { json: _json, ...DOCTOR_ARG_DEFAULTS } = DEFAULT_DOCTOR_ARGS;
export const DEFAULT_DOCTOR_COLLECT_OPTIONS: DoctorCollectOptions = DOCTOR_ARG_DEFAULTS;

interface InstanceProbe {
  state: ServerState | null;
  alive: boolean;
}

/** Collect every doctor row for these options. // Usage: await collectDoctorChecks({ ...DEFAULT_DOCTOR_COLLECT_OPTIONS, sections: [] }) */
export async function collectDoctorChecks(
  options: DoctorCollectOptions = DEFAULT_DOCTOR_COLLECT_OPTIONS,
  deps: Partial<DoctorCollectDeps> = {}
): Promise<CheckResult[]> {
  const d = resolveDoctorCollectDeps(deps);
  const config = d.loadConfig();
  return await collectResults(config, options, d);
}

async function collectResults(
  config: MangoConfig,
  options: DoctorCollectOptions,
  d: Required<DoctorCollectDeps>
): Promise<CheckResult[]> {
  const instance = await inspectInstance(d);
  const embedded = d.getEmbeddedFrontend();
  const frontendDir = embedded
    ? EMBEDDED_FRONTEND_DIR
    : instance.alive
      ? (instance.state?.frontendDir ?? d.frontendDir())
      : d.frontendDir();
  const serverBuild = instance.alive ? (instance.state?.buildInfo ?? null) : d.getBuildInfo();

  const sectionFilter = options.envOnly || options.libraryOnly;
  const includeEnvSection = options.sections
    ? options.sections.includes('environments')
    : !options.libraryOnly || options.envOnly;
  const includeLibrarySection = options.sections
    ? options.sections.includes('library')
    : !options.envOnly || options.libraryOnly;

  // Four independent probes, two of which spawn a program (`--version` on the
  // runtime binary, `ssh -V`). Inside the array literal below they would run
  // one after another; the doctor is an HTTP endpoint now, not only a command
  // that exits afterwards.
  const [runtimeBinary, runtimeSlots, runtimeCache, sshClient] = await Promise.all([
    d.probeRuntimeBinary(),
    d.probeRuntimeSlots(),
    probeRuntimeCache(),
    d.probeSshClient(),
  ]);

  const installStatus = resolveInstallStatus(
    d.installOriginProbe(),
    config.updates.channel,
    getVersion()
  );
  const updateRow = await collectUpdateDoctorRow(config, installStatus, d);

  const results: CheckResult[] = [
    checkDir('Home directory', getHomeMangoDir(), d.fs),
    checkDir('Logs directory', getLogsDir(), d.fs),
    checkDir('Run directory', getRunDir(), d.fs),
    checkConfig(config),
    checkDatabase(config, d.fs),
    resolveFrontendCheck(frontendDir, embedded, d),
    checkAuthSecret(config),
    checkInstance(instance.state, instance.alive),
    checkRuntime(getVersion(), isStandaloneExecutable()),
    checkRuntimeBinary(runtimeBinary, getVersion()),
    ...runtimeSlots.map(checkRuntimeSlot),
    checkRuntimeCache(runtimeCache),
    checkSshClient(sshClient),
    ...collectBuildIdentityChecks({
      serverBuild,
      checkoutBuild: d.getCheckoutBuildInfo(),
      frontendBuild: embedded
        ? readEmbeddedFrontendBuildInfo(embedded)
        : d.readFrontendBuildInfo(frontendDir),
      frontendDir,
    }),
    collectInstalledViaDoctorRow(installStatus),
    updateRow,
  ];

  if (!sectionFilter) {
    // Not a health check — a migration notice. The provider is deprecated and
    // refuses every turn, so what matters is whether anyone still has a key
    // sitting there, which is also the evidence the removal cycle needs before
    // the connector and its secret can go.
    if (d.isCursorConfigured(config) || d.listCursorConnectors(config, options.userId).length > 0) {
      results.push(
        warn(
          'Cursor connector',
          'Deprecated provider. Use the Cursor CLI runner in the chat runner selector; this key no longer runs turns.'
        )
      );
    }

    const chatgptConnectors = d.listChatGptConnectors(config, options.userId);
    if (chatgptConnectors.length > 0 || options.all) {
      results.push(
        ...(await d.collectChatGptChecks(config, chatgptConnectors, options.chatgptRefresh))
      );
    }

    results.push(...d.collectSkillsChecks(config, options.userId));

    const mcpServers = d.listMcpServers(config, options.userId);
    if (mcpServers.length > 0 || options.all) {
      results.push(
        ...(await d.collectMcpChecks(mcpServers, {
          probe: options.probe,
          serverRunning: instance.alive,
        }))
      );
    }
  }

  if (includeEnvSection) {
    results.push(...(await d.collectEnvironmentChecks()));
  }

  if (includeLibrarySection) {
    results.push(...(await d.collectLibraryChecks()));
  }

  return results;
}

/**
 * Embedded assets ship inside the binary, so the frontend is present by
 * construction. A live instance may still report the embedded sentinel while
 * doctor runs from a source checkout — surface that instead of probing the
 * filesystem for a directory that does not exist.
 */
function resolveFrontendCheck(
  frontendDir: string,
  embedded: EmbeddedFrontendFiles | null,
  d: Required<DoctorCollectDeps>
): CheckResult {
  if (embedded) {
    return checkEmbeddedFrontend(Object.keys(embedded).length);
  }
  if (frontendDir === EMBEDDED_FRONTEND_DIR) {
    return ok('Frontend', 'embedded in running server binary');
  }
  return checkFrontend(frontendDir, d.fs);
}

/** Frontend build stamp travels inside the embedded manifest as /build-info.json. */
function readEmbeddedFrontendBuildInfo(embedded: EmbeddedFrontendFiles): BuildInfo | null {
  const path = embedded[`/${BUILD_INFO_FILENAME}`];
  return path ? readBuildInfoFile(path) : null;
}

async function inspectInstance(d: Required<DoctorCollectDeps>): Promise<InstanceProbe> {
  const state = await d.readState();
  if (!state) {
    return { state: null, alive: false };
  }
  const alive = isStateLive(state, (pid) => d.controller.isAlive(pid));
  return { state, alive };
}

function realFsProbe(): FsProbe {
  return {
    exists: (path) => existsSync(path),
    isWritable: (path) => {
      try {
        accessSync(path, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function resolveDoctorCollectDeps(deps: Partial<DoctorCollectDeps>): Required<DoctorCollectDeps> {
  return {
    loadConfig: deps.loadConfig ?? (() => loadConfig()),
    fs: deps.fs ?? realFsProbe(),
    frontendDir: deps.frontendDir ?? getSourceFrontendDir,
    controller: deps.controller ?? createProcessController(),
    readState: deps.readState ?? readState,
    isCursorConfigured: deps.isCursorConfigured ?? isCursorConnectorConfigured,
    listCursorConnectors: deps.listCursorConnectors ?? listCursorConnectorRows,
    probeRuntimeBinary: deps.probeRuntimeBinary ?? probeRuntimeBinary,
    probeRuntimeSlots: deps.probeRuntimeSlots ?? (() => probeRuntimeSlots()),
    probeSshClient: deps.probeSshClient ?? (() => probeSshClient()),
    listChatGptConnectors: deps.listChatGptConnectors ?? listChatGptConnectorRows,
    collectChatGptChecks:
      deps.collectChatGptChecks ??
      ((config, connectors, refresh) => collectChatGptDoctorChecks(config, connectors, refresh)),
    getBuildInfo: deps.getBuildInfo ?? getBuildInfo,
    getCheckoutBuildInfo: deps.getCheckoutBuildInfo ?? getCurrentCheckoutBuildInfo,
    readFrontendBuildInfo: deps.readFrontendBuildInfo ?? readFrontendBuildInfo,
    getEmbeddedFrontend: deps.getEmbeddedFrontend ?? getEmbeddedFrontend,
    collectSkillsChecks: deps.collectSkillsChecks ?? collectSkillsDoctorSection,
    listMcpServers: deps.listMcpServers ?? listMcpServerRows,
    collectMcpChecks: deps.collectMcpChecks ?? ((rows, opts) => collectMcpDoctorChecks(rows, opts)),
    collectEnvironmentChecks:
      deps.collectEnvironmentChecks ?? (() => collectEnvironmentDoctorSection()),
    collectLibraryChecks: deps.collectLibraryChecks ?? (() => collectLibraryDoctorSection()),
    installOriginProbe: deps.installOriginProbe ?? currentInstallOriginProbe,
    checker: deps.checker ?? updateChecker,
    // Real default is false: this is what the API's `GET /api/machine/doctor`
    // gets (a background server has no terminal), and what every test gets
    // unless it opts in. `runDoctor` overrides it with a real TTY check.
    isTty: deps.isTty ?? (() => false),
    now: deps.now ?? Date.now,
  };
}

/** `Installed via` doctor row: always `ok`, the channel and manager it resolved. */
function collectInstalledViaDoctorRow(status: InstallStatus): CheckResult {
  const legacyNote =
    status.installedVia.manager === 'self-managed' && status.installedVia.legacy
      ? ' · legacy layout, run mangostudio upgrade to migrate'
      : '';
  return ok(
    'Installed via',
    `${describeInstallManager(status.installedVia.manager)} · channel ${status.channel}${legacyNote}`
  );
}

/**
 * `Update` doctor row. On a TTY this performs the check itself (through the
 * checker's own freshness rule, so it is a real fetch only when the cache is
 * stale or absent) so a CLI-only user sees a fresh answer; off a TTY — the API
 * route, and every other CLI command — it only ever reads what is cached.
 */
async function collectUpdateDoctorRow(
  config: MangoConfig,
  status: InstallStatus,
  d: Required<DoctorCollectDeps>
): Promise<CheckResult> {
  const skip = updateCheckSkipReason(config, process.env, getVersion());
  if (skip === 'disabled') return ok('Update', 'checks disabled');
  if (skip === 'env') return ok('Update', 'skipped (NO_UPDATE_NOTIFIER|DO_NOT_TRACK|CI)');
  if (skip === 'dev') return ok('Update', 'skipped (development build)');

  const check = d.isTty() ? await d.checker.check() : d.checker.readCached();
  if (check === null) return ok('Update', 'not checked yet');
  if (check.error !== undefined) return warn('Update', `check failed (${check.error})`);
  if (check.updateAvailable) {
    return warn(
      'Update',
      `${check.latestVersion ?? 'a newer build'} available — run: ${status.command}`
    );
  }
  const hoursAgo = Math.max(0, Math.floor((d.now() - check.checkedAt) / 3_600_000));
  return ok('Update', `up to date (${check.currentVersion}, checked ${hoursAgo}h ago)`);
}

/** True when a Cursor API key is present in env or config.toml. */
export function isCursorConnectorConfigured(config: MangoConfig): boolean {
  const { envPrefix, tomlSection } = PROVIDER_SECRET_CONFIG.cursor;
  if (hasProviderSecretEnv(envPrefix, mergeConnectorSecretEnv(config))) return true;

  const configPath = config.configFilePath;
  if (!configPath || !existsSync(configPath)) return false;

  return hasProviderTomlSecret(
    tomlSection,
    configPath,
    (path) => parseToml(readFileSync(path, 'utf8')) as Record<string, unknown>
  );
}

/**
 * Reads ChatGPT connector rows straight from SQLite. Opened read-only so
 * doctor never creates or migrates the database; a missing file or table
 * (fresh install) simply means no connectors.
 */
function listChatGptConnectorRows(config: MangoConfig, userId?: string): SecretMetadataRow[] {
  return listConnectorRows(config, 'chatgpt', userId);
}

function listCursorConnectorRows(config: MangoConfig, userId?: string): SecretMetadataRow[] {
  return listConnectorRows(config, 'cursor', userId);
}

/**
 * Connector rows for one provider. `secret_metadata.userId` is nullable — a row
 * with no owner came from the environment or `config.toml` and belongs to the
 * install rather than to an account, so a scoped read keeps those.
 */
function listConnectorRows(
  config: MangoConfig,
  provider: string,
  userId?: string
): SecretMetadataRow[] {
  return userId === undefined
    ? readDbRows<SecretMetadataRow>(config, 'SELECT * FROM secret_metadata WHERE provider = ?', [
        provider,
      ])
    : readDbRows<SecretMetadataRow>(
        config,
        'SELECT * FROM secret_metadata WHERE provider = ? AND (userId = ? OR userId IS NULL)',
        [provider, userId]
      );
}

function mergeConnectorSecretEnv(config: MangoConfig): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...process.env };
  const envFile = parseRuntimeEnvFile(getConfigEnvFilePath(config.configFilePath));

  for (const [key, value] of Object.entries(envFile)) {
    if (!isReloadableSecretEnvKey(key)) continue;
    merged[key] = value;
  }

  return merged;
}

/**
 * Gathers the skills-section inputs doctor needs (source toggles, per-skill
 * disabled flags, and where the effective `skills.dir` came from) and renders
 * the checklist. All reads are offline: SQLite is opened read-only and the
 * filesystem scan never mutates.
 */
function collectSkillsDoctorSection(config: MangoConfig, userId?: string): CheckResult[] {
  return collectSkillsDoctorChecks({
    configDir: config.skills.dir,
    configOrigin: resolveSkillsConfigOrigin(config),
    sourceToggles: readSkillSourceToggles(config, userId),
    disabledKeys: readDisabledSkillKeys(config, userId),
  });
}

/**
 * Resolves the provenance of the effective `skills.dir`, mirroring config
 * precedence: `SKILLS_DIR` (process env or the `.env` beside config.toml) wins,
 * then a `[skills].dir` in config.toml, else the built-in default.
 */
function resolveSkillsConfigOrigin(config: MangoConfig): SkillsConfigOrigin {
  if (process.env.SKILLS_DIR?.trim()) return 'env';
  const envFile = parseRuntimeEnvFile(getConfigEnvFilePath(config.configFilePath));
  if (envFile.SKILLS_DIR?.trim()) return 'env';

  const configPath = config.configFilePath;
  if (configPath && existsSync(configPath)) {
    try {
      const parsed = parseToml(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      const skills = parsed.skills as Record<string, unknown> | undefined;
      if (skills && typeof skills.dir === 'string' && skills.dir.trim()) return 'toml';
    } catch {
      // A malformed config.toml is reported by the Config row; treat as default here.
    }
  }
  return 'default';
}

/**
 * Skill keys switched off in per-skill settings. Without a `userId` these span
 * every account and a key disabled for any of them counts as disabled, which is
 * what the local CLI wants; with one they are that account's answer.
 */
function readDisabledSkillKeys(config: MangoConfig, userId?: string): Set<string> {
  const rows =
    userId === undefined
      ? readDbRows<{ skillKey: string }>(
          config,
          'SELECT skillKey FROM user_skill_settings WHERE enabled = 0'
        )
      : readDbRows<{ skillKey: string }>(
          config,
          'SELECT skillKey FROM user_skill_settings WHERE enabled = 0 AND userId = ?',
          [userId]
        );
  return new Set(rows.map((row) => row.skillKey));
}

/** Third-party source toggles, read the same way and with the same scoping. */
function readSkillSourceToggles(
  config: MangoConfig,
  userId?: string
): { agents: boolean; claude: boolean } {
  const rows =
    userId === undefined
      ? readDbRows<{ settingsJson: string }>(config, 'SELECT settingsJson FROM user_app_settings')
      : readDbRows<{ settingsJson: string }>(
          config,
          'SELECT settingsJson FROM user_app_settings WHERE userId = ?',
          [userId]
        );
  const toggles = { agents: false, claude: false };
  for (const row of rows) {
    const settings = parseSettingsJson(row.settingsJson);
    const legacy = parseBooleanRecord(settings.skillSources);
    const nestedDefault =
      settings.profileSettings &&
      typeof settings.profileSettings === 'object' &&
      !Array.isArray(settings.profileSettings)
        ? (settings.profileSettings as Record<string, unknown>).default
        : undefined;
    const nestedLocations =
      nestedDefault && typeof nestedDefault === 'object' && !Array.isArray(nestedDefault)
        ? (nestedDefault as Record<string, unknown>).libraryLocations
        : undefined;
    const locations = normalizeLibraryLocationSettings(
      nestedLocations ?? settings.libraryLocations,
      {
        home: {
          'mango-skills': true,
          'agents-skills': legacy.agents ?? false,
          'claude-skills': legacy.claude ?? false,
        },
        workspace: {},
      }
    );
    if (locations.home['agents-skills']) toggles.agents = true;
    if (locations.home['claude-skills']) toggles.claude = true;
  }
  return toggles;
}

function parseBooleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      typeof entry === 'boolean' ? [[key, entry]] : []
    )
  );
}

function parseSettingsJson(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * MCP server rows, ordered like the settings list. `userId` scopes them to one
 * account; without it every row is returned, which is what the local CLI wants
 * — see {@link DoctorCollectOptions.userId}.
 */
function listMcpServerRows(config: MangoConfig, userId?: string): McpServerSelect[] {
  return userId === undefined
    ? readDbRows<McpServerSelect>(config, 'SELECT * FROM mcp_servers ORDER BY createdAt ASC')
    : readDbRows<McpServerSelect>(
        config,
        'SELECT * FROM mcp_servers WHERE userId = ? ORDER BY createdAt ASC',
        [userId]
      );
}

/**
 * Runs a read-only query against the SQLite file, returning [] on any failure
 * (missing file, absent table on a fresh install). Doctor never creates or
 * migrates the database.
 */
function readDbRows<T>(
  config: MangoConfig,
  query: string,
  parameters: readonly string[] = []
): T[] {
  const dbPath = config.database.path;
  if (dbPath === ':memory:' || !existsSync(dbPath)) return [];

  let db: SQLiteDatabase | null = null;
  try {
    db = new SQLiteDatabase(dbPath, { readonly: true });
    return db.query(query).all(...parameters) as unknown as T[];
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
