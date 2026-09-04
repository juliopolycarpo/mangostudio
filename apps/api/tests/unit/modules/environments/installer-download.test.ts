import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  createInstallerDownloader,
  InstallerDownloadError,
} from '../../../../src/modules/environments/infrastructure/installer-download';

const SCRIPT = `#!/usr/bin/env bash
set -eu
echo installing
`;

const PS1_SCRIPT = `#Requires -Version 5.1
param(
  [string]$Channel = "stable"
)
Write-Host "Installing $Channel"
`;

/** Long enough to clear any `minBytes` bound, but with no PowerShell token in it. */
const PS1_WITHOUT_TOKENS = `echo installing\n${'x'.repeat(64)}\n`;

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Exercises the real address policy without touching DNS: every host resolves to
 * a public address except `internal.test`, which lands inside RFC1918.
 */
function resolveHostname(hostname: string) {
  return Promise.resolve(
    hostname === 'internal.test'
      ? [{ address: '10.0.0.5', family: 4 as const }]
      : [{ address: '93.184.216.34', family: 4 as const }]
  );
}

function createDownloaderWithFetch(fetchImpl: typeof fetch) {
  let written: Uint8Array | null = null;
  let writtenPath: string | null = null;
  let removed = false;
  const downloader = createInstallerDownloader({
    fetch: fetchImpl,
    resolveHostname,
    createTempDir: () => Promise.resolve('/tmp/mangostudio-installer-test'),
    writeFile: (path, data) => {
      written = data;
      writtenPath = path;
      return Promise.resolve();
    },
    removeDir: () => {
      removed = true;
      return Promise.resolve();
    },
  });
  return {
    downloader,
    getWritten: () => written,
    getWrittenPath: () => writtenPath,
    wasRemoved: () => removed,
  };
}

function createDownloader(response: Response) {
  return createDownloaderWithFetch((() => Promise.resolve(response)) as unknown as typeof fetch);
}

describe('installer download', () => {
  it('accepts a bounded shell script and returns inspectable metadata', async () => {
    const fixture = createDownloader(new Response(SCRIPT, { status: 200 }));

    const artifact = await fixture.downloader.download({
      url: 'https://example.test/install.sh',
      interpreter: 'bash',
      minBytes: 16,
      maxBytes: 1024,
    });

    expect(artifact.path).toBe('/tmp/mangostudio-installer-test/installer.sh');
    expect(artifact.url).toBe('https://example.test/install.sh');
    expect(artifact.sizeBytes).toBe(new TextEncoder().encode(SCRIPT).byteLength);
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.getWritten()).not.toBeNull();

    await artifact.cleanup();
    expect(fixture.wasRemoved()).toBe(true);
  });

  it('refuses HTML, undersized, and oversized responses', async () => {
    const cases = [
      {
        response: new Response('<!doctype html><html>login</html>'),
        minBytes: 1,
        maxBytes: 1024,
        message: 'HTML',
      },
      {
        response: new Response('#!/bin/sh\n'),
        minBytes: 100,
        maxBytes: 1024,
        message: 'smaller',
      },
      {
        response: new Response(`${SCRIPT}${'x'.repeat(100)}`),
        minBytes: 1,
        maxBytes: 32,
        message: 'exceeds',
      },
    ];

    for (const testCase of cases) {
      const fixture = createDownloader(testCase.response);
      await expect(
        fixture.downloader.download({
          url: 'https://example.test/install.sh',
          interpreter: 'bash',
          minBytes: testCase.minBytes,
          maxBytes: testCase.maxBytes,
        })
      ).rejects.toThrow(testCase.message);
      expect(fixture.getWritten()).toBeNull();
    }
  });

  it('requires HTTPS and a successful response', async () => {
    const fixture = createDownloader(new Response('not found', { status: 404 }));

    await expect(
      fixture.downloader.download({
        url: 'http://example.test/install.sh',
        interpreter: 'bash',
        minBytes: 1,
        maxBytes: 1024,
      })
    ).rejects.toBeInstanceOf(InstallerDownloadError);

    await expect(
      fixture.downloader.download({
        url: 'https://example.test/install.sh',
        interpreter: 'bash',
        minBytes: 1,
        maxBytes: 1024,
      })
    ).rejects.toThrow('HTTP 404');
  });

  it('follows bounded HTTPS redirects and refuses a downgrade before fetching it', async () => {
    const calls: string[] = [];
    const responses = [
      new Response(null, {
        status: 302,
        headers: { location: '/resolved-install.sh' },
      }),
      new Response(SCRIPT, { status: 200 }),
    ];
    const redirected = createDownloaderWithFetch(((input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      const response = responses.shift();
      if (!response) throw new Error('Unexpected fetch.');
      return Promise.resolve(response);
    }) as unknown as typeof fetch);

    const artifact = await redirected.downloader.download({
      url: 'https://example.test/install.sh',
      interpreter: 'bash',
      minBytes: 16,
      maxBytes: 1024,
    });

    expect(calls).toEqual([
      'https://example.test/install.sh',
      'https://example.test/resolved-install.sh',
    ]);
    expect(artifact.url).toBe('https://example.test/resolved-install.sh');

    const downgradedCalls: string[] = [];
    const downgraded = createDownloaderWithFetch(((input: Parameters<typeof fetch>[0]) => {
      downgradedCalls.push(String(input));
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'http://example.test/insecure.sh' },
        })
      );
    }) as unknown as typeof fetch);

    await expect(
      downgraded.downloader.download({
        url: 'https://example.test/install.sh',
        interpreter: 'bash',
        minBytes: 16,
        maxBytes: 1024,
      })
    ).rejects.toThrow('non-HTTPS');
    expect(downgradedCalls).toEqual(['https://example.test/install.sh']);
  });

  it('refuses a redirect into a link-local or private address', async () => {
    const cases = [
      // The classic cloud metadata endpoint, reached as a bare IP literal.
      { location: 'https://169.254.169.254/latest/meta-data/', label: 'metadata' },
      // A public-looking hostname that resolves inside RFC1918.
      { location: 'https://internal.test/install.sh', label: 'internal host' },
    ];

    for (const testCase of cases) {
      const calls: string[] = [];
      const fixture = createDownloaderWithFetch(((input: Parameters<typeof fetch>[0]) => {
        calls.push(String(input));
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: testCase.location } })
        );
      }) as unknown as typeof fetch);

      await expect(
        fixture.downloader.download({
          url: 'https://example.test/install.sh',
          interpreter: 'bash',
          minBytes: 16,
          maxBytes: 1024,
        })
      ).rejects.toThrow('refused');
      // The redirect target is never fetched, so nothing internal is contacted.
      expect(calls).toEqual(['https://example.test/install.sh']);
      expect(fixture.getWritten()).toBeNull();
    }
  });

  it('accepts a pinned digest that matches the fetched bytes', async () => {
    const fixture = createDownloader(new Response(SCRIPT, { status: 200 }));

    const artifact = await fixture.downloader.download({
      url: 'https://example.test/install.sh',
      interpreter: 'bash',
      minBytes: 16,
      maxBytes: 1024,
      sha256: sha256Hex(SCRIPT),
    });

    expect(artifact.sha256).toBe(sha256Hex(SCRIPT));
  });

  it('refuses a pinned digest that does not match the fetched bytes, naming both', async () => {
    const fixture = createDownloader(new Response(SCRIPT, { status: 200 }));
    const wrongDigest = 'b'.repeat(64);

    await expect(
      fixture.downloader.download({
        url: 'https://example.test/install.sh',
        interpreter: 'bash',
        minBytes: 16,
        maxBytes: 1024,
        sha256: wrongDigest,
      })
    ).rejects.toThrow(
      `installer digest mismatch: expected ${wrongDigest} | received ${sha256Hex(SCRIPT)}`
    );
    expect(fixture.getWritten()).toBeNull();
  });

  it('refuses an HTML response declared as a PowerShell installer', async () => {
    const fixture = createDownloader(new Response('<!doctype html><html>login</html>'));

    await expect(
      fixture.downloader.download({
        url: 'https://example.test/install.ps1',
        interpreter: 'powershell',
        minBytes: 1,
        maxBytes: 1024,
      })
    ).rejects.toThrow('HTML');
  });

  it('refuses a PowerShell installer whose body has no PowerShell token', async () => {
    const fixture = createDownloader(new Response(PS1_WITHOUT_TOKENS, { status: 200 }));

    await expect(
      fixture.downloader.download({
        url: 'https://example.test/install.ps1',
        interpreter: 'powershell',
        minBytes: 16,
        maxBytes: 1024,
      })
    ).rejects.toThrow('does not look like a PowerShell script');
  });

  it('accepts a PowerShell installer and writes it as installer.ps1', async () => {
    const fixture = createDownloader(new Response(PS1_SCRIPT, { status: 200 }));

    const artifact = await fixture.downloader.download({
      url: 'https://example.test/install.ps1',
      interpreter: 'powershell',
      minBytes: 16,
      maxBytes: 1024,
    });

    expect(artifact.path).toBe('/tmp/mangostudio-installer-test/installer.ps1');
    expect(fixture.getWrittenPath()).toBe('/tmp/mangostudio-installer-test/installer.ps1');
  });
});
