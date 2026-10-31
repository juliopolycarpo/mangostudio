import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { sha256File } from '../release/verify-checksum';
import { parseArtifactSections, qualifiesTextAttribution } from './rust-cost-receipt';

export interface ArtifactInspector {
  readonly capture: (label: string, command: readonly string[]) => Promise<string>;
  readonly hash: (path: string) => string | Promise<string>;
}

export interface RustArtifactReceipt {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly textSha256: string;
  readonly sections: ReturnType<typeof parseArtifactSections>;
  readonly readelf: string;
}

/** Inspects an artifact without altering it; outputs are private files. Example: inspectRustArtifact(binary, out, inspector). */
export async function inspectRustArtifact(
  binary: string,
  out: string,
  inspector: ArtifactInspector
): Promise<RustArtifactReceipt> {
  await mkdir(out, { recursive: true });
  const before = await inspector.hash(binary);
  const sections = parseArtifactSections(
    await inspector.capture('sections', ['size', '-A', '-d', binary])
  );
  const readelf = await inspector.capture('elf', ['readelf', '-h', '-S', '-W', binary]);
  const text = join(out, 'text.bin');
  const object = join(out, 'inspection-copy.elf');
  try {
    await inspector.capture('text', ['objcopy', '--dump-section', `.text=${text}`, binary, object]);
    const textSha256 = await inspector.hash(text);
    const after = await inspector.hash(binary);
    if (after !== before)
      throw new Error(
        `Artifact identity: expected unchanged SHA-256 ${before} | received: ${after}`
      );
    return {
      path: binary,
      bytes: (await stat(binary)).size,
      sha256: after,
      textSha256,
      sections,
      readelf,
    };
  } finally {
    await rm(object, { force: true });
  }
}

/** Preserves the measured artifact with its source-bound receipt. Example: preserveRustArtifact(source, output). */
export async function preserveRustArtifact(
  source: string,
  output: string
): Promise<{ path: string; bytes: number; sha256: string }> {
  await copyFile(source, output);
  const before = await sha256File(source);
  const after = await sha256File(output);
  if (before !== after)
    throw new Error(`Artifact copy: expected SHA-256 ${before} | received: ${after}`);
  return { path: output, bytes: (await stat(output)).size, sha256: after };
}

/** Records attribution as qualified only when both code sections agree. Example: attributeRustArtifact(measured, symbols, json). */
export function attributeRustArtifact(
  measured: RustArtifactReceipt,
  symbols: RustArtifactReceipt,
  cargoBloatJson: string
) {
  const bloat: unknown = JSON.parse(cargoBloatJson);
  if (
    !bloat ||
    typeof bloat !== 'object' ||
    !Array.isArray((bloat as Record<string, unknown>).crates)
  )
    throw new Error('cargo bloat: expected JSON object with crates array');
  const fields = bloat as Record<string, unknown>;
  const textBytes = symbols.sections.find((section) => section.name === '.text')?.bytes;
  if (
    fields['file-size'] !== symbols.bytes ||
    fields['text-section-size'] !== textBytes ||
    !Number.isSafeInteger(textBytes)
  )
    throw new Error(
      'cargo bloat: expected file/text byte counts matching the inspected symbol artifact'
    );
  for (const crate of fields.crates as unknown[]) {
    if (
      !crate ||
      typeof crate !== 'object' ||
      typeof (crate as Record<string, unknown>).name !== 'string' ||
      !Number.isSafeInteger((crate as Record<string, unknown>).size) ||
      Number((crate as Record<string, unknown>).size) < 0
    )
      throw new Error('cargo bloat crate: expected name string and nonnegative safe integer size');
  }
  return {
    qualified: qualifiesTextAttribution(measured.textSha256, symbols.textSha256),
    measuredSha256: measured.sha256,
    symbolsSha256: symbols.sha256,
    measuredTextSha256: measured.textSha256,
    symbolsTextSha256: symbols.textSha256,
    scope: 'host GNU baseline; does not attribute a different distribution artifact',
    bloat,
  };
}

/** Identifies the downloader from sealed package metadata without executing it. Runtime versions use isolated caller-owned execution. Example: identifyRustArtifactVersion('mangostudio', manifest, binary, stamp, capture). */
export async function identifyRustArtifactVersion(
  packageName: string,
  manifest: string,
  binary: string,
  stamp: string,
  capture: (command: readonly string[]) => Promise<string>
): Promise<{
  version: string;
  expected: string;
  valid: boolean;
  source: string;
  executed: boolean;
}> {
  const parsed = Bun.TOML.parse(manifest) as { package?: { name?: unknown; version?: unknown } };
  if (parsed.package?.name !== packageName || typeof parsed.package.version !== 'string')
    throw new Error(
      `Artifact package: expected ${packageName} with explicit package.version | received: ${JSON.stringify(parsed.package)}`
    );
  if (packageName === 'mangostudio')
    return {
      version: parsed.package.version,
      expected: parsed.package.version,
      valid: true,
      source: 'sealed launcher Cargo package metadata',
      executed: false,
    };
  if (packageName !== 'mangostudio-runtime')
    throw new Error(
      `Artifact package: expected mangostudio | mangostudio-runtime | received: ${packageName}`
    );
  const version = (await capture([binary, '--version'])).trim();
  return {
    version,
    expected: stamp,
    valid: version === stamp,
    source: 'runtime --version under isolated home',
    executed: true,
  };
}

/** Seals every produced Rust library while ignoring unrelated compiler metadata. Example: await rustLibraryHashes('target/release/deps'). */
export async function rustLibraryHashes(directory: string): Promise<Record<string, string>> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.rlib')).sort();
  if (!names.length)
    throw new Error(
      `Rust library directory: expected at least one .rlib | received: ${directory} contains none`
    );
  return Object.fromEntries(names.map((name) => [name, sha256File(join(directory, name))]));
}
