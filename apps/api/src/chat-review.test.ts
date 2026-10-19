import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createClients } from './aws';
import { ChatReviewEnvSchema } from './env';
import { createChatReviewHandler } from './chat-review';

const env = ChatReviewEnvSchema.parse({TABLE_NAME: 'table'});
const clients = createClients(env);
const ddb = mockClient(clients.ddb);
const chatReviewHandler = createChatReviewHandler({ env, clients, now: () => 1_700_000_000_000 });

beforeEach(() => {
  ddb.reset();
  ddb.on(GetCommand).resolves({ Item: { displayName: 'テストユーザー', commentSuspended: false } });
  ddb.on(QueryCommand).resolves({ Items: [] });
  ddb.on(PutCommand).resolves({});
  ddb.on(TransactWriteCommand).resolves({});
});

const event = (Content: string) => ({ MessageId: 'message-1', Content, RoomArn: 'room', Sender: { UserId: 'user-1' } });

describe('chat review policy', () => {
  it('allows 1 and 200 character comments and stores them for one year', async () => {
    for (const Content of ['x', 'x'.repeat(200)]) {
      const response = await chatReviewHandler(event(Content));
      expect(response.ReviewResult).toBe('ALLOW');
      expect(response.Content).toBe(Content);
    }
    const ttl = 1_700_000_000 + 365 * 24 * 60 * 60;
    expect(ddb.commandCalls(TransactWriteCommand).at(-1)?.args[0].input.TransactItems?.map((item) => item.Put?.Item)).toEqual([
      { PK: 'COMMENT', SK: '2023-11-14T22:13:20.000Z#message-1', messageId: 'message-1', userId: 'user-1', displayName: 'テストユーザー', comment: 'x'.repeat(200), sentAt: '2023-11-14T22:13:20.000Z', deleted: false, ttl },
      { PK: 'COMMENT#message-1', SK: 'REF', commentSk: '2023-11-14T22:13:20.000Z#message-1', ttl },
    ]);
    expect(ddb.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({ KeyConditionExpression: '#pk = :pk', ExpressionAttributeValues: { ':pk': 'NGWORD' }, ConsistentRead: true });
    expect(ddb.commandCalls(ScanCommand)).toHaveLength(0);
  });
  it('denies empty and over-limit comments', async () => {
    await expect(chatReviewHandler(event(''))).resolves.toMatchObject({ ReviewResult: 'DENY' });
    await expect(chatReviewHandler(event('x'.repeat(201)))).resolves.toMatchObject({ ReviewResult: 'DENY' });
  });
  it('denies NFKC-normalized forbidden words and suspended users', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ PK: 'NGWORD', SK: 'blocked', word: 'blocked' }] });
    await expect(chatReviewHandler(event('ＢＬＯＣＫＥＤ'))).resolves.toMatchObject({ ReviewResult: 'DENY' });
    ddb.on(GetCommand).resolves({ Item: { displayName: 'テストユーザー', commentSuspended: true } });
    await expect(chatReviewHandler(event('hello'))).resolves.toMatchObject({ ReviewResult: 'DENY' });
  });
  it('denies a second message within three seconds atomically', async () => {
    ddb.on(PutCommand).rejectsOnce(Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' }));
    await expect(chatReviewHandler(event('hello'))).resolves.toMatchObject({ ReviewResult: 'DENY' });
  });
  it('overwrites client supplied attributes with the stored display name (R1-04)', async () => {
    const response = await chatReviewHandler({ ...event('hello'), Attributes: { displayName: '運営事務局', extra: 'x' } });
    expect(response).toEqual({ Content: 'hello', ReviewResult: 'ALLOW', Attributes: { displayName: 'テストユーザー' } });
  });
  it('returns the trimmed content it stored', async () => {
    await expect(chatReviewHandler(event('  hi  '))).resolves.toMatchObject({ ReviewResult: 'ALLOW', Content: 'hi' });
    expect(ddb.commandCalls(TransactWriteCommand).at(-1)?.args[0].input.TransactItems?.[0]?.Put?.Item?.comment).toBe('hi');
  });
});
