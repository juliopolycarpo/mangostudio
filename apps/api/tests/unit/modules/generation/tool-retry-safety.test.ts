import { describe, expect, it } from 'bun:test';

import {
  type ToolRetrySafety,
  TOOLS_NEEDING_A_MODEL_TURN,
} from '@mangostudio/shared/tool-executions';

import { classifyToolRetrySafety } from '../../../../src/modules/generation/application/tool-retry-safety';
import { getTool, registerTool } from '../../../../src/services/tools';
import { DELEGATE_TO_AGENT_TOOL_NAME } from '../../../../src/services/tools/builtin/delegate-to-agent';
import { GENERATE_IMAGE_TOOL_NAME } from '../../../../src/services/tools/builtin/generate-image';
import type { RegisteredTool } from '../../../../src/services/tools/types';
import { expectedToolNames } from '../../../support/registration-expectations';

/**
 * Every builtin, classified on purpose. A new tool fails the coverage test below
 * until someone decides here, which is the point: the default is the cautious
 * answer, and a read must be a deliberate claim.
 */
const BUILTIN_RETRY_SAFETY: Readonly<Record<string, ToolRetrySafety>> = {
  apply_patch: 'confirmation_required',
  ask_user_question: 'confirmation_required',
  bash: 'confirmation_required',
  create_file: 'confirmation_required',
  delegate_to_agent: 'unknown',
  delete_file: 'confirmation_required',
  edit_file: 'confirmation_required',
  generate_image: 'confirmation_required',
  get_current_datetime: 'safe_read',
  glob: 'safe_read',
  grep: 'safe_read',
  list_directory: 'safe_read',
  move_file: 'confirmation_required',
  powershell: 'confirmation_required',
  read_file: 'safe_read',
  replace_range: 'confirmation_required',
  skill: 'safe_read',
  todo_read: 'safe_read',
  todo_write: 'confirmation_required',
  write_file: 'confirmation_required',
  zsh: 'confirmation_required',
};

function fakeTool(
  name: string,
  settings: Partial<RegisteredTool['settings']> = {}
): RegisteredTool {
  return {
    definition: { name, description: name, parameters: {} },
    settings: {
      title: name,
      description: name,
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      defaultParameters: {},
      parameterDescriptors: [],
      ...settings,
    },
    execute: () => Promise.resolve({}),
  };
}

describe('builtin retry safety table', () => {
  it('classifies every registered builtin explicitly', () => {
    expect(Object.keys(BUILTIN_RETRY_SAFETY).sort()).toEqual(expectedToolNames());
  });

  for (const [name, expected] of Object.entries(BUILTIN_RETRY_SAFETY)) {
    it(`${name} is ${expected}, declared on its own metadata`, () => {
      const tool = getTool(name);
      expect(tool, `builtin "${name}" is not registered`).toBeDefined();
      // Declared, not defaulted: the registry's default must never be what classifies a builtin.
      expect(tool?.settings.retrySafety, `builtin "${name}" declares no retrySafety`).toBe(
        expected
      );
      expect(classifyToolRetrySafety(name)).toBe(expected);
    });
  }
});

describe('tools a user retry cannot run', () => {
  it('names the builtins whose constants live in the API workspace', () => {
    // Shared matches by name; this keeps those names from drifting from the tools.
    expect(TOOLS_NEEDING_A_MODEL_TURN.has(GENERATE_IMAGE_TOOL_NAME)).toBe(true);
    expect(TOOLS_NEEDING_A_MODEL_TURN.has(DELEGATE_TO_AGENT_TOOL_NAME)).toBe(true);
    expect(
      TOOLS_NEEDING_A_MODEL_TURN.has(getTool('ask_user_question')?.definition.name ?? '')
    ).toBe(true);
  });
});

describe('classifyToolRetrySafety', () => {
  it('defaults a tool that declares nothing to confirmation_required', () => {
    registerTool(fakeTool('undeclared_fake_tool'));

    expect(classifyToolRetrySafety('undeclared_fake_tool')).toBe('confirmation_required');
  });

  it('defaults a name the registry does not know to confirmation_required', () => {
    expect(classifyToolRetrySafety('not_registered_anywhere')).toBe('confirmation_required');
  });

  it('honours a declared safe_read on an ordinary tool', () => {
    registerTool(fakeTool('declared_read_fake_tool', { retrySafety: 'safe_read' }));

    expect(classifyToolRetrySafety('declared_read_fake_tool')).toBe('safe_read');
  });

  it('never calls a tool that writes outside a checkpointed path safe_read', () => {
    registerTool(
      fakeTool('shell_like_fake_tool', {
        retrySafety: 'safe_read',
        uncheckpointedWriteSource: 'shell',
      })
    );

    expect(classifyToolRetrySafety('shell_like_fake_tool')).toBe('confirmation_required');
  });

  it('never calls subagent delegation safe_read, whatever the metadata says', () => {
    registerTool(fakeTool('delegate_to_agent', { retrySafety: 'safe_read' }));

    expect(classifyToolRetrySafety('delegate_to_agent')).toBe('unknown');
  });
});

describe('classifyToolRetrySafety for MCP tools', () => {
  const MCP_NAME = 'mcp__github__create_issue';

  it('defaults to unknown: the server is untrusted', () => {
    expect(classifyToolRetrySafety(MCP_NAME)).toBe('unknown');
    expect(classifyToolRetrySafety(MCP_NAME, { mcpHints: {} })).toBe('unknown');
  });

  it('lowers the prompt one step for a readOnlyHint or an idempotentHint', () => {
    expect(classifyToolRetrySafety(MCP_NAME, { mcpHints: { readOnlyHint: true } })).toBe(
      'confirmation_required'
    );
    expect(classifyToolRetrySafety(MCP_NAME, { mcpHints: { idempotentHint: true } })).toBe(
      'confirmation_required'
    );
  });

  it('ignores a hint that says the tool is not read-only or not idempotent', () => {
    expect(
      classifyToolRetrySafety(MCP_NAME, {
        mcpHints: { readOnlyHint: false, idempotentHint: false },
      })
    ).toBe('unknown');
  });

  it('never reaches safe_read, however the hints combine', () => {
    for (const readOnlyHint of [undefined, true, false]) {
      for (const idempotentHint of [undefined, true, false]) {
        expect(
          classifyToolRetrySafety(MCP_NAME, { mcpHints: { readOnlyHint, idempotentHint } }),
          `readOnlyHint=${String(readOnlyHint)} idempotentHint=${String(idempotentHint)}`
        ).not.toBe('safe_read');
      }
    }
  });
});
