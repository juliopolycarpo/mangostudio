import type { DiffPreviewMode } from '@mangostudio/shared/app-settings';
import { Check } from 'lucide-react';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SettingsSegmented } from '@/components/settings/SettingsSegmented';
import { SettingToggle } from '@/components/settings/SettingToggle';
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
 * current theme is the accent border plus a check, so selection is never the
 * colour alone.
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
        'cursor-pointer overflow-hidden rounded-sm border-2 text-left transition-colors',
        selected ? 'border-accent' : 'border-stroke hover:border-stroke-strong'
      )}
    >
      <ThemePreviewSample themeId={themeId} />
      <div className="flex items-center justify-between gap-2 bg-surface px-3 py-2 text-xs font-medium text-fg">
        {label}
        {selected ? (
          <Check size={ICON_SM} className="shrink-0 text-accent-fg" aria-hidden="true" />
        ) : null}
      </div>
    </button>
  );
}

const PREVIEW_SENTENCE = 'The quick brown fox jumps over the lazy dog.';

const DIFF_PREVIEW_MODE_I18N_KEYS = {
  expanded: 'modeExpanded',
  collapsed: 'modeCollapsed',
  collapse_older: 'modeCollapseOlder',
} as const satisfies Record<DiffPreviewMode, string>;

const DIFF_PREVIEW_MODES = ['expanded', 'collapsed', 'collapse_older'] as const;

/**
 * Appearance settings page: app theme, code theme, font size, chat density,
 * file change previews.
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
      <SettingsSection title={s.appTheme.label} description={s.appTheme.description} padded>
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

      <SettingsSection title={s.fontSize.label} description={s.fontSize.description} padded>
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
          className="border-t border-stroke pt-4 leading-relaxed text-fg-muted"
          style={{ fontSize: 'var(--chat-font-size)' }}
        >
          {PREVIEW_SENTENCE}
        </p>
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

      <SettingsSection title={s.chatDensity.label} description={s.chatDensity.description} padded>
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
      </SettingsSection>
    </SettingsPage>
  );
}
