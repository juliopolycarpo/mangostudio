import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Configuration text I/O; implementations retain filesystem errno codes for absent/read-failure handling. */
export interface RustCostConfigFiles {
  read(path: string): Promise<string>;
}

const CARGO_CONFIG_FILES: RustCostConfigFiles = {
  read: (path) => readFile(path, 'utf8'),
};

const PRESENCE_SELECTORS = new Set(['RUSTC_BOOTSTRAP', 'RUSTC_STAGE']);

const EXTERNAL_TABLES = new Set(['net', 'http', 'registry', 'registries', 'credential-alias']);
const COMPILER_KEYS = new Set([
  'rustc',
  'rustc-wrapper',
  'rustc-workspace-wrapper',
  'build-dir',
  'target-dir',
  'incremental',
  'target',
]);

/** Reject inherited selectors that can replace the declared compiler, profile, cache or private output.
 * @example assertRustCostEnvironment(process.env);
 */
export function assertRustCostEnvironment(env: NodeJS.ProcessEnv): void {
  const names = Object.keys(env).filter((name) => {
    if (PRESENCE_SELECTORS.has(name)) return env[name] !== undefined;
    return (
      env[name] &&
      (name.startsWith('CARGO_PROFILE_') ||
        name.startsWith('CARGO_BUILD_') ||
        name.startsWith('CARGO_CACHE_') ||
        (name.startsWith('CARGO_TARGET_') && name.endsWith('_LINKER')) ||
        name.endsWith('_RUSTFLAGS') ||
        [
          'RUSTFLAGS',
          'CARGO_ENCODED_RUSTFLAGS',
          'RUSTC_WRAPPER',
          'RUSTC_WORKSPACE_WRAPPER',
          'CARGO_TARGET_DIR',
          'CARGO_INCREMENTAL',
          'RUSTC',
        ].includes(name))
    );
  });
  if (names.length)
    throw new Error(
      `Rust baseline environment: expected repository profile and compiler | received override names: ${names.join(', ')}`
    );
}

/** Seal Cargo's ancestor/home configuration slots and refuse unsupported configuration inputs.
 * Extensionless config wins when both names exist; absent and shadowed slots remain in the seal.
 * External files may configure registry/network credentials only; includes are unsupported.
 * @example const configs = await inspectRustCostCargoConfigs(root, process.env, ['.cargo/config.toml']);
 */
export async function inspectRustCostCargoConfigs(
  root: string,
  env: NodeJS.ProcessEnv,
  tracked: readonly string[],
  files: RustCostConfigFiles = CARGO_CONFIG_FILES
): Promise<Record<string, string | null>> {
  const roots = new Set<string>();
  let ancestor = resolve(root);
  while (true) {
    roots.add(join(ancestor, '.cargo'));
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  roots.add(resolve(root, env.CARGO_HOME || join(homedir(), '.cargo')));
  const trusted = new Set(tracked.map((path) => resolve(root, path)));
  const hashes: Record<string, string | null> = {};
  for (const directory of roots) {
    const candidates = await Promise.all(
      ['config', 'config.toml'].map(async (name) => {
        const path = join(directory, name);
        const content = await optionalConfig(path, files);
        hashes[path] =
          content === null ? null : new Bun.CryptoHasher('sha256').update(content).digest('hex');
        return { path, content };
      })
    );
    const active = candidates.find(({ content }) => content !== null);
    if (active && active.content !== null)
      validateConfig(active.path, active.content, trusted.has(active.path));
  }
  return Object.fromEntries(
    Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right))
  );
}

async function optionalConfig(path: string, files: RustCostConfigFiles): Promise<string | null> {
  try {
    return await files.read(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `Rust baseline Cargo config ${path}: expected readable file or absent slot | received: ${(error as NodeJS.ErrnoException).code ?? 'read failure'}`
    );
  }
}

function validateConfig(path: string, text: string, trusted: boolean): void {
  let config: Record<string, unknown>;
  try {
    config = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Rust baseline Cargo config ${path}: expected valid TOML | received: invalid configuration`
    );
  }
  const unsupported = Object.keys(config).filter(
    (key) => key === 'include' || (!trusted && !EXTERNAL_TABLES.has(key))
  );
  const build = config.build;
  if (build && typeof build === 'object') {
    unsupported.push(
      ...Object.keys(build)
        .filter((key) => COMPILER_KEYS.has(key))
        .map((key) => `build.${key}`)
    );
  }
  if (trusted)
    unsupported.push(
      ...['env', 'profile', 'paths', 'source', 'unstable'].filter((key) => key in config)
    );
  if (unsupported.length)
    throw new Error(
      `Rust baseline Cargo config ${path}: expected sealed registry/network settings or tracked repository flags without includes/compiler/profile/output overrides | received: ${unsupported.join(', ')}`
    );
}
