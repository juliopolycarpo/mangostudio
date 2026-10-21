import type { ReactNode } from 'react';
import { SettingsSaveIndicator } from './SettingsSaveIndicator';

interface SettingsPageProps {
  /** The page's name — the one `text-title` heading on the screen. */
  readonly title: string;
  /** What the page is for, in `fg-muted`. Omit when the title says it all. */
  readonly description?: string;
  /** Page-level buttons (Add, Refresh) or a caption, right-aligned and centred on the title line. */
  readonly actions?: ReactNode;
  /** `SettingsSection`s, lists or states. They stack at `space-y-8`. */
  readonly children: ReactNode;
}

/**
 * The frame every settings page shares: a `text-title` heading, an optional
 * description, the auto-save indicator, then the page's sections. The layout
 * owns the nav and an off-screen `h1`; this owns what the page is called, so
 * no page draws its own title card or puts an icon tile beside it.
 *
 * // Usage:
 * <SettingsPage title={t.settings.tabs.git} description={s.description}>
 *   <SettingsSection title={s.title}>…</SettingsSection>
 * </SettingsPage>
 */
export function SettingsPage({ title, description, actions, children }: SettingsPageProps) {
  return (
    <div className="space-y-8">
      {/* On a touch screen the 44px action button overflows its 28px line by 8px
          each way, so when the actions wrap under the text the row gap pays for
          that overflow and the button keeps its own 8px from the description. */}
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 pointer-coarse:gap-y-4">
        <div className="min-w-0 flex-1 basis-64 space-y-1">
          <h2 className="text-title font-semibold text-fg">{title}</h2>
          {description ? <p className="text-sm text-fg-muted">{description}</p> : null}
        </div>
        {/* The title's own line height, centring what it holds: a 44px touch
            button or a 16px caption then overflows equally above and below, so
            its centre is the title's centre at every size. */}
        <div className="flex h-7 shrink-0 items-center gap-3">
          <SettingsSaveIndicator />
          {actions}
        </div>
      </header>
      {children}
    </div>
  );
}
