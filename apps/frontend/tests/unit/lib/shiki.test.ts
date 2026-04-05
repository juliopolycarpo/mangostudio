/**
 * Unit tests for the Shiki theme engine.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  getInstalledThemeIds,
  isThemeAvailable,
  isThemeBuiltIn,
  uninstallTheme,
  BUILTIN_THEMES,
  SUGGESTED_THEMES,
  SHIKI_THEME_CATALOG,
} from '../../../src/lib/shiki';

describe('Shiki theme engine', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('BUILTIN_THEMES', () => {
    it('contains exactly two built-in themes', () => {
      expect(BUILTIN_THEMES).toEqual(['one-dark-pro', 'one-light']);
    });
  });

  describe('SUGGESTED_THEMES', () => {
    it('contains recommended themes separate from built-ins', () => {
      expect(SUGGESTED_THEMES.length).toBeGreaterThan(0);
      for (const theme of SUGGESTED_THEMES) {
        expect((BUILTIN_THEMES as readonly string[]).includes(theme)).toBe(false);
      }
    });
  });

  describe('SHIKI_THEME_CATALOG', () => {
    it('contains all bundled Shiki themes', () => {
      expect(SHIKI_THEME_CATALOG.length).toBeGreaterThan(60);
    });

    it('includes builtin themes', () => {
      for (const theme of BUILTIN_THEMES) {
        expect(SHIKI_THEME_CATALOG).toContain(theme);
      }
    });
  });

  describe('isThemeBuiltIn', () => {
    it('returns true for built-in themes', () => {
      expect(isThemeBuiltIn('one-dark-pro')).toBe(true);
      expect(isThemeBuiltIn('one-light')).toBe(true);
    });

    it('returns false for non-built-in themes', () => {
      expect(isThemeBuiltIn('dracula')).toBe(false);
      expect(isThemeBuiltIn('github-dark-dimmed')).toBe(false);
    });
  });

  describe('isThemeAvailable', () => {
    it('returns true for built-in themes without any installation', () => {
      expect(isThemeAvailable('one-dark-pro')).toBe(true);
      expect(isThemeAvailable('one-light')).toBe(true);
    });

    it('returns false for non-built-in themes when not installed', () => {
      expect(isThemeAvailable('dracula')).toBe(false);
    });

    it('returns true for installed themes', () => {
      localStorage.setItem('mango-studio-installed-themes', JSON.stringify(['dracula']));
      expect(isThemeAvailable('dracula')).toBe(true);
    });
  });

  describe('getInstalledThemeIds', () => {
    it('returns empty array when nothing installed', () => {
      expect(getInstalledThemeIds()).toEqual([]);
    });

    it('returns installed theme IDs from localStorage', () => {
      localStorage.setItem('mango-studio-installed-themes', JSON.stringify(['dracula', 'nord']));
      expect(getInstalledThemeIds()).toEqual(['dracula', 'nord']);
    });

    it('handles corrupted localStorage gracefully', () => {
      localStorage.setItem('mango-studio-installed-themes', 'not-json');
      expect(getInstalledThemeIds()).toEqual([]);
    });
  });

  describe('uninstallTheme', () => {
    it('removes a theme from installed list', () => {
      localStorage.setItem('mango-studio-installed-themes', JSON.stringify(['dracula', 'nord']));
      const result = uninstallTheme('dracula');
      expect(result).toBe(true);
      expect(getInstalledThemeIds()).toEqual(['nord']);
    });

    it('returns false when trying to uninstall a built-in theme', () => {
      const result = uninstallTheme('one-dark-pro');
      expect(result).toBe(false);
    });

    it('handles uninstalling a theme that is not installed', () => {
      const result = uninstallTheme('dracula');
      expect(result).toBe(true);
      expect(getInstalledThemeIds()).toEqual([]);
    });
  });
});
