import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getDb } from '../../../../src/db/database';
import { loadConfigForTest } from '../../../../src/lib/config';
import { resetLibraryDiscoveryCache } from '../../../../src/modules/library/application/library-discovery';
import {
  expandNativeSlashCommand,
  MAX_COMMAND_FILE_BYTES,
} from '../../../../src/modules/library/application/native-command-expansion';

let configHome: string;
let commandsDir: string;

function writeCommand(slug: string, content: string): string {
  const path = join(commandsDir, `${slug}.md`);
  writeFileSync(path, content, 'utf8');
  return path;
}

async function expand(prompt: string): Promise<string> {
  return expandNativeSlashCommand(getDb(), 'user-native-commands', prompt);
}

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), 'mango-native-commands-'));
  commandsDir = join(configHome, 'commands');
  mkdirSync(commandsDir);
  // `~/.mango/commands` hangs off the directory of the loaded config file.
  loadConfigForTest({ configFilePath: join(configHome, 'config.toml') });
  resetLibraryDiscoveryCache();
});

afterEach(() => {
  rmSync(configHome, { recursive: true, force: true });
  resetLibraryDiscoveryCache();
});

describe('expandNativeSlashCommand', () => {
  it('expands a command from ~/.mango/commands, frontmatter stripped, arguments substituted', async () => {
    writeCommand(
      'review',
      '---\ndescription: Review a file\nargument-hint: <file>\n---\nReview $1 and report issues. Full args: $ARGUMENTS\n'
    );

    const received = await expand('/review src/app.ts --strict');

    expect(received).toBe('Review src/app.ts and report issues. Full args: src/app.ts --strict');
  });

  it('appends the arguments when the template names no placeholder', async () => {
    writeCommand('standup', 'Write my standup from the git log.\n');

    expect(await expand('/standup yesterday only')).toBe(
      'Write my standup from the git log.\n\nARGUMENTS: yesterday only'
    );
  });

  it('passes an unknown command through unchanged', async () => {
    writeCommand('review', 'Review.\n');

    expect(await expand('/nope some args')).toBe('/nope some args');
  });

  it('passes a prompt that does not start with a slash through unchanged', async () => {
    writeCommand('review', 'Review.\n');

    expect(await expand('please /review this')).toBe('please /review this');
  });

  it('does not expand a command file that exceeds the byte cap', async () => {
    writeCommand('huge', `${'x'.repeat(MAX_COMMAND_FILE_BYTES + 1)}\n`);

    expect(await expand('/huge now')).toBe('/huge now');
  });

  it('does not follow a symlinked command file out of the commands directory', async () => {
    const outside = join(configHome, 'secret.md');
    writeFileSync(outside, 'TOP SECRET\n', 'utf8');
    symlinkSync(outside, join(commandsDir, 'leak.md'));

    expect(await expand('/leak')).toBe('/leak');
  });
});
