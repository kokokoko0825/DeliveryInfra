import { createHash } from 'node:crypto';
import { GetCompositionCommand } from '@aws-sdk/client-ivs-realtime';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SendEventCommand } from '@aws-sdk/client-ivschat';
import { ARCHIVE_RETENTION_DAYS, ChatCustomEventSchema } from '@delivery/shared';
import { createClients, type Clients } from './aws';
import { isConditionalFailure, KEYS } from './database';
import { getRecordingEnv, type RecordingEnv } from './env';

export interface RecordingEvent {
  source: string;
  'detail-type': string;
  time: string;
  resources: string[];
  detail: { event_name: string; stage_arn?: string };
}
interface RecordingDependencies { env: RecordingEnv; clients: Clients; now?: () => number }
const SESSION_EVENTS = new Set(['Session End', 'Session Failure']);

export function createRecordingHandler(dependencies?: RecordingDependencies) {
  return async (event: RecordingEvent): Promise<{ archived: boolean; archiveId?: string; broadcastEnded?: boolean }> => {
    if (event.source !== 'aws.ivs' || event['detail-type'] !== 'IVS Composition State Change' || !SESSION_EVENTS.has(event.detail.event_name)) return { archived: false };
    const env = dependencies?.env ?? getRecordingEnv();
    const clients = dependencies?.clients ?? createClients(env);
    const nowMs = dependencies?.now?.() ?? Date.now();
    const compositionArn = event.resources[0];
    if (!compositionArn) return { archived: false };
    const ddb = clients.ddb;
    const sendChatEvent = async (name: string) => {
      const custom = ChatCustomEventSchema.parse({ eventName: name });
      await clients.chat.send(new SendEventCommand({ roomIdentifier: env.CHAT_ROOM_ARN, eventName: custom.eventName }));
    };

    // Composition が自動停止・失敗した場合でも配信状態を ended に進める（R1-03）
    let broadcastEnded = false;
    try {
      await ddb.send(new UpdateCommand({
        TableName: env.TABLE_NAME, Key: { PK: 'BROADCAST', SK: 'CURRENT' },
        UpdateExpression: 'SET #status = :ended, endedAt = :endedAt',
        ConditionExpression: 'compositionArn = :arn AND #status = :live',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':ended': 'ended', ':endedAt': new Date(nowMs).toISOString(), ':arn': compositionArn, ':live': 'live' },
      }));
      broadcastEnded = true;
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }
    if (broadcastEnded) await sendChatEvent('broadcast-ended');
    if (event.detail.event_name === 'Session Failure') console.error(JSON.stringify({ level: 'error', event: 'composition_session_failure', compositionArn }));

    const compositionResult = await ddb.send(new GetCommand({ TableName: env.TABLE_NAME, Key: { PK: KEYS.compositionPk(compositionArn), SK: 'META' }, ConsistentRead: true }));
    const metadata = compositionResult.Item as { broadcastId?: string; title?: string; startedAt?: string; outputPrefix?: string } | undefined;
    if (!metadata) return { archived: false, broadcastEnded };
    const details = metadata.outputPrefix ? undefined : (await clients.ivs.send(new GetCompositionCommand({ arn: compositionArn }))).composition;
    const outputPrefix = metadata.outputPrefix ?? details?.destinations?.find((destination) => destination.detail?.s3?.recordingPrefix)?.detail?.s3?.recordingPrefix;
    if (!outputPrefix) throw new Error(`IVS composition ${compositionArn} has no S3 recording prefix`);
    const archiveId = createHash('sha256').update(compositionArn).digest('hex').slice(0, 32);
    const startTime = details?.startTime?.getTime() ?? Date.parse(metadata.startedAt ?? event.time);
    const endTime = details?.endTime?.getTime() ?? Date.parse(event.time);
    // 保存期限は作成から365日。DynamoDB TTL で行が消えると archive-expiry が録画を削除する（R1-22）
    const retainUntilMs = nowMs + ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    try {
      await ddb.send(new PutCommand({
        TableName: env.TABLE_NAME,
        Item: {
          PK: KEYS.archivePk, SK: archiveId, id: archiveId, broadcastId: metadata.broadcastId,
          // recordingPrefix はアーカイブ行だけが持つ（Infra の Stream フィルタ条件）
          title: metadata.title ?? '配信アーカイブ', recordingPrefix: outputPrefix.replace(/\/+$/u, ''),
          durationSeconds: Math.max(0, Math.round((endTime - startTime) / 1000)),
          published: false, createdAt: new Date(nowMs).toISOString(),
          retainUntil: new Date(retainUntilMs).toISOString(), ttl: Math.floor(retainUntilMs / 1000),
        },
        // End と Failure の両方が届いても1件にする
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }
    await sendChatEvent('archives-updated');
    return { archived: true, archiveId, broadcastEnded };
  };
}

export const recordingHandler = createRecordingHandler();
export const handler = recordingHandler;
