import { describe, expect, it } from 'vitest';
import {
  HANDLER_DIRS,
  type ResourceRefs,
  buildLambdaEnvironment,
  buildRuntimeConfig,
  buildWebClientSettings,
  oauthRedirectUrl,
} from '../src/app-config.ts';

const refs: ResourceRefs = {
  userPoolId: 'pool',
  userPoolClientId: 'client',
  tableName: 'table',
  stageProductionArn: 'stage-prod',
  stageSlideArn: 'stage-slide',
  stageBroadcastArn: 'stage-broadcast',
  chatRoomArn: 'room',
  contentBucket: 'content',
  recordingBucket: 'recording',
  storageConfigurationArn: 'storage',
  encoderConfigurationArn: 'encoder',
  cloudFrontKeyPairId: 'kp',
  cloudFrontPrivateKeyParameter: '/p/key',
};

describe('buildLambdaEnvironment', () => {
  it('api は apps/api/src/env.ts の変数を受け取る(AWS_REGION と CLOUDFRONT_DOMAIN は除く)', () => {
    expect(buildLambdaEnvironment('api', refs)).toEqual({
      NODE_ENV: 'production',
      TABLE_NAME: 'table',
      USER_POOL_ID: 'pool',
      USER_POOL_CLIENT_ID: 'client',
      STAGE_PRODUCTION_ARN: 'stage-prod',
      STAGE_SLIDE_ARN: 'stage-slide',
      STAGE_BROADCAST_ARN: 'stage-broadcast',
      CHAT_ROOM_ARN: 'room',
      CONTENT_BUCKET: 'content',
      RECORDING_BUCKET: 'recording',
      RECORDING_STORAGE_CONFIGURATION_ARN: 'storage',
      ENCODER_CONFIGURATION_ARN: 'encoder',
      CLOUDFRONT_KEY_PAIR_ID: 'kp',
      CLOUDFRONT_PRIVATE_KEY_PARAMETER: '/p/key',
    });
  });
  it('recording は録画バケット・Chat・配信ステージのみ', () => {
    expect(buildLambdaEnvironment('recording', refs)).toEqual({
      NODE_ENV: 'production',
      TABLE_NAME: 'table',
      RECORDING_BUCKET: 'recording',
      CHAT_ROOM_ARN: 'room',
      STAGE_BROADCAST_ARN: 'stage-broadcast',
    });
  });
  it('api に未使用の CLOUDFRONT_KEY_GROUP_ID を渡さない', () => {
    expect(buildLambdaEnvironment('api', refs)).not.toHaveProperty('CLOUDFRONT_KEY_GROUP_ID');
  });
  it('archiveExpiry は録画バケットのみ(テーブルは Stream の OldImage で足りる)', () => {
    expect(buildLambdaEnvironment('archiveExpiry', refs)).toEqual({ NODE_ENV: 'production', RECORDING_BUCKET: 'recording' });
  });
  it.each(['chatReview', 'cognito'] as const)('%s はトリガー元の ID を受け取らない(循環参照回避)', (name) => {
    expect(buildLambdaEnvironment(name, refs)).toEqual({ NODE_ENV: 'production', TABLE_NAME: 'table' });
  });
  it('AWS_REGION(予約変数)はどのハンドラにも設定しない', () => {
    for (const name of Object.keys(HANDLER_DIRS) as (keyof typeof HANDLER_DIRS)[]) {
      expect(buildLambdaEnvironment(name, refs)).not.toHaveProperty('AWS_REGION');
    }
  });
});

describe('HANDLER_DIRS', () => {
  it('apps/api の dist ディレクトリ名に対応', () =>
    expect(HANDLER_DIRS).toEqual({
      api: 'index',
      chatReview: 'chat-review',
      recording: 'recording',
      cognito: 'cognito',
      archiveExpiry: 'archive-expiry',
    }));
});

describe('buildRuntimeConfig', () => {
  const base = { region: 'ap-northeast-1', userPoolId: 'pool', userPoolClientId: 'client', cloudFrontDomain: 'd1.cloudfront.net' };
  it('Okta なしでは oauth を含めない', () => {
    expect(buildRuntimeConfig(base)).toEqual({ region: 'ap-northeast-1', userPoolId: 'pool', userPoolClientId: 'client' });
  });
  it('Okta ありでは Hosted UI とリダイレクト先を含める', () => {
    expect(buildRuntimeConfig({ ...base, oauth: { domain: 'login.example', providerName: 'Okta' } })).toEqual({
      region: 'ap-northeast-1',
      userPoolId: 'pool',
      userPoolClientId: 'client',
      oauth: {
        domain: 'login.example',
        redirectSignIn: 'https://d1.cloudfront.net/login',
        redirectSignOut: 'https://d1.cloudfront.net/login',
        oktaProviderName: 'Okta',
      },
    });
  });
});

describe('buildWebClientSettings', () => {
  it('トークン期限(アクセス1h/ID1h/リフレッシュ12h)・シークレットなし・SRP', () => {
    expect(buildWebClientSettings('web')).toEqual({
      ClientName: 'web',
      ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      AccessTokenValidity: 1,
      IdTokenValidity: 1,
      RefreshTokenValidity: 12,
      TokenValidityUnits: { AccessToken: 'hours', IdToken: 'hours', RefreshToken: 'hours' },
      PreventUserExistenceErrors: 'ENABLED',
      EnableTokenRevocation: true,
      SupportedIdentityProviders: ['COGNITO'],
    });
  });
  it('Okta ありでは認可コードフローとコールバックを追加', () => {
    expect(buildWebClientSettings('web', { providerName: 'Okta', cloudFrontDomain: 'd1.cloudfront.net' })).toMatchObject({
      ClientName: 'web',
      AccessTokenValidity: 1,
      SupportedIdentityProviders: ['COGNITO', 'Okta'],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthScopes: ['openid', 'email', 'profile', 'aws.cognito.signin.user.admin'],
      CallbackURLs: ['https://d1.cloudfront.net/login'],
      LogoutURLs: ['https://d1.cloudfront.net/login'],
    });
  });
  it('リダイレクト先', () => expect(oauthRedirectUrl('x.net')).toBe('https://x.net/login'));
});
