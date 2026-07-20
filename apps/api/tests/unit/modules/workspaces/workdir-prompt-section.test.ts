import { describe, expect, it } from 'bun:test';
import {
  appendWorkdirPromptSection,
  WORKDIR_RESTRICTED_PROMPT_LINE,
} from '../../../../src/modules/workspaces/application/workdir-prompt-section';

describe('appendWorkdirPromptSection', () => {
  it('adds the server working directory to an agent system prompt', () => {
    expect(appendWorkdirPromptSection('Base prompt', '/srv/projects/mango')).toBe(
      'Base prompt\n\nWorking directory:\n/srv/projects/mango'
    );
  });

  it('adds the restriction line when tools are constrained to the workdir', () => {
    expect(appendWorkdirPromptSection('Base prompt', '/srv/projects/mango', true)).toBe(
      `Base prompt\n\nWorking directory:\n/srv/projects/mango\n${WORKDIR_RESTRICTED_PROMPT_LINE}`
    );
  });

  it('does not change the prompt when no workdir is bound', () => {
    expect(appendWorkdirPromptSection('Base prompt', undefined)).toBe('Base prompt');
  });
});
