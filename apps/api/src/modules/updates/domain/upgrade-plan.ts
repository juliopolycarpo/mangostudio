/**
 * What an upgrade request turns into for a given install origin: the hub does
 * it itself, hands the job to the package manager that owns the binary, or
 * refuses with the exact command that would do it. One table, used by the CLI,
 * the machine route and the update banner, so no surface invents its own.
 */

import type {
  InstallManager,
  UpdateChannel,
  UpgradeRefusalReason,
} from '@mangostudio/shared/updates';

export const RELEASES_BASE_URL = 'https://github.com/juliopolycarpo/mangostudio/releases';
export const IMAGE_REPOSITORY = 'ghcr.io/juliopolycarpo/mangostudio';
const INSTALL_SH_URL = `${RELEASES_BASE_URL}/latest/download/install.sh`;
const INSTALL_PS1_URL = `${RELEASES_BASE_URL}/latest/download/install.ps1`;

export interface UpgradeRequest {
  readonly channel: UpdateChannel;
  /**
   * The exact version being installed, when already resolved: a stable
   * `x.y.z` or a canary `<root>-canary.<sha7>`. Absent means "the channel's
   * latest", which every package manager spells with a dist-tag.
   */
  readonly version?: string;
  /** Canary only: a pinned source commit. */
  readonly sha?: string;
}

export type UpgradePlan =
  /** The hub downloads, verifies and runs the embedded install script. */
  | { readonly kind: 'self' }
  /** A package manager owns the binary; `argv` is what `--yes` runs. */
  | { readonly kind: 'delegate'; readonly command: string; readonly argv: readonly string[] }
  /** Nothing to run from here; `command` is what the user runs instead. */
  | {
      readonly kind: 'refused';
      readonly reason: UpgradeRefusalReason;
      readonly command: string;
      readonly message: string;
    };

function shellInstaller(platform: NodeJS.Platform, channel: UpdateChannel): string {
  if (platform === 'win32') {
    const flag = channel === 'canary' ? ' -Canary' : '';
    return `& ([scriptblock]::Create((irm ${INSTALL_PS1_URL})))${flag}`;
  }
  const flag = channel === 'canary' ? ' -s -- --canary' : '';
  return `curl -fsSL ${INSTALL_SH_URL} | bash${flag}`;
}

/** The npm spec a request maps to: a dist-tag for "latest", else the exact version. */
function npmSpec(request: UpgradeRequest): string {
  if (request.version) return `mangostudio@${request.version}`;
  return request.channel === 'canary' ? 'mangostudio@canary' : 'mangostudio@latest';
}

function npmFamilyArgv(manager: 'npm' | 'bun' | 'pnpm', spec: string): readonly string[] {
  switch (manager) {
    case 'npm':
      return ['npm', 'install', '-g', spec];
    case 'bun':
      return ['bun', 'add', '-g', spec];
    case 'pnpm':
      return ['pnpm', 'add', '-g', spec];
  }
}

function delegate(argv: readonly string[]): UpgradePlan {
  return { kind: 'delegate', command: argv.join(' '), argv };
}

function refused(reason: UpgradeRefusalReason, command: string, message: string): UpgradePlan {
  return { kind: 'refused', reason, command, message };
}

function imageTag(request: UpgradeRequest, currentRoot: string): string {
  if (request.version) return request.version;
  if (request.channel === 'canary')
    return request.sha ? `${currentRoot}-canary.${request.sha}` : 'canary';
  return 'latest';
}

/** `x.y.z` of a version, without any prerelease. // Usage: versionRoot('0.1.1-canary.abc') → '0.1.1' */
export function versionRoot(version: string): string {
  return version.split('-')[0] ?? version;
}

function planForManager(
  manager: InstallManager,
  request: UpgradeRequest,
  context: { readonly platform: NodeJS.Platform; readonly currentVersion: string }
): UpgradePlan {
  const canary = request.channel === 'canary';
  const installer = shellInstaller(context.platform, request.channel);
  switch (manager) {
    case 'self-managed':
      return { kind: 'self' };
    case 'npm':
    case 'bun':
    case 'pnpm':
      return delegate(npmFamilyArgv(manager, npmSpec(request)));
    case 'homebrew':
      if (canary) {
        return refused(
          'channel-unsupported',
          installer,
          'Homebrew publishes stable releases only. Switch to the shell installer for canary.'
        );
      }
      return delegate(['brew', 'upgrade', 'mangostudio']);
    case 'scoop':
      if (canary) {
        return refused(
          'channel-unsupported',
          installer,
          'Scoop publishes stable releases only. Switch to the PowerShell installer for canary.'
        );
      }
      return delegate(['scoop', 'update', 'mangostudio']);
    case 'cargo':
      if (request.sha) {
        return refused(
          'channel-unsupported',
          installer,
          'crates.io has no per-commit canary. Switch to the shell installer for a pinned commit.'
        );
      }
      if (canary) {
        const root = versionRoot(request.version ?? context.currentVersion);
        return delegate([
          'cargo',
          'install',
          'mangostudio',
          '--version',
          `${root}-canary`,
          '--locked',
        ]);
      }
      return delegate(['cargo', 'install', 'mangostudio', '--locked']);
    case 'docker': {
      const tag = imageTag(request, versionRoot(context.currentVersion));
      return refused(
        'container',
        `docker pull ${IMAGE_REPOSITORY}:${tag}`,
        'A container is replaced by pulling the image, not upgraded in place.'
      );
    }
    case 'source':
      return refused(
        'source-checkout',
        'git pull && bun run build',
        'This is a source checkout; rebuild it instead of upgrading a binary.'
      );
    case 'unknown':
      return refused(
        'unknown-origin',
        installer,
        'Could not tell how this binary was installed. Reinstall with the install script, which records its origin.'
      );
  }
}

/**
 * Decide how a request is carried out for this origin.
 * // Usage: planUpgrade('bun', { channel: 'stable' }, { platform: 'linux', currentVersion: '0.1.1' })
 */
export function planUpgrade(
  manager: InstallManager,
  request: UpgradeRequest,
  context: { readonly platform: NodeJS.Platform; readonly currentVersion: string }
): UpgradePlan {
  return planForManager(manager, request, context);
}

/** The one-line command to print beside "update available". // Usage: upgradeCommandFor(plan) */
export function upgradeCommandFor(plan: UpgradePlan, channel: UpdateChannel): string {
  if (plan.kind === 'self')
    return channel === 'canary' ? 'mangostudio upgrade --canary' : 'mangostudio upgrade';
  return plan.command;
}
