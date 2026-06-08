import { WORKSPACES, type WorkspaceName } from './config';

export type TestLaneTask = 'test:unit' | 'test:integration' | 'test:coverage';

/** Build a filtered Turbo test-lane command. // Usage: createTurboTestCommand('test:unit', ['api']); */
export function createTurboTestCommand(task: TestLaneTask, workspaces: WorkspaceName[]): string[] {
  const filters = workspaces.map((workspace) => `--filter=${WORKSPACES[workspace].packageName}`);
  return ['turbo', 'run', task, '--ui=stream', ...filters];
}
