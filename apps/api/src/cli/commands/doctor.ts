/**
 * `doctor` command: run environment and configuration diagnostics and print a
 * plain-text checklist. Exits non-zero if any check fails.
 */

import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import { getHomeMangoDir, getVersion, loadConfig, type MangoConfig } from '../../lib/config';
import { getLogsDir, getRunDir } from '../../lib/mango-paths';
import { getDefaultFrontendDir, isStandaloneExecutable } from '../../lib/runtime-paths';
import { isStateLive, readState, type ServerState } from '../../lib/server-state';
import {
  detectNodeRuntime,
  type NodeRuntimeStatus,
} from '../../services/providers/cursor/node-runtime';
import {
  type CheckResult,
  type CheckStatus,
  checkAuthSecret,
  checkConfig,
  checkCursorNodeRuntime,
  checkDatabase,
  checkDir,
  checkFrontend,
  checkInstance,
  checkRuntime,
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
  detectNodeRuntime: () => Promise<NodeRuntimeStatus>;
  isCursorConfigured: (config: MangoConfig) => boolean;
  log: (msg: string) => void;
  exit: (code: number) => void;
}

interface InstanceProbe {
  state: ServerState | null;
  alive: boolean;
}

/** Run diagnostics and print a checklist; exit 1 on any failure. // Usage: await runDoctor() */
export async function runDoctor(deps: Partial<DoctorDeps> = {}): Promise<void> {
  const d = resolveDeps(deps);
  const config = d.loadConfig();
  const results = await collectResults(config, d);
  render(results, d);
}

async function collectResults(
  config: MangoConfig,
  d: Required<DoctorDeps>
): Promise<CheckResult[]> {
  const instance = await inspectInstance(d);
  const results: CheckResult[] = [
    checkDir('Home directory', getHomeMangoDir(), d.fs),
    checkDir('Logs directory', getLogsDir(), d.fs),
    checkDir('Run directory', getRunDir(), d.fs),
    checkConfig(config),
    checkDatabase(config, d.fs),
    checkFrontend(d.frontendDir(), d.fs),
    checkAuthSecret(config),
    checkInstance(instance.state, instance.alive),
    checkRuntime(getVersion(), isStandaloneExecutable()),
  ];

  if (d.isCursorConfigured(config)) {
    const runtime = await d.detectNodeRuntime();
    results.push(checkCursorNodeRuntime(runtime));
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
    detectNodeRuntime: deps.detectNodeRuntime ?? detectNodeRuntime,
    isCursorConfigured: deps.isCursorConfigured ?? isCursorConnectorConfigured,
    log: deps.log ?? writeLine,
    exit: deps.exit ?? ((code) => process.exit(code)),
  };
}

/** True when a Cursor API key is present in env or config.toml. */
export function isCursorConnectorConfigured(config: MangoConfig): boolean {
  if (process.env.CURSOR_API_KEY?.trim()) return true;

  const configPath = config.configFilePath;
  if (!configPath || !existsSync(configPath)) return false;

  try {
    const parsed = parseToml(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const section = parsed.cursor_api_keys;
    if (!section || typeof section !== 'object') return false;
    return Object.values(section as Record<string, unknown>).some(
      (value) => typeof value === 'string' && value.trim().length > 0
    );
  } catch {
    return false;
  }
}
