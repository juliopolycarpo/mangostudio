/**
 * `doctor` command: run environment and configuration diagnostics and print a
 * plain-text checklist. Exits non-zero if any check fails.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { parseRuntimeEnvFile } from '@mangostudio/shared/runtime-env';
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import { parse as parseToml } from 'smol-toml';
import {
  type BuildInfo,
  getBuildInfo,
  getCurrentCheckoutBuildInfo,
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
import { detectNodeRuntime } from '../../services/providers/cursor/node-runtime';
import {
  type CursorRuntimeChainStep,
  describeCursorRuntimeChain,
} from '../../services/providers/cursor/runtime-availability';
import type { DoctorArgs } from '../args';
import { collectChatGptDoctorChecks } from '../chatgpt-doctor-checks';
import { probeCursorDoctorRuntime } from '../cursor-doctor-probe';
import {
  type CheckResult,
  type CheckStatus,
  checkAuthSecret,
  checkConfig,
  checkDatabase,
  checkDir,
  checkFrontend,
  checkInstance,
  checkRuntime,
  collectBuildIdentityChecks,
  collectCursorDoctorChecks,
  cursorRuntimeChainReady,
  type FsProbe,
} from '../doctor-checks';
import { writeLine } from '../output';
import { createProcessController, type ProcessController } from '../process-control';

export interface DoctorDeps {
  loadConfig: () => MangoConfig;
  fs: FsProbe;
  frontendDir: () => string;
  controller: ProcessController;
  readState: typeof readState;
  getCursorDoctorChain: () => Promise<readonly CursorRuntimeChainStep[]>;
  isCursorConfigured: (config: MangoConfig) => boolean;
  probeCursorRuntime: typeof probeCursorDoctorRuntime;
  listChatGptConnectors: (config: MangoConfig) => SecretMetadataRow[];
  collectChatGptChecks: (
    config: MangoConfig,
    connectors: readonly SecretMetadataRow[],
    refresh: boolean
  ) => Promise<CheckResult[]>;
  getBuildInfo: () => BuildInfo;
  getCheckoutBuildInfo: () => BuildInfo;
  readFrontendBuildInfo: (frontendDir: string) => BuildInfo | null;
  log: (msg: string) => void;
  exit: (code: number) => void;
}

interface InstanceProbe {
  state: ServerState | null;
  alive: boolean;
}

/** Run diagnostics and print a checklist; exit 1 on any failure. // Usage: await runDoctor() */
export async function runDoctor(
  options: DoctorArgs = { all: false, cursorProbe: false, chatgptRefresh: false },
  deps: Partial<DoctorDeps> = {}
): Promise<void> {
  const d = resolveDeps(deps);
  const config = d.loadConfig();
  const results = await collectResults(config, options, d);
  render(results, d);
}

async function collectResults(
  config: MangoConfig,
  options: DoctorArgs,
  d: Required<DoctorDeps>
): Promise<CheckResult[]> {
  const instance = await inspectInstance(d);
  const frontendDir = instance.alive
    ? (instance.state?.frontendDir ?? d.frontendDir())
    : d.frontendDir();
  const serverBuild = instance.alive ? (instance.state?.buildInfo ?? null) : d.getBuildInfo();
  const results: CheckResult[] = [
    checkDir('Home directory', getHomeMangoDir(), d.fs),
    checkDir('Logs directory', getLogsDir(), d.fs),
    checkDir('Run directory', getRunDir(), d.fs),
    checkConfig(config),
    checkDatabase(config, d.fs),
    checkFrontend(frontendDir, d.fs),
    checkAuthSecret(config),
    checkInstance(instance.state, instance.alive),
    checkRuntime(getVersion(), isStandaloneExecutable()),
    ...collectBuildIdentityChecks({
      serverBuild,
      checkoutBuild: d.getCheckoutBuildInfo(),
      frontendBuild: d.readFrontendBuildInfo(frontendDir),
      frontendDir,
    }),
  ];

  if (d.isCursorConfigured(config) || options.all) {
    const chain = await d.getCursorDoctorChain();
    const probe =
      options.cursorProbe && cursorRuntimeChainReady(chain)
        ? await d.probeCursorRuntime()
        : undefined;
    results.push(...collectCursorDoctorChecks(chain, probe));
  }

  const chatgptConnectors = d.listChatGptConnectors(config);
  if (chatgptConnectors.length > 0 || options.all) {
    results.push(
      ...(await d.collectChatGptChecks(config, chatgptConnectors, options.chatgptRefresh))
    );
  }

  return results;
}

async function inspectInstance(d: Required<DoctorDeps>): Promise<InstanceProbe> {
  const state = await d.readState();
  if (!state) {
    return { state: null, alive: false };
  }
  const alive = isStateLive(state, (pid) => d.controller.isAlive(pid));
  return { state, alive };
}

function render(results: CheckResult[], d: Required<DoctorDeps>): void {
  d.log('MangoStudio doctor\n');
  for (const result of results) {
    d.log(`${badge(result.status)} ${result.label.padEnd(18)} ${result.detail}`);
  }

  const failures = results.filter((r) => r.status === 'fail').length;
  const warnings = results.filter((r) => r.status === 'warn').length;
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
    getCursorDoctorChain:
      deps.getCursorDoctorChain ??
      (async () => describeCursorRuntimeChain(await detectNodeRuntime())),
    isCursorConfigured: deps.isCursorConfigured ?? isCursorConnectorConfigured,
    probeCursorRuntime: deps.probeCursorRuntime ?? probeCursorDoctorRuntime,
    listChatGptConnectors: deps.listChatGptConnectors ?? listChatGptConnectorRows,
    collectChatGptChecks:
      deps.collectChatGptChecks ??
      ((config, connectors, refresh) => collectChatGptDoctorChecks(config, connectors, refresh)),
    getBuildInfo: deps.getBuildInfo ?? getBuildInfo,
    getCheckoutBuildInfo: deps.getCheckoutBuildInfo ?? getCurrentCheckoutBuildInfo,
    readFrontendBuildInfo: deps.readFrontendBuildInfo ?? readFrontendBuildInfo,
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
export function listChatGptConnectorRows(config: MangoConfig): SecretMetadataRow[] {
  const dbPath = config.database.path;
  if (dbPath === ':memory:' || !existsSync(dbPath)) return [];

  let db: SQLiteDatabase | null = null;
  try {
    db = new SQLiteDatabase(dbPath, { readonly: true });
    return db
      .query("SELECT * FROM secret_metadata WHERE provider = 'chatgpt'")
      .all() as unknown as SecretMetadataRow[];
  } catch {
    return [];
  } finally {
    db?.close();
  }
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
