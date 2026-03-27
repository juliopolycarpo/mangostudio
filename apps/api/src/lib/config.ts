/**
 * Centralized configuration loader for MangoStudio.
 *
 * Resolution hierarchy (highest priority wins):
 * 1. process.env           (shell environment — works in both dev and standalone binary)
 * 2. ./.mango/.env         (if it exists, overrides matching config.toml keys)
 * 3. config.toml           (dev: ./.mango/config.toml | build: ~/.mango/config.toml)
 * 4. Hardcoded defaults
 */

import { parse as parseToml } from 'smol-toml';
import { readFileSync, existsSync } from 'fs';
import { join, isAbsolute } from 'path';
import { homedir } from 'os';
import { isStandaloneExecutable } from './runtime-paths';

/**
 * Absolute path to the monorepo root, derived from this file's location.
 * config.ts lives at apps/api/src/lib/ → 4 levels up is the repo root.
 */
const MONOREPO_ROOT = join(import.meta.dir, '../../../..');

/**
 * Resolves a user-supplied path to an absolute path.
 * Relative paths (starting with ./ or ../) are resolved against the
 * monorepo root so that config.toml values behave consistently
 * regardless of the process CWD when workspace scripts run.
 * Absolute paths are returned unchanged.
 */
function resolveUserPath(userPath: string): string {
  if (isAbsolute(userPath)) return userPath;
  return join(MONOREPO_ROOT, userPath);
}

export interface MangoConfig {
  server: {
    host: string;
    port: number;
  };
  frontend: {
    host: string;
    port: number;
  };
  database: {
    path: string;
  };
  uploads: {
    dir: string;
  };
  auth: {
    secret: string;
    url: string;
  };
  /** Computed CORS origins derived from frontend host/port. */
  corsOrigins: string[];
  /** Path to the config.toml that was loaded (for TOML-based services). */
  configFilePath: string;
}

const DEFAULT_CONFIG: Omit<MangoConfig, 'corsOrigins' | 'configFilePath'> = {
  server: { host: 'localhost', port: 3001 },
  frontend: { host: 'localhost', port: 5173 },
  database: { path: '' },
  uploads: { dir: '' },
  auth: { secret: '', url: '' },
};

/** Maps .env keys to config paths for override resolution. */
const ENV_KEY_MAP: Record<string, (cfg: MangoConfig, value: string) => void> = {
  API_PORT: (cfg, v) => {
    cfg.server.port = Number(v) || cfg.server.port;
  },
  API_HOST: (cfg, v) => {
    cfg.server.host = v;
  },
  FRONTEND_PORT: (cfg, v) => {
    cfg.frontend.port = Number(v) || cfg.frontend.port;
  },
  DATABASE_PATH: (cfg, v) => {
    cfg.database.path = v;
  },
  UPLOADS_DIR: (cfg, v) => {
    cfg.uploads.dir = v;
  },
  BETTER_AUTH_SECRET: (cfg, v) => {
    cfg.auth.secret = v;
  },
  BETTER_AUTH_URL: (cfg, v) => {
    cfg.auth.url = v;
  },
};

/**
 * Returns the .mango directory at the monorepo root.
 * Uses import.meta.dir (this file's directory) to navigate reliably
 * regardless of the process CWD when workspace scripts run.
 * config.ts lives at apps/api/src/lib/ → 4 levels up is the repo root.
 */
export function getMangoDir(): string {
  return join(import.meta.dir, '../../../../.mango');
}

function getHomeMangoDir(): string {
  return join(homedir(), '.mango');
}

/** Resolves the config.toml path based on runtime mode. */
function resolveConfigTomlPath(): string {
  const localPath = join(getMangoDir(), 'config.toml');
  if (!isStandaloneExecutable() && existsSync(localPath)) {
    return localPath;
  }
  return join(getHomeMangoDir(), 'config.toml');
}

/** Parses a .env file into a key-value map (simple KEY=VALUE lines). */
function parseEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(filePath)) return result;

  try {
    const content = readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      result[key] = value;
    }
  } catch {
    // Ignore read errors — config.toml or defaults will be used
  }
  return result;
}

/** Deep-clones the default config. */
function cloneDefaults(): MangoConfig {
  return {
    server: { ...DEFAULT_CONFIG.server },
    frontend: { ...DEFAULT_CONFIG.frontend },
    database: { ...DEFAULT_CONFIG.database },
    uploads: { ...DEFAULT_CONFIG.uploads },
    auth: { ...DEFAULT_CONFIG.auth },
    corsOrigins: [],
    configFilePath: '',
  };
}

/** Applies parsed TOML sections onto a config object. */
function applyToml(cfg: MangoConfig, parsed: Record<string, unknown>): void {
  const server = parsed.server as Record<string, unknown> | undefined;
  if (server) {
    if (typeof server.host === 'string') cfg.server.host = server.host;
    if (typeof server.port === 'number') cfg.server.port = server.port;
  }

  const frontend = parsed.frontend as Record<string, unknown> | undefined;
  if (frontend) {
    if (typeof frontend.host === 'string') cfg.frontend.host = frontend.host;
    if (typeof frontend.port === 'number') cfg.frontend.port = frontend.port;
  }

  const database = parsed.database as Record<string, unknown> | undefined;
  if (database) {
    if (typeof database.path === 'string') cfg.database.path = database.path;
  }

  const uploads = parsed.uploads as Record<string, unknown> | undefined;
  if (uploads) {
    if (typeof uploads.dir === 'string') cfg.uploads.dir = uploads.dir;
  }

  const auth = parsed.auth as Record<string, unknown> | undefined;
  if (auth) {
    if (typeof auth.secret === 'string') cfg.auth.secret = auth.secret;
    if (typeof auth.url === 'string') cfg.auth.url = auth.url;
  }
}

/** Applies .env overrides onto a config object. */
function applyEnvOverrides(cfg: MangoConfig, env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    const applier = ENV_KEY_MAP[key];
    if (applier && value) {
      applier(cfg, value);
    }
  }
}

/** Computes derived values after all overrides are applied. */
function computeDerived(cfg: MangoConfig, tomlPath: string): void {
  cfg.configFilePath = tomlPath;

  // auth.url defaults to server address
  if (!cfg.auth.url) {
    cfg.auth.url = `http://${cfg.server.host}:${cfg.server.port}`;
  }

  // database.path: auto-detect when empty, resolve relative paths against monorepo root
  if (!cfg.database.path) {
    if (isStandaloneExecutable()) {
      cfg.database.path = join(getHomeMangoDir(), 'database.sqlite');
    } else {
      cfg.database.path = join(getMangoDir(), 'database.sqlite');
    }
  } else {
    cfg.database.path = resolveUserPath(cfg.database.path);
  }

  // uploads.dir: auto-detect when empty, resolve relative paths against monorepo root
  if (!cfg.uploads.dir) {
    cfg.uploads.dir = isStandaloneExecutable()
      ? join(getHomeMangoDir(), 'uploads') // ~/.mango/uploads in standalone mode
      : join(getMangoDir(), 'uploads'); // .mango/uploads in dev mode
  } else {
    cfg.uploads.dir = resolveUserPath(cfg.uploads.dir);
  }

  // CORS origins from frontend host/port (include +1 for Vite port bumping)
  const fHost = cfg.frontend.host;
  const fPort = cfg.frontend.port;
  cfg.corsOrigins = [
    `http://localhost:${fPort}`,
    `http://127.0.0.1:${fPort}`,
    `http://localhost:${fPort + 1}`,
    `http://127.0.0.1:${fPort + 1}`,
  ];
  // Add explicit frontend host if it differs from localhost
  if (fHost !== 'localhost' && fHost !== '127.0.0.1') {
    cfg.corsOrigins.push(`http://${fHost}:${fPort}`);
    cfg.corsOrigins.push(`http://${fHost}:${fPort + 1}`);
  }

  // Include the server's own origin for same-origin deployments (standalone binary).
  //
  // In standalone mode the runner scripts (run.sh / run.bat) launch the binary with
  // API_PORT set to whatever port the user chose. The binary reads that value via
  // process.env, applies it as cfg.server.port (step 3 of loadConfig), and then
  // computeDerived() runs — so sPort below is already the final resolved port,
  // regardless of whether it came from config.toml, .env, or API_PORT.
  //
  // The frontend is served by the API process itself at that same origin.
  // The browser therefore sends Origin: http://<host>:<sPort> on CORS preflight
  // requests (e.g. POST with JSON body). Both the Elysia CORS middleware and
  // Better Auth trustedOrigins validate against corsOrigins, so this origin must
  // be present or same-origin requests from the binary-served frontend are rejected.
  const sHost = cfg.server.host;
  const sPort = cfg.server.port;
  cfg.corsOrigins.push(`http://localhost:${sPort}`);
  cfg.corsOrigins.push(`http://127.0.0.1:${sPort}`);
  if (sHost !== 'localhost' && sHost !== '127.0.0.1') {
    cfg.corsOrigins.push(`http://${sHost}:${sPort}`);
  }
}

/**
 * Loads configuration from config.toml with .env overrides.
 * @param overridePath - Force a specific config.toml path (for tests).
 */
export function loadConfig(overridePath?: string): MangoConfig {
  const cfg = cloneDefaults();

  // 1. Determine and read config.toml
  const tomlPath = overridePath ?? resolveConfigTomlPath();
  if (existsSync(tomlPath)) {
    try {
      const content = readFileSync(tomlPath, 'utf8');
      const parsed = parseToml(content) as Record<string, unknown>;
      applyToml(cfg, parsed);
    } catch (err) {
      console.warn(`[config] Failed to parse ${tomlPath}:`, err);
    }
  }

  // 2. Read ./.mango/.env (overrides config.toml)
  const envPath = join(getMangoDir(), '.env');
  const envOverrides = parseEnvFile(envPath);
  applyEnvOverrides(cfg, envOverrides);

  // 3. Apply process.env (highest priority — works in dev and standalone binary)
  applyEnvOverrides(cfg, process.env as Record<string, string>);

  // 4. Compute derived values
  computeDerived(cfg, tomlPath);

  return cfg;
}

// -- Singleton management --

let configInstance: MangoConfig | null = null;

/**
 * Returns the cached config singleton. Loads from disk on first call.
 */
export function getConfig(): MangoConfig {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}

/**
 * Clears the cached singleton (for tests).
 */
export function resetConfig(): void {
  configInstance = null;
}

/**
 * Sets the config singleton from partial overrides without reading any file.
 * Intended for tests only.
 */
export function loadConfigForTest(partial: Partial<MangoConfig> = {}): MangoConfig {
  const cfg = cloneDefaults();

  // Apply partial overrides
  if (partial.server) Object.assign(cfg.server, partial.server);
  if (partial.frontend) Object.assign(cfg.frontend, partial.frontend);
  if (partial.database) Object.assign(cfg.database, partial.database);
  if (partial.uploads) Object.assign(cfg.uploads, partial.uploads);
  if (partial.auth) Object.assign(cfg.auth, partial.auth);
  if (partial.corsOrigins) cfg.corsOrigins = partial.corsOrigins;
  if (partial.configFilePath) cfg.configFilePath = partial.configFilePath;

  // Compute derived values for fields not explicitly set
  computeDerived(cfg, cfg.configFilePath || '/dev/null');

  configInstance = cfg;
  return cfg;
}
