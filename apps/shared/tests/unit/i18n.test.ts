import { describe, expect, it } from 'bun:test';
import { en, ptBR } from '../../src/i18n';

describe('i18n provider-neutral copy', () => {
  it('keeps generic chat placeholder copy provider-neutral', () => {
    expect(en.chat.input.placeholder).not.toContain('Gemini');
    expect(ptBR.chat.input.placeholder).not.toContain('Gemini');
  });

  it('keeps generated image filenames provider-neutral', () => {
    expect(en.common.downloadFilenamePrefix).toBe('mangostudio');
    expect(ptBR.common.downloadFilenamePrefix).toBe('mangostudio');
  });
});
