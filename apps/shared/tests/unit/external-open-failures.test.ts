import { describe, expect, it } from 'bun:test';
import {
  EXTERNAL_AGENT_CAPACITY_CODE,
  isExternalAgentKindCode,
} from '../../src/external-agents/open-failures';

describe('isExternalAgentKindCode', () => {
  it('accepts every kind the runtime spells for a failed open, including the session cap', () => {
    const kinds = [
      EXTERNAL_AGENT_CAPACITY_CODE,
      'external_agent_launch_failed',
      'external_agent_link_lost',
      'external_agent_closed',
      'external_agent_protocol',
      'external_agent_vendor',
      'external_agent_failure',
    ];

    expect(kinds.filter((kind) => !isExternalAgentKindCode(kind))).toEqual([]);
  });

  it('refuses anything that is not that shape, with the value it received', () => {
    const received = [
      '',
      'tool_argument',
      '__proto__',
      'external_agent_',
      'external_agent_Launch',
      'external_agent_<img src=x onerror=alert(1)>',
      'external_agent_launch failed',
      `external_agent_${'a'.repeat(60)}`,
      undefined,
      42,
      null,
    ].filter(isExternalAgentKindCode);

    expect(received, 'expected no value of the wrong shape to be accepted').toEqual([]);
  });
});
