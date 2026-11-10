#!/usr/bin/env bun
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RegistryClient, RegistryResponse } from '../lib/canary-publication';
import {
  CANARY_TAG_NPM_VERSION,
  type CanaryTagAncestry,
  type CanaryTagDependencies,
  canaryTagEnvironment,
  type CanaryTagPromotion,
  type CanaryTagRunner,
  promoteCanaryTags,
} from '../lib/canary-tags';
import { readDistributionManifest } from '../lib/distribution-manifest';
import type { NpmCommandResult } from '../lib/npm-publish';

/** Subprocess I/O retained behind the project-owned command adapter. */
export interface CanaryTagProcess {
  run(
    command: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly signal?: AbortSignal;
    }
  ): Promise<NpmCommandResult>;
}

/** Execute a command while draining both pipes before returning its verdict. */
export class BunCanaryTagProcess implements CanaryTagProcess {
  /** @example await process.run(['node', '--version'], { cwd, env }); */
  async run(
    command: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly signal?: AbortSignal;
    }
  ): Promise<NpmCommandResult> {
    const child = Bun.spawn({
      cmd: [...command],
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      killSignal: 'SIGKILL',
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  }
}

/** Isolate npm's project/user/global configuration while preserving GitHub OIDC. */
export class IsolatedCanaryTagRunner implements CanaryTagRunner {
  private readonly env: NodeJS.ProcessEnv;
  constructor(
    private readonly directory: string,
    env: NodeJS.ProcessEnv,
    private readonly process: CanaryTagProcess = new BunCanaryTagProcess()
  ) {
    this.env = canaryTagEnvironment(env);
    if (readdirSync(directory).length !== 0)
      throw new Error(
        `Invalid canary command directory ${directory}: expected empty owned scratch directory`
      );
    writeFileSync(join(directory, 'package.json'), '{"private":true}\n');
    writeFileSync(join(directory, '.npmrc'), '');
    writeFileSync(join(directory, 'user.npmrc'), '');
    writeFileSync(join(directory, 'global.npmrc'), '');
  }

  /** @example await runner.run(['bunx', '--package', 'npm@11.21.2', 'npm', '--version']); */
  run(command: readonly string[], signal?: AbortSignal): Promise<NpmCommandResult> {
    let isolated = [...command];
    if (command[0] === 'bunx') {
      if (
        command[1] !== '--package' ||
        command[2] !== `npm@${CANARY_TAG_NPM_VERSION}` ||
        command[3] !== 'npm'
      ) {
        throw new Error(
          `Invalid npm tag command: expected bunx --package npm@${CANARY_TAG_NPM_VERSION} npm`
        );
      }
      isolated = [
        ...command.slice(0, 4),
        '--userconfig',
        join(this.directory, 'user.npmrc'),
        '--globalconfig',
        join(this.directory, 'global.npmrc'),
        ...command.slice(4),
      ];
    }
    return this.process.run(isolated, {
      cwd: this.directory,
      env: this.env,
      ...(signal ? { signal } : {}),
    });
  }
}

/** Public npm reads preserve status and never use a write credential. */
export class HttpCanaryRegistry implements RegistryClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  /** @example const response = await registry.getJson(versionUrl); */
  async getJson(url: string, signal?: AbortSignal): Promise<RegistryResponse<unknown>> {
    const response = await this.read(url, signal);
    if (response.status !== 200) {
      await response.body?.cancel();
      return { status: response.status, body: null };
    }
    try {
      return { status: response.status, body: await response.json() };
    } catch (cause) {
      throw new Error(`Registry response ${url}: expected valid JSON`, { cause });
    }
  }
  /** @example const archive = await registry.getBytes(tarballUrl); */
  async getBytes(url: string, signal?: AbortSignal): Promise<RegistryResponse<Uint8Array>> {
    const response = await this.read(url, signal);
    if (response.status !== 200) {
      await response.body?.cancel();
      return { status: response.status, body: new Uint8Array() };
    }
    return { status: response.status, body: new Uint8Array(await response.arrayBuffer()) };
  }
  private read(url: string, signal?: AbortSignal): Promise<Response> {
    if (!url.startsWith('https://registry.npmjs.org/'))
      throw new Error(`Invalid public npm URL: ${url}; expected https://registry.npmjs.org/`);
    return this.fetcher(url, { redirect: 'error', signal });
  }
}

/** GitHub commit resolution and compare proofs for the configured publication repository. */
export class GitHubCanaryTagAncestry implements CanaryTagAncestry {
  constructor(
    private readonly repository: string,
    private readonly runner: CanaryTagRunner
  ) {
    validateRepository(repository);
  }

  /** @example const sha = await ancestry.resolveCommit('abc1234'); */
  async resolveCommit(prefix: string, signal?: AbortSignal): Promise<string> {
    if (!/^[0-9a-f]{7}$/.test(prefix))
      throw new Error(
        `Invalid canary SHA prefix: ${prefix}; expected seven lowercase hex characters`
      );
    const commit = await this.get(`repos/${this.repository}/commits/${prefix}`, signal);
    if (
      typeof commit.sha !== 'string' ||
      !/^[0-9a-f]{40}$/.test(commit.sha) ||
      !commit.sha.startsWith(prefix)
    ) {
      throw new Error(
        `Invalid resolved canary commit: expected full SHA starting ${prefix}; received ${JSON.stringify(commit.sha)}`
      );
    }
    return commit.sha;
  }

  /** @example const relation = await ancestry.compare(currentSource, selectedSource); */
  async compare(
    base: string,
    head: string,
    signal?: AbortSignal
  ): Promise<'ahead' | 'identical' | 'behind' | 'diverged'> {
    if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) {
      throw new Error(
        `Invalid canary comparison: expected full base/head SHA; received ${base}...${head}`
      );
    }
    const comparison = await this.get(`repos/${this.repository}/compare/${base}...${head}`, signal);
    const baseCommit = record(comparison.base_commit, 'compare base');
    const mergeBase = record(comparison.merge_base_commit, 'compare merge base');
    const status = comparison.status;
    if (
      baseCommit.sha !== base ||
      typeof mergeBase.sha !== 'string' ||
      !/^[0-9a-f]{40}$/.test(mergeBase.sha) ||
      comparison.html_url !== `https://github.com/${this.repository}/compare/${base}...${head}` ||
      !['ahead', 'identical', 'behind', 'diverged'].includes(String(status)) ||
      (status === 'ahead' && mergeBase.sha !== base) ||
      (status === 'identical' && (base !== head || mergeBase.sha !== base))
    ) {
      throw new Error(
        `Unproven canary ancestry ${base}...${head}: expected associated GitHub compare verdict; received ${JSON.stringify(comparison)}`
      );
    }
    return status as 'ahead' | 'identical' | 'behind' | 'diverged';
  }

  private async get(path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.runner.run(['gh', 'api', path], signal);
    if (response.exitCode !== 0)
      throw new Error(
        `GitHub canary ancestry ${path}: expected exit0; received ${response.exitCode}`
      );
    let body: unknown;
    try {
      body = JSON.parse(response.stdout);
    } catch (cause) {
      throw new Error(`GitHub canary ancestry ${path}: expected valid JSON`, { cause });
    }
    return record(body, path);
  }
}

type CliDependencies = Omit<CanaryTagDependencies, 'env'>;

/**
 * Promote the authenticated manifest's canary tags using a frozen source identity.
 * The manifest's original builder provenance must be verified by the calling workflow.
 * @example await runPromoteCanaryTagsCli(['distribution-manifest.json'], process.env);
 */
export async function runPromoteCanaryTagsCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  dependencies?: CliDependencies
): Promise<CanaryTagPromotion | null> {
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'Usage: bun scripts/release/promote-canary-tags.ts [distribution-manifest.json]\nRequires REPO, GitHub Actions OIDC, Node >=22.14.0 and npm trusted publisher Allow npm dist-tag. No legacy token fallback.'
    );
    return null;
  }
  if (args.length > 1 || args[0]?.startsWith('-'))
    throw new Error(
      `Invalid canary tag arguments: ${JSON.stringify(args)}; expected optional manifest path`
    );
  const repository = env.REPO;
  validateRepository(repository);
  const manifest = readDistributionManifest(args[0] ?? 'distribution-manifest.json');
  if (
    (env.SOURCE_SHA !== undefined && env.SOURCE_SHA !== manifest.sourceSha) ||
    (env.VERSION !== undefined && env.VERSION !== manifest.packageVersion)
  ) {
    throw new Error(
      `Canary tag manifest identity mismatch: expected SOURCE_SHA=${env.SOURCE_SHA ?? manifest.sourceSha} VERSION=${env.VERSION ?? manifest.packageVersion}; received source=${manifest.sourceSha} version=${manifest.packageVersion}`
    );
  }
  const oidcEnv = canaryTagEnvironment(env);
  if (dependencies) return promoteCanaryTags(manifest, { ...dependencies, env: oidcEnv });
  const directory = mkdtempSync(join(tmpdir(), 'fix-canary-tag-recovery-'));
  try {
    const runner = new IsolatedCanaryTagRunner(directory, oidcEnv);
    return await promoteCanaryTags(manifest, {
      registry: new HttpCanaryRegistry(),
      runner,
      ancestry: new GitHubCanaryTagAncestry(repository, runner),
      env: oidcEnv,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${label}: expected object; received ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
}

function validateRepository(repository: unknown): asserts repository is string {
  if (
    typeof repository !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error(
      `Invalid REPO: expected owner/repository; received ${JSON.stringify(repository)}`
    );
  }
}

if (import.meta.main) {
  try {
    const result = await runPromoteCanaryTagsCli(process.argv.slice(2), process.env);
    if (result) console.log(JSON.stringify(result, null, 2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}
