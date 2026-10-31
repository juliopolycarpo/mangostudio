import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { classifyPublishFailure, type NpmCommandResult } from '../lib/npm-publish';
import { sanitizeNpmPublishResult } from '../lib/npm-publish-diagnostics';

class FakeRegistryCommands {
  readonly root = mkdtempSync(join(tmpdir(), 'npm-publish-diagnostics-'));
  readonly calls = join(this.root, 'calls.json');

  constructor() {
    for (const [directory, name] of [
      ['linux-x64', '@mangostudio/cli-linux-x64'],
      ['cli', 'mangostudio'],
    ]) {
      const path = join(this.root, 'dist', directory);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.2.3' }));
    }
    this.executable(
      'bun',
      'console.error("error: No version of package satisfying 1.2.3 found"); process.exit(1);'
    );
    this.executable(
      'npx',
      `
      const args = process.argv.slice(2);
      await Bun.write(${JSON.stringify(this.calls)}, JSON.stringify(args));
      if (args.includes('--loglevel=verbose')) {
        console.error('npm http fetch GET https://token.actions.example/request?secret=QUERY_SECRET 200 2ms');
        console.error('npm http fetch POST 404 https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@mangostudio%2fcli-linux-x64 2ms');
        console.error('npm verbose oidc Failed token exchange request with body message: UPSTREAM_SECRET');
        console.error('npm verbose stack Authorization: Bearer HEADER_SECRET');
        console.error('JWT_SECRET');
      }
      console.error('npm error code ENEEDAUTH');
      console.error('npm error need auth This command requires you to be logged in');
      process.exit(1);
    `
    );
  }

  private executable(name: string, source: string): void {
    const path = join(this.root, name);
    writeFileSync(path, `#!${process.execPath}\n${source}\n`);
    chmodSync(path, 0o755);
  }

  run(args: readonly string[] = [], legacy = false) {
    return Bun.spawnSync(
      [
        process.execPath,
        resolve('scripts/release/publish-npm.ts'),
        join(this.root, 'dist'),
        '--tag',
        'canary',
        ...args,
      ],
      {
        env: {
          ...process.env,
          PATH: `${this.root}${delimiter}${process.env.PATH ?? ''}`,
          GITHUB_ACTIONS: 'true',
          ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.example/request?secret=QUERY_SECRET',
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'REQUEST_TOKEN_SECRET',
          NODE_AUTH_TOKEN: legacy ? 'LEGACY_TOKEN_SECRET' : '',
          NPM_PUBLISH_ALLOW_LEGACY_TOKEN: String(legacy),
        },
      }
    );
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

test.skipIf(process.platform === 'win32').each([false, true])(
  'CLI retains safe token request and exchange diagnostics with legacy=%s',
  (legacy) => {
    const registry = new FakeRegistryCommands();
    try {
      const child = registry.run([], legacy);
      const output = child.stdout.toString() + child.stderr.toString();
      expect(child.exitCode, output).toBe(1);
      expect(output).toContain('npm error code ENEEDAUTH');
      expect(output).toContain('GitHub token request HTTP 200');
      expect(output).toContain('npm token exchange HTTP 404');
      expect(output).toContain('npm token exchange failed');
      for (const secret of [
        'QUERY_SECRET',
        'UPSTREAM_SECRET',
        'HEADER_SECRET',
        'JWT_SECRET',
        'REQUEST_TOKEN_SECRET',
      ]) {
        expect(output).not.toContain(secret);
      }
      expect(JSON.parse(readFileSync(registry.calls, 'utf8'))).toEqual([
        '--yes',
        'npm@11.5.1',
        '--loglevel=verbose',
        'publish',
        '--access',
        'public',
        '--tag',
        'canary',
        '--provenance',
      ]);
    } finally {
      registry.dispose();
    }
  }
);

test.skipIf(process.platform === 'win32')(
  'CLI dry run reads registry without invoking npm or requiring authentication',
  () => {
    const registry = new FakeRegistryCommands();
    try {
      const child = registry.run(['--dry-run']);
      const output = child.stdout.toString() + child.stderr.toString();
      expect(child.exitCode, output).toBe(0);
      expect(output).toContain('2 dry-run. Auth: not-published');
      expect(existsSync(registry.calls)).toBe(false);
    } finally {
      registry.dispose();
    }
  }
);

const DIAGNOSTIC_ENV = {
  GITHUB_ACTIONS: 'true',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.example/request?secret=QUERY_SECRET',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'REQUEST_TOKEN_SECRET',
};

function npmFailure(stderr: string): NpmCommandResult {
  return { exitCode: 1, stdout: '', stderr };
}

describe('sanitizeNpmPublishResult', () => {
  test.each([
    [
      'Skipped because incorrect permissions for id-token within GitHub workflow',
      'GitHub token request prerequisites missing',
    ],
    [
      'Failed to fetch id_token from GitHub: received an invalid response',
      'GitHub token request failed',
    ],
    [
      'Failed to fetch id_token from GitHub: missing value',
      'GitHub token response missing identity token',
    ],
    ['Skipped because no id_token available', 'identity token unavailable'],
    [
      'Failed token exchange request with body message: UPSTREAM_SECRET',
      'npm token exchange failed',
    ],
    [
      'Failed because token exchange was missing the token in the response body',
      'npm token exchange response missing credential',
    ],
    ['Successfully retrieved and set token', 'npm token exchange credential received'],
    ['Failure with message: CONFIG_SECRET', 'OIDC client operation failed'],
    ['NEW_UPSTREAM_SECRET', 'unrecognized OIDC diagnostic'],
  ])('maps %s to a constant category', (message, category) => {
    const result = sanitizeNpmPublishResult(
      npmFailure(`npm verbose oidc ${message}`),
      DIAGNOSTIC_ENV
    );
    expect(result.diagnostics).toContain(`npm authentication: ${category}.`);
    expect(result.stderr).toBe('');
    expect(JSON.stringify(result)).not.toMatch(
      /UPSTREAM_SECRET|CONFIG_SECRET|REQUEST_TOKEN_SECRET|QUERY_SECRET/
    );
  });

  test('keeps ordinary errors and notices while discarding debug records and continuations in both streams', () => {
    const raw = [
      '\u001b[33mnpm verbose oidc Failure with message: CONFIG_SECRET\u001b[0m',
      'eyJhbGciOiJIUzI1NiJ9.eyJ0b2tlbiI6IlNFQ1JFVCJ9.SIGNATURE_SECRET',
      'Authorization: Bearer HEADER_SECRET',
      'npm http fetch GET https://unrelated.example?QUERY_SECRET 401 2ms',
      'npm silly SECRET',
      'npm info SECRET',
      'npm timing SECRET',
      'npm notice package size: 3 kB',
      'npm ERR! code ENEEDAUTH',
      'npm error need auth Login required',
    ].join('\n');
    const result = sanitizeNpmPublishResult(
      { exitCode: 1, stdout: raw, stderr: raw },
      DIAGNOSTIC_ENV
    );
    expect(result.stdout).toBe(
      'npm notice package size: 3 kB\nnpm ERR! code ENEEDAUTH\nnpm error need auth Login required'
    );
    expect(result.stderr).toBe(result.stdout);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|Authorization|eyJ|https:/);
    expect(result.diagnostics).toContain('npm authentication: OIDC client operation failed.');
  });

  test('retains only HTTP status for the configured GitHub request and official package exchange', () => {
    const result = sanitizeNpmPublishResult(
      npmFailure(
        [
          'npm http fetch GET https://token.actions.example/request?secret=QUERY_SECRET 200 2ms',
          'npm http fetch POST 404 https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@scope%2fname?secret=QUERY_SECRET 2ms (cache skip)',
          'npm http fetch GET 403 https://token.actions.example/request?other=SECRET 2ms',
          'npm http fetch POST https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/pkg 401 2ms',
          'npm http fetch GET https://token.actions.example/other 500 2ms',
          'npm http fetch POST 403 https://other.example/-/npm/v1/oidc/token/exchange/package/pkg 2ms',
          'npm http fetch POST 700 https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/pkg 2ms',
          'npm http fetch POST 403 invalid-url 2ms',
        ].join('\n')
      ),
      DIAGNOSTIC_ENV
    );
    expect(result.diagnostics).toEqual([
      'npm authentication: GitHub token request HTTP 200.',
      'npm authentication: npm token exchange HTTP 404.',
      'npm authentication: GitHub token request HTTP 403.',
      'npm authentication: npm token exchange HTTP 401.',
      'npm authentication prerequisites present: GITHUB_ACTIONS=true, ACTIONS_ID_TOKEN_REQUEST_URL=true, ACTIONS_ID_TOKEN_REQUEST_TOKEN=true.',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|https:|scope|other.example/);
  });

  test('reports missing prerequisites as booleans without malformed environment values', () => {
    const result = sanitizeNpmPublishResult(npmFailure('npm error code ENEEDAUTH'), {
      ACTIONS_ID_TOKEN_REQUEST_URL: 'INVALID_SECRET',
    });
    expect(result.diagnostics).toEqual([
      'npm authentication prerequisites present: GITHUB_ACTIONS=false, ACTIONS_ID_TOKEN_REQUEST_URL=true, ACTIONS_ID_TOKEN_REQUEST_TOKEN=false.',
    ]);
    expect(JSON.stringify(result)).not.toContain('INVALID_SECRET');
  });

  test('leaves successful ordinary publication output intact without a failure prerequisite summary', () => {
    const result = sanitizeNpmPublishResult(
      { exitCode: 0, stdout: '+ package@1.2.3\n', stderr: 'npm notice published\n' },
      {}
    );
    expect(result).toEqual({
      exitCode: 0,
      stdout: '+ package@1.2.3\n',
      stderr: 'npm notice published\n',
      diagnostics: [],
    });
  });

  test('does not let authentication diagnostics change fatal ENEEDAUTH retry classification', () => {
    const result = sanitizeNpmPublishResult(
      npmFailure('npm verbose oidc Failure with message: network SECRET\nnpm error code ENEEDAUTH'),
      DIAGNOSTIC_ENV
    );
    expect(classifyPublishFailure(result)).toBe('fatal');
    expect(result.diagnostics).toContain('npm authentication: OIDC client operation failed.');
  });
});
