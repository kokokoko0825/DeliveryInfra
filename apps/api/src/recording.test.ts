import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetCompositionCommand } from '@aws-sdk/client-ivs-realtime';
import { CopyObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { SendEventCommand } from '@aws-sdk/client-ivschat';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createClients } from './aws';
import { RecordingEnvSchema } from './env';
import { createRecordingHandler } from './recording';

const env = RecordingEnvSchema.parse({TABLE_NAME: 'table', RECORDING_BUCKET: 'recording', CHAT_ROOM_ARN: 'room', STAGE_BROADCAST_ARN: 'broadcast'});
const clients = createClients(env);
const ddb = mockClient(clients.ddb);
const ivs = mockClient(clients.ivs);
const s3 = mockClient(clients.s3);
const chat = mockClient(clients.chat);
const NOW = Date.parse('2026-01-01T01:00:00.000Z');
const handler = createRecordingHandler({ env, clients, now: () => NOW });
const event = { source: 'aws.ivs', 'detail-type': 'IVS Composition State Change', time: '2026-01-01T01:00:00Z', resources: ['arn:composition'], detail: { event_name: 'Session End', stage_arn: 'stage' } };
const conditionalError = () => Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });

beforeEach(() => {
  ddb.reset(); ivs.reset(); s3.reset(); chat.reset();
  ddb.on(GetCommand).resolves({});
  ddb.on(GetCommand, { TableName: 'table', Key: { PK: 'COMPOSITION#arn:composition', SK: 'META' } }).resolves({ Item: { broadcastId: 'broadcast-id', title: '配信', startedAt: '2026-01-01T00:00:00Z', outputPrefix: 'st/session/composition/composite' } });
  ddb.on(PutCommand).resolves({});
  // 既定では BROADCAST/CURRENT がこの Composition の live ではない
  ddb.on(UpdateCommand).rejects(conditionalError());
  ivs.on(GetCompositionCommand).resolves({ composition: { arn: 'arn:composition', stageArn: 'stage', state: 'STOPPED', layout: {}, startTime: new Date('2026-01-01T00:00:00Z'), endTime: new Date('2026-01-01T01:00:00Z'), destinations: [] } });
  s3.on(ListObjectsV2Command).resolves({ Contents: [{ Key: 'st/session/composition/composite/media/hls/multivariant.m3u8' }] });
  s3.on(CopyObjectCommand).resolves({});
  s3.on(DeleteObjectsCommand).resolves({});
  chat.on(SendEventCommand).resolves({});
});

describe('recording handler', () => {
  it('registers the completed HLS in its original private recording prefix with a 365 day retention (R1-22)', async () => {
    await expect(handler(event)).resolves.toMatchObject({ archived: true, broadcastEnded: false });
    const put = ddb.commandCalls(PutCommand)[0]?.args[0].input;
    expect(put?.Item).toMatchObject({
      PK: 'ARCHIVE', title: '配信', published: false, durationSeconds: 3600, recordingPrefix: 'st/session/composition/composite', createdAt: '2026-01-01T01:00:00.000Z',
      retainUntil: '2027-01-01T01:00:00.000Z', ttl: Date.parse('2027-01-01T01:00:00.000Z') / 1000,
    });
    expect(put?.Item?.SK).toBe(put?.Item?.id);
    expect(put?.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(s3.commandCalls(CopyObjectCommand)).toHaveLength(0);
    expect(s3.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
    expect(chat.commandCalls(SendEventCommand).map((call) => call.args[0].input.eventName)).toEqual(['archives-updated']);
  });

  it.each(['Session End', 'Session Failure'])('ends the matching live broadcast on %s and notifies viewers (R1-03)', async (eventName) => {
    ddb.on(UpdateCommand).resolves({});
    await expect(handler({ ...event, detail: { event_name: eventName } })).resolves.toMatchObject({ archived: true, broadcastEnded: true });
    expect(ddb.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({
      Key: { PK: 'BROADCAST', SK: 'CURRENT' }, ConditionExpression: 'compositionArn = :arn AND #status = :live',
      ExpressionAttributeValues: { ':ended': 'ended', ':arn': 'arn:composition', ':live': 'live', ':endedAt': '2026-01-01T01:00:00.000Z' },
    });
    expect(chat.commandCalls(SendEventCommand).map((call) => call.args[0].input.eventName)).toEqual(['broadcast-ended', 'archives-updated']);
  });

  it('resends broadcast-ended when a retry finds the broadcast already ended by this composition (R2-03)', async () => {
    ddb.on(UpdateCommand).resolvesOnce({}).rejects(conditionalError());
    ddb.on(GetCommand, { TableName: 'table', Key: { PK: 'BROADCAST', SK: 'CURRENT' }, ConsistentRead: true }).resolves({ Item: { status: 'ended', compositionArn: 'arn:composition' } });
    chat.on(SendEventCommand).rejectsOnce(new Error('chat unavailable')).resolves({});
    await expect(handler(event)).rejects.toThrow('chat unavailable');
    await expect(handler(event)).resolves.toMatchObject({ archived: true, broadcastEnded: true });
    expect(chat.commandCalls(SendEventCommand).map((call) => call.args[0].input.eventName)).toEqual(['broadcast-ended', 'broadcast-ended', 'archives-updated']);
  });

  it('does not announce the end of a different or still-live broadcast', async () => {
    ddb.on(GetCommand, { TableName: 'table', Key: { PK: 'BROADCAST', SK: 'CURRENT' }, ConsistentRead: true }).resolves({ Item: { status: 'ended', compositionArn: 'arn:other' } });
    await expect(handler(event)).resolves.toMatchObject({ broadcastEnded: false });
    ddb.on(GetCommand, { TableName: 'table', Key: { PK: 'BROADCAST', SK: 'CURRENT' }, ConsistentRead: true }).resolves({ Item: { status: 'live', compositionArn: 'arn:composition' } });
    await expect(handler(event)).resolves.toMatchObject({ broadcastEnded: false });
    expect(chat.commandCalls(SendEventCommand).map((call) => call.args[0].input.eventName)).toEqual(['archives-updated', 'archives-updated']);
  });

  it('keeps one archive when both end and failure events arrive', async () => {
    ddb.on(PutCommand).rejects(conditionalError());
    await expect(handler(event)).resolves.toMatchObject({ archived: true });
  });

  it('falls back to GetComposition when the recording prefix was not stored', async () => {
    ddb.on(GetCommand, { TableName: 'table', Key: { PK: 'COMPOSITION#arn:composition', SK: 'META' } }).resolves({ Item: { title: '配信' } });
    ivs.on(GetCompositionCommand).resolves({ composition: { arn: 'arn:composition', stageArn: 'stage', state: 'STOPPED', layout: {}, startTime: new Date('2026-01-01T00:00:00Z'), endTime: new Date('2026-01-01T00:30:00Z'), destinations: [{ id: 'd', state: 'STOPPED', configuration: {}, detail: { s3: { recordingPrefix: 'p/q/r/composite/' } } } as never] } });
    await handler(event);
    expect(ddb.commandCalls(PutCommand)[0]?.args[0].input.Item).toMatchObject({ recordingPrefix: 'p/q/r/composite', durationSeconds: 1800 });
  });

  it('ignores other composition events', async () => {
    await expect(handler({ ...event, detail: { event_name: 'Session Start' } })).resolves.toEqual({ archived: false });
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
