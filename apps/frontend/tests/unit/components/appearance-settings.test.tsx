/**
 * Unit tests for AppearanceSettings component and useTheme hook.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import { render, renderHook } from '../../support/harness/render';
import { AppearanceSettings } from '../../../src/components/settings/AppearanceSettings';
import { SettingsTabs } from '../../../src/components/settings/SettingsTabs';
import { useTheme } from '../../../src/hooks/use-theme';

// SettingsTabs uses TanStack Router Link — mock it to a simple anchor
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    Link: ({
      to,
      children,
      ...props
    }: {
      to: string;
      children: React.ReactNode;
      [k: string]: unknown;
    }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
    useRouterState: () => ({ location: { pathname: '/settings/appearance' } }),
  };
});

describe('AppearanceSettings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    // Reset data- attributes on documentElement
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.fontSize;
    delete document.documentElement.dataset.chatDensity;
  });

  it('renders the app theme section', () => {
    render(<AppearanceSettings />);
    expect(screen.getByText('App Theme')).toBeTruthy();
    expect(screen.getByRole('button', { name: /dark/i })).toBeTruthy();
  });

  it('renders the font size section with all options', () => {
    render(<AppearanceSettings />);
    expect(screen.getByText('Font Size')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^small$/i })).toBeTruthy();
    // Multiple 'Default' buttons exist (font size + density); verify at least one per group
    const defaultButtons = screen.getAllByRole('button', { name: /^default$/i });
    expect(defaultButtons.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: /^large$/i })).toBeTruthy();
  });

  it('renders the chat density section with all options', () => {
    render(<AppearanceSettings />);
    expect(screen.getByText('Chat Density')).toBeTruthy();
    expect(screen.getByRole('button', { name: /compact/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /comfortable/i })).toBeTruthy();
  });

  it('changing font size updates aria-pressed on the selected button', () => {
    render(<AppearanceSettings />);
    const largeBtn = screen.getByRole('button', { name: /large/i });
    fireEvent.click(largeBtn);
    expect(largeBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('changing density updates aria-pressed on the selected button', () => {
    render(<AppearanceSettings />);
    const compactBtn = screen.getByRole('button', { name: /compact/i });
    fireEvent.click(compactBtn);
    expect(compactBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('Light and System theme buttons are disabled', () => {
    render(<AppearanceSettings />);
    const lightBtn = screen.getByRole('button', { name: /light/i });
    const systemBtn = screen.getByRole('button', { name: /system/i });
    expect(lightBtn).toBeDisabled();
    expect(systemBtn).toBeDisabled();
  });
});

describe('useTheme hook', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.fontSize;
    delete document.documentElement.dataset.chatDensity;
  });

  it('returns default config on first load', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.config.appTheme).toBe('dark');
    expect(result.current.config.fontSize).toBe('default');
    expect(result.current.config.chatDensity).toBe('default');
  });

  it('setConfig updates fontSize in config', async () => {
    const { result } = renderHook(() => useTheme());
    await act(async () => {
      result.current.setConfig({ fontSize: 'large' });
    });
    expect(result.current.config.fontSize).toBe('large');
  });

  it('setConfig persists settings to localStorage', async () => {
    const { result } = renderHook(() => useTheme());
    await act(async () => {
      result.current.setConfig({ chatDensity: 'compact' });
    });
    const stored = JSON.parse(localStorage.getItem('mango-studio-theme') ?? '{}');
    expect(stored.chatDensity).toBe('compact');
  });

  it('reads persisted settings from localStorage on init', async () => {
    localStorage.setItem(
      'mango-studio-theme',
      JSON.stringify({ fontSize: 'small', chatDensity: 'comfortable' })
    );
    const { result } = renderHook(() => useTheme());
    // useEffect reads localStorage on mount
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(result.current.config.fontSize).toBe('small');
    expect(result.current.config.chatDensity).toBe('comfortable');
  });
});

describe('SettingsTabs — appearance tab present', () => {
  it('renders an Appearance tab link', () => {
    render(<SettingsTabs />);
    const links = screen.getAllByRole('link');
    const appearanceLink = links.find((l) => l.textContent?.toLowerCase().includes('appearance'));
    expect(appearanceLink).toBeTruthy();
  });
});
