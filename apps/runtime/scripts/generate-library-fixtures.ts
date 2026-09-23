/**
 * Records what the TypeScript library readers answer for a fixed corpus, for
 * the Rust `mangostudio-runtime` crate to prove parity against.
 *
 * `crates/mangostudio-runtime/src/library/ts_compat_tests.rs` reads what this
 * script writes and replays every case through the Rust port: hash domains,
 * the `localeCompare` order that decides `whitespaceHash` and
 * `library.read-tree`'s file order, frontmatter scalars, instance discovery,
 * bounded content reads, settings sources, location resolution, and backup
 * sets the write engines left behind (`library-backup-fixtures.ts`). Every
 * expected value comes from the production shared code, never a restatement.
 *
 * Trees are described declaratively and built in a scratch directory on both
 * sides, so filenames git cannot carry portably (a newline, a symlink) stay
 * out of the repository. Cases marked `unixOnly` use symlinks or names Windows
 * refuses; the Rust side skips them there.
 *
 * Regenerate with `bun run --filter @mangostudio/runtime fixtures:library`.
 * The output is committed, so the Rust gate never depends on Bun.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { hashLibraryDirectory, hashLibraryFile } from '@mangostudio/shared/library';
import { getLibraryLocation, LIBRARY_LOCATION_DEFINITIONS } from '@mangostudio/shared/library/host';
import {
  LibraryCache,
  libraryLocationRoot,
  readLibraryContent,
  readLibraryTree,
  readLocationInstances,
  readSettingsSources,
} from '@mangostudio/shared/library/machine';
import { parseMarkdownFrontmatter } from '@mangostudio/shared/markdown';
import { recordBackupCorpus } from './library-backup-fixtures';

const OUTPUT = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'crates',
  'mangostudio-runtime',
  'tests',
  'fixtures',
  'ts-library',
  'corpus.json'
);

/** One entry of a declarative tree, relative to the case root. */
type TreeEntry =
  | { readonly path: string; readonly text: string }
  | { readonly path: string; readonly base64: string }
  | { readonly path: string; readonly fill: { readonly byte: number; readonly count: number } }
  | { readonly path: string; readonly dir: true }
  | { readonly path: string; readonly symlink: string };

const b64 = (bytes: Uint8Array | number[]) => Buffer.from(bytes).toString('base64');

function buildTree(root: string, entries: readonly TreeEntry[]): void {
  for (const entry of entries) {
    const target = join(root, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    if ('dir' in entry) mkdirSync(target, { recursive: true });
    else if ('symlink' in entry) symlinkSync(entry.symlink, target);
    else if ('text' in entry) writeFileSync(target, entry.text);
    else if ('base64' in entry) writeFileSync(target, Buffer.from(entry.base64, 'base64'));
    else writeFileSync(target, Buffer.alloc(entry.fill.count, entry.fill.byte));
  }
}

function withScratch<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'mango-library-fixture-'));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

/** Replaces the scratch root with a stable token so both sides compare text. */
function relativize<T>(value: T, root: string): T {
  return JSON.parse(JSON.stringify(value).replaceAll(JSON.stringify(root).slice(1, -1), '<root>'));
}

function stripVolatile(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, item) => (key === 'modifiedAtMs' ? undefined : item))
  );
}

// --- collation ---------------------------------------------------------------

const COLLATION_INPUT = [
  'SKILL.md',
  'references/x.md',
  'references/Z.md',
  'a-b',
  'ab',
  'a_b',
  'A',
  'a',
  'b',
  'B',
  'é',
  'e',
  'f',
  'ä',
  'z.md',
  'Z.md',
  'a/b',
  'a.b',
  'a0',
  'a10',
  'a2',
  '_x',
  '-x',
  '~x',
  '日本.md',
  '中文.md',
  '😀.md',
  '\uFF01.md',
  'Ω.md',
  'ß.md',
  'ss.md',
  'résumé.md',
  'resume.md',
  'Résumé.md',
  ' space.md',
  '#hash.md',
  '(paren).md',
  'a b.md',
  'a+b.md',
  'a@b.md',
];

// --- frontmatter -------------------------------------------------------------

const FRONTMATTER_SCALARS = [
  'plain',
  '"quoted"',
  "'single'",
  '007',
  '1e3',
  '0x1f',
  '0o17',
  '0b101',
  '-0',
  '.5',
  '5.',
  '+5',
  '1e21',
  '1e-7',
  '123456789012345680000',
  '1e999',
  'Infinity',
  '-0x10',
  '1_000',
  'true',
  'false',
  '[a, "b", ]',
  '0.1',
  '1.5e300',
  '12abc',
];

function describeFrontmatterValue(value: unknown): unknown {
  if (typeof value === 'number') return { type: 'number', string: String(value) };
  if (typeof value === 'boolean') return { type: 'boolean', string: String(value) };
  if (typeof value === 'string') return { type: 'string', string: value };
  return { type: 'array', items: value };
}

const FRONTMATTER_DOCUMENTS = [
  '---\nname: alpha\ndescription: first\n---\nbody',
  '---\r\nname: crlf\r\n---\r\n',
  ' --- \nname: padded\n --- \n',
  '---\nname: unterminated\n',
  'no frontmatter at all',
  '---\ntools:\n  - read\n  - "write"\nname: arrays\n# comment\nkeyless line\n: novalue\n---\n',
  '---\nname:\n- orphan\n---\n', // A comment, even one carrying a colon, neither sets a key nor ends an
  // open block array; neither does a blank line.
  '---\ntools:\n  # a note: inside\n\n  - read\n# name: evil\nname: ok\n---\n',
  // Only a value that both opens and closes with brackets is an inline array.
  '---\nname: x]\ndescription: [y\n---\n',
];

// --- hashing -----------------------------------------------------------------

const FILE_HASH_INPUTS: readonly number[][] = [
  [],
  [...Buffer.from('hello')],
  [0xef, 0xbb, 0xbf, ...Buffer.from('bom')],
  [0x00, 0xff, 0x0d, 0x0a],
];

interface MemoryTree {
  readonly name: string;
  readonly files: readonly { readonly path: string; readonly base64: string }[];
}

const DIRECTORY_HASH_TREES: readonly MemoryTree[] = [
  {
    name: 'utf16-order-and-length',
    files: [
      { path: 'SKILL.md', base64: b64(Buffer.from('---\nname: x\n---\n')) },
      { path: '\uFF01.md', base64: b64(Buffer.from('fullwidth')) },
      { path: '😀.md', base64: b64(Buffer.from('astral')) },
      { path: 'nested/deeper/a.md', base64: b64(Buffer.from('a')) },
    ],
  },
  { name: 'empty', files: [] },
  {
    name: 'unsafe-newline',
    files: [{ path: 'a\nb.md', base64: b64(Buffer.from('x')) }],
  },
  {
    name: 'dot-segment',
    files: [{ path: 'a/../b.md', base64: b64(Buffer.from('x')) }],
  },
];

function hashMemoryTree(tree: MemoryTree): Promise<unknown> {
  const root = '/fixture-root';
  const byPath = new Map(
    tree.files.map((file) => [`${root}/${file.path}`, Buffer.from(file.base64, 'base64')])
  );
  return hashLibraryDirectory(root, {
    listFiles: () => tree.files.map((file) => file.path),
    realPath: (path) => path,
    readFile: (path) => byPath.get(path) ?? new Uint8Array(),
    pathStyle: 'posix',
  });
}

// --- discovery ---------------------------------------------------------------

interface ScanCase {
  readonly name: string;
  readonly locationId: string;
  /** Relative to the case root; the location path the scan is pointed at. */
  readonly locationPath: string;
  readonly tree: readonly TreeEntry[];
  readonly unixOnly?: boolean;
}

const SKILL = (name: string, description = 'A skill.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`;

// --- parser edges --------------------------------------------------------------
//
// Documents where `JSON.parse` / `smol-toml` and the Rust host's parsers could
// part ways: JSON past serde_json's default depth, lone surrogate escapes and
// out-of-range numbers; TOML 1.1 syntax, bare scalars smol-toml reads through
// `Number()` and Bun's `Date`, and the 64-container nesting limit both hosts
// apply. Kept small: the corpus is committed.

const nestedToml = {
  arrays: (depth: number) => `a = ${'['.repeat(depth)}${']'.repeat(depth)}\n`,
  inline: (depth: number) => `a = ${'{b='.repeat(depth)}1${'}'.repeat(depth)}\n`,
  dotted: (segments: number) => `${Array(segments).fill('k').join('.')} = 1\n`,
  header: (segments: number) => `[${Array(segments).fill('h').join('.')}]\n`,
  arrayTable: (segments: number) => `[[${Array(segments).fill('t').join('.')}]]\n`,
};

const TOML_EDGES: Record<string, string> = {
  'inline-table-newlines': 'name = "inline"\nopts = {\n  a = 1,\n  b = 2,\n}\n',
  'inline-table-trailing-comma': 'opts = {x = 1,}\n',
  'escape-e': 'name = "esc\\e"\n',
  'escape-x': 'name = "\\x41gent"\n',
  'escape-x-malformed': 'name = "\\xZZ"\n',
  'escape-lone-surrogate': 'name = "\\uD800"\n',
  'time-without-seconds': 't = 10:30\ndt = 1979-05-27T07:32\n',
  'date-feb-30': 'd = 1979-02-30\n',
  'date-feb-29-non-leap': 'd = 1979-02-29\n',
  'date-apr-31-datetime': 'd = 1979-04-31 07:32:00+01:00\n',
  'date-day-32': 'd = 1979-12-32\n',
  'date-with-z': 'd = 1979-05-27Z\n',
  'date-with-offset': 'd = 1979-05-27+01:00\n',
  'time-with-offset': 't = 07:32Z\nu = 07:32:00+01:00\n',
  'time-leap-second': 't = 00:00:60\n',
  'datetime-leap-second': 'dt = 1979-05-27T23:59:60Z\n',
  'time-hour-24': 't = 24:00\n',
  'date-space-z': 'd = 1979-05-27 Z\ne = 1979-05-27 z\n',
  'date-t-space-z': 'd = 1979-05-27T Z\n',
  'date-space-offset': 'd = 1979-05-27 +01:00\n',
  'date-day-00-glued-time': 'd = 1979-01-0007:32Z\ne = 1979-12-0023:59:59.5-05:00\n',
  'date-day-00-glued-offset-hour-99': 'd = 1979-01-0007:32+99:59\n',
  'date-day-01-glued-time': 'd = 1979-01-0107:32Z\n',
  'date-day-00-separated-time': 'd = 1979-01-00T07:32Z\n',
  'date-day-00-glued-offset-minute-60': 'd = 1979-01-0007:32+23:60\n',
  'date-as-name': 'name = 1979-02-30\n',
  'float-overflow': 'f = 1e1000\ng = -1e400\n',
  'integer-safe-max': 'i = 9007199254740991\nj = -9007199254740991\n',
  'integer-unsafe': 'i = 9007199254740992\n',
  'integer-i64-max': 'i = 9223372036854775807\n',
  'integer-hex-unsafe': 'i = 0x20000000000000\n',
  'integer-octal-digit-8': 'i = 0o8\n',
  'nesting-arrays-64': nestedToml.arrays(64),
  'nesting-arrays-65': nestedToml.arrays(65),
  'nesting-arrays-1000': nestedToml.arrays(1000),
  'nesting-inline-64': nestedToml.inline(64),
  'nesting-inline-65': nestedToml.inline(65),
  'nesting-dotted-65': nestedToml.dotted(65),
  'nesting-dotted-66': nestedToml.dotted(66),
  'nesting-header-64': nestedToml.header(64),
  'nesting-header-65': nestedToml.header(65),
  'nesting-array-table-63': nestedToml.arrayTable(63),
  'nesting-array-table-64': nestedToml.arrayTable(64),
  'nesting-mixed-64': `[h]\nk.l = {z = {z = ${'['.repeat(60)}1${']'.repeat(60)}}}\n`,
  'nesting-mixed-65': `[h]\nk.l = {z = {z = ${'['.repeat(61)}1${']'.repeat(61)}}}\n`,
};

const JSON_EDGES: Record<string, string> = {
  'deep-129': `{"a":${'['.repeat(129)}${']'.repeat(129)}}`,
  'deep-1000': `{"a":${'['.repeat(1000)}${']'.repeat(1000)}}`,
  'lone-surrogate-value': '{"a":"\\ud800"}',
  'lone-surrogate-key': '{"\\udfff":1}',
  'number-overflow': '{"a":1e400,"b":-1e400,"c":1e-400}',
  'raw-control-character': '{"a":"\u0001"}',
  'hex-escape': '{"a":"\\x41"}',
};

const SCAN_CASES: readonly ScanCase[] = [
  {
    name: 'skills-mixed-validity',
    locationId: 'mango-skills',
    locationPath: 'skills',
    tree: [
      { path: 'skills/alpha/SKILL.md', text: SKILL('alpha') },
      { path: 'skills/beta/SKILL.md', text: SKILL('not-beta') },
      { path: 'skills/gamma/README.md', text: 'no entrypoint' },
      { path: 'skills/My_Skill/SKILL.md', text: SKILL('My_Skill') },
      { path: 'skills/bad name/SKILL.md', text: SKILL('bad name') },
      { path: 'skills/.hidden/SKILL.md', text: SKILL('hidden') },
      { path: 'skills/file-not-dir.md', text: 'a file where a skill directory belongs' },
      { path: 'skills/007/SKILL.md', text: SKILL('007') },
      { path: 'skills/empty-description/SKILL.md', text: '---\nname: empty-description\n---\n' },
      {
        path: 'skills/bom/SKILL.md',
        base64: b64([0xef, 0xbb, 0xbf, ...Buffer.from(SKILL('bom', '  padded  '))]),
      },
    ],
  },
  {
    name: 'skill-multi-file-ordering',
    locationId: 'claude-skills',
    locationPath: 'claude/skills',
    tree: [
      { path: 'claude/skills/ordered/SKILL.md', text: SKILL('ordered') },
      { path: 'claude/skills/ordered/references/Z.md', text: 'Z  upper\n' },
      { path: 'claude/skills/ordered/references/a.md', text: 'a\tlower\r\n' },
      { path: 'claude/skills/ordered/_x.md', text: 'underscore' },
      { path: 'claude/skills/ordered/é.md', text: 'accent\u00a0nbsp' },
      { path: 'claude/skills/ordered/ä.md', text: '\ufeffbom inside' },
      { path: 'claude/skills/ordered/日本.md', text: 'cjk' },
      { path: 'claude/skills/ordered/😀.md', text: 'emoji\u2028sep' },
      { path: 'claude/skills/ordered/scripts/run.sh', base64: b64([0x00, 0xff, 0xfe]) },
    ],
  },
  {
    name: 'skill-caps',
    locationId: 'agents-skills',
    locationPath: 'agents/skills',
    tree: [
      { path: 'agents/skills/big-entry/SKILL.md', fill: { byte: 0x61, count: 256 * 1024 + 1 } },
      { path: 'agents/skills/big-leaf/SKILL.md', text: SKILL('big-leaf') },
      {
        path: 'agents/skills/big-leaf/asset.bin',
        fill: { byte: 0x62, count: 2 * 1024 * 1024 + 1 },
      },
      { path: 'agents/skills/just-fits/SKILL.md', text: SKILL('just-fits') },
      { path: 'agents/skills/just-fits/asset.bin', fill: { byte: 0x63, count: 2 * 1024 * 1024 } },
    ],
  },
  {
    name: 'subagents-markdown',
    locationId: 'claude-agents',
    locationPath: 'claude/agents',
    tree: [
      {
        path: 'claude/agents/reviewer.md',
        text: '---\nname: Reviewer\ndescription: Reviews.\n---\n',
      },
      { path: 'claude/agents/UPPER.MD', text: 'no frontmatter' },
      { path: 'claude/agents/notes.txt', text: 'skipped: wrong extension' },
      { path: 'claude/agents/noext', text: 'skipped: no extension' },
      { path: 'claude/agents/.dot.md', text: 'skipped: dotfile' },
      { path: 'claude/agents/a.b.md', text: '---\nname: dotted\n---\n' },
      { path: 'claude/agents/nested/deep.md', text: 'skipped: directory, not a file' },
      { path: 'claude/agents/numeric.md', text: '---\nname: 1e3\ndescription: 0x1f\n---\n' },
    ],
  },
  {
    name: 'subagents-toml',
    locationId: 'codex-agents',
    locationPath: 'codex/agents',
    tree: [
      {
        path: 'codex/agents/good.toml',
        text: 'name = "  Good Agent  "\ndescription = "Does things."\n',
      },
      { path: 'codex/agents/bad.toml', text: 'name = "unterminated\n' },
      { path: 'codex/agents/nameless.toml', text: 'model = "x"\n' },
      { path: 'codex/agents/typed.toml', text: 'name = 5\ndescription = true\n' },
      { path: 'codex/agents/blank-name.toml', text: 'name = "   "\n' },
    ],
  },
  {
    name: 'settings-json-object',
    locationId: 'claude-settings',
    locationPath: 'claude/settings.json',
    tree: [{ path: 'claude/settings.json', text: '{"model": "x"}' }],
  },
  {
    name: 'settings-json-array',
    locationId: 'claude-settings',
    locationPath: 'claude/settings.json',
    tree: [{ path: 'claude/settings.json', text: '[1, 2]' }],
  },
  {
    name: 'settings-json-malformed',
    locationId: 'cursor-settings',
    locationPath: 'cursor/cli-config.json',
    tree: [{ path: 'cursor/cli-config.json', text: '{"trailing": 1,}' }],
  },
  {
    name: 'settings-json-bom',
    locationId: 'codex-hooks',
    locationPath: 'codex/hooks.json',
    tree: [{ path: 'codex/hooks.json', base64: b64([0xef, 0xbb, 0xbf, ...Buffer.from('{}')]) }],
  },
  {
    name: 'subagents-toml-parser-edges',
    locationId: 'codex-agents',
    locationPath: 'codex/agents',
    tree: [
      ...Object.entries(TOML_EDGES).map(([name, text]) => ({
        path: `codex/agents/${name}.toml`,
        text,
      })),
      {
        path: 'codex/agents/bom.toml',
        base64: b64([0xef, 0xbb, 0xbf, ...Buffer.from('name = "bom"\n')]),
      },
    ],
  },
  {
    name: 'settings-toml-nesting-limit',
    locationId: 'codex-settings',
    locationPath: 'codex/config.toml',
    tree: [{ path: 'codex/config.toml', text: nestedToml.header(65) }],
  },
  ...Object.entries(JSON_EDGES).map(([name, text]) => ({
    name: `settings-json-${name}`,
    locationId: 'claude-settings',
    locationPath: 'claude/settings.json',
    tree: [{ path: 'claude/settings.json', text }],
  })),
  {
    name: 'settings-toml-malformed',
    locationId: 'codex-settings',
    locationPath: 'codex/config.toml',
    tree: [{ path: 'codex/config.toml', text: '[table\nkey = 1\n' }],
  },
  {
    name: 'settings-toml-oversized',
    locationId: 'mango-settings',
    locationPath: 'mango/config.toml',
    tree: [{ path: 'mango/config.toml', fill: { byte: 0x23, count: 2 * 1024 * 1024 + 1 } }],
  },
  {
    name: 'single-file-missing',
    locationId: 'mango-instructions',
    locationPath: 'mango/AGENTS.md',
    tree: [{ path: 'mango/other.md', text: 'unrelated' }],
  },
  {
    name: 'single-file-directory',
    locationId: 'claude-instructions',
    locationPath: 'claude/CLAUDE.md',
    tree: [{ path: 'claude/CLAUDE.md', dir: true }],
  },
  {
    name: 'instruction-plain',
    locationId: 'codex-instructions',
    locationPath: 'codex/AGENTS.md',
    tree: [{ path: 'codex/AGENTS.md', text: '---\nname: ignored\n---\nplain markdown' }],
  },
  {
    name: 'cursor-rules-mdc',
    locationId: 'cursor-rules',
    locationPath: 'cursor/rules',
    tree: [
      { path: 'cursor/rules/style.mdc', text: '---\ndescription: House style\n---\n' },
      { path: 'cursor/rules/ignored.md', text: 'wrong extension' },
    ],
  },
  {
    name: 'permission-rules',
    locationId: 'codex-permission-rules',
    locationPath: 'codex/rules',
    tree: [{ path: 'codex/rules/default.rules', text: 'allow read\n' }],
  },
  {
    name: 'missing-location',
    locationId: 'cursor-commands',
    locationPath: 'cursor/commands',
    tree: [{ path: 'cursor/other', dir: true }],
  },
  {
    name: 'location-is-a-file',
    locationId: 'claude-commands',
    locationPath: 'claude/commands',
    tree: [{ path: 'claude/commands', text: 'not a directory' }],
  },
  {
    name: 'symlink-containment',
    locationId: 'cursor-skills',
    locationPath: 'cursor/skills',
    unixOnly: true,
    tree: [
      { path: 'outside/escaped/SKILL.md', text: SKILL('escaped') },
      { path: 'outside/secret.md', text: 'secret' },
      { path: 'cursor/skills/escaped', symlink: '../../outside/escaped' },
      { path: 'cursor/skills/leaf-escape/SKILL.md', text: SKILL('leaf-escape') },
      { path: 'cursor/skills/leaf-escape/secret.md', symlink: '../../../outside/secret.md' },
      { path: 'cursor/skills/sibling/SKILL.md', text: SKILL('sibling') },
      { path: 'cursor/skills/sibling/alias.md', symlink: 'SKILL.md' },
      { path: 'cursor/skills/cycle/SKILL.md', text: SKILL('cycle') },
      { path: 'cursor/skills/cycle/loop', symlink: '.' },
      { path: 'cursor/skills/newline/SKILL.md', text: SKILL('newline') },
      { path: 'cursor/skills/newline/bad\nname.md', text: 'unsafe' },
    ],
  },
];

// --- bounded reads -----------------------------------------------------------

interface ReadCase {
  readonly name: string;
  readonly base64: string;
  readonly maxBytes?: number;
  readonly truncateOversize?: boolean;
}

const READ_CASES: readonly ReadCase[] = [
  { name: 'bom-stripped', base64: b64([0xef, 0xbb, 0xbf, ...Buffer.from('hello')]) },
  { name: 'invalid-utf8', base64: b64([0x61, 0xff, 0xc3, 0x28, 0xe2, 0x82, 0x62]) },
  {
    name: 'truncated-mid-sequence',
    base64: b64(Buffer.from('aé€😀')),
    maxBytes: 4,
    truncateOversize: true,
  },
  { name: 'exact-cap', base64: b64(Buffer.from('abcd')), maxBytes: 4 },
  { name: 'empty', base64: '' },
];

// --- read-tree ---------------------------------------------------------------

interface TreeCase {
  readonly name: string;
  readonly path: string;
  readonly containment: string;
  readonly tree: readonly TreeEntry[];
  readonly unixOnly?: boolean;
}

const TREE_CASES: readonly TreeCase[] = [
  {
    name: 'directory-order',
    path: 'skills/ordered',
    containment: 'skills',
    tree: [
      { path: 'skills/ordered/SKILL.md', text: 'entry' },
      { path: 'skills/ordered/references/Z.md', text: 'Z' },
      { path: 'skills/ordered/references/a.md', text: 'a' },
      // Case-distinct names only across letters: `b.md` and `B.md` would be
      // one file on a case-insensitive filesystem.
      { path: 'skills/ordered/B.md', text: 'B' },
      { path: 'skills/ordered/c.md', text: 'c' },
      { path: 'skills/ordered/é.md', text: 'e' },
      { path: 'skills/ordered/bin.dat', base64: b64([0xef, 0xbb, 0xbf, 0x00, 0xff]) },
    ],
  },
  {
    name: 'single-file',
    path: 'agents/one.md',
    containment: 'agents',
    tree: [{ path: 'agents/one.md', base64: b64([0xef, 0xbb, 0xbf, ...Buffer.from('bom kept')]) }],
  },
  {
    name: 'leaf-escape',
    path: 'skills/leaky',
    containment: 'skills',
    unixOnly: true,
    tree: [
      { path: 'outside.md', text: 'secret' },
      { path: 'skills/leaky/SKILL.md', text: 'entry' },
      { path: 'skills/leaky/secret.md', symlink: '../../outside.md' },
    ],
  },
];

// --- settings sources --------------------------------------------------------

const SETTINGS_HOME: readonly TreeEntry[] = [
  {
    path: '.claude/settings.json',
    base64: b64([0xef, 0xbb, 0xbf, ...Buffer.from('{"hooks": {}}')]),
  },
  { path: '.codex/config.toml', text: 'model = "gpt"\n' },
  { path: '.codex/rules/b.rules', text: 'rule b\n' },
  { path: '.codex/rules/a.rules', text: 'rule a\n' },
  { path: '.codex/rules/.hidden.rules', text: 'hidden\n' },
  { path: '.codex/rules/notes.txt', text: 'not a rule\n' },
  { path: '.codex/rules/nested.rules/inner.rules', text: 'a directory named like a rule\n' },
  { path: '.mango/config.toml', fill: { byte: 0x23, count: 512 * 1024 + 1 } },
  { path: '.cursor/cli-config.json', dir: true },
];

// --- location resolution -----------------------------------------------------

const PATH_ENVS = [
  { name: 'linux-defaults', platform: 'linux', homeDir: '/home/u', env: {} },
  {
    name: 'linux-overrides',
    platform: 'linux',
    homeDir: '/home/u',
    env: {
      SKILLS_DIR: './my-skills/',
      AGENTS_DIR: '/srv/agents/../agents2',
      CLAUDE_CONFIG_DIR: '  /opt/claude  ',
      CODEX_HOME: 'codex-home',
      XDG_CONFIG_HOME: '/xdg',
    },
  },
  {
    name: 'linux-cursor-override-beats-xdg',
    platform: 'linux',
    homeDir: '/home/u',
    env: { CURSOR_CONFIG_DIR: '/cursor', XDG_CONFIG_HOME: '/xdg' },
  },
  {
    name: 'linux-blank-overrides',
    platform: 'linux',
    homeDir: '/home/u',
    env: { SKILLS_DIR: '   ' },
  },
  {
    name: 'darwin-defaults',
    platform: 'darwin',
    homeDir: '/Users/u',
    env: { XDG_CONFIG_HOME: '/x' },
  },
  {
    name: 'win32-overrides',
    platform: 'win32',
    homeDir: 'C:\\Users\\u',
    env: { SKILLS_DIR: 'D:/skills/', CODEX_HOME: '..\\codex' },
  },
  { name: 'unsupported-platform', platform: 'freebsd', homeDir: '/home/u', env: {} },
];

async function main(): Promise<void> {
  const collation = [...COLLATION_INPUT].sort((left, right) => left.localeCompare(right));

  const frontmatterScalars = FRONTMATTER_SCALARS.map((raw) => ({
    raw,
    value: describeFrontmatterValue(
      parseMarkdownFrontmatter(`---\nname: ${raw}\n---\n`).frontmatter.name
    ),
  }));
  const frontmatterDocuments = FRONTMATTER_DOCUMENTS.map((document) => {
    const { frontmatter } = parseMarkdownFrontmatter(document);
    return {
      document,
      frontmatter: Object.fromEntries(
        Object.entries(frontmatter).map(([key, value]) => [key, describeFrontmatterValue(value)])
      ),
    };
  });

  const fileHashes = await Promise.all(
    FILE_HASH_INPUTS.map(async (bytes) => ({
      base64: b64(bytes),
      ...(await hashLibraryFile('/file', { readFile: () => new Uint8Array(bytes) })),
    }))
  );
  const directoryHashes = await Promise.all(
    DIRECTORY_HASH_TREES.map(async (tree) => ({ ...tree, result: await hashMemoryTree(tree) }))
  );

  const scans = [];
  for (const scanCase of SCAN_CASES) {
    const result = await withScratch(async (root) => {
      buildTree(root, scanCase.tree);
      const location = getLibraryLocation(scanCase.locationId);
      if (!location) throw new Error(`unknown location ${scanCase.locationId}`);
      const scanned = await readLocationInstances(location, join(root, scanCase.locationPath), {
        cache: new LibraryCache(),
        force: true,
      });
      // `readdir` order is the filesystem's, not the reader's: sort so the
      // corpus is identical on every machine that regenerates it.
      const ordered = {
        instances: [...scanned.instances].sort((left, right) =>
          left.instance.path < right.instance.path
            ? -1
            : left.instance.path > right.instance.path
              ? 1
              : 0
        ),
        unreadableEntries: [...scanned.unreadableEntries].sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0
        ),
      };
      return relativize(stripVolatile(ordered), root);
    });
    scans.push({ ...scanCase, expected: result });
  }

  const reads = [];
  for (const readCase of READ_CASES) {
    const result = await withScratch((root) => {
      const file = join(root, 'file.md');
      writeFileSync(file, Buffer.from(readCase.base64, 'base64'));
      return readLibraryContent({
        path: file,
        root,
        ...(readCase.maxBytes !== undefined && { maxBytes: readCase.maxBytes }),
        ...(readCase.truncateOversize !== undefined && {
          truncateOversize: readCase.truncateOversize,
        }),
      });
    });
    reads.push({ ...readCase, expected: result });
  }

  const trees = [];
  for (const treeCase of TREE_CASES) {
    const result = await withScratch(async (root) => {
      buildTree(root, treeCase.tree);
      try {
        const files = await readLibraryTree(
          join(root, treeCase.path),
          join(root, treeCase.containment)
        );
        return {
          files: files.map((file) => ({
            relativePath: file.relativePath,
            contentBase64: b64(file.bytes),
          })),
        };
      } catch (error) {
        return { error: error instanceof Error ? error.constructor.name : String(error) };
      }
    });
    trees.push({ ...treeCase, expected: result });
  }

  const settingsSources = await withScratch((root) => {
    buildTree(root, SETTINGS_HOME);
    return Promise.resolve(
      relativize(readSettingsSources({ platform: 'linux', homeDir: root, env: {} }), root)
    );
  });

  // `libraryLocationRoot` takes its `dirname` from the *host's* `node:path`,
  // so a root is only meaningful for an env describing the generator's own
  // platform family; the resolved path itself is platform-parameterized.
  const hostFamily = (platform: string) => (platform === 'win32' ? 'win32' : 'posix');
  const locations = PATH_ENVS.map((env) => ({
    ...env,
    expected: LIBRARY_LOCATION_DEFINITIONS.map((location) => ({
      id: location.id,
      path: location.resolvePath(env),
      ...(hostFamily(env.platform) === hostFamily(process.platform) && {
        root: libraryLocationRoot(location.id, env),
      }),
    })),
  }));

  const corpus = {
    generatedBy: 'apps/runtime/scripts/generate-library-fixtures.ts',
    pathSeparator: sep,
    collation: { input: COLLATION_INPUT, sorted: collation },
    frontmatterScalars,
    frontmatterDocuments,
    fileHashes,
    directoryHashes,
    scans,
    reads,
    trees,
    settingsSources: { home: SETTINGS_HOME, expected: settingsSources },
    locations,
    backups: await recordBackupCorpus(),
  };
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(corpus, null, 2)}\n`);
}

await main();
