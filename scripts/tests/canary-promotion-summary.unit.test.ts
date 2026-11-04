import { expect, test } from 'bun:test';

import { renderCanaryPromotionSummary } from '../lib/canary-promotion-summary';

const revision = 'a'.repeat(40);
const url = 'https://github.com/owner/repository/actions/runs/123';
function needs(npm = 'failure', github = 'cancelled', approval = 'success') {
  return {
    source: {
      result: 'success',
      outputs: {
        version: '1.0.0-canary.aaaaaaa',
        source_sha: revision,
        run_id: '12',
        run_attempt: '2',
      },
    },
    approve: {
      result: approval,
      outputs: {
        npm_needed: 'true',
        github_needed: 'false',
        reason: 'recover missing npm versions',
        approval_sha256: 'b'.repeat(64),
      },
    },
    'npm-canary': { result: npm },
    'github-release-canary': { result: github },
  };
}
test('a failed or cancelled publisher reports possible partial external state', () => {
  const summary = renderCanaryPromotionSummary(needs(), revision, url);
  expect(summary).toContain('failure');
  expect(summary).toContain('cancelled');
  expect(summary).toContain('External state may be partial or changed');
  expect(summary).toContain('do not roll back writes');
  expect(summary).toContain('"run_attempt": "2"');
  expect(summary).toContain('"approval_sha256"');
  expect(summary).toContain('"channels"');
});
test('only a successful verified preflight explains a skipped channel as complete', () => {
  expect(renderCanaryPromotionSummary(needs('success', 'skipped'), revision, url)).toContain(
    'preflight verified this channel complete'
  );
  expect(
    renderCanaryPromotionSummary(needs('skipped', 'skipped', 'failure'), revision, url)
  ).not.toContain('preflight verified this channel complete');
});
test('missing or malformed workflow evidence fails with its expected shape', () => {
  expect(() => renderCanaryPromotionSummary(null, revision, url)).toThrow(
    'canary needs: expected object'
  );
  expect(() => renderCanaryPromotionSummary(needs(), 'main', url)).toThrow(
    'main: expected full SHA'
  );
  expect(() => renderCanaryPromotionSummary(needs(), revision, 'file:///tmp/run')).toThrow(
    'expected GitHub Actions run URL'
  );
  expect(() => renderCanaryPromotionSummary(needs('unknown'), revision, url)).toThrow(
    'unknown: expected workflow job conclusion'
  );
});
test('oversized evidence is rejected and Markdown fences cannot terminate the JSON block', () => {
  const value = needs();
  value.approve.outputs.reason = '```';
  expect(renderCanaryPromotionSummary(value, revision, url)).toContain('\\u0060\\u0060\\u0060');
  value.approve.outputs.reason = 'x'.repeat(100_001);
  expect(() => renderCanaryPromotionSummary(value, revision, url)).toThrow(
    'expected at most 100000 characters'
  );
});
