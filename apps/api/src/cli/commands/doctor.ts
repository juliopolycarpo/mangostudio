/**
 * `doctor` command: run environment and configuration diagnostics and print a
 * plain-text checklist. Exits non-zero if any check fails.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { normalizeLibraryLocationSettings } from '@mangostudio/shared/app-settings';
import { parseRuntimeEnvFile } from '@mangostudio/shared/runtime-env';
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import { parse as parseToml } from 'smol-toml';
import type { McpServerSelect } from '../../db/types';
import {
  BUILD_INFO_FILENAME,
  type BuildInfo,
  getBuildInfo,
  getCurrentCheckoutBuildInfo,
  readBuildInfoFile,
  readFrontendBuildInfo,
} from '../../lib/build-info';
import {
  getConfigEnvFilePath,
  getHomeMangoDir,
  getVersion,
  isReloadableSecretEnvKey,
  loadConfig,
  type MangoConfig,
} from '../../lib/config';
import { getLogsDir, getRunDir } from '../../lib/mango-paths';
import { getDefaultFrontendDir, isStandaloneExecutable } from '../../lib/runtime-paths';
import { isStateLive, readState, type ServerState } from '../../lib/server-state';
import {
  hasProviderSecretEnv,
  hasProviderTomlSecret,
  PROVIDER_SECRET_CONFIG,
} from '../../modules/connectors/domain/connector';
import type { SkillsConfigOrigin } from '../../modules/skills/application/skill-diagnostics';
import {
  EMBEDDED_FRONTEND_DIR,
  type EmbeddedFrontendFiles,
  getEmbeddedFrontend,
} from '../../server/embedded-frontend';
import type { DoctorArgs } from '../args';
import { DEFAULT_DOCTOR_ARGS } from '../args';
import { collectChatGptDoctorChecks } from '../chatgpt-doctor-checks';
import {
  type CheckResult,
  type CheckStatus,
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
} from '../doctor-checks';
import { collectEnvironmentDoctorSection } from '../environment-doctor-checks';
import { collectLibraryDoctorSection } from '../library-doctor-checks';
import { collectMcpDoctorChecks } from '../mcp-doctor-checks';
import { writeLine } from '../output';
import { createProcessController, type ProcessController } from '../process-control';
import { probeRuntimeBinary, type RuntimeBinaryProbe } from '../runtime-binary-probe';
import { probeRuntimeCache } from '../runtime-cache-probe';
import { probeRuntimeSlots, type RuntimeSlotProbe } from '../runtime-slot-probe';
import { collectSkillsDoctorChecks } from '../skills-doctor-checks';
import { probeSshClient, type SshClientProbe } from '../ssh-client-probe';

export interface DoctorDeps {
  loadConfig: () => MangoConfig;
  fs: FsProbe;
  frontendDir: () => string;
  controller: ProcessController;
  readState: typeof readState;
  isCursorConfigured: (config: MangoConfig) => boolean;
  probeRuntimeBinary: () => Promise<RuntimeBinaryProbe>;
  probeRuntimeSlots: () => Promise<RuntimeSlotProbe[]>;
  probeSshClient: () => Promise<SshClientProbe>;
  listChatGptConnectors: (config: MangoConfig) => SecretMetadataRow[];
  collectChatGptChecks: (
    config: MangoConfig,
    connectors: readonly SecretMetadataRow[],
    refresh: boolean
  ) => Promise<CheckResult[]>;
  getBuildInfo: () => BuildInfo;
  getCheckoutBuildInfo: () => BuildInfo;
  readFrontendBuildInfo: (frontendDir: string) => BuildInfo | null;
  getEmbeddedFrontend: () => EmbeddedFrontendFiles | null;
  collectSkillsChecks: (config: MangoConfig) => CheckResult[];
  listMcpServers: (config: MangoConfig) => McpServerSelect[];
  collectMcpChecks: (
    rows: readonly McpServerSelect[],
    options: { probe: boolean; serverRunning: boolean }
  ) => Promise<CheckResult[]>;
  collectEnvironmentChecks: () => Promise<CheckResult[]>;
  collectLibraryChecks: () => Promise<CheckResult[]>;
  log: (msg: string) => void;
  exit: (code: number) => void;
}

interface InstanceProbe {
  state: ServerState | null;
  alive: boolean;
}

/** Run diagnostics and print a checklist; exit 1 on any failure. // Usage: await runDoctor() */
export async function runDoctor(
  options: DoctorArgs = DEFAULT_DOCTOR_ARGS,
  deps: Partial<DoctorDeps> = {}
): Promise<void> {
  const d = resolveDeps(deps);
  const config = d.loadConfig();
  const results = await collectResults(config, options, d);
  render(results, options, d);
}

async function collectResults(
  config: MangoConfig,
  options: DoctorArgs,
  d: Required<DoctorDeps>
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
  const includeEnvSection = !options.libraryOnly || options.envOnly;
  const includeLibrarySection = !options.envOnly || options.libraryOnly;

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
    checkRuntimeBinary(await d.probeRuntimeBinary(), getVersion()),
    ...(await d.probeRuntimeSlots()).map(checkRuntimeSlot),
    checkRuntimeCache(await probeRuntimeCache()),
    checkSshClient(await d.probeSshClient()),
    ...collectBuildIdentityChecks({
      serverBuild,
      checkoutBuild: d.getCheckoutBuildInfo(),
      frontendBuild: embedded
        ? readEmbeddedFrontendBuildInfo(embedded)
        : d.readFrontendBuildInfo(frontendDir),
      frontendDir,
    }),
  ];

  if (!sectionFilter) {
    // Not a health check — a migration notice. The provider is deprecated and
    // refuses every turn, so what matters is whether anyone still has a key
    // sitting there, which is also the evidence the removal cycle needs before
    // the connector and its secret can go.
    if (d.isCursorConfigured(config)) {
      results.push(
        warn(
          'Cursor connector',
          'Deprecated provider. Use the Cursor CLI runner in the chat runner selector; this key no longer runs turns.'
        )
      );
    }

    const chatgptConnectors = d.listChatGptConnectors(config);
    if (chatgptConnectors.length > 0 || options.all) {
      results.push(
        ...(await d.collectChatGptChecks(config, chatgptConnectors, options.chatgptRefresh))
      );
    }

    results.push(...d.collectSkillsChecks(config));

    const mcpServers = d.listMcpServers(config);
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
  d: Required<DoctorDeps>
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

async function inspectInstance(d: Required<DoctorDeps>): Promise<InstanceProbe> {
  const state = await d.readState();
  if (!state) {
    return { state: null, alive: false };
  }
  const alive = isStateLive(state, (pid) => d.controller.isAlive(pid));
  return { state, alive };
}

function render(results: CheckResult[], options: DoctorArgs, d: Required<DoctorDeps>): void {
  const failures = results.filter((r) => r.status === 'fail').length;
  const warnings = results.filter((r) => r.status === 'warn').length;

  if (options.json) {
    d.log(
      JSON.stringify(
        {
          checks: results,
          warnings,
          failures,
        },
        null,
        2
      )
    );
    if (failures > 0) {
      d.exit(1);
    }
    return;
  }

  d.log('MangoStudio doctor\n');
  for (const result of results) {
    d.log(`${badge(result.status)} ${result.label.padEnd(18)} ${result.detail}`);
  }

  d.log(`\n${warnings} warning(s), ${failures} failure(s).`);

  if (failures > 0) {
    d.exit(1);
  }
}

function badge(status: CheckStatus): string {
  if (status === 'ok') {
    return '[ok]  ';
  }
  return status === 'warn' ? '[warn]' : '[fail]';
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

function resolveDeps(deps: Partial<DoctorDeps>): Required<DoctorDeps> {
  return {
    loadConfig: deps.loadConfig ?? (() => loadConfig()),
    fs: deps.fs ?? realFsProbe(),
    frontendDir: deps.frontendDir ?? getDefaultFrontendDir,
    controller: deps.controller ?? createProcessController(),
    readState: deps.readState ?? readState,
    isCursorConfigured: deps.isCursorConfigured ?? isCursorConnectorConfigured,
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
    log: deps.log ?? writeLine,
    exit: deps.exit ?? ((code) => process.exit(code)),
  };
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
function listChatGptConnectorRows(config: MangoConfig): SecretMetadataRow[] {
  return readDbRows<SecretMetadataRow>(
    config,
    "SELECT * FROM secret_metadata WHERE provider = 'chatgpt'"
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
function collectSkillsDoctorSection(config: MangoConfig): CheckResult[] {
  return collectSkillsDoctorChecks({
    configDir: config.skills.dir,
    configOrigin: resolveSkillsConfigOrigin(config),
    sourceToggles: readSkillSourceToggles(config),
    disabledKeys: readDisabledSkillKeys(config),
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
 * Skill keys switched off in per-skill settings, across all users (doctor is a
 * local single-user tool). A key disabled for any user counts as disabled.
 */
function readDisabledSkillKeys(config: MangoConfig): Set<string> {
  const rows = readDbRows<{ skillKey: string }>(
    config,
    'SELECT skillKey FROM user_skill_settings WHERE enabled = 0'
  );
  return new Set(rows.map((row) => row.skillKey));
}

/** Third-party source toggles; a source enabled for any user is treated as on. */
function readSkillSourceToggles(config: MangoConfig): { agents: boolean; claude: boolean } {
  const rows = readDbRows<{ settingsJson: string }>(
    config,
    'SELECT settingsJson FROM user_app_settings'
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

/** MCP server rows across all users, ordered like the settings list. */
function listMcpServerRows(config: MangoConfig): McpServerSelect[] {
  return readDbRows<McpServerSelect>(config, 'SELECT * FROM mcp_servers ORDER BY createdAt ASC');
}

/**
 * Runs a read-only query against the SQLite file, returning [] on any failure
 * (missing file, absent table on a fresh install). Doctor never creates or
 * migrates the database.
 */
function readDbRows<T>(config: MangoConfig, query: string): T[] {
  const dbPath = config.database.path;
  if (dbPath === ':memory:' || !existsSync(dbPath)) return [];

  let db: SQLiteDatabase | null = null;
  try {
    db = new SQLiteDatabase(dbPath, { readonly: true });
    return db.query(query).all() as unknown as T[];
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
