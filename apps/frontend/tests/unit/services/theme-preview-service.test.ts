/**
 * Unit tests for the theme preview generation service.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { getCachedPreview, clearPreviewCache } from '../../../src/services/theme-preview-service';

vi.mock('@/lib/shiki', () => ({
  highlightCode: vi.fn(() => '<pre class="shiki">mock html</pre>'),
  loadThemeOnDemand: vi.fn().mockResolvedValue(true),
  initHighlighter: vi.fn().mockResolvedValue(undefined),
  isThemeAvailable: vi.fn(() => true),
}));

describe('theme-preview-service', () => {
  beforeEach(() => {
    clearPreviewCache();
  });

  it('getCachedPreview returns null before any preview is generated', () => {
    expect(getCachedPreview('dracula')).toBeNull();
  });
});
