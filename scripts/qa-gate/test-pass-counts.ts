import { ALL_WORKSPACE_NAMES, type WorkspaceName } from '../lib/config';

export type TestPassCounts = Readonly<Record<WorkspaceName | 'root', number>>;

const WORKSPACE_PASS_RE = new RegExp(
  `^@mangostudio/(${ALL_WORKSPACE_NAMES.join('|')}) test:[^\\s]+:\\s+(?:Tests\\s+)?(\\d+)\\s+pass(?:ed)?\\b`
);
const ROOT_PASS_RE = /^\s+(\d+)\s+pass$/;

export const parseTestPassCounts = (text: string): TestPassCounts => {
  const stats = Object.fromEntries(
    ['root', ...ALL_WORKSPACE_NAMES].map((workspace) => [workspace, 0])
  ) as Record<WorkspaceName | 'root', number>;

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
