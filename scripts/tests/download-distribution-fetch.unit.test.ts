import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

import { ARCHIVE_TIMEOUT_MS, DOWNLOAD_ATTEMPTS, METADATA_TIMEOUT_MS } from '../lib/run-artifact';

// actions/download-artifact stayed alive for a whole step deadline after it
// finished (#1735). Same-run distribution artifacts are fetched by a script
// that owns the bound and one retry. These tests pin that wiring so a new
// workflow cannot quietly bring the Node action back.

interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly with?: Record<string, string>;
  readonly env?: Record<string, string>;
  readonly run?: string;
}
interface Job {
  readonly uses?: string;
  readonly permissions?: Record<string, string> | string;
  readonly steps?: readonly Step[];
}
interface Workflow {
  readonly permissions?: Record<string, string> | string;
  readonly jobs?: Record<string, Job>;
}
interface Composite {
  readonly runs?: { readonly steps?: readonly Step[] };
}

const readYaml = <T>(path: string): T => Bun.YAML.parse(readFileSync(path, 'utf8')) as T;
const workflowFiles = readdirSync('.github/workflows')
  .filter((file) => file.endsWith('.yml'))
  .map((file) => `.github/workflows/${file}`);
const compositeFiles = readdirSync('.github/actions').map(
  (directory) => `.github/actions/${directory}/action.yml`
);

const isDirectDownloadArtifact = (step: Step): boolean =>
  step.uses?.startsWith('actions/download-artifact@') === true;
const usesFetchComposite = (step: Step): boolean =>
  /\.github\/actions\/download-(distribution|run-artifact)$/.test(step.uses ?? '');

// distribution-build.yml downloads hub-inputs on musl legs that never install
// Bun, which the script needs; those two steps stay on the Node action.
const DIRECT_DOWNLOAD_EXCEPTIONS = ['.github/workflows/distribution-build.yml'];

// A literal distribution or hub-inputs name, or an expression that resolves to
// one of the content-addressed artifact names the build workflow publishes.
const LITERAL_ARTIFACT_NAME = /^(?:hub-inputs|distribution)-/;
const EXPRESSION_ARTIFACT_NAME =
  /artifact_name|target_artifacts|(?:linux|windows|assets|npm|checksums)_artifact/;
const isDistributionArtifactName = (name: string): boolean =>
  LITERAL_ARTIFACT_NAME.test(name) || EXPRESSION_ARTIFACT_NAME.test(name);

describe('same-run distribution fetch', () => {
  test('the composite fetches through the bounded script, not the Node action', () => {
    const steps =
      readYaml<Composite>('.github/actions/download-distribution/action.yml').runs?.steps ?? [];
    expect(
      steps.filter(isDirectDownloadArtifact),
      'download-distribution Node action steps'
    ).toEqual([]);
    const fetch = steps.find((step) => step.run?.includes('download-run-artifact.ts'));
    expect(fetch?.run, 'download-distribution same-run fetch step').toBe(
      'bun --no-install ./scripts/ci/download-run-artifact.ts'
    );
    expect(fetch?.env?.EXTRACT_MODE).toBe('bundle');
    // gh reads its token from the environment; without it the fetch is anonymous.
    expect(fetch?.env?.GH_TOKEN).toBe('$' + '{{ github.token }}');
  });

  test('no workflow or composite downloads a distribution or hub-inputs artifact with the Node action', () => {
    const offenders: string[] = [];
    for (const file of [...workflowFiles, ...compositeFiles]) {
      if (DIRECT_DOWNLOAD_EXCEPTIONS.includes(file)) continue;
      const parsed = readYaml<Workflow & Composite>(file);
      const steps = [
        ...Object.values(parsed.jobs ?? {}).flatMap((job) => job.steps ?? []),
        ...(parsed.runs?.steps ?? []),
      ];
      for (const step of steps.filter(isDirectDownloadArtifact)) {
        const name = step.with?.name ?? '';
        if (isDistributionArtifactName(name)) {
          offenders.push(`${file} step "${step.name ?? name}" downloads ${name}`);
        }
      }
    }
    expect(offenders, 'direct actions/download-artifact steps for distribution inputs').toEqual([]);
  });

  test('the bounds keep one try plus one retry inside the 3-minute step deadline', () => {
    expect([METADATA_TIMEOUT_MS, ARCHIVE_TIMEOUT_MS, DOWNLOAD_ATTEMPTS]).toEqual([
      15_000, 70_000, 2,
    ]);
    expect(DOWNLOAD_ATTEMPTS * (METADATA_TIMEOUT_MS + ARCHIVE_TIMEOUT_MS)).toBeLessThanOrEqual(
      180_000
    );
  });

  test('every job that fetches with gh can read Actions', () => {
    // gh api .../artifacts needs actions: read; without it the fetch is a 403.
    const fetchingWorkflows = new Set<string>();
    const problems: string[] = [];
    const grantsActions = (permissions: Job['permissions']): boolean =>
      typeof permissions === 'object' && ['read', 'write'].includes(permissions.actions ?? '');
    for (const file of workflowFiles) {
      const workflow = readYaml<Workflow>(file);
      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        if (!(job.steps ?? []).some(usesFetchComposite)) continue;
        fetchingWorkflows.add(file.replace('.github/workflows/', ''));
        if (!grantsActions(job.permissions ?? workflow.permissions)) {
          problems.push(
            `${file} job ${jobName}: expected permissions.actions: read | received none`
          );
        }
      }
    }
    // A reusable workflow cannot exceed its caller, so the caller job grants it too.
    for (const file of workflowFiles) {
      for (const [jobName, job] of Object.entries(readYaml<Workflow>(file).jobs ?? {})) {
        const called = job.uses?.replace(/^.*\.github\/workflows\//, '');
        if (called && fetchingWorkflows.has(called) && !grantsActions(job.permissions)) {
          problems.push(
            `${file} job ${jobName}: expected permissions.actions: read for ${called} | received none`
          );
        }
      }
    }
    expect(problems).toEqual([]);
    expect([...fetchingWorkflows].sort()).toEqual([
      'canary.yml',
      'release-dry-run.yml',
      'release.yml',
      'smoke-binary.yml',
      'smoke-container.yml',
    ]);
  });
});
