// Reads a downloaded qa-metrics archive on the trusted publisher side, for two
// questions only: which base SHA did the head collector record, and is a main
// baseline artifact complete. The archive is untrusted output, so this module
// treats it as hostile bytes: it never writes to disk, bounds every read and
// inflate, and yields a base SHA only when it is exactly a 40-character
// lowercase hex string. Everything else — bad zip, missing entry, bad JSON,
// null or malformed baseSha, placeholder metrics — becomes an explicit
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

/** Paths of collector-error placeholders (`{ error: string }`) inside `node`. */
function placeholderPaths(node, path, found) {
  if (node === null || typeof node !== 'object') return found;
  if (typeof node.error === 'string') {
    found.push(path);
    return found;
  }
  for (const [key, child] of Object.entries(node)) {
    placeholderPaths(child, `${path}/${key}`, found);
  }
  return found;
}

const MAX_REPORTED_PLACEHOLDERS = 5;

/**
 * Why a main baseline artifact must not be used, or null when it is complete:
 * readable, recorded for exactly `baseSha`, and carrying a real measurement for
 * every metric. An envelope with collector-error placeholders is partial — its
 * missing metrics would otherwise read as a baseline that was measured.
 *
 * // Usage: baselineIncompleteReason(archive, baseSha) // => null | 'partial: metrics/tests'
 */
export function baselineIncompleteReason(archive, baseSha) {
  const { envelope, reason } = parseEnvelope(archive);
  if (!envelope) return reason;
  if (envelope.headSha !== baseSha) {
    const shown = String(JSON.stringify(envelope.headSha)).slice(0, 80);
    return `qa-metrics artifact headSha ${shown} does not match base ${baseSha}`;
  }
  const missing = placeholderPaths(envelope.metrics, 'metrics', []);
  if (missing.length === 0) return null;
  const listed = missing.slice(0, MAX_REPORTED_PLACEHOLDERS).join(', ');
  return `qa-metrics artifact is partial: ${missing.length} metric(s) failed to collect (${listed})`;
}
