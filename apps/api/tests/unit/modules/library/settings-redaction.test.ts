import { describe, expect, it } from 'bun:test';
import { redactSettingsDocument } from '../../../../src/modules/library/domain/settings-redaction';

describe('settings redaction', () => {
  it('omits the entire authInfo subtree', () => {
    expect(
      redactSettingsDocument(
        {
          authInfo: {
            email: 'ada@example.com',
            userId: 'user-secret',
          },
          permissions: {
            allow: ['Read'],
          },
        },
        { homeDir: '/home/ada' }
      )
    ).toEqual([
      {
        path: 'permissions.allow[0]',
        presentation: 'value',
        value: 'Read',
      },
    ]);
  });

  it('redacts every credential-shaped key without retaining its value', () => {
    const values = {
      apiKey: 'visible-api-key',
      token: 'visible-token',
      clientSecret: 'visible-secret',
      password: 'visible-password',
      signingKey: 'visible-signing-key',
    };

    expect(redactSettingsDocument(values, { homeDir: '/home/ada' })).toEqual(
      Object.keys(values).map((path) => ({
        path,
        presentation: 'redacted',
      }))
    );
  });

  it('redacts a credential-shaped value under an innocuous key', () => {
    expect(
      redactSettingsDocument(
        {
          endpoint: 'https://ada:password@example.com/api',
        },
        { homeDir: '/home/ada' }
      )
    ).toEqual([
      {
        path: 'endpoint',
        presentation: 'redacted',
      },
    ]);
  });

  it('omits cache, session, installation, statsig, and credentials subtrees', () => {
    const fields = redactSettingsDocument(
      {
        autoReviewAvailabilityCache: { token: 'cache-secret' },
        privacyCache: { email: 'ada@example.com' },
        statsigAssignments: { experiment: 'variant' },
        installation_id: 'machine-id',
        sessionState: { id: 'session-id' },
        nested: {
          credentials: {
            username: 'ada',
            password: 'credential-secret',
          },
          visible: true,
        },
      },
      { homeDir: '/home/ada' }
    );

    expect(fields).toEqual([
      {
        path: 'nested.visible',
        presentation: 'value',
        value: 'true',
      },
    ]);
  });

  it('relativizes the home directory in field paths and values', () => {
    expect(
      redactSettingsDocument(
        {
          paths: {
            '/home/ada/projects/mango': '/home/ada/projects/mango/config.toml',
          },
        },
        { homeDir: '/home/ada' }
      )
    ).toEqual([
      {
        path: 'paths.~/projects/mango',
        presentation: 'value',
        value: '~/projects/mango/config.toml',
      },
    ]);
  });

  it('never retains generated credential values in redacted output', () => {
    for (let index = 0; index < 128; index += 1) {
      const secret = `generated-secret-${index}-${(index * 2_654_435_761).toString(36)}`;
      const serialized = JSON.stringify(
        redactSettingsDocument({ apiKey: secret }, { homeDir: '/home/ada' })
      );

      expect(serialized).not.toContain(secret);
    }
  });

  it('keeps injected secrets out of a fuzz corpus of settings-shaped documents', () => {
    for (let index = 0; index < 96; index += 1) {
      const secret = `fuzz-secret-${index}-${(index * 97_531).toString(36)}`;
      const documents = [
        { permissions: { apiKey: secret } },
        { hooks: [{ environment: { accessToken: secret } }] },
        { credentials: { account: secret } },
        { authInfo: { email: secret } },
        { endpoint: `Bearer ${secret}` },
      ];

      for (const document of documents) {
        const serialized = JSON.stringify(
          redactSettingsDocument(document, { homeDir: '/home/ada' })
        );
        expect(serialized).not.toContain(secret);
      }
    }
  });
});
