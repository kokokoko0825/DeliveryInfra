import { z } from 'zod';

const CommonEnvSchema = z.object({
  AWS_REGION: z.string().default('ap-northeast-1'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
});
const CloudFrontKeyEnvSchema = z.object({
  CLOUDFRONT_KEY_PAIR_ID: z.string().min(1),
  CLOUDFRONT_PRIVATE_KEY_PARAMETER: z.string().min(1),
});

export const ApiEnvSchema = CommonEnvSchema.extend({
  USER_POOL_ID: z.string().min(1), USER_POOL_CLIENT_ID: z.string().min(1), TABLE_NAME: z.string().min(1),
  STAGE_PRODUCTION_ARN: z.string().min(1), STAGE_SLIDE_ARN: z.string().min(1), STAGE_BROADCAST_ARN: z.string().min(1),
  // Chat Room と StorageConfiguration は ARN を参照すると CloudFormation が循環するため名前で受け取る(resources.ts で解決)。
  CHAT_ROOM_NAME: z.string().min(1), CONTENT_BUCKET: z.string().min(1), RECORDING_BUCKET: z.string().min(1),
  RECORDING_STORAGE_CONFIGURATION_NAME: z.string().min(1), ENCODER_CONFIGURATION_ARN: z.string().min(1),
}).merge(CloudFrontKeyEnvSchema);
export const ChatReviewEnvSchema = CommonEnvSchema.extend({ TABLE_NAME: z.string().min(1) });
export const RecordingEnvSchema = CommonEnvSchema.extend({
  TABLE_NAME: z.string().min(1), RECORDING_BUCKET: z.string().min(1), CHAT_ROOM_ARN: z.string().min(1), STAGE_BROADCAST_ARN: z.string().min(1),
});
export const CognitoEnvSchema = CommonEnvSchema.extend({ TABLE_NAME: z.string().min(1) });
export const ArchiveExpiryEnvSchema = CommonEnvSchema.extend({ RECORDING_BUCKET: z.string().min(1) });

export type Env = z.infer<typeof ApiEnvSchema>;
export type ChatReviewEnv = z.infer<typeof ChatReviewEnvSchema>;
export type RecordingEnv = z.infer<typeof RecordingEnvSchema>;
export type CognitoEnv = z.infer<typeof CognitoEnvSchema>;
export type ArchiveExpiryEnv = z.infer<typeof ArchiveExpiryEnvSchema>;

const cache = new Map<string, unknown>();
function parseEnv<T>(key: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, source: NodeJS.ProcessEnv): T {
  if (source === process.env && cache.has(key)) return cache.get(key) as T;
  const value = schema.parse(source as unknown);
  if (source === process.env) cache.set(key, value);
  return value;
}
export const getApiEnv = (source: NodeJS.ProcessEnv = process.env): Env => parseEnv('api', ApiEnvSchema, source);
export const getChatReviewEnv = (source: NodeJS.ProcessEnv = process.env): ChatReviewEnv => parseEnv('chat-review', ChatReviewEnvSchema, source);
export const getRecordingEnv = (source: NodeJS.ProcessEnv = process.env): RecordingEnv => parseEnv('recording', RecordingEnvSchema, source);
export const getCognitoEnv = (source: NodeJS.ProcessEnv = process.env): CognitoEnv => parseEnv('cognito', CognitoEnvSchema, source);
export const getArchiveExpiryEnv = (source: NodeJS.ProcessEnv = process.env): ArchiveExpiryEnv => parseEnv('archive-expiry', ArchiveExpiryEnvSchema, source);
export function resetEnvCache(): void { cache.clear(); }
