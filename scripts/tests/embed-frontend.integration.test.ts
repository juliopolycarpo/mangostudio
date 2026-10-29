import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderFrontendManifestModule } from '../lib/embed-frontend';

test('native compilation embeds HTML and CSS file-loader values as paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-frontend-manifest-'));
  const distDir = join(directory, 'dist');
  mkdirSync(distDir);
  writeFileSync(join(distDir, 'index.html'), '<html>native manifest</html>');
  writeFileSync(join(distDir, 'styles.css'), 'body { color: red; }');
  writeFileSync(
    join(directory, 'frontend-manifest.ts'),
    renderFrontendManifestModule(distDir, ['/index.html', '/styles.css'])
  );
  const entry = join(directory, 'entry.ts');
  writeFileSync(
    entry,
    `import { embeddedFrontend } from './frontend-manifest';
console.log(await Bun.file(embeddedFrontend['/index.html']).text());
console.log(await Bun.file(embeddedFrontend['/styles.css']).text());
`
  );
  const binary = join(directory, process.platform === 'win32' ? 'manifest.exe' : 'manifest');

  try {
    const compiled = Bun.spawnSync(
      [process.execPath, 'build', entry, '--compile', '--aot', '--outfile', binary],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    expect(
      compiled.exitCode,
      `expected native manifest compilation to succeed; received ${compiled.stderr.toString()}`
    ).toBe(0);
    const result = Bun.spawnSync([binary], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim().split(/\r?\n/)).toEqual([
      '<html>native manifest</html>',
      'body { color: red; }',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
