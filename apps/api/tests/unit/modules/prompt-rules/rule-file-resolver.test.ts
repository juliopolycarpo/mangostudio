import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CUSTOM_INSTRUCTION_LOCATION_ID } from '@mangostudio/shared/library';
import { getLibraryLocation, LIBRARY_LOCATION_DEFINITIONS } from '@mangostudio/shared/library/host';
import type { PathEnv } from '@mangostudio/shared/runtime-env';

import {
  FIXED_RULE_FILE_LOCATIONS,
  getDefaultRuleFileDescriptors,
  loadFixedRuleFileContent,
  loadRuleFileContent,
  previewRuleFile,
  RuleFileError,
} from '../../../../src/modules/prompt-rules/application/rule-file-resolver';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mango-rule-file-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function createFile(name: string, content: string): string {
  const filePath = join(tmpDir, name);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function createDirectory(name: string): string {
  const dirPath = join(tmpDir, name);
  mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function createLargeFile(name: string, sizeBytes: number): string {
  const filePath = join(tmpDir, name);
  const content = 'x'.repeat(sizeBytes);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/** A hub-shaped path env rooted in the test directory, so nothing reads the real home. */
function pathEnvFor(env: Record<string, string> = {}): PathEnv {
  return { platform: process.platform, homeDir: tmpDir, env };
}

describe('getDefaultRuleFileDescriptors', () => {
  it('returns AGENTS.md and CLAUDE.md descriptors', () => {
    const descriptors = getDefaultRuleFileDescriptors();

    expect(descriptors.length).toBe(2);

    const agents = descriptors.find((d) => d.kind === 'agents');
    const claude = descriptors.find((d) => d.kind === 'claude');

    expect(agents).toBeDefined();
    expect(agents?.label).toBe('Mango AGENTS.md');
    expect(agents?.locationId).toBe('mango-instructions');
    expect(claude).toBeDefined();
    expect(claude?.label).toBe('Claude CLAUDE.md');
    expect(claude?.locationId).toBe('claude-instructions');
  });

  it('honours CLAUDE_CONFIG_DIR for the Claude file, as the library registry does', () => {
    const claudeDir = createDirectory('claude-home');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# From the override', 'utf8');
    const env = pathEnvFor({ CLAUDE_CONFIG_DIR: claudeDir });

    const claude = getDefaultRuleFileDescriptors(env).find((d) => d.kind === 'claude');

    expect(claude?.path, '(claude descriptor path): expected the CLAUDE_CONFIG_DIR file').toBe(
      join(claudeDir, 'CLAUDE.md')
    );
    expect(claude?.exists).toBe(true);
    expect(loadFixedRuleFileContent('claude', env)).toBe('# From the override');
  });

  it('follows the library registry path for every fixed file, not a table of its own', () => {
    const envs = [
      pathEnvFor(),
      pathEnvFor({ CLAUDE_CONFIG_DIR: join(tmpDir, 'dotfiles', 'claude') }),
      pathEnvFor({ MANGOSTUDIO_CONFIG_HOME: join(tmpDir, 'mango-home') }),
    ];

    for (const env of envs) {
      for (const descriptor of getDefaultRuleFileDescriptors(env)) {
        const location = getLibraryLocation(descriptor.locationId);
        expect(
          descriptor.path,
          `(${descriptor.kind} path under ${JSON.stringify(env.env)}): expected the registry path of ${descriptor.locationId}`
        ).toBe(location?.resolvePath(env) ?? '');
      }
    }
  });

  it('reads the fixed files from the same set of instruction locations as the library', () => {
    // Every single-file instruction location MangoStudio's own prompts or Claude's
    // CLAUDE.md read must be a prompt rule. A new one added to the registry fails
    // here, so the two features cannot grow different path sets unnoticed.
    const registryIds = LIBRARY_LOCATION_DEFINITIONS.filter(
      (location) =>
        location.kind === 'instruction' &&
        location.layout === 'single-file' &&
        (location.readBy.includes('mangostudio') || location.readBy.includes('claude'))
    )
      .map((location) => location.id)
      .sort();
    const promptRuleIds = Object.values(FIXED_RULE_FILE_LOCATIONS)
      .map(({ locationId }) => locationId)
      .sort();

    expect(promptRuleIds, '(prompt-rules fixed location ids vs registry instruction ids)').toEqual(
      registryIds
    );
  });

  it('returns exists: false for missing default files', () => {
    const descriptors = getDefaultRuleFileDescriptors();

    for (const d of descriptors) {
      if (!d.exists) {
        expect(d.readable).toBe(false);
        expect(d.sizeBytes).toBeUndefined();
      }
    }
  });
});

describe('previewRuleFile', () => {
  it('reads content from a valid .md file', () => {
    const filePath = createFile('test.md', '# Hello World\n\nSome content.');
    const result = previewRuleFile(filePath);

    expect(result.exists).toBe(true);
    expect(result.readable).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe('# Hello World\n\nSome content.');
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('expands ~ to the path env home directory', () => {
    createFile('manual.md', 'test content');

    const result = previewRuleFile('~/manual.md', pathEnvFor());

    expect(result.exists).toBe(true);
    expect(result.content).toBe('test content');
    expect(result.path).toBe('~/manual.md');
  });

  it('reports a custom path as the read-only custom-instruction location kind', () => {
    const filePath = createFile('team.md', '# Team');

    expect(previewRuleFile(filePath).locationId).toBe(CUSTOM_INSTRUCTION_LOCATION_ID);
  });

  it('rejects non-.md extensions', () => {
    const filePath = createFile('test.txt', 'not markdown');

    expect(() => previewRuleFile(filePath)).toThrow(RuleFileError);
    try {
      previewRuleFile(filePath);
    } catch (err) {
      expect(err).toBeInstanceOf(RuleFileError);
      expect((err as RuleFileError).code).toBe('VALIDATION');
    }
  });

  it('rejects extensionless files', () => {
    const filePath = createFile('nofile', 'no extension');

    expect(() => previewRuleFile(filePath)).toThrow(RuleFileError);
  });

  it('rejects directories', () => {
    const dirPath = createDirectory('some-dir.md');

    expect(() => previewRuleFile(dirPath)).toThrow(RuleFileError);
    try {
      previewRuleFile(dirPath);
    } catch (err) {
      expect(err).toBeInstanceOf(RuleFileError);
      expect((err as RuleFileError).code).toBe('VALIDATION');
    }
  });

  it('rejects relative paths', () => {
    expect(() => previewRuleFile('./relative/path.md')).toThrow(RuleFileError);
    try {
      previewRuleFile('./relative/path.md');
    } catch (err) {
      expect(err).toBeInstanceOf(RuleFileError);
      expect((err as RuleFileError).code).toBe('VALIDATION');
    }
  });

  it('returns error for missing files', () => {
    const missingPath = join(tmpDir, 'nonexistent.md');

    expect(() => previewRuleFile(missingPath)).toThrow(RuleFileError);
    try {
      previewRuleFile(missingPath);
    } catch (err) {
      expect(err).toBeInstanceOf(RuleFileError);
      expect((err as RuleFileError).code).toBe('NOT_FOUND');
    }
  });

  it('truncates oversized files', () => {
    const MAX_BYTES = 256 * 1024;
    const filePath = createLargeFile('large.md', MAX_BYTES + 1000);

    const result = previewRuleFile(filePath);

    expect(result.truncated).toBe(true);
    const content = result.content as string;
    expect(content.length).toBeLessThanOrEqual(MAX_BYTES);
  });

  it('does not truncate files at exactly the cap', () => {
    const MAX_BYTES = 256 * 1024;
    const filePath = createLargeFile('exact.md', MAX_BYTES);

    const result = previewRuleFile(filePath);

    expect(result.truncated).toBe(false);
    const exactContent = result.content as string;
    expect(exactContent.length).toBe(MAX_BYTES);
  });

  it('throws for unreadable empty content read failure', () => {
    const filePath = createFile('empty.md', '');

    const result = previewRuleFile(filePath);

    expect(result.content).toBe('');
    expect(result.truncated).toBe(false);
  });
});

describe('loadRuleFileContent', () => {
  it('returns content for a valid .md file', () => {
    const filePath = createFile('rules.md', '# Rules');

    expect(loadRuleFileContent(filePath)).toBe('# Rules');
  });

  it('returns null for missing files, directories, and wrong extensions', () => {
    expect(loadRuleFileContent(join(tmpDir, 'missing.md'))).toBeNull();
    expect(loadRuleFileContent(createDirectory('dir.md'))).toBeNull();
    expect(loadRuleFileContent(createFile('rules.txt', 'nope'))).toBeNull();
  });

  it('truncates oversized files instead of failing', () => {
    const MAX_BYTES = 256 * 1024;
    const filePath = createLargeFile('large.md', MAX_BYTES + 500);

    const content = loadRuleFileContent(filePath);

    expect(content).not.toBeNull();
    expect((content as string).length).toBe(MAX_BYTES);
  });
});
