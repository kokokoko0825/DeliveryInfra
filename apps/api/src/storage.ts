import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';

/** prefix 配下を全削除する。何度呼んでも同じ結果になる（TTL 削除と API 削除の重複に耐える）。 */
export async function deletePrefix(s3: S3Client, bucket: string, prefix: string): Promise<number> {
  if (!prefix || prefix === '/') throw new Error('Refusing to delete an empty S3 prefix');
  const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;
  let deleted = 0;
  let ContinuationToken: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: normalized, ContinuationToken }));
    const keys = page.Contents?.flatMap((item) => item.Key ? [{ Key: item.Key }] : []) ?? [];
    if (keys.length) {
      const result = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
      if (result.Errors?.length) throw new Error(`Failed to delete ${result.Errors.length} objects under ${normalized}`);
      deleted += keys.length;
    }
    ContinuationToken = page.NextContinuationToken;
  } while (ContinuationToken);
  return deleted;
}
