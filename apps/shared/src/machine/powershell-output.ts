/**
 * Plain text from the stderr of a Windows PowerShell child started with `-EncodedCommand`.
 *
 * With `-EncodedCommand` and stderr piped, PowerShell (5.1 and 7) writes its error and progress
 * streams as CLIXML, and `-OutputFormat Text` does not stop it on 5.1. An operator then reads
 * `#< CLIXML <Objs ...><S S="Error">boom_x000D__x000A_</S>...` where the message belongs.
 * `$ProgressPreference = 'SilentlyContinue'` removes the progress records; the error records can
 * only be decoded. `-Command` and `-File` write plain text, but they put the script on the
 * command line or on disk, which is what `-EncodedCommand` exists to avoid.
 *
 * The Rust twin is `crates/mangostudio-runtime/src/cli/user_service/powershell_output.rs`.
 */

const ENVELOPE_PATTERN = /#< CLIXML(?:[\s\S]*?<\/Objs>|[\s\S]*$)/g;
const STRING_RECORD_PATTERN = /<S S="[^"]*">([\s\S]*?)(?:<\/S>|$)/g;
// ESC [ ... <letter>: PowerShell 7 colours its error text and the record carries the escapes.
// eslint-disable-next-line no-control-regex -- the escape character is the whole point
const ANSI_SEQUENCE_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

const XML_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

function decodeEntity(match: string, name: string): string {
  const named = XML_ENTITIES[name];
  if (named !== undefined) return named;
  const hex = /^#[xX]([0-9a-fA-F]+)$/.exec(name)?.[1];
  const decimal = /^#(\d+)$/.exec(name)?.[1];
  let point: number | undefined;
  if (hex !== undefined) point = Number.parseInt(hex, 16);
  else if (decimal !== undefined) point = Number.parseInt(decimal, 10);
  return point !== undefined && point <= 0x10ffff ? String.fromCodePoint(point) : match;
}

/** Undoes a CLIXML string's two escapes: XML entities, then `_xHHHH_` UTF-16 code units. */
function unescapeRecord(raw: string): string {
  return raw
    .replace(/&([^;&\s]+);/g, decodeEntity)
    .replace(/_x([0-9a-fA-F]{4})_/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    );
}

/**
 * Replaces every CLIXML envelope in `text` with the message text it carries.
 *
 * Text outside an envelope is kept in order: a native program's own stderr can sit before or
 * after one. Progress records and other serialised objects carry no message and are dropped. An
 * envelope cut short is decoded as far as it goes.
 *
 * @example
 * decodeClixml('#< CLIXML\r\n<Objs><S S="Error">boom_x000D__x000A_</S></Objs>'); // 'boom\r\n'
 */
export function decodeClixml(text: string): string {
  return text.replace(ENVELOPE_PATTERN, (envelope) => {
    const records = [...envelope.matchAll(STRING_RECORD_PATTERN)].map((match) =>
      unescapeRecord(match[1] ?? '')
    );
    return records.join('').replace(ANSI_SEQUENCE_PATTERN, '');
  });
}
