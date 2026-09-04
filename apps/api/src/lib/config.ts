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
import { TERMINAL_SCROLLBACK_MAX_BYTES } from '@mangostudio/shared/terminal';
import type { UpdateChannel } from '@mangostudio/shared/updates';
import { parse as parseToml } from 'smol-toml';
import { CliError } from '../cli/errors';

/** `terminal.scrollback_kib` is threaded to the runtime as bytes; it cannot ask for more than the ring buffer holds. */
const TERMINAL_SCROLLBACK_KIB_MAX = TERMINAL_SCROLLBACK_MAX_BYTES / 1024;

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
    /**
     * How a peer outside this process reaches the hub, which is a different
     * question from how the hub binds: `host`/`port` can be `0.0.0.0:3001`
     * behind a proxy terminating TLS on a public name. Empty means unset —
     * nothing derives it from a request header, which the caller controls.
     */
    publicUrl: string;
    /**
     * Extra browser origins allowed to call this API, for the split deployment
     * the `MANGO_API_URL` build-time override exists for: the frontend bundle is
     * served from one origin and this API answers on another. Added to the
     * server's own origins rather than replacing them, so a same-origin install
     * keeps working. Empty means same-origin only.
     */
    allowedOrigins: string[];
  };
  /**
   * @deprecated The API serves the frontend itself, so there is no second
   * origin to allow. Still parsed so an existing config.toml keeps booting,
   * but nothing reads these values.
   */
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
  /** Avatar images the user uploaded or asked us to cache, one dir per user. */
  toolImages: {
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
    /**
     * Total byte budget for retained backup sets. Skill directories can be
     * large, so a count alone lets backups become a mystery disk consumer.
     */
    backupRetentionBytes: number;
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
    /**
     * Whether a request that reaches this hub on loopback still counts as local
     * when `trustProxy` is on and no `X-Forwarded-For` hop arrived.
     *
     * Only read behind a trusted proxy, and only when that proxy appended
     * nothing. Left on, the socket peer answers as it always has — which keeps
     * the machine page working for a browser that talks to the hub directly,
     * bypassing the proxy. Turn it off when the proxy in front of this hub does
     * not set `X-Forwarded-For`: there the loopback peer is the proxy itself,
     * and every remote browser would otherwise pass a check that is supposed to
     * mean "at this machine's keyboard".
     */
    allowDirectLoopback: boolean;
  };
  updates: {
    /** Whether the hub checks the release host for a newer build. */
    check: boolean;
    /**
     * Force a channel instead of the one this build came from. Null means
     * "this build's own channel" — resolved with `versionChannel(getVersion())`
     * at the point of use, never here.
     */
    channel: UpdateChannel | null;
  };
  environments: {
    /** Opt in to refreshing Node release metadata from nodejs.org. */
    ltsRefresh: boolean;
    /** Permit guarded local runtime and agent CLI installation. */
    installsEnabled: boolean;
    /**
     * True when the API runs inside a container. Derived from `/.dockerenv` and
     * forced on by `MANGO_CONTAINER`. Installs are refused here because they are
     * discarded on restart and mutate an image the user did not build.
     */
    container: boolean;
    /**
     * Overrides which `wsl.exe` the hub spawns (`MANGO_WSL_EXE`). Used verbatim,
     * with no existence check, so a bad value fails loudly on spawn rather than
     * silently falling back to auto-detection. Empty means auto-detect.
     */
    wslExecutable: string;
  };
  terminal: {
    /** Master switch for opening live terminal sessions on any environment. */
    enabled: boolean;
    /** A session with no attached viewer this long is closed by the idle reaper. */
    idleTimeoutMinutes: number;
    /** Running sessions one user may hold at once, across every environment. */
    maxSessionsPerUser: number;
    /** Bytes of output the runtime keeps per session for `terminal.attach` replay. */
    scrollbackKib: number;
  };
  /** The server's own origins plus every `server.allowedOrigins` entry. */
  corsOrigins: string[];
  /** Path to the config.toml that was loaded (for TOML-based services). */
  configFilePath: string;
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
  server: { host: '0.0.0.0', port: 3001, publicUrl: '', allowedOrigins: [] },
  frontend: { host: 'localhost', port: 5173 },
  database: { path: '' },
  uploads: { dir: '' },
  images: { dir: '' },
  toolImages: { dir: '' },
  agents: { dir: '' },
  skills: { dir: '' },
  library: { backupDir: '', backupRetentionCount: 10, backupRetentionBytes: 512 * 1024 * 1024 },
  checkpoints: { dir: '' },
  auth: { secret: '', url: '' },
  security: { trustProxy: false, allowDirectLoopback: true },
  updates: { check: true, channel: null },
  environments: { ltsRefresh: false, installsEnabled: false, container: false, wslExecutable: '' },
  terminal: { enabled: true, idleTimeoutMinutes: 30, maxSessionsPerUser: 8, scrollbackKib: 256 },
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

/**
 * A positive safe integer within an optional ceiling, or `undefined` for
 * anything else — so a caller can fall back to the default with `??` instead of
 * restating the guard.
 *
 * Deliberately number-only: TOML has real types, so a quoted `"30"` there is a
 * config error rather than a value to coerce. Env callers pass `Number(v)`
 * themselves, which is the one place a string is expected. Sharing the guard is
 * what keeps an env var and its TOML twin from validating differently.
 *
 * // Usage: readPositiveInteger(64, 1024) // → 64
 */
export function readPositiveInteger(value: unknown, max?: number): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return undefined;
  if (max !== undefined && value > max) return undefined;
  return value;
}

/**
 * Trims an origin list and drops the empty entries a trailing comma or a blank
 * TOML string leaves behind. Nothing else is filtered: a malformed entry is
 * kept so `computeDerived` can reject it out loud, rather than the value
 * disappearing somewhere between the config file and the CORS gate.
 */
function normalizeOriginList(entries: string[]): string[] {
  return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/**
 * Splits the comma-separated `ALLOWED_ORIGINS` list.
 * // Usage: parseOriginList('https://a.example, https://b.example:8443')
 */
function parseOriginList(value: string): string[] {
  return normalizeOriginList(value.split(','));
}

/** Maps .env keys to config paths for override resolution. */
const ENV_KEY_MAP: Record<string, (cfg: MangoConfig, value: string) => void> = {
  API_PORT: (cfg, v) => {
    cfg.server.port = Number(v) || cfg.server.port;
  },
  API_HOST: (cfg, v) => {
    cfg.server.host = v;
  },
  PUBLIC_URL: (cfg, v) => {
    cfg.server.publicUrl = v;
  },
  ALLOWED_ORIGINS: (cfg, v) => {
    cfg.server.allowedOrigins = parseOriginList(v);
  },
  // Deprecated and ignored; still parsed so an existing .env keeps booting.
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
  TOOL_IMAGES_DIR: (cfg, v) => {
    cfg.toolImages.dir = v;
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
  ALLOW_DIRECT_LOOPBACK: (cfg, v) => {
    cfg.security.allowDirectLoopback = parseBooleanFlag(v);
  },
  MANGO_UPDATES_CHECK: (cfg, v) => {
    cfg.updates.check = parseBooleanFlag(v);
  },
  MANGO_UPDATES_CHANNEL: (cfg, v) => {
    if (v === 'stable' || v === 'canary') cfg.updates.channel = v;
  },
  MANGO_ENV_LTS_REFRESH: (cfg, v) => {
    cfg.environments.ltsRefresh = parseBooleanFlag(v);
  },
  MANGO_ENV_INSTALLS_ENABLED: (cfg, v) => {
    cfg.environments.installsEnabled = parseBooleanFlag(v);
  },
  // Only ever forces container mode on. A container the runtime detects must
  // not become invisible because an env file says otherwise.
  MANGO_CONTAINER: (cfg, v) => {
    cfg.environments.container = cfg.environments.container || parseBooleanFlag(v);
  },
  MANGO_WSL_EXE: (cfg, v) => {
    cfg.environments.wslExecutable = v;
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
  MANGO_LIBRARY_BACKUP_RETENTION_BYTES: (cfg, v) => {
    const bytes = Number(v);
    if (Number.isSafeInteger(bytes) && bytes > 0) {
      cfg.library.backupRetentionBytes = bytes;
    }
  },
  MANGO_TERMINAL_ENABLED: (cfg, v) => {
    cfg.terminal.enabled = parseBooleanFlag(v);
  },
  MANGO_TERMINAL_IDLE_TIMEOUT_MINUTES: (cfg, v) => {
    cfg.terminal.idleTimeoutMinutes =
      readPositiveInteger(Number(v)) ?? cfg.terminal.idleTimeoutMinutes;
  },
  MANGO_TERMINAL_MAX_SESSIONS_PER_USER: (cfg, v) => {
    cfg.terminal.maxSessionsPerUser =
      readPositiveInteger(Number(v)) ?? cfg.terminal.maxSessionsPerUser;
  },
  MANGO_TERMINAL_SCROLLBACK_KIB: (cfg, v) => {
    cfg.terminal.scrollbackKib =
      readPositiveInteger(Number(v), TERMINAL_SCROLLBACK_KIB_MAX) ?? cfg.terminal.scrollbackKib;
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
 * The `~/.mango` a runtime this hub spawns will use.
 *
 * Runtime children inherit this process's environment and read `MANGO_HOME` as
 * their own home, so a hub that ignored it would report on a directory nothing
 * writes to — `mango doctor` would describe slots while the runtime beside it
 * used others. Only the runtime home follows the variable; the database, logs,
 * and config.toml stay at {@link getHomeMangoDir}, because moving those is a
 * different decision and nobody has asked for it.
 */
// Usage: getRuntimeHomeMangoDir() // → "/home/user/.mango"
export function getRuntimeHomeMangoDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MANGO_HOME?.trim();
  return override && override.length > 0 ? override : getHomeMangoDir();
}

/** What a build reports when no release stamped a version into it. */
const DEVELOPMENT_VERSION = 'dev';

/**
 * Build version embedded at compile time via process.env.VERSION, or "dev" when
 * running from source. Centralized here so the server state file and `doctor`
 * report the same value. // Usage: getVersion() // → "1.2.3"
 */
export function getVersion(): string {
  return process.env.VERSION || DEVELOPMENT_VERSION;
}

/**
 * True for a build that no release produced. Anything that would go looking for
 * this version's release assets has to ask first: there is no `vdev` tag and
 * there never will be. // Usage: isDevelopmentVersion(getVersion())
 */
export function isDevelopmentVersion(version: string): boolean {
  return version === DEVELOPMENT_VERSION;
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

/**
 * Returns why an allowed-origin entry is unusable, or null when it is safe.
 *
 * Every gate that reads `corsOrigins` compares the browser's `Origin` header by
 * exact string, so a near-miss — a trailing slash, a path, an explicit default
 * port, an uppercase host — parses cleanly and then matches nothing. The entry
 * has to be a canonical origin or be rejected out loud.
 * // Usage: getAllowedOriginValidationMessage('https://studio.example.com')
 */
function getAllowedOriginValidationMessage(origin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return `"${origin}" is not a URL`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `"${origin}" must use http:// or https://`;
  }
  if (parsed.origin !== origin) {
    return `"${origin}" must be a bare scheme://host[:port] origin (did you mean "${parsed.origin}"?)`;
  }
  return null;
}

/** Fails before the server binds with an origin no browser request can match. */
function assertValidAllowedOrigins(origins: string[]): void {
  const messages = origins
    .map((origin) => getAllowedOriginValidationMessage(origin))
    .filter((message): message is string => message !== null);
  if (messages.length === 0) return;

  throw new CliError(
    `Invalid server.allowedOrigins (ALLOWED_ORIGINS): ${messages.join('; ')}. ` +
      'Each entry must be a bare origin such as https://studio.example.com.'
  );
}

/**
 * Fails before the server binds with a `baseURL` Better Auth cannot reason about.
 *
 * Better Auth derives more than a link target from this value: the `__Secure-`
 * cookie prefix comes from whether it starts with `https://`, and it seeds the
 * origins a request is checked against. A value that is not an absolute URL
 * mis-derives both without ever throwing — `localhost:3001` parses, with
 * `localhost:` as its protocol and an empty hostname — so a login that silently
 * never establishes a session is the first symptom the operator sees.
 *
 * Only the parts Better Auth reads are checked. A path is explicitly allowed:
 * `basePath` is appended to this value, so a subpath deployment
 * (`https://example.com/mango`) is a legitimate configuration.
 */
function assertValidAuthUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(
      `Invalid auth.url (BETTER_AUTH_URL): "${url}" is not a URL. ` +
        'It must be an absolute URL such as https://studio.example.com.'
    );
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname === '') {
    throw new CliError(
      `Invalid auth.url (BETTER_AUTH_URL): "${url}" must use http:// or https:// and name a host. ` +
        'It must be an absolute URL such as https://studio.example.com.'
    );
  }
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

/** Whether this process already reported the frontend.port deprecation. */
let warnedFrontendPortDeprecated = false;

/**
 * Reports `frontend.host` / `frontend.port` / `FRONTEND_PORT` once per
 * process, and only when the user actually set one of them — the resolved
 * config cannot answer "was it set?", because the fields still carry their
 * Vite-era defaults.
 */
function warnFrontendPortDeprecated(serverPort: number): void {
  if (warnedFrontendPortDeprecated) return;
  warnedFrontendPortDeprecated = true;
  console.warn(
    `[config] The [frontend] settings are deprecated and ignored; the frontend is served by the API on ${serverPort}. ` +
      'To allow a frontend served from another origin, set server.allowedOrigins (or ALLOWED_ORIGINS).'
  );
}

/** Clears the once-per-process deprecation latch (for tests). */
export function resetFrontendPortDeprecationWarning(): void {
  warnedFrontendPortDeprecated = false;
}

/** Deep-clones the default config. */
function cloneDefaults(): MangoConfig {
  return {
    // allowedOrigins is copied, not shared: a spread would alias the default
    // array into every clone, so one loaded config could mutate the next.
    server: { ...DEFAULT_CONFIG.server, allowedOrigins: [...DEFAULT_CONFIG.server.allowedOrigins] },
    frontend: { ...DEFAULT_CONFIG.frontend },
    database: { ...DEFAULT_CONFIG.database },
    uploads: { ...DEFAULT_CONFIG.uploads },
    images: { ...DEFAULT_CONFIG.images },
    toolImages: { ...DEFAULT_CONFIG.toolImages },
    agents: { ...DEFAULT_CONFIG.agents },
    skills: { ...DEFAULT_CONFIG.skills },
    library: { ...DEFAULT_CONFIG.library },
    checkpoints: { ...DEFAULT_CONFIG.checkpoints },
    auth: { ...DEFAULT_CONFIG.auth },
    security: { ...DEFAULT_CONFIG.security },
    updates: { ...DEFAULT_CONFIG.updates },
    environments: { ...DEFAULT_CONFIG.environments },
    terminal: { ...DEFAULT_CONFIG.terminal },
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
    if (typeof server.publicUrl === 'string') cfg.server.publicUrl = server.publicUrl;
    if (
      Array.isArray(server.allowedOrigins) &&
      server.allowedOrigins.every((entry) => typeof entry === 'string')
    ) {
      cfg.server.allowedOrigins = normalizeOriginList(server.allowedOrigins);
    }
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

  const toolImages = parsed.tool_images as Record<string, unknown> | undefined;
  if (toolImages) {
    if (typeof toolImages.dir === 'string') cfg.toolImages.dir = toolImages.dir;
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
    if (
      typeof library.backup_retention_bytes === 'number' &&
      Number.isSafeInteger(library.backup_retention_bytes) &&
      library.backup_retention_bytes > 0
    ) {
      cfg.library.backupRetentionBytes = library.backup_retention_bytes;
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
    if (typeof security.allowDirectLoopback === 'boolean') {
      cfg.security.allowDirectLoopback = security.allowDirectLoopback;
    }
  }

  const updates = parsed.updates as Record<string, unknown> | undefined;
  if (updates) {
    if (typeof updates.check === 'boolean') cfg.updates.check = updates.check;
    if (updates.channel === 'stable' || updates.channel === 'canary') {
      cfg.updates.channel = updates.channel;
    }
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

  const terminal = parsed.terminal as Record<string, unknown> | undefined;
  if (terminal) {
    if (typeof terminal.enabled === 'boolean') cfg.terminal.enabled = terminal.enabled;
    cfg.terminal.idleTimeoutMinutes =
      readPositiveInteger(terminal.idle_timeout_minutes) ?? cfg.terminal.idleTimeoutMinutes;
    cfg.terminal.maxSessionsPerUser =
      readPositiveInteger(terminal.max_sessions_per_user) ?? cfg.terminal.maxSessionsPerUser;
    cfg.terminal.scrollbackKib =
      readPositiveInteger(terminal.scrollback_kib, TERMINAL_SCROLLBACK_KIB_MAX) ??
      cfg.terminal.scrollbackKib;
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

  // The container marker is a fact about the runtime, not a preference, so it
  // is OR-ed over whatever MANGO_CONTAINER asked for.
  cfg.environments.container = cfg.environments.container || existsSync('/.dockerenv');

  // auth.url defaults to the server address; the 0.0.0.0 wildcard is not a valid
  // browser baseURL, so fall back to localhost (matches the running-server log).
  if (!cfg.auth.url) {
    cfg.auth.url = `http://${displayHost(cfg.server.host)}:${cfg.server.port}`;
  }
  assertValidAuthUrl(cfg.auth.url);

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

  if (!cfg.toolImages.dir) {
    cfg.toolImages.dir = join(getHomeMangoDir(), 'tool-images');
  } else {
    cfg.toolImages.dir = resolveUserPath(cfg.toolImages.dir);
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

  if (cfg.secretStore.unsafeFileFallbackDir) {
    cfg.secretStore.unsafeFileFallbackDir = resolveUserPath(cfg.secretStore.unsafeFileFallbackDir);
  }

  // The API process serves the frontend, so its own origin is the one every
  // default install needs.
  //
  // In standalone mode the runner scripts (run.sh / run.bat) launch the binary with
  // API_PORT set to whatever port the user chose. The binary reads that value via
  // process.env, applies it as cfg.server.port (step 3 of loadConfig), and then
  // computeDerived() runs — so sPort below is already the final resolved port,
  // regardless of whether it came from config.toml, .env, or API_PORT.
  //
  // The browser sends Origin: http://<host>:<sPort> on CORS preflight requests
  // (e.g. POST with JSON body). The Elysia CORS middleware, Better Auth
  // trustedOrigins, and the realtime handshake all validate against corsOrigins,
  // so this origin must be present or same-origin requests from the served
  // frontend are rejected.
  //
  // A split deployment — the bundle built with MANGO_API_URL and served from
  // somewhere else — has no origin here to derive, so the user names it:
  // `server.allowedOrigins` in config.toml, or ALLOWED_ORIGINS in the
  // environment. Those are unioned in rather than replacing the defaults, so
  // configuring one never breaks a local browser session.
  assertValidAllowedOrigins(cfg.server.allowedOrigins);
  const sHost = cfg.server.host;
  const sPort = cfg.server.port;
  const origins = new Set([`http://localhost:${sPort}`, `http://127.0.0.1:${sPort}`]);
  if (sHost !== 'localhost' && sHost !== '127.0.0.1') {
    origins.add(`http://${sHost}:${sPort}`);
  }
  for (const origin of cfg.server.allowedOrigins) origins.add(origin);
  cfg.corsOrigins = [...origins];
}

/**
 * True when running under the Bun test runner, which sets NODE_ENV=test.
 * The one seam production code may branch on: background work that must
 * never run against a real network or filesystem during `bun test` checks
 * this instead of reading `NODE_ENV` itself.
 * // Usage: if (isTestRuntime()) { ... }
 */
export function isTestRuntime(): boolean {
  // allow-node-env: selects the isolated test config path; moving this seam
  // risks clobbering a real user file.
  return process.env.NODE_ENV === 'test';
}

/**
 * The single managed config location for the Bun test runner. Every test that
 * does not provide its own config file shares this path, and the test
 * environment deletes the file between tests — so config-file connector writes
 * from one test cannot leak into another test's reads. Scoped by pid and Bun
 * worker id to stay isolated across worker processes. Lives under the user's
 * home dir (not the OS temp dir) so CodeQL does not flag the read path as an
 * "insecure temporary file" — the test environment owns its lifecycle and
 * removes the directory in `afterAll`.
 * // Usage: loadConfigForTest({ configFilePath: TEST_MANAGED_CONFIG_PATH })
 */
export const TEST_MANAGED_CONFIG_DIR = join(
  homedir(),
  `.mangostudio-test-${process.pid}-${process.env.BUN_TEST_WORKER_ID ?? '0'}`
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
  cfg.toolImages.dir = join(TEST_MANAGED_CONFIG_DIR, 'tool-images');
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
  let frontendPortInToml = false;

  // 1. Determine and read config.toml
  const tomlPath = overridePath ?? resolveConfigTomlPath();
  if (existsSync(tomlPath)) {
    try {
      const content = readFileSync(tomlPath, 'utf8');
      const parsed = parseToml(content) as Record<string, unknown>;
      // Either key: host is as deprecated (and as ignored) as port.
      const frontendTable = parsed.frontend as Record<string, unknown> | undefined;
      frontendPortInToml = frontendTable?.port !== undefined || frontendTable?.host !== undefined;
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

  // 5. Report a setting that still parses but no longer does anything. Asked
  // of the sources rather than of cfg, which cannot distinguish an explicit
  // 5173 from the default one.
  if (frontendPortInToml || envOverrides.FRONTEND_PORT || process.env.FRONTEND_PORT) {
    warnFrontendPortDeprecated(cfg.server.port);
  }

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
  if (partial.toolImages) Object.assign(cfg.toolImages, partial.toolImages);
  if (partial.agents) Object.assign(cfg.agents, partial.agents);
  if (partial.skills) Object.assign(cfg.skills, partial.skills);
  if (partial.library) Object.assign(cfg.library, partial.library);
  if (partial.checkpoints) Object.assign(cfg.checkpoints, partial.checkpoints);
  if (partial.auth) Object.assign(cfg.auth, partial.auth);
  if (partial.security) Object.assign(cfg.security, partial.security);
  if (partial.updates) Object.assign(cfg.updates, partial.updates);
  if (partial.environments) Object.assign(cfg.environments, partial.environments);
  if (partial.terminal) Object.assign(cfg.terminal, partial.terminal);
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
  // Kept out of the developer's real ~/.mango for the same reason: a test that
  // stores a tool image must not write into the machine it runs on. Uploads and
  // generated images need the same treatment — `computeDerived` resolves an
  // empty dir to ~/.mango, so leaving them unset pointed the upload suites at
  // the developer's own uploads directory and left real files behind there.
  if (!cfg.toolImages.dir) {
    cfg.toolImages.dir = join(TEST_MANAGED_CONFIG_DIR, 'tool-images');
  }
  if (!cfg.uploads.dir) {
    cfg.uploads.dir = join(TEST_MANAGED_CONFIG_DIR, 'uploads');
  }
  if (!cfg.images.dir) {
    cfg.images.dir = join(TEST_MANAGED_CONFIG_DIR, 'images');
  }
  const configFilePath = partial.configFilePath ?? TEST_MANAGED_CONFIG_PATH;

  computeDerived(cfg, configFilePath);

  configInstance = cfg;
  return cfg;
}
