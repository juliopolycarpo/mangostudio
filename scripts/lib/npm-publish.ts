import { appendFileSync } from 'node:fs';
import { NPM_PLATFORMS } from './npm-pack';
import { log, warn } from './runner';

const PUBLISH_RETRY_DELAYS_MS = [10_000, 30_000, 90_000] as const;

export type ProvenancePolicy = 'required' | 'optional' | 'disabled';

export interface NpmPublishPackage {
  readonly dir: string;
  readonly name: string;
  readonly version: string;
}

export interface NpmCommandOptions {
  readonly cwd: string;
}

export interface NpmCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface NpmRunner {
  run(args: readonly string[], options: NpmCommandOptions): Promise<NpmCommandResult>;
}

export interface NpmPublishLogger {
  info(message: string): void;
  warn(message: string): void;
}

type NpmPublishAuthMode = 'failed' | 'legacy-explicit' | 'not-published' | 'oidc';

export interface ResolveNpmPublishAuthInput {
  readonly allowLegacy: boolean;
  readonly oidcAvailable: boolean;
  readonly tokenPresent: boolean;
}

export interface NpmPublishOptions {
  readonly runner: NpmRunner;
  readonly dryRun?: boolean;
  /** npm dist-tag to publish under (e.g. 'canary'). Omitted ⇒ npm's default 'latest'. */
  readonly distTag?: string;
  readonly logger?: NpmPublishLogger;
  /** Provenance policy. Defaults to `required` (fail closed). */
  readonly provenancePolicy?: ProvenancePolicy;
  readonly retryDelaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
  /** Resolved auth mode; skips env resolution (tests). */
  readonly authMode?: 'legacy-explicit' | 'oidc';
  /** Allow NODE_AUTH_TOKEN when OIDC is unavailable (dispatch escape hatch). */
  readonly allowLegacyToken?: boolean;
}

export interface NpmPublishSummary {
  readonly published: number;
  readonly skipped: number;
  readonly dryRun: number;
  readonly provenance: NpmPublishProvenanceOutcome;
  readonly auth: NpmPublishAuthMode;
}

type NpmPublishProvenanceOutcome =
  | { readonly status: 'disabled' }
  | { readonly status: 'dropped'; readonly package: string }
  | { readonly status: 'explicit' }
  | { readonly status: 'failed'; readonly package?: string };

export type NpmPublishFailureKind = 'conflict' | 'fatal' | 'provenance' | 'transient';

interface PublishContext {
  readonly dryRun: boolean;
  readonly distTag: string | undefined;
  readonly logger: NpmPublishLogger;
  readonly policy: ProvenancePolicy;
  readonly retryDelaysMs: readonly number[];
  readonly runner: NpmRunner;
  readonly sleep: (ms: number) => Promise<void>;
  readonly state: PublishState;
}

interface PublishState {
  /** Whether the next publish attempt should pass `--provenance`. */
  useProvenance: boolean;
  provenanceDroppedAt?: string;
  provenanceFailedAt?: string;
}

type PackageOutcome = 'dryRun' | 'published' | 'skipped';

const PLATFORM_DIR_ORDER = new Map(
  NPM_PLATFORMS.map((platform, index) => [`${platform.os}-${platform.cpu}`, index])
);

const DEFAULT_LOGGER: NpmPublishLogger = { info: log, warn };

const TRANSIENT_PATTERNS = [
  /\bEAI_AGAIN\b/i,
  /\bECONNRESET\b/i,
  /\bECONNREFUSED\b/i,
  /\bETIMEDOUT\b/i,
  /\bENOTFOUND\b/i,
  /\bEPIPE\b/i,
  /\bERR_SOCKET_TIMEOUT\b/i,
  /\bFETCH_ERROR\b/i,
  /\b5\d\d\b/,
  /gateway timeout/i,
  /network/i,
  /socket hang up/i,
];

const CONFLICT_PATTERNS = [
  /\bE403\b/i,
  /403 Forbidden/i,
  /cannot publish over/i,
  /previously published/i,
  /version already exists/i,
];

const PROVENANCE_PATTERNS = [/provenance/i, /attestation/i, /sigstore/i, /oidc/i, /id-token/i];

const PROVENANCE_POLICIES = new Set<ProvenancePolicy>(['required', 'optional', 'disabled']);

/** Parse a provenance policy string. // Usage: parseProvenancePolicy('required') */
export function parseProvenancePolicy(value: string): ProvenancePolicy {
  if (!PROVENANCE_POLICIES.has(value as ProvenancePolicy)) {
    throw new Error(
      `Invalid provenance policy "${value}". Expected one of: required, optional, disabled.`
    );
  }
  return value as ProvenancePolicy;
}

/** Order platform package directories before the wrapper. // Usage: orderNpmPackageDirs(['cli','linux-x64']) */
export function orderNpmPackageDirs(dirNames: readonly string[]): string[] {
  return [...dirNames].sort(comparePackageDirs);
}

/** True when a registry view reported that a package version is absent. // Usage: isMissingPackageViewResult(result) */
export function isMissingPackageViewResult(result: NpmCommandResult): boolean {
  return (
    result.exitCode !== 0 &&
    matchesAny(result, [
      /\bE404\b/i,
      /404 Not Found/i,
      /not in this registry/i,
      /No version of .* satisfying/i,
    ])
  );
}

/** True when GitHub Actions can mint an OIDC token for npm Trusted Publishing. */
export function isNpmPublishOidcAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  return (
    typeof requestUrl === 'string' &&
    requestUrl.length > 0 &&
    typeof requestToken === 'string' &&
    requestToken.length > 0
  );
}

/** True when a non-empty npm automation token is present in the environment. */
export function isNpmPublishTokenPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  const token = env.NODE_AUTH_TOKEN;
  return typeof token === 'string' && token.length > 0;
}

/**
 * Choose npm publish auth mode. Fails closed when neither OIDC nor an allowed
 * legacy token is available.
 */
export function resolveNpmPublishAuth(
  input: ResolveNpmPublishAuthInput
): 'legacy-explicit' | 'oidc' {
  if (input.allowLegacy && input.tokenPresent) {
    return 'legacy-explicit';
  }
  if (input.oidcAvailable) {
    return 'oidc';
  }
  throw new Error(
    'npm publish authentication failed: Trusted Publishing (OIDC) is unavailable and legacy token fallback is not allowed or missing.'
  );
}

/** Classify a failed `npm publish` result. // Usage: classifyPublishFailure(result) */
export function classifyPublishFailure(result: NpmCommandResult): NpmPublishFailureKind {
  if (matchesAny(result, PROVENANCE_PATTERNS)) return 'provenance';
  if (matchesAny(result, CONFLICT_PATTERNS)) return 'conflict';
  if (isTransientNpmFailure(result)) return 'transient';
  return 'fatal';
}

/** Publish packages idempotently, preserving platform-first order. // Usage: await publishPackages(packages, { runner }) */
export async function publishPackages(
  packages: readonly NpmPublishPackage[],
  options: NpmPublishOptions
): Promise<NpmPublishSummary> {
  const publishAuthMode =
    options.authMode ??
    resolveNpmPublishAuth({
      allowLegacy: options.allowLegacyToken ?? false,
      oidcAvailable: isNpmPublishOidcAvailable(),
      tokenPresent: isNpmPublishTokenPresent(),
    });
  const context = createContext(options);
  const summary = { published: 0, skipped: 0, dryRun: 0 };

  for (const packageInfo of packages) {
    const outcome = await publishPackage(packageInfo, context);
    summary[outcome] += 1;
  }

  return {
    ...summary,
    provenance: summarizeProvenance(context),
    auth: summarizeAuth(summary, publishAuthMode),
  };
}

/** Format the final npm publish status line. // Usage: success(formatNpmPublishSummary(summary)) */
export function formatNpmPublishSummary(summary: NpmPublishSummary): string {
  return `npm publish complete: ${summary.published} published, ${summary.skipped} skipped, ${summary.dryRun} dry-run. Auth: ${summary.auth}. Provenance: ${formatProvenanceOutcome(
    summary.provenance
  )}.`;
}

/** Append auth/provenance lines to GITHUB_OUTPUT synchronously. // Usage: appendNpmPublishGithubOutputs(summary) */
export function appendNpmPublishGithubOutputs(
  summary: NpmPublishSummary,
  outputPath = process.env.GITHUB_OUTPUT
): void {
  if (!outputPath) return;
  appendFileSync(outputPath, `auth=${summary.auth}\nprovenance=${summary.provenance.status}\n`);
}

function comparePackageDirs(left: string, right: string): number {
  return packageDirSortKey(left) - packageDirSortKey(right) || left.localeCompare(right);
}

function packageDirSortKey(dirName: string): number {
  if (dirName === 'cli') return Number.MAX_SAFE_INTEGER;
  return PLATFORM_DIR_ORDER.get(dirName) ?? 1_000;
}

function createContext(options: NpmPublishOptions): PublishContext {
  const policy = options.provenancePolicy ?? 'required';
  return {
    dryRun: options.dryRun ?? false,
    distTag: options.distTag,
    logger: options.logger ?? DEFAULT_LOGGER,
    policy,
    retryDelaysMs: options.retryDelaysMs ?? PUBLISH_RETRY_DELAYS_MS,
    runner: options.runner,
    sleep: options.sleep ?? sleep,
    state: { useProvenance: policy !== 'disabled' },
  };
}

async function publishPackage(
  packageInfo: NpmPublishPackage,
  context: PublishContext
): Promise<PackageOutcome> {
  if (await isPackagePublished(packageInfo, context, true)) {
    context.logger.info(`Already published ${packageSpec(packageInfo)}; skipping.`);
    return 'skipped';
  }

  if (context.dryRun) {
    context.logger.info(`Dry run: would publish ${packageSpec(packageInfo)}.`);
    return 'dryRun';
  }

  await publishWithRetries(packageInfo, context);
  return 'published';
}

async function publishWithRetries(
  packageInfo: NpmPublishPackage,
  context: PublishContext
): Promise<void> {
  for (let attempt = 1; attempt <= maxPublishAttempts(context); attempt += 1) {
    const result = await publishOnce(packageInfo, context, attempt);
    if (result.exitCode === 0) return context.logger.info(`Published ${packageSpec(packageInfo)}.`);

    const kind = classifyPublishFailure(result);
    if (kind === 'conflict') return handleConflict(packageInfo, context, result);
    if (kind === 'transient' && hasPublishRetry(context, attempt)) {
      await waitForRetry(context, `npm publish failed for ${packageSpec(packageInfo)}`, attempt);
      continue;
    }
    if (kind !== 'transient') throw publishError(packageInfo, result);
  }

  if (await isPackagePublished(packageInfo, context, false)) return;
  throw new Error(`${packageSpec(packageInfo)} remains unpublished after retry exhaustion.`);
}

async function publishOnce(
  packageInfo: NpmPublishPackage,
  context: PublishContext,
  attempt: number
): Promise<NpmCommandResult> {
  const first = await runPublish(packageInfo, context, attempt);
  if (first.exitCode === 0 || !context.state.useProvenance) return first;
  if (classifyPublishFailure(first) !== 'provenance') return first;

  if (context.policy === 'required') {
    context.state.provenanceFailedAt = packageSpec(packageInfo);
    return first;
  }

  if (context.policy !== 'optional') return first;

  context.logger.warn(
    `npm rejected provenance for ${packageSpec(packageInfo)}; retrying without it.`
  );
  context.state.provenanceDroppedAt = packageSpec(packageInfo);
  context.state.useProvenance = false;
  return runPublish(packageInfo, context, attempt);
}

function runPublish(
  packageInfo: NpmPublishPackage,
  context: PublishContext,
  attempt: number
): Promise<NpmCommandResult> {
  const args = ['publish'];
  if (isScopedPackage(packageInfo.name)) args.push('--access', 'public');
  if (context.distTag) args.push('--tag', context.distTag);
  if (context.state.useProvenance) args.push('--provenance');

  context.logger.info(
    `Publishing ${packageSpec(packageInfo)} (${attempt}/${maxPublishAttempts(context)})...`
  );
  return context.runner.run(args, { cwd: packageInfo.dir });
}

async function handleConflict(
  packageInfo: NpmPublishPackage,
  context: PublishContext,
  result: NpmCommandResult
): Promise<void> {
  context.logger.warn(`npm reported a conflict for ${packageSpec(packageInfo)}; re-checking.`);
  if (await isPackagePublished(packageInfo, context, false)) return;
  throw publishError(packageInfo, result);
}

async function isPackagePublished(
  packageInfo: NpmPublishPackage,
  context: PublishContext,
  allowUnknown: boolean
): Promise<boolean> {
  const result = await runView(packageInfo, context);
  if (result.exitCode === 0) return true;
  if (isMissingPackageViewResult(result)) return false;
  if (allowUnknown && isTransientNpmFailure(result)) return false;
  throw new Error(`npm view failed for ${packageSpec(packageInfo)}.${formatOutput(result)}`);
}

async function runView(
  packageInfo: NpmPublishPackage,
  context: PublishContext
): Promise<NpmCommandResult> {
  for (let attempt = 1; attempt <= maxViewAttempts(context); attempt += 1) {
    const result = await context.runner.run(['view', packageSpec(packageInfo), 'version'], {
      cwd: packageInfo.dir,
    });
    if (!shouldRetryView(result, context, attempt)) return result;
    await waitForRetry(context, `npm view failed for ${packageSpec(packageInfo)}`, attempt);
  }

  throw new Error(`npm view retry loop exhausted for ${packageSpec(packageInfo)}.`);
}

function shouldRetryView(
  result: NpmCommandResult,
  context: PublishContext,
  attempt: number
): boolean {
  if (result.exitCode === 0 || isMissingPackageViewResult(result)) return false;
  return isTransientNpmFailure(result) && attempt <= context.retryDelaysMs.length;
}

async function waitForRetry(
  context: PublishContext,
  message: string,
  attempt: number
): Promise<void> {
  const delay = context.retryDelaysMs[attempt - 1];
  context.logger.warn(`${message}; retrying in ${formatDelay(delay)}.`);
  await context.sleep(delay);
}

function hasPublishRetry(context: PublishContext, attempt: number): boolean {
  return attempt <= context.retryDelaysMs.length;
}

function maxPublishAttempts(context: PublishContext): number {
  return context.retryDelaysMs.length + 1;
}

function summarizeProvenance(context: PublishContext): NpmPublishProvenanceOutcome {
  if (context.state.provenanceFailedAt) {
    return { status: 'failed', package: context.state.provenanceFailedAt };
  }
  if (context.policy === 'disabled') return { status: 'disabled' };
  if (context.state.provenanceDroppedAt) {
    return { status: 'dropped', package: context.state.provenanceDroppedAt };
  }
  return { status: 'explicit' };
}

function summarizeAuth(
  summary: {
    readonly published: number;
    readonly skipped: number;
    readonly dryRun: number;
  },
  publishAuthMode: 'legacy-explicit' | 'oidc'
): NpmPublishAuthMode {
  if (summary.published === 0 && summary.dryRun === 0 && summary.skipped > 0) {
    return 'not-published';
  }
  return publishAuthMode;
}

function formatProvenanceOutcome(outcome: NpmPublishProvenanceOutcome): string {
  if (outcome.status === 'dropped') return `dropped at ${outcome.package}`;
  if (outcome.status === 'failed' && outcome.package) return `failed at ${outcome.package}`;
  return outcome.status;
}

function maxViewAttempts(context: PublishContext): number {
  return context.retryDelaysMs.length + 1;
}

function isTransientNpmFailure(result: NpmCommandResult): boolean {
  return result.exitCode !== 0 && matchesAny(result, TRANSIENT_PATTERNS);
}

function matchesAny(result: NpmCommandResult, patterns: readonly RegExp[]): boolean {
  const output = commandOutput(result);
  return patterns.some((pattern) => pattern.test(output));
}

function publishError(packageInfo: NpmPublishPackage, result: NpmCommandResult): Error {
  return new Error(`npm publish failed for ${packageSpec(packageInfo)}.${formatOutput(result)}`);
}

function packageSpec(packageInfo: NpmPublishPackage): string {
  return `${packageInfo.name}@${packageInfo.version}`;
}

function isScopedPackage(packageName: string): boolean {
  return packageName.startsWith('@');
}

function commandOutput(result: NpmCommandResult): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function formatOutput(result: NpmCommandResult): string {
  const output = commandOutput(result);
  return output.length > 0 ? `\n${output}` : '';
}

function formatDelay(ms: number): string {
  return `${Math.round(ms / 1_000)}s`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
