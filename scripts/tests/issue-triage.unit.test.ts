import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';
import { extractJobBlock, extractOnBlock, sectionKeys } from './support/workflow-blocks';

const EXPR = '$' + '{{';

describe('issue triage workflow', () => {
  const workflow = readText('.github/workflows/issue-triage.yml');

  test('triggers only on issue open and label changes', () => {
    const onBlock = extractOnBlock(workflow);

    expect(sectionKeys(onBlock)).toEqual(['issues']);
    expect(onBlock).toContain('types: [opened, labeled, unlabeled]');
    expect(onBlock).not.toContain('pull_request');
  });

  test('uses minimal permissions and plain gh without checkout', () => {
    expect(workflow).toContain('permissions: {}');
    expect(workflow).toContain('issues: write');
    expect(workflow).not.toContain('pull-requests: write');
    expect(workflow).not.toContain('contents: write');
    expect(workflow).not.toContain('actions/checkout');
    expect(workflow).not.toContain('actions/github-script');
    expect(workflow).toContain(`GH_TOKEN: ${EXPR} github.token }}`);
    expect(workflow).toContain('gh issue view');
    expect(workflow).toContain('gh issue edit');
    expect(workflow).toContain('gh issue comment');
  });

  test('backstops status needs triage only on opened when no status label exists', () => {
    const needsTriage = extractJobBlock(workflow, 'needs-triage');

    expect(needsTriage).toContain(`if: ${EXPR} github.event.action == 'opened' }}`);
    expect(needsTriage).toContain('startswith("status: ")');
    expect(needsTriage).toContain('--add-label "status: needs triage"');
  });

  test('validates exactly one type label and guards bot re-entrancy', () => {
    const typeLabel = extractJobBlock(workflow, 'type-label');

    expect(workflow).toContain("github.actor != 'github-actions[bot]'");
    expect(typeLabel).toContain('startswith("type: ")');
    expect(typeLabel).toContain('--add-label "status: needs author"');
    expect(typeLabel).toContain('--remove-label "status: needs author"');
    expect(typeLabel).toContain('<!-- issue-triage: type-label -->');
    expect(typeLabel).toContain('AGENTS.md');
  });

  test('classifies the workflow as CI work', () => {
    const labeler = readText('.github/labeler.yml');

    expect(labeler).toContain('".github/workflows/**"');
  });
});
