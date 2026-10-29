import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ROOT_DIR } from '../../lib/config';
import { ALL_BINARY_TARGETS, type ReleasePlatformId } from '../../lib/release-targets';
import { cargoRuntimeOutputPath } from '../../lib/runtime-build';

const SOURCE_SHA = 'abcdef0123456789abcdef0123456789abcdef01';

/** Minimal source inputs and named git/cargo/bun fakes for the real packaging CLI. */
export class FakeNativeBuildInputs {
  readonly root = mkdtempSync(join(tmpdir(), 'native-build-command-'));
  readonly command = join(this.root, 'scripts/lib/build.mjs');
  readonly fakeBin = join(this.root, 'fake-bin');
  readonly runtime = join(this.root, 'fake-runtime');
  readonly version = '1.2.3';

  constructor(readonly platform: ReleasePlatformId) {}

  private write(relative: string, content: string, executable = false): void {
    const path = join(this.root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    if (executable) chmodSync(path, 0o755);
  }

  /** Bundle the actual CLI and prepare inputs without Cargo or a frontend build. @example await fake.prepare(); */
  async prepare(): Promise<void> {
    this.write('package.json', JSON.stringify({ version: this.version, type: 'module' }));
    this.write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '#build-value': ['./root-value.ts'] } },
      })
    );
    this.write('root-value.ts', "export const value = 'root-config';\n");
    this.write(
      'apps/api/tsconfig.json',
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '#build-value': ['./api-value.ts'] } },
      })
    );
    this.write('apps/api/api-value.ts', "export const value = 'api-config';\n");
    this.write(
      'apps/api/src/index.ts',
      "import { value } from '#build-value';\nconsole.log(value);\n"
    );
    this.write(
      'apps/api/src/server/embedded-frontend.ts',
      'export function registerEmbeddedFrontend(_files: Record<string, string>, _encodings: Record<string, Record<string, string>>) {}\n'
    );
    this.write('apps/frontend/dist/index.html', '<html>packaging fixture</html>');
    this.write(
      'apps/frontend/dist/build-info.json',
      JSON.stringify({
        gitSha: SOURCE_SHA.slice(0, 12),
        gitDirty: false,
        builtAt: '2026-01-01T00:00:00.000Z',
        buildType: 'production',
      })
    );
    this.write('fake-runtime.ts', `console.log(${JSON.stringify(this.version)});\n`);
    this.write('fake-bin/bun', '#!/bin/sh\necho "unexpected PATH compiler" >&2\nexit 91\n', true);
    this.write(
      'fake-bin/git',
      `#!/bin/sh\ncase "$*" in\n  'rev-parse HEAD') echo '${SOURCE_SHA}';;\n  'rev-parse --short=12 HEAD') echo '${SOURCE_SHA.slice(0, 12)}';;\n  'status --porcelain') exit 0;;\n  *) echo "unexpected fake git arguments: $*" >&2; exit 92;;\nesac\n`,
      true
    );
    this.write(
      'fake-bin/cargo',
      '#!/bin/sh\nexec cp "$NATIVE_BUILD_FAKE_RUNTIME" "$NATIVE_BUILD_FAKE_TARGET"\n',
      true
    );
    const target = ALL_BINARY_TARGETS.find((candidate) => candidate.arch === this.platform);
    if (!target) throw new Error(`expected release platform | received: ${this.platform}`);
    mkdirSync(dirname(cargoRuntimeOutputPath(join(this.root, 'target'), target)), {
      recursive: true,
    });
    const compiled = Bun.spawnSync(
      [
        process.execPath,
        'build',
        join(this.root, 'fake-runtime.ts'),
        '--compile',
        '--outfile',
        this.runtime,
      ],
      { stdout: 'pipe', stderr: 'pipe', timeout: 30000 }
    );
    if (compiled.exitCode !== 0)
      throw new Error(
        `expected fake runtime compile exit 0 | received: ${compiled.exitCode} ${compiled.stderr.toString()}`
      );
    const bundle = await Bun.build({
      entrypoints: [join(ROOT_DIR, 'scripts/build.ts')],
      outdir: dirname(this.command),
      naming: 'build.mjs',
      target: 'bun',
      format: 'esm',
      packages: 'bundle',
    });
    if (!bundle.success)
      throw new Error(
        `expected packaging CLI bundle | received: ${bundle.logs.map((message) => message.message).join('\n')}`
      );
  }

  /** Run packaging with PATH compiler shadowed and all runtime outputs inside the fixture. @example fake.run(); */
  run() {
    const target = ALL_BINARY_TARGETS.find((candidate) => candidate.arch === this.platform);
    if (!target) throw new Error(`expected release platform | received: ${this.platform}`);
    return Bun.spawnSync(
      [process.execPath, this.command, '--binary', '--reuse-frontend', '--platform', this.platform],
      {
        cwd: this.root,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30000,
        env: {
          ...process.env,
          PATH: `${this.fakeBin}:${process.env.PATH ?? ''}`,
          VERSION: this.version,
          CARGO_TARGET_DIR: join(this.root, 'target'),
          RUNTIME_DIR: '',
          DRY_RUN: '',
          NATIVE_BUILD_FAKE_RUNTIME: this.runtime,
          NATIVE_BUILD_FAKE_TARGET: cargoRuntimeOutputPath(join(this.root, 'target'), target),
        },
      }
    );
  }

  /** Remove only the fixture's temporary inputs and outputs. @example fake.dispose(); */
  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
