import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  type ApprovedArtifact,
  type ArtifactEvidence,
  distributionBundleMember,
  validateArtifactEvidence,
} from '../lib/distribution-artifact';

const approval: ApprovedArtifact = {
  repository: 'owner/repo',
  sourceSha: 'a'.repeat(40),
  runId: 42,
  runAttempt: 2,
  producerAttempt: 1,
  artifactId: 99,
  artifactName: 'distribution-npm-identity',
  digest: `sha256:${'b'.repeat(64)}`,
};
function evidence(): ArtifactEvidence {
  return {
    run: {
      id: 42,
      run_attempt: 2,
      path: '.github/workflows/ci.yml',
      event: 'push',
      head_branch: 'main',
      head_sha: approval.sourceSha,
      status: 'completed',
      conclusion: 'success',
      repository: { id: 5, full_name: 'owner/repo' },
      head_repository: { id: 5, full_name: 'owner/repo' },
    },
    artifact: {
      id: 99,
      name: approval.artifactName,
      digest: approval.digest,
      expired: false,
      created_at: '2026-11-04T10:05:00Z',
      workflow_run: {
        id: 42,
        repository_id: 5,
        head_repository_id: 5,
        head_sha: approval.sourceSha,
        head_branch: 'main',
      },
    },
    jobs: [
      {
        name: 'Distribution / Build immutable distribution',
        run_id: 42,
        run_attempt: 1,
        conclusion: 'success',
        started_at: '2026-11-04T10:00:00Z',
        completed_at: '2026-11-04T10:10:00Z',
      },
    ],
  };
}

describe('approved distribution artifact', () => {
  test.each([undefined, null, 0, -1, 1.5, '5', Number.MAX_SAFE_INTEGER + 1])(
    'rejects jointly invalid repository IDs %s instead of comparing missing values as equal',
    (value) => {
      const current = evidence();
      const malformed: ArtifactEvidence = JSON.parse(
        JSON.stringify({
          ...current,
          run: {
            ...current.run,
            repository: { ...current.run.repository, id: value },
            head_repository: { ...current.run.head_repository, id: value },
          },
          artifact: {
            ...current.artifact,
            workflow_run: {
              ...current.artifact.workflow_run,
              repository_id: value,
              head_repository_id: value,
            },
          },
        })
      );
      expect(() => validateArtifactEvidence(approval, malformed)).toThrow('positive safe integer');
    }
  );
  test('rejects a head repository name inconsistent with the approved repository', () => {
    const current = evidence();
    const malformed: ArtifactEvidence = JSON.parse(
      JSON.stringify({
        ...current,
        run: {
          ...current.run,
          head_repository: { ...current.run.head_repository, full_name: 'attacker/repo' },
        },
      })
    );
    expect(() => validateArtifactEvidence(approval, malformed)).toThrow(
      'expected owner/repo | received attacker/repo'
    );
  });
  test('accepts explicitly proven earlier successful producing attempts', () => {
    expect(() => validateArtifactEvidence(approval, evidence())).not.toThrow();
  });
  test.each(['runId', 'runAttempt', 'producerAttempt', 'artifactId'] as const)(
    'rejects invalid %s',
    (field) => {
      expect(() => validateArtifactEvidence({ ...approval, [field]: 0 }, evidence())).toThrow(
        'positive safe integer'
      );
    }
  );
  test.each([
    ['sourceSha', 'short', 'full lowercase SHA'],
    ['digest', 'sha256:bad', '64 lowercase hex'],
    ['producerAttempt', 3, '<= 2'],
  ] as const)('rejects invalid approval %s', (field, value, reason) => {
    expect(() => validateArtifactEvidence({ ...approval, [field]: value }, evidence())).toThrow(
      reason
    );
  });
  test.each([
    ['id', 43],
    ['run_attempt', 3],
    ['path', '.github/workflows/release.yml'],
    ['event', 'pull_request'],
    ['head_branch', 'feature'],
    ['head_sha', 'c'.repeat(40)],
    ['status', 'in_progress'],
    ['conclusion', 'failure'],
    ['repository', { id: 5, full_name: 'attacker/repo' }],
    ['head_repository', { id: 6 }],
  ])('rejects run mismatch %s', (field, value) => {
    const current = evidence();
    expect(() =>
      validateArtifactEvidence(approval, {
        ...current,
        run: { ...current.run, [field as string]: value },
      })
    ).toThrow('Distribution');
  });
  test.each([
    ['id', 100],
    ['name', 'light'],
    ['digest', `sha256:${'c'.repeat(64)}`],
    ['expired', true],
    ['created_at', '2026-11-04T10:20:00Z'],
  ])('rejects artifact mismatch %s', (field, value) => {
    const current = evidence();
    expect(() =>
      validateArtifactEvidence(approval, {
        ...current,
        artifact: { ...current.artifact, [field as string]: value },
      })
    ).toThrow('Distribution');
  });
  test.each(['id', 'repository_id', 'head_repository_id', 'head_sha', 'head_branch'])(
    'rejects artifact run mismatch %s',
    (field) => {
      const current = evidence();
      expect(() =>
        validateArtifactEvidence(approval, {
          ...current,
          artifact: {
            ...current.artifact,
            workflow_run: { ...current.artifact.workflow_run, [field]: 'wrong' },
          },
        })
      ).toThrow('Distribution');
    }
  );
  test('rejects failed, absent, ambiguous and wrong-attempt producer evidence', () => {
    const current = evidence();
    const job = current.jobs[0];
    if (!job) throw new Error('Expected producer job fixture');
    for (const jobs of [
      [],
      [job, job],
      [{ ...job, conclusion: 'failure' }],
      [{ ...job, run_attempt: 2 }],
    ]) {
      expect(() => validateArtifactEvidence(approval, { ...current, jobs })).toThrow(
        'successful producing jobs'
      );
    }
  });
  test.each([
    '2026-02-31T00:00:00Z',
    '2026-11-04',
    '2026-11-04T10:05:00+00:00',
    '2026-11-04T10:05:00.000000Z',
  ])('rejects noncanonical artifact time %j before correlating its producer', (value) => {
    const current = evidence();
    const parsed = Date.parse(value);
    expect(Number.isFinite(parsed)).toBe(true);
    const job = current.jobs[0];
    if (!job) throw new Error('Expected producer timestamp fixture');
    const aligned = {
      ...current,
      artifact: { ...current.artifact, created_at: new Date(parsed).toISOString() },
      jobs: [
        {
          ...job,
          started_at: new Date(parsed - 60_000).toISOString(),
          completed_at: new Date(parsed + 60_000).toISOString(),
        },
      ],
    };
    expect(() => validateArtifactEvidence(approval, aligned)).not.toThrow();
    expect(() =>
      validateArtifactEvidence(approval, {
        ...aligned,
        artifact: { ...aligned.artifact, created_at: value },
      })
    ).toThrow('Distribution artifact created_at: expected UTC ISO timestamp');
  });
  for (const field of ['started_at', 'completed_at'] as const) {
    test.each([
      '2026-02-31T00:00:00Z',
      '2026-11-04',
      '2026-11-04T10:05:00+00:00',
      '2026-11-04T10:05:00.000000Z',
    ])(`rejects noncanonical producer ${field}=%j before correlation`, (value) => {
      const current = evidence();
      const parsed = Date.parse(value);
      expect(Number.isFinite(parsed)).toBe(true);
      const job = current.jobs[0];
      if (!job) throw new Error('Expected producer timestamp fixture');
      const started = field === 'started_at' ? parsed : parsed - 60_000;
      const completed = field === 'completed_at' ? parsed : parsed + 60_000;
      const aligned = {
        ...current,
        artifact: {
          ...current.artifact,
          created_at: new Date((started + completed) / 2).toISOString(),
        },
        jobs: [
          {
            ...job,
            started_at: new Date(started).toISOString(),
            completed_at: new Date(completed).toISOString(),
          },
        ],
      };
      expect(() => validateArtifactEvidence(approval, aligned)).not.toThrow();
      expect(() =>
        validateArtifactEvidence(approval, {
          ...aligned,
          jobs: [
            {
              ...job,
              started_at: new Date(started).toISOString(),
              completed_at: new Date(completed).toISOString(),
              [field]: value,
            },
          ],
        })
      ).toThrow(`Distribution producer ${field}: expected UTC ISO timestamp`);
    });
  }
  test('keeps unrelated job timestamps outside the approved producer boundary', () => {
    const current = evidence();
    const job = current.jobs[0];
    if (!job) throw new Error('Expected producer fixture');
    expect(() =>
      validateArtifactEvidence(approval, {
        ...current,
        jobs: [
          ...current.jobs,
          {
            ...job,
            run_attempt: 3,
            started_at: 'not a timestamp',
            completed_at: 'not a timestamp',
          },
        ],
      })
    ).not.toThrow();
  });
  test('accepts only one flat bundle member', () => {
    expect(distributionBundleMember('npm.tar.gz\n')).toBe('npm.tar.gz');
    expect(distributionBundleMember('linux-x64.tar\n')).toBe('linux-x64.tar');
    for (const listing of ['', '../npm.tar.gz', '/npm.tar', 'a.tar\nb.tar', 'npm.zip', '-x.tar']) {
      expect(() => distributionBundleMember(listing)).toThrow('expected one flat');
    }
  });
  test('cross-run action downloads verified bytes and binds provenance to source', () => {
    const action = readFileSync('.github/actions/download-distribution/action.yml', 'utf8');
    expect(action).toContain('download-approved-distribution.ts');
    expect(action).toContain('source_args+=(--source-digest "$SOURCE_SHA")');
  });
});

describe('cross-run artifact download CLI', () => {
  test('extracts the verified ZIP and refuses corrupted bytes before extraction', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fix-canary-artifact-download-'));
    try {
      const current = evidence();
      writeFileSync(join(directory, 'run.json'), JSON.stringify(current.run));
      writeFileSync(join(directory, 'jobs.json'), JSON.stringify([{ jobs: current.jobs }]));
      writeFileSync(join(directory, 'npm.tar.gz'), 'approved bundle bytes');
      const zip = Bun.spawnSync(['zip', '-q', 'artifact.zip', 'npm.tar.gz'], { cwd: directory });
      expect(zip.exitCode).toBe(0);
      const digest = `sha256:${createHash('sha256')
        .update(readFileSync(join(directory, 'artifact.zip')))
        .digest('hex')}`;
      writeFileSync(
        join(directory, 'artifact.json'),
        JSON.stringify({ ...current.artifact, digest })
      );
      copyFileSync('scripts/tests/fixtures/approved-artifact/gh.fixture', join(directory, 'gh'));
      chmodSync(join(directory, 'gh'), 0o755);
      const env = {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        APPROVED_ARTIFACT_FIXTURE: directory,
        GITHUB_REPOSITORY: approval.repository,
        SOURCE_SHA: approval.sourceSha,
        APPROVED_RUN_ID: '42',
        APPROVED_RUN_ATTEMPT: '2',
        PRODUCER_ATTEMPT: '1',
        ARTIFACT_ID: '99',
        ARTIFACT_NAME: approval.artifactName,
        ARTIFACT_DIGEST: digest,
        RUNTIME_PROFILE: 'shipping',
        VERIFY_ATTESTATION: 'true',
        DOWNLOAD_DIR: join(directory, 'valid'),
        GITHUB_STEP_SUMMARY: join(directory, 'summary'),
      };
      const valid = Bun.spawn(['bun', resolve('scripts/ci/download-approved-distribution.ts')], {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await valid.exited).toBe(0);
      expect(readFileSync(join(directory, 'valid/npm.tar.gz'), 'utf8')).toBe(
        'approved bundle bytes'
      );
      expect(readFileSync(join(directory, 'summary'), 'utf8')).toContain('producer attempt 1');
      writeFileSync(join(directory, 'npm.tar.gz'), 'different unapproved bundle bytes');
      const replacementZip = Bun.spawnSync(['zip', '-q', '-FS', 'artifact.zip', 'npm.tar.gz'], {
        cwd: directory,
      });
      expect(replacementZip.exitCode).toBe(0);
      const corrupt = Bun.spawn(['bun', resolve('scripts/ci/download-approved-distribution.ts')], {
        env: { ...env, DOWNLOAD_DIR: join(directory, 'invalid') },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await corrupt.exited).toBe(1);
      expect(await new Response(corrupt.stderr).text()).toContain(`ZIP digest: expected ${digest}`);
      expect(await Bun.file(join(directory, 'invalid/npm.tar.gz')).exists()).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

test.each(['npm.tar.gz\n \n', ' \nnpm.tar.gz\n', 'npm.tar.gz \n', 'npm.tar.gz\n\n'])(
  'rejects whitespace members or whitespace in bundle name %j',
  (listing) => {
    expect(() => distributionBundleMember(listing)).toThrow('expected one flat');
  }
);
