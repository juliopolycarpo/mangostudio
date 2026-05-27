import type { MessagePart } from '@mangostudio/shared';
import { describe, expect, it } from 'vitest';
import { planToolGroups } from '@/features/chat/components/tool-call-grouping';

function call(id: string, name: string, args: Record<string, unknown> = {}): MessagePart {
  return { type: 'tool_call', toolCallId: id, name, args };
}

function result(id: string, content = '{}', isError?: boolean): MessagePart {
  return { type: 'tool_result', toolCallId: id, content, isError };
}

describe('planToolGroups', () => {
  it('groups a contiguous run of same-name groupable calls', () => {
    const parts: MessagePart[] = [
      call('1', 'read_file', { path: '/a.ts' }),
      result('1'),
      call('2', 'read_file', { path: '/b.ts' }),
      result('2'),
      call('3', 'read_file', { path: '/c.ts' }),
      result('3'),
    ];

    const { groups, consumed } = planToolGroups(parts, false);

    expect(groups.get(0)).toHaveLength(3);
    expect(groups.get(0)?.map((e) => e.toolCallId)).toEqual(['1', '2', '3']);
    // Leader stays renderable; members are folded in.
    expect(consumed.has(0)).toBe(false);
    expect([...consumed]).toEqual([2, 4]);
  });

  it('does not group a single call', () => {
    const parts: MessagePart[] = [call('1', 'read_file', { path: '/a.ts' }), result('1')];

    const { groups, consumed } = planToolGroups(parts, false);

    expect(groups.size).toBe(0);
    expect(consumed.size).toBe(0);
  });

  it('does not group across a different tool name', () => {
    const parts: MessagePart[] = [
      call('1', 'read_file'),
      call('2', 'list_directory'),
      call('3', 'read_file'),
    ];

    const { groups } = planToolGroups(parts, false);

    expect(groups.size).toBe(0);
  });

  it('does not group non-groupable tools', () => {
    const parts: MessagePart[] = [call('1', 'generate_image'), call('2', 'generate_image')];

    const { groups } = planToolGroups(parts, false);

    expect(groups.size).toBe(0);
  });

  it('breaks a run at an interleaved text part', () => {
    const parts: MessagePart[] = [
      call('1', 'read_file'),
      result('1'),
      { type: 'text', text: 'thinking out loud' },
      call('2', 'read_file'),
      result('2'),
    ];

    const { groups } = planToolGroups(parts, false);

    expect(groups.size).toBe(0);
  });

  it('groups two separate runs independently', () => {
    const parts: MessagePart[] = [
      call('1', 'read_file'),
      call('2', 'read_file'),
      { type: 'text', text: 'mid' },
      call('3', 'list_directory'),
      call('4', 'list_directory'),
    ];

    const { groups } = planToolGroups(parts, false);

    expect(groups.get(0)).toHaveLength(2);
    expect(groups.get(3)).toHaveLength(2);
  });

  it('marks a call pending when streaming with no result', () => {
    const parts: MessagePart[] = [call('1', 'read_file'), result('1'), call('2', 'read_file')];

    const entries = planToolGroups(parts, true).groups.get(0);

    expect(entries?.[0].isPending).toBe(false);
    expect(entries?.[1].isPending).toBe(true);
  });

  it('carries the error flag from a matching result', () => {
    const parts: MessagePart[] = [
      call('1', 'read_file'),
      result('1', 'boom', true),
      call('2', 'read_file'),
      result('2'),
    ];

    const entries = planToolGroups(parts, false).groups.get(0);

    expect(entries?.[0].isError).toBe(true);
    expect(entries?.[1].isError).toBeUndefined();
  });
});
