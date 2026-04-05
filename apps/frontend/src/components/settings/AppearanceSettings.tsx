import { useState, useEffect, useCallback } from 'react';
import { Download, Trash2, Check, ShoppingBag } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';
import { useTheme } from '@/hooks/use-theme';
import type { ThemeConfig, CodeThemeConfig } from '@/hooks/use-theme';
import {
  BUILTIN_THEMES,
  SUGGESTED_THEMES,
  type CodeThemeId,
  isThemeBuiltIn,
  isThemeAvailable,
  getInstalledThemeIds,
  loadThemeOnDemand,
  uninstallTheme,
} from '@/lib/shiki';
import { getThemePreview, getCachedPreview } from '@/services/theme-preview-service';
import { useNavigate } from '@tanstack/react-router';

type FontSize = ThemeConfig['fontSize'];
type ChatDensity = ThemeConfig['chatDensity'];

function OptionButton({
  selected,
  disabled,
  onClick,
  label,
  badge,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick?: () => void;
  label: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={`
        flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200
        border focus:outline-none focus:ring-2 focus:ring-primary/40
        ${
          selected
            ? 'bg-primary/15 border-primary/50 text-primary'
            : disabled
              ? 'opacity-40 cursor-not-allowed border-outline-variant/20 text-on-surface-variant/50'
              : 'border-outline-variant/20 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface cursor-pointer'
        }
      `}
    >
      {label}
      {badge && (
        <span className="ml-1.5 text-[10px] font-label font-bold text-on-surface-variant/50 uppercase tracking-wide">
          {badge}
        </span>
      )}
    </button>
  );
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card variant="solid" className="space-y-3 p-6">
      <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
        {title}
      </h3>
      <p className="text-sm text-on-surface-variant/60">{description}</p>
      {children}
    </Card>
  );
}

/** Prettify a Shiki theme ID into a human-readable display name. */
function formatThemeName(id: string): string {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function ThemeCard({
  themeId,
  selected,
  onClick,
  label,
  installed,
  builtIn,
  onInstall,
  onUninstall,
  loading,
}: {
  themeId: CodeThemeId;
  selected: boolean;
  onClick: () => void;
  label: string;
  installed: boolean;
  builtIn: boolean;
  onInstall?: () => void;
  onUninstall?: () => void;
  loading?: boolean;
}) {
  const { t } = useI18n();
  const [previewHtml, setPreviewHtml] = useState<string | null>(() => getCachedPreview(themeId));

  useEffect(() => {
    if (!previewHtml) {
      void getThemePreview(themeId).then((html) => {
        if (html) setPreviewHtml(html);
      });
    }
  }, [themeId, previewHtml]);

  const mp = t.marketplace;

  return (
    <div
      className={`
        group relative rounded-xl border-2 transition-all duration-200 overflow-hidden text-left
        focus-within:ring-2 focus-within:ring-primary/40
        ${selected ? 'border-primary ring-1 ring-primary/30' : 'border-outline-variant/20 hover:border-outline-variant/50'}
      `}
    >
      <button
        type="button"
        onClick={onClick}
        aria-pressed={selected}
        className="w-full text-left cursor-pointer"
      >
        {previewHtml ? (
          <div
            className="p-3 text-[11px] leading-normal font-mono overflow-hidden [&_pre]:!m-0 [&_pre]:!p-0 [&_pre]:!bg-transparent [&_pre]:overflow-hidden"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        ) : (
          <div className="p-3 h-20 bg-surface-container-lowest animate-pulse rounded-t-lg" />
        )}
        <div className="px-3 py-2 text-xs font-semibold text-on-surface-variant bg-surface-container-high flex items-center justify-between">
          <span>{label}</span>
          {installed && <Check size={12} className="text-primary" />}
        </div>
      </button>

      {/* Hover overlay with actions:
           pointer-events-none keeps clicks on the select button when not hovered;
           pointer-events-auto re-enables on hover so install/uninstall work. */}
      {!builtIn && (
        <div className="absolute inset-0 bg-background/60 backdrop-blur-sm pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center gap-2">
          {!installed ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onInstall?.();
              }}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-bold transition-all active:scale-95 disabled:opacity-50"
              title={mp.download}
            >
              {loading ? (
                <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
              ) : (
                <Download size={12} />
              )}
              {mp.install}
            </button>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onUninstall?.();
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-error/10 text-error text-xs font-bold transition-all active:scale-95"
              title={mp.uninstall}
            >
              <Trash2 size={12} />
              {mp.uninstall}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Appearance settings tab: app theme, code theme, font size, chat density.
 */
export function AppearanceSettings() {
  const { t } = useI18n();
  const { config, setConfig } = useTheme();
  const navigate = useNavigate();
  const s = t.settings.appearance;
  const mp = t.marketplace;

  const [installedIds, setInstalledIds] = useState<CodeThemeId[]>(() => getInstalledThemeIds());
  const [loadingTheme, setLoadingTheme] = useState<CodeThemeId | null>(null);

  const refreshInstalled = useCallback(() => {
    setInstalledIds(getInstalledThemeIds());
  }, []);

  const setFontSize = (fontSize: FontSize) => setConfig({ fontSize });
  const setDensity = (chatDensity: ChatDensity) => setConfig({ chatDensity });

  const codeTheme = config.codeTheme;
  const setCodeThemeMode = (mode: CodeThemeConfig['mode']) =>
    setConfig({ codeTheme: { ...codeTheme, mode } });
  const setDarkTheme = (darkTheme: CodeThemeId) =>
    setConfig({ codeTheme: { ...codeTheme, darkTheme } });
  const setLightTheme = (lightTheme: CodeThemeId) =>
    setConfig({ codeTheme: { ...codeTheme, lightTheme } });

  const handleInstall = useCallback(
    async (id: CodeThemeId) => {
      setLoadingTheme(id);
      const ok = await loadThemeOnDemand(id);
      if (ok) refreshInstalled();
      setLoadingTheme(null);
    },
    [refreshInstalled]
  );

  const handleUninstall = useCallback(
    (id: CodeThemeId) => {
      uninstallTheme(id);
      refreshInstalled();
    },
    [refreshInstalled]
  );

  const selectTheme = useCallback(
    (id: CodeThemeId) => {
      if (isThemeAvailable(id)) {
        setDarkTheme(id);
      } else {
        void handleInstall(id).then(() => setDarkTheme(id));
      }
    },
    [handleInstall, setDarkTheme]
  );

  /** All available theme IDs: built-in + installed (deduped). */
  const allAvailable: CodeThemeId[] = [
    ...BUILTIN_THEMES,
    ...installedIds.filter((id) => !isThemeBuiltIn(id)),
  ];

  const builtInDark = BUILTIN_THEMES.filter((id) => id === 'one-dark-pro');
  const builtInLight = BUILTIN_THEMES.filter((id) => id === 'one-light');

  const suggestedNotInstalled = SUGGESTED_THEMES.filter((id) => !isThemeAvailable(id));
  const suggestedInstalled = SUGGESTED_THEMES.filter(
    (id) => isThemeAvailable(id) && !isThemeBuiltIn(id)
  );

  const extraInstalled = installedIds.filter(
    (id) => !isThemeBuiltIn(id) && !(SUGGESTED_THEMES as readonly string[]).includes(id)
  );

  const getLabel = (id: CodeThemeId) => formatThemeName(id);

  const renderThemeCard = (id: CodeThemeId, { isDarkSlot }: { isDarkSlot?: boolean } = {}) => (
    <ThemeCard
      key={id}
      themeId={id}
      selected={
        isDarkSlot === undefined
          ? codeTheme.darkTheme === id
          : isDarkSlot
            ? codeTheme.darkTheme === id
            : codeTheme.lightTheme === id
      }
      onClick={() => (isDarkSlot === false ? setLightTheme(id) : selectTheme(id))}
      label={getLabel(id)}
      installed={isThemeAvailable(id)}
      builtIn={isThemeBuiltIn(id)}
      onInstall={() => void handleInstall(id)}
      onUninstall={() => handleUninstall(id)}
      loading={loadingTheme === id}
    />
  );

  return (
    <div className="space-y-4">
      {/* ── App Theme ── */}
      <SettingsSection title={s.appTheme.label} description={s.appTheme.description}>
        <div className="flex gap-2">
          <OptionButton
            selected={config.appTheme === 'dark'}
            onClick={() => setConfig({ appTheme: 'dark' })}
            label={s.appTheme.dark}
          />
          <OptionButton
            selected={config.appTheme === 'light'}
            onClick={() => setConfig({ appTheme: 'light' })}
            label={s.appTheme.light}
          />
          <OptionButton
            selected={config.appTheme === 'system'}
            onClick={() => setConfig({ appTheme: 'system' })}
            label={s.appTheme.system}
          />
        </div>
      </SettingsSection>

      {/* ── Code Theme ── */}
      <SettingsSection title={s.codeTheme.label} description={s.codeTheme.description}>
        <div className="flex gap-2">
          <OptionButton
            selected={codeTheme.mode === 'auto'}
            onClick={() => setCodeThemeMode('auto')}
            label={s.codeTheme.auto}
          />
          <OptionButton
            selected={codeTheme.mode === 'manual'}
            onClick={() => setCodeThemeMode('manual')}
            label={s.codeTheme.manual}
          />
        </div>

        {codeTheme.mode === 'auto' ? (
          <div className="space-y-3 mt-2">
            {/* Dark preference */}
            <div>
              <p className="text-xs font-semibold text-on-surface-variant/70 mb-2">
                {s.codeTheme.darkPreference}
              </p>
              <div className="grid grid-cols-2 gap-3">
                {builtInDark.map((id) => renderThemeCard(id, { isDarkSlot: true }))}
                {[...suggestedInstalled, ...extraInstalled]
                  .filter(
                    (id) => id.includes('dark') || id.includes('night') || id.includes('monokai')
                  )
                  .map((id) => renderThemeCard(id, { isDarkSlot: true }))}
              </div>
            </div>
            {/* Light preference */}
            <div>
              <p className="text-xs font-semibold text-on-surface-variant/70 mb-2">
                {s.codeTheme.lightPreference}
              </p>
              <div className="grid grid-cols-2 gap-3">
                {builtInLight.map((id) => renderThemeCard(id, { isDarkSlot: false }))}
                {[...suggestedInstalled, ...extraInstalled]
                  .filter((id) => id.includes('light') || id.includes('dawn'))
                  .map((id) => renderThemeCard(id, { isDarkSlot: false }))}
              </div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 mt-2">
            {allAvailable.map((id) => renderThemeCard(id))}
          </div>
        )}

        {/* Suggested themes */}
        {suggestedNotInstalled.length > 0 && (
          <div className="mt-4">
            <p className="text-xs font-semibold text-on-surface-variant/70 mb-2">
              {s.codeTheme.suggestedThemes}
            </p>
            <div className="grid grid-cols-2 gap-3">
              {suggestedNotInstalled.map((id) => renderThemeCard(id))}
            </div>
          </div>
        )}

        {/* Extra installed themes */}
        {extraInstalled.length > 0 && (
          <div className="mt-4">
            <p className="text-xs font-semibold text-on-surface-variant/70 mb-2">
              {s.codeTheme.installedThemes}
            </p>
            <div className="grid grid-cols-2 gap-3">
              {extraInstalled.map((id) => renderThemeCard(id))}
            </div>
          </div>
        )}

        {/* Marketplace link */}
        <button
          type="button"
          onClick={() => void navigate({ to: '/marketplace' })}
          className="mt-3 flex items-center gap-2 text-sm font-semibold text-primary hover:text-primary/80 transition-colors cursor-pointer"
        >
          <ShoppingBag size={16} />
          {mp.addFromMarketplace}
        </button>
      </SettingsSection>

      {/* ── Font Size ── */}
      <SettingsSection title={s.fontSize.label} description={s.fontSize.description}>
        <div className="flex gap-2">
          {(['small', 'default', 'large'] as const).map((size) => (
            <OptionButton
              key={size}
              selected={config.fontSize === size}
              onClick={() => setFontSize(size)}
              label={s.fontSize[size]}
            />
          ))}
        </div>
        {/* Live preview */}
        <p
          className="mt-2 text-on-surface-variant/70 font-body leading-relaxed transition-all duration-200"
          style={{ fontSize: 'var(--chat-font-size)' }}
        >
          {t.settings.appearance.fontPreview}
        </p>
      </SettingsSection>

      {/* ── Chat Density ── */}
      <SettingsSection title={s.chatDensity.label} description={s.chatDensity.description}>
        <div className="flex gap-2">
          {(['compact', 'default', 'comfortable'] as const).map((density) => (
            <OptionButton
              key={density}
              selected={config.chatDensity === density}
              onClick={() => setDensity(density)}
              label={s.chatDensity[density]}
            />
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}
