import type { ModelCatalogResponse, ModelOption, ProviderType } from '@mangostudio/shared';
import { Menu, Plus, Settings } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { authClient } from '@/lib/auth-client';
import { ModelSelector } from './ModelSelector';

export interface HeaderProps {
  activeModel: string;
  activeModels: ModelOption[];
  isModelSelectorDisabled: boolean;
  currentChatId: string | null;
  currentPage: 'chat' | 'gallery' | 'settings' | 'studio';
  onUpdateChatModel: (chatId: string, model: string) => void;
  onSetPageModel: (model: string) => void;
  onNewChat: () => void;
  onNavigateToSettings: () => void;
  modelCatalog: ModelCatalogResponse;
  lockedProvider?: ProviderType | null;
  onMobileMenuToggle?: () => void;
}

export function Header({
  activeModel,
  activeModels,
  isModelSelectorDisabled,
  currentChatId,
  currentPage,
  onUpdateChatModel,
  onSetPageModel,
  onNewChat,
  onNavigateToSettings,
  modelCatalog,
  lockedProvider,
  onMobileMenuToggle,
}: HeaderProps) {
  const { data: session } = authClient.useSession();
  const { toast } = useToast();
  const { t } = useI18n();
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    setLoggingOut(true);
    await authClient.signOut({
      fetchOptions: {
        // Full page replace avoids stale-session race: SPA navigate fires before
        // Better Auth clears its session atom, causing login.tsx to redirect back.
        onSuccess: () => window.location.replace('/login'),
        onError: () => {
          setLoggingOut(false);
          toast(t.auth.logoutError, 'error');
        },
      },
    });
  };

  return (
    <header className="bg-surface-dim flex justify-between items-center px-3 sm:px-4 md:px-6 py-3 md:py-4 w-full sticky top-0 z-40 border-b border-outline-variant/10">
      <div className="flex items-center gap-2 sm:gap-3 md:gap-4 min-w-0 flex-1">
        <button
          onClick={onMobileMenuToggle}
          className="md:hidden p-2 rounded-lg hover:bg-surface-container-high transition-colors text-on-surface shrink-0"
          aria-label="Open menu"
        >
          <Menu size={20} />
        </button>
        {currentPage !== 'studio' && (
          <div className="min-w-0 flex-1 max-w-[60vw] sm:max-w-none">
            <ModelSelector
              activeModel={activeModel}
              activeModels={activeModels}
              isDisabled={isModelSelectorDisabled}
              onSelect={(modelId) =>
                currentChatId ? onUpdateChatModel(currentChatId, modelId) : onSetPageModel(modelId)
              }
              modelCatalog={modelCatalog}
              lockedProvider={lockedProvider}
            />
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 sm:gap-3 shrink-0 ml-2">
        {currentPage === 'chat' && (
          <button
            onClick={onNewChat}
            className="flex items-center gap-2 px-3 sm:px-4 py-2 rounded-full bg-surface-container-high hover:bg-surface-container-highest transition-colors text-sm font-medium text-on-surface active:scale-95 duration-200 shrink-0"
          >
            <Plus size={16} />
            <span className="hidden sm:inline">{t.chat.newChat}</span>
          </button>
        )}
        <button
          onClick={onNavigateToSettings}
          className={`p-2 rounded-full transition-all duration-200 active:scale-95 shrink-0 ${currentPage === 'settings' ? 'bg-primary/10 text-primary' : 'bg-surface-container-high text-on-surface hover:bg-surface-container-highest cursor-pointer'}`}
          title={t.settings.title}
        >
          <Settings size={18} />
        </button>

        {session?.user && (
          <div className="flex items-center gap-2 sm:gap-3 ml-1 sm:ml-2 pl-2 sm:pl-4 border-l border-outline-variant/20 shrink-0">
            <span className="text-sm font-medium text-on-surface hidden md:inline max-w-[120px] truncate">
              {session.user.name}
            </span>
            <button
              onClick={() => void handleLogout()}
              disabled={loggingOut}
              data-testid="logout-button"
              className="text-xs px-2 sm:px-3 py-1.5 rounded-full bg-surface-container-high hover:bg-surface-container-highest transition-colors cursor-pointer text-on-surface disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 shrink-0"
            >
              {loggingOut && (
                <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
              )}
              <span className="hidden sm:inline">
                {loggingOut ? t.auth.logoutLoading : t.auth.logoutButton}
              </span>
              <span className="sm:hidden">
                {loggingOut ? t.auth.logoutLoading : t.auth.logoutButton.slice(0, 4)}
              </span>
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
