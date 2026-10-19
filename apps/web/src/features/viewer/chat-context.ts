import { createContext, useContext } from 'react';
import type { ChatRoomState } from '@/lib/chat';

export const ChatContext = createContext<ChatRoomState | null>(null);

export function useChat(): ChatRoomState {
  const value = useContext(ChatContext);
  if (!value) throw new Error('ChatProvider の内側で使用してください');
  return value;
}
