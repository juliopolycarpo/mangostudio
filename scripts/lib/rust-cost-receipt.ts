import { summarizeLatencies } from './latency-stats';

export interface BuildCpuReceipt {
  readonly userSeconds: number;
  readonly systemSeconds: number;
  readonly elapsedSeconds: number;
  /** GNU time's maximum individual-process RSS; never a process-tree peak. */
  readonly maxIndividualRssKb: number;
}

/** Parses the fixed GNU-time machine format, rejecting missing/ambiguous observations. Example: parseBuildCpu('1.20 0.30 2048 1.50'). */
export function parseBuildCpu(text: string): BuildCpuReceipt {
  const match = /^(\d+(?:\.\d+)?) (\d+(?:\.\d+)?) (\d+) (\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!match)
    throw new Error(
      `GNU time: expected user-seconds system-seconds max-RSS-KiB elapsed-seconds | received: ${JSON.stringify(text)}`
    );
  const [userSeconds, systemSeconds, maxIndividualRssKb, elapsedSeconds] = match
    .slice(1)
    .map(Number);
  if (
    ![userSeconds, systemSeconds, maxIndividualRssKb, elapsedSeconds].every(Number.isFinite) ||
    !Number.isSafeInteger(maxIndividualRssKb)
  )
    throw new Error(
      `GNU time: expected finite nonnegative counters | received: ${JSON.stringify(text)}`
    );
  return { userSeconds, systemSeconds, maxIndividualRssKb, elapsedSeconds };
}

export interface ArtifactSection {
  readonly name: string;
  readonly bytes: number;
  readonly address: string;
}

/** Parses `size -A -d` without conflating file size and allocatable sections. Example: parseArtifactSections('a :\nsection size addr\n.text 100 4096\nTotal 100\n'). */
export function parseArtifactSections(text: string): ArtifactSection[] {
  const sections: ArtifactSection[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\.[^\s]+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) {
      if (line.trim().startsWith('.') && !line.trim().endsWith(':'))
        throw new Error(
          `Artifact section: expected name decimal-bytes decimal-address | received: ${line}`
        );
      continue;
    }
    const bytes = Number(match[2]);
    if (!Number.isSafeInteger(bytes) || sections.some((section) => section.name === match[1]))
      throw new Error(
        `Artifact section: expected unique section and safe byte count | received: ${line}`
      );
    sections.push({ name: match[1], bytes, address: match[3] });
  }
  if (!sections.some((section) => section.name === '.text'))
    throw new Error(
      `Artifact sections: expected .text in size -A -d output | received: ${JSON.stringify(text)}`
    );
  return sections;
}

/** Qualifies symbol attribution only for identical machine code. Example: qualifiesTextAttribution(strippedHash, unstrippedHash). */
export function qualifiesTextAttribution(
  measuredTextSha256: string,
  symbolTextSha256: string
): boolean {
  const shape = /^[a-f0-9]{64}$/;
  if (!shape.test(measuredTextSha256) || !shape.test(symbolTextSha256))
    throw new Error('Text identity: expected two lowercase SHA-256 hashes');
  return measuredTextSha256 === symbolTextSha256;
}

export interface RustCostWorkload {
  readonly label: string;
  readonly package: string;
  readonly target: string;
  readonly stamp: string;
  readonly emptyTarget: boolean;
}

/** Freezes separate baseline workloads; alternation never implies an optimization candidate. Example: rustCostWorkloads('0.1.1'). */
export function rustCostWorkloads(version: string): RustCostWorkload[] {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`Application version: expected x.y.z | received: ${JSON.stringify(version)}`);
  const workloads: RustCostWorkload[] = [];
  for (const [kind, packageName] of [
    ['runtime', 'mangostudio-runtime'],
    ['launcher', 'mangostudio'],
  ] as const) {
    for (let index = 1; index <= 3; index += 1)
      workloads.push({
        label: `${kind}-empty-${index}`,
        package: packageName,
        target: `${kind}-${index}`,
        stamp: version,
        emptyTarget: true,
      });
  }
  let stamp = version;
  for (let index = 1; index <= 10; index += 1) {
    workloads.push({
      label: `runtime-noop-${index}`,
      package: 'mangostudio-runtime',
      target: 'runtime-3',
      stamp,
      emptyTarget: false,
    });
    stamp = `${version}-bench.${index}`;
    workloads.push({
      label: `runtime-restamp-${index}`,
      package: 'mangostudio-runtime',
      target: 'runtime-3',
      stamp,
      emptyTarget: false,
    });
  }
  return workloads;
}

/** Summarizes completed baseline attempts by workload, retaining raw failures elsewhere. Example: summarizeRustCosts(attempts). */
export function summarizeRustCosts(
  attempts: readonly { label: string; valid: boolean; durationMs: number }[]
): Record<string, ReturnType<typeof summarizeLatencies>> {
  const groups = new Map<string, number[]>();
  for (const attempt of attempts) {
    if (!attempt.valid) continue;
    if (!Number.isFinite(attempt.durationMs) || attempt.durationMs < 0)
      throw new Error(
        `Build duration: expected finite nonnegative milliseconds | received: ${attempt.durationMs}`
      );
    const group = attempt.label.replace(/-\d+$/, '');
    groups.set(group, [...(groups.get(group) ?? []), attempt.durationMs]);
  }
  return Object.fromEntries(
    [...groups].map(([group, values]) => [group, summarizeLatencies(values)])
  );
}

/** Pins the declared shipping profile against Cargo-home profile overrides. Example: shippingRustProfile(await Bun.file('Cargo.toml').text()). */
export function shippingRustProfile(manifest: string): string[] {
  const parsed = Bun.TOML.parse(manifest) as { profile?: { release?: Record<string, unknown> } };
  const expected = { 'opt-level': 3, lto: 'fat', 'codegen-units': 1, strip: true, panic: 'unwind' };
  for (const [field, value] of Object.entries(expected)) {
    if (parsed.profile?.release?.[field] !== value)
      throw new Error(
        `Shipping release profile ${field}: expected ${JSON.stringify(value)} | received: ${JSON.stringify(parsed.profile?.release?.[field])}`
      );
  }
  return Object.entries(expected).flatMap(([field, value]) => [
    '--config',
    `profile.release.${field}=${JSON.stringify(value)}`,
  ]);
}

/** Qualifies unchanged and stamp-only rebuilds as distinct workloads. Example: qualifiesRustIncremental('restamp', before, after, 1). */
export function qualifiesRustIncremental(
  kind: 'noop' | 'restamp',
  before: string | undefined,
  after: string,
  compiledUnits: number
): boolean {
  if (!before) return false;
  if (![before, after].every((hash) => /^[a-f0-9]{64}$/.test(hash)))
    throw new Error('Incremental artifact identity: expected lowercase SHA-256 hashes');
  return kind === 'noop'
    ? before === after && compiledUnits === 0
    : before !== after && compiledUnits === 1;
}
