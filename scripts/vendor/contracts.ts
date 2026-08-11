/**
 * Regenerates — or drift-checks — every committed vendor contract.
 *
 *   bun run vendor-contracts:regen              recapture everything available
 *   bun run vendor-contracts:regen --only cursor-acp
 *   bun run vendor-contracts:check              diff, and exit non-zero on a break
 *
 * Three vendor surfaces are pinned, and each is committed so a version bump
 * shows up as a reviewable diff instead of a silent behaviour change. On a bump
 * the diff *is* the changelog, which is the whole reason the output is in the
 * repository rather than generated during the build.
 *
 * ## What fails, and what is only reported
 *
 * A vendor **removing or changing** something a capture recorded fails the
 * check: that is the case where an adapter is reading a field that is gone. A
 * vendor **adding** something is reported and nothing more. Every one of these
 * CLIs ships constantly and almost all of that motion is additive, so a check
 * that failed on all of it would be red most weeks and would train maintainers
 * to rerun it rather than read it. The adapters ignore what they do not
 * recognize by construction, which is what makes tolerating additions safe.
 *
 * ## Why this is not part of `bun run check`
 *
 * It needs vendor binaries that a contributor's machine will not have. Making
 * the repository's main gate depend on three third-party CLIs would be a poor
 * trade, so this runs in its own workflow. A set whose tool is missing is
 * **skipped loudly** and counted — a green check that verified nothing is the
 * worst outcome available here, so `--check` reports what it could not look at
 * and `--require-all` turns that into a failure for the scheduled job.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseArgs } from '../lib/args';
import { error, info, success, warn } from '../lib/log';
import type { VendorContractSet } from './lib/contract-set';
import { type ContractChange, diffCaptures, formatChange, isBreaking } from './lib/diff';
import { readArtifacts, writeManifest } from './lib/manifest';
import { claudeContractSet } from './sets/claude';
import { codexContractSet } from './sets/codex';
import { cursorContractSet } from './sets/cursor';

const ROOT_DIR = join(import.meta.dir, '..', '..');
const CONTRACT_SETS: readonly VendorContractSet[] = [
  codexContractSet,
  cursorContractSet,
  claudeContractSet,
];

interface SetOutcome {
  readonly id: string;
  readonly status: 'matched' | 'additive' | 'broken' | 'skipped';
  readonly changes: readonly ContractChange[];
  readonly observedVersion?: string;
}

/** Captures into a fresh temporary directory and hands back its artifacts. */
async function captureInto(set: VendorContractSet): Promise<Map<string, string>> {
  const staging = await mkdtemp(join(tmpdir(), `${set.id}-`));
  try {
    await set.capture(staging);
    const artifacts = await readArtifacts(staging);
    if (artifacts.size === 0) throw new Error(`${set.id} produced no artifacts.`);
    return artifacts;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Every difference between what is committed and what was just captured.
 *
 * A file that appeared or disappeared is reported as a whole-file change, and a
 * file present on both sides is compared structurally when both parse as JSON.
 * Codex's generated TypeScript does not parse as JSON, so it falls back to a
 * byte comparison — for generated output that is the right granularity anyway.
 */
function diffArtifacts(
  committed: ReadonlyMap<string, string>,
  captured: ReadonlyMap<string, string>
): ContractChange[] {
  const changes: ContractChange[] = [];
  for (const [name, content] of captured) {
    const existing = committed.get(name);
    if (existing === undefined) {
      changes.push({ kind: 'added', path: name });
      continue;
    }
    if (existing === content) continue;
    const before = tryParse(existing);
    const after = tryParse(content);
    if (before === undefined || after === undefined) {
      changes.push({ kind: 'changed', path: name, before: 'committed', after: 'regenerated' });
      continue;
    }
    for (const change of diffCaptures(before, after)) {
      changes.push({ ...change, path: `${name}: ${change.path}` });
    }
  }
  for (const name of committed.keys()) {
    if (!captured.has(name)) changes.push({ kind: 'removed', path: name });
  }
  return changes;
}

function tryParse(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

async function checkSet(set: VendorContractSet): Promise<SetOutcome> {
  const observedVersion = await set.resolveVersion();
  if (observedVersion === undefined) {
    warn(`Skipping ${set.id}: its tool is not on this machine, so nothing was verified.`);
    return { id: set.id, status: 'skipped', changes: [] };
  }

  const captured = await captureInto(set);
  const committed = await readArtifacts(set.artifactsDirectory);
  const changes = diffArtifacts(committed, captured);
  if (changes.length === 0) {
    success(`${set.id} matches ${observedVersion} (${committed.size} files).`);
    return { id: set.id, status: 'matched', changes, observedVersion };
  }

  const breaking = changes.filter(isBreaking);
  for (const change of changes) console.log(formatChange(change));
  if (breaking.length === 0) {
    warn(
      `${set.id} grew ${changes.length} field(s) on ${observedVersion}. Additive, so nothing is broken — run \`bun run vendor-contracts:regen\` to record it.`
    );
    return { id: set.id, status: 'additive', changes, observedVersion };
  }
  error(
    `${set.id} no longer matches ${observedVersion}: ${breaking.length} removed or changed field(s). An adapter is reading something this build does not produce.`
  );
  return { id: set.id, status: 'broken', changes, observedVersion };
}

async function regenerateSet(set: VendorContractSet, today: string): Promise<SetOutcome> {
  const observedVersion = await set.resolveVersion();
  if (observedVersion === undefined) {
    warn(`Skipping ${set.id}: its tool is not on this machine.`);
    return { id: set.id, status: 'skipped', changes: [] };
  }

  const captured = await captureInto(set);
  const committed = await readArtifacts(set.artifactsDirectory);
  const changes = diffArtifacts(committed, captured);

  await rm(set.artifactsDirectory, { recursive: true, force: true });
  await mkdir(set.artifactsDirectory, { recursive: true });
  for (const [name, content] of captured) {
    const destination = join(set.artifactsDirectory, name);
    await mkdir(join(destination, '..'), { recursive: true });
    await Bun.write(destination, content);
  }
  await mkdir(set.manifestDirectory, { recursive: true });
  const manifest = await writeManifest(set.manifestDirectory, {
    set: set.id,
    command: set.command,
    capturedFrom: observedVersion,
    artifacts: captured,
    today,
    perFileDigests: set.perFileDigests,
  });

  success(
    `${set.id}: ${captured.size} file(s) from ${observedVersion} into ${relative(ROOT_DIR, set.artifactsDirectory)} (${manifest.checksum.slice(0, 14)}…).`
  );
  return {
    id: set.id,
    status: changes.length === 0 ? 'matched' : changes.some(isBreaking) ? 'broken' : 'additive',
    changes,
    observedVersion,
  };
}

/**
 * The step summary CI reads.
 *
 * Written unconditionally when `GITHUB_STEP_SUMMARY` is set, because the
 * interesting outcome — additive drift — does not fail the job and would
 * otherwise be invisible to anyone not reading the raw log.
 */
async function writeStepSummary(outcomes: readonly SetOutcome[]): Promise<void> {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const lines = [
    '### Vendor contract drift',
    '',
    '| Set | Version | Result |',
    '| --- | --- | --- |',
  ];
  const label = {
    matched: 'no drift',
    additive: 'additive only — not a break',
    broken: 'removed or changed fields',
    skipped: 'skipped — tool not installed',
  } as const;
  for (const outcome of outcomes) {
    lines.push(`| ${outcome.id} | ${outcome.observedVersion ?? '—'} | ${label[outcome.status]} |`);
  }
  for (const outcome of outcomes) {
    if (outcome.changes.length === 0) continue;
    lines.push('', `<details><summary>${outcome.id}</summary>`, '', '```');
    for (const change of outcome.changes) lines.push(formatChange(change));
    lines.push('```', '', '</details>');
  }
  await Bun.write(path, `${lines.join('\n')}\n`);
}

function usage(): void {
  console.log(
    'Usage: bun run vendor-contracts:regen [--only <set>] [--check] [--require-all]\n\n' +
      '  (no flags)      recapture every contract whose tool is installed\n' +
      '  --check         capture into a temporary directory and diff instead of writing\n' +
      '  --only <set>    limit to one set: codex-protocol, cursor-acp, claude-cli\n' +
      '  --require-all   fail when a set was skipped because its tool is missing\n'
  );
}

async function main(): Promise<void> {
  const { flags, values, positional } = parseArgs({
    booleanFlags: ['--check', '--require-all'],
    valueFlags: ['--only'],
  });
  if (flags['--help']) return usage();
  if (positional.length > 0) {
    error(`Unexpected argument: ${positional[0]}`);
    process.exitCode = 1;
    return;
  }

  const only = values['--only'];
  const sets = only ? CONTRACT_SETS.filter((set) => set.id === only) : CONTRACT_SETS;
  if (sets.length === 0) {
    error(`Unknown contract set "${only}". Known: ${CONTRACT_SETS.map((s) => s.id).join(', ')}.`);
    process.exitCode = 1;
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const outcomes: SetOutcome[] = [];
  for (const set of sets) {
    info(`${flags['--check'] ? 'Checking' : 'Capturing'} ${set.id}…`);
    outcomes.push(flags['--check'] ? await checkSet(set) : await regenerateSet(set, today));
  }
  await writeStepSummary(outcomes);

  const broken = outcomes.filter((outcome) => outcome.status === 'broken');
  const skipped = outcomes.filter((outcome) => outcome.status === 'skipped');
  // A regeneration that found drift has *recorded* it, which is the job it was
  // asked to do. Only `--check` turns drift into an exit code; failing here
  // would mean the one command that fixes the problem also reports failure.
  if (!flags['--check']) {
    if (broken.length > 0) {
      warn(
        `Recorded removed or changed fields in: ${broken.map((outcome) => outcome.id).join(', ')}. Read the diff before committing — an adapter may be reading something this build no longer produces.`
      );
    }
    if (skipped.length > 0) {
      warn(`${skipped.length} set(s) were skipped, so their committed contracts are untouched.`);
    }
    return;
  }
  if (broken.length > 0) {
    error(
      `Breaking vendor drift in: ${broken.map((outcome) => outcome.id).join(', ')}. Update the adapter, then re-record with \`bun run vendor-contracts:regen\`.`
    );
    process.exitCode = 1;
    return;
  }
  if (flags['--require-all'] && skipped.length > 0) {
    error(
      `Nothing was verified for: ${skipped.map((outcome) => outcome.id).join(', ')}. Install the pinned CLI or drop --require-all.`
    );
    process.exitCode = 1;
    return;
  }
  if (skipped.length > 0) {
    warn(`${skipped.length} set(s) were skipped, so this run did not verify them.`);
  }
}

await main();
