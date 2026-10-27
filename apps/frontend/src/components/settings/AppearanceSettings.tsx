import type { DiffPreviewMode } from '@mangostudio/shared/app-settings';
import { Check } from 'lucide-react';

import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SettingsSegmented } from '@/components/settings/SettingsSegmented';
import { SettingToggle } from '@/components/settings/SettingToggle';
import { SELECTION_BAR } from '@/components/ui/selection-bar';
import { useGlobalSettings } from '@/hooks/use-global-settings';
import { useI18n } from '@/hooks/use-i18n';
import type { CodeThemeConfig, ThemeConfig } from '@/hooks/use-theme';
import { useTheme } from '@/hooks/use-theme';
import { CODE_THEMES, type CodeThemeId } from '@/lib/code-themes';
import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

import { ThemePreviewSample } from './ThemePreviewSample';

type AppTheme = ThemeConfig['appTheme'];
type FontSize = ThemeConfig['fontSize'];
type ChatDensity = ThemeConfig['chatDensity'];

const THEME_I18N_KEYS = {
  'one-dark-pro': 'oneDarkPro',
  'github-dark-dimmed': 'githubDarkDimmed',
  'github-light': 'githubLight',
  'one-light': 'oneLight',
} as const satisfies Record<CodeThemeId, string>;

/**
 * A code theme as a tile: a live sample of the theme above its name. The
 * current theme is marked as the current item is everywhere else — a neutral
 * fill and the accent bar on the caption's leading edge — plus a check and a
 * firmer border, so selection is never the colour alone and the tile keeps one
 * border width whether or not it is chosen.
 */
function ThemeCard({
  themeId,
  selected,
  onClick,
  label,
}: {
  themeId: CodeThemeId;
  selected: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'cursor-pointer overflow-hidden rounded-sm border text-left transition-colors',
        selected ? 'border-stroke-strong' : 'border-stroke hover:border-stroke-strong'
      )}
    >
      <ThemePreviewSample themeId={themeId} />
      <div
        className={cn(
          'relative flex items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-fg',
          selected ? cn('bg-fill-selected', SELECTION_BAR) : 'bg-surface'
        )}
      >
        {label}
        {selected ? (
          <Check size={ICON_SM} className="shrink-0 text-accent-fg" aria-hidden="true" />
        ) : null}
      </div>
    </button>
  );
}

const DIFF_PREVIEW_MODE_I18N_KEYS = {
  expanded: 'modeExpanded',
  collapsed: 'modeCollapsed',
  collapse_older: 'modeCollapseOlder',
} as const satisfies Record<DiffPreviewMode, string>;

const DIFF_PREVIEW_MODES = ['expanded', 'collapsed', 'collapse_older'] as const;

/**
 * Appearance settings page: app theme, font size and chat density in one
 * card, then code theme and file change previews.
 */
export function AppearanceSettings() {
  const { t } = useI18n();
  const { config, setConfig } = useTheme();
  const { chatDisplaySettings, setDiffPreviewsEnabled, setDiffPreviewMode } = useGlobalSettings();
  const s = t.settings.appearance;

  const codeTheme = config.codeTheme;
  const setCodeThemeMode = (mode: CodeThemeConfig['mode']) =>
    setConfig({ codeTheme: { ...codeTheme, mode } });
  const setDarkTheme = (darkTheme: CodeThemeId) =>
    setConfig({ codeTheme: { ...codeTheme, darkTheme } });
  const setLightTheme = (lightTheme: CodeThemeId) =>
    setConfig({ codeTheme: { ...codeTheme, lightTheme } });

  const darkThemes = CODE_THEMES.filter(
    (id) => id === 'one-dark-pro' || id === 'github-dark-dimmed'
  );
  const lightThemes = CODE_THEMES.filter((id) => id === 'github-light' || id === 'one-light');

  return (
    <SettingsPage title={s.title}>
      {/* The page's plain choices share one card, one row each, as General's
          first card does; Code theme and File changes keep their own headed
          sections because each carries more than a single control. */}
      <SettingsSection>
        <SettingsRow label={s.appTheme.label} hint={s.appTheme.description} layout="stacked">
          <SettingsSegmented<AppTheme>
            ariaLabel={s.appTheme.label}
            value={config.appTheme}
            options={[
              { value: 'dark', label: s.appTheme.dark },
              { value: 'light', label: s.appTheme.light },
              { value: 'system', label: s.appTheme.system },
            ]}
            onChange={(appTheme) => setConfig({ appTheme })}
          />
        </SettingsRow>
        <SettingsRow label={s.fontSize.label} hint={s.fontSize.description} layout="stacked">
          <SettingsSegmented<FontSize>
            ariaLabel={s.fontSize.label}
            value={config.fontSize}
            options={[
              { value: 'small', label: s.fontSize.small },
              { value: 'default', label: s.fontSize.default },
              { value: 'large', label: s.fontSize.large },
            ]}
            onChange={(fontSize) => setConfig({ fontSize })}
          />
          <p
            className="mt-3 leading-relaxed text-fg-muted"
            style={{ fontSize: 'var(--chat-font-size)' }}
          >
            {s.fontSize.preview}
          </p>
        </SettingsRow>
        <SettingsRow label={s.chatDensity.label} hint={s.chatDensity.description} layout="stacked">
          <SettingsSegmented<ChatDensity>
            ariaLabel={s.chatDensity.label}
            value={config.chatDensity}
            options={[
              { value: 'compact', label: s.chatDensity.compact },
              { value: 'default', label: s.chatDensity.default },
              { value: 'comfortable', label: s.chatDensity.comfortable },
            ]}
            onChange={(chatDensity) => setConfig({ chatDensity })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={s.codeTheme.label} description={s.codeTheme.description} padded>
        <SettingsSegmented<CodeThemeConfig['mode']>
          ariaLabel={s.codeTheme.label}
          value={codeTheme.mode}
          options={[
            { value: 'auto', label: s.codeTheme.auto },
            { value: 'manual', label: s.codeTheme.manual },
          ]}
          onChange={setCodeThemeMode}
        />

        {codeTheme.mode === 'auto' ? (
          <div className="space-y-5">
            <div className="space-y-2">
              <p className="text-sm font-medium text-fg">{s.codeTheme.darkPreference}</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {darkThemes.map((id) => (
                  <ThemeCard
                    key={id}
                    themeId={id}
                    selected={codeTheme.darkTheme === id}
                    onClick={() => setDarkTheme(id)}
                    label={s.codeTheme[THEME_I18N_KEYS[id]]}
                  />
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium text-fg">{s.codeTheme.lightPreference}</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {lightThemes.map((id) => (
                  <ThemeCard
                    key={id}
                    themeId={id}
                    selected={codeTheme.lightTheme === id}
                    onClick={() => setLightTheme(id)}
                    label={s.codeTheme[THEME_I18N_KEYS[id]]}
                  />
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {CODE_THEMES.map((id) => (
              <ThemeCard
                key={id}
                themeId={id}
                selected={codeTheme.darkTheme === id}
                onClick={() => setDarkTheme(id)}
                label={s.codeTheme[THEME_I18N_KEYS[id]]}
              />
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={s.fileChanges.label} description={s.fileChanges.description}>
        <SettingToggle
          label={s.fileChanges.enabled}
          checked={chatDisplaySettings.diffPreviewsEnabled}
          onChange={setDiffPreviewsEnabled}
        />
        {chatDisplaySettings.diffPreviewsEnabled ? (
          <SettingsRow hint={s.fileChanges.modeDescription} layout="stacked">
            <SettingsSegmented<DiffPreviewMode>
              ariaLabel={s.fileChanges.label}
              value={chatDisplaySettings.diffPreviewMode}
              options={DIFF_PREVIEW_MODES.map((mode) => ({
                value: mode,
                label: s.fileChanges[DIFF_PREVIEW_MODE_I18N_KEYS[mode]],
              }))}
              onChange={setDiffPreviewMode}
            />
          </SettingsRow>
        ) : null}
      </SettingsSection>
    </SettingsPage>
  );
}
