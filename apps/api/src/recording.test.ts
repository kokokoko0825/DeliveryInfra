import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetCompositionCommand } from '@aws-sdk/client-ivs-realtime';
import { CopyObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { SendEventCommand } from '@aws-sdk/client-ivschat';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createClients } from './aws';
import { RecordingEnvSchema } from './env';
import { createRecordingHandler } from './recording';

const env = RecordingEnvSchema.parse({TABLE_NAME: 'table', RECORDING_BUCKET: 'recording', CHAT_ROOM_ARN: 'room', STAGE_BROADCAST_ARN: 'broadcast'});
const clients = createClients(env);
const ddb = mockClient(clients.ddb);
const ivs = mockClient(clients.ivs);
const s3 = mockClient(clients.s3);
const chat = mockClient(clients.chat);
const handler = createRecordingHandler({ env, clients, now: () => Date.parse('2026-01-01T01:00:00.000Z') });
const event = { source: 'aws.ivs', 'detail-type': 'IVS Composition State Change', time: '2026-01-01T01:00:00Z', resources: ['arn:composition'], detail: { event_name: 'Session End', stage_arn: 'stage' } };

beforeEach(() => {
  ddb.reset(); ivs.reset(); s3.reset(); chat.reset();
  ddb.on(GetCommand).resolves({});
  ddb.on(GetCommand, { TableName: 'table', Key: { PK: 'COMPOSITION#arn:composition', SK: 'META' } }).resolves({ Item: { broadcastId: 'broadcast-id', title: '配信', startedAt: '2026-01-01T00:00:00Z', recordingPrefix: 'st/session/composition/composite' } });
  ddb.on(PutCommand).resolves({});
  ivs.on(GetCompositionCommand).resolves({ composition: { arn: 'arn:composition', stageArn: 'stage', state: 'STOPPED', layout: {}, startTime: new Date('2026-01-01T00:00:00Z'), endTime: new Date('2026-01-01T01:00:00Z'), destinations: [] } });
  s3.on(ListObjectsV2Command).resolves({ Contents: [{ Key: 'st/session/composition/composite/media/hls/multivariant.m3u8' }, { Key: 'st/session/composition/composite/media/hls/video.m3u8' }] });
  s3.on(CopyObjectCommand).resolves({});
  s3.on(DeleteObjectsCommand).resolves({});
  chat.on(SendEventCommand).resolves({});
});

describe('recording handler', () => {
  it('registers the completed HLS in its original private recording prefix', async () => {
    await expect(handler(event)).resolves.toMatchObject({ archived: true });
    const archive = ddb.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(archive).toMatchObject({ title: '配信', published: false, durationSeconds: 3600, s3Path: 'st/session/composition/composite/media/hls/multivariant.m3u8' });
    expect(s3.commandCalls(CopyObjectCommand)).toHaveLength(0);
    expect(s3.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
    expect(chat.commandCalls(SendEventCommand)[0]?.args[0].input.eventName).toBe('archives-updated');
  });
  it('ignores non-session-end events', async () => {
    await expect(handler({ ...event, detail: { event_name: 'Session Start' } })).resolves.toEqual({ archived: false });
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });
});
