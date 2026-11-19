import { afterEach, describe, expect, it } from 'bun:test';

import { lintConfiguredSource, lintSource, removeSourceTrees } from './support/boundary-fixtures';

// The locale dictionary boundary is the one import boundary Bun lint owns. The
// shared root and `@mangostudio/api/internal/*` bans belong to the source scans
// (shared-root-import-boundary / frontend-api-import-boundary unit tests).

const LOCALE_MESSAGE = 'Locale dictionaries are i18n plumbing';
const DICTIONARY_SPECIFIERS = [
  '@mangostudio/shared/i18n',
  '@mangostudio/shared/i18n/en',
  '@mangostudio/shared/i18n/en-settings',
  '@mangostudio/shared/i18n/en-onboarding',
  '@mangostudio/shared/i18n/en-environments',
  '@mangostudio/shared/i18n/en-library',
  '@mangostudio/shared/i18n/en-git',
  '@mangostudio/shared/i18n/en-github',
  '@mangostudio/shared/i18n/pt-BR',
];
// The one module per feature that hands its English namespace to the feature's lazy chunk.
const FEATURE_NAMESPACE_MODULES = [
  ['en-environments', 'apps/frontend/src/features/environments/environments-i18n.ts'],
  ['en-library', 'apps/frontend/src/features/library/library-i18n.ts'],
  ['en-git', 'apps/frontend/src/features/workspace/git-i18n.ts'],
  ['en-github', 'apps/frontend/src/features/github/github-i18n.ts'],
] as const;
const PLUMBING_PATHS = [
  'apps/frontend/src/hooks/use-i18n.tsx',
  'apps/frontend/src/lib/locale-dictionaries.ts',
  'apps/frontend/tests/unit/locale.test.ts',
  'apps/frontend/tests/unit/features/generation/external-turn-live-vs-reload.test.ts',
];

afterEach(removeSourceTrees);

describe('locale dictionary Bun restriction', () => {
  it('keeps the exemption in the full repository bunfig.toml', () => {
    const result = lintConfiguredSource(
      'apps/frontend/src/lib/locale-dictionaries.ts',
      "import '@mangostudio/shared/i18n/en';"
    );
    expect(result.exitCode, result.output).toBe(0);
  });

  it.each(DICTIONARY_SPECIFIERS)('rejects a static import of %s in a render layer', (specifier) => {
    const result = lintSource('apps/frontend/src/forbidden-locale.ts', `import '${specifier}';`);
    expect(result.exitCode, result.output).toBe(1);
    expect(result.output).toContain(LOCALE_MESSAGE);
  });

  it.each(DICTIONARY_SPECIFIERS)('rejects dynamic loading of %s in a render layer', (specifier) => {
    const result = lintSource('apps/frontend/src/forbidden-locale.ts', `import(\`${specifier}\`);`);
    expect(result.exitCode, result.output).toBe(1);
    expect(result.output).toContain(LOCALE_MESSAGE);
  });

  it.each(PLUMBING_PATHS)('lets %s load dictionaries', (path) => {
    const result = lintSource(path, "import '@mangostudio/shared/i18n/en';");
    expect(result.exitCode, result.output).toBe(0);
  });

  it.each(['en-settings', 'en-onboarding'])(
    'lets locale-dictionaries load the deferred %s namespace, and no other source file',
    (name) => {
      const specifier = `@mangostudio/shared/i18n/${name}`;
      const allowed = lintSource(
        'apps/frontend/src/lib/locale-dictionaries.ts',
        `import '${specifier}';`
      );
      expect(allowed.exitCode, allowed.output).toBe(0);

      const refused = lintSource(
        'apps/frontend/src/features/settings/forbidden.ts',
        `import '${specifier}';`
      );
      expect(refused.exitCode, refused.output).toBe(1);
      expect(refused.output).toContain(LOCALE_MESSAGE);
    }
  );

  it.each(FEATURE_NAMESPACE_MODULES)(
    'lets only the feature module import the %s namespace',
    (name, allowedPath) => {
      const specifier = `@mangostudio/shared/i18n/${name}`;
      const allowed = lintSource(allowedPath, `import '${specifier}';`);
      expect(allowed.exitCode, allowed.output).toBe(0);

      const refused = lintSource(
        'apps/frontend/src/features/chat/forbidden.ts',
        `import '${specifier}';`
      );
      expect(refused.exitCode, refused.output).toBe(1);
      expect(refused.output).toContain(LOCALE_MESSAGE);
    }
  );

  it('allows the plumbing names and Eden root types', () => {
    const result = lintSource(
      'apps/frontend/src/locale-types.ts',
      "import { defaultLocale, type Locale, type Messages } from '@mangostudio/shared/i18n';\nimport type { App } from '@mangostudio/api';"
    );
    expect(result.exitCode, result.output).toBe(0);
  });

  it.each([
    "import * as locale from '@mangostudio/shared/i18n';",
    "import locale from '@mangostudio/shared/i18n';",
    "import { en } from '@mangostudio/shared/i18n';",
  ])('rejects non-plumbing locale imports: %s', (source) => {
    const result = lintSource('apps/frontend/src/forbidden-locale.ts', source);
    expect(result.exitCode, result.output).toBe(1);
    expect(result.output).toContain(LOCALE_MESSAGE);
  });

  it.each(['@mangostudio/shared', '@mangostudio/api/internal/secret'])(
    'leaves %s to the source scans, not lint',
    (specifier) => {
      const result = lintConfiguredSource(
        'apps/frontend/src/scan-owned.ts',
        `import '${specifier}';\nexport const loaded = import('${specifier}');`
      );
      expect(result.output).not.toContain('no-restricted');
    }
  );
});
