import type { NativeWatchApi, TrackingIssue, WorkflowJobResult } from '../../ci/native-watch/api';

/** In-memory GitHub for the native platform watch; records every mutation in `calls`. */
export class FakeNativeWatchApi implements NativeWatchApi {
  lastScheduledSha: string | null = null;
  jobs: WorkflowJobResult[] = [];
  issues: TrackingIssue[] = [];
  comments = new Map<number, string[]>();
  calls: string[] = [];
  private nextIssueNumber = 100;

  lastSuccessfulScheduledSha(): Promise<string | null> {
    return Promise.resolve(this.lastScheduledSha);
  }

  listJobs(): Promise<WorkflowJobResult[]> {
    return Promise.resolve(this.jobs);
  }

  listOpenIssues(): Promise<TrackingIssue[]> {
    return Promise.resolve([...this.issues]);
  }

  listIssueCommentBodies(issueNumber: number): Promise<string[]> {
    return Promise.resolve(this.comments.get(issueNumber) ?? []);
  }

  createIssue(issue: { title: string; body: string; labels: readonly string[] }): Promise<number> {
    const number = this.nextIssueNumber++;
    this.calls.push(`create #${number} ${issue.title} [${issue.labels.join(', ')}]`);
    this.issues.push({ number, body: issue.body, author: 'github-actions[bot]' });
    return Promise.resolve(number);
  }

  commentOnIssue(issueNumber: number, body: string): Promise<void> {
    this.calls.push(`comment #${issueNumber}`);
    this.comments.set(issueNumber, [...(this.comments.get(issueNumber) ?? []), body]);
    return Promise.resolve();
  }

  closeIssue(issueNumber: number): Promise<void> {
    this.calls.push(`close #${issueNumber}`);
    this.issues = this.issues.filter((issue) => issue.number !== issueNumber);
    return Promise.resolve();
  }
}
