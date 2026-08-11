/**
 * Provenance for a committed vendor contract: what produced it, from which
 * binary, when, and a checksum over the result.
 *
 * The checksum is the reason this file exists. Without it, a regeneration that
 * produced byte-identical output is indistinguishable from one that was never
 * run — and "I regenerated it and nothing changed" is the single most common
 * thing a maintainer will want to be sure about after bumping a pin.
 *
 * `capturedAt` and `capturedFrom` are *provenance*, not contract. They are
 * carried along, reported when they move, and never fail a check: a capture
 * taken from a newer binary that produced the same shapes is exactly the
 * outcome the pinning discipline is hoping for. `regen` only rewrites them when
 * the digest or the observed version actually changed, which is what keeps
 * running it twice in a row a no-op.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MANIFEST_FILENAME = 'manifest.json';

export interface ContractManifest {
  /** The contract set's id, so a manifest read on its own says what it is. */
  readonly set: string;
  /** Exactly what a maintainer runs to reproduce this capture. */
  readonly command: string;
  /** The vendor build the capture came off, verbatim. */
  readonly capturedFrom: string;
  /** ISO date, day resolution. A capture is not precise to the second. */
  readonly capturedAt: string;
  /** `sha256:…` over every artifact file except this manifest. */
  readonly checksum: string;
  /**
   * Per-file digests, so a single changed artifact is nameable.
   *
   * Omitted for a set whose artifacts are a generated tree: 285 digests would
   * bury the one line of the manifest a reviewer needs, and the tree diff
   * already names every file that moved.
   */
  readonly files?: Readonly<Record<string, string>>;
}

function digest(content: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/**
 * Every artifact under a contract directory, manifest excluded, path-sorted.
 *
 * Recursive because Codex's generator emits a tree, and keyed on the
 * directory-relative path so two captures compare by name rather than by
 * traversal order.
 */
export async function readArtifacts(directory: string): Promise<Map<string, string>> {
  const artifacts = new Map<string, string>();
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(current, entry.name), relative);
        continue;
      }
      if (!entry.isFile() || relative === MANIFEST_FILENAME) continue;
      artifacts.set(relative, await readFile(join(current, entry.name), 'utf8'));
    }
  };
  await walk(directory, '');
  return artifacts;
}

/** Per-file digests plus one over the whole set, both derived from the same bytes. */
export function digestArtifacts(artifacts: ReadonlyMap<string, string>): {
  readonly checksum: string;
  readonly files: Record<string, string>;
} {
  const files: Record<string, string> = {};
  const combined = createHash('sha256');
  for (const name of [...artifacts.keys()].sort()) {
    const content = artifacts.get(name) ?? '';
    files[name] = digest(content);
    // The name goes into the set digest too, so renaming a file changes it.
    // Escaped, not literal: a raw NUL in the source makes git call this
    // file binary, and `git show` then refuses to diff it.
    combined.update(name).update('\u0000').update(content).update('\u0000');
  }
  return { checksum: `sha256:${combined.digest('hex')}`, files };
}

async function readManifest(directory: string): Promise<ContractManifest | undefined> {
  const raw = await readFile(join(directory, MANIFEST_FILENAME), 'utf8').catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as ContractManifest;
  } catch {
    return undefined;
  }
}

/**
 * Writes the manifest, keeping `capturedAt` when nothing about the capture
 * moved.
 *
 * Rewriting the date unconditionally would make `regen` produce a diff every
 * time it ran, which would in turn make "run it twice and commit nothing" —
 * the cheapest possible idempotence check — impossible to state.
 */
export async function writeManifest(
  directory: string,
  input: {
    readonly set: string;
    readonly command: string;
    readonly capturedFrom: string;
    readonly artifacts: ReadonlyMap<string, string>;
    readonly today: string;
    /** False for a generated tree, where the diff already names every file. */
    readonly perFileDigests: boolean;
  }
): Promise<ContractManifest> {
  const previous = await readManifest(directory);
  const { checksum, files } = digestArtifacts(input.artifacts);
  const unchanged =
    previous?.checksum === checksum &&
    previous?.capturedFrom === input.capturedFrom &&
    previous?.command === input.command;
  const manifest: ContractManifest = {
    set: input.set,
    command: input.command,
    capturedFrom: input.capturedFrom,
    capturedAt: unchanged ? previous.capturedAt : input.today,
    checksum,
    ...(input.perFileDigests ? { files } : {}),
  };
  await writeFile(join(directory, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
