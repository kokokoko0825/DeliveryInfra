import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
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
  ddb.on(ScanCommand).resolves({ Items: [] });
  ddb.on(PutCommand).resolves({});
});

const event = (Content: string) => ({ MessageId: 'message-1', Content, RoomArn: 'room', Sender: { UserId: 'user-1' } });

describe('chat review policy', () => {
  it('allows 1 and 200 character comments and stores them for one year', async () => {
    for (const Content of ['x', 'x'.repeat(200)]) {
      const response = await chatReviewHandler(event(Content));
      expect(response.ReviewResult).toBe('ALLOW');
      expect(response.Content).toBe(Content);
    }
    const commentPut = ddb.commandCalls(PutCommand).at(-1)?.args[0].input;
    expect(commentPut?.Item).toMatchObject({ comment: 'x'.repeat(200), displayName: 'テストユーザー', ttl: expect.any(Number) });
  });
  it('denies empty and over-limit comments', async () => {
    await expect(chatReviewHandler(event(''))).resolves.toMatchObject({ ReviewResult: 'DENY' });
    await expect(chatReviewHandler(event('x'.repeat(201)))).resolves.toMatchObject({ ReviewResult: 'DENY' });
  });
  it('denies NFKC-normalized forbidden words and suspended users', async () => {
    ddb.on(ScanCommand).resolves({ Items: [{ word: 'blocked' }] });
    await expect(chatReviewHandler(event('ＢＬＯＣＫＥＤ'))).resolves.toMatchObject({ ReviewResult: 'DENY' });
    ddb.on(GetCommand).resolves({ Item: { displayName: 'テストユーザー', commentSuspended: true } });
    await expect(chatReviewHandler(event('hello'))).resolves.toMatchObject({ ReviewResult: 'DENY' });
  });
  it('denies a second message within three seconds atomically', async () => {
    ddb.on(PutCommand).rejectsOnce(Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' }));
    await expect(chatReviewHandler(event('hello'))).resolves.toMatchObject({ ReviewResult: 'DENY' });
  });
});
