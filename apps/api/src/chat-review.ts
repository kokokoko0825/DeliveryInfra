import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { CommentSchema, containsNgWord } from '@delivery/shared';
import { createClients } from './aws';
import { getChatReviewEnv, type ChatReviewEnv } from './env';
import type { Clients } from './aws';

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
    const profile = await clients.ddb.send(new GetCommand({ TableName: env.TABLE_NAME, Key: { PK: `USER#${event.Sender.UserId}`, SK: 'PROFILE' }, ConsistentRead: true }));
    const profileItem = profile.Item as { displayName?: string; commentSuspended?: boolean } | undefined;
    if (!profileItem?.displayName) return deny(content, '表示名を設定してください');
    if (profileItem.commentSuspended) return deny(content, 'コメントの送信が停止されています');
    const words: string[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const wordsPage = await clients.ddb.send(new ScanCommand({ TableName: env.TABLE_NAME, FilterExpression: 'begins_with(PK, :prefix)', ExpressionAttributeValues: { ':prefix': 'NGWORD#' }, ConsistentRead: true, ExclusiveStartKey }));
      words.push(...((wordsPage.Items as { word?: string }[] | undefined)?.flatMap((item) => item.word ? [item.word] : []) ?? []));
      ExclusiveStartKey = wordsPage.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    if (containsNgWord(content, words)) return deny(content, '使用できない単語が含まれています');

    const now = dependencies?.now?.() ?? Date.now();
    const nowSeconds = Math.floor(now / 1000);
    try {
      await clients.ddb.send(new PutCommand({
        TableName: env.TABLE_NAME,
        Item: { PK: `USER#${event.Sender.UserId}`, SK: 'CHAT_RATE', lastSentAt: now, ttl: nowSeconds + 60 },
        ConditionExpression: 'attribute_not_exists(PK) OR #lastSentAt <= :cutoff',
        ExpressionAttributeNames: { '#lastSentAt': 'lastSentAt' }, ExpressionAttributeValues: { ':cutoff': now - 3000 },
      }));
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return deny(content, 'コメントは3秒に1回まで送信できます');
      throw error;
    }
    await clients.ddb.send(new PutCommand({
      TableName: env.TABLE_NAME,
      Item: {
        PK: `COMMENT#${event.MessageId}`, SK: 'ITEM', messageId: event.MessageId,
        userId: event.Sender.UserId, displayName: profileItem.displayName, comment: content,
        sentAt: new Date(now).toISOString(), deleted: false, ttl: nowSeconds + 365 * 24 * 60 * 60,
      },
    }));
    return { Content: content, ReviewResult: 'ALLOW', ...(event.Attributes ? { Attributes: event.Attributes } : {}) };
  };
}

function deny(content: string, reason: string): ChatReviewResponse {
  return { Content: content || ' ', ReviewResult: 'DENY', Attributes: { Reason: reason.slice(0, 200) } };
}

export const chatReviewHandler = createChatReviewHandler();
export const handler = chatReviewHandler;
