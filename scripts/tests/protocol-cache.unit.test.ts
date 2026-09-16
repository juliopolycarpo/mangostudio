import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readText } from './support/read-text';

const TURBO = join(import.meta.dir, '../../node_modules/.bin/turbo');
const PROTOCOL_PACKAGE = '@mangostudio/protocol';
const PROTOCOL_TURBO = 'packages/protocol/turbo.json';

interface TurboDryRun {
  tasks: Array<{ taskId: string; hash: string }>;
}

function buildHash(root: string): string {
  const result = Bun.spawnSync({
    cmd: [TURBO, 'run', 'build', `--filter=${PROTOCOL_PACKAGE}`, '--dry=json'],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = result.stdout.toString();

  expect(result.exitCode, `${output}${result.stderr.toString()}`).toBe(0);
  const task = (JSON.parse(output) as TurboDryRun).tasks.find(
    ({ taskId }) => taskId === `${PROTOCOL_PACKAGE}#build`
  );

  expect(task).toBeDefined();
  return task?.hash ?? '';
}

function createProtocolFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'mango-protocol-turbo-'));
  const protocol = join(root, 'packages/protocol');
  mkdirSync(join(protocol, 'src'), { recursive: true });
  mkdirSync(join(root, 'spec/schema/1'), { recursive: true });

  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      private: true,
      packageManager: 'bun@1.4.2',
      workspaces: ['packages/*'],
    })
  );
  writeFileSync(
    join(root, 'turbo.json'),
    JSON.stringify({ tasks: { build: { outputs: ['dist/**'] } } })
  );
  writeFileSync(
    join(protocol, 'package.json'),
    JSON.stringify({ name: PROTOCOL_PACKAGE, version: '0.0.0', scripts: { build: 'bun -e ""' } })
  );
  writeFileSync(join(protocol, 'turbo.json'), readText(PROTOCOL_TURBO));
  writeFileSync(join(protocol, 'src/index.ts'), 'export const protocol = 1;\n');
  writeFileSync(join(root, 'spec/schema/1/protocol.json'), '{"type":"object"}\n');
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{}}\n');
  writeFileSync(join(root, 'LICENSE'), 'MIT\n');

  return root;
}

describe('protocol Turbo build cache inputs', () => {
  test('changes the build hash for every input build reads', () => {
    for (const [path, contents] of [
      ['packages/protocol/src/index.ts', 'export const protocol = 2;\n'],
      ['spec/schema/1/protocol.json', '{"type":"string"}\n'],
      ['tsconfig.json', '{"compilerOptions":{"strict":true}}\n'],
      ['LICENSE', 'Apache-2.0\n'],
    ]) {
      const root = createProtocolFixture();
      try {
        const baseline = buildHash(root);
        writeFileSync(join(root, path), contents);
        expect(buildHash(root), path).not.toBe(baseline);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
