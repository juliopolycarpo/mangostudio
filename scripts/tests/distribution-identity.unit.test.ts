import { describe, expect, test } from 'bun:test';

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
