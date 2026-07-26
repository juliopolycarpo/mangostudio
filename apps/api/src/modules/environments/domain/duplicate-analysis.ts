import type {
  RuntimeFinding,
  RuntimeHealth,
  RuntimeStatus,
} from '@mangostudio/shared/environments';
import type { RuntimeDefinition, RuntimeScanResult, SemVer } from './binary-scan';

export interface MinimumRuntimeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch?: number;
}

export interface RuntimeAnalysisOptions {
  readonly installable: boolean;
  readonly probedAtMs: number;
  readonly minimumVersion?: MinimumRuntimeVersion;
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

function healthFor(scan: RuntimeScanResult, findings: readonly RuntimeFinding[]): RuntimeHealth {
  if (scan.installations.length === 0) {
    return scan.failures.length > 0 ? 'error' : 'missing';
  }
  return findings.length > 0 ? 'warn' : 'ok';
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
  const effective =
    scan.installations.find((installation) => installation.effective) ?? scan.installations[0];
  const effectiveCanonical = canonicalInstallations[0];

  if (canonicalInstallations.length === 0 && scan.failures.length === 0) {
    findings.push({ code: 'not-found', params: { runtime: definition.id } });
  }

  const versions = [...new Set(canonicalInstallations.map((installation) => installation.version))];
  if (versions.length > 1) {
    findings.push({
      code: 'multiple-versions',
      params: { runtime: definition.id, versions: versions.join(', ') },
    });
  }

  if (effectiveCanonical?.pathIndex !== undefined) {
    for (const installation of canonicalInstallations.slice(1)) {
      if (installation.pathIndex === undefined) continue;
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
      const version = definition.parseVersion(installation.version);
      if (!version || compareVersions(version, options.minimumVersion) >= 0) continue;
      findings.push({
        code: 'version-below-minimum',
        params: {
          path: installation.rawPath,
          version: installation.version,
          minimumVersion: formatMinimumVersion(options.minimumVersion),
        },
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
