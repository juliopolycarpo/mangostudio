import { type RegistryClient, verifyCanaryNpmPublication } from './canary-publication';
import type { DistributionManifest } from './distribution-manifest';
import { MAIN_PACKAGE, NPM_PLATFORMS, platformPackageName } from './npm-pack';
import type { NpmCommandResult } from './npm-publish';

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
  const publication = await verifyCanaryNpmPublication(manifest, dependencies.registry);
  if (publication.missing.length > 0) {
    throw new Error(
      `Canary tag promotion requires all seven verified packages; missing ${publication.missing.join(', ')}`
    );
  }
  const names = [...NPM_PLATFORMS.map(platformPackageName), MAIN_PACKAGE];
  const updates: string[] = [];
  const unchanged: string[] = [];
  const resolved = new Map<string, string>();
  for (const name of names) {
    const version = publication.canary[name];
    if (version === null) {
      updates.push(name);
      continue;
    }
    if (typeof version !== 'string')
      throw new Error(`Unproven canary owner for ${name}: expected version or explicit absent tag`);
    const prefix = sourcePrefix(version, name);
    let owner = resolved.get(prefix);
    if (!owner) {
      owner = await dependencies.ancestry.resolveCommit(prefix);
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
    if (owner !== manifest.sourceSha) {
      const relation = await dependencies.ancestry.compare(owner, manifest.sourceSha);
      if (relation !== 'ahead') {
        throw new Error(
          `Canary tag ${name}@${version} cannot move to ${manifest.sourceSha}: expected selected source ahead of owner ${owner}; received ${relation}`
        );
      }
    }
    if (version === manifest.packageVersion) unchanged.push(name);
    else updates.push(name);
  }
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

function sourcePrefix(version: string, name: string): string {
  const match =
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-canary\.(g0\d{6}|[0-9a-f]{7})$/.exec(version);
  if (!match?.[1]) {
    throw new Error(
      `Invalid canary owner for ${name}: expected SHA-stamped canary version; received ${JSON.stringify(version)}`
    );
  }
  return match[1].startsWith('g') ? match[1].slice(1) : match[1];
}

function requireCommand(result: NpmCommandResult, label: string, oidcWrite = false): void {
  if (result.exitCode !== 0) {
    const permission = oidcWrite
      ? ". npm dist-tag requires the trusted publisher's Allow npm dist-tag permission; no legacy token fallback is allowed."
      : '';
    throw new Error(`${label}: expected exit0; received ${result.exitCode}${permission}`);
  }
}
