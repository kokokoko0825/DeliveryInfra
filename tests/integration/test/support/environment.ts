/**
 * API / recording Lambda が読む環境変数(infra の buildLambdaEnvironment と同じキー)。値はダミー。
 * 認証情報は presigned POST の署名計算にだけ使われる(通信はすべてモック)。
 */
export const REGION = 'ap-northeast-1';
export const ACCOUNT = '123456789012';
export const ENV = {
  AWS_REGION: REGION,
  AWS_ACCESS_KEY_ID: 'AKIAINTEGRATIONTEST',
  AWS_SECRET_ACCESS_KEY: 'integration-test-secret',
  NODE_ENV: 'test',
  USER_POOL_ID: `${REGION}_Integ1234`,
  USER_POOL_CLIENT_ID: 'integration-client-id',
  TABLE_NAME: 'delivery-integration-table',
  STAGE_PRODUCTION_ARN: `arn:aws:ivs:${REGION}:${ACCOUNT}:stage/production`,
  STAGE_SLIDE_ARN: `arn:aws:ivs:${REGION}:${ACCOUNT}:stage/slide`,
  STAGE_BROADCAST_ARN: `arn:aws:ivs:${REGION}:${ACCOUNT}:stage/broadcast`,
  /** recording が使う。api は CHAT_ROOM_NAME から ListRooms でこの ARN を引く。 */
  CHAT_ROOM_ARN: `arn:aws:ivschat:${REGION}:${ACCOUNT}:room/room1`,
  CHAT_ROOM_NAME: 'delivery-integration-room',
  CONTENT_BUCKET: 'delivery-integration-content',
  RECORDING_BUCKET: 'delivery-integration-recording',
  RECORDING_STORAGE_CONFIGURATION_NAME: 'delivery-integration-recording',
  ENCODER_CONFIGURATION_ARN: `arn:aws:ivs:${REGION}:${ACCOUNT}:encoder-configuration/encoder1`,
  CLOUDFRONT_KEY_PAIR_ID: 'K2INTEGRATION',
  CLOUDFRONT_KEY_GROUP_ID: 'key-group-1',
  CLOUDFRONT_PRIVATE_KEY_PARAMETER: '/delivery-integration/cloudfront/private-key',
} as const;

/** api は StorageConfiguration を名前で受け取り、ListStorageConfigurations でこの ARN を引く。 */
export const RECORDING_STORAGE_CONFIGURATION_ARN = `arn:aws:ivs:${REGION}:${ACCOUNT}:storage-configuration/storage1`;

/**
 * API が前提とする GSI。フェイクの DynamoDB は未定義の IndexName を拒否し(API 通しテストが落ちる)、
 * infra-api.test.ts は CDK のテーブル定義がこれと完全に一致することを検証する。現在の設計は GSI なし。
 */
export const TABLE_INDEXES: Record<string, { partitionKey: string; sortKey: string }> = {};

export const CLOUDFRONT_HOST = 'd111111abcdef8.cloudfront.net';

Object.assign(process.env, ENV);
