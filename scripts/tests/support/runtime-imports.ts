import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { ROOT_DIR } from '../../lib/config';

export interface RuntimeImportWalkResult {
  readonly files: ReadonlySet<string>;
  readonly externalSpecifiers: ReadonlyMap<string, readonly string[]>;
}

// The clause may span lines but never contains a quote or `;`, so a statement
// cannot swallow the one that follows it.
const IMPORT_FROM_RE = /(?:^|\n)\s*(?:import|export)\s+([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g;
/** Side-effect imports (`import 'x'`) carry no clause and no `from`. */
const SIDE_EFFECT_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
/** Deferred runtime edges: `import('x')` and `require('x')` with literal specifiers. */
const DYNAMIC_IMPORT_RE = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:'"`\\])\/\/[^\n]*/g;

/**
 * Strip comments so commented-out or illustrative `import`/`require` snippets do
 * not register as runtime edges. Newlines are preserved so the anchored import
 * patterns keep matching.
 */
function stripComments(source: string): string {
  return source
    .replace(BLOCK_COMMENT_RE, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(LINE_COMMENT_RE, (_match, prefix: string) => prefix);
}

function resolveRelativeModule(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  // TS-style ESM specifiers point at the emitted `.js`; the source is `.ts`.
  const sourceOfEmitted = base.replace(/\.js$/, '');
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${sourceOfEmitted}.ts`,
    `${sourceOfEmitted}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  throw new Error(`Unresolved relative import "${specifier}" from ${fromFile}`);
}

function isTypeOnlyImportClause(clause: string): boolean {
  const trimmed = clause.trim();
  if (/^type\b/.test(trimmed)) {
    return true;
  }
  if (!/^\{[\s\S]*\}$/.test(trimmed)) {
    return false;
  }
  const inner = trimmed.slice(1, -1);
  const bindings = inner
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return bindings.length > 0 && bindings.every((binding) => /^\s*type\s/.test(binding));
}

/** Walk runtime imports from a repo-relative or absolute entrypoint. */
export function walkRuntimeImports(entryRelativePath: string): RuntimeImportWalkResult {
  const entry = resolve(ROOT_DIR, entryRelativePath);
  const files = new Set<string>();
  const externalSpecifiers = new Map<string, string[]>();

  function recordExternal(specifier: string, fromFile: string): void {
    const relativeFrom = fromFile.replace(`${ROOT_DIR}/`, '');
    const existing = externalSpecifiers.get(specifier);
    if (existing) {
      if (!existing.includes(relativeFrom)) {
        existing.push(relativeFrom);
      }
      return;
    }
    externalSpecifiers.set(specifier, [relativeFrom]);
  }

  function walk(filePath: string): void {
    if (files.has(filePath)) {
      return;
    }
    files.add(filePath);

    // `matchAll` clones the pattern, so the shared module-level regexes keep no
    // `lastIndex` state across the recursive `walk` calls below.
    const source = stripComments(readFileSync(filePath, 'utf8'));

    function visitSpecifier(specifier: string): void {
      if (specifier.startsWith('node:') || specifier === 'bun') {
        return;
      }
      if (specifier.startsWith('.')) {
        walk(resolveRelativeModule(filePath, specifier));
        return;
      }
      recordExternal(specifier, filePath);
    }

    for (const match of source.matchAll(IMPORT_FROM_RE)) {
      if (isTypeOnlyImportClause(match[1] ?? '')) {
        continue;
      }
      visitSpecifier(match[2] ?? '');
    }
    for (const match of source.matchAll(SIDE_EFFECT_IMPORT_RE)) {
      visitSpecifier(match[1] ?? '');
    }
    for (const match of source.matchAll(DYNAMIC_IMPORT_RE)) {
      visitSpecifier(match[1] ?? '');
    }
  }

  walk(entry);
  return { files, externalSpecifiers };
}
