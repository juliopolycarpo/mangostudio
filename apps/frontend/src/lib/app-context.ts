import { createContext, useContext } from 'react';
import type { useAppState } from '@/hooks/use-app-state';

export const AppContext = createContext<ReturnType<typeof useAppState> | null>(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppContext');
  return ctx;
}