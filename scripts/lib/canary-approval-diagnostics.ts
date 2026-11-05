/**
 * Explain a refused child phase without forwarding transport logs or remote values.
 * Only fixed project-owned reasons and allowlisted workflow names reach the caller.
 * Example: canaryApprovalChildFailure('acquisition', result.exitCode, result.stdout, result.stderr).
 */
export function canaryApprovalChildFailure(
  phase: 'acquisition' | 'qualification',
  exitCode: number,
  stdout: Uint8Array,
  stderr: Uint8Array
): string {
  // Keep memory and matching work bounded even if the child filled its capture buffer.
  const diagnostics = [stderr, stdout]
    .map((bytes) => Buffer.from(bytes.subarray(0, 8192)).toString('utf8'))
    .join('\n');
  let reason: string;
  const workflow =
    /\b(ci|distribution-build|smoke-binary|smoke-container|cargo-shim|protocol-ci|codeql)\.yml: source validation contract differs from qualification revision\b/.exec(
      diagnostics
    );
  if (/\bHTTP\s*401\b|\bBad credentials\b/i.test(diagnostics))
    reason = 'GitHub authentication refused (HTTP401); verify the job read credentials';
  else if (/\bHTTP\s*403\b/i.test(diagnostics))
    reason = 'GitHub access refused (HTTP403); verify repository and attestation read permissions';
  else if (workflow)
    reason = `${workflow[1]}.yml: source validation contract differs from qualification revision; select a compatible successful source`;
  else if (/Original CI checksums unavailable or invalid/.test(diagnostics))
    reason =
      'Original CI checksums unavailable or invalid: recover approved artifact bytes; rebuilding a partial version is forbidden';
  else if (/Original CI distribution unavailable/.test(diagnostics))
    reason =
      'Original CI distribution unavailable: recover original approved artifact metadata; rebuilding a partial version is forbidden';
  else if (
    /Original (?:canary )?approval unavailable|Original approved distribution unavailable|earliest successful approval|recover original approval/i.test(
      diagnostics
    )
  )
    reason =
      'Original approval unavailable: recover its exact approved archive; selecting rebuilt bytes is forbidden';
  else if (
    /Ambiguous approv(?:ed|al).*payload|Ambiguous approval artifacts|different.*payload|Conflicting.*approval/i.test(
      diagnostics
    )
  )
    reason = 'Conflicting approval payloads: expected one original immutable approval';
  else if (/Approval provenance refused/.test(diagnostics))
    reason =
      'Approval provenance refused: expected the trusted builder or approval workflow signature for the frozen source';
  else if (
    /Corrupt |Mixed approval|Invalid publisher checksum|checksum identity mismatch|Invalid original checksum|Invalid SHA256SUMS|Invalid approval ZIP|Invalid approval evidence|Invalid evidence TAR|Incomplete evidence TAR|Truncated evidence TAR/.test(
      diagnostics
    )
  )
    reason =
      'Approval integrity verification failed: recover the original authenticated archive and manifest';
  else if (/Frozen CI .*mismatch|Invalid historical approval attempt identity/.test(diagnostics))
    reason =
      'Frozen CI identity mismatch: expected the original repository, source and successful run attempt';
  else if (
    /expected.*complete.*collection|expected.*total_count|paginated|truncat/i.test(diagnostics)
  )
    reason = 'Incomplete GitHub metadata: expected every artifact, job and workflow run page';
  else if (
    /Missing successful immutable distribution builder attempt|expected exactly one latest producer|expected completed successful associated job|Missing required same-SHA|expected same-SHA main push validation|predates distribution builder attempt|expected completed successful .* main push/.test(
      diagnostics
    )
  )
    reason =
      'Qualification producer refused: expected successful CI, smoke and required sibling jobs for the approved distribution';
  else if (
    /GitHub API |GitHub response:|GitHub JSON response:|GitHub transport|expected HTTP200/.test(
      diagnostics
    )
  )
    reason =
      'GitHub read failed: expected authenticated, complete repository metadata; transport details withheld';
  else reason = 'Child refusal was not a recognized safe diagnostic; transport details withheld';
  const status = Number.isSafeInteger(exitCode) ? String(exitCode) : 'unknown';
  return `Canary approval ${phase} failed (exit ${status}): ${reason}`;
}
