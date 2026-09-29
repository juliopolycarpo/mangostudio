// Reads a downloaded qa-metrics archive on the trusted publisher side, for two
// questions only: which base SHA did the head collector record, and is a main
// baseline artifact complete. The archive is untrusted output, so this module
// treats it as hostile bytes: it never writes to disk, bounds every read and
// inflate, and yields a base SHA only when it is exactly a 40-character
// lowercase hex string. Everything else — bad zip, missing entry, bad JSON,
// null or malformed baseSha, unavailable/partial/stale metrics, another schema
// version — becomes an explicit
// "unavailable" with a reason, never a guess. Full schema validation stays in
// render-report.ts.

import { inflateRawSync } from 'node:zlib';

/** File name inside the artifact archive (pinned to metrics-envelope.ts by test). */
export const QA_METRICS_FILE_NAME = 'metrics.json';

/** Payload cap, mirrors QA_METRICS_MAX_BYTES in metrics-envelope.ts (pinned by test). */
export const MAX_METRICS_PAYLOAD_BYTES = 1024 * 1024;

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const MAX_EOCD_SCAN_BYTES = EOCD_MIN_BYTES + 0xffff;
const ZIP64_SENTINEL = 0xffffffff;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

function findEndOfCentralDirectory(view) {
  const lowest = Math.max(0, view.byteLength - MAX_EOCD_SCAN_BYTES);
  for (let offset = view.byteLength - EOCD_MIN_BYTES; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  throw new Error(`archive has no zip end-of-central-directory record (${view.byteLength} bytes)`);
}

function findEntry(view, name) {
  const eocd = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (offset === ZIP64_SENTINEL) throw new Error('zip64 archives are not supported');

  const decoder = new TextDecoder();
  let found = null;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`corrupt zip central directory at offset ${offset}`);
    }
    const nameLength = view.getUint16(offset + 28, true);
    const entryName = decoder.decode(
      new Uint8Array(view.buffer, view.byteOffset + offset + 46, nameLength)
    );
    const next =
      offset +
      46 +
      nameLength +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
    if (entryName === name && found) {
      // `unzip -p` in the workflow streams every match, so a first-match reader
      // could validate one payload while the renderer consumes another.
      throw new Error(`archive has more than one ${name} entry; expected exactly one`);
    }
    if (entryName === name) {
      found = {
        flags: view.getUint16(offset + 8, true),
        method: view.getUint16(offset + 10, true),
        compressedSize: view.getUint32(offset + 20, true),
        size: view.getUint32(offset + 24, true),
        localOffset: view.getUint32(offset + 42, true),
      };
    }
    offset = next;
  }
  if (!found) throw new Error(`archive has no ${name} entry`);
  return found;
}

/**
 * Extract the metrics payload text from an in-memory artifact zip.
 *
 * Sizes come from the central directory (authoritative even when the local
 * header sets the data-descriptor bit and records zero sizes). Only stored and
 * deflated entries are accepted, and output is capped at
 * MAX_METRICS_PAYLOAD_BYTES. Throws with the offending value on any violation.
 *
 * // Usage: readMetricsPayload(archiveBytes) // => '{"schemaVersion":3,...}'
 */
export function readMetricsPayload(archive) {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const entry = findEntry(view, QA_METRICS_FILE_NAME);
  if (entry.flags & 1) throw new Error(`${QA_METRICS_FILE_NAME} is encrypted; expected plain zip`);
  if (entry.size > MAX_METRICS_PAYLOAD_BYTES) {
    throw new Error(
      `${QA_METRICS_FILE_NAME} declares ${entry.size} bytes; expected at most ${MAX_METRICS_PAYLOAD_BYTES}`
    );
  }
  const local = entry.localOffset;
  if (local + 30 > view.byteLength || view.getUint32(local, true) !== LOCAL_SIGNATURE) {
    throw new Error(`corrupt zip local header at offset ${local}`);
  }
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  if (start + entry.compressedSize > view.byteLength) {
    throw new Error(
      `${QA_METRICS_FILE_NAME} data is truncated (archive ends at ${view.byteLength})`
    );
  }
  const data = archive.subarray(start, start + entry.compressedSize);

  if (entry.method === METHOD_STORED) return new TextDecoder().decode(data);
  if (entry.method !== METHOD_DEFLATED) {
    throw new Error(
      `${QA_METRICS_FILE_NAME} uses compression method ${entry.method}; expected 0 (stored) or 8 (deflate)`
    );
  }
  return new TextDecoder().decode(
    inflateRawSync(data, { maxOutputLength: MAX_METRICS_PAYLOAD_BYTES })
  );
}

const unavailable = (reason) => ({ sha: null, reason });

function parseEnvelope(archive) {
  try {
    return { envelope: JSON.parse(readMetricsPayload(archive)), reason: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { envelope: null, reason: `qa-metrics artifact is unreadable: ${message}` };
  }
}

/**
 * Resolve the base SHA the head envelope recorded at CI time.
 *
 * Returns `{ sha, reason: null }` only for a 40-hex lowercase SHA. Returns
 * `{ sha: null, reason }` for a missing archive, unreadable archive, invalid
 * JSON, or a null/malformed `baseSha`. Full envelope validation still happens in
 * render-report.ts; this reads exactly one field.
 *
 * // Usage: recordedBaseSha(headArchive) // => { sha: '0123…', reason: null }
 */
export function recordedBaseSha(archive) {
  if (!archive) return unavailable('head qa-metrics artifact is unavailable');
  const { envelope, reason } = parseEnvelope(archive);
  if (!envelope) return unavailable(reason);
  const value = envelope.baseSha;
  if (typeof value === 'string' && SHA_PATTERN.test(value)) return { sha: value, reason: null };
  // The value is untrusted and lands in the report, so bound what is echoed.
  const shown = String(JSON.stringify(value)).slice(0, 80);
  return unavailable(`head envelope baseSha ${shown} is not a 40-character lowercase hex SHA`);
}

/** Schema version this reader understands; mirrors QA_METRICS_SCHEMA_VERSION in metrics-envelope.ts (pinned by test). */
export const QA_METRICS_SCHEMA_VERSION = 4;

/** States that carry a complete, trustworthy value. `unsupported` is a definition, not a gap. */
const COMPLETE_STATES = new Set(['measured', 'unsupported']);

const MAX_REPORTED_INCOMPLETE = 5;

/** Key for a child node: a component's root (or id) reads better than an array index. */
function childKey(child, key) {
  if (Array.isArray(child) || child === null || typeof child !== 'object') return key;
  if (typeof child.root === 'string') return child.root;
  return typeof child.id === 'string' ? child.id : key;
}

/**
 * A crate's coverage comes from one CI job on one platform. When that job did
 * not deliver on a main push (a flaky test, a failed tool download, a cold-cache
 * timeout) the crate's own rows show n/a; it must not make the baseline of every
 * JS and docs PR on that commit unusable, so the cell is left out of the
 * completeness check. Everything else a crate carries is still checked.
 */
const isCrateCoverage = (node, key) => node.kind === 'crate' && key === 'coverage';

/**
 * Paths of measurements whose `state` is not complete (`unavailable`, `partial`,
 * `stale`, or anything unknown). A measurement is any object with a string
 * `state`; its `value` is data and is never searched.
 */
function incompletePaths(node, path, found) {
  if (node === null || typeof node !== 'object') return found;
  if (typeof node.state === 'string') {
    if (!COMPLETE_STATES.has(node.state)) found.push(`${path}=${node.state}`);
    return found;
  }
  for (const [key, child] of Object.entries(node)) {
    if (isCrateCoverage(node, key)) continue;
    incompletePaths(child, `${path}/${childKey(child, key)}`, found);
  }
  return found;
}

const usable = { reason: null, incomparable: false };
const rejected = (reason) => ({ reason, incomparable: false });

/**
 * Decide whether a main baseline artifact may be used.
 *
 * `{ reason: null }` means complete: readable, recorded under the schema
 * version this reader knows, recorded for exactly `baseSha`, and every metric
 * `measured` or `unsupported` (a crate's coverage excepted). Otherwise `reason`
 * says why not. An envelope
 * recorded under another schema version (v3 and older are historical) is
 * `incomparable: true` with an explicit reason, decided before any other field
 * is trusted, so it never reads as a missing baseline.
 *
 * // Usage: baselineVerdict(archive, baseSha) // => { reason: null, incomparable: false }
 */
export function baselineVerdict(archive, baseSha) {
  const { envelope, reason } = parseEnvelope(archive);
  if (!envelope) return rejected(reason);
  const version = envelope.schemaVersion;
  if (Number.isInteger(version) && version !== QA_METRICS_SCHEMA_VERSION) {
    return {
      reason: `qa-metrics artifact is incomparable: recorded under schema version ${version}, expected ${QA_METRICS_SCHEMA_VERSION}; older envelopes are historical and are not read`,
      incomparable: true,
    };
  }
  if (version !== QA_METRICS_SCHEMA_VERSION) {
    const shown = String(JSON.stringify(version)).slice(0, 80);
    return rejected(
      `qa-metrics artifact schemaVersion ${shown} is not the integer ${QA_METRICS_SCHEMA_VERSION}`
    );
  }
  if (envelope.headSha !== baseSha) {
    const shown = String(JSON.stringify(envelope.headSha)).slice(0, 80);
    return rejected(`qa-metrics artifact headSha ${shown} does not match base ${baseSha}`);
  }
  if (envelope.metrics === null || typeof envelope.metrics !== 'object') {
    return rejected('qa-metrics artifact has no metrics object');
  }
  const missing = incompletePaths(envelope.metrics, 'metrics', []);
  if (missing.length === 0) return usable;
  const listed = missing.slice(0, MAX_REPORTED_INCOMPLETE).join(', ');
  return rejected(
    `qa-metrics artifact is partial: ${missing.length} metric(s) not fully measured (${listed})`
  );
}

/**
 * Why a main baseline artifact must not be used, or null when it is complete.
 * // Usage: baselineIncompleteReason(archive, baseSha) // => null | 'qa-metrics artifact is partial: …'
 */
export function baselineIncompleteReason(archive, baseSha) {
  return baselineVerdict(archive, baseSha).reason;
}
