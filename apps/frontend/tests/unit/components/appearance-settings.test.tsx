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
    expect(screen.getByRole('button', { name: /^dark$/i })).toBeTruthy();
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

  it('all three theme options are enabled', () => {
    render(<AppearanceSettings />);
    const darkBtn = screen.getByRole('button', { name: /^dark$/i });
    const lightBtn = screen.getByRole('button', { name: /^light$/i });
    const systemBtn = screen.getByRole('button', { name: /system/i });
    expect(darkBtn).not.toBeDisabled();
    expect(lightBtn).not.toBeDisabled();
    expect(systemBtn).not.toBeDisabled();
  });

  it('switching to light updates aria-pressed', () => {
    render(<AppearanceSettings />);
    const lightBtn = screen.getByRole('button', { name: /^light$/i });
    fireEvent.click(lightBtn);
    expect(lightBtn.getAttribute('aria-pressed')).toBe('true');
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
    expect(result.current.resolvedTheme).toBe('dark');
  });

  it('returns default code theme config on first load', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.config.codeTheme).toEqual({
      mode: 'auto',
      darkTheme: 'one-dark-pro',
      lightTheme: 'github-light',
    });
    expect(result.current.resolvedCodeTheme).toBe('one-dark-pro');
  });

  it('auto mode resolves to dark theme when app is dark', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolvedTheme).toBe('dark');
    expect(result.current.resolvedCodeTheme).toBe('one-dark-pro');
  });

  it('auto mode resolves to light theme when app is light', async () => {
    const { result } = renderHook(() => useTheme());
    await act(async () => {
      result.current.setConfig({ appTheme: 'light' });
    });
    expect(result.current.resolvedCodeTheme).toBe('github-light');
  });

  it('manual mode uses darkTheme regardless of app theme', async () => {
    const { result } = renderHook(() => useTheme());
    await act(async () => {
      result.current.setConfig({
        appTheme: 'light',
        codeTheme: { mode: 'manual', darkTheme: 'github-dark-dimmed', lightTheme: 'github-light' },
      });
    });
    expect(result.current.resolvedCodeTheme).toBe('github-dark-dimmed');
  });

  it('code theme preference persists in localStorage', async () => {
    const { result } = renderHook(() => useTheme());
    await act(async () => {
      result.current.setConfig({
        codeTheme: { mode: 'manual', darkTheme: 'github-dark-dimmed', lightTheme: 'one-light' },
      });
    });
    const stored = JSON.parse(localStorage.getItem('mango-studio-theme') ?? '{}');
    expect(stored.codeTheme.mode).toBe('manual');
    expect(stored.codeTheme.darkTheme).toBe('github-dark-dimmed');
  });

  it('migrates legacy string codeTheme from localStorage', () => {
    localStorage.setItem('mango-studio-theme', JSON.stringify({ codeTheme: 'one-dark-pro' }));
    const { result } = renderHook(() => useTheme());
    expect(result.current.config.codeTheme.mode).toBe('auto');
    expect(result.current.config.codeTheme.darkTheme).toBe('one-dark-pro');
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

  it('reads persisted settings from localStorage on init', () => {
    localStorage.setItem(
      'mango-studio-theme',
      JSON.stringify({ fontSize: 'small', chatDensity: 'comfortable' })
    );
    // Config is now initialized synchronously via useState lazy initializer.
    const { result } = renderHook(() => useTheme());
    expect(result.current.config.fontSize).toBe('small');
    expect(result.current.config.chatDensity).toBe('comfortable');
  });

  it('reads persisted appTheme from localStorage on init', () => {
    localStorage.setItem('mango-studio-theme', JSON.stringify({ appTheme: 'light' }));
    const { result } = renderHook(() => useTheme());
    expect(result.current.config.appTheme).toBe('light');
    expect(result.current.resolvedTheme).toBe('light');
  });

  it('switching to light sets resolvedTheme and data-theme attribute', async () => {
    const { result } = renderHook(() => useTheme());
    await act(async () => {
      result.current.setConfig({ appTheme: 'light' });
    });
    expect(result.current.config.appTheme).toBe('light');
    expect(result.current.resolvedTheme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('system theme resolves based on OS preference', async () => {
    // jsdom matchMedia defaults to not matching (prefers-color-scheme: dark = false → light)
    const { result } = renderHook(() => useTheme());
    await act(async () => {
      result.current.setConfig({ appTheme: 'system' });
    });
    expect(result.current.config.appTheme).toBe('system');
    expect(result.current.resolvedTheme).toBe('light');
  });

  it('theme persists across page loads via localStorage', async () => {
    const { result } = renderHook(() => useTheme());
    await act(async () => {
      result.current.setConfig({ appTheme: 'light' });
    });
    const stored = JSON.parse(localStorage.getItem('mango-studio-theme') ?? '{}');
    expect(stored.appTheme).toBe('light');
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

describe('AppearanceSettings — code theme selector', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.fontSize;
    delete document.documentElement.dataset.chatDensity;
  });

  it('renders the code theme section', () => {
    render(<AppearanceSettings />);
    expect(screen.getByText('Code Theme')).toBeTruthy();
  });

  it('shows auto and manual mode buttons', () => {
    render(<AppearanceSettings />);
    expect(screen.getByRole('button', { name: /auto/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /manual/i })).toBeTruthy();
  });

  it('shows 4 theme cards in manual mode', () => {
    render(<AppearanceSettings />);
    const manualBtn = screen.getByRole('button', { name: /manual/i });
    fireEvent.click(manualBtn);
    expect(screen.getByText('One Dark Pro')).toBeTruthy();
    expect(screen.getByText('GitHub Dark Dimmed')).toBeTruthy();
    expect(screen.getByText('GitHub Light')).toBeTruthy();
    expect(screen.getByText('One Light')).toBeTruthy();
  });

  it('shows dark and light preference sections in auto mode', () => {
    render(<AppearanceSettings />);
    // Default is auto mode
    expect(screen.getByText('Dark preference')).toBeTruthy();
    expect(screen.getByText('Light preference')).toBeTruthy();
  });

  it('switching mode toggles between auto and manual views', () => {
    render(<AppearanceSettings />);
    // Auto mode — dark/light preference labels visible
    expect(screen.getByText('Dark preference')).toBeTruthy();

    // Switch to manual
    fireEvent.click(screen.getByRole('button', { name: /manual/i }));
    expect(screen.queryByText('Dark preference')).toBeNull();
    expect(screen.getByText('One Dark Pro')).toBeTruthy();
  });
});
