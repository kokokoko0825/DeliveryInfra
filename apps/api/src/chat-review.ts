import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { CHAT_DENY_REASONS, CommentSchema, containsNgWord } from '@delivery/shared';
import { createClients } from './aws';
import { getChatReviewEnv, type ChatReviewEnv } from './env';
import type { Clients } from './aws';
import { KEYS, makeDatabase } from './database';

export interface ChatReviewEvent {
  MessageId: string;
  Content: string;
  Attributes?: Record<string, string>;
  RoomArn: string;
  Sender: { UserId: string; Ip?: string; Attributes?: Record<string, string> };
}
export interface ChatReviewResponse { Content: string; ReviewResult: 'ALLOW' | 'DENY'; Attributes?: Record<string, string> }

export function createChatReviewHandler(dependencies?: { env?: ChatReviewEnv; clients?: Clients; now?: () => number }) {
  return async (event: ChatReviewEvent): Promise<ChatReviewResponse> => {
    let content: string;
    try { content = CommentSchema.parse(event.Content); }
    catch (error) { return deny(event.Content ?? '', error instanceof Error ? error.message : 'コメントは1〜200文字で入力してください'); }
    const env = dependencies?.env ?? getChatReviewEnv();
    const clients = dependencies?.clients ?? createClients(env);
    const profile = await clients.ddb.send(new GetCommand({ TableName: env.TABLE_NAME, Key: { PK: KEYS.user(event.Sender.UserId), SK: 'PROFILE' }, ConsistentRead: true }));
    const profileItem = profile.Item as { displayName?: string; commentSuspended?: boolean } | undefined;
    if (!profileItem?.displayName) return deny(content, CHAT_DENY_REASONS.displayNameMissing);
    if (profileItem.commentSuspended) return deny(content, CHAT_DENY_REASONS.suspended);
    // NG ワードは固定 PK の Query で読む（R1-10）。追加直後から効くよう強整合読み込み
    const words = (await makeDatabase(clients.ddb, env).query<{ PK: string; SK: string; word?: string }>(KEYS.ngWordPk, { consistentRead: true })).flatMap((item) => item.word ? [item.word] : []);
    if (containsNgWord(content, words)) return deny(content, CHAT_DENY_REASONS.ngWord);

    const now = dependencies?.now?.() ?? Date.now();
    const nowSeconds = Math.floor(now / 1000);
    try {
      await clients.ddb.send(new PutCommand({
        TableName: env.TABLE_NAME,
        Item: { PK: KEYS.user(event.Sender.UserId), SK: 'CHAT_RATE', lastSentAt: now, ttl: nowSeconds + 60 },
        ConditionExpression: 'attribute_not_exists(PK) OR #lastSentAt <= :cutoff',
        ExpressionAttributeNames: { '#lastSentAt': 'lastSentAt' }, ExpressionAttributeValues: { ':cutoff': now - 3000 },
      }));
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return deny(content, CHAT_DENY_REASONS.rateLimited);
      throw error;
    }
    const sentAt = new Date(now).toISOString();
    const ttl = nowSeconds + 365 * 24 * 60 * 60;
    const commentSk = KEYS.commentSk(sentAt, event.MessageId);
    // 本体（時刻順 Query 用）と messageId → SK の参照行を同時に書く（R1-10、GSI なし）
    await clients.ddb.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: env.TABLE_NAME, Item: {
        PK: KEYS.commentPk, SK: commentSk, messageId: event.MessageId,
        userId: event.Sender.UserId, displayName: profileItem.displayName, comment: content,
        sentAt, deleted: false, ttl,
      } } },
      { Put: { TableName: env.TABLE_NAME, Item: { PK: KEYS.commentRef(event.MessageId), SK: 'REF', commentSk, ttl } } },
    ] }));
    // クライアント指定の属性は捨て、保存済みの表示名で上書きする（R1-04 なりすまし対策）
    return { Content: content, ReviewResult: 'ALLOW', Attributes: { displayName: profileItem.displayName } };
  };
}

function deny(content: string, reason: string): ChatReviewResponse {
  return { Content: content || ' ', ReviewResult: 'DENY', Attributes: { Reason: reason.slice(0, 200) } };
}

export const chatReviewHandler = createChatReviewHandler();
export const handler = chatReviewHandler;
