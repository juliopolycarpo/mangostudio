/** Injectable platform inputs for resolving user-owned runtime and library paths. */
export interface PathEnv {
  readonly platform: string;
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Root a `workspace`-scoped library location resolves under. Reserved: absent
   * until workspace locations exist, and a resolver that needs it must return
   * null when it is missing rather than falling back to `homeDir`.
   */
  readonly workspaceRoot?: string;
}

const libraryPathEnvBrand: unique symbol = Symbol('LibraryPathEnv');

/**
 * A `PathEnv` built by a factory (`createPathEnv`, `createLibraryPathEnv`, or
 * `createRuntimePathEnv`). Library writers take this so a raw `process.env`
 * snapshot cannot be passed by accident and resolve `mango-*` to a different
 * directory than the one `describeLocation` reported.
 */
export type LibraryPathEnv = PathEnv & {
  readonly [libraryPathEnvBrand]: true;
};

/** Hub-pinned variables that relocate MangoStudio's own library directories. */
export const SKILLS_DIR_ENV = 'SKILLS_DIR';
export const AGENTS_DIR_ENV = 'AGENTS_DIR';
export const MANGO_CONFIG_HOME_ENV = 'MANGO_CONFIG_HOME';

export const LIBRARY_PATH_ENV_KEYS = [
  SKILLS_DIR_ENV,
  AGENTS_DIR_ENV,
  MANGO_CONFIG_HOME_ENV,
] as const;

export type LibraryPathEnvKey = (typeof LIBRARY_PATH_ENV_KEYS)[number];

/**
 * The only way to construct a `LibraryPathEnv`. Hub and runtime factories call
 * this after they decide which variables to pin; tests that need a host layout
 * without hub config call it directly.
 */
export function createPathEnv(input: {
  readonly platform: string;
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly workspaceRoot?: string;
}): LibraryPathEnv {
  return {
    platform: input.platform,
    homeDir: input.homeDir,
    env: input.env,
    ...(input.workspaceRoot !== undefined && { workspaceRoot: input.workspaceRoot }),
    [libraryPathEnvBrand]: true,
  };
}

/** Copies the MangoStudio directory pins out of a `PathEnv` for the wire. */
export function libraryPathEnvOverrides(
  env: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const key of LIBRARY_PATH_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) overrides[key] = value;
  }
  return overrides;
}
