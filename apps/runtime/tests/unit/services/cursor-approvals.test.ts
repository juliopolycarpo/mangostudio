/**
 * The client-method table Cursor's ACP server talks to.
 *
 * What matters here is that every server→client request produces *an answer*.
 * A plan that throws instead of refusing is not a stricter refusal — it leaves
 * the vendor parked on a reply that never arrives, and the pump answers those
 * requests one at a time, so one unanswered request stops the connection.
 */

import { describe, expect, it } from 'bun:test';
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
