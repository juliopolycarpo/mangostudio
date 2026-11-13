import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';
import { extractJobBlock, extractStepBlocks } from './support/workflow-blocks';

describe('canonical production frontend handoff', () => {
  test('existing Build owns the producer without adding a frontend setup job', () => {
    const ci = readText('.github/workflows/ci.yml');
    expect(extractJobBlock(ci, 'frontend')).toBe('');
    const producer = extractJobBlock(ci, 'build');
    expect(producer).toContain('uses: $/.github/workflows/build.yml');
    expect(producer).toContain(`source_sha: ${'$'}{{ needs.changes.outputs.source_sha }}`);
    for (const name of ['distribution', 'browser-smoke', 'qa-metrics']) {
      const consumer = extractJobBlock(ci, name);
      expect(consumer, name).toContain(
        name === 'qa-metrics'
          ? `frontend_artifact: ${'$'}{{ needs.build.result == 'success' && needs.build.outputs.artifact || '' }}`
          : `frontend_artifact: ${'$'}{{ needs.build.outputs.artifact }}`
      );
      expect(consumer, name).toContain(
        name === 'qa-metrics'
          ? `frontend_bun_revision: ${'$'}{{ needs.build.result == 'success' && needs.build.outputs.bun_revision || '' }}`
          : `frontend_bun_revision: ${'$'}{{ needs.build.outputs.bun_revision }}`
      );
      const parsed = Bun.YAML.parse(ci) as { jobs: Record<string, { needs: string[] }> };
      expect(parsed.jobs[name]?.needs, name).toContain('build');
    }
  });

  test('producer clears before cache replay and uploads exact output before the API build', () => {
    const source = readText('.github/workflows/build.yml');
    const job = extractJobBlock(source, 'build');
    const steps = extractStepBlocks(job);
    const build = steps.find((step) => step.includes('name: Build clean production frontend'));
    expect(build, 'existing Build must produce frontend output').toBeDefined();
    expect(build?.indexOf('frontend-artifact.ts clean')).toBeLessThan(
      build?.indexOf('bun run build --frontend') ?? 0
    );
    expect(build?.indexOf('bun run build --frontend')).toBeLessThan(
      build?.indexOf('frontend-artifact.ts record') ?? 0
    );
    expect(job.indexOf('uses: actions/upload-artifact@')).toBeLessThan(
      job.indexOf('name: Build API ESM bundle')
    );
    expect(job).toContain(`ref: ${'$'}{{ inputs.source_sha }}`);
    for (const path of [
      'apps/frontend/dist',
      'apps/frontend/dist-metafile.json',
      '.mango/frontend-artifact.json',
    ])
      expect(job).toContain(path);
    expect(job).toContain('include-hidden-files: true');
    expect(job).toContain('overwrite: false');
    expect(source).toContain(`value: ${'$'}{{ jobs.build.outputs.artifact }}`);
    expect(source).toContain(`value: ${'$'}{{ jobs.build.outputs.bun_revision }}`);
    expect(job).not.toContain('run: bun run build --all');
  });

  test('API failure blocks consumers while QA retains its failure metrics route', () => {
    const ci = readText('.github/workflows/ci.yml');
    for (const name of ['distribution', 'browser-smoke']) {
      // No status function overrides the implicit success() dependency guard.
      expect(extractJobBlock(ci, name)).not.toMatch(/if:.*(?:always|cancelled|failure|success)\(/);
    }
    const qa = extractJobBlock(ci, 'qa-metrics');
    expect(qa).toContain('!cancelled()');
    expect(qa).toContain('needs.check.outputs.invocation_id');
    const workflow = readText('.github/workflows/qa-metrics.yml');
    expect(workflow).toContain('QA_FRONTEND_DIST:');
    expect(workflow).toContain('./frontend-dist');
    // Missing outputs select a missing artifact directory, never a local build.
    expect(workflow).not.toContain('bun run build');
  });

  test('distribution verifies exact source, Bun, environment and bytes on every compiler host', () => {
    const workflow = readText('.github/workflows/distribution-build.yml');
    const prepare = extractJobBlock(workflow, 'prepare');
    const hub = extractJobBlock(workflow, 'hub');
    const packaging = extractJobBlock(workflow, 'build');
    expect(
      extractStepBlocks(prepare).find((step) => step.includes('run: bun run build --frontend'))
    ).toContain("if: inputs.frontend_artifact == ''");
    expect(prepare).toContain('uses: ./.github/actions/download-frontend');
    expect(hub).toContain('name: Verify shared frontend before native compilation');
    const alpine = extractStepBlocks(hub).find((step) =>
      step.includes('name: Build native musl hub in Alpine')
    );
    expect(alpine).toContain(`FRONTEND_ARTIFACT: ${'$'}{{ inputs.frontend_artifact }}`);
    expect(alpine?.indexOf('frontend-artifact.ts verify')).toBeLessThan(
      alpine?.indexOf('bun run build --binary') ?? 0
    );
    expect(packaging).toContain('name: Verify shared frontend before packaging');
  });

  test('QA withholds invalid handoffs and the adapter clears output before download', () => {
    const qa = readText('.github/workflows/qa-metrics.yml');
    expect(
      qa.indexOf('name: Download verified canonical frontend'),
      'verify clean source before untracked QA input directories are downloaded'
    ).toBeLessThan(qa.indexOf('name: Download test metrics fragment'));
    expect(qa.indexOf('name: Download verified canonical frontend')).toBeLessThan(
      qa.indexOf('name: Download canonical Check evidence')
    );
    expect(qa).toContain(
      "steps.frontend.outcome == 'success' && './apps/frontend/dist' || './frontend-unavailable'"
    );
    const action = readText('.github/actions/download-frontend/action.yml');
    expect(action.indexOf('frontend-artifact.ts clean')).toBeLessThan(
      action.indexOf('uses: actions/download-artifact@')
    );
    expect(action.indexOf('uses: actions/download-artifact@')).toBeLessThan(
      action.indexOf('frontend-artifact.ts verify')
    );
  });
});
