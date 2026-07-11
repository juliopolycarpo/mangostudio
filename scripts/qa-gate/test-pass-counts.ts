import type { WorkspaceName } from '../lib/config';

export interface TestPassCounts {
  readonly root: number;
  readonly frontend: number;
  readonly api: number;
  readonly shared: number;
}

const WORKSPACE_PASS_RE =
  /^@mangostudio\/(frontend|api|shared) test:[^\s]+:\s+(?:Tests\s+)?(\d+)\s+pass(?:ed)?\b/;
const ROOT_PASS_RE = /^\s+(\d+)\s+pass$/;

export const parseTestPassCounts = (text: string): TestPassCounts => {
  const stats: Record<WorkspaceName | 'root', number> = {
    root: 0,
    frontend: 0,
    api: 0,
    shared: 0,
  };

  for (const line of text.split('\n')) {
    const workspaceMatch = line.match(WORKSPACE_PASS_RE);
    if (workspaceMatch) {
      const workspace = workspaceMatch[1] as WorkspaceName;
      stats[workspace] += Number(workspaceMatch[2]);
      continue;
    }

    const rootMatch = line.match(ROOT_PASS_RE);
    if (rootMatch) stats.root += Number(rootMatch[1]);
  }

  return stats;
};
