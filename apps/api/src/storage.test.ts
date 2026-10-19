import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { deletePrefix } from './storage';

const s3 = new S3Client({ region: 'us-east-1' });
const mock = mockClient(s3);

beforeEach(() => {
  mock.reset();
  mock.on(ListObjectsV2Command).resolves({ Contents: [{ Key: 'archive/media/index.m3u8' }, { Key: undefined }] });
  mock.on(DeleteObjectsCommand).resolves({});
});

describe('deletePrefix', () => {
  it('normalizes the prefix, ignores missing object keys, counts deleted keys and paginates', async () => {
    mock.on(ListObjectsV2Command)
      .resolvesOnce({ Contents: [{ Key: 'archive/a.ts' }, { Key: undefined }], NextContinuationToken: 'next' })
      .resolves({ Contents: [{ Key: 'archive/b.ts' }] });
    await expect(deletePrefix(s3, 'recordings', 'archive')).resolves.toBe(2);
    expect(mock.commandCalls(ListObjectsV2Command).map((call) => call.args[0].input)).toEqual([
      { Bucket: 'recordings', Prefix: 'archive/' },
      { Bucket: 'recordings', Prefix: 'archive/', ContinuationToken: 'next' },
    ]);
    expect(mock.commandCalls(DeleteObjectsCommand).map((call) => call.args[0].input.Delete)).toEqual([
      { Objects: [{ Key: 'archive/a.ts' }], Quiet: true },
      { Objects: [{ Key: 'archive/b.ts' }], Quiet: true },
    ]);
  });

  it('adds a trailing separator to a prefix that already starts with a slash', async () => {
    mock.on(ListObjectsV2Command).resolves({ Contents: [] });
    await expect(deletePrefix(s3, 'recordings', '/archive')).resolves.toBe(0);
    expect(mock.commandCalls(ListObjectsV2Command).map((call) => call.args[0].input)).toEqual([
      { Bucket: 'recordings', Prefix: '/archive/' },
    ]);
  });

  it.each(['', '/'])('refuses an empty prefix %j without listing', async (prefix) => {
    await expect(deletePrefix(s3, 'recordings', prefix)).rejects.toThrow('Refusing to delete an empty S3 prefix');
    expect(mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
  });

  it('does not issue an empty delete and reports object level failures', async () => {
    mock.on(ListObjectsV2Command).resolvesOnce({ Contents: [{ Key: undefined }] });
    await expect(deletePrefix(s3, 'recordings', 'archive/')).resolves.toBe(0);
    expect(mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
    mock.on(ListObjectsV2Command).resolves({ Contents: [{ Key: 'archive/a.ts' }] });
    mock.on(DeleteObjectsCommand).resolves({ Errors: [{ Key: 'archive/a.ts', Code: 'AccessDenied' }] });
    await expect(deletePrefix(s3, 'recordings', 'archive')).rejects.toThrow('Failed to delete 1 objects under archive/');
  });
});
