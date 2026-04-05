import { useI18n } from '@/hooks/use-i18n';

type ThemeFilter = 'all' | 'dark' | 'light';

interface MarketplaceSidebarProps {
  filter: ThemeFilter;
  onFilterChange: (filter: ThemeFilter) => void;
}

export function MarketplaceSidebar({ filter, onFilterChange }: MarketplaceSidebarProps) {
  const { t } = useI18n();
  const mp = t.marketplace;

  const filters: { value: ThemeFilter; label: string }[] = [
    { value: 'all', label: mp.filterAll },
    { value: 'dark', label: mp.filterDark },
    { value: 'light', label: mp.filterLight },
  ];

  return (
    <aside className="hidden lg:flex flex-col w-56 border-r border-outline-variant/10 p-6 space-y-6 overflow-y-auto">
      {/* Category */}
      <div>
        <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label mb-3">
          {mp.codeThemes}
        </h3>
        <div className="space-y-1">
          {filters.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => onFilterChange(value)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                filter === value
                  ? 'bg-primary/10 text-primary'
                  : 'text-on-surface-variant/70 hover:bg-surface-container-high hover:text-on-surface cursor-pointer'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Provider - just Shiki for now */}
      <div>
        <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label mb-3">
          {mp.provider}
        </h3>
        <div className="px-3 py-2 text-sm text-on-surface-variant/70">Shiki</div>
      </div>

      {/* Coming Soon */}
      <div>
        <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/50 font-label mb-3">
          {mp.comingSoon}
        </h3>
        <div className="space-y-1 text-sm text-on-surface-variant/40">
          <div className="px-3 py-2">{mp.skills}</div>
          <div className="px-3 py-2">{mp.tools}</div>
          <div className="px-3 py-2">{mp.mcps}</div>
        </div>
      </div>
    </aside>
  );
}
