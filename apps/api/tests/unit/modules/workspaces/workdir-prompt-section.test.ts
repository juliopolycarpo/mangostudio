import { describe, expect, it } from 'bun:test';
import { appendWorkdirPromptSection } from '../../../../src/modules/workspaces/application/workdir-prompt-section';

describe('appendWorkdirPromptSection', () => {
  it('adds the server working directory to an agent system prompt', () => {
    expect(appendWorkdirPromptSection('Base prompt', '/srv/projects/mango')).toBe(
      'Base prompt\n\nWorking directory:\n/srv/projects/mango'
    );
  });

  it('does not change the prompt when no workdir is bound', () => {
    expect(appendWorkdirPromptSection('Base prompt', undefined)).toBe('Base prompt');
  });
});
