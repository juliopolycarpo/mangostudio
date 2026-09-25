#!/usr/bin/env bun
// Build the cargo `mangostudio-runtime` for one or more release platforms and
// lay it out the way `bun run build --binary --runtime-dir <dir>` stages it:
// `<out>/<platform-id>/mangostudio-runtime[.exe]`. The distribution's runtime
// legs run this once per OS family; it verifies every binary it produces from
// its header, and asks it its version when this machine can run it.
// Dependency-free: CI runs it with `bun --no-install`.
// Usage: bun run build:runtime [--platform <ids>] [--os linux|darwin|windows] [--zig] [--rustup] [--dev] [--out <dir>]

import { chmodSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { assertNoUnexpectedArguments, fatal, parseArgs } from './lib/args';
import { ROOT_DIR } from './lib/config';
import { runCommand } from './lib/exec';
import { header, log, success } from './lib/log';
import type { BinaryTarget } from './lib/release-targets';
import { resolveReleaseVersion } from './lib/release-version';
import {
  cargoRuntimeBuildCommand,
  cargoRuntimeOutputPath,
  hostPlatformId,
  prebuiltRuntimePath,
  RUNTIME_RELEASE_VERSION_ENV,
  runtimeBuildVersion,
  rustTargetTriple,
  selectRuntimeTargets,
  verifyRuntimeBinary,
} from './lib/runtime-build';

function printHelp(): never {
  console.log(`Usage: bun run build:runtime [--platform <ids>] [--os <os>] [--zig] [--rustup] [--dev] [--out <dir>]

Builds the cargo mangostudio-runtime into <out>/<platform-id>/mangostudio-runtime[.exe].

Flags:
  --platform <ids>  Comma- or space-separated platform ids (default: every platform)
  --os <os>         Keep only the selected platforms for linux, darwin, or windows
  --zig             Link Linux targets through cargo-zigbuild (glibc floor, musl toolchain)
  --rustup          Install each target's Rust standard library first (rustup target add)
  --dev             Stamp the runtime \`dev\`, the version a source checkout's hub accepts
  --out <dir>       Output directory (default: .mango/runtime)
  --help            Show this help message`);
  process.exit(0);
}

async function buildOne(
  target: BinaryTarget,
  context: { outDir: string; version: string; zig: boolean; rustup: boolean }
): Promise<void> {
  const command = cargoRuntimeBuildCommand(target.arch, { zig: context.zig });
  header(`Runtime ${target.arch} (${command.at(-1)})`);
  if (context.rustup) {
    const triple = rustTargetTriple(target.arch);
    const added = await runCommand(`rustup:${triple}`, ['rustup', 'target', 'add', triple], {
      cwd: ROOT_DIR,
    });
    if (added.exitCode !== 0) fatal(`rustup target add ${triple} exited ${added.exitCode}.`);
  }
  const result = await runCommand(`runtime:${target.arch}`, command, {
    cwd: ROOT_DIR,
    env: { [RUNTIME_RELEASE_VERSION_ENV]: context.version },
  });
  if (result.exitCode !== 0) {
    fatal(`cargo exited ${result.exitCode} building the ${target.arch} runtime.`);
  }

  const targetDir = process.env.CARGO_TARGET_DIR ?? join(ROOT_DIR, 'target');
  const built = cargoRuntimeOutputPath(targetDir, target);
  const staged = prebuiltRuntimePath(context.outDir, target);
  mkdirSync(dirname(staged), { recursive: true });
  copyFileSync(built, staged);
  if (process.platform !== 'win32') chmodSync(staged, 0o755);

  const verification = await verifyRuntimeBinary({
    path: staged,
    target,
    version: context.version,
    hostPlatform: hostPlatformId(),
    // Only a zig link pins the floor; a plain host build links the host glibc.
    enforceGlibcFloor: context.zig,
  });
  if (verification.problems.length > 0) {
    fatal(`Runtime ${target.arch} failed verification:\n  ${verification.problems.join('\n  ')}`);
  }
  const { header: found, reportedVersion } = verification;
  log(
    `  ${staged}: ${found?.format} ${found?.arch}` +
      (found?.maxGlibc ? `, max GLIBC_${found.maxGlibc}` : '') +
      (reportedVersion ? `, --version ${reportedVersion}` : ', not runnable here') +
      `, ${statSync(staged).size} bytes`
  );
}

if (import.meta.main) {
  const { flags, values, positional } = parseArgs({
    booleanFlags: ['--zig', '--rustup', '--dev'],
    valueFlags: ['--platform', '--os', '--out'],
  });
  if (flags['--help']) printHelp();
  assertNoUnexpectedArguments(positional);

  let targets: BinaryTarget[];
  let version: string;
  try {
    targets = selectRuntimeTargets(values['--platform'], values['--os']);
    version = runtimeBuildVersion({ dev: flags['--dev'] ?? false }, resolveReleaseVersion);
  } catch (caught) {
    fatal(caught instanceof Error ? caught.message : String(caught));
  }
  if (targets.length === 0) fatal('No runtime platform matches --platform and --os.');

  const out = values['--out'] ?? join('.mango', 'runtime');
  const outDir = isAbsolute(out) ? out : join(ROOT_DIR, out);
  for (const target of targets) {
    await buildOne(target, {
      outDir,
      version,
      zig: flags['--zig'] ?? false,
      rustup: flags['--rustup'] ?? false,
    });
  }
  success(`Built ${targets.length} runtime(s) at v${version} into ${outDir}`);
}
