import { isValidSemver, normalizeVersion } from './release-version';

interface ExpectedAsset {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

/** Complete release plan derived from an authenticated distribution and generated evidence. */
export interface CanaryReleaseExpectation {
  readonly repository: string;
  readonly sourceSha: string;
  readonly version: string;
  readonly assets: readonly ExpectedAsset[];
}

/** Preserve the actual HTTP status; a transport error must reject rather than become 404. */
export interface CanaryReleaseResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Project-owned read boundary, configured for the expected repository by the caller. */
export interface CanaryReleaseClient {
  /** Search this configured repository's public releases and drafts with push-capable visibility.
   * A 404 is valid only after complete draft-capable discovery finds no matching tag;
   * forwarding GET /releases/tags/{tag}'s published-only 404 is insufficient.
   */
  getRelease(tag: string): Promise<CanaryReleaseResponse>;
  /** Peel annotated tags in that same configured repository; success contains the full commit SHA. */
  resolveTag(tag: string): Promise<CanaryReleaseResponse>;
  /** Return every page, rejecting missing or malformed pages instead of returning a prefix. */
  listAssets(releaseId: number): Promise<readonly unknown[]>;
}

export interface CanaryReleasePublication {
  readonly state: 'absent' | 'draft' | 'complete';
  readonly releaseId: number | null;
  readonly present: readonly string[];
  readonly missing: readonly ExpectedAsset[];
}

/**
 * Verify existing canary release bytes before a no-op or filling draft gaps.
 * The caller authenticates the expected asset map's builder provenance. This
 * function reads GitHub's uploaded-asset digests without changing any release,
 * asset or tag. An immutable public release must contain the exact complete set.
 * A draft can lack a tag only when its full target commit matches the source.
 * A missing release still requires an absent tag or a tag at the exact source.
 *
 * @example
 * const release = await verifyCanaryReleasePublication(expected, github);
 * // Upload release.missing only when release.state is 'draft' or 'absent'.
 */
export async function verifyCanaryReleasePublication(
  expected: CanaryReleaseExpectation,
  client: CanaryReleaseClient
): Promise<CanaryReleasePublication> {
  const assets = validateExpectation(expected);
  const tag = `v${expected.version}`;
  const response = await client.getRelease(tag);
  if (response.status === 404) {
    validateTagSource(await client.resolveTag(tag), tag, expected.sourceSha, true);
    return { state: 'absent', releaseId: null, present: [], missing: [...assets.values()] };
  }
  requireSuccess(response.status, `release ${tag}`);
  const release = object(response.body, `release ${tag}`);
  const releaseId = positiveInteger(release.id, `release ${tag} ID`);
  const expectedUrl = `https://github.com/${expected.repository}/releases/tag/${tag}`;
  const apiUrl = `https://api.github.com/repos/${expected.repository}/releases/${releaseId}`;
  const draftUrlPrefix = `https://github.com/${expected.repository}/releases/tag/untagged-`;
  const draftUrl =
    release.draft === true &&
    typeof release.html_url === 'string' &&
    release.html_url.startsWith(draftUrlPrefix) &&
    /^[0-9a-f]+$/.test(release.html_url.slice(draftUrlPrefix.length));
  if (
    release.tag_name !== tag ||
    release.prerelease !== true ||
    typeof release.draft !== 'boolean' ||
    (release.html_url !== expectedUrl && !draftUrl) ||
    release.url !== apiUrl ||
    typeof release.target_commitish !== 'string' ||
    release.target_commitish.length === 0
  ) {
    throw new Error(
      `Invalid release ${tag}: expected ${expected.repository} pre-release targeting ${expected.sourceSha} at ${expectedUrl}; received ${JSON.stringify(release)}`
    );
  }
  if (!release.draft && release.immutable !== true) {
    throw new Error(
      `Invalid public release ${tag}: expected immutable=true; received ${JSON.stringify(release.immutable)}`
    );
  }
  const tagAbsent = validateTagSource(
    await client.resolveTag(tag),
    tag,
    expected.sourceSha,
    release.draft
  );
  if (tagAbsent && release.target_commitish !== expected.sourceSha) {
    throw new Error(
      `Invalid tagless draft ${tag}: expected exact full source target ${expected.sourceSha}; received ${JSON.stringify(release.target_commitish)}`
    );
  }
  const existing = await client.listAssets(releaseId);
  if (!Array.isArray(existing)) {
    throw new Error(
      `Invalid asset listing for release ${tag}: expected complete array; received ${JSON.stringify(existing)}`
    );
  }
  const present = new Set<string>();
  const ids = new Set<number>();
  for (const value of existing) {
    const asset = object(value, `release ${tag} asset`);
    const id = positiveInteger(asset.id, `release ${tag} asset ID`);
    const name = asset.name;
    if (typeof name !== 'string' || !assets.has(name) || present.has(name) || ids.has(id)) {
      throw new Error(
        `Invalid asset identity for release ${tag}: expected unique expected name and ID; received ${JSON.stringify(asset)}`
      );
    }
    const approved = assets.get(name);
    if (
      !approved ||
      asset.state !== 'uploaded' ||
      asset.size !== approved.size ||
      asset.digest !== `sha256:${approved.sha256}`
    ) {
      throw new Error(
        `Published asset mismatch for ${tag} ${name}: expected uploaded size=${approved?.size} digest=sha256:${approved?.sha256}; received ${JSON.stringify(asset)}. Existing assets cannot be replaced; recover with the original approved bytes or publish the next version.`
      );
    }
    present.add(name);
    ids.add(id);
  }
  const missing = [...assets.values()].filter((asset) => !present.has(asset.name));
  if (!release.draft && missing.length > 0) {
    throw new Error(
      `Incomplete immutable release ${tag}: missing ${missing.map((asset) => asset.name).join(', ')}; assets cannot be added after publication, publish the next version instead`
    );
  }
  return {
    state: release.draft ? 'draft' : 'complete',
    releaseId,
    present: [...assets.keys()].filter((name) => present.has(name)),
    missing,
  };
}

function validateTagSource(
  resolved: CanaryReleaseResponse,
  tag: string,
  sourceSha: string,
  allowAbsent: boolean
): boolean {
  if (allowAbsent && resolved.status === 404) return true;
  requireSuccess(resolved.status, `tag ${tag}`);
  if (
    typeof resolved.body !== 'string' ||
    !/^[0-9a-f]{40}$/.test(resolved.body) ||
    resolved.body !== sourceSha
  ) {
    throw new Error(
      `Invalid tag ${tag}: expected full source commit ${sourceSha}; received ${JSON.stringify(resolved.body)}`
    );
  }
  return false;
}

function validateExpectation(
  expected: CanaryReleaseExpectation
): ReadonlyMap<string, ExpectedAsset> {
  const source = expected.sourceSha;
  const short = typeof source === 'string' ? source.slice(0, 7) : '';
  const identifier = /^0\d+$/.test(short) ? `g${short}` : short;
  if (
    typeof expected.repository !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected.repository) ||
    typeof source !== 'string' ||
    !/^[0-9a-f]{40}$/.test(source) ||
    typeof expected.version !== 'string' ||
    !isValidSemver(expected.version) ||
    normalizeVersion(expected.version) !== expected.version ||
    !expected.version.endsWith(`-canary.${identifier}`) ||
    !Array.isArray(expected.assets) ||
    expected.assets.length === 0
  ) {
    throw new Error(
      `Invalid expected canary release: expected owner/repository, full source SHA, matching canonical canary version and nonempty asset set; received ${JSON.stringify(expected)}`
    );
  }
  const assets = new Map<string, ExpectedAsset>();
  for (const value of expected.assets) {
    const asset = object(value, 'expected release asset');
    if (
      typeof asset.name !== 'string' ||
      asset.name.length === 0 ||
      asset.name.trim() !== asset.name ||
      asset.name === '.' ||
      asset.name === '..' ||
      /[\\/\0\r\n]/.test(asset.name) ||
      assets.has(asset.name) ||
      typeof asset.size !== 'number' ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0 ||
      typeof asset.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(asset.sha256)
    ) {
      throw new Error(
        `Invalid expected release asset: expected unique basename, nonnegative safe size and lowercase SHA256; received ${JSON.stringify(asset)}`
      );
    }
    assets.set(asset.name, { name: asset.name, size: asset.size, sha256: asset.sha256 });
  }
  return assets;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object; received ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `Invalid ${label}: expected positive safe integer; received ${JSON.stringify(value)}`
    );
  }
  return value;
}

function requireSuccess(status: number, label: string): void {
  if (status !== 200) throw new Error(`${label}: expected HTTP 200; received ${status}`);
}
