import { useCallback, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useChatRoom, type ChatEventName } from '@/lib/chat';
import { useAuth } from '@/features/auth/auth-context';
import { queryKeys } from '@/lib/query-keys';
import { ChatContext } from './chat-context';

const invalidations: Record<ChatEventName, readonly (readonly string[])[]> = {
  'broadcast-started': [queryKeys.broadcast],
  'broadcast-ended': [queryKeys.broadcast, queryKeys.archives],
  'slides-updated': [queryKeys.slides],
  'archives-updated': [queryKeys.archives],
};

/** ログイン中は 1 タブにつき 1 本の Chat 接続を張り、カスタムイベントで各画面のデータを再取得する。 */
export function ChatProvider({ children }: { children: ReactNode }) {
  const { status, config, refresh } = useAuth();
  const queryClient = useQueryClient();
  const onEvent = useCallback((name: ChatEventName) => {
    invalidations[name].forEach((queryKey) => { void queryClient.invalidateQueries({ queryKey }); });
  }, [queryClient]);
  const onServerDisconnect = useCallback(() => { void refresh(); }, [refresh]);
  const chat = useChatRoom({ enabled: status === 'signedIn', region: config?.region, onEvent, onServerDisconnect });
  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}
