import { type RegistryClient, verifyCanaryNpmPublication } from './canary-publication';
import { type CanaryVisibilityOptions, CanaryVisibilityWindow } from './canary-visibility';
import type { DistributionManifest } from './distribution-manifest';
import { MAIN_PACKAGE, NPM_PLATFORMS, platformPackageName } from './npm-pack';
import type { NpmCommandResult } from './npm-publish';
import { isValidSemver, normalizeVersion } from './release-version';

// https://docs.npmjs.com/trusted-publishers/#managing-dist-tags-with-trusted-publishing
// https://github.com/npm/cli/releases/tag/v11.21.0
// npm11.21 added OIDC dist-tag operations. Its 2026-09-30 publication clears
// bunfig.toml's three-day minimum age. No release-age exception is required.
export const CANARY_TAG_NPM_VERSION = '11.21.0';

/** Project-owned command boundary; failed subprocesses retain their exit code. */
export interface CanaryTagRunner {
  run(command: readonly string[]): Promise<NpmCommandResult>;
}

/** Resolve owners in the expected repository and establish commit ancestry. */
export interface CanaryTagAncestry {
  resolveCommit(prefix: string): Promise<string>;
  compare(base: string, head: string): Promise<'ahead' | 'identical' | 'behind' | 'diverged'>;
}

export interface CanaryTagDependencies {
  readonly registry: RegistryClient;
  readonly runner: CanaryTagRunner;
  readonly ancestry: CanaryTagAncestry;
  readonly env: NodeJS.ProcessEnv;
  readonly visibility?: CanaryVisibilityOptions;
}

interface CanaryTagPlan {
  readonly updates: readonly string[];
  readonly unchanged: readonly string[];
}

export interface CanaryTagPromotion {
  readonly sourceSha: string;
  readonly version: string;
  readonly updated: readonly string[];
  readonly unchanged: readonly string[];
}

/**
 * Require GitHub OIDC and remove npm configuration that could select legacy auth.
 * The command adapter must also isolate project, user and global npm config files.
 * Never include credential values in an error or diagnostic.
 * @example const env = canaryTagEnvironment(process.env);
 */
export function canaryTagEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN?.trim() ||
    !env.ACTIONS_ID_TOKEN_REQUEST_URL?.trim()
  ) {
    throw new Error(
      'Canary tag promotion requires GitHub Actions OIDC request URL/token and GITHUB_ACTIONS=true; legacy token authentication is disabled'
    );
  }
  let request: URL;
  try {
    request = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  } catch {
    throw new Error('Invalid ACTIONS_ID_TOKEN_REQUEST_URL: expected absolute HTTPS OIDC endpoint');
  }
  if (request.protocol !== 'https:' || request.username || request.password || request.hash) {
    throw new Error(
      'Invalid ACTIONS_ID_TOKEN_REQUEST_URL: expected absolute HTTPS OIDC endpoint without credentials or fragment'
    );
  }
  for (const [name, value] of Object.entries(env)) {
    if (
      value?.trim() &&
      (/^(?:NODE_AUTH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN)$/i.test(name) ||
        (/^npm_config_/i.test(name) && /(?:auth|token)/i.test(name)))
    ) {
      throw new Error(
        `Canary tag promotion refuses legacy npm credential ${name}; expected OIDC only`
      );
    }
  }
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        !/^npm_config_/i.test(name) && !/^(?:NODE_AUTH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN)$/i.test(name)
    )
  );
}

/**
 * Recover canary tags only after every selected package's published bytes match.
 * Validate every existing owner before the first write, then promote platform
 * tags before the wrapper. Failed commands stop recovery without moving latest.
 * The caller must authenticate the manifest and serialize publication workflows.
 * @example const result = await promoteCanaryTags(approvedManifest, dependencies);
 */
export async function promoteCanaryTags(
  manifest: DistributionManifest,
  dependencies: CanaryTagDependencies
): Promise<CanaryTagPromotion> {
  canaryTagEnvironment(dependencies.env);
  const node = await dependencies.runner.run(['node', '--version']);
  requireCommand(node, 'Node runtime probe');
  const runtime = /^v(\d+)\.(\d+)\.(\d+)$/.exec(node.stdout.trim());
  if (
    !runtime ||
    !(Number(runtime[1]) > 22 || (Number(runtime[1]) === 22 && Number(runtime[2]) >= 14))
  ) {
    throw new Error(
      `Invalid Node runtime for canary OIDC: expected stable Node >=22.14.0; received ${JSON.stringify(node.stdout.trim())}`
    );
  }
  const npm = await dependencies.runner.run([
    'bunx',
    '--package',
    `npm@${CANARY_TAG_NPM_VERSION}`,
    'npm',
    '--version',
  ]);
  requireCommand(npm, 'Pinned npm version probe');
  if (npm.stdout.trim() !== CANARY_TAG_NPM_VERSION) {
    throw new Error(
      `Invalid npm CLI for canary OIDC: expected ${CANARY_TAG_NPM_VERSION}; received ${JSON.stringify(npm.stdout.trim())}`
    );
  }
  const publication = await verifyCanaryNpmPublication(
    manifest,
    dependencies.registry,
    new CanaryVisibilityWindow(dependencies.visibility)
  );
  if (publication.missing.length > 0) {
    throw new Error(
      `Canary tag promotion requires all seven verified packages; missing ${publication.missing.join(', ')}`
    );
  }
  const { updates, unchanged } = await planCanaryTagUpdates(
    manifest,
    publication.canary,
    dependencies.ancestry
  );
  const names = [...NPM_PLATFORMS.map(platformPackageName), MAIN_PACKAGE];
  for (const name of updates) {
    const result = await dependencies.runner.run([
      'bunx',
      '--package',
      `npm@${CANARY_TAG_NPM_VERSION}`,
      'npm',
      'dist-tag',
      'add',
      `${name}@${manifest.packageVersion}`,
      'canary',
      '--registry=https://registry.npmjs.org',
    ]);
    requireCommand(result, `Canary tag promotion ${name}@${manifest.packageVersion}`, true);
  }
  for (const name of names) {
    const url = `https://registry.npmjs.org/-/package/${encodeURIComponent(name)}/dist-tags`;
    const response = await dependencies.registry.getJson(url);
    const body = response.body;
    if (
      response.status !== 200 ||
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      (body as Record<string, unknown>).canary !== manifest.packageVersion
    ) {
      throw new Error(
        `Canary tag verification for ${name}: expected HTTP200 and canary=${manifest.packageVersion}; received status=${response.status} body=${JSON.stringify(body)}`
      );
    }
  }
  return {
    sourceSha: manifest.sourceSha,
    version: manifest.packageVersion,
    updated: updates,
    unchanged,
  };
}

/**
 * Check fresh channel owners before any publisher can move a canary tag.
 * All seven explicit owner keys are required, even while selected packages are
 * still missing. This read-only plan proves source ordering without publishing
 * packages or requiring OIDC. The caller authenticates the shipping manifest.
 * @example const plan = await planCanaryTagUpdates(manifest, publication.canary, ancestry);
 */
export async function planCanaryTagUpdates(
  manifest: DistributionManifest,
  canaryOwners: Readonly<Record<string, string | null>>,
  ancestry: CanaryTagAncestry
): Promise<CanaryTagPlan> {
  const source = manifest.sourceSha;
  const short = typeof source === 'string' ? source.slice(0, 7) : '';
  const identifier = /^0\d+$/.test(short) ? `g${short}` : short;
  if (
    typeof source !== 'string' ||
    !/^[0-9a-f]{40}$/.test(source) ||
    typeof manifest.packageVersion !== 'string' ||
    !isValidSemver(manifest.packageVersion) ||
    normalizeVersion(manifest.packageVersion) !== manifest.packageVersion ||
    !manifest.packageVersion.endsWith(`-canary.${identifier}`) ||
    manifest.channel !== 'canary' ||
    manifest.runtimeProfile !== 'shipping' ||
    manifest.dirty !== false
  ) {
    throw new Error(
      `Invalid canary tag manifest: expected clean shipping canary with full lowercase source SHA and matching canonical version; received ${JSON.stringify({ sourceSha: source, packageVersion: manifest.packageVersion, channel: manifest.channel, runtimeProfile: manifest.runtimeProfile, dirty: manifest.dirty })}`
    );
  }
  const expectedNames = [...NPM_PLATFORMS.map(platformPackageName), MAIN_PACKAGE];
  if (
    canaryOwners === null ||
    typeof canaryOwners !== 'object' ||
    Array.isArray(canaryOwners) ||
    Object.keys(canaryOwners).length !== expectedNames.length ||
    Object.keys(canaryOwners).some((name) => !expectedNames.includes(name)) ||
    expectedNames.some((name) => !Object.hasOwn(canaryOwners, name))
  ) {
    throw new Error(
      `Unproven canary owner keys: expected exactly ${expectedNames.join(', ')}; received ${JSON.stringify(canaryOwners)}`
    );
  }
  for (const name of expectedNames) {
    const version = canaryOwners[name];
    if (version !== null && typeof version !== 'string') {
      throw new Error(
        `Unproven canary owner for ${name}: expected version or explicit absent tag; received ${JSON.stringify(version)}`
      );
    }
    if (typeof version === 'string') sourcePrefix(version, name);
  }
  const names = [...NPM_PLATFORMS.map(platformPackageName), MAIN_PACKAGE];
  const updates: string[] = [];
  const unchanged: string[] = [];
  const resolved = new Map<string, string>();
  for (const name of names) {
    const version = canaryOwners[name];
    if (version === null) {
      updates.push(name);
      continue;
    }
    if (typeof version !== 'string')
      throw new Error(`Unproven canary owner for ${name}: expected version or explicit absent tag`);
    const prefix = sourcePrefix(version, name);
    let owner = resolved.get(prefix);
    if (!owner) {
      owner = await ancestry.resolveCommit(prefix);
      if (!/^[0-9a-f]{40}$/.test(owner) || !owner.startsWith(prefix)) {
        throw new Error(
          `Invalid canary owner commit for ${name}@${version}: expected full SHA with prefix ${prefix}; received ${JSON.stringify(owner)}`
        );
      }
      resolved.set(prefix, owner);
    }
    if (version === manifest.packageVersion && owner !== manifest.sourceSha) {
      throw new Error(
        `Ambiguous canary version ${version}: expected full selected source ${manifest.sourceSha}; received owner ${owner}`
      );
    }
    if (owner === manifest.sourceSha && version !== manifest.packageVersion) {
      throw new Error(
        `Invalid canary source version alias for ${name}: expected identical source owner version ${manifest.packageVersion}; received ${version} at ${owner}`
      );
    }
    if (owner !== manifest.sourceSha) {
      const relation = await ancestry.compare(owner, manifest.sourceSha);
      if (relation !== 'ahead') {
        throw new Error(
          `Canary tag ${name}@${version} cannot move to ${manifest.sourceSha}: expected selected source ahead of owner ${owner}; received ${relation}`
        );
      }
    }
    if (version === manifest.packageVersion) unchanged.push(name);
    else updates.push(name);
  }
  return { updates, unchanged };
}

function sourcePrefix(version: string, name: string): string {
  const match = /^(.+)-canary\.(g0\d{6}|[0-9a-f]{7})$/.exec(version);
  if (
    !isValidSemver(version) ||
    normalizeVersion(version) !== version ||
    !match?.[1] ||
    !isValidSemver(match[1]) ||
    normalizeVersion(match[1]) !== match[1]
  ) {
    throw new Error(
      `Invalid canary owner for ${name}: expected SHA-stamped canary version; received ${JSON.stringify(version)}`
    );
  }
  return match[2].startsWith('g') ? match[2].slice(1) : match[2];
}

function requireCommand(result: NpmCommandResult, label: string, oidcWrite = false): void {
  if (result.exitCode !== 0) {
    const permission = oidcWrite
      ? ". npm dist-tag requires the trusted publisher's Allow npm dist-tag permission; no legacy token fallback is allowed."
      : '';
    throw new Error(`${label}: expected exit0; received ${result.exitCode}${permission}`);
  }
}
