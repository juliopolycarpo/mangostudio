import { describe, expect, it } from 'bun:test';
import { redactSettingsDocument } from '../../../../src/modules/library/domain/settings-redaction';

describe('settings redaction', () => {
  it('marks the authInfo subtree as omitted instead of dropping it', () => {
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
        path: 'authInfo',
        presentation: 'omitted',
      },
      {
        path: 'permissions.allow[0]',
        presentation: 'value',
        value: 'Read',
      },
    ]);
  });

  it('emits exactly one marker at the subtree root, however deep the subtree is', () => {
    const fields = redactSettingsDocument(
      {
        authInfo: {
          account: { email: 'ada@example.com', organizations: [{ id: 'org-1' }, { id: 'org-2' }] },
          tokens: { refresh: 'refresh-secret', access: 'access-secret' },
        },
      },
      { homeDir: '/home/ada' }
    );

    expect(fields).toEqual([{ path: 'authInfo', presentation: 'omitted' }]);
  });

  it('relativizes the home directory in an omitted marker path', () => {
    expect(
      redactSettingsDocument(
        { '/home/ada/projects/mango': { sessionState: { id: 'session-id' } } },
        { homeDir: '/home/ada' }
      )
    ).toEqual([{ path: '~/projects/mango.sessionState', presentation: 'omitted' }]);
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

  it('redacts every leaf below a credential-shaped key, not just scalar leaves', () => {
    expect(
      redactSettingsDocument(
        {
          token: { github: 'ghp-visible-token' },
          auth: { secret: 'visible-secret', url: 'https://auth.example.com' },
        },
        { homeDir: '/home/ada' }
      )
    ).toEqual([
      { path: 'token.github', presentation: 'redacted' },
      { path: 'auth.secret', presentation: 'redacted' },
      { path: 'auth.url', presentation: 'redacted' },
    ]);
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

  it('marks cache, session, installation, statsig, and credentials subtrees as omitted', () => {
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
      { path: 'autoReviewAvailabilityCache', presentation: 'omitted' },
      { path: 'privacyCache', presentation: 'omitted' },
      { path: 'statsigAssignments', presentation: 'omitted' },
      { path: 'installation_id', presentation: 'omitted' },
      { path: 'sessionState', presentation: 'omitted' },
      { path: 'nested.credentials', presentation: 'omitted' },
      {
        path: 'nested.visible',
        presentation: 'value',
        value: 'true',
      },
    ]);
  });

  it('never lets the content behind a marker reach the serialized snapshot', () => {
    for (let index = 0; index < 96; index += 1) {
      const secret = `omitted-secret-${index}-${(index * 15_485_863).toString(36)}`;
      const documents = [
        { authInfo: { email: secret } },
        { sessionState: { transcript: [secret, { nested: secret }] } },
        { privacyCache: { entries: { [secret]: secret } } },
        { statsigStable: secret },
        { installation_id: secret },
        { nested: { credentials: { account: secret } } },
      ];

      for (const document of documents) {
        const fields = redactSettingsDocument(document, { homeDir: '/home/ada' });
        expect(fields.every((field) => field.presentation === 'omitted')).toBe(true);
        expect(JSON.stringify(fields)).not.toContain(secret);
      }
    }
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
