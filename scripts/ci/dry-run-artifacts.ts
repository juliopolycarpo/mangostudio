import { distributionArtifactName } from '../lib/distribution-manifest';

const TARGETS = ['linux-x64', 'windows-x64'] as const;

/**
 * Validate exact same-run artifact names before an empty download name can fan out.
 * @example
 * dryRunTargetArtifacts(JSON.stringify(targetArtifacts), sourceSha, version);
 */
export function dryRunTargetArtifacts(
  raw: string,
  sourceSha: string,
  version: string
): Record<(typeof TARGETS)[number], string> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Dry-run target artifacts must be an object');
  }
  const artifacts = {} as Record<(typeof TARGETS)[number], string>;
  for (const target of TARGETS) {
    const name = (parsed as Record<string, unknown>)[target];
    const digest = typeof name === 'string' ? /-([a-f0-9]{12})$/.exec(name)?.[1] : null;
    if (
      !digest ||
      name !== distributionArtifactName(target, sourceSha, version, digest.padEnd(64, '0'))
    ) {
      throw new Error(`Missing or wrong distribution artifact identity for ${target}`);
    }
    artifacts[target] = name as string;
  }
  return artifacts;
}

if (import.meta.main) {
  try {
    const artifacts = dryRunTargetArtifacts(
      process.env.TARGET_ARTIFACTS ?? '',
      process.env.SOURCE_SHA ?? '',
      process.env.VERSION ?? ''
    );
    process.stdout.write(
      `linux_artifact=${artifacts['linux-x64']}\nwindows_artifact=${artifacts['windows-x64']}\n`
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
