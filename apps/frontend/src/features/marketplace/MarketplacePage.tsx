import { useState, useCallback, useMemo } from 'react';
import { Search, ShoppingBag } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { useTheme } from '@/hooks/use-theme';
import {
  SHIKI_THEME_CATALOG,
  type CodeThemeId,
  isThemeBuiltIn,
  isThemeAvailable,
  getInstalledThemeIds,
  loadThemeOnDemand,
  uninstallTheme,
} from '@/lib/shiki';
import { MarketplaceSidebar } from './MarketplaceSidebar';
import { MarketplaceThemeCard } from './MarketplaceThemeCard';

type ThemeFilter = 'all' | 'dark' | 'light';

/** Heuristic: themes with "light", "dawn", "latte" in name are light; rest are dark. */
function inferThemeType(id: string): 'dark' | 'light' {
  const lightKeywords = ['light', 'dawn', 'latte', 'bright', 'snazzy-light', 'ochin', 'lotus'];
  return lightKeywords.some((kw) => id.includes(kw)) ? 'light' : 'dark';
}

export function MarketplacePage() {
  const { t } = useI18n();
  const { config, setConfig } = useTheme();
  const mp = t.marketplace;

  const [, setInstalledIds] = useState<CodeThemeId[]>(() => getInstalledThemeIds());
  const [loadingTheme, setLoadingTheme] = useState<CodeThemeId | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<ThemeFilter>('all');

  const refreshInstalled = useCallback(() => {
    setInstalledIds(getInstalledThemeIds());
  }, []);

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

  const handleApply = useCallback(
    async (id: CodeThemeId) => {
      if (!isThemeAvailable(id)) {
        await handleInstall(id);
      }
      setConfig({ codeTheme: { ...config.codeTheme, darkTheme: id } });
    },
    [config.codeTheme, setConfig, handleInstall]
  );

  const filteredThemes = useMemo(() => {
    let themes = [...SHIKI_THEME_CATALOG];

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      themes = themes.filter((id) => id.toLowerCase().includes(q));
    }

    if (filter !== 'all') {
      themes = themes.filter((id) => inferThemeType(id) === filter);
    }

    return themes;
  }, [searchQuery, filter]);

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <MarketplaceSidebar filter={filter} onFilterChange={setFilter} />

      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-5xl mx-auto space-y-6">
          {/* Header */}
          <div className="flex items-center gap-4">
            <div className="p-3 bg-primary-container text-on-primary-container rounded-2xl">
              <ShoppingBag size={24} />
            </div>
            <h1 className="text-3xl font-bold font-headline text-on-background">{mp.title}</h1>
          </div>

          {/* Search */}
          <div className="relative">
            <Search
              size={16}
              className="absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant/50"
            />
            <input
              type="text"
              placeholder={mp.search}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-11 pr-4 py-3 rounded-xl bg-surface-container-high border border-outline-variant/20 text-on-surface text-sm focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-colors"
            />
          </div>

          {/* Theme grid */}
          {filteredThemes.length > 0 ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {filteredThemes.map((id) => (
                <MarketplaceThemeCard
                  key={id}
                  themeId={id}
                  themeType={inferThemeType(id)}
                  installed={isThemeAvailable(id)}
                  builtIn={isThemeBuiltIn(id)}
                  active={config.codeTheme.darkTheme === id}
                  loading={loadingTheme === id}
                  onInstall={() => void handleInstall(id)}
                  onUninstall={() => handleUninstall(id)}
                  onApply={() => void handleApply(id)}
                />
              ))}
            </div>
          ) : (
            <div className="text-center py-16 text-on-surface-variant/60 text-sm">
              {mp.noResults}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
