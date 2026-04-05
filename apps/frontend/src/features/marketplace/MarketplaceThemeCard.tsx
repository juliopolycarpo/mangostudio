import { useState, useEffect } from 'react';
import { Download, Trash2, Check, Play } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { getThemePreview, getCachedPreview } from '@/services/theme-preview-service';
import type { CodeThemeId } from '@/lib/shiki';

/** Prettify a Shiki theme ID into a human-readable display name. */
function formatThemeName(id: string): string {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

interface MarketplaceThemeCardProps {
  themeId: CodeThemeId;
  themeType: 'dark' | 'light';
  installed: boolean;
  builtIn: boolean;
  active: boolean;
  loading: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onApply: () => void;
}

export function MarketplaceThemeCard({
  themeId,
  themeType,
  installed,
  builtIn,
  active,
  loading,
  onInstall,
  onUninstall,
  onApply,
}: MarketplaceThemeCardProps) {
  const { t } = useI18n();
  const mp = t.marketplace;
  const [previewHtml, setPreviewHtml] = useState<string | null>(() => getCachedPreview(themeId));

  useEffect(() => {
    if (!previewHtml) {
      void getThemePreview(themeId).then((html) => {
        if (html) setPreviewHtml(html);
      });
    }
  }, [themeId, previewHtml]);

  const label = formatThemeName(themeId);

  return (
    <div
      className={`
        group relative rounded-xl border-2 transition-all duration-200 overflow-hidden
        ${active ? 'border-primary ring-1 ring-primary/30' : 'border-outline-variant/20 hover:border-outline-variant/50'}
      `}
    >
      {/* Preview */}
      {previewHtml ? (
        <div
          className="p-3 text-[10px] leading-normal font-mono overflow-hidden h-24 [&_pre]:!m-0 [&_pre]:!p-0 [&_pre]:!bg-transparent [&_pre]:overflow-hidden"
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      ) : (
        <div className="p-3 h-24 bg-surface-container-lowest animate-pulse" />
      )}

      {/* Label bar */}
      <div className="px-3 py-2 bg-surface-container-high flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-on-surface-variant truncate">{label}</span>
          <span
            className={`shrink-0 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${
              themeType === 'dark'
                ? 'bg-surface-container-highest text-on-surface-variant/60'
                : 'bg-primary-container/50 text-on-primary-container/70'
            }`}
          >
            {themeType === 'dark' ? mp.dark : mp.light}
          </span>
        </div>
        {builtIn && (
          <span className="text-[9px] font-bold uppercase tracking-wide text-primary/70">
            {mp.builtIn}
          </span>
        )}
        {installed && !builtIn && <Check size={12} className="text-primary shrink-0" />}
      </div>

      {/* Hover overlay — pointer-events-none keeps card clickable; auto on hover */}
      {!builtIn && (
        <div className="absolute inset-0 bg-background/60 backdrop-blur-sm pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center gap-2">
          {!installed ? (
            <>
              <button
                type="button"
                onClick={onInstall}
                disabled={loading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-bold transition-all active:scale-95 disabled:opacity-50"
              >
                {loading ? (
                  <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
                ) : (
                  <Download size={12} />
                )}
                {mp.install}
              </button>
              <button
                type="button"
                onClick={onApply}
                disabled={loading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-container-highest text-on-surface text-xs font-bold transition-all active:scale-95 disabled:opacity-50"
              >
                <Play size={12} />
                {mp.apply}
              </button>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onApply}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-bold transition-all active:scale-95"
              >
                <Play size={12} />
                {mp.apply}
              </button>
              <button
                type="button"
                onClick={onUninstall}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-error/10 text-error text-xs font-bold transition-all active:scale-95"
              >
                <Trash2 size={12} />
                {mp.uninstall}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
