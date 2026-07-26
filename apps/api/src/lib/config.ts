/**
 * Centralized configuration loader for MangoStudio.
 *
 * Resolution hierarchy (highest priority wins):
 * 1. process.env           (shell environment — works in both dev and standalone binary)
 * 2. .env next to config.toml (if it exists, overrides matching config.toml keys)
 * 3. config.toml           (~/.mango/config.toml in dev and standalone)
 * 4. Hardcoded defaults
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { parseRuntimeEnvFile } from '@mangostudio/shared/runtime-env';
import { parse as parseToml } from 'smol-toml';

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
  images: {
    dir: string;
  };
  agents: {
    dir: string;
  };
  skills: {
    dir: string;
  };
  library: {
    /** Recoverable copies created before library resources are overwritten. */
    backupDir: string;
    /** Maximum number of apply backup sets retained on disk. */
    backupRetentionCount: number;
  };
  checkpoints: {
    dir: string;
  };
  auth: {
    secret: string;
    url: string;
  };
  security: {
    /**
     * Trust proxy headers (X-Forwarded-For, X-Real-IP, CF-Connecting-IP) when
     * resolving the client IP for rate limiting. Enable ONLY when the app runs
     * behind a reverse proxy that overwrites these headers (e.g. nginx, a load
     * balancer, Docker behind a proxy); otherwise clients can spoof them.
     */
    trustProxy: boolean;
  };
  environments: {
    /** Opt in to refreshing Node release metadata from nodejs.org. */
    ltsRefresh: boolean;
    /** Permit guarded local runtime and agent CLI installation. */
    installsEnabled: boolean;
  };
  /** Computed CORS origins derived from frontend host/port. */
  corsOrigins: string[];
  /** Path to the config.toml that was loaded (for TOML-based services). */
  configFilePath: string;
  cursor: {
    /** Workspace directory for Cursor SDK local agents. Empty = process.cwd(). */
    workspaceDir: string;
    /** Override path to the Cursor SDK sidecar script. Empty = auto-detect. */
    sidecarScriptPath: string;
    /** Override path to the Node.js binary for the sidecar. Empty = auto-detect. */
    nodePath: string;
  };
  chatgpt: {
    /** ChatGPT OAuth issuer base URL. Override only for tests/debugging. */
    authBaseUrl: string;
    /** ChatGPT API base URL. Override only for tests/debugging. */
    apiBaseUrl: string;
  };
  secretStore: {
    /**
     * Unsafe plaintext secret-store directory for automated smoke tests.
     * When set, this replaces the native Bun.secrets backend.
     */
    unsafeFileFallbackDir: string;
  };
}

const DEFAULT_CONFIG: Omit<MangoConfig, 'corsOrigins' | 'configFilePath'> = {
  server: { host: '0.0.0.0', port: 3001 },
  frontend: { host: 'localhost', port: 5173 },
  database: { path: '' },
  uploads: { dir: '' },
  images: { dir: '' },
  agents: { dir: '' },
  skills: { dir: '' },
  library: { backupDir: '', backupRetentionCount: 10 },
  checkpoints: { dir: '' },
  auth: { secret: '', url: '' },
  security: { trustProxy: false },
  environments: { ltsRefresh: false, installsEnabled: false },
  cursor: { workspaceDir: '', sidecarScriptPath: '', nodePath: '' },
  chatgpt: {
    authBaseUrl: 'https://auth.openai.com',
    apiBaseUrl: 'https://chatgpt.com/backend-api/codex',
  },
  secretStore: { unsafeFileFallbackDir: '' },
};

export const AUTH_SECRET_MIN_LENGTH = 32;

/**
 * Parses a boolean-ish env/TOML string. Accepts `1`, `true`, `yes`, `on`
 * (case-insensitive) as true; everything else is false.
 * // Usage: parseBooleanFlag('true') // → true
 */
export function parseBooleanFlag(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

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
  IMAGES_DIR: (cfg, v) => {
    cfg.images.dir = v;
  },
  AGENTS_DIR: (cfg, v) => {
    cfg.agents.dir = v;
  },
  SKILLS_DIR: (cfg, v) => {
    cfg.skills.dir = v;
  },
  CHECKPOINTS_DIR: (cfg, v) => {
    cfg.checkpoints.dir = v;
  },
  BETTER_AUTH_SECRET: (cfg, v) => {
    cfg.auth.secret = v;
  },
  BETTER_AUTH_URL: (cfg, v) => {
    cfg.auth.url = v;
  },
  TRUST_PROXY: (cfg, v) => {
    cfg.security.trustProxy = parseBooleanFlag(v);
  },
  MANGO_ENV_LTS_REFRESH: (cfg, v) => {
    cfg.environments.ltsRefresh = parseBooleanFlag(v);
  },
  MANGO_ENV_INSTALLS_ENABLED: (cfg, v) => {
    cfg.environments.installsEnabled = parseBooleanFlag(v);
  },
  CURSOR_WORKSPACE_DIR: (cfg, v) => {
    cfg.cursor.workspaceDir = v;
  },
  MANGO_CURSOR_SIDECAR_SCRIPT: (cfg, v) => {
    cfg.cursor.sidecarScriptPath = v;
  },
  MANGO_NODE_PATH: (cfg, v) => {
    cfg.cursor.nodePath = v;
  },
  MANGO_CHATGPT_AUTH_BASE_URL: (cfg, v) => {
    cfg.chatgpt.authBaseUrl = v;
  },
  MANGO_CHATGPT_BASE_URL: (cfg, v) => {
    cfg.chatgpt.apiBaseUrl = v;
  },
  MANGO_SECRET_STORE_UNSAFE_FILE_FALLBACK_DIR: (cfg, v) => {
    cfg.secretStore.unsafeFileFallbackDir = v;
  },
  MANGO_LIBRARY_BACKUP_DIR: (cfg, v) => {
    cfg.library.backupDir = v;
  },
  MANGO_LIBRARY_BACKUP_RETENTION_COUNT: (cfg, v) => {
    const count = Number(v);
    if (Number.isSafeInteger(count) && count > 0) {
      cfg.library.backupRetentionCount = count;
    }
  },
};

/**
 * Env var names that carry runtime configuration (the keys of ENV_KEY_MAP).
 * Exported so the detached-spawn allowlist can forward exactly these without a
 * hand-maintained copy that drifts when a new key is added here.
 * // Usage: RUNTIME_CONFIG_ENV_KEYS
 */
export const RUNTIME_CONFIG_ENV_KEYS: readonly string[] = Object.keys(ENV_KEY_MAP);

/**
 * Returns the user-level MangoStudio directory (~/.mango).
 * Used for user config, secrets, and runtime data across dev and standalone modes.
 */
// Usage: getHomeMangoDir() // → "/home/user/.mango"
export function getHomeMangoDir(): string {
  return join(homedir(), '.mango');
}

/**
 * Build version embedded at compile time via process.env.VERSION, or "dev" when
 * running from source. Centralized here so the server state file and `doctor`
 * report the same value. // Usage: getVersion() // → "1.2.3"
 */
export function getVersion(): string {
  return process.env.VERSION || 'dev';
}

/**
 * Maps the IPv4 wildcard bind address to a browser-reachable host. `0.0.0.0`
 * accepts connections on every interface but is not itself routable from a
 * browser, so user-facing URLs and the derived auth baseURL must fall back to
 * localhost. // Usage: displayHost('0.0.0.0') // → "localhost"
 */
export function displayHost(host: string): string {
  return host === '0.0.0.0' ? 'localhost' : host;
}

/**
 * Returns why a Better Auth secret is unusable, or null when it is safe to use.
 * // Usage: getAuthSecretValidationMessage(process.env.BETTER_AUTH_SECRET ?? '')
 */
export function getAuthSecretValidationMessage(secret: string): string | null {
  const trimmed = secret.trim();
  if (!trimmed) {
    return `BETTER_AUTH_SECRET is required and must be at least ${AUTH_SECRET_MIN_LENGTH} characters.`;
  }
  if (trimmed.length < AUTH_SECRET_MIN_LENGTH) {
    return `BETTER_AUTH_SECRET must be at least ${AUTH_SECRET_MIN_LENGTH} characters.`;
  }
  return null;
}

/** Fails before Better Auth can initialize with an unsafe secret. // Usage: assertValidAuthSecret(secret) */
export function assertValidAuthSecret(secret: string): void {
  const message = getAuthSecretValidationMessage(secret);
  if (message) {
    throw new Error(`${message} Set it to a unique random value before starting MangoStudio.`);
  }
}

/** Resolves the canonical user config.toml path. */
function resolveConfigTomlPath(): string {
  return join(getHomeMangoDir(), 'config.toml');
}

/** Returns the .env path paired with a config.toml path. // Usage: getConfigEnvFilePath('/home/me/.mango/config.toml') */
export function getConfigEnvFilePath(configFilePath = resolveConfigTomlPath()): string {
  return join(dirname(configFilePath), '.env');
}

// -- Connector secret env reload --

/**
 * Restricts which .env keys reloadSecretEnv may push into process.env to the
 * connector-secret shape `<PROVIDER>_API_KEY[_<NAME>]`. A malformed or hostile
 * .env line therefore cannot inject a runtime-sensitive variable such as PATH,
 * NODE_OPTIONS, or LD_PRELOAD into the running process.
 * // Usage: isReloadableSecretEnvKey('GEMINI_API_KEY_DEFAULT') // → true
 */
export function isReloadableSecretEnvKey(key: string): boolean {
  return /^[A-Z0-9]+_API_KEY(?:_[A-Z0-9_]+)?$/.test(key);
}

/** Keys reloadSecretEnv injected from the file, tracked so removed keys are dropped. */
let loadedSecretEnvKeys = new Set<string>();

/**
 * Syncs connector secrets from ~/.mango/.env into process.env so adding or removing
 * a key applies to the running server (foreground or detached) without a restart.
 * Only keys passing isReloadableSecretEnvKey are touched, and keys this function
 * previously loaded but the file no longer defines are removed.
 * // Usage: reloadSecretEnv()
 */
export function reloadSecretEnv(): void {
  const parsed = parseRuntimeEnvFile(getConfigEnvFilePath(getConfig().configFilePath));
  const next = new Set<string>();

  for (const [key, value] of Object.entries(parsed)) {
    if (!isReloadableSecretEnvKey(key)) continue;
    process.env[key] = value;
    next.add(key);
  }

  for (const key of loadedSecretEnvKeys) {
    if (!next.has(key)) delete process.env[key];
  }
  loadedSecretEnvKeys = next;
}

/** Clears the reload tracking set (for tests). */
export function resetSecretEnvTracking(): void {
  loadedSecretEnvKeys = new Set();
}

/** Deep-clones the default config. */
function cloneDefaults(): MangoConfig {
  return {
    server: { ...DEFAULT_CONFIG.server },
    frontend: { ...DEFAULT_CONFIG.frontend },
    database: { ...DEFAULT_CONFIG.database },
    uploads: { ...DEFAULT_CONFIG.uploads },
    images: { ...DEFAULT_CONFIG.images },
    agents: { ...DEFAULT_CONFIG.agents },
    skills: { ...DEFAULT_CONFIG.skills },
    library: { ...DEFAULT_CONFIG.library },
    checkpoints: { ...DEFAULT_CONFIG.checkpoints },
    auth: { ...DEFAULT_CONFIG.auth },
    security: { ...DEFAULT_CONFIG.security },
    environments: { ...DEFAULT_CONFIG.environments },
    cursor: { ...DEFAULT_CONFIG.cursor },
    chatgpt: { ...DEFAULT_CONFIG.chatgpt },
    secretStore: { ...DEFAULT_CONFIG.secretStore },
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

  const images = parsed.images as Record<string, unknown> | undefined;
  if (images) {
    if (typeof images.dir === 'string') cfg.images.dir = images.dir;
  }

  const agents = parsed.agents as Record<string, unknown> | undefined;
  if (agents) {
    if (typeof agents.dir === 'string') cfg.agents.dir = agents.dir;
  }

  const skills = parsed.skills as Record<string, unknown> | undefined;
  if (skills) {
    if (typeof skills.dir === 'string') cfg.skills.dir = skills.dir;
  }

  const library = parsed.library as Record<string, unknown> | undefined;
  if (library) {
    if (typeof library.backup_dir === 'string') cfg.library.backupDir = library.backup_dir;
    if (
      typeof library.backup_retention_count === 'number' &&
      Number.isSafeInteger(library.backup_retention_count) &&
      library.backup_retention_count > 0
    ) {
      cfg.library.backupRetentionCount = library.backup_retention_count;
    }
  }

  const checkpoints = parsed.checkpoints as Record<string, unknown> | undefined;
  if (checkpoints) {
    if (typeof checkpoints.dir === 'string') cfg.checkpoints.dir = checkpoints.dir;
  }

  const auth = parsed.auth as Record<string, unknown> | undefined;
  if (auth) {
    if (typeof auth.secret === 'string') cfg.auth.secret = auth.secret;
    if (typeof auth.url === 'string') cfg.auth.url = auth.url;
  }

  const security = parsed.security as Record<string, unknown> | undefined;
  if (security) {
    if (typeof security.trustProxy === 'boolean') cfg.security.trustProxy = security.trustProxy;
  }

  const environments = parsed.environments as Record<string, unknown> | undefined;
  if (environments) {
    if (typeof environments.lts_refresh === 'boolean') {
      cfg.environments.ltsRefresh = environments.lts_refresh;
    }
    if (typeof environments.installs_enabled === 'boolean') {
      cfg.environments.installsEnabled = environments.installs_enabled;
    }
  }

  const cursor = parsed.cursor as Record<string, unknown> | undefined;
  if (cursor) {
    if (typeof cursor.workspace_dir === 'string') cfg.cursor.workspaceDir = cursor.workspace_dir;
    if (typeof cursor.sidecar_script === 'string') {
      cfg.cursor.sidecarScriptPath = cursor.sidecar_script;
    }
    if (typeof cursor.node_path === 'string') {
      cfg.cursor.nodePath = cursor.node_path;
    }
  }

  const chatgpt = parsed.chatgpt as Record<string, unknown> | undefined;
  if (chatgpt) {
    if (typeof chatgpt.auth_base_url === 'string' && chatgpt.auth_base_url) {
      cfg.chatgpt.authBaseUrl = chatgpt.auth_base_url;
    }
    if (typeof chatgpt.api_base_url === 'string' && chatgpt.api_base_url) {
      cfg.chatgpt.apiBaseUrl = chatgpt.api_base_url;
    }
  }

  const secretStore = parsed.secret_store as Record<string, unknown> | undefined;
  if (secretStore) {
    if (
      typeof secretStore.unsafe_file_fallback_dir === 'string' &&
      secretStore.unsafe_file_fallback_dir
    ) {
      cfg.secretStore.unsafeFileFallbackDir = secretStore.unsafe_file_fallback_dir;
    }
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

  // auth.url defaults to the server address; the 0.0.0.0 wildcard is not a valid
  // browser baseURL, so fall back to localhost (matches the running-server log).
  if (!cfg.auth.url) {
    cfg.auth.url = `http://${displayHost(cfg.server.host)}:${cfg.server.port}`;
  }

  // database.path: auto-detect when empty, resolve relative paths against monorepo root
  if (!cfg.database.path) {
    cfg.database.path = join(getHomeMangoDir(), 'database.sqlite');
  } else if (cfg.database.path !== ':memory:') {
    cfg.database.path = resolveUserPath(cfg.database.path);
  }

  // uploads.dir: auto-detect when empty, resolve relative paths against monorepo root
  if (!cfg.uploads.dir) {
    cfg.uploads.dir = join(getHomeMangoDir(), 'uploads');
  } else {
    cfg.uploads.dir = resolveUserPath(cfg.uploads.dir);
  }

  if (!cfg.images.dir) {
    cfg.images.dir = join(getHomeMangoDir(), 'images');
  } else {
    cfg.images.dir = resolveUserPath(cfg.images.dir);
  }

  if (!cfg.agents.dir) {
    cfg.agents.dir = join(getHomeMangoDir(), 'agents');
  } else {
    cfg.agents.dir = resolveUserPath(cfg.agents.dir);
  }

  if (!cfg.skills.dir) {
    cfg.skills.dir = join(getHomeMangoDir(), 'skills');
  } else {
    cfg.skills.dir = resolveUserPath(cfg.skills.dir);
  }

  if (!cfg.library.backupDir) {
    cfg.library.backupDir = join(getHomeMangoDir(), 'library-backups');
  } else {
    cfg.library.backupDir = resolveUserPath(cfg.library.backupDir);
  }

  if (!cfg.checkpoints.dir) {
    cfg.checkpoints.dir = join(getHomeMangoDir(), 'checkpoints');
  } else {
    cfg.checkpoints.dir = resolveUserPath(cfg.checkpoints.dir);
  }

  if (cfg.cursor.workspaceDir) {
    cfg.cursor.workspaceDir = resolveUserPath(cfg.cursor.workspaceDir);
  }

  if (cfg.cursor.sidecarScriptPath) {
    cfg.cursor.sidecarScriptPath = resolveUserPath(cfg.cursor.sidecarScriptPath);
  }

  if (cfg.cursor.nodePath) {
    cfg.cursor.nodePath = resolveUserPath(cfg.cursor.nodePath);
  }

  if (cfg.secretStore.unsafeFileFallbackDir) {
    cfg.secretStore.unsafeFileFallbackDir = resolveUserPath(cfg.secretStore.unsafeFileFallbackDir);
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
 * True when running under the Bun test runner, which sets NODE_ENV=test.
 * // Usage: if (isTestRuntime()) { ... }
 */
function isTestRuntime(): boolean {
  return process.env.NODE_ENV === 'test';
}

/**
 * The single managed config location for the Bun test runner. Every test that
 * does not provide its own config file shares this path, and the test
 * environment deletes the file between tests — so config-file connector writes
 * from one test cannot leak into another test's reads. Scoped by pid (and Bun
 * worker id) to stay isolated across processes. Lives under the user's home
 * dir (not the OS temp dir) so CodeQL does not flag the read path as an
 * "insecure temporary file" — the test environment owns its lifecycle.
 * // Usage: loadConfigForTest({ configFilePath: TEST_MANAGED_CONFIG_PATH })
 */
export const TEST_MANAGED_CONFIG_DIR = join(
  homedir(),
  `.mangostudio-test-${process.pid}-${process.env.BUN_WORKER_ID ?? '0'}`
);
export const TEST_MANAGED_CONFIG_PATH = join(TEST_MANAGED_CONFIG_DIR, 'config.toml');

let warnedTestSandboxFallback = false;

/**
 * Builds an isolated, in-memory config for the Bun test runner. Used when a
 * caller reaches for configuration before the test environment installed it
 * (e.g. tests started from the repo root, where the workspace bunfig preload
 * never runs). This guarantees a test process can never read or write the
 * developer's real ~/.mango database, secrets, or uploads.
 */
function loadTestSandboxConfig(): MangoConfig {
  const cfg = cloneDefaults();
  cfg.database.path = ':memory:';
  cfg.auth.secret = 'test-sandbox-secret-at-least-32-characters';
  cfg.uploads.dir = join(TEST_MANAGED_CONFIG_DIR, 'uploads');
  cfg.images.dir = join(TEST_MANAGED_CONFIG_DIR, 'images');
  cfg.agents.dir = join(TEST_MANAGED_CONFIG_DIR, 'agents');
  cfg.skills.dir = join(TEST_MANAGED_CONFIG_DIR, 'skills');
  cfg.library.backupDir = join(TEST_MANAGED_CONFIG_DIR, 'library-backups');
  cfg.checkpoints.dir = join(TEST_MANAGED_CONFIG_DIR, 'checkpoints');
  computeDerived(cfg, TEST_MANAGED_CONFIG_PATH);

  if (!warnedTestSandboxFallback) {
    warnedTestSandboxFallback = true;
    console.warn(
      '[config] Configuration was requested before the test environment was ' +
        'initialized; falling back to an isolated in-memory sandbox so the real ' +
        '~/.mango is never touched. If a database-backed test then fails with a ' +
        'missing table, it was started without the preload — run API tests via ' +
        '`bun run --filter @mangostudio/api test:unit` (see docs/reference/testing.md).'
    );
  }
  return cfg;
}

/**
 * Loads configuration from config.toml with .env overrides.
 * @param overridePath - Force a specific config.toml path (for tests).
 */
export function loadConfig(overridePath?: string): MangoConfig {
  // Safety net: under the test runner an absent overridePath means something
  // reached for config before the test environment was set up. Never fall
  // through to the real ~/.mango here. Callers that pass an explicit
  // overridePath (the config-loader tests) keep the real resolution behavior.
  if (overridePath === undefined && isTestRuntime()) {
    return loadTestSandboxConfig();
  }

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

  // 2. Read .env next to config.toml (overrides config.toml)
  const envPath = getConfigEnvFilePath(tomlPath);
  const envOverrides = parseRuntimeEnvFile(envPath);
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
  if (partial.images) Object.assign(cfg.images, partial.images);
  if (partial.agents) Object.assign(cfg.agents, partial.agents);
  if (partial.skills) Object.assign(cfg.skills, partial.skills);
  if (partial.library) Object.assign(cfg.library, partial.library);
  if (partial.checkpoints) Object.assign(cfg.checkpoints, partial.checkpoints);
  if (partial.auth) Object.assign(cfg.auth, partial.auth);
  if (partial.security) Object.assign(cfg.security, partial.security);
  if (partial.environments) Object.assign(cfg.environments, partial.environments);
  if (partial.cursor) Object.assign(cfg.cursor, partial.cursor);
  if (partial.chatgpt) Object.assign(cfg.chatgpt, partial.chatgpt);
  if (partial.secretStore) Object.assign(cfg.secretStore, partial.secretStore);
  if (partial.corsOrigins) cfg.corsOrigins = partial.corsOrigins;

  // Default to the single managed test config path (not /dev/null, which
  // *exists* and makes config-file connector sync run against an empty file —
  // silently deleting just-created connectors). The test environment removes
  // this file between tests, so config-file writes never leak across tests.
  if (!cfg.database.path) cfg.database.path = ':memory:';
  if (!cfg.library.backupDir) {
    cfg.library.backupDir = join(TEST_MANAGED_CONFIG_DIR, 'library-backups');
  }
  const configFilePath = partial.configFilePath ?? TEST_MANAGED_CONFIG_PATH;

  computeDerived(cfg, configFilePath);

  configInstance = cfg;
  return cfg;
}
