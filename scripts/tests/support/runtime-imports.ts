import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { ROOT_DIR } from '../../lib/config';

export interface RuntimeImportWalkResult {
  readonly files: ReadonlySet<string>;
  readonly externalSpecifiers: ReadonlyMap<string, readonly string[]>;
}

const IMPORT_FROM_RE = /(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;

function resolveRelativeModule(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
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

    const source = readFileSync(filePath, 'utf8');
    IMPORT_FROM_RE.lastIndex = 0;
    for (
      let match = IMPORT_FROM_RE.exec(source);
      match !== null;
      match = IMPORT_FROM_RE.exec(source)
    ) {
      const clause = match[1] ?? '';
      const specifier = match[2] ?? '';
      if (isTypeOnlyImportClause(clause)) {
        continue;
      }
      if (specifier.startsWith('node:') || specifier === 'bun') {
        continue;
      }
      if (specifier.startsWith('.')) {
        walk(resolveRelativeModule(filePath, specifier));
        continue;
      }
      recordExternal(specifier, filePath);
    }
  }

  walk(entry);
  return { files, externalSpecifiers };
}
