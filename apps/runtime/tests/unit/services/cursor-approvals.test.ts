/**
 * The client-method table Cursor's ACP server talks to.
 *
 * What matters here is that every server→client request produces *an answer*.
 * A plan that throws instead of refusing is not a stricter refusal — it leaves
 * the vendor parked on a reply that never arrives, and the pump answers those
 * requests one at a time, so one unanswered request stops the connection.
 */

import { describe, expect, it } from 'bun:test';
import {
  EXTERNAL_APPROVAL_MAX_OPTIONS,
  EXTERNAL_TEXT_LIMITS,
} from '@mangostudio/shared/external-agents';
import { planCursorServerRequest } from '../../../src/services/external-agents/cursor/approvals';

describe('planCursorServerRequest', () => {
  it('refuses a permission request that arrived without params', () => {
    // JSON-RPC allows a request with no `params` member at all.
    for (const params of [undefined, null, 'not an object']) {
      const plan = planCursorServerRequest('session/request_permission', params, '0', 0);
      expect(plan).toMatchObject({ outcome: 'refuse', code: -32600 });
    }
  });

  it('refuses methods this client never advertised', () => {
    for (const method of ['fs/read_text_file', 'terminal/create', 'cursor/update_todos']) {
      expect(planCursorServerRequest(method, {}, '0', 0)).toMatchObject({
        outcome: 'refuse',
        code: -32601,
      });
    }
  });

  it('refuses an option set the neutral contract cannot carry', () => {
    // Emitting these would fail validation in the supervisor, which ends the
    // turn. Refusing costs one unanswerable approval instead.
    const option = (optionId: string) => ({ optionId, name: 'Allow', kind: 'allow_once' });
    const tooMany = Array.from({ length: EXTERNAL_APPROVAL_MAX_OPTIONS + 1 }, (_, index) =>
      option(`allow-${index}`)
    );
    expect(
      planCursorServerRequest('session/request_permission', { options: tooMany }, '0', 0)
    ).toMatchObject({ outcome: 'refuse', code: -32600 });

    const longId = 'a'.repeat(EXTERNAL_TEXT_LIMITS.vendorId + 1);
    expect(
      planCursorServerRequest('session/request_permission', { options: [option(longId)] }, '0', 0)
    ).toMatchObject({ outcome: 'refuse', code: -32600 });

    // The vendor's own JSON-RPC id is in the same position: it is echoed back.
    expect(
      planCursorServerRequest(
        'session/request_permission',
        { options: [option('allow-once')] },
        longId,
        0
      )
    ).toMatchObject({ outcome: 'refuse', code: -32600 });
  });

  it('counts an id by code point, not by UTF-16 length', () => {
    // `boundVendorText` cuts by code point, so an id of astral characters is
    // within bounds at twice the `String.length`. Refusing it would reject a
    // request the rest of the pipeline accepts.
    const astral = '😀'.repeat(EXTERNAL_TEXT_LIMITS.vendorId);
    expect(astral.length).toBe(EXTERNAL_TEXT_LIMITS.vendorId * 2);
    expect(
      planCursorServerRequest(
        'session/request_permission',
        { options: [{ optionId: astral, name: 'Allow', kind: 'allow_once' }] },
        '0',
        0
      )
    ).toMatchObject({ outcome: 'approval' });
  });

  it('accepts exactly as many options as the contract carries', () => {
    const options = Array.from({ length: EXTERNAL_APPROVAL_MAX_OPTIONS }, (_, index) => ({
      optionId: `allow-${index}`,
      name: 'Allow',
      kind: 'allow_once',
    }));
    expect(
      planCursorServerRequest('session/request_permission', { options }, '0', 0)
    ).toMatchObject({ outcome: 'approval' });
  });

  it('plans an approval when the vendor offered choices', () => {
    const plan = planCursorServerRequest(
      'session/request_permission',
      { options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }] },
      '0',
      1_000
    );

    expect(plan).toMatchObject({ outcome: 'approval' });
  });
});
