import { describe, expect, test } from 'bun:test';
import { reportFreshDependencies } from '../ci/report-fresh-dependencies.mjs';
import { readText } from './support/read-text';
import { extractJobBlock, extractOnBlock, sectionKeys } from './support/workflow-blocks';

interface Issue {
  number: number;
  body: string;
  user: { login: string };
  state?: string;
  pull_request?: object;
}

class FakeIssueClient {
  readonly issues: Issue[] = [];
  readonly requests: object[] = [];
  readonly rest = {
    issues: {
      listForRepo: 'issues',
      create: (request: { body: string }) => {
        this.requests.push(request);
        const issue = {
          number: this.issues.length + 1,
          body: request.body,
          user: { login: 'github-actions[bot]' },
        };
        this.issues.push(issue);
        return Promise.resolve({ data: issue });
      },
      update: (request: { issue_number: number; body: string; state: string }) => {
        this.requests.push(request);
        const issue = this.issues.find((entry) => entry.number === request.issue_number);
        if (!issue) throw new Error(`Unknown fake issue ${request.issue_number}`);
        issue.body = request.body;
        issue.state = request.state;
        return Promise.resolve();
      },
    },
  };

  paginate(_route: string, request: object): Promise<Issue[]> {
    this.requests.push(request);
    return Promise.resolve(this.issues);
  }
}

const revision = 'a'.repeat(40);
const runUrl = 'https://github.com/example/project/actions/runs/123';
const context = { repo: { owner: 'example', repo: 'project' } };

describe('fresh dependency reporting', () => {
  test('successive failures update one issue and preserve maintainer notes', async () => {
    const github = new FakeIssueClient();
    expect(await reportFreshDependencies({ github, context, revision, runUrl })).toBe(1);
    const issue = github.issues[0];
    issue.body = `Maintainer decision\n\n${issue.body}\n\nInvestigation notes`;
    issue.state = 'closed';
    const nextRevision = 'b'.repeat(40);
    expect(await reportFreshDependencies({ github, context, revision: nextRevision, runUrl })).toBe(
      1
    );
    expect(github.issues).toHaveLength(1);
    expect(issue.state).toBe('open');
    expect(issue.body).toStartWith('Maintainer decision\n\n');
    expect(issue.body).toEndWith('\n\nInvestigation notes');
    expect(issue.body).toContain(nextRevision);
    expect(issue.body).not.toContain(revision);
    expect(github.requests[0]).toMatchObject({ state: 'all', per_page: 100 });
    expect(github.requests[1]).toMatchObject({
      labels: ['type: dependencies', 'status: needs triage'],
    });
  });

  test('ignores pull requests and issues whose marker was quoted by a user', async () => {
    const github = new FakeIssueClient();
    github.issues.push(
      { number: 10, body: '<!-- rust-fresh-dependencies -->', user: { login: 'maintainer' } },
      {
        number: 11,
        body: '<!-- rust-fresh-dependencies -->',
        user: { login: 'github-actions[bot]' },
        pull_request: {},
      }
    );
    await reportFreshDependencies({ github, context, revision, runUrl });
    expect(github.issues).toHaveLength(3);
    expect(github.issues[0].body).toBe('<!-- rust-fresh-dependencies -->');
  });

  test('refuses ambiguous or malformed managed issues before writing', async () => {
    const github = new FakeIssueClient();
    github.issues.push({
      number: 4,
      body: '<!-- rust-fresh-dependencies --> no closing marker',
      user: { login: 'github-actions[bot]' },
    });
    await expect(reportFreshDependencies({ github, context, revision, runUrl })).rejects.toThrow(
      'Invalid managed section in issue 4; expected exactly one ordered'
    );
    expect(github.requests).toHaveLength(1);
    github.issues.push({ ...github.issues[0], number: 5 });
    await expect(reportFreshDependencies({ github, context, revision, runUrl })).rejects.toThrow(
      'Received compatibility issues 4, 5; expected at most one managed issue'
    );
    expect(github.requests).toHaveLength(2);
  });

  test('rejects a malformed source revision before external I/O', async () => {
    const github = new FakeIssueClient();
    await expect(
      reportFreshDependencies({ github, context, revision: 'main', runUrl })
    ).rejects.toThrow('Invalid revision "main"; expected a 40-character Git SHA');
    expect(github.requests).toHaveLength(0);
  });
});

describe('fresh dependency workflow', () => {
  const workflow = readText('.github/workflows/rust-fresh-dependencies.yml');

  test('is advisory, scheduled, manually dispatchable and validates its own PR edits', () => {
    expect(sectionKeys(extractOnBlock(workflow))).toEqual([
      'schedule',
      'workflow_dispatch',
      'pull_request',
    ]);
    expect(workflow).not.toContain('name: Gate');
    expect(workflow).not.toContain('contents: write');
    expect(workflow).not.toContain('git push');
  });

  test('resolves a fresh graph before all locked build, policy, clippy and test checks', () => {
    const fresh = extractJobBlock(workflow, 'fresh');
    expect(fresh.indexOf('rm Cargo.lock')).toBeLessThan(fresh.indexOf('cargo generate-lockfile'));
    expect(fresh.indexOf('cargo generate-lockfile')).toBeLessThan(
      fresh.indexOf('cargo build --workspace --all-features --locked')
    );
    expect(fresh).toContain('cargo deny check bans licenses sources');
    expect(fresh).toContain(
      'cargo clippy --workspace --all-targets --all-features --locked -- -D warnings'
    );
    expect(fresh).toContain('cargo test --workspace --all-targets --all-features --locked');
    expect(fresh).toContain('cargo test --doc --workspace --all-features --locked');
    expect(fresh).toContain('path: Cargo.lock');
    expect(fresh).not.toContain('issues: write');
  });

  test('only reports a genuine failed scheduled or dispatched run', () => {
    const report = extractJobBlock(workflow, 'report');
    expect(report).toContain("needs.fresh.result == 'failure'");
    expect(report).toContain("github.event_name != 'pull_request'");
    expect(report).toContain('issues: write');
    expect(report).toContain('reportFreshDependencies');
  });
});
