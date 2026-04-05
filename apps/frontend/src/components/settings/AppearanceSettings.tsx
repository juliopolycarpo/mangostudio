import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';
import { useTheme } from '@/hooks/use-theme';
import type { ThemeConfig } from '@/hooks/use-theme';

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

const PREVIEW_SENTENCE_KEY = 'The quick brown fox jumps over the lazy dog.';

/**
 * Appearance settings tab: app theme, font size, chat density.
 */
export function AppearanceSettings() {
  const { t } = useI18n();
  const { config, setConfig } = useTheme();
  const s = t.settings.appearance;

  const setFontSize = (fontSize: FontSize) => setConfig({ fontSize });
  const setDensity = (chatDensity: ChatDensity) => setConfig({ chatDensity });

  return (
    <div className="space-y-4">
      {/* ── App Theme ── */}
      <Card variant="solid" className="space-y-3 p-6">
        <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
          {s.appTheme.label}
        </h3>
        <p className="text-sm text-on-surface-variant/60">{s.appTheme.description}</p>
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
      </Card>

      {/* ── Font Size ── */}
      <Card variant="solid" className="space-y-3 p-6">
        <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
          {s.fontSize.label}
        </h3>
        <p className="text-sm text-on-surface-variant/60">{s.fontSize.description}</p>
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
      </Card>

      {/* ── Chat Density ── */}
      <Card variant="solid" className="space-y-3 p-6">
        <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
          {s.chatDensity.label}
        </h3>
        <p className="text-sm text-on-surface-variant/60">{s.chatDensity.description}</p>
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
      </Card>
    </div>
  );
}
