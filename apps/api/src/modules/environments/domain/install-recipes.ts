import type {
  InstallAction,
  InstallPlatform,
  InstallRecipeId,
  RecipeInput,
  RuntimeId,
  VersionManagerId,
} from '@mangostudio/shared/environments';
import { renderShellCommand, shellQuote } from '@mangostudio/shared/environments';
import type { LibraryTargetId } from '@mangostudio/shared/library';
import { assertRecipeInput, toNvmDefaultArgument, toNvmVersionArgument } from './recipe-input';

const INSTALLER_MIN_BYTES = 256;
const INSTALLER_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

interface DownloadedInstaller {
  readonly url: string;
  readonly interpreter: 'bash' | 'sh';
  readonly minBytes: number;
  readonly maxBytes: number;
}

interface InstallRecipeBuildContext {
  readonly installerPath?: string;
  readonly nvmDir?: string;
}

/**
 * One status surface a finished recipe invalidates.
 *
 * A union rather than a single id because the three detection services do not
 * share an id type: `getVersionManagerStatus` takes a `VersionManagerId`,
 * `getAgentCliStatus` takes a `LibraryTargetId`, and neither is a `RuntimeId`.
 * Carrying the id beside its kind is what lets the post-install probe dispatch
 * without a cast.
 */
export type InstallRecipeProbe =
  | { readonly kind: 'runtime'; readonly runtimeId: RuntimeId }
  | { readonly kind: 'version-manager'; readonly versionManagerId: VersionManagerId }
  | { readonly kind: 'agent'; readonly targetId: LibraryTargetId };

export interface InstallRecipe {
  readonly id: InstallRecipeId;
  readonly runtimeId: RuntimeId;
  readonly action: InstallAction;
  readonly inputKind: RecipeInput['kind'];
  readonly platforms: readonly InstallPlatform[];
  readonly requires: readonly RuntimeId[];
  readonly writes: readonly string[];
  readonly networkAccess: boolean;
  readonly timeoutMs: number;
  /**
   * Which status surfaces this recipe's completion makes stale, so the
   * post-install probe is a fact the recipe declares rather than a branch in
   * the application layer that a ninth recipe would silently miss. Required and
   * non-empty: a recipe whose effect nothing re-probes is invisible until the
   * next lazy read.
   */
  readonly probe: readonly [InstallRecipeProbe, ...InstallRecipeProbe[]];
  readonly download?: DownloadedInstaller;
  readonly env?: Readonly<Record<string, string>>;
  readonly profileLines?: readonly string[];
  readonly argv: (input: RecipeInput, context: InstallRecipeBuildContext) => readonly string[];
  readonly copyCommand: (input: RecipeInput) => string;
}

function noInputArgv(argv: readonly string[]) {
  return (input: RecipeInput): readonly string[] => {
    assertRecipeInput(input, 'none');
    return argv;
  };
}

function downloadedScriptArgv(interpreter: 'bash' | 'sh') {
  return (input: RecipeInput, context: InstallRecipeBuildContext): readonly string[] => {
    assertRecipeInput(input, 'none');
    if (!context.installerPath) {
      throw new Error('Downloaded installer path is required.');
    }
    return [interpreter, context.installerPath];
  };
}

function nvmNodeArgv(
  operation: 'install' | 'set-default',
  input: RecipeInput,
  context: InstallRecipeBuildContext
): readonly string[] {
  const validated = assertRecipeInput(input, 'node-version');
  if (validated.kind !== 'node-version') {
    throw new Error('Node version input is required.');
  }
  if (!context.nvmDir) {
    throw new Error('NVM directory is required.');
  }

  const argument =
    operation === 'install'
      ? toNvmVersionArgument(validated.version)
      : toNvmDefaultArgument(validated.version);
  const command =
    operation === 'install'
      ? '. "$NVM_DIR/nvm.sh" && nvm install "$1"'
      : '. "$NVM_DIR/nvm.sh" && nvm alias default "$1"';
  return ['bash', '-c', command, 'mangostudio-install', argument];
}

function downloadedCopyCommand(url: string, interpreter: 'bash' | 'sh'): string {
  return `curl -fsSL ${shellQuote(url)} | ${interpreter}`;
}

const POSIX_PLATFORMS = ['darwin', 'linux'] as const;

export const INSTALL_RECIPES: readonly InstallRecipe[] = [
  {
    id: 'bun.install.official',
    runtimeId: 'bun',
    action: 'install',
    inputKind: 'none',
    platforms: POSIX_PLATFORMS,
    requires: [],
    writes: ['$HOME/.bun', '$HOME/.bashrc or $HOME/.zshrc'],
    networkAccess: true,
    timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    probe: [{ kind: 'runtime', runtimeId: 'bun' }],
    download: {
      url: 'https://bun.com/install',
      interpreter: 'bash',
      minBytes: INSTALLER_MIN_BYTES,
      maxBytes: INSTALLER_MAX_BYTES,
    },
    profileLines: ['export BUN_INSTALL="$HOME/.bun"', 'export PATH="$BUN_INSTALL/bin:$PATH"'],
    argv: downloadedScriptArgv('bash'),
    copyCommand: (input) => {
      assertRecipeInput(input, 'none');
      return downloadedCopyCommand('https://bun.com/install', 'bash');
    },
  },
  {
    id: 'bun.update',
    runtimeId: 'bun',
    action: 'update',
    inputKind: 'none',
    platforms: POSIX_PLATFORMS,
    requires: ['bun'],
    writes: ['$BUN_INSTALL/bin/bun'],
    networkAccess: true,
    timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    probe: [{ kind: 'runtime', runtimeId: 'bun' }],
    argv: noInputArgv(['bun', 'upgrade']),
    copyCommand: (input) => renderShellCommand(noInputArgv(['bun', 'upgrade'])(input)),
  },
  {
    id: 'nvm.install',
    runtimeId: 'nvm',
    action: 'install',
    inputKind: 'none',
    platforms: POSIX_PLATFORMS,
    requires: [],
    writes: ['$NVM_DIR'],
    networkAccess: true,
    timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    probe: [{ kind: 'version-manager', versionManagerId: 'nvm' }],
    download: {
      url: 'https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh',
      interpreter: 'bash',
      minBytes: INSTALLER_MIN_BYTES,
      maxBytes: INSTALLER_MAX_BYTES,
    },
    env: { PROFILE: '/dev/null' },
    profileLines: [
      'export NVM_DIR="$HOME/.nvm"',
      '[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh" # This loads nvm',
      '[ -s "$NVM_DIR/bash_completion" ] && \\. "$NVM_DIR/bash_completion" # This loads nvm bash_completion',
    ],
    argv: downloadedScriptArgv('bash'),
    copyCommand: (input) => {
      assertRecipeInput(input, 'none');
      return 'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | PROFILE=/dev/null bash';
    },
  },
  {
    id: 'nvm.node.install',
    runtimeId: 'node',
    action: 'use-version',
    inputKind: 'node-version',
    platforms: POSIX_PLATFORMS,
    requires: ['nvm'],
    writes: ['$NVM_DIR/versions/node'],
    networkAccess: true,
    timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    // Both surfaces move: a new managed version is a node the machine can
    // now run and a version nvm now lists.
    probe: [
      { kind: 'runtime', runtimeId: 'node' },
      { kind: 'version-manager', versionManagerId: 'nvm' },
    ],
    argv: (input, context) => nvmNodeArgv('install', input, context),
    copyCommand: (input) => {
      const validated = assertRecipeInput(input, 'node-version');
      if (validated.kind !== 'node-version') throw new Error('Node version input is required.');
      return `nvm install ${shellQuote(toNvmVersionArgument(validated.version))}`;
    },
  },
  {
    id: 'nvm.node.set-default',
    runtimeId: 'node',
    action: 'set-default',
    inputKind: 'node-version',
    platforms: POSIX_PLATFORMS,
    requires: ['nvm'],
    writes: ['$NVM_DIR/alias/default'],
    networkAccess: false,
    timeoutMs: 30_000,
    probe: [
      { kind: 'runtime', runtimeId: 'node' },
      { kind: 'version-manager', versionManagerId: 'nvm' },
    ],
    argv: (input, context) => nvmNodeArgv('set-default', input, context),
    copyCommand: (input) => {
      const validated = assertRecipeInput(input, 'node-version');
      if (validated.kind !== 'node-version') throw new Error('Node version input is required.');
      return `nvm alias default ${shellQuote(toNvmDefaultArgument(validated.version))}`;
    },
  },
  {
    id: 'claude.install',
    runtimeId: 'claude',
    action: 'install',
    inputKind: 'none',
    platforms: POSIX_PLATFORMS,
    requires: [],
    writes: ['$HOME/.local/bin/claude', '$HOME/.claude'],
    networkAccess: true,
    timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    probe: [{ kind: 'agent', targetId: 'claude' }],
    download: {
      url: 'https://claude.ai/install.sh',
      interpreter: 'bash',
      minBytes: INSTALLER_MIN_BYTES,
      maxBytes: INSTALLER_MAX_BYTES,
    },
    argv: downloadedScriptArgv('bash'),
    copyCommand: (input) => {
      assertRecipeInput(input, 'none');
      return downloadedCopyCommand('https://claude.ai/install.sh', 'bash');
    },
  },
  {
    id: 'codex.install',
    runtimeId: 'codex',
    action: 'install',
    inputKind: 'none',
    platforms: POSIX_PLATFORMS,
    requires: [],
    writes: ['$HOME/.local/bin/codex', '$HOME/.codex'],
    networkAccess: true,
    timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    probe: [{ kind: 'agent', targetId: 'codex' }],
    download: {
      url: 'https://chatgpt.com/codex/install.sh',
      interpreter: 'sh',
      minBytes: INSTALLER_MIN_BYTES,
      maxBytes: INSTALLER_MAX_BYTES,
    },
    argv: downloadedScriptArgv('sh'),
    copyCommand: (input) => {
      assertRecipeInput(input, 'none');
      return downloadedCopyCommand('https://chatgpt.com/codex/install.sh', 'sh');
    },
  },
  {
    id: 'cursor.install',
    runtimeId: 'cursor',
    action: 'install',
    inputKind: 'none',
    platforms: POSIX_PLATFORMS,
    requires: [],
    writes: ['$HOME/.local/bin', '$HOME/.cursor'],
    networkAccess: true,
    timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    probe: [{ kind: 'agent', targetId: 'cursor' }],
    download: {
      url: 'https://cursor.com/install',
      interpreter: 'bash',
      minBytes: INSTALLER_MIN_BYTES,
      maxBytes: INSTALLER_MAX_BYTES,
    },
    argv: downloadedScriptArgv('bash'),
    copyCommand: (input) => {
      assertRecipeInput(input, 'none');
      return downloadedCopyCommand('https://cursor.com/install', 'bash');
    },
  },
];

const INSTALL_RECIPES_BY_ID = new Map(
  INSTALL_RECIPES.map((recipe) => [recipe.id, recipe] as const)
);

export function getInstallRecipe(id: InstallRecipeId): InstallRecipe {
  const recipe = INSTALL_RECIPES_BY_ID.get(id);
  if (!recipe) throw new Error(`Missing install recipe "${id}".`);
  return recipe;
}

export function hasInstallRecipeForRuntime(
  runtimeId: RuntimeId,
  platform: string = process.platform
): boolean {
  return INSTALL_RECIPES.some(
    (recipe) =>
      recipe.runtimeId === runtimeId && recipe.platforms.includes(platform as InstallPlatform)
  );
}
