import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createTailwindPlugin, resolveMetafileInputPath } from '../../scripts/tailwind';

const fixtures: string[] = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'tailwind-compiler-')));
  fixtures.push(repository);
  const project = join(repository, 'apps/frontend');
  cpSync(join(import.meta.dir, '../../../../bun.lock'), join(repository, 'bun.lock'));
  for (const path of [
    'apps/frontend/src/excluded',
    'apps/frontend/scripts',
    'apps/frontend/styles',
    'apps/frontend/images',
    'apps/frontend/explicit',
    'apps/shared/src/frontend-build',
    'node_modules',
    '.git',
  ])
    mkdirSync(join(repository, path), { recursive: true });
  cpSync(
    dirname(require.resolve('tailwindcss/package.json')),
    join(repository, 'node_modules/tailwindcss'),
    { recursive: true, dereference: true }
  );
  for (const path of [
    'apps/frontend/scripts/routes.ts',
    'apps/frontend/scripts/tailwind.ts',
    'apps/shared/src/frontend-build/host.ts',
    'apps/frontend/index.html',
  ])
    writeFileSync(join(repository, path), 'fixture');
  const config = {
    version: 1,
    defaultSources: [
      { base: '.', pattern: 'src/**/*', negated: false },
      { base: '.', pattern: 'index.html', negated: false },
    ],
    additionalRoots: [
      { path: 'explicit', kind: 'directory' },
      { path: 'styles', kind: 'directory' },
      { path: 'images', kind: 'directory' },
    ],
  };
  writeFileSync(join(project, 'tailwind-inputs.json'), JSON.stringify(config));
  writeFileSync(
    join(project, 'src/card.tsx'),
    '<div className="flex md:grid hover:opacity-50 bg-brand"/>'
  );
  writeFileSync(join(project, 'src/excluded/card.tsx'), '<div className="z-[9876]"/>');
  writeFileSync(join(project, 'explicit/card.tsx'), '<div className="z-[3456]"/>');
  const input = join(project, 'src/index.css');
  const write = (source: string) => writeFileSync(input, source);
  write('@import "tailwindcss"; @theme { --color-brand: #123456; }');
  async function build() {
    const plugin = createTailwindPlugin({ projectRoot: project });
    await plugin.prepare(input);
    const result = await Bun.build({
      entrypoints: [input],
      plugins: [plugin],
      external: ['/fonts/*'],
      throw: true,
      metafile: true,
    });
    plugin.verify(result.metafile);
    const stylesheet = result.outputs.find((output) => output.path.endsWith('.css'));
    if (!stylesheet) throw new Error(`${input}: expected compiled CSS output`);
    return {
      css: await stylesheet.text(),
      plugin,
      result,
    };
  }
  return { repository, project, input, write, build };
}

describe('Bun metafile input paths', () => {
  test('decodes Bun 1.4.3 cross-volume Windows paths before scope validation', () => {
    const raw = '../../../C:/Users/runner/Temp/styles/pixel.svg';
    expect(
      resolveMetafileInputPath(raw, 'D:\\agents\\frontend', 'win32'),
      `${raw}: expected the imported asset on C:, not a D:\\C: path`
    ).toBe('C:\\Users\\runner\\Temp\\styles\\pixel.svg');
  });
  test('rejects malformed or ambiguous drive components and preserves POSIX colons', () => {
    for (const path of [
      '../../C:/assets/pixel.svg',
      '../../../../C:/assets/pixel.svg',
      '../../../D:/assets/pixel.svg',
      '../../../C:/assets/D:/pixel.svg',
      'C:assets/pixel.svg',
    ])
      expect(() => resolveMetafileInputPath(path, 'D:\\agents\\frontend', 'win32')).toThrow(
        `${path}: expected Bun metafile path with an unambiguous Windows volume`
      );
    expect(resolveMetafileInputPath('../../C:/pixel.svg', '/repo/app/styles', 'linux')).toBe(
      '/repo/C:/pixel.svg'
    );
    expect(resolveMetafileInputPath('images/icon:dark.svg', '/repo/app', 'linux')).toBe(
      '/repo/app/images/icon:dark.svg'
    );
  });
  test('retains same-volume, native absolute, UNC and POSIX input paths', () => {
    expect(resolveMetafileInputPath('src/pixel.svg', 'D:\\agents\\app', 'win32')).toBe(
      'D:\\agents\\app\\src\\pixel.svg'
    );
    expect(resolveMetafileInputPath('C:\\repo\\pixel.svg', 'D:\\app', 'win32')).toBe(
      'C:\\repo\\pixel.svg'
    );
    expect(resolveMetafileInputPath('images/pixel.svg', '\\\\server\\share\\app', 'win32')).toBe(
      '\\\\server\\share\\app\\images\\pixel.svg'
    );
    expect(resolveMetafileInputPath('../images/pixel.svg', '/repo/app', 'linux')).toBe(
      '/repo/images/pixel.svg'
    );
  });
});

describe('owned Tailwind Bun loader', () => {
  test('preserves default, explicit, negative and inline sources, variants and theme tokens', async () => {
    const f = fixture();
    f.write(
      '@import "tailwindcss"; @source "../explicit"; @source not "./excluded"; @source inline("underline"); @theme { --color-brand: #123456; }'
    );
    const { css, plugin } = await f.build();
    for (const selector of [
      '.flex',
      '.md\\:grid',
      '.hover\\:opacity-50',
      '.bg-brand',
      '.z-\\[3456\\]',
      '.underline',
    ])
      expect(css).toContain(selector);
    expect(css).not.toContain('.z-\\[9876\\]');
    expect(plugin.diagnostics[0].sources.some((source) => source.negated)).toBe(true);
    expect(plugin.verify().digest).toMatch(/^[a-f0-9]{64}$/);
  });
  test('supports source(none) and an explicit compiler root', async () => {
    const f = fixture();
    f.write('@import "tailwindcss" source(none); @source inline("underline");');
    const disabled = await f.build();
    expect(disabled.css).toContain('.underline');
    expect(disabled.css).not.toContain('.flex');
    f.write('@import "tailwindcss" source("./excluded");');
    const explicit = await f.build();
    expect(explicit.css).toContain('.z-\\[9876\\]');
    expect(explicit.css).not.toContain('.flex');
  });
  test('uses a fresh compiler/scanner for additions, deletions and imported CSS edits', async () => {
    const f = fixture();
    f.write('@import "tailwindcss"; @import "../styles/nested.css";');
    writeFileSync(join(f.project, 'styles/nested.css'), '.nested { color: #123456; }');
    expect((await f.build()).css).toContain('#123456');
    const added = join(f.project, 'src/new.tsx');
    writeFileSync(added, '<div className="z-[4567]"/>');
    expect((await f.build()).css).toContain('.z-\\[4567\\]');
    rmSync(added);
    writeFileSync(join(f.project, 'styles/nested.css'), '.nested { color: #abcdef; }');
    const after = await f.build();
    expect(after.css).not.toContain('.z-\\[4567\\]');
    expect(after.css).toContain('#abcdef');
    expect(after.plugin.diagnostics[0].dependencies).toContain(
      join(f.project, 'styles/nested.css')
    );
  });
  test('retains Bun asset resolution and leaves plain CSS on the normal loader', async () => {
    const f = fixture();
    writeFileSync(join(f.project, 'images/pixel.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(
      join(f.project, 'styles/nested.css'),
      '.nested { background-image: url("../images/pixel.svg"); }'
    );
    f.write(
      '@import "tailwindcss"; @import "../styles/nested.css"; @font-face { font-family: Test; src: url("/fonts/test.woff2"); }'
    );
    const { css, result } = await f.build();
    expect(css).toContain('/fonts/test.woff2');
    expect(
      result.outputs.some((output) => output.path.endsWith('.svg')) ||
        css.includes('data:image/svg+xml')
    ).toBe(true);
    const plain = join(f.project, 'styles/plain.css');
    writeFileSync(plain, '.xterm { color: red; }');
    const plugin = createTailwindPlugin({ projectRoot: f.project });
    const built = await Bun.build({ entrypoints: [plain], plugins: [plugin], throw: true });
    expect(await built.outputs[0].text()).toContain('.xterm');
    expect(plugin.diagnostics).toEqual([]);
  });
  test('rejects missing imports and missing or undeclared sources, then permits a fresh retry', async () => {
    const f = fixture();
    f.write('@import "./missing.css";');
    await expect(f.build()).rejects.toThrow('missing.css');
    f.write('@import "tailwindcss" source("./does-not-exist");');
    await expect(f.build()).rejects.toThrow('does-not-exist');
    f.write('@import "tailwindcss"; @source "../../../undeclared";');
    await expect(f.build()).rejects.toThrow('undeclared');
    f.write('@import "tailwindcss";');
    expect((await f.build()).css).toContain('.flex');
  });
  test('requires authored imported stylesheets to have declared hash coverage', async () => {
    const f = fixture();
    mkdirSync(join(f.repository, 'styles'), { recursive: true });
    const stylesheet = join(f.repository, 'styles/shared.css');
    writeFileSync(stylesheet, '.external-style { color: #abcdef; }');
    f.write('@import "tailwindcss"; @import "../../../styles/shared.css";');
    await expect(f.build()).rejects.toThrow(
      'expected stylesheet dependency declared by tailwind-inputs.json'
    );
    const configPath = join(f.project, 'tailwind-inputs.json');
    const config = await Bun.file(configPath).json();
    config.additionalRoots.push({ path: '../../styles/shared.css', kind: 'file' });
    writeFileSync(configPath, JSON.stringify(config));
    const declared = await f.build();
    expect(declared.css).toContain('#abcdef');
    const before = declared.plugin.verify();
    writeFileSync(stylesheet, '.external-style { color: #123456; }');
    expect(() => declared.plugin.verify()).toThrow('expected unchanged Tailwind inputs');
    expect(before.files.some((file) => file.path === 'styles/shared.css')).toBe(true);
    expect((await f.build()).css).toContain('#123456');
  });

  test('requires declared hash coverage for imported CSS assets and unowned package files', async () => {
    const f = fixture();
    mkdirSync(join(f.repository, 'assets'), { recursive: true });
    writeFileSync(
      join(f.repository, 'assets/pixel.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"/>'
    );
    f.write('@import "tailwindcss"; .example { background: url("../../../assets/pixel.svg"); }');
    await expect(f.build()).rejects.toThrow(
      'expected stylesheet dependency declared by tailwind-inputs.json'
    );
    const configPath = join(f.project, 'tailwind-inputs.json');
    const config = await Bun.file(configPath).json();
    config.additionalRoots.push({ path: '../../assets/pixel.svg', kind: 'file' });
    writeFileSync(configPath, JSON.stringify(config));
    expect((await f.build()).css).toContain('data:image/svg+xml');
    writeFileSync(join(f.repository, 'node_modules/unowned.css'), '.unowned { color: red; }');
    f.write('@import "tailwindcss"; @import "../../../node_modules/unowned.css";');
    await expect(f.build()).rejects.toThrow('unowned.css: expected stylesheet dependency declared');
  });

  test('exempts installed package CSS only with matching registry integrity in the lock', async () => {
    const f = fixture();
    const path = join(f.repository, 'bun.lock');
    const lock = Bun.JSON5.parse(await Bun.file(path).text()) as {
      packages: Record<string, unknown[]>;
    };
    lock.packages.tailwindcss = ['tailwindcss@4.3.3', '', {}];
    writeFileSync(path, JSON.stringify(lock));
    await expect(f.build()).rejects.toThrow(
      'expected stylesheet dependency declared by tailwind-inputs.json'
    );
  });

  test('tracks ignored defaults and allows explicitly declared node_modules sources', async () => {
    const f = fixture();
    writeFileSync(join(f.project, '.gitignore'), 'src/excluded/');
    expect((await f.build()).css).not.toContain('.z-\\[9876\\]');
    const vendor = join(f.repository, 'node_modules/vendor/src');
    mkdirSync(vendor, { recursive: true });
    writeFileSync(join(vendor, 'card.tsx'), '<div className="z-[7654]"/>');
    const configPath = join(f.project, 'tailwind-inputs.json');
    const config = await Bun.file(configPath).json();
    config.additionalRoots.push({ path: '../../node_modules/vendor/src', kind: 'directory' });
    writeFileSync(configPath, JSON.stringify(config));
    f.write('@import "tailwindcss"; @source "../../../node_modules/vendor/src";');
    expect((await f.build()).css).toContain('.z-\\[7654\\]');
  });
  test('captures eager plain CSS roots alongside the Tailwind entry before compiling', async () => {
    const f = fixture();
    const plain = join(f.project, 'styles/plain.css');
    writeFileSync(plain, '.xterm { color: red; }');
    const plugin = createTailwindPlugin({ projectRoot: f.project });
    const inputs = await plugin.prepare([f.input, plain]);
    expect(inputs.files.some((file) => file.path === 'apps/frontend/styles/plain.css')).toBe(true);
    const built = await Bun.build({
      entrypoints: [f.input, plain],
      plugins: [plugin],
      throw: true,
    });
    expect(built.outputs.length).toBeGreaterThan(0);
    expect(plugin.verify().digest).toBe(inputs.digest);
  });

  test('rejects input changes between discovery and publication without replacing the snapshot', async () => {
    const f = fixture();
    const plugin = createTailwindPlugin({ projectRoot: f.project });
    expect(() => plugin.verify()).toThrow('expected Tailwind preparation before publication');
    const before = await plugin.prepare(f.input);
    await expect(plugin.prepare(f.input)).rejects.toThrow('expected one Tailwind preparation');
    writeFileSync(join(f.project, 'src/card.tsx'), '<div className="block"/>');
    expect(() => plugin.verify()).toThrow('expected unchanged Tailwind inputs');
    expect(before.digest).toMatch(/^[a-f0-9]{64}$/);
  });
});
