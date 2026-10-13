import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROOT_DIR } from '../lib/config';

const SCRIPT = join(ROOT_DIR, 'scripts/release/verify-launcher-package.sh');

// A named Cargo fake emits a real archive so the verifier must inspect the
// packaged manifest rather than accidentally checking the source manifest.
const FAKE_CARGO = `#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s\\n' "$PWD" "\${RUSTUP_TOOLCHAIN:-}" >> "$CARGO_LOG"
(IFS='|'; printf '%s\\n' "$*") >> "$CARGO_LOG"
args=("$@")
target_dir=''
install_root=''
for ((index=1; index<\${#args[@]}; index++)); do
  case "\${args[index]}" in
    --target-dir) target_dir="\${args[index+1]}" ;;
    --root) install_root="\${args[index+1]}" ;;
  esac
done
case "$1" in
  package)
    if [ "\${PACKAGE_STATUS:-0}" != 0 ]; then
      echo "Cargo package failed" >&2
      exit "$PACKAGE_STATUS"
    fi
    mkdir -p "$target_dir/package"
    if [ "\${SKIP_PACKAGE:-0}" = 1 ]; then exit 0; fi
    tar -czf "$target_dir/package/mangostudio-0.1.1.crate" -C "$PACKAGE_SOURCE" mangostudio-0.1.1
    ;;
  install)
    if [ "\${INSTALL_STATUS:-0}" != 0 ]; then
      echo "Cargo install failed" >&2
      exit "$INSTALL_STATUS"
    fi
    mkdir -p "$install_root/bin" "$target_dir"
    touch "$install_root/bin/mangostudio"
    ;;
  *) echo "Unexpected Cargo command: $*" >&2; exit 99 ;;
esac
`;

interface CargoInvocation {
  cwd: string;
  toolchain: string;
  args: string[];
}

function runVerifier(
  options: {
    packagedFloor?: string | null;
    workspaceFloor?: string;
    packageStatus?: number;
    installStatus?: number;
    skipPackage?: boolean;
    tempInCheckout?: boolean;
  } = {}
) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'launcher package verifier-')));
  try {
    const repository = join(directory, 'checkout');
    const script = join(repository, 'scripts/release/verify-launcher-package.sh');
    mkdirSync(dirname(script), { recursive: true });
    copyFileSync(SCRIPT, script);
    writeFileSync(
      join(repository, 'Cargo.toml'),
      `[workspace.package]\nrust-version = "${options.workspaceFloor ?? '1.99.0'}"\n`
    );

    const source = join(directory, 'package-source');
    const packageDirectory = join(source, 'mangostudio-0.1.1');
    mkdirSync(packageDirectory, { recursive: true });
    const packagedFloor = options.packagedFloor === undefined ? '1.99.0' : options.packagedFloor;
    writeFileSync(
      join(packageDirectory, 'Cargo.toml'),
      `[package]\nname = "mangostudio"\nversion = "0.1.1"\n${packagedFloor === null ? 'rust-version.workspace = true' : `rust-version = "${packagedFloor}"`}\n`
    );

    const bin = join(directory, 'bin');
    mkdirSync(bin);
    const cargo = join(bin, 'cargo');
    writeFileSync(cargo, FAKE_CARGO);
    chmodSync(cargo, 0o755);
    const log = join(directory, 'cargo.log');
    writeFileSync(log, '');
    const temporaryRoot = join(options.tempInCheckout ? repository : directory, 'temp');
    mkdirSync(temporaryRoot);

    const result = Bun.spawnSync(['bash', script], {
      cwd: repository,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUSTUP_TOOLCHAIN: '1.96.0',
        RUNNER_TEMP: temporaryRoot,
        CARGO_LOG: log,
        PACKAGE_SOURCE: source,
        PACKAGE_STATUS: String(options.packageStatus ?? 0),
        INSTALL_STATUS: String(options.installStatus ?? 0),
        SKIP_PACKAGE: options.skipPackage ? '1' : '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const lines = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    const invocations: CargoInvocation[] = [];
    for (let index = 0; index < lines.length; index += 2) {
      const [cwd, toolchain] = lines[index].split('|');
      invocations.push({ cwd, toolchain, args: lines[index + 1].split('|') });
    }
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      invocations,
      temporaryContents: readdirSync(temporaryRoot),
      repository,
      temporaryRoot,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// The caller jobs run on Ubuntu. These fixtures assert native POSIX paths.
describe.skipIf(process.platform === 'win32')('packaged launcher verification', () => {
  test('installs the normalized package with the workspace compiler and outside-checkout paths', () => {
    const result = runVerifier();
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.invocations).toHaveLength(2);
    const [packaged, installed] = result.invocations;
    expect(packaged.toolchain).toBe('1.99.0');
    expect(installed.toolchain).toBe('1.99.0');
    expect(packaged.cwd).toBe(result.repository);
    expect(packaged.args.slice(0, 5)).toEqual([
      'package',
      '--locked',
      '--no-verify',
      '--manifest-path',
      'crates/mangostudio-launcher/Cargo.toml',
    ]);
    expect(installed.cwd.startsWith(`${result.temporaryRoot}/`)).toBe(true);
    expect(installed.cwd.startsWith(`${result.repository}/`)).toBe(false);
    expect(installed.args).toEqual([
      'install',
      '--path',
      `${installed.cwd}/source/mangostudio-0.1.1`,
      '--locked',
      '--root',
      `${installed.cwd}/install`,
      '--target-dir',
      `${installed.cwd}/install-target`,
    ]);
    expect(packaged.args.at(-1)).toBe(`${installed.cwd}/package-target`);
    expect(result.stdout).toContain(
      'rust-version=1.99.0 and isolated cargo install with Rust 1.99.0'
    );
    expect(result.temporaryContents).toEqual([]);
  });

  test('rejects a package that exposes the old compiler floor before installing', () => {
    const result = runVerifier({ packagedFloor: '1.96.0' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Invalid packaged launcher rust-version '1.96.0'; expected '1.99.0'"
    );
    expect(result.invocations).toHaveLength(1);
    expect(result.temporaryContents).toEqual([]);
  });

  test('rejects a package whose MSRV still depends on a workspace', () => {
    const result = runVerifier({ packagedFloor: null });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Invalid packaged launcher rust-version '<missing>'; expected '1.99.0'"
    );
    expect(result.invocations).toHaveLength(1);
  });

  test('rejects an invalid workspace floor before invoking Cargo', () => {
    const result = runVerifier({ workspaceFloor: '1.99' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Invalid workspace rust-version '1.99'; expected a major.minor.patch version"
    );
    expect(result.invocations).toEqual([]);
  });

  test('rejects a temporary directory inside the checkout', () => {
    const result = runVerifier({ tempInCheckout: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('expected a temporary directory outside');
    expect(result.invocations).toEqual([]);
    expect(result.temporaryContents).toEqual([]);
  });

  test('preserves a packaging failure and cleans its temporary directory', () => {
    const result = runVerifier({ packageStatus: 17 });
    expect(result.exitCode).toBe(17);
    expect(result.stderr).toContain('Cargo package failed');
    expect(result.invocations).toHaveLength(1);
    expect(result.temporaryContents).toEqual([]);
  });

  test('reports a missing Cargo package before installing', () => {
    const result = runVerifier({ skipPackage: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Invalid launcher package count '0'; expected one mangostudio-*.crate archive"
    );
    expect(result.invocations).toHaveLength(1);
    expect(result.temporaryContents).toEqual([]);
  });

  test('preserves an installation failure and cleans its temporary directory', () => {
    const result = runVerifier({ installStatus: 19 });
    expect(result.exitCode).toBe(19);
    expect(result.stderr).toContain('Cargo install failed');
    expect(result.stdout).not.toContain('Verified packaged launcher');
    expect(result.invocations).toHaveLength(2);
    expect(result.temporaryContents).toEqual([]);
  });
});
