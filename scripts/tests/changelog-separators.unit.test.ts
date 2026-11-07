import { describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { normalizeChangelogSeparators } from '../lib/changelog';
import { ROOT_DIR } from '../lib/config';
import { PROTOCOL_CHANGELOG } from '../lib/protocol';
import { readText } from './support/read-text';

describe('committed historical changelog separators', () => {
  for (const file of ['CHANGELOG.md', PROTOCOL_CHANGELOG]) {
    test(`${file} separates each historical release from the preceding bullet`, () => {
      const source = readText(file);
      expect(normalizeChangelogSeparators(source)).toBe(source);
    });
  }
});

describe('normalizeChangelogSeparators', () => {
  for (const newline of ['\n', '\r\n']) {
    test(`inserts only a missing separator and preserves ${JSON.stringify(newline)} line endings`, () => {
      const before = [
        '# Changelog',
        '',
        '## [0.1.1] - 2026-07-05',
        '',
        '- First entry',
        '## [0.1.0-canary] - 2026-06-15',
        '',
        '- Older entry',
      ].join(newline);
      const after = before.replace(
        `${newline}## [0.1.0-canary]`,
        `${newline}${newline}## [0.1.0-canary]`
      );
      expect(normalizeChangelogSeparators(before)).toBe(after);
      expect(normalizeChangelogSeparators(after)).toBe(after);
      // Every original nonblank line, heading, date and bullet stays identical.
      expect(after.split(newline).filter(Boolean)).toEqual(before.split(newline).filter(Boolean));
    });
  }

  test('preserves already separated sections, extra blank lines and EOF', () => {
    for (const source of [
      '',
      '- Entry\n\n## [1.0.0] - 2026-01-01\n',
      '- Entry\n\n\n## [1.0.0] - 2026-01-01',
      '- Entry\n## Other heading\n',
      '- Entry\n## [Unreleased]\n',
    ]) {
      expect(normalizeChangelogSeparators(source)).toBe(source);
    }
  });

  test('leaves fenced examples unchanged, including shorter nested fence markers', () => {
    for (const marker of ['````', '~~~~']) {
      const example = `${marker}markdown\n${marker.slice(0, 3)}\n- Example\n## [1.0.0] - 2026-01-01\n${marker}\n`;
      const actual = '- Real entry\n## [0.1.0] - 2025-01-01\n';
      expect(normalizeChangelogSeparators(example + actual)).toBe(
        example + actual.replace('\n##', '\n\n##')
      );
    }
  });

  test('does not mistake inline backticks for an opening code fence', () => {
    const inline = '```foo`bar```\n';
    const source = `${inline}- Entry\n## [1.0.0] - 2026-01-01\n`;

    expect(normalizeChangelogSeparators(source)).toBe(
      `${inline}- Entry\n\n## [1.0.0] - 2026-01-01\n`
    );
  });

  test('keeps a fence open when a candidate closing line has non-ASCII whitespace', () => {
    const fenced = '```markdown\n```\u00a0\n- Example\n## [1.0.0] - 2026-01-01\n```\t\n';
    const source = `${fenced}- Entry\n## [0.1.0] - 2025-01-01\n`;

    expect(normalizeChangelogSeparators(source)).toBe(
      `${fenced}- Entry\n\n## [0.1.0] - 2025-01-01\n`
    );
  });
  test('parses the first line without dropping a leading byte-order mark', () => {
    const fenced = '\ufeff~~~markdown\n- Example\n## [1.0.0] - 2026-01-01\n~~~\n';
    const seam = '- Entry\n## [0.1.0] - 2025-01-01\n';
    const repaired = seam.replace('\n##', '\n\n##');

    expect(normalizeChangelogSeparators(fenced + seam)).toBe(fenced + repaired);
    expect(normalizeChangelogSeparators(`\ufeff${seam}`)).toBe(`\ufeff${repaired}`);
  });

  test('ends a nested code fence when the top-level changelog list item ends', () => {
    const example = '- Example\n  ~~~markdown\n  Example content\n';
    const seam = '- Entry\n## [0.1.0] - 2025-01-01\n';

    expect(normalizeChangelogSeparators(example + seam)).toBe(
      example + seam.replace('\n##', '\n\n##')
    );
  });
});

type ChangelogFixture = {
  root: string;
  script: string;
  protocol: string;
  application: string;
};

function withChangelogFixture(run: (fixture: ChangelogFixture) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'changelog-separators-'));
  try {
    const script = join(root, 'scripts/changelog-separators.ts');
    const protocol = join(root, PROTOCOL_CHANGELOG);
    mkdirSync(dirname(script), { recursive: true });
    mkdirSync(dirname(protocol), { recursive: true });
    copyFileSync(join(ROOT_DIR, 'scripts/changelog-separators.ts'), script);
    cpSync(join(ROOT_DIR, 'scripts/lib'), join(root, 'scripts/lib'), { recursive: true });
    const application = join(root, 'CHANGELOG.md');
    run({ root, script, protocol, application });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('separator repair rejects malformed UTF-8 and preserves a valid byte-order mark', () => {
  withChangelogFixture(({ script, protocol, application }) => {
    const seam = '- Entry\n## [1.0.0] - 2026-01-01\n';
    const invalid = Buffer.concat([Buffer.from([0xff, 0x0a]), Buffer.from(seam)]);
    writeFileSync(application, seam);
    writeFileSync(protocol, invalid);

    const result = Bun.spawnSync([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(`${PROTOCOL_CHANGELOG}: expected valid UTF-8`);
    expect(readFileSync(application, 'utf8')).toBe(seam);
    expect(readFileSync(protocol)).toEqual(invalid);

    const prefix = '\ufeff# Changelog\n\n';
    writeFileSync(protocol, prefix + seam);
    const repaired = Bun.spawnSync([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
    expect(repaired.exitCode).toBe(0);
    expect(readFileSync(protocol)).toEqual(Buffer.from(prefix + seam.replace('\n##', '\n\n##')));
  });
});

test.skipIf(process.platform !== 'linux')(
  'an interrupted repair leaves the original changelog intact',
  () => {
    withChangelogFixture(({ root, script, protocol, application }) => {
      const original = `- ${'x'.repeat(4_096)}\n## [1.0.0] - 2026-01-01\n`;
      writeFileSync(application, original);
      writeFileSync(protocol, '# Changelog\n');

      const result = Bun.spawnSync(
        [
          'bash',
          '-c',
          'ulimit -c 0 && ulimit -f 1 && exec "$@"',
          'limit',
          process.execPath,
          script,
        ],
        { cwd: root, stdout: 'pipe', stderr: 'pipe' }
      );

      expect(result.success).toBe(false);
      expect(readFileSync(application, 'utf8')).toBe(original);
    });
  }
);

test.skipIf(process.platform === 'win32')(
  'separator repair rejects a changelog symlink before writing either file',
  () => {
    withChangelogFixture(({ root, script, protocol, application }) => {
      const target = join(root, 'symlink-target.md');
      const seam = '- Entry\n## [1.0.0] - 2026-01-01\n';
      writeFileSync(application, seam);
      writeFileSync(target, seam);
      symlinkSync(target, protocol, 'file');

      const result = Bun.spawnSync([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(`${PROTOCOL_CHANGELOG}: expected a regular file`);
      expect(readFileSync(application, 'utf8')).toBe(seam);
      expect(readFileSync(target, 'utf8')).toBe(seam);
    });
  }
);

test.skipIf(process.platform === 'win32')(
  'separator repair rejects a symlinked parent before writing either file',
  () => {
    withChangelogFixture(({ root, script, protocol, application }) => {
      const targetDir = join(root, 'symlink-target');
      const target = join(targetDir, 'CHANGELOG.md');
      const seam = '- Entry\n## [1.0.0] - 2026-01-01\n';
      mkdirSync(targetDir);
      writeFileSync(application, seam);
      writeFileSync(target, seam);
      rmSync(dirname(protocol), { recursive: true });
      symlinkSync(targetDir, dirname(protocol), 'dir');

      const result = Bun.spawnSync([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(`${PROTOCOL_CHANGELOG}: expected a regular file`);
      expect(readFileSync(application, 'utf8')).toBe(seam);
      expect(readFileSync(target, 'utf8')).toBe(seam);
    });
  }
);

test.skipIf(process.platform === 'win32')(
  'separator repair rejects a symlink substituted when a changelog is opened',
  () => {
    withChangelogFixture(({ root, script, protocol, application }) => {
      const target = join(root, 'swap-target.md');
      const seam = '- Entry\n## [1.0.0] - 2026-01-01\n';
      writeFileSync(application, seam);
      writeFileSync(protocol, seam);
      writeFileSync(target, seam);

      const probe = join(dirname(script), 'open-race.test.ts');
      writeFileSync(
        probe,
        `
import { mock, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';

test('swap the protocol entry after its canonical path is checked', async () => {
  const native = { ...fs };
  const root = native.realpathSync(join(import.meta.dir, '..'));
  const protocol = join(root, 'packages/protocol/CHANGELOG.md');
  let swapped = false;
  const resolveBeforeSwap = new Proxy(native.realpathSync, {
    apply(resolve, receiver, args) {
      const result = Reflect.apply(resolve, receiver, args);
      if (!swapped && args[0] === protocol) {
        swapped = true;
        native.renameSync(protocol, protocol + '.original');
        native.symlinkSync(join(root, 'swap-target.md'), protocol, 'file');
      }
      return result;
    },
  });
  mock.module('node:fs', () => ({ ...native, realpathSync: resolveBeforeSwap }));
  process.argv = [process.execPath, join(import.meta.dir, 'changelog-separators.ts')];
  await import('./changelog-separators');
});
`
      );

      const result = Bun.spawnSync([process.execPath, 'test', probe], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(`${PROTOCOL_CHANGELOG}: expected a regular file`);
      expect(readFileSync(application, 'utf8')).toBe(seam);
      expect(readFileSync(target, 'utf8')).toBe(seam);
    });
  }
);

test('separator repair preserves an edit made while the replacement is staged', () => {
  withChangelogFixture(({ root, script, protocol, application }) => {
    const concurrent = '# Changelog\n\nAn edit made during repair.\n';
    writeFileSync(application, '# Changelog\n');
    writeFileSync(protocol, '- Entry\n## [1.0.0] - 2026-01-01\n');

    const probe = join(dirname(script), 'write-race.test.ts');
    writeFileSync(
      probe,
      `
import { mock, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';

test('edit the protocol file after its temporary replacement is written', async () => {
  const native = { ...fs };
  const root = native.realpathSync(join(import.meta.dir, '..'));
  const protocol = join(root, 'packages/protocol/CHANGELOG.md');
  const writeThenEdit = new Proxy(native.writeFileSync, {
    apply(write, receiver, args) {
      const result = Reflect.apply(write, receiver, args);
      if (typeof args[0] === 'string' && args[0].includes('.changelog-repair-')) {
        native.writeFileSync(protocol, ${JSON.stringify(concurrent)});
      }
      return result;
    },
  });
  mock.module('node:fs', () => ({ ...native, writeFileSync: writeThenEdit }));
  process.argv = [process.execPath, join(import.meta.dir, 'changelog-separators.ts')];
  await import('./changelog-separators');
});
`
    );

    const result = Bun.spawnSync([process.execPath, 'test', probe], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(`${PROTOCOL_CHANGELOG}: changed during repair`);
    expect(readFileSync(protocol, 'utf8')).toBe(concurrent);
  });
});
