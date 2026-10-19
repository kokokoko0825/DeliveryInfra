import { createHash } from 'node:crypto';
import { GetCompositionCommand } from '@aws-sdk/client-ivs-realtime';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SendEventCommand } from '@aws-sdk/client-ivschat';
import { createClients, type Clients } from './aws';
import { getRecordingEnv, type RecordingEnv } from './env';
import { ChatCustomEventSchema } from '@delivery/shared';

export interface RecordingEvent {
  source: string;
  'detail-type': string;
  time: string;
  resources: string[];
  detail: { event_name: string; stage_arn?: string };
}
interface RecordingDependencies { env: RecordingEnv; clients: Clients; now?: () => number }

export function createRecordingHandler(dependencies?: RecordingDependencies) {
  return async (event: RecordingEvent): Promise<{ archived: boolean; archiveId?: string }> => {
    if (event.source !== 'aws.ivs' || event['detail-type'] !== 'IVS Composition State Change' || event.detail.event_name !== 'Session End') return { archived: false };
    const env = dependencies?.env ?? getRecordingEnv();
    const clients = dependencies?.clients ?? createClients(env);
    const compositionArn = event.resources[0];
    if (!compositionArn) return { archived: false };
    const ddb = clients.ddb;
    const compositionResult = await ddb.send(new GetCommand({ TableName: env.TABLE_NAME, Key: { PK: `COMPOSITION#${compositionArn}`, SK: 'META' }, ConsistentRead: true }));
    const metadata = compositionResult.Item as { broadcastId?: string; title?: string; startedAt?: string; recordingPrefix?: string } | undefined;
    if (!metadata) return { archived: false };
    const details = metadata.recordingPrefix ? undefined : (await clients.ivs.send(new GetCompositionCommand({ arn: compositionArn }))).composition;
    const recordingPrefix = metadata.recordingPrefix ?? details?.destinations?.find((destination) => destination.detail?.s3?.recordingPrefix)?.detail?.s3?.recordingPrefix;
    if (!recordingPrefix) throw new Error(`IVS composition ${compositionArn} has no S3 recording prefix`);
    const archiveId = createHash('sha256').update(compositionArn).digest('hex').slice(0, 32);
    const existingArchive = await ddb.send(new GetCommand({ TableName: env.TABLE_NAME, Key: { PK: `ARCHIVE#${archiveId}`, SK: 'ITEM' }, ConsistentRead: true }));
    if (existingArchive.Item) {
      const custom = ChatCustomEventSchema.parse({ eventName: 'archives-updated' });
      await clients.chat.send(new SendEventCommand({ roomIdentifier: env.CHAT_ROOM_ARN, eventName: custom.eventName }));
      return { archived: true, archiveId };
    }
    const startTime = details?.startTime?.getTime() ?? Date.parse(metadata.startedAt ?? event.time);
    const endTime = details?.endTime?.getTime() ?? Date.parse(event.time);
    await ddb.send(new PutCommand({
      TableName: env.TABLE_NAME,
      Item: {
        PK: `ARCHIVE#${archiveId}`, SK: 'ITEM', id: archiveId, broadcastId: metadata.broadcastId,
        title: metadata.title ?? '配信アーカイブ', s3Prefix: recordingPrefix,
        s3Path: `${recordingPrefix.replace(/\/+$/u, '')}/media/hls/multivariant.m3u8`,
        durationSeconds: Math.max(0, Math.round((endTime - startTime) / 1000)),
        published: false, createdAt: new Date(dependencies?.now?.() ?? Date.now()).toISOString(),
      },
    }));
    const custom = ChatCustomEventSchema.parse({ eventName: 'archives-updated' });
    await clients.chat.send(new SendEventCommand({ roomIdentifier: env.CHAT_ROOM_ARN, eventName: custom.eventName }));
    return { archived: true, archiveId };
  };
}


export const recordingHandler = createRecordingHandler();
export const handler = recordingHandler;
