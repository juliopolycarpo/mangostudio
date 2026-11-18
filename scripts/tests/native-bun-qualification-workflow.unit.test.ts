import { describe, expect, it } from 'bun:test';

import { readText } from './support/read-text';
import { uncoveredScriptImports, workflowPathFilters } from './support/workflow-path-filters';

// The qualification workflow runs on a pull request only when a changed file
// matches its `paths:` filter. The qualification entry script loads parser and
// output modules beyond its own `native-bun-qualification*.ts` family; a change
// to one of those can alter what the lane counts as a failure, so the filter
// has to name every module the entry imports, transitively.

const WORKFLOW_PATH = '.github/workflows/native-bun-qualification.yml';
const QUALIFICATION_ENTRY_SCRIPTS = ['scripts/ci/native-bun-qualification.ts'] as const;

describe('native Bun qualification workflow path filters', () => {
  const pullRequestPaths = workflowPathFilters(readText(WORKFLOW_PATH), 'pull_request');

  it('declares a pull_request paths list', () => {
    expect(pullRequestPaths, `${WORKFLOW_PATH}: pull_request paths`).toContain(WORKFLOW_PATH);
  });

  it('lists the scheduled-run helper the workflow executes and its native-watch modules', () => {
    expect(pullRequestPaths, `${WORKFLOW_PATH}: pull_request paths`).toEqual(
      expect.arrayContaining(['scripts/ci/native-platform-watch.ts', 'scripts/ci/native-watch/**'])
    );
  });

  it('covers every scripts/ module the qualification entry scripts import', () => {
    const uncovered = uncoveredScriptImports(QUALIFICATION_ENTRY_SCRIPTS, pullRequestPaths);

    expect(
      uncovered,
      `(${WORKFLOW_PATH} pull_request paths): ${uncovered.join(', ')} imported by ${QUALIFICATION_ENTRY_SCRIPTS.join(', ')} but matched by no filter | expected: every imported scripts/ module listed`
    ).toEqual([]);
  });
});
