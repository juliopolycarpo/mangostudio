import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';
import { extractJobBlock, extractJobBlocks, extractStepBlocks } from './support/workflow-blocks';

const EXPR = '$' + '{{';

function run(event: string, overrides: Record<string, string> = {}): string {
  const result = Bun.spawnSync({
    cmd: ['bun', './scripts/ci/distribution-identity.ts'],
    env: {
      ...process.env,
      EVENT_NAME: event,
      SOURCE_SHA: '0123456789abcdef',
      ...overrides,
    },
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

describe('distribution CI identity', () => {
  test('uses the exact canary version for main pushes', () => {
    expect(run('push')).toContain('version=0.1.1-canary.g0123456\nchannel=canary');
  });

  test('uses deterministic PR and manual versions', () => {
    expect(run('pull_request', { PR_NUMBER: '42' })).toContain(
      'version=0.1.1-pr.42.g0123456\nchannel=pr'
    );
    expect(run('workflow_dispatch')).toContain('version=0.1.1-ci.g0123456\nchannel=ci');
  });
});

describe('Preflight job owns the distribution identity', () => {
  const ci = readText('.github/workflows/ci.yml');
  const preflight = extractJobBlock(ci, 'changes');

  test('no separate identity job remains', () => {
    const jobs = extractJobBlocks(ci).map(({ job }) => job);
    expect(jobs, 'expected no job named distribution-identity').not.toContain(
      'distribution-identity'
    );
    expect(ci).not.toContain('needs.distribution-identity');
    expect(ci).not.toContain("needs['distribution-identity']");
  });

  test('exposes version, channel, cargo_version and the checked out source SHA', () => {
    for (const output of ['version', 'channel', 'cargo_version']) {
      expect(preflight, `expected output ${output} from steps.identity`).toContain(
        `      ${output}: ${EXPR} steps.identity.outputs.${output} }}`
      );
    }
    expect(preflight).toContain(`      source_sha: ${EXPR} steps.source.outputs.sha }}`);
  });

  test('resolves the SHA from HEAD and feeds it to the identity script', () => {
    const steps = extractStepBlocks(preflight);
    const source = steps.findIndex((step) => step.includes('id: source'));
    const identity = steps.findIndex((step) => step.includes('id: identity'));
    expect(source, 'expected a source step').toBeGreaterThanOrEqual(0);
    expect(identity, 'expected the identity step after the source step').toBeGreaterThan(source);
    expect(steps[source]).toContain('git rev-parse HEAD');
    expect(steps[identity]).toContain(`SOURCE_SHA: ${EXPR} steps.source.outputs.sha }}`);
    expect(steps[identity]).toContain('bun ./scripts/ci/distribution-identity.ts');
    // Full history moves no ref: HEAD stays the merge or pushed commit.
    expect(preflight).toContain('fetch-depth: 0');
  });

  test('is named for both duties and every consumer reads identity from it', () => {
    expect(/^ {4}name: (.+)$/m.exec(preflight)?.[1]).toBe('Preflight');
    for (const job of ['distribution', 'release-dry-run', 'smoke', 'smoke-container', 'build']) {
      expect(extractJobBlock(ci, job), `${job} must read needs.changes`).toContain(
        `${EXPR} needs.changes.outputs.source_sha }}`
      );
    }
  });
});
