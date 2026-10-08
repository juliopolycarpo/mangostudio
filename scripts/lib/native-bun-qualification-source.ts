import { createHash } from 'node:crypto';
import { readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

interface SourceFileSeal {
  readonly path: string;
  readonly mode: string;
  readonly object: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface SourceSeal {
  readonly head: string;
  readonly tree: string;
  readonly status: string;
  readonly sha256: string;
  readonly files: readonly SourceFileSeal[];
}

export interface ArtifactSeal {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface NativeCompilerArtifact {
  readonly packageId: string;
  readonly target: string;
  readonly kind: readonly string[];
  readonly features: readonly string[];
  readonly executable: string | null;
  readonly filenames: readonly string[];
}

/**
 * Preserve Cargo's actual compiled feature sets and require its successful final JSON receipt.
 * @example nativeCompilerArtifacts(await Bun.file('/out/logs/build-runtime.stdout.log').text());
 */
export function nativeCompilerArtifacts(log: string): NativeCompilerArtifact[] {
  const artifacts: NativeCompilerArtifact[] = [];
  let finished = false;
  for (const line of log.split('\n').filter((line) => line.trim())) {
    const value = JSON.parse(line);
    if (value.reason === 'build-finished') finished = value.success === true;
    if (value.reason !== 'compiler-artifact') continue;
    if (
      typeof value.package_id !== 'string' ||
      typeof value.target?.name !== 'string' ||
      !Array.isArray(value.target?.kind) ||
      !Array.isArray(value.features) ||
      !value.features.every((feature: unknown) => typeof feature === 'string') ||
      !Array.isArray(value.filenames)
    ) {
      throw new Error(
        `Invalid compiler artifact ${line}; expected package, target, features, and filenames`
      );
    }
    artifacts.push({
      packageId: value.package_id,
      target: value.target.name,
      kind: value.target.kind,
      features: value.features,
      executable: value.executable ?? null,
      filenames: value.filenames,
    });
  }
  if (!finished || artifacts.length === 0)
    throw new Error(
      'Missing or truncated Cargo build receipt; expected compiler artifacts and successful build-finished'
    );
  return artifacts;
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(['git', '--no-optional-locks', ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });
  const [out, error, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${exit}: ${error}; expected a readable checkout`);
  }
  return out;
}

async function trackedSourceBytes(path: string, mode: string): Promise<Buffer> {
  if (mode !== '120000') return readFile(path);
  try {
    return Buffer.from(await readlink(path));
  } catch (error) {
    throw new Error(
      `Invalid tracked symlink ${path}: ${String(error)}; expected filesystem symlink matching Git mode 120000`,
      { cause: error }
    );
  }
}

/**
 * Seal HEAD, its tree, index entries, and the actual bytes of every tracked file.
 * CRLF checkouts keep their actual byte hashes, even when git normalizes them.
 * @example const before = await sealNativeSource('/checkout');
 */
export async function sealNativeSource(root: string): Promise<SourceSeal> {
  const [head, tree, status, index] = await Promise.all([
    git(root, ['rev-parse', 'HEAD']),
    git(root, ['rev-parse', 'HEAD^{tree}']),
    git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
    git(root, ['ls-files', '--stage', '-z']),
  ]);
  const files: SourceFileSeal[] = [];
  for (const entry of index.split('\0').filter(Boolean)) {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t(.+)$/s.exec(entry);
    if (match?.[3] !== '0' || !['100644', '100755', '120000'].includes(match[1])) {
      throw new Error(
        `Invalid tracked entry ${JSON.stringify(entry)}; expected a stage-0 regular file or symlink`
      );
    }
    const path = match[4];
    const file = join(root, path);
    const bytes = await trackedSourceBytes(file, match[1]);
    files.push({
      path,
      mode: match[1],
      object: match[2],
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return {
    head: head.trim(),
    tree: tree.trim(),
    status,
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    files,
  };
}

/** Hash the exact executable supplied to the test command. @example await sealNativeArtifact('/out/runtime'); */
export async function sealNativeArtifact(path: string): Promise<ArtifactSeal> {
  const bytes = await readFile(path);
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Compare seals without allowing a clean normalized git status to hide byte changes. @example nativeSourceChanged(before, after); */
export function nativeSourceChanged(before: SourceSeal, after: SourceSeal): boolean {
  return before.head !== after.head || before.tree !== after.tree || before.sha256 !== after.sha256;
}
