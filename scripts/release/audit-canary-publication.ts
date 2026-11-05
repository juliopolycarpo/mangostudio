#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { CanaryGitHub } from '../lib/canary-github';
import {
  auditCanaryPublication,
  type CanaryPublicationAudit,
  type CanaryPublicationAuditDependencies,
  parseCanaryApprovalOrigin,
} from '../lib/canary-publication-audit';
import type { CanaryReleaseExpectation } from '../lib/canary-release';
import type { CanaryTagRunner } from '../lib/canary-tags';
import { parseDistributionManifest } from '../lib/distribution-manifest';
import type { NpmCommandResult } from '../lib/npm-publish';
import {
  BunCanaryTagProcess,
  type CanaryTagProcess,
  GitHubCanaryTagAncestry,
  HttpCanaryRegistry,
} from './promote-canary-tags';

/** Restrict the shared subprocess adapter to repository-scoped GET ancestry reads. */
export class CanaryAuditReadRunner implements CanaryTagRunner {
  constructor(
    private readonly repository: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly process: CanaryTagProcess = new BunCanaryTagProcess()
  ) {
    validateRepository(repository);
  }

  /** @example await runner.run(['gh', 'api', 'repos/owner/repo/commits/abcdef0']); */
  run(command: readonly string[]): Promise<NpmCommandResult> {
    const path = command[2];
    const prefix = `repos/${this.repository}/`;
    if (
      command.length !== 3 ||
      command[0] !== 'gh' ||
      command[1] !== 'api' ||
      typeof path !== 'string' ||
      !path.startsWith(prefix) ||
      !(
        path.slice(prefix.length).startsWith('commits/') ||
        path.slice(prefix.length).startsWith('compare/')
      ) ||
      /[\r\n?#\\]/.test(path) ||
      path.split('/').some((part) => part === '.' || part === '..')
    ) {
      throw new Error(
        'Invalid canary audit command: expected repository-scoped GitHub commit/compare GET'
      );
    }
    return this.process.run(command, { cwd: globalThis.process.cwd(), env: this.env });
  }
}

/**
 * Write a fresh read-only publication audit from authenticated expected inputs.
 * Optional input SHA256 values pin same-run evidence without changing provenance.
 * @example await runAuditCanaryPublicationCli(['manifest.json', 'expected.json', 'audit.json'], process.env);
 */
export async function runAuditCanaryPublicationCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  dependencies?: CanaryPublicationAuditDependencies
): Promise<CanaryPublicationAudit | null> {
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'Usage: bun scripts/release/audit-canary-publication.ts [manifest.json] [expected-release.json] [audit.json]\nReads public registry/GitHub state without OIDC or publication mutations. REPO is required; input builder provenance must already be verified.'
    );
    return null;
  }
  if (args.length > 3 || args.some((arg) => arg.startsWith('-')))
    throw new Error(
      `Invalid audit arguments: ${JSON.stringify(args)}; expected optional manifest, expected-release and output paths`
    );
  const repository = env.REPO;
  validateRepository(repository);
  const approvalOrigin = parseCanaryApprovalOrigin(env.APPROVAL_ORIGIN);
  const manifestPath = resolve(args[0] ?? 'distribution-manifest.json');
  const expectedPath = resolve(args[1] ?? env.EXPECTED_RELEASE ?? 'expected-release.json');
  const outputPath = resolve(args[2] ?? env.PUBLICATION_AUDIT ?? 'canary-publication-audit.json');
  if (outputPath === manifestPath || outputPath === expectedPath)
    throw new Error(
      'Invalid audit output: expected path distinct from authenticated manifest and release plan'
    );
  const manifestRaw = readPinnedInput(manifestPath, env.EXPECTED_MANIFEST_SHA256);
  const expectedRaw = readPinnedInput(expectedPath, env.EXPECTED_RELEASE_SHA256);
  const manifest = parseDistributionManifest(manifestRaw);
  const expected: unknown = JSON.parse(expectedRaw);
  if (
    !expected ||
    typeof expected !== 'object' ||
    Array.isArray(expected) ||
    !('repository' in expected) ||
    expected.repository !== repository
  ) {
    throw new Error(
      `Invalid expected release audit plan: expected object for repository ${repository}`
    );
  }
  if (
    (env.SOURCE_SHA !== undefined && env.SOURCE_SHA !== manifest.sourceSha) ||
    (env.VERSION !== undefined && env.VERSION !== manifest.packageVersion)
  ) {
    throw new Error(
      `Canary audit source mismatch: expected SOURCE_SHA=${env.SOURCE_SHA ?? manifest.sourceSha} VERSION=${env.VERSION ?? manifest.packageVersion}; received ${manifest.sourceSha}@${manifest.packageVersion}`
    );
  }
  const boundaries = dependencies ?? {
    registry: new HttpCanaryRegistry(),
    github: new CanaryGitHub(repository),
    ancestry: new GitHubCanaryTagAncestry(repository, new CanaryAuditReadRunner(repository, env)),
  };
  const audit = await auditCanaryPublication(
    manifest,
    expected as CanaryReleaseExpectation,
    boundaries,
    approvalOrigin
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(audit, null, 2)}\n`);
  if (env.GITHUB_OUTPUT) {
    // Only fixed decision labels and booleans cross the shell output boundary.
    appendFileSync(
      env.GITHUB_OUTPUT,
      [
        `npm_needed=${audit.needed.npm}`,
        `packages_needed=${audit.needed.packages.length > 0}`,
        `tags_needed=${audit.needed.tags.length > 0}`,
        `github_needed=${audit.needed.github}`,
        `reason=${audit.reason}`,
        '',
      ].join('\n')
    );
  }
  return audit;
}

function readPinnedInput(path: string, expectedHash: string | undefined): string {
  const bytes = readFileSync(path);
  if (expectedHash !== undefined) {
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (!/^[0-9a-f]{64}$/.test(expectedHash) || actual !== expectedHash) {
      throw new Error(
        `Canary audit input ${path}: expected SHA256 ${expectedHash}; received ${actual}`
      );
    }
  }
  return bytes.toString('utf8');
}

function validateRepository(repository: unknown): asserts repository is string {
  if (
    typeof repository !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error(
      `Invalid canary audit REPO: expected owner/repository; received ${JSON.stringify(repository)}`
    );
  }
}

if (import.meta.main) {
  try {
    const audit = await runAuditCanaryPublicationCli(process.argv.slice(2), process.env);
    if (audit) console.log(JSON.stringify(audit, null, 2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}
