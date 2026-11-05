import { expect, test } from 'bun:test';

import { readText } from './support/read-text';

const workflows = ['ci', 'cargo-shim', 'protocol-ci', 'codeql', 'dependency-review'];

test.each(workflows)(
  '%s validates main and stacked PR targets without duplicate feature pushes',
  (name) => {
    const workflow = Bun.YAML.parse(readText(`.github/workflows/${name}.yml`)) as {
      on: Record<string, { branches?: string[]; paths?: string[]; 'paths-ignore'?: string[] }>;
    };
    const pullRequest = workflow.on.pull_request;
    expect(pullRequest.branches).toEqual(['main', 'stack/**']);
    expect(pullRequest.paths).toBeUndefined();
    expect(pullRequest['paths-ignore']).toBeUndefined();
    if (workflow.on.push) expect(workflow.on.push.branches).toEqual(['main']);
  }
);
