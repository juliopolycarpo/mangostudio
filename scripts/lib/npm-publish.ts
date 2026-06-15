import { NPM_PLATFORMS } from './npm-pack';
import { log, warn } from './runner';

export const PUBLISH_RETRY_DELAYS_MS = [10_000, 30_000, 90_000] as const;

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

export interface NpmPublishOptions {
  readonly runner: NpmRunner;
  readonly dryRun?: boolean;
  /** npm dist-tag to publish under (e.g. 'canary'). Omitted ⇒ npm's default 'latest'. */
  readonly distTag?: string;
  readonly logger?: NpmPublishLogger;
  readonly provenance?: boolean;
  readonly retryDelaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface NpmPublishSummary {
  readonly published: number;
  readonly skipped: number;
  readonly dryRun: number;
  readonly provenance: NpmPublishProvenanceOutcome;
}

export type NpmPublishProvenanceOutcome =
  | { readonly status: 'disabled' }
  | { readonly status: 'dropped'; readonly package: string }
  | { readonly status: 'full' };

export type NpmPublishFailureKind = 'conflict' | 'fatal' | 'provenance' | 'transient';

interface PublishContext {
  readonly dryRun: boolean;
  readonly distTag: string | undefined;
  readonly logger: NpmPublishLogger;
  readonly retryDelaysMs: readonly number[];
  readonly runner: NpmRunner;
  readonly sleep: (ms: number) => Promise<void>;
  readonly state: PublishState;
}

interface PublishState {
  provenance: boolean;
  provenanceDroppedAt?: string;
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

/** Order platform package directories before the wrapper. // Usage: orderNpmPackageDirs(['cli','linux-x64']) */
export function orderNpmPackageDirs(dirNames: readonly string[]): string[] {
  return [...dirNames].sort(comparePackageDirs);
}

/** True when `npm view` reported that a package version is absent. // Usage: isMissingPackageViewResult(result) */
export function isMissingPackageViewResult(result: NpmCommandResult): boolean {
  return (
    result.exitCode !== 0 &&
    matchesAny(result, [/\bE404\b/i, /404 Not Found/i, /not in this registry/i])
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
  const context = createContext(options);
  const summary = { published: 0, skipped: 0, dryRun: 0 };

  for (const packageInfo of packages) {
    const outcome = await publishPackage(packageInfo, context);
    summary[outcome] += 1;
  }

  return { ...summary, provenance: summarizeProvenance(context.state) };
}

/** Format the final npm publish status line. // Usage: success(formatNpmPublishSummary(summary)) */
export function formatNpmPublishSummary(summary: NpmPublishSummary): string {
  return `npm publish complete: ${summary.published} published, ${summary.skipped} skipped, ${summary.dryRun} dry-run. Provenance: ${formatProvenanceOutcome(
    summary.provenance
  )}.`;
}

function comparePackageDirs(left: string, right: string): number {
  return packageDirSortKey(left) - packageDirSortKey(right) || left.localeCompare(right);
}

function packageDirSortKey(dirName: string): number {
  if (dirName === 'cli') return Number.MAX_SAFE_INTEGER;
  return PLATFORM_DIR_ORDER.get(dirName) ?? 1_000;
}

function createContext(options: NpmPublishOptions): PublishContext {
  return {
    dryRun: options.dryRun ?? false,
    distTag: options.distTag,
    logger: options.logger ?? DEFAULT_LOGGER,
    retryDelaysMs: options.retryDelaysMs ?? PUBLISH_RETRY_DELAYS_MS,
    runner: options.runner,
    sleep: options.sleep ?? sleep,
    state: { provenance: options.provenance ?? true },
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
  if (first.exitCode === 0 || !context.state.provenance) return first;
  if (classifyPublishFailure(first) !== 'provenance') return first;

  context.logger.warn(
    `npm rejected provenance for ${packageSpec(packageInfo)}; retrying without it.`
  );
  context.state.provenanceDroppedAt = packageSpec(packageInfo);
  context.state.provenance = false;
  return runPublish(packageInfo, context, attempt);
}

function runPublish(
  packageInfo: NpmPublishPackage,
  context: PublishContext,
  attempt: number
): Promise<NpmCommandResult> {
  const args = ['publish', '--access', 'public'];
  if (context.distTag) args.push('--tag', context.distTag);
  if (context.state.provenance) args.push('--provenance');

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

function summarizeProvenance(state: PublishState): NpmPublishProvenanceOutcome {
  if (state.provenance) return { status: 'full' };
  if (state.provenanceDroppedAt) {
    return { status: 'dropped', package: state.provenanceDroppedAt };
  }
  return { status: 'disabled' };
}

function formatProvenanceOutcome(outcome: NpmPublishProvenanceOutcome): string {
  if (outcome.status === 'dropped') return `dropped at ${outcome.package}`;
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
