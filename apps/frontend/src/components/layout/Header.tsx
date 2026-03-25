import { useState } from 'react';
import { Plus, Settings } from 'lucide-react';
import type { GeminiModelCatalogResponse, GeminiModelOption } from '@mangostudio/shared';
import { ModelSelector } from './ModelSelector';
import { authClient } from '@/lib/auth-client';
import { useNavigate } from '@tanstack/react-router';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';

export interface HeaderProps {
  activeModel: string;
  activeModels: GeminiModelOption[];
  isModelSelectorDisabled: boolean;
  composerMode: 'chat' | 'image';
  currentChatId: string | null;
  currentPage: 'chat' | 'gallery' | 'settings';
  onUpdateChatModel: (chatId: string, model: string) => void;
  onSetPageModel: (model: string) => void;
  onNewChat: () => void;
  onNavigateToSettings: () => void;
  geminiModelCatalog: GeminiModelCatalogResponse;
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
  geminiModelCatalog,
}: HeaderProps) {
  const { data: session } = authClient.useSession();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useI18n();
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    setLoggingOut(true);
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => void navigate({ to: '/login' }),
        onError: () => {
          setLoggingOut(false);
          toast(t.auth.logoutError, 'error');
        },
      },
    });
  };

  return (
    <header className="bg-surface-dim flex justify-between items-center px-6 py-4 w-full sticky top-0 z-40 border-b border-outline-variant/10">
      <div className="flex items-center gap-4">
        <ModelSelector
          activeModel={activeModel}
          activeModels={activeModels}
          isDisabled={isModelSelectorDisabled}
          onSelect={(modelId) =>
            currentChatId
              ? onUpdateChatModel(currentChatId, modelId)
              : onSetPageModel(modelId)
          }
          geminiModelCatalog={geminiModelCatalog}
        />
      </div>
      <div className="flex items-center gap-3">
        {currentPage === 'chat' && (
          <button
            onClick={onNewChat}
            className="flex items-center gap-2 px-4 py-2 rounded-full bg-surface-container-high hover:bg-surface-container-highest transition-colors text-sm font-medium text-on-surface active:scale-95 duration-200"
          >
            <Plus size={16} />
            <span className="hidden sm:inline">{t.chat.newChat}</span>
          </button>
        )}
        <button
          onClick={onNavigateToSettings}
          className={`p-2 rounded-full transition-all duration-200 active:scale-95 ${currentPage === 'settings' ? 'bg-primary/10 text-primary' : 'bg-surface-container-high text-on-surface hover:bg-surface-container-highest cursor-pointer'}`}
          title={t.settings.title}
        >
          <Settings size={18} />
        </button>

        {session?.user && (
          <div className="flex items-center gap-3 ml-2 pl-4 border-l border-outline-variant/20">
            <span className="text-sm font-medium text-on-surface">{session.user.name}</span>
            <button
              onClick={() => void handleLogout()}
              disabled={loggingOut}
              className="text-xs px-3 py-1.5 rounded-full bg-surface-container-high hover:bg-surface-container-highest transition-colors cursor-pointer text-on-surface disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {loggingOut && (
                <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
              )}
              {loggingOut ? t.auth.logoutLoading : t.auth.logoutButton}
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
