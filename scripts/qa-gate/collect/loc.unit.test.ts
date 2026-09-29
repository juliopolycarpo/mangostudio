import { describe, expect, it } from 'bun:test';
import type { LocClass } from '../model/metrics';
import { makeFakeRepository } from '../testing/fake-repository';
import { expectState } from '../testing/measurement-assertions';
import { classifyFile, countLines, measureComponentLoc } from './loc';

describe('classifyFile', () => {
  it.each<[string, LocClass]>([
    ['apps/api/src/server.ts', 'production'],
    ['apps/frontend/src/App.tsx', 'production'],
    ['crates/alpha/src/lib.rs', 'production'],
    ['scripts/check.mjs', 'production'],
    ['apps/api/tests/unit/a.test.ts', 'test'],
    ['apps/api/src/thing.spec.ts', 'test'],
    ['crates/alpha/tests/it.rs', 'test'],
    ['scripts/qa-gate/testing/metrics-fixture.ts', 'test'],
    ['apps/api/tests/fixtures/legacy-hello.ts', 'fixture'],
    ['apps/api/tests/unit/__fixtures__/agent.golden.md', 'fixture'],
    ['apps/frontend/src/routeTree.gen.ts', 'generated'],
    ['apps/shared/src/runtime-contract/generated/catalog.json', 'generated'],
    ['apps/x/src/schema.generated.ts', 'generated'],
    ['Cargo.lock', 'generated'],
    ['bun.lock', 'generated'],
    ['apps/api/package.json', 'config'],
    ['.github/workflows/ci.yml', 'config'],
    ['crates/alpha/Cargo.toml', 'config'],
    ['Dockerfile.alpine', 'config'],
    ['docs/guide.md', 'docs'],
    ['.cursor/rules/x.mdc', 'docs'],
  ])('classifies %s as %s', (path, expected) => {
    expect(classifyFile(path)?.class).toBe(expected);
  });

  // "generated-images" and "generated_images" are product names, not generated code.
  it('does not mistake a name that merely contains "generated" for generated code', () => {
    expect(classifyFile('apps/api/src/routes/generated-images.ts')?.class).toBe('production');
  });

  it('puts a .ts file under fixtures in the fixture class, ahead of test', () => {
    expect(classifyFile('apps/api/tests/support/fixtures/managed-process.ts')?.class).toBe(
      'fixture'
    );
  });

  it.each(['apps/frontend/public/logo.png', 'apps/x/font.woff2', 'scripts/run.sh', 'a.css'])(
    'leaves %s out of the LoC scope',
    (path) => {
      expect(classifyFile(path)).toBeNull();
    }
  );

  it('only splits comment lines for source languages', () => {
    expect(classifyFile('a/b.ts')?.commentAware).toBe(true);
    expect(classifyFile('a/b.rs')?.commentAware).toBe(true);
    expect(classifyFile('a/b.json')?.commentAware).toBe(false);
    expect(classifyFile('a/b.md')?.commentAware).toBe(false);
  });
});

describe('countLines', () => {
  it('splits code, line comments, block comments and blanks', () => {
    const text = [
      '// header',
      'const a = 1;',
      '',
      '/* block',
      ' * more',
      ' */',
      'const b = 2;',
    ].join('\n');

    expect(countLines(text, true)).toEqual({ code: 2, comment: 4, blank: 1 });
  });

  it('counts every non-blank line as code when there is no comment syntax to split on', () => {
    expect(countLines('# title\n\n// not a comment here\n', false)).toEqual({
      code: 2,
      comment: 0,
      blank: 2,
    });
  });
});

describe('measureComponentLoc', () => {
  const files = {
    'apps/api/src/server.ts': '// entry\nexport const a = 1;\n',
    'apps/api/src/util.ts': 'export const b = 2;\nexport const c = 3;\n',
    'apps/api/tests/server.test.ts': 'import "./x";\n',
    'apps/api/package.json': '{\n  "name": "@x/api"\n}\n',
    'apps/api/logo.png': 'binary',
  };

  it('counts tracked files per class and leaves out-of-scope files unread', async () => {
    const repo = makeFakeRepository(files);

    const cell = expectState(
      await measureComponentLoc(repo.trackedFiles, repo.readText),
      'measured'
    );
    const stats = cell.value;

    expect(stats.production).toEqual({ files: 2, code: 3, comment: 1, blank: 2, total: 6 });
    expect(stats.test).toEqual({ files: 1, code: 1, comment: 0, blank: 1, total: 2 });
    expect(stats.config).toEqual({ files: 1, code: 3, comment: 0, blank: 1, total: 4 });
    expect(stats.docs.files).toBe(0);
    expect(repo.reads).not.toContain('apps/api/logo.png');
  });

  // Regression: the old collector logged "Skipped <file>" but still counted the
  // file, so a file it could not read produced a lower line total under an
  // unchanged file count, with no signal in the envelope.
  it('marks the component partial, with the reason recorded, when a file is unreadable', async () => {
    const repo = makeFakeRepository({
      ...files,
      'apps/api/src/util.ts': new Error('EACCES: permission denied'),
    });

    const cell = expectState(
      await measureComponentLoc(repo.trackedFiles, repo.readText),
      'partial'
    );

    expect(cell.reasons[0]).toBe(
      '1 of 4 counted file(s) unreadable; totals cover only the files that were read'
    );
    expect(cell.reasons).toContain('apps/api/src/util.ts: EACCES: permission denied');
  });

  it('keeps files and lines consistent: an unreadable file is in neither', async () => {
    const repo = makeFakeRepository({
      ...files,
      'apps/api/src/util.ts': new Error('EACCES'),
    });

    const cell = expectState(
      await measureComponentLoc(repo.trackedFiles, repo.readText),
      'partial'
    );

    expect(cell.value.production.files).toBe(1);
    expect(cell.value.production.total).toBe(3);
  });

  it('marks a component partial when a tracked file was deleted from the worktree', async () => {
    const repo = makeFakeRepository(files);

    expectState(
      await measureComponentLoc([...repo.trackedFiles, 'apps/api/src/gone.ts'], repo.readText),
      'partial'
    );
  });

  it('bounds the recorded reasons when many files are unreadable', async () => {
    const broken = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`apps/api/src/f${index}.ts`, new Error('EIO')])
    );
    const repo = makeFakeRepository(broken);

    const cell = expectState(
      await measureComponentLoc(repo.trackedFiles, repo.readText),
      'partial'
    );

    expect(cell.reasons.length).toBeLessThanOrEqual(20);
    expect(cell.reasons.at(-1)).toBe('… and 20 more');
  });

  it('reports a component with no countable files as measured zeros, not as a failure', async () => {
    const cell = expectState(
      await measureComponentLoc(['apps/x/logo.png'], async () => 'x'),
      'measured'
    );

    expect(cell.value.production.files).toBe(0);
  });
});
