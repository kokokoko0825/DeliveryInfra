import { describe, expect, it } from 'vitest';
import {
  ApiEnvSchema, ArchiveExpiryEnvSchema, ChatReviewEnvSchema, CognitoEnvSchema,
  RecordingEnvSchema, getApiEnv, getArchiveExpiryEnv, getChatReviewEnv, getCognitoEnv, getRecordingEnv,
} from './env';

const apiEnv = {
  USER_POOL_ID: 'pool', USER_POOL_CLIENT_ID: 'client', TABLE_NAME: 'table',
  STAGE_PRODUCTION_ARN: 'production', STAGE_SLIDE_ARN: 'slide', STAGE_BROADCAST_ARN: 'broadcast',
  CHAT_ROOM_ARN: 'room', CONTENT_BUCKET: 'content', RECORDING_BUCKET: 'recording',
  RECORDING_STORAGE_CONFIGURATION_ARN: 'storage', ENCODER_CONFIGURATION_ARN: 'encoder',
  CLOUDFRONT_KEY_PAIR_ID: 'key-pair', CLOUDFRONT_PRIVATE_KEY_PARAMETER: '/delivery/key',
};

describe('Lambda environment validation', () => {
  it('applies region and production defaults and validates every required API binding', () => {
    expect(ApiEnvSchema.parse(apiEnv)).toEqual({ ...apiEnv, AWS_REGION: 'ap-northeast-1', NODE_ENV: 'production' });
    expect(ApiEnvSchema.parse({ ...apiEnv, AWS_REGION: 'us-east-1', NODE_ENV: 'test' })).toMatchObject({ AWS_REGION: 'us-east-1', NODE_ENV: 'test' });
    for (const key of Object.keys(apiEnv)) expect(ApiEnvSchema.safeParse({ ...apiEnv, [key]: '' }).success, key).toBe(false);
    expect(ApiEnvSchema.safeParse({ ...apiEnv, NODE_ENV: 'stage' }).success).toBe(false);
  });

  it('requires the table for review, cognito, and recording handlers', () => {
    expect(ChatReviewEnvSchema.parse({ TABLE_NAME: 'table' })).toEqual({ TABLE_NAME: 'table', AWS_REGION: 'ap-northeast-1', NODE_ENV: 'production' });
    expect(CognitoEnvSchema.safeParse({ TABLE_NAME: '' }).success).toBe(false);
    expect(RecordingEnvSchema.safeParse({ TABLE_NAME: 'table', RECORDING_BUCKET: 'bucket', CHAT_ROOM_ARN: 'room', STAGE_BROADCAST_ARN: 'stage' }).success).toBe(true);
    for (const key of ['TABLE_NAME', 'RECORDING_BUCKET', 'CHAT_ROOM_ARN', 'STAGE_BROADCAST_ARN']) {
      const valid = { TABLE_NAME: 'table', RECORDING_BUCKET: 'bucket', CHAT_ROOM_ARN: 'room', STAGE_BROADCAST_ARN: 'stage' };
      expect(RecordingEnvSchema.safeParse({ ...valid, [key]: '' }).success, key).toBe(false);
    }
    expect(ArchiveExpiryEnvSchema.parse({ RECORDING_BUCKET: 'bucket' })).toEqual({ RECORDING_BUCKET: 'bucket', AWS_REGION: 'ap-northeast-1', NODE_ENV: 'production' });
  });

  it('exposes parsed values through each environment accessor', () => {
    expect(getApiEnv({ ...apiEnv, AWS_REGION: 'ap-southeast-2', NODE_ENV: 'development' })).toMatchObject({ AWS_REGION: 'ap-southeast-2', NODE_ENV: 'development' });
    expect(getChatReviewEnv({ TABLE_NAME: 'chat-table' }).TABLE_NAME).toBe('chat-table');
    expect(getRecordingEnv({ TABLE_NAME: 't', RECORDING_BUCKET: 'b', CHAT_ROOM_ARN: 'r', STAGE_BROADCAST_ARN: 's' }).STAGE_BROADCAST_ARN).toBe('s');
    expect(getCognitoEnv({ TABLE_NAME: 'cognito-table' }).TABLE_NAME).toBe('cognito-table');
    expect(getArchiveExpiryEnv({ RECORDING_BUCKET: 'archive-bucket' }).RECORDING_BUCKET).toBe('archive-bucket');
  });
});
