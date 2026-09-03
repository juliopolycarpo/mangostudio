import { readFileSync } from 'node:fs';
import ts from '@typescript/typescript6';

import { ROOT_DIR } from './config';

/**
 * Marker that exempts one intentional `NODE_ENV` read, written directly above
 * it or as a trailing comment on the same line, with the reason after the
 * colon:
 *
 *   // allow-node-env: selects the isolated test config path
 *   return process.env.NODE_ENV === 'test';
 *
 * Keyed on the marker rather than on an absolute line number, which the three
 * exceptions previously were. A line number has to be re-synced by whoever
 * inserts anything above it — it moved three times in one pull request — and,
 * worse, it fails open: when code shifts so the allowlisted line lands on a
 * *different* `NODE_ENV` read, that read is silently exempted instead. The
 * marker travels with the code it excuses and cannot drift onto another one.
 */
const NODE_ENV_ALLOW_MARKER = 'allow-node-env:';

export interface ProductionSourceFile {
  readonly path: string;
  readonly content: string;
}

export interface NodeEnvReadViolation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Whether a file is worth parsing. Parsing every production file's AST is the
 * expensive part of this guard, so files that cannot hold a `NODE_ENV` token
 * skip it. The token can also be spelled with escapes that the parser decodes
 * but a substring search misses — `process.env.NODE_EN\u0056` and
 * `process.env['NODE_EN\x56']` both resolve to it — so a file holding a
 * backslash is still parsed rather than trusted to the substring check.
 *
 * Every caller has to ask this exact question. A cheaper filter in front of the
 * scan silently reinstates the escape bypass this predicate exists to close,
 * and the guard passes while the violation stays in the tree.
 */
function mayHoldNodeEnvToken(content: string): boolean {
  return content.includes('NODE_ENV') || content.includes('\\');
}

/**
 * Whether the read on `lineIndex` carries an allow marker: either trailing on
 * its own line, or in the run of comment lines immediately above it. Blank
 * lines end the run, so a marker cannot excuse a read it is not adjacent to.
 */
function hasAllowMarker(lines: readonly string[], lineIndex: number): boolean {
  if (lines[lineIndex]?.includes(NODE_ENV_ALLOW_MARKER)) return true;

  for (let i = lineIndex - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? '';
    const isComment =
      line.startsWith('//') || line.startsWith('*') || line.startsWith('/*') || line === '*/';
    if (!isComment) return false;
    if (line.includes(NODE_ENV_ALLOW_MARKER)) return true;
  }
  return false;
}

export function findDisallowedNodeEnvReads(
  sources: readonly ProductionSourceFile[]
): NodeEnvReadViolation[] {
  const violations: NodeEnvReadViolation[] = [];

  for (const source of sources) {
    if (!mayHoldNodeEnvToken(source.content)) continue;

    // Parent pointers stay off: the only position lookup passes `sourceFile` to
    // `getStart`, which then never has to walk up the tree to find it.
    const sourceFile = ts.createSourceFile(
      source.path,
      source.content,
      ts.ScriptTarget.Latest,
      false
    );
    const lines = source.content.split('\n');

    const visit = (node: ts.Node): void => {
      const isNodeEnvToken =
        (ts.isIdentifier(node) && node.text === 'NODE_ENV') ||
        ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
          node.text === 'NODE_ENV');
      if (isNodeEnvToken) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile)
        );
        if (!hasAllowMarker(lines, line)) {
          violations.push({
            path: source.path,
            line: line + 1,
            column: character + 1,
          });
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return violations;
}

export function assertNoProductionNodeEnvBranches(rootDir: string = ROOT_DIR): void {
  const glob = new Bun.Glob('apps/*/src/**/*.{js,jsx,ts,tsx,mjs,cjs}');
  const sources = [...glob.scanSync({ cwd: rootDir, onlyFiles: true })].flatMap((path) => {
    const content = readFileSync(`${rootDir}/${path}`, 'utf8');
    // Filtered here as well as inside the scan so the whole tree's contents are
    // never resident at once.
    if (!mayHoldNodeEnvToken(content)) return [];
    return [{ path, content }];
  });
  const violations = findDisallowedNodeEnvReads(sources);

  if (violations.length === 0) return;

  const details = violations
    .map(({ path, line, column }) => `  - ${path}:${line}:${column}`)
    .join('\n');
  throw new Error(
    'Production source must not branch on NODE_ENV. Inject an explicit test seam instead.\n' +
      details
  );
}
