import type {
  InstallAction,
  InstallPlatform,
  InstallProbeEvent,
  InstallRecipeId,
  InstallUnrunnableReason,
  RecipeInput,
  RuntimeId,
  VersionManagerId,
} from '@mangostudio/shared/environments';
import { renderShellCommand, shellQuote } from '@mangostudio/shared/environments';
import type { LibraryTargetId } from '@mangostudio/shared/library';
import {
  assertRecipeInput,
  toFnmDefaultArgument,
  toFnmVersionArgument,
  toNvmDefaultArgument,
  toNvmVersionArgument,
} from './recipe-input';

const INSTALLER_MIN_BYTES = 256;
const INSTALLER_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * winget's HRESULT for "no applicable update found" (0x8A15002B), read as a
 * signed exit code. A package already at the version winget would install
 * exits with this instead of 0 — accepting it is what keeps a re-run of
 * `install`/`upgrade` idempotent instead of reporting an already-current tool
 * as a failed install.
 */
const WINGET_NO_APPLICABLE_UPGRADE = -1978335189;

/** Every win32 script installer runs with the same locked-down flags. */
const POWERSHELL_ARGV_PREFIX = [
  'powershell',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
] as const;

const POSIX_PLATFORMS = ['darwin', 'linux'] as const;
const ALL_PLATFORMS = ['darwin', 'linux', 'win32'] as const;

/**
 * A vendor script this recipe fetches and executes on one platform. `sha256`
 * is set only when the URL is immutable enough to pin ahead of time — a
 * tagged release, never a "latest" alias — and the downloader refuses a body
 * that does not match it.
 */
export interface DownloadedInstaller {
  readonly url: string;
  readonly interpreter: 'bash' | 'sh' | 'powershell';
  readonly minBytes: number;
  readonly maxBytes: number;
  readonly sha256?: string;
}

export interface InstallRecipeBuildContext {
  readonly installerPath?: string;
  readonly nvmDir?: string;
  readonly platform: InstallPlatform;
  /**
   * Absolute path of each resolved requirement, keyed by runtime id. Every
   * recipe that invokes the tool it manages (`bun upgrade`, `fnm install`,
   * `claude update`, …) reads its own binary from here rather than a bare
   * name on PATH — a service-launched runtime's own PATH is exactly the
   * problem this sidesteps.
   */
  readonly binaryPaths: Partial<Record<RuntimeId, string>>;
}

/**
 * One status surface a finished recipe invalidates.
 *
 * A union rather than a single id because the three detection services do not
 * share an id type: `getVersionManagerStatus` takes a `VersionManagerId`,
 * `getAgentCliStatus` takes a `LibraryTargetId`, and neither is a `RuntimeId`.
 * Carrying the id beside its kind is what lets the post-install probe dispatch
 * without a cast.
 *
 * `kind` is the wire event's own `target` rather than a second copy of the same
 * three strings: a declared surface is published verbatim as an
 * `InstallProbeEvent.target`, so one the wire stops carrying must stop being
 * declarable here in the same change — `Extract` collapses it to `never` and
 * every recipe declaring it fails to compile.
 */
type ProbeTarget = InstallProbeEvent['target'];

export type InstallRecipeProbe =
  | { readonly kind: Extract<ProbeTarget, 'runtime'>; readonly runtimeId: RuntimeId }
  | {
      readonly kind: Extract<ProbeTarget, 'version-manager'>;
      readonly versionManagerId: VersionManagerId;
    }
  | { readonly kind: Extract<ProbeTarget, 'agent'>; readonly targetId: LibraryTargetId };

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
  /** Exit codes besides 0 that still mean success (winget's "already current"). */
  readonly acceptedExitCodes?: readonly number[];
  /**
   * Which status surfaces this recipe's completion makes stale, so the
   * post-install probe is a fact the recipe declares rather than a branch in
   * the application layer that a ninth recipe would silently miss. Required and
   * non-empty: a recipe whose effect nothing re-probes is invisible until the
   * next lazy read.
   */
  readonly probe: readonly [InstallRecipeProbe, ...InstallRecipeProbe[]];
  readonly download?: Partial<Record<InstallPlatform, DownloadedInstaller>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly profileLines?: readonly string[];
  /**
   * Absent when no vendor-documented unattended shape exists for this action
   * — `unrunnableReason` is then required, and `copyCommand` is the whole
   * offer.
   */
  readonly argv?: (input: RecipeInput, context: InstallRecipeBuildContext) => readonly string[];
  readonly copyCommand: (input: RecipeInput, platform: InstallPlatform) => string;
  readonly unrunnableReason?: InstallUnrunnableReason;
}

function requireBinaryPath(context: InstallRecipeBuildContext, id: RuntimeId): string {
  const path = context.binaryPaths[id];
  if (!path) {
    throw new Error(`Absolute path for "${id}" is required to run this recipe.`);
  }
  return path;
}

/**
 * A vendor's install script per platform: one POSIX body shared by darwin and
 * linux, and optionally a PowerShell one for win32. Every downloaded installer
 * is held to the same size bounds, so they are filled in here rather than
 * restated per vendor.
 * // Usage: vendorDownloads({ posix: 'https://bun.com/install', interpreter: 'bash', win32: 'https://bun.sh/install.ps1' })
 */
function vendorDownloads(descriptor: {
  readonly posix: string;
  readonly interpreter: 'bash' | 'sh';
  readonly win32?: string;
  readonly sha256?: string;
}): Partial<Record<InstallPlatform, DownloadedInstaller>> {
  const bounds = { minBytes: INSTALLER_MIN_BYTES, maxBytes: INSTALLER_MAX_BYTES } as const;
  const posix: DownloadedInstaller = {
    url: descriptor.posix,
    interpreter: descriptor.interpreter,
    ...bounds,
    ...(descriptor.sha256 !== undefined && { sha256: descriptor.sha256 }),
  };

  return {
    darwin: posix,
    linux: posix,
    ...(descriptor.win32 !== undefined && {
      win32: { url: descriptor.win32, interpreter: 'powershell', ...bounds },
    }),
  };
}

function downloadFor(
  downloads: Partial<Record<InstallPlatform, DownloadedInstaller>>,
  platform: InstallPlatform
): DownloadedInstaller {
  // A preview is built for every recipe against the host's actual platform,
  // even one this recipe does not support — `supported` already reports that
  // separately. Falling back to any declared entry keeps the preview's argv
  // non-empty instead of throwing mid-listing.
  const download = downloads[platform] ?? Object.values(downloads)[0];
  if (!download) {
    throw new Error('Recipe declares no downloaded installer for any platform.');
  }
  return download;
}

function downloadedScriptArgv(downloads: Partial<Record<InstallPlatform, DownloadedInstaller>>) {
  return (input: RecipeInput, context: InstallRecipeBuildContext): readonly string[] => {
    assertRecipeInput(input, 'none');
    if (!context.installerPath) {
      throw new Error('Downloaded installer path is required.');
    }
    const download = downloadFor(downloads, context.platform);
    if (download.interpreter === 'powershell') {
      return [...POWERSHELL_ARGV_PREFIX, '-File', context.installerPath];
    }
    return [download.interpreter, context.installerPath];
  };
}

function downloadedCopyCommand(url: string, interpreter: 'bash' | 'sh'): string {
  return `curl -fsSL ${shellQuote(url)} | ${interpreter}`;
}

/** A constant script with no user input at all — never interpolated, so a bare `bash -c` is safe. */
function posixShellArgv(script: string) {
  return (input: RecipeInput): readonly string[] => {
    assertRecipeInput(input, 'none');
    return ['bash', '-c', script];
  };
}

/** Same shape for win32: a constant script string, never built from user input. */
function powershellCommandArgv(script: string) {
  return (input: RecipeInput): readonly string[] => {
    assertRecipeInput(input, 'none');
    return [...POWERSHELL_ARGV_PREFIX, '-Command', script];
  };
}

/** Dispatches on the target platform: win32 gets its own builder, everything else the POSIX one. */
function platformArgv(
  posix: (input: RecipeInput, context: InstallRecipeBuildContext) => readonly string[],
  win32: (input: RecipeInput, context: InstallRecipeBuildContext) => readonly string[]
) {
  return (input: RecipeInput, context: InstallRecipeBuildContext): readonly string[] =>
    context.platform === 'win32' ? win32(input, context) : posix(input, context);
}

/** Renders a self-contained argv (no absolute paths) as the command a user would type themselves. */
function argvCopyCommand(
  argv: (input: RecipeInput, context: InstallRecipeBuildContext) => readonly string[]
) {
  return (input: RecipeInput, platform: InstallPlatform): string =>
    renderShellCommand(argv(input, { platform, binaryPaths: {} }));
}

/** The literal command a user would type in their own shell, never the host's resolved absolute path. */
function literalCommand(argv: readonly string[]): string {
  return renderShellCommand(argv);
}

const WINGET_FLAGS = [
  '--exact',
  '--silent',
  '--accept-package-agreements',
  '--accept-source-agreements',
  '--disable-interactivity',
] as const;

function wingetArgv(action: 'install' | 'upgrade', packageId: string) {
  return (_input: RecipeInput, context: InstallRecipeBuildContext): readonly string[] => [
    requireBinaryPath(context, 'winget'),
    action,
    '--id',
    packageId,
    ...WINGET_FLAGS,
  ];
}

function wingetCopyCommand(action: 'install' | 'upgrade', packageId: string): string {
  return literalCommand(['winget', action, '--id', packageId, ...WINGET_FLAGS]);
}

/**
 * A recipe that hands one package to winget. Every one of them is win32-only,
 * needs the network, requires winget itself, and must accept winget's
 * "already current" exit code — so those are stated here rather than per
 * recipe, where the next one could omit `acceptedExitCodes` and report an
 * already-current tool as a failed install.
 * // Usage: wingetRecipe({ id: 'git.install.windows', runtimeId: 'git', action: 'install', packageId: 'Git.Git', writes: ['%ProgramFiles%\\Git'], probe: [{ kind: 'runtime', runtimeId: 'git' }] })
 */
function wingetRecipe(descriptor: {
  readonly id: InstallRecipeId;
  readonly runtimeId: RuntimeId;
  readonly action: InstallAction;
  readonly packageId: string;
  readonly writes: readonly string[];
  readonly probe: readonly [InstallRecipeProbe, ...InstallRecipeProbe[]];
  /** Beyond winget itself — `winget.node.update` also needs the Node it upgrades. */
  readonly alsoRequires?: readonly RuntimeId[];
}): InstallRecipe {
  const packageAction = descriptor.action === 'update' ? 'upgrade' : 'install';
  return {
    id: descriptor.id,
    runtimeId: descriptor.runtimeId,
    action: descriptor.action,
    inputKind: 'none',
    platforms: ['win32'],
    requires: ['winget', ...(descriptor.alsoRequires ?? [])],
    writes: descriptor.writes,
    networkAccess: true,
    timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    acceptedExitCodes: [WINGET_NO_APPLICABLE_UPGRADE],
    probe: descriptor.probe,
    argv: wingetArgv(packageAction, descriptor.packageId),
    copyCommand: () => wingetCopyCommand(packageAction, descriptor.packageId),
  };
}

/**
 * A vendor CLI that updates itself in place: run by the absolute path the
 * probe resolved, but copied as a bare name, since that is what a user would
 * type.
 * // Usage: { id: 'bun.update', ...selfUpdateCommand('bun', 'upgrade') }
 */
function selfUpdateCommand(
  id: RuntimeId,
  verb: string
): Pick<InstallRecipe, 'argv' | 'copyCommand'> {
  return {
    argv: (input, context) => {
      assertRecipeInput(input, 'none');
      return [requireBinaryPath(context, id), verb];
    },
    copyCommand: () => literalCommand([id, verb]),
  };
}

function nvmNodeArgv(
  operation: 'install' | 'set-default',
  input: RecipeInput,
  context: InstallRecipeBuildContext
): readonly string[] {
  const validated = assertRecipeInput(input, 'node-version');
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

/**
 * Unlike nvm, fnm is a real binary rather than a shell function, so its
 * arguments are passed straight through argv — no `bash -c` shell source is
 * needed, and there is nothing here for a shell to expand in the first place.
 */
function fnmNodeArgv(
  operation: 'install' | 'set-default',
  input: RecipeInput,
  context: InstallRecipeBuildContext
): readonly string[] {
  const validated = assertRecipeInput(input, 'node-version');
  const fnmPath = requireBinaryPath(context, 'fnm');
  const argument =
    operation === 'install'
      ? toFnmVersionArgument(validated.version)
      : toFnmDefaultArgument(validated.version);
  // Never `fnm use`: that needs `fnm env` shell integration this recipe does
  // not have. `install` and `default` are the two subcommands that work from
  // a bare invocation.
  const subcommand = operation === 'install' ? 'install' : 'default';
  return [fnmPath, subcommand, argument];
}

const BUN_DOWNLOADS = vendorDownloads({
  posix: 'https://bun.com/install',
  interpreter: 'bash',
  win32: 'https://bun.sh/install.ps1',
});

const NVM_INSTALL_SCRIPT_URL = 'https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh';
// A tag URL is immutable, so this digest can be pinned; the downloader
// verifies the fetched body against it before anything runs.
const NVM_INSTALL_SCRIPT_SHA256 =
  '066ce4eaf4d78eaa6410433bc9ba58faaba646157cbbed6109153e6c24c5f8a5';
const NVM_DOWNLOADS = vendorDownloads({
  posix: NVM_INSTALL_SCRIPT_URL,
  interpreter: 'bash',
  sha256: NVM_INSTALL_SCRIPT_SHA256,
});
const NVM_PROFILE_LINES = [
  'export NVM_DIR="$HOME/.nvm"',
  '[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh" # This loads nvm',
  '[ -s "$NVM_DIR/bash_completion" ] && \\. "$NVM_DIR/bash_completion" # This loads nvm bash_completion',
];
function nvmScriptCopyCommand(input: RecipeInput, _platform: InstallPlatform): string {
  assertRecipeInput(input, 'none');
  return `curl -fsSL ${NVM_INSTALL_SCRIPT_URL} | PROFILE=/dev/null bash`;
}

const CLAUDE_DOWNLOADS = vendorDownloads({
  posix: 'https://claude.ai/install.sh',
  interpreter: 'bash',
  win32: 'https://claude.ai/install.ps1',
});

const CODEX_DOWNLOADS = vendorDownloads({
  posix: 'https://chatgpt.com/codex/install.sh',
  interpreter: 'sh',
  win32: 'https://chatgpt.com/codex/install.ps1',
});

const CURSOR_DOWNLOADS = vendorDownloads({
  posix: 'https://cursor.com/install',
  interpreter: 'bash',
  win32: 'https://cursor.com/install?win32=true',
});

/**
 * Removes Bun's *default* root only, and proves the directory is one before
 * deleting it.
 *
 * `$BUN_INSTALL` is deliberately not expanded here. It is a prefix, not the
 * Bun directory — detection joins `bin` onto it (`wellKnownBunDirectories`) —
 * so a machine that points it at a shared location turns `rm -rf "$BUN_INSTALL"`
 * into a delete of that whole tree. A Bun installed under a custom prefix is
 * therefore detected but not removable from here: the guard fails loudly
 * rather than deleting a root this recipe cannot vouch for.
 */
const BUN_UNINSTALL_ARGV = platformArgv(
  posixShellArgv(
    [
      'root="$HOME/.bun"',
      '[ -x "$root/bin/bun" ] || { echo "refusing to remove $root: no bin/bun inside it" >&2; exit 1; }',
      'rm -rf -- "$root"',
    ].join('\n')
  ),
  powershellCommandArgv(
    [
      '$root = "$env:USERPROFILE\\.bun"',
      // `${root}` is delimited deliberately: PowerShell parses a bare `$root:`
      // as a drive-qualified variable and refuses to compile the script.
      'if (-not (Test-Path -LiteralPath "$root\\uninstall.ps1")) { ' +
        'Write-Error "refusing to remove ${root}: no uninstall.ps1 inside it"; exit 1 }',
      '& "$root\\uninstall.ps1"',
    ].join('; ')
  )
);

const CLAUDE_UNINSTALL_ARGV = platformArgv(
  posixShellArgv('rm -f "$HOME/.local/bin/claude" && rm -rf "$HOME/.local/share/claude"'),
  powershellCommandArgv(
    'Remove-Item -Path "$env:USERPROFILE\\.local\\bin\\claude.exe" -Force; ' +
      'Remove-Item -Path "$env:USERPROFILE\\.local\\share\\claude" -Recurse -Force'
  )
);

export const INSTALL_RECIPES: readonly InstallRecipe[] = [
  {
    id: 'bun.install.official',
    runtimeId: 'bun',
    action: 'install',
    inputKind: 'none',
    platforms: ALL_PLATFORMS,
    requires: [],
    writes: ['$HOME/.bun', '$HOME/.bashrc or $HOME/.zshrc', '%USERPROFILE%\\.bun'],
    networkAccess: true,
    timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    probe: [{ kind: 'runtime', runtimeId: 'bun' }],
    download: BUN_DOWNLOADS,
    profileLines: ['export BUN_INSTALL="$HOME/.bun"', 'export PATH="$BUN_INSTALL/bin:$PATH"'],
    argv: downloadedScriptArgv(BUN_DOWNLOADS),
    copyCommand: (input, platform) => {
      assertRecipeInput(input, 'none');
      if (platform === 'win32') return 'powershell -c "irm bun.sh/install.ps1|iex"';
      return downloadedCopyCommand('https://bun.com/install', 'bash');
    },
  },
  {
    id: 'bun.update',
    runtimeId: 'bun',
    action: 'update',
    inputKind: 'none',
    platforms: ALL_PLATFORMS,
    requires: ['bun'],
    writes: ['$BUN_INSTALL/bin/bun'],
    networkAccess: true,
    timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    probe: [{ kind: 'runtime', runtimeId: 'bun' }],
    ...selfUpdateCommand('bun', 'upgrade'),
  },
  {
    id: 'bun.uninstall',
    runtimeId: 'bun',
    action: 'uninstall',
    inputKind: 'none',
    platforms: ALL_PLATFORMS,
    requires: [],
    writes: ['$HOME/.bun', '%USERPROFILE%\\.bun'],
    networkAccess: false,
    timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    probe: [{ kind: 'runtime', runtimeId: 'bun' }],
    argv: BUN_UNINSTALL_ARGV,
    copyCommand: argvCopyCommand(BUN_UNINSTALL_ARGV),
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
    download: NVM_DOWNLOADS,
    env: { PROFILE: '/dev/null' },
    profileLines: NVM_PROFILE_LINES,
    argv: downloadedScriptArgv(NVM_DOWNLOADS),
    copyCommand: nvmScriptCopyCommand,
  },
  {
    id: 'nvm.update',
    runtimeId: 'nvm',
    action: 'update',
    inputKind: 'none',
    platforms: POSIX_PLATFORMS,
    // nvm has no separate updater: re-running the tagged install script is
    // the vendor-documented way to move `nvm.sh` itself to a newer release.
    requires: ['nvm'],
    writes: ['$NVM_DIR'],
    networkAccess: true,
    timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    probe: [{ kind: 'version-manager', versionManagerId: 'nvm' }],
    download: NVM_DOWNLOADS,
    env: { PROFILE: '/dev/null' },
    profileLines: NVM_PROFILE_LINES,
    argv: downloadedScriptArgv(NVM_DOWNLOADS),
    copyCommand: nvmScriptCopyCommand,
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
      return `nvm alias default ${shellQuote(toNvmDefaultArgument(validated.version))}`;
    },
  },
  // winget's fnm manifest ships zip+portable: without Developer Mode there
  // is no stable symlink for it, which is why the node recipes below call
  // fnm by the absolute path the probe resolved rather than by name.
  wingetRecipe({
    id: 'fnm.install',
    runtimeId: 'fnm',
    action: 'install',
    packageId: 'Schniz.fnm',
    writes: [
      '%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\Schniz.fnm*',
      '%LOCALAPPDATA%\\Microsoft\\WinGet\\Links',
    ],
    probe: [{ kind: 'runtime', runtimeId: 'fnm' }],
  }),
  {
    id: 'fnm.node.install',
    runtimeId: 'node',
    action: 'use-version',
    inputKind: 'node-version',
    platforms: ALL_PLATFORMS,
    requires: ['fnm'],
    writes: ['<FNM_DIR>/node-versions'],
    networkAccess: true,
    timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    // `fnm install --lts` also writes the `lts-latest` alias that
    // `fnm.node.set-default` relies on. Both surfaces move: a new managed
    // version is a node the machine can now run and a version fnm now lists.
    probe: [
      { kind: 'runtime', runtimeId: 'node' },
      { kind: 'version-manager', versionManagerId: 'fnm' },
    ],
    argv: (input, context) => fnmNodeArgv('install', input, context),
    copyCommand: (input) => {
      const validated = assertRecipeInput(input, 'node-version');
      return literalCommand(['fnm', 'install', toFnmVersionArgument(validated.version)]);
    },
  },
  {
    id: 'fnm.node.set-default',
    runtimeId: 'node',
    action: 'set-default',
    inputKind: 'node-version',
    platforms: ALL_PLATFORMS,
    requires: ['fnm'],
    writes: ['<FNM_DIR>/aliases/default'],
    networkAccess: false,
    timeoutMs: 30_000,
    probe: [
      { kind: 'runtime', runtimeId: 'node' },
      { kind: 'version-manager', versionManagerId: 'fnm' },
    ],
    argv: (input, context) => fnmNodeArgv('set-default', input, context),
    copyCommand: (input) => {
      const validated = assertRecipeInput(input, 'node-version');
      return literalCommand(['fnm', 'default', toFnmDefaultArgument(validated.version)]);
    },
  },
  // The per-machine MSI declares `elevatesSelf`, so a UAC prompt shows
  // regardless of `--silent`; over an existing nodejs.org MSI winget takes
  // its "found existing package, trying to upgrade" path instead of failing.
  wingetRecipe({
    id: 'winget.node.install',
    runtimeId: 'node',
    action: 'install',
    packageId: 'OpenJS.NodeJS.LTS',
    writes: ['%ProgramFiles%\\nodejs'],
    probe: [{ kind: 'runtime', runtimeId: 'node' }],
  }),
  // The `.LTS` package tracks the current LTS line, so this crosses majors
  // rather than only patching within one.
  wingetRecipe({
    id: 'winget.node.update',
    runtimeId: 'node',
    action: 'update',
    packageId: 'OpenJS.NodeJS.LTS',
    writes: ['%ProgramFiles%\\nodejs'],
    probe: [{ kind: 'runtime', runtimeId: 'node' }],
    alsoRequires: ['node'],
  }),
  // The Inno Setup installer self-elevates for an admin account.
  wingetRecipe({
    id: 'git.install.windows',
    runtimeId: 'git',
    action: 'install',
    packageId: 'Git.Git',
    writes: ['%ProgramFiles%\\Git'],
    probe: [{ kind: 'runtime', runtimeId: 'git' }],
  }),
  {
    id: 'claude.install',
    runtimeId: 'claude',
    action: 'install',
    inputKind: 'none',
    platforms: ALL_PLATFORMS,
    requires: [],
    writes: ['$HOME/.local/bin/claude', '$HOME/.claude', '%USERPROFILE%\\.local\\bin\\claude.exe'],
    networkAccess: true,
    timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    probe: [{ kind: 'agent', targetId: 'claude' }],
    download: CLAUDE_DOWNLOADS,
    argv: downloadedScriptArgv(CLAUDE_DOWNLOADS),
    copyCommand: (input, platform) => {
      assertRecipeInput(input, 'none');
      if (platform === 'win32') return 'irm https://claude.ai/install.ps1 | iex';
      return downloadedCopyCommand('https://claude.ai/install.sh', 'bash');
    },
  },
  {
    id: 'claude.update',
    runtimeId: 'claude',
    action: 'update',
    inputKind: 'none',
    platforms: ALL_PLATFORMS,
    requires: ['claude'],
    writes: ['$HOME/.local/bin/claude', '%USERPROFILE%\\.local\\bin\\claude.exe'],
    networkAccess: true,
    timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    probe: [{ kind: 'agent', targetId: 'claude' }],
    ...selfUpdateCommand('claude', 'update'),
  },
  {
    id: 'claude.uninstall',
    runtimeId: 'claude',
    action: 'uninstall',
    inputKind: 'none',
    platforms: ALL_PLATFORMS,
    requires: [],
    // Deliberately leaves `~/.claude` (settings, credentials) untouched — this
    // removes the binary, not the user's configuration. The versioned install
    // under `share` is named as well as the entry point: the argv deletes it
    // recursively, the confirm dialog discloses this list verbatim, and the
    // card reads it to decide whether the effective installation is one this
    // recipe owns — which for a vendor symlink resolves under `share`.
    writes: [
      '$HOME/.local/bin/claude',
      '$HOME/.local/share/claude',
      '%USERPROFILE%\\.local\\bin\\claude.exe',
      '%USERPROFILE%\\.local\\share\\claude',
    ],
    networkAccess: false,
    timeoutMs: 30_000,
    probe: [{ kind: 'agent', targetId: 'claude' }],
    argv: CLAUDE_UNINSTALL_ARGV,
    copyCommand: argvCopyCommand(CLAUDE_UNINSTALL_ARGV),
  },
  {
    id: 'codex.install',
    runtimeId: 'codex',
    action: 'install',
    inputKind: 'none',
    platforms: ALL_PLATFORMS,
    requires: [],
    writes: ['$HOME/.local/bin/codex', '$HOME/.codex', '%LOCALAPPDATA%\\Programs\\OpenAI\\Codex'],
    networkAccess: true,
    timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    probe: [{ kind: 'agent', targetId: 'codex' }],
    download: CODEX_DOWNLOADS,
    argv: downloadedScriptArgv(CODEX_DOWNLOADS),
    copyCommand: (input, platform) => {
      assertRecipeInput(input, 'none');
      if (platform === 'win32') {
        return 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"';
      }
      return downloadedCopyCommand('https://chatgpt.com/codex/install.sh', 'sh');
    },
  },
  {
    id: 'codex.update',
    runtimeId: 'codex',
    action: 'update',
    inputKind: 'none',
    platforms: ALL_PLATFORMS,
    requires: ['codex'],
    writes: ['$HOME/.local/bin/codex', '%LOCALAPPDATA%\\Programs\\OpenAI\\Codex'],
    networkAccess: true,
    timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    // The standalone installer's `update` re-runs the vendor install script;
    // this is what makes that unattended instead of prompting.
    env: { CODEX_NON_INTERACTIVE: '1' },
    probe: [{ kind: 'agent', targetId: 'codex' }],
    ...selfUpdateCommand('codex', 'update'),
  },
  {
    id: 'codex.uninstall',
    runtimeId: 'codex',
    action: 'uninstall',
    inputKind: 'none',
    platforms: ALL_PLATFORMS,
    requires: [],
    writes: ['$HOME/.local/bin/codex', '$HOME/.codex/packages/standalone'],
    networkAccess: false,
    timeoutMs: 30_000,
    probe: [{ kind: 'agent', targetId: 'codex' }],
    // No vendor-documented unattended uninstall exists — offered as a
    // copyable command only.
    unrunnableReason: 'vendor-undocumented',
    copyCommand: (input, platform) => {
      assertRecipeInput(input, 'none');
      if (platform === 'win32') {
        return (
          'Remove-Item "$env:LOCALAPPDATA\\Programs\\OpenAI\\Codex" -Recurse -Force; ' +
          'Remove-Item "$env:USERPROFILE\\.codex\\packages\\standalone" -Recurse -Force'
        );
      }
      return 'rm -f ~/.local/bin/codex && rm -rf ~/.codex/packages/standalone';
    },
  },
  {
    id: 'cursor.install',
    runtimeId: 'cursor',
    action: 'install',
    inputKind: 'none',
    platforms: ALL_PLATFORMS,
    requires: [],
    writes: ['$HOME/.local/bin', '$HOME/.cursor', '%USERPROFILE%\\.cursor'],
    networkAccess: true,
    timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    probe: [{ kind: 'agent', targetId: 'cursor' }],
    download: CURSOR_DOWNLOADS,
    argv: downloadedScriptArgv(CURSOR_DOWNLOADS),
    copyCommand: (input, platform) => {
      assertRecipeInput(input, 'none');
      if (platform === 'win32') return "irm 'https://cursor.com/install?win32=true' | iex";
      return downloadedCopyCommand('https://cursor.com/install', 'bash');
    },
  },
  {
    id: 'cursor.update',
    runtimeId: 'cursor',
    action: 'update',
    inputKind: 'none',
    platforms: ALL_PLATFORMS,
    requires: ['cursor'],
    writes: ['$HOME/.local/bin', '%USERPROFILE%\\.cursor'],
    networkAccess: true,
    timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    probe: [{ kind: 'agent', targetId: 'cursor' }],
    ...selfUpdateCommand('cursor', 'update'),
  },
  {
    id: 'cursor.uninstall',
    runtimeId: 'cursor',
    action: 'uninstall',
    inputKind: 'none',
    platforms: ALL_PLATFORMS,
    requires: [],
    writes: ['$HOME/.local/bin/agent', '$HOME/.cursor', '%USERPROFILE%\\.cursor'],
    networkAccess: false,
    timeoutMs: 30_000,
    probe: [{ kind: 'agent', targetId: 'cursor' }],
    // No vendor-documented unattended uninstall exists — offered as a
    // copyable command only.
    unrunnableReason: 'vendor-undocumented',
    copyCommand: (input, platform) => {
      assertRecipeInput(input, 'none');
      if (platform === 'win32') return 'Remove-Item "$env:USERPROFILE\\.cursor" -Recurse -Force';
      return 'rm -rf ~/.local/bin/agent ~/.cursor';
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

/** A write entry spelled the Windows way: `%VAR%` expansion, or a backslash separator. */
const WIN32_WRITE_SHAPE = /^%[^%]+%|\\/;
/** A write entry spelled the POSIX way: `$VAR` expansion, `~`, or an absolute path. */
const POSIX_WRITE_SHAPE = /^[$~/]/;

/**
 * The paths a recipe declares it writes, narrowed to the ones that mean
 * anything on `platform`.
 *
 * A cross-platform recipe declares both spellings in one flat list
 * (`$HOME/.local/bin/claude` *and* `%USERPROFILE%\.local\bin\claude.exe`), and
 * every consumer reads that list as a fact about the machine in front of the
 * user: the uninstall confirmation names them as what it is about to delete,
 * and the card matches an installation's path against them to decide whether
 * the recipe owns it. Showing a Windows path in a Linux "this will remove"
 * dialog is wrong in the one place being precise matters most.
 *
 * An entry in neither spelling (`<FNM_DIR>/node-versions`) is a placeholder
 * that reads the same everywhere and is kept on every platform.
 *
 * // Usage: writesForPlatform(recipe.writes, 'linux') // ['$HOME/.local/bin/claude', …]
 */
export function writesForPlatform(
  writes: readonly string[],
  platform: InstallPlatform
): readonly string[] {
  const narrowed = writes.filter((write) =>
    platform === 'win32' ? !POSIX_WRITE_SHAPE.test(write) : !WIN32_WRITE_SHAPE.test(write)
  );
  // A recipe whose every entry reads as the other platform's is malformed
  // rather than silent: disclosing nothing would understate what runs.
  return narrowed.length > 0 ? narrowed : writes;
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
