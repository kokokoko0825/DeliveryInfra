import { createClients, type Clients } from './aws';
import { KEYS } from './database';
import { getArchiveExpiryEnv, type ArchiveExpiryEnv } from './env';
import { deletePrefix } from './storage';

/** DynamoDB Streams の REMOVE レコード（OLD_IMAGE を含む）のうち使う部分。 */
export interface ArchiveStreamRecord {
  eventName?: string;
  userIdentity?: { type?: string; principalId?: string };
  dynamodb?: { SequenceNumber?: string; OldImage?: Record<string, { S?: string }> };
}
export interface ArchiveStreamEvent { Records: ArchiveStreamRecord[] }
export interface BatchResponse { batchItemFailures: { itemIdentifier: string }[] }

/**
 * アーカイブ行が消えたら（主に retainUntil の TTL 到来）録画 prefix を削除する（R1-22）。
 * API の DELETE で先に消えている場合も、空の prefix を削除するだけなので冪等。
 * 失敗したレコードは ReportBatchItemFailures（itemIdentifier = SequenceNumber）で再試行させる。
 */
export function createArchiveExpiryHandler(dependencies?: { env?: ArchiveExpiryEnv; clients?: Clients }) {
  return async (event: ArchiveStreamEvent): Promise<BatchResponse> => {
    const env = dependencies?.env ?? getArchiveExpiryEnv();
    const clients = dependencies?.clients ?? createClients(env);
    const batchItemFailures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      const image = record.dynamodb?.OldImage;
      if (record.eventName !== 'REMOVE' || image?.PK?.S !== KEYS.archivePk) continue;
      const prefix = image.recordingPrefix?.S?.replace(/\/+$/u, '');
      try {
        if (!prefix) throw new Error(`Archive ${image.SK?.S ?? '?'} has no recordingPrefix`);
        const deleted = await deletePrefix(clients.s3, env.RECORDING_BUCKET, prefix);
        const byTtl = record.userIdentity?.type === 'Service' && record.userIdentity.principalId === 'dynamodb.amazonaws.com';
        console.info(JSON.stringify({ event: 'archive_recording_deleted', archiveId: image.SK?.S, prefix, deleted, byTtl }));
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', event: 'archive_recording_delete_failed', archiveId: image.SK?.S, message: error instanceof Error ? error.message : String(error) }));
        const sequenceNumber = record.dynamodb?.SequenceNumber;
        if (!sequenceNumber) throw error;
        batchItemFailures.push({ itemIdentifier: sequenceNumber });
        // 以降のレコードは最小の失敗位置から再試行されるので処理しない
        break;
      }
    }
    return { batchItemFailures };
  };
}

export const archiveExpiryHandler = createArchiveExpiryHandler();
export const handler = archiveExpiryHandler;
