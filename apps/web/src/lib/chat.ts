import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatRoom, SendMessageRequest, type ChatMessage } from 'amazon-ivs-chat-messaging';
import { CHAT_EVENTS, COMMENT_HISTORY_LIMIT, ChatTokenResponseSchema, RecentCommentsResponseSchema, type Comment } from '@delivery/shared';
import { apiFetch } from './api';
import { backoffMs } from './retry';

export type ChatEventName = typeof CHAT_EVENTS[number];
export type ChatConnection = 'connecting' | 'connected' | 'disconnected';

export const isChatEventName = (name: string): name is ChatEventName => (CHAT_EVENTS as readonly string[]).includes(name);

/**
 * 表示名は審査 Lambda が PROFILE の値で上書きしたメッセージ属性（失敗時は DENY）か、サーバーがトークンに入れた送信者属性だけを使う（Review-1 R1-04）。
 */
export function toComment(message: ChatMessage): Comment {
  return {
    messageId: message.id,
    userId: message.sender.userId,
    displayName: message.attributes?.displayName ?? message.sender.attributes?.displayName ?? '',
    comment: message.content,
    sentAt: message.sendTime.toISOString(),
    deleted: false,
  };
}

/** ID で重複を除き、送信日時順に並べ、直近 100 件に絞る。 */
export function mergeComments(current: readonly Comment[], incoming: readonly Comment[]): Comment[] {
  const byId = new Map<string, Comment>();
  for (const comment of [...current, ...incoming]) byId.set(comment.messageId, comment);
  return [...byId.values()]
    .filter((comment) => !comment.deleted)
    .sort((a, b) => a.sentAt.localeCompare(b.sentAt))
    .slice(-COMMENT_HISTORY_LIMIT);
}

/** 履歴 API の結果を正とし、それより新しい受信済みコメントだけを残す（切断中の削除を反映するため）。 */
export function replaceWithHistory(current: readonly Comment[], history: readonly Comment[]): Comment[] {
  const newest = history.reduce((max, comment) => (comment.sentAt > max ? comment.sentAt : max), '');
  return mergeComments(history, current.filter((comment) => comment.sentAt > newest));
}

export const removeComment = (current: readonly Comment[], messageId: string): Comment[] =>
  current.filter((comment) => comment.messageId !== messageId);

export function chatErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'errorCode' in error) {
    const { errorCode, errorMessage } = error as { errorCode: number; errorMessage?: string };
    if (errorCode === 429) return '連投はできません。しばらく待ってから送信してください';
    if (errorCode === 403) return 'コメントを送信する権限がありません';
    if (errorCode === 406) return 'NGワードを含むか、送信できない内容です';
    return errorMessage ? `送信できませんでした（${errorMessage}）` : '送信できませんでした';
  }
  return error instanceof Error ? error.message : '送信できませんでした';
}

export const fetchRecentComments = () => apiFetch('/comments/recent', { schema: RecentCommentsResponseSchema });

export type UseChatRoomOptions = {
  enabled: boolean;
  region: string | undefined;
  /** broadcast-started などのカスタムイベント受信時 */
  onEvent?: (name: ChatEventName) => void;
  /** 管理者による切断（コメント停止）時。プロフィール再取得に使う */
  onServerDisconnect?: () => void;
};

export type ChatRoomState = {
  comments: Comment[];
  connection: ChatConnection;
  capabilities: string[];
  send: (content: string) => Promise<void>;
  remove: (messageId: string) => void;
};

/** IVS Chat ルームへの接続、直近 100 件の取得、自動再接続を行う。 */
export function useChatRoom({ enabled, region, onEvent, onServerDisconnect }: UseChatRoomOptions): ChatRoomState {
  const [comments, setComments] = useState<Comment[]>([]);
  const [connection, setConnection] = useState<ChatConnection>('disconnected');
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const roomRef = useRef<ChatRoom | null>(null);
  const onEventRef = useRef(onEvent);
  const onServerDisconnectRef = useRef(onServerDisconnect);
  onEventRef.current = onEvent;
  onServerDisconnectRef.current = onServerDisconnect;

  useEffect(() => {
    if (!enabled || !region) return undefined;
    let disposed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = () => fetchRecentComments()
      .then((history) => { if (!disposed) setComments((current) => replaceWithHistory(current, history)); })
      .catch(() => undefined);
    const room = new ChatRoom({
      regionOrUrl: region,
      tokenProvider: async () => {
        const response = await apiFetch('/tokens/chat', { method: 'POST', body: {}, schema: ChatTokenResponseSchema });
        setCapabilities(response.capabilities);
        return { token: response.token };
      },
    });
    roomRef.current = room;
    const unsubscribers = [
      room.addListener('connecting', () => setConnection('connecting')),
      room.addListener('connect', () => { attempt = 0; setConnection('connected'); void reload(); }),
      room.addListener('disconnect', (reason) => {
        setConnection('disconnected');
        if (disposed || reason === 'clientDisconnect') return;
        if (reason === 'serverDisconnect') onServerDisconnectRef.current?.();
        timer = setTimeout(() => room.connect(), backoffMs(attempt));
        attempt += 1;
      }),
      room.addListener('message', (message) => setComments((current) => mergeComments(current, [toComment(message)]))),
      room.addListener('messageDelete', (event) => setComments((current) => removeComment(current, event.messageId))),
      room.addListener('event', (event) => { if (isChatEventName(event.eventName)) onEventRef.current?.(event.eventName); }),
    ];
    room.connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      room.disconnect();
      roomRef.current = null;
    };
  }, [enabled, region]);

  const send = useCallback(async (content: string) => {
    const room = roomRef.current;
    if (!room || room.state !== 'connected') throw new Error('コメントサーバーに接続していません');
    try {
      // 表示名はサーバーが付けるので、クライアントからは属性を送らない（R1-04）
      await room.sendMessage(new SendMessageRequest(content));
    } catch (error) {
      throw new Error(chatErrorMessage(error));
    }
  }, []);
  const remove = useCallback((messageId: string) => setComments((current) => removeComment(current, messageId)), []);

  return { comments, connection, capabilities, send, remove };
}
