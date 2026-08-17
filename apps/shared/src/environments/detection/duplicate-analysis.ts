import type { RuntimeFinding, RuntimeHealth, RuntimeStatus } from '../schemas';
import type { RuntimeDefinition, RuntimeScanResult, SemVer } from './binary-scan';

export interface MinimumRuntimeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch?: number;
}

/**
 * A version floor that belongs to one consumer of this runtime, not the
 * runtime itself — e.g. an agent CLI that needs a newer Node than MangoStudio
 * requires generically. `enabled` decides whether falling short of it is the
 * user's problem right now: a consumer that is off cannot fail on it yet.
 */
export interface ConsumerVersionRequirement extends MinimumRuntimeVersion {
  readonly consumer: string;
  readonly enabled: boolean;
}

export interface RuntimeAnalysisOptions {
  readonly installable: boolean;
  readonly probedAtMs: number;
  readonly minimumVersion?: MinimumRuntimeVersion;
  readonly consumerRequirements?: readonly ConsumerVersionRequirement[];
}

function compareVersions(left: SemVer, right: MinimumRuntimeVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - (right.patch ?? 0);
}

function formatMinimumVersion(version: MinimumRuntimeVersion): string {
  return version.patch === undefined
    ? `${version.major}.${version.minor}`
    : `${version.major}.${version.minor}.${version.patch}`;
}

/** Health is the worst severity carried by any finding; an absent severity counts as `warn`. */
function healthFor(scan: RuntimeScanResult, findings: readonly RuntimeFinding[]): RuntimeHealth {
  if (scan.installations.length === 0) {
    return scan.failures.length > 0 ? 'error' : 'missing';
  }
  return findings.some((finding) => finding.severity !== 'info') ? 'warn' : 'ok';
}

export function analyzeRuntimeScan(
  definition: RuntimeDefinition,
  scan: RuntimeScanResult,
  options: RuntimeAnalysisOptions
): RuntimeStatus {
  const findings: RuntimeFinding[] = scan.failures.map((failure) => ({
    code: failure.code,
    params: { path: failure.path },
  }));
  const canonicalInstallations = scan.installations.filter(
    (installation) => installation.aliasOf === undefined
  );
  const firstCanonical = canonicalInstallations[0];
  const effective = scan.installations.find((installation) => installation.effective);
  const effectiveCanonical =
    effective === undefined
      ? undefined
      : canonicalInstallations.find((installation) => installation.path === effective.path);

  // A missing runtime and a broken candidate on PATH are different facts, and
  // a user can have both at once (no real install, plus a dead shim). Neither
  // should hide the other, so this no longer waits for `scan.failures` to be
  // empty.
  if (firstCanonical === undefined) {
    findings.push({ code: 'not-found', params: { runtime: definition.id } });
  }
  if (firstCanonical !== undefined && effective === undefined) {
    findings.push({
      code: 'installed-but-not-on-path',
      params: {
        runtime: definition.id,
        path: firstCanonical.rawPath,
      },
    });
  }

  for (const installation of canonicalInstallations) {
    if (installation.version !== null) continue;
    findings.push({ code: 'version-probe-failed', params: { path: installation.rawPath } });
  }

  const versions = [
    ...new Set(
      canonicalInstallations
        .map((installation) => installation.version)
        .filter((version): version is string => version !== null)
    ),
  ];
  if (versions.length > 1) {
    findings.push({
      code: 'multiple-versions',
      params: { runtime: definition.id, versions: versions.join(', ') },
      // Several installed versions is normal for anyone on a version manager.
      // `shadowed-by-earlier-path` is the finding that fires when one of them
      // is actually ambiguous — earlier on PATH and different from what runs.
      severity: 'info',
    });
  }

  if (effectiveCanonical?.pathIndex !== undefined) {
    for (const installation of canonicalInstallations.slice(1)) {
      if (installation.pathIndex === undefined) continue;
      // Same version at two paths is a layout detail, not a conflict. Only a
      // version difference makes "which entry comes first in PATH" actionable.
      if (installation.version === effectiveCanonical.version) continue;
      findings.push({
        code: 'shadowed-by-earlier-path',
        params: {
          effectivePath: effectiveCanonical.rawPath,
          effectivePathIndex: String(effectiveCanonical.pathIndex),
          shadowedPath: installation.rawPath,
          shadowedPathIndex: String(installation.pathIndex),
        },
      });
    }
  }

  if (options.minimumVersion) {
    for (const installation of canonicalInstallations) {
      if (installation.version === null) continue;
      const version = definition.parseVersion(installation.version);
      if (!version || compareVersions(version, options.minimumVersion) >= 0) continue;
      findings.push({
        code: 'version-below-minimum',
        params: {
          path: installation.rawPath,
          version: installation.version,
          minimumVersion: formatMinimumVersion(options.minimumVersion),
        },
        // Only the binary that actually runs can make a feature fail today; a
        // stale install sitting below the floor is detail, not a warning.
        ...(!installation.effective && { severity: 'info' }),
      });
    }
  }

  if (options.consumerRequirements && effective && effective.version !== null) {
    for (const requirement of options.consumerRequirements) {
      const version = definition.parseVersion(effective.version);
      if (!version || compareVersions(version, requirement) >= 0) continue;
      findings.push({
        code: 'version-below-minimum-for',
        params: {
          consumer: requirement.consumer,
          version: effective.version,
          minimumVersion: formatMinimumVersion(requirement),
        },
        // A disabled consumer cannot fail on a version it never runs against yet.
        ...(!requirement.enabled && { severity: 'info' }),
      });
    }
  }

  return {
    id: definition.id,
    health: healthFor(scan, findings),
    installations: [...scan.installations],
    ...(effective !== undefined && { effective }),
    findings,
    installable: options.installable,
    probedAtMs: options.probedAtMs,
  };
}
