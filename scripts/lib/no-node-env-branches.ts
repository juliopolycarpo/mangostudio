import { readFileSync } from 'node:fs';
import ts from '@typescript/typescript6';

import { ROOT_DIR } from './config';

/**
 * These are the only production source files where NODE_ENV is intentional.
 * Keep the reason next to every exception so the list does not become a
 * historical record of unexplained escapes.
 */
export const NODE_ENV_READ_ALLOWLIST = [
  {
    path: 'apps/api/src/lib/config.ts',
    line: 657,
    reason:
      'selects the isolated test config path; moving this seam risks clobbering a real user file',
  },
  {
    path: 'apps/runtime/src/config.ts',
    line: 39,
    reason:
      'enables frame validation outside production; this is a production discriminator, not a test seam',
  },
  {
    path: 'apps/api/src/cli/detach.ts',
    line: 107,
    reason: 'passes through the variable to detached children; it is not a production branch',
  },
] as const;

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
    const allowlistedLines = new Set<number>(
      NODE_ENV_READ_ALLOWLIST.filter(({ path }) => path === source.path).map(({ line }) => line)
    );

    const visit = (node: ts.Node): void => {
      const isNodeEnvToken =
        (ts.isIdentifier(node) && node.text === 'NODE_ENV') ||
        ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
          node.text === 'NODE_ENV');
      if (isNodeEnvToken) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile)
        );
        const lineNumber = line + 1;
        if (!allowlistedLines.has(lineNumber)) {
          violations.push({
            path: source.path,
            line: lineNumber,
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
