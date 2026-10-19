import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createArchiveExpiryHandler, type ArchiveStreamRecord } from './archive-expiry';
import { createClients } from './aws';
import { ArchiveExpiryEnvSchema } from './env';

const env = ArchiveExpiryEnvSchema.parse({ RECORDING_BUCKET: 'recording' });
const clients = createClients(env);
const s3 = mockClient(clients.s3);
const handler = createArchiveExpiryHandler({ env, clients });
const ttlIdentity = { type: 'Service', principalId: 'dynamodb.amazonaws.com' };
const remove = (sequence: string, image: Record<string, { S?: string }>): ArchiveStreamRecord => ({ eventName: 'REMOVE', userIdentity: ttlIdentity, dynamodb: { SequenceNumber: sequence, OldImage: image } });
const archiveImage = (id: string) => ({ PK: { S: 'ARCHIVE' }, SK: { S: id }, recordingPrefix: { S: `stage/${id}/d/composite` } });

beforeEach(() => {
  s3.reset();
  s3.on(ListObjectsV2Command).resolves({ Contents: [{ Key: 'stage/a-1/d/composite/media/hls/multivariant.m3u8' }, { Key: 'stage/a-1/d/composite/media/hls/0.ts' }] });
  s3.on(DeleteObjectsCommand).resolves({});
});

describe('archive expiry stream handler (R1-22)', () => {
  it('deletes the recording prefix of an archive removed by TTL', async () => {
    await expect(handler({ Records: [remove('1', archiveImage('a-1'))] })).resolves.toEqual({ batchItemFailures: [] });
    expect(s3.commandCalls(ListObjectsV2Command)[0]?.args[0].input).toMatchObject({ Bucket: 'recording', Prefix: 'stage/a-1/d/composite/' });
    expect(s3.commandCalls(DeleteObjectsCommand)[0]?.args[0].input.Delete?.Objects).toEqual([{ Key: 'stage/a-1/d/composite/media/hls/multivariant.m3u8' }, { Key: 'stage/a-1/d/composite/media/hls/0.ts' }]);
  });

  it('pages through every object under the prefix', async () => {
    s3.on(ListObjectsV2Command).resolvesOnce({ Contents: [{ Key: 'stage/a-1/d/composite/1' }], NextContinuationToken: 'next' }).resolves({ Contents: [{ Key: 'stage/a-1/d/composite/2' }] });
    await handler({ Records: [remove('1', archiveImage('a-1'))] });
    expect(s3.commandCalls(ListObjectsV2Command).map((call) => call.args[0].input)).toEqual([
      { Bucket: 'recording', Prefix: 'stage/a-1/d/composite/', ContinuationToken: undefined },
      { Bucket: 'recording', Prefix: 'stage/a-1/d/composite/', ContinuationToken: 'next' },
    ]);
    expect(s3.commandCalls(DeleteObjectsCommand)).toHaveLength(2);
    expect(s3.commandCalls(DeleteObjectsCommand).map((call) => call.args[0].input.Delete?.Objects)).toEqual([
      [{ Key: 'stage/a-1/d/composite/1' }],
      [{ Key: 'stage/a-1/d/composite/2' }],
    ]);
  });

  it('removes trailing separators before passing the stored recording prefix to storage', async () => {
    await handler({ Records: [remove('6', { ...archiveImage('a-1'), recordingPrefix: { S: 'stage/a-1/d/composite///' } })] });
    expect(s3.commandCalls(ListObjectsV2Command)[0]?.args[0].input.Prefix).toBe('stage/a-1/d/composite/');
  });

  it('ignores inserts, modifications and non-archive removals', async () => {
    await handler({ Records: [
      { eventName: 'MODIFY', dynamodb: { SequenceNumber: '1', OldImage: archiveImage('a-1') } },
      { eventName: 'INSERT', dynamodb: { SequenceNumber: '2' } },
      remove('3', { PK: { S: 'COMMENT#m-1' }, SK: { S: 'ITEM' } }),
      remove('4', { PK: { S: 'USER#u' }, SK: { S: 'CHAT_RATE' }, recordingPrefix: { S: 'stage/x' } }),
    ] });
    expect(s3.commandCalls(ListObjectsV2Command)).toHaveLength(0);
  });

  it('reports the first failed sequence number and stops processing later records', async () => {
    s3.on(DeleteObjectsCommand).resolves({ Errors: [{ Key: 'stage/a-1/d/composite/0.ts', Code: 'AccessDenied' }] });
    await expect(handler({ Records: [remove('10', archiveImage('a-1')), remove('11', archiveImage('a-2'))] })).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: '10' }] });
    expect(s3.commandCalls(ListObjectsV2Command)).toHaveLength(1);
  });

  it('treats an archive without a recordingPrefix as a failure instead of deleting the whole bucket', async () => {
    await expect(handler({ Records: [remove('5', { PK: { S: 'ARCHIVE' }, SK: { S: 'a-3' } })] })).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: '5' }] });
    expect(s3.commandCalls(ListObjectsV2Command)).toHaveLength(0);
  });

  it('fails the stream invocation when a malformed record has no sequence number to report', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(handler({ Records: [
      { eventName: 'REMOVE', dynamodb: { OldImage: { PK: { S: 'ARCHIVE' }, SK: { S: 'a-1' } } } },
    ] })).rejects.toThrow('Archive a-1 has no recordingPrefix');
    expect(error).toHaveBeenCalledWith(JSON.stringify({ level: 'error', event: 'archive_recording_delete_failed', archiveId: 'a-1', message: 'Archive a-1 has no recordingPrefix' }));
    error.mockRestore();
  });

  it('fails the invocation when S3 deletion fails and a sequence number is unavailable', async () => {
    s3.on(ListObjectsV2Command).rejects(new Error('S3 unavailable'));
    await expect(handler({ Records: [
      { eventName: 'REMOVE', userIdentity: ttlIdentity, dynamodb: { OldImage: archiveImage('a-4') } },
    ] })).rejects.toThrow('S3 unavailable');
    expect(s3.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
  });

  it('records whether a removal came from DynamoDB TTL', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await handler({ Records: [
      remove('ttl', archiveImage('ttl')),
      { eventName: 'REMOVE', dynamodb: { SequenceNumber: 'manual', OldImage: archiveImage('manual') } },
    ] });
    expect(info.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { event: 'archive_recording_deleted', archiveId: 'ttl', prefix: 'stage/ttl/d/composite', deleted: 2, byTtl: true },
      { event: 'archive_recording_deleted', archiveId: 'manual', prefix: 'stage/manual/d/composite', deleted: 2, byTtl: false },
    ]);
    info.mockRestore();
  });
});
