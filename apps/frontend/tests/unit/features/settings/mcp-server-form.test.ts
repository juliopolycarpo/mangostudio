/**
 * Unit tests for the pure MCP server form-state model: validation messages,
 * transport-specific body building, and write-only header semantics.
 */

import { describe, expect, it } from 'bun:test';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import type { McpServer } from '@mangostudio/shared/mcp';
import {
  buildAddBody,
  buildUpdateBody,
  createEmptyFormState,
  formStateFromServer,
  validateFormState,
} from '../../../../src/features/settings/mcp/lib/server-form';

const HTTP_SERVER: McpServer = {
  id: 'srv-1',
  name: 'GitHub',
  slug: 'github',
  transport: 'http',
  environmentId: LOCAL_ENVIRONMENT_ID,
  command: null,
  args: [],
  env: {},
  secretEnvNames: [],
  url: 'https://example.com/mcp',
  headerNames: ['Authorization'],
  enabled: true,
  timeoutMs: 5000,
  status: 'connected',
  createdAt: 1,
  updatedAt: 1,
};

const STDIO_SERVER: McpServer = {
  id: 'srv-2',
  name: 'Everything',
  slug: 'everything',
  transport: 'stdio',
  environmentId: LOCAL_ENVIRONMENT_ID,
  command: 'bunx',
  args: ['@modelcontextprotocol/server-everything'],
  env: { LOG_LEVEL: 'debug' },
  secretEnvNames: [],
  url: null,
  headerNames: [],
  enabled: true,
  timeoutMs: null,
  status: 'disconnected',
  createdAt: 1,
  updatedAt: 1,
};

describe('validateFormState', () => {
  const messages = en.settings.mcp;

  it('reports required fields with i18n messages', () => {
    const errors = validateFormState(createEmptyFormState(), messages);
    expect(errors.name).toBe(messages.nameRequired);
    expect(errors.slug).toBe(messages.slugRequired);
    expect(errors.command).toBe(messages.commandRequired);
  });

  it('rejects an invalid slug', () => {
    const state = { ...createEmptyFormState(), name: 'A', slug: 'Bad Slug', command: 'x' };
    expect(validateFormState(state, messages).slug).toBe(messages.slugInvalid);
  });

  it('requires a URL only for the http transport', () => {
    const state = { ...createEmptyFormState(), name: 'A', slug: 'a', transport: 'http' as const };
    const errors = validateFormState(state, messages);
    expect(errors.url).toBe(messages.urlRequired);
    expect(errors.command).toBeUndefined();
  });

  it('accepts a complete stdio state', () => {
    const state = { ...createEmptyFormState(), name: 'A', slug: 'a', command: 'bunx server' };
    expect(validateFormState(state, messages)).toEqual({});
  });
});

describe('formStateFromServer', () => {
  it('never round-trips stored header values into the form', () => {
    const state = formStateFromServer(HTTP_SERVER);
    expect(state.headers).toEqual([]);
    expect(state.url).toBe('https://example.com/mcp');
    expect(state.timeoutMs).toBe('5000');
  });

  it('maps stdio fields including env entries', () => {
    const state = formStateFromServer(STDIO_SERVER);
    expect(state.command).toBe('bunx');
    expect(state.args).toEqual(['@modelcontextprotocol/server-everything']);
    expect(state.env).toEqual([{ key: 'LOG_LEVEL', value: 'debug' }]);
    expect(state.timeoutMs).toBe('');
  });
});

describe('buildAddBody', () => {
  it('drops http-only fields from a stdio body after a transport switch', () => {
    const state = {
      ...createEmptyFormState(),
      name: 'A',
      slug: 'a',
      transport: 'stdio' as const,
      command: 'bunx server',
      args: ['--verbose', '  '],
      env: [{ key: 'KEY', value: 'v' }],
      secretEnv: [{ key: 'API_TOKEN', value: 'secret' }],
      url: 'https://leftover.example',
      headers: [{ key: 'Authorization', value: 'secret' }],
    };
    const body = buildAddBody(state);
    expect(body).toEqual({
      name: 'A',
      slug: 'a',
      enabled: true,
      timeoutMs: null,
      transport: 'stdio',
      environmentId: LOCAL_ENVIRONMENT_ID,
      command: 'bunx server',
      args: ['--verbose'],
      env: { KEY: 'v' },
      secretEnv: { API_TOKEN: 'secret' },
    });
    expect('url' in body).toBe(false);
    expect('headers' in body).toBe(false);
  });

  it('drops stdio-only fields from an http body after a transport switch', () => {
    const state = {
      ...createEmptyFormState(),
      name: 'A',
      slug: 'a',
      transport: 'http' as const,
      command: 'leftover',
      url: 'https://example.com/mcp',
      headers: [{ key: 'Authorization', value: 'Bearer x' }],
      timeoutMs: '2500',
    };
    const body = buildAddBody(state);
    expect(body).toEqual({
      name: 'A',
      slug: 'a',
      enabled: true,
      timeoutMs: 2500,
      transport: 'http',
      environmentId: LOCAL_ENVIRONMENT_ID,
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    });
    expect('command' in body).toBe(false);
    expect('env' in body).toBe(false);
  });

  it('skips key/value rows with an empty key', () => {
    const state = {
      ...createEmptyFormState(),
      name: 'A',
      slug: 'a',
      command: 'x',
      env: [
        { key: '', value: 'ignored' },
        { key: 'KEEP', value: '1' },
      ],
    };
    expect(buildAddBody(state)).toMatchObject({ env: { KEEP: '1' } });
  });
});

describe('buildUpdateBody', () => {
  it('keeps the stored header bundle when the editor is untouched', () => {
    const state = formStateFromServer(HTTP_SERVER);
    const body = buildUpdateBody(state);
    expect('headers' in body).toBe(false);
    expect(body.url).toBe('https://example.com/mcp');
  });

  it('replaces the header bundle when new rows exist', () => {
    const state = {
      ...formStateFromServer(HTTP_SERVER),
      headers: [{ key: 'Authorization', value: 'Bearer new' }],
    };
    expect(buildUpdateBody(state).headers).toEqual({ Authorization: 'Bearer new' });
  });
});
