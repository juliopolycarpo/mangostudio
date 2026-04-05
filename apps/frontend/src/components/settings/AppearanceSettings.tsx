import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';
import { useTheme } from '@/hooks/use-theme';
import type { ThemeConfig, CodeThemeConfig } from '@/hooks/use-theme';
import { CODE_THEMES, type CodeThemeId } from '@/lib/shiki';

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

/** Pre-rendered code snippet previews for each Shiki theme (static HTML). */
const THEME_PREVIEWS: Record<CodeThemeId, { bg: string; html: string }> = {
  'one-dark-pro': {
    bg: '#282c34',
    html: '<code><span style="color:#c678dd">const</span> <span style="color:#e5c07b">greeting</span> <span style="color:#56b6c2">=</span> <span style="color:#98c379">"hello"</span><span style="color:#abb2bf">;</span>\n<span style="color:#c678dd">function</span> <span style="color:#61afef">greet</span><span style="color:#abb2bf">(</span><span style="color:#e06c75">name</span><span style="color:#abb2bf">)</span> <span style="color:#abb2bf">{</span>\n  <span style="color:#c678dd">return</span> <span style="color:#98c379">`${greeting}, ${name}`</span><span style="color:#abb2bf">;</span>\n<span style="color:#abb2bf">}</span></code>',
  },
  'github-dark-dimmed': {
    bg: '#22272e',
    html: '<code><span style="color:#f47067">const</span> <span style="color:#f69d50">greeting</span> <span style="color:#adbac7">=</span> <span style="color:#96d0ff">"hello"</span><span style="color:#adbac7">;</span>\n<span style="color:#f47067">function</span> <span style="color:#dcbdfb">greet</span><span style="color:#adbac7">(</span><span style="color:#f69d50">name</span><span style="color:#adbac7">)</span> <span style="color:#adbac7">{</span>\n  <span style="color:#f47067">return</span> <span style="color:#96d0ff">`${greeting}, ${name}`</span><span style="color:#adbac7">;</span>\n<span style="color:#adbac7">}</span></code>',
  },
  'github-light': {
    bg: '#ffffff',
    html: '<code><span style="color:#cf222e">const</span> <span style="color:#953800">greeting</span> <span style="color:#24292f">=</span> <span style="color:#0a3069">"hello"</span><span style="color:#24292f">;</span>\n<span style="color:#cf222e">function</span> <span style="color:#8250df">greet</span><span style="color:#24292f">(</span><span style="color:#953800">name</span><span style="color:#24292f">)</span> <span style="color:#24292f">{</span>\n  <span style="color:#cf222e">return</span> <span style="color:#0a3069">`${greeting}, ${name}`</span><span style="color:#24292f">;</span>\n<span style="color:#24292f">}</span></code>',
  },
  'one-light': {
    bg: '#fafafa',
    html: '<code><span style="color:#a626a4">const</span> <span style="color:#c18401">greeting</span> <span style="color:#0184bc">=</span> <span style="color:#50a14f">"hello"</span><span style="color:#383a42">;</span>\n<span style="color:#a626a4">function</span> <span style="color:#4078f2">greet</span><span style="color:#383a42">(</span><span style="color:#e45649">name</span><span style="color:#383a42">)</span> <span style="color:#383a42">{</span>\n  <span style="color:#a626a4">return</span> <span style="color:#50a14f">`${greeting}, ${name}`</span><span style="color:#383a42">;</span>\n<span style="color:#383a42">}</span></code>',
  },
};

const THEME_I18N_KEYS = {
  'one-dark-pro': 'oneDarkPro',
  'github-dark-dimmed': 'githubDarkDimmed',
  'github-light': 'githubLight',
  'one-light': 'oneLight',
} as const satisfies Record<CodeThemeId, string>;

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
  const preview = THEME_PREVIEWS[themeId];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`
        rounded-xl border-2 transition-all duration-200 overflow-hidden text-left
        focus:outline-none focus:ring-2 focus:ring-primary/40
        ${selected ? 'border-primary ring-1 ring-primary/30' : 'border-outline-variant/20 hover:border-outline-variant/50 cursor-pointer'}
      `}
    >
      <pre
        className="p-3 text-[11px] leading-normal font-mono overflow-hidden"
        style={{ background: preview.bg }}
        dangerouslySetInnerHTML={{ __html: preview.html }}
      />
      <div className="px-3 py-2 text-xs font-semibold text-on-surface-variant bg-surface-container-high">
        {label}
      </div>
    </button>
  );
}

const PREVIEW_SENTENCE_KEY = 'The quick brown fox jumps over the lazy dog.';

/**
 * Appearance settings tab: app theme, code theme, font size, chat density.
 */
export function AppearanceSettings() {
  const { t } = useI18n();
  const { config, setConfig } = useTheme();
  const s = t.settings.appearance;

  const setFontSize = (fontSize: FontSize) => setConfig({ fontSize });
  const setDensity = (chatDensity: ChatDensity) => setConfig({ chatDensity });

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
            <div>
              <p className="text-xs font-semibold text-on-surface-variant/70 mb-2">
                {s.codeTheme.darkPreference}
              </p>
              <div className="grid grid-cols-2 gap-3">
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
            <div>
              <p className="text-xs font-semibold text-on-surface-variant/70 mb-2">
                {s.codeTheme.lightPreference}
              </p>
              <div className="grid grid-cols-2 gap-3">
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
          <div className="grid grid-cols-2 gap-3 mt-2">
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
          {PREVIEW_SENTENCE_KEY}
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
