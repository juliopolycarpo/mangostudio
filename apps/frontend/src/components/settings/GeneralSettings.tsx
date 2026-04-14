import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import type { Locale } from '@mangostudio/shared/i18n';
import { MAX_TOOL_ITERATIONS_MAX, MAX_TOOL_ITERATIONS_MIN } from '@/hooks/use-global-settings';

interface GeneralSettingsProps {
  textSystemPrompt: string;
  setTextSystemPrompt: (val: string) => void;
  imageSystemPrompt: string;
  setImageSystemPrompt: (val: string) => void;
  imageQuality: string;
  setImageQuality: (val: string) => void;
  maxToolIterations: number;
  setMaxToolIterations: (val: number) => void;
}

const IMAGE_QUALITY_OPTIONS = ['512px', '1K', '2K', '4K'] as const;

const LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'pt-BR', label: 'Português (BR)' },
];

/**
 * General settings tab: language selector, system prompts, image quality grid.
 */
export function GeneralSettings({
  textSystemPrompt,
  setTextSystemPrompt,
  imageSystemPrompt,
  setImageSystemPrompt,
  imageQuality,
  setImageQuality,
  maxToolIterations,
  setMaxToolIterations,
}: GeneralSettingsProps) {
  const { t, locale, setLocale } = useI18n();
  const s = t.settings.general;

  const hintText = s.maxToolIterationsHint.replace('{value}', String(maxToolIterations));

  return (
    <div className="space-y-4">
      {/* ── Language ── */}
      <Card variant="solid" className="space-y-3 p-6">
        <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
          {s.languageLabel}
        </h3>
        <p className="text-sm text-on-surface-variant/60">{s.languageDescription}</p>
        <select
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
          id="language-select"
          className="
            w-full rounded-xl px-4 py-2.5 text-sm
            bg-surface-container-lowest text-on-surface
            border border-outline-variant/20
            focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20
            transition-colors cursor-pointer
          "
        >
          {LOCALE_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Card>

      {/* ── Default Text System Prompt ── */}
      <Card variant="solid" className="space-y-3 p-6">
        <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
          {s.textPromptLabel}
        </h3>
        <textarea
          value={textSystemPrompt}
          onChange={(e) => setTextSystemPrompt(e.target.value)}
          placeholder={s.textPromptPlaceholder}
          className="
            w-full bg-surface-container-lowest border border-outline-variant/20 rounded-xl p-4
            text-sm text-on-surface focus:ring-1 focus:ring-primary/40 focus:outline-none
            focus:border-primary/60 placeholder:text-on-surface-variant/40
            min-h-[120px] transition-all resize-none font-body
          "
        />
      </Card>

      {/* ── Default Image System Prompt ── */}
      <Card variant="solid" className="space-y-3 p-6">
        <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
          {s.imagePromptLabel}
        </h3>
        <textarea
          value={imageSystemPrompt}
          onChange={(e) => setImageSystemPrompt(e.target.value)}
          placeholder={s.imagePromptPlaceholder}
          className="
            w-full bg-surface-container-lowest border border-outline-variant/20 rounded-xl p-4
            text-sm text-on-surface focus:ring-1 focus:ring-primary/40 focus:outline-none
            focus:border-primary/60 placeholder:text-on-surface-variant/40
            min-h-[120px] transition-all resize-none font-body
          "
        />
      </Card>

      {/* ── Default Image Quality ── */}
      <Card variant="solid" className="space-y-3 p-6">
        <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
          {s.imageQualityLabel}
        </h3>
        <div className="grid grid-cols-4 gap-2">
          {IMAGE_QUALITY_OPTIONS.map((q) => (
            <Button
              key={q}
              variant={imageQuality === q ? 'primary' : 'secondary'}
              size="md"
              onClick={() => setImageQuality(q)}
            >
              {q}
            </Button>
          ))}
        </div>
      </Card>

      {/* ── Max Tool Iterations ── */}
      <Card variant="solid" className="space-y-3 p-6">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
            {s.maxToolIterationsLabel}
          </h3>
          <span className="text-sm font-medium text-on-surface">{hintText}</span>
        </div>
        <p className="text-sm text-on-surface-variant/60">{s.maxToolIterationsDescription}</p>
        <div className="flex items-center gap-4">
          <input
            type="range"
            min={MAX_TOOL_ITERATIONS_MIN}
            max={MAX_TOOL_ITERATIONS_MAX}
            step={1}
            value={maxToolIterations}
            onChange={(e) => setMaxToolIterations(Number(e.target.value))}
            aria-label={s.maxToolIterationsLabel}
            className="flex-1 h-2 bg-surface-container-lowest rounded-full appearance-none cursor-pointer accent-primary"
          />
          <input
            type="number"
            min={MAX_TOOL_ITERATIONS_MIN}
            max={MAX_TOOL_ITERATIONS_MAX}
            step={1}
            value={maxToolIterations}
            onChange={(e) => setMaxToolIterations(Number(e.target.value))}
            onBlur={(e) => setMaxToolIterations(Number(e.target.value))}
            aria-label={s.maxToolIterationsLabel}
            className="
              w-20 rounded-xl px-3 py-2 text-sm text-center
              bg-surface-container-lowest text-on-surface
              border border-outline-variant/20
              focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20
              transition-colors
            "
          />
        </div>
      </Card>
    </div>
  );
}
