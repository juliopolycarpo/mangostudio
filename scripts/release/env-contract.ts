export interface ReleaseScriptEnvContract {
  readonly requiredEnv?: readonly string[];
  readonly tokenEnvFlag?: string;
  readonly requirements?: readonly ConditionalEnvRequirement[];
}

export interface ConditionalEnvRequirement {
  readonly env: readonly string[];
  readonly whenArgsInclude?: string;
  readonly unlessArgsInclude?: string;
}

export const RELEASE_SCRIPT_ENV_CONTRACTS = {
  'scripts/release/archive-assets.ts': {
    requiredEnv: ['VERSION'],
  },
  'scripts/release/canary-version.ts': {},
  'scripts/release/fill-dry-run-checksums.ts': {},
  'scripts/release/pack-npm.ts': {
    requirements: [{ env: ['VERSION'], unlessArgsInclude: '--validate' }],
  },
  'scripts/release/prepare-release.ts': {},
  'scripts/release/publish-npm.ts': {
    requiredEnv: ['NODE_AUTH_TOKEN'],
  },
  'scripts/release/push-dist-repo.ts': {
    tokenEnvFlag: '--token-env',
  },
  'scripts/release/stage-docker-ctx.ts': {
    requirements: [{ env: ['VERSION'], whenArgsInclude: '--release-assets' }],
  },
  'scripts/release/stamp-cargo-version.ts': {},
  'scripts/release/update-homebrew.ts': {},
  'scripts/release/update-scoop.ts': {},
  'scripts/release/verify-checksum.ts': {},
} as const satisfies Record<string, ReleaseScriptEnvContract>;

export type ReleaseScriptPath = keyof typeof RELEASE_SCRIPT_ENV_CONTRACTS;

export function requiredEnvForReleaseScriptInvocation(
  scriptPath: ReleaseScriptPath,
  command: string
): string[] {
  const contract: ReleaseScriptEnvContract = RELEASE_SCRIPT_ENV_CONTRACTS[scriptPath];
  const required = new Set(contract.requiredEnv ?? []);

  for (const requirement of contract.requirements ?? []) {
    const includeMatches =
      requirement.whenArgsInclude === undefined ||
      commandIncludesArg(command, requirement.whenArgsInclude);
    const excludeMatches =
      requirement.unlessArgsInclude !== undefined &&
      commandIncludesArg(command, requirement.unlessArgsInclude);
    if (includeMatches && !excludeMatches) {
      for (const envName of requirement.env) required.add(envName);
    }
  }

  if (contract.tokenEnvFlag) {
    const tokenEnv = valueAfterArg(command, contract.tokenEnvFlag);
    if (tokenEnv) required.add(tokenEnv);
  }

  return [...required].sort();
}

function commandIncludesArg(command: string, arg: string): boolean {
  return new RegExp(`(^|\\s)${escapeRegExp(arg)}(=|\\s|$)`).test(command);
}

function valueAfterArg(command: string, arg: string): string | undefined {
  const match = new RegExp(`(^|\\s)${escapeRegExp(arg)}\\s+([A-Z0-9_]+)(\\s|$)`).exec(command);
  return match?.[2];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
