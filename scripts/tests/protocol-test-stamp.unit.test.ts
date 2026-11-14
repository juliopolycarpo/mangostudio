import { describe, expect, test } from 'bun:test';
import { dirname, posix } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { listCheckoutFiles } from '../lib/git';
import { protocolTestFacts, protocolTestInputFiles } from '../lib/protocol-test-stamp';
import { readText } from './support/read-text';

// The TypeScript protocol suite replays from a pass stamp when its inputs are
// unchanged. The stamp is only sound while the input list covers everything
// the suite reads, so these tests hold the list to the suite's own imports.

const COMMAND = ['bun', './scripts/protocol/test.ts', '--ts-only'];

describe('protocolTestInputFiles', () => {
  const checkout = [
    'packages/protocol/src/session.ts',
    'packages/protocol/tests/new-untracked.test.ts',
    'crates/mango-protocol/src/lib.rs',
    'spec/schema/1/protocol.json',
    'docs/protocol/overview.md',
    'scripts/protocol/test.ts',
    'scripts/lib/exec.ts',
    'scripts/tests/support/fake-cli-preload.ts',
    'package.json',
    'bun.lock',
    '.bun-version',
    'bunfig.toml',
    'tsconfig.json',
    'apps/api/src/app.ts',
    'apps/frontend/package.json',
    'scripts/test.ts',
    'scripts/tests/dev.unit.test.ts',
    'README.md',
  ];

  test('keeps the protocol directories and the files that resolve and run the suite', () => {
    expect(protocolTestInputFiles(ROOT_DIR, checkout)).toEqual(checkout.slice(0, 13));
  });

  test('keys every file a protocol source or test imports from outside its package', () => {
    const checkoutFiles = listCheckoutFiles(ROOT_DIR);
    const keyed = new Set(protocolTestInputFiles(ROOT_DIR, checkoutFiles));
    const sources = checkoutFiles.filter(
      (file) => file.startsWith('packages/protocol/') && /\.[cm]?tsx?$/.test(file)
    );
    const outside = new Set<string>();
    for (const source of sources) {
      for (const [, specifier] of readText(source).matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
        const resolved = posix.normalize(posix.join(dirname(source), specifier));
        if (!resolved.startsWith('packages/protocol/')) outside.add(resolved);
      }
    }

    expect(outside.size, 'expected the suite to import spec fixtures').toBeGreaterThan(0);
    const unkeyed = [...outside].filter((file) => !keyed.has(file));
    expect(
      unkeyed,
      `(protocol stamp): expected every outside import in the stamp key | received: ${unkeyed[0]}`
    ).toEqual([]);
  });

  test('keys every module bunfig.toml preloads into the suite', () => {
    const preloads = [...readText('bunfig.toml').matchAll(/"\.\/([^"]+\.ts)"/g)].map(
      (match) => match[1]
    );
    expect(preloads.length).toBeGreaterThan(0);
    expect(protocolTestInputFiles(ROOT_DIR, preloads)).toEqual(preloads);
  });

  test('declares only the dependencies the lockfile and manifests resolve', () => {
    // A workspace dependency would pull another package's sources into the
    // suite without a relative import to show it.
    const manifest = JSON.parse(readText('packages/protocol/package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const ranges = Object.values({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(
      ranges.filter((range) => range.startsWith('workspace:')),
      '(protocol stamp): expected no workspace dependency; add its sources to the stamp inputs first'
    ).toEqual([]);
  });
});

describe('protocolTestFacts', () => {
  test('records the command, the Bun build and the host', () => {
    const facts = protocolTestFacts(COMMAND, {});
    expect(facts.command).toBe(JSON.stringify(COMMAND));
    expect(facts.bun).toBe(`${Bun.version} ${Bun.revision}`);
    expect(facts.host).toBe(`${process.platform} ${process.arch}`);
  });

  test('records MANGO variables and the socket directory, sorted, and nothing else', () => {
    const facts = protocolTestFacts(COMMAND, {
      XDG_RUNTIME_DIR: '/run/user/1000',
      MANGO_TEST_LEAK: '1',
      MANGO_INTEROP: '1',
      MANGO_RUNNER_GROUP: '4242',
      PATH: '/usr/bin',
      HOME: '/home/someone',
    });
    expect(JSON.parse(facts.env)).toEqual([
      ['MANGO_INTEROP', '1'],
      ['MANGO_TEST_LEAK', '1'],
      ['XDG_RUNTIME_DIR', '/run/user/1000'],
    ]);
  });

  test('a different command is a different fact', () => {
    expect(protocolTestFacts(COMMAND, {}).command).not.toBe(
      protocolTestFacts([...COMMAND, '--', '--bail'], {}).command
    );
  });
});

describe('bun run test', () => {
  const testScript = readText('scripts/test.ts');

  test('stamps the protocol lane on its inputs and facts, and honours --force', () => {
    const lane = /label: 'root:test:protocol',[\s\S]*?\}\),\n {4}\]/.exec(testScript)?.[0] ?? '';
    expect(lane, 'expected a stamped root:test:protocol lane in scripts/test.ts').not.toBe('');
    expect(lane).toContain('enabled: passStampsEnabled(forceRun)');
    expect(lane).toContain('files: protocolTestInputFiles(ROOT_DIR)');
    expect(lane).toContain('facts: protocolTestFacts(PROTOCOL_TEST_COMMAND)');
  });

  test('still runs the command the qualification inventory certifies', () => {
    expect(testScript).toContain(
      `const PROTOCOL_TEST_COMMAND = [${COMMAND.map((item) => `'${item}'`).join(', ')}];`
    );
    expect(testScript).toContain("runCommand('root:test:protocol', PROTOCOL_TEST_COMMAND");
  });
});
