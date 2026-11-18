import { inflateRawSync } from 'node:zlib';

/** One ZIP member as the central directory names it, with its decompressed bytes. */
export interface ZipMember {
  /** The member name exactly as stored, including any `/` directory prefix. */
  readonly name: string;
  readonly bytes: Uint8Array;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const END_RECORD_MIN_BYTES = 22;
// The end record trails an archive comment of at most 0xffff bytes.
const END_RECORD_SEARCH_BYTES = END_RECORD_MIN_BYTES + 0xffff;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

/**
 * Read every member of a ZIP through its central directory, without PowerShell, `unzip` or
 * `tar`, so a test verifies an archive the same way on every platform. Handles stored and
 * deflated members; anything else (ZIP64, encryption, other methods) throws, naming the field.
 * Each member's CRC-32 is checked against the decompressed bytes.
 * @example
 * const members = readZipMembers(new Uint8Array(readFileSync('bundle.zip')));
 * members.map((member) => member.name); // ['mangostudio', 'build-state.json']
 */
export function readZipMembers(archive: Uint8Array): ZipMember[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const endRecord = findEndRecord(view);
  const memberCount = view.getUint16(endRecord + 10, true);
  const directoryOffset = view.getUint32(endRecord + 16, true);
  if (memberCount === 0xffff || directoryOffset === 0xffffffff) {
    throw new Error('(zip): expected a plain ZIP | received a ZIP64 end record');
  }

  const members: ZipMember[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < memberCount; index += 1) {
    expectSignature(view, cursor, CENTRAL_DIRECTORY_HEADER, `central directory entry ${index}`);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const expectedCrc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(archive.subarray(cursor + 46, cursor + 46 + nameLength));
    if (flags & 0x1)
      throw new Error(`(zip member ${name}): expected unencrypted | received flag 1`);

    expectSignature(view, localOffset, LOCAL_FILE_HEADER, `local header of ${name}`);
    // The local name and extra lengths can differ from the central ones, so read the local pair.
    const dataStart =
      localOffset +
      30 +
      view.getUint16(localOffset + 26, true) +
      view.getUint16(localOffset + 28, true);
    const stored = archive.subarray(dataStart, dataStart + compressedSize);
    const bytes = decompress(name, method, stored);
    const actualCrc = Bun.hash.crc32(bytes);
    if (actualCrc !== expectedCrc) {
      throw new Error(
        `(zip member ${name}): expected crc32 ${expectedCrc} | received ${actualCrc}`
      );
    }
    members.push({ name, bytes });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return members;
}

function findEndRecord(view: DataView): number {
  const lowest = Math.max(0, view.byteLength - END_RECORD_SEARCH_BYTES);
  for (let offset = view.byteLength - END_RECORD_MIN_BYTES; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error(
    `(zip): expected an end-of-central-directory record | received none in ${view.byteLength} bytes`
  );
}

function expectSignature(view: DataView, offset: number, signature: number, what: string): void {
  const received = offset + 4 <= view.byteLength ? view.getUint32(offset, true) : null;
  if (received !== signature) {
    throw new Error(
      `(zip ${what}): expected signature 0x${signature.toString(16)} at ${offset} | received ${received === null ? 'end of file' : `0x${received.toString(16)}`}`
    );
  }
}

function decompress(name: string, method: number, stored: Uint8Array): Uint8Array {
  if (method === METHOD_STORED) return stored;
  if (method === METHOD_DEFLATED) return new Uint8Array(inflateRawSync(stored));
  throw new Error(
    `(zip member ${name}): expected compression method ${METHOD_STORED} (stored) or ${METHOD_DEFLATED} (deflate) | received ${method}`
  );
}
