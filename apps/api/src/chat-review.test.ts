import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { createClients } from './aws';
import { ChatReviewEnvSchema } from './env';
import { createChatReviewHandler } from './chat-review';

const env = ChatReviewEnvSchema.parse({ TABLE_NAME: 'table' });
const clients = createClients(env);
const ddb = mockClient(clients.ddb);
const chatReviewHandler = createChatReviewHandler({
  env,
  clients,
  now: () => 1_700_000_000_000,
});

beforeEach(() => {
  ddb.reset();
  ddb.on(GetCommand).resolves({
    Item: { displayName: 'テストユーザー', commentSuspended: false },
  });
  ddb.on(QueryCommand).resolves({ Items: [] });
  ddb.on(TransactWriteCommand).resolves({});
});

const event = (Content: string) => ({
  MessageId: 'message-1',
  Content,
  RoomArn: 'room',
  Sender: { UserId: 'user-1' },
});

describe('chat review policy', () => {
  it('allows 1 and 200 character comments and stores them for one year', async () => {
    for (const Content of ['x', 'x'.repeat(200)]) {
      const response = await chatReviewHandler(event(Content));
      expect(response.ReviewResult).toBe('ALLOW');
      expect(response.Content).toBe(Content);
    }
    const ttl = 1_700_000_000 + 365 * 24 * 60 * 60;
    expect(ddb.commandCalls(GetCommand)[0]?.args[0].input).toEqual({
      TableName: 'table',
      Key: { PK: 'USER#user-1', SK: 'PROFILE' },
      ConsistentRead: true,
    });
    expect(
      ddb
        .commandCalls(TransactWriteCommand)
        .at(-1)
        ?.args[0].input.TransactItems?.map((item) => item.Put?.Item),
    ).toEqual([
      {
        PK: 'USER#user-1',
        SK: 'CHAT_RATE',
        lastSentAt: 1_700_000_000_000,
        ttl: 1_700_000_060,
      },
      {
        PK: 'COMMENT',
        SK: '2023-11-14T22:13:20.000Z#message-1',
        messageId: 'message-1',
        userId: 'user-1',
        displayName: 'テストユーザー',
        comment: 'x'.repeat(200),
        sentAt: '2023-11-14T22:13:20.000Z',
        deleted: false,
        ttl,
      },
      {
        PK: 'COMMENT#message-1',
        SK: 'REF',
        commentSk: '2023-11-14T22:13:20.000Z#message-1',
        ttl,
      },
    ]);
    expect(
      ddb.commandCalls(TransactWriteCommand).at(-1)?.args[0].input
        .TransactItems?.[0],
    ).toMatchObject({
      Put: {
        ConditionExpression:
          'attribute_not_exists(PK) OR #lastSentAt <= :cutoff',
        ExpressionAttributeNames: { '#lastSentAt': 'lastSentAt' },
        ExpressionAttributeValues: { ':cutoff': 1_699_999_997_000 },
      },
    });
    expect(ddb.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeValues: { ':pk': 'NGWORD' },
      ConsistentRead: true,
    });
    expect(ddb.commandCalls(ScanCommand)).toHaveLength(0);
  });
  it('denies empty and over-limit comments', async () => {
    const empty = await chatReviewHandler(event(''));
    expect(empty).toMatchObject({ Content: ' ', ReviewResult: 'DENY' });
    expect(empty.Attributes?.Reason?.length).toBeGreaterThan(0);
    expect(empty.Attributes?.Reason?.length).toBeLessThanOrEqual(200);
    const tooLong = await chatReviewHandler(event('x'.repeat(201)));
    expect(tooLong).toMatchObject({
      Content: 'x'.repeat(201),
      ReviewResult: 'DENY',
    });
    expect(tooLong.Attributes?.Reason?.length).toBeGreaterThan(0);
    expect(tooLong.Attributes?.Reason?.length).toBeLessThanOrEqual(200);
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
  it('denies NFKC-normalized forbidden words and suspended users', async () => {
    ddb
      .on(QueryCommand)
      .resolves({ Items: [{ PK: 'NGWORD', SK: 'blocked', word: 'blocked' }] });
    await expect(chatReviewHandler(event('ＢＬＯＣＫＥＤ'))).resolves.toEqual({
      Content: 'ＢＬＯＣＫＥＤ',
      ReviewResult: 'DENY',
      Attributes: { Reason: '使用できない単語が含まれています' },
    });
    ddb.on(GetCommand).resolves({
      Item: { displayName: 'テストユーザー', commentSuspended: true },
    });
    await expect(chatReviewHandler(event('hello'))).resolves.toEqual({
      Content: 'hello',
      ReviewResult: 'DENY',
      Attributes: { Reason: 'コメントの送信が停止されています' },
    });
  });
  it('denies a second message within three seconds atomically', async () => {
    ddb.on(TransactWriteCommand).rejectsOnce(
      Object.assign(new Error('conditional'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      }),
    );
    await expect(chatReviewHandler(event('hello'))).resolves.toEqual({
      Content: 'hello',
      ReviewResult: 'DENY',
      Attributes: { Reason: 'コメントは3秒に1回まで送信できます' },
    });
  });
  it('overwrites client supplied attributes with the stored display name (R1-04)', async () => {
    const response = await chatReviewHandler({
      ...event('hello'),
      Attributes: { displayName: '運営事務局', extra: 'x' },
    });
    expect(response).toEqual({
      Content: 'hello',
      ReviewResult: 'ALLOW',
      Attributes: { displayName: 'テストユーザー' },
    });
  });
  it('returns the trimmed content it stored', async () => {
    await expect(chatReviewHandler(event('  hi  '))).resolves.toMatchObject({
      ReviewResult: 'ALLOW',
      Content: 'hi',
    });
    expect(
      ddb.commandCalls(TransactWriteCommand).at(-1)?.args[0].input
        .TransactItems?.[1]?.Put?.Item?.comment,
    ).toBe('hi');
  });

  it('denies profiles without a display name and does not write a rate limit or comment', async () => {
    ddb.on(GetCommand).resolves({ Item: { commentSuspended: false } });
    await expect(chatReviewHandler(event('hello'))).resolves.toEqual({
      Content: 'hello',
      ReviewResult: 'DENY',
      Attributes: { Reason: '表示名を設定してください' },
    });
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(1);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('uses the exact three-second cutoff and propagates non-rate transaction errors', async () => {
    await chatReviewHandler(event('hello'));
    const failingClients = createClients(env);
    const failingDdb = mockClient(failingClients.ddb);
    failingDdb
      .on(GetCommand)
      .resolves({ Item: { displayName: 'テストユーザー' } });
    failingDdb.on(QueryCommand).resolves({ Items: [] });
    failingDdb.on(TransactWriteCommand).rejects(
      Object.assign(new Error('ddb unavailable'), {
        name: 'ProvisionedThroughputExceededException',
      }),
    );
    const failingHandler = createChatReviewHandler({
      env,
      clients: failingClients,
      now: () => 1_700_000_000_000,
    });
    await expect(failingHandler(event('second'))).rejects.toThrow(
      'ddb unavailable',
    );
    expect(failingDdb.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('propagates NG-word query and comment transaction failures', async () => {
    ddb.on(QueryCommand).rejectsOnce(new Error('query unavailable'));
    await expect(chatReviewHandler(event('hello'))).rejects.toThrow(
      'query unavailable',
    );
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb
      .on(TransactWriteCommand)
      .rejectsOnce(new Error('transaction unavailable'));
    await expect(chatReviewHandler(event('hello'))).rejects.toThrow(
      'transaction unavailable',
    );
  });

  it('starts profile and NG-word reads concurrently', async () => {
    const parallelClients = createClients(env);
    const parallelDdb = mockClient(parallelClients.ddb);
    let releaseProfile!: () => void;
    const profileGate = new Promise<void>((resolve) => {
      releaseProfile = resolve;
    });
    parallelDdb.on(GetCommand).callsFake(async () => {
      await profileGate;
      return {
        Item: { displayName: 'テストユーザー', commentSuspended: false },
      };
    });
    parallelDdb.on(QueryCommand).callsFake(async () => {
      return { Items: [] };
    });
    parallelDdb.on(TransactWriteCommand).resolves({});
    const pending = createChatReviewHandler({
      env,
      clients: parallelClients,
      now: () => 1_700_000_000_000,
    })(event('hello'));
    try {
      expect(parallelDdb.commandCalls(QueryCommand)).toHaveLength(1);
      expect(parallelDdb.commandCalls(GetCommand)).toHaveLength(1);
    } finally {
      releaseProfile();
    }
    await expect(pending).resolves.toMatchObject({ ReviewResult: 'ALLOW' });
  });
});
