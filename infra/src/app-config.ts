/**
 * Lambda 環境変数・SPA 用 config.json・Cognito App Client 設定の組み立て。
 * 値は CDK トークンでもよい(文字列として埋め込まれ、デプロイ時に解決される)。
 */

/** apps/api の esbuild 出力 dist/<dir>/index.mjs と対応する。 */
export const HANDLER_DIRS = {
  api: 'api',
  chatReview: 'chat-review',
  recording: 'recording',
  cognito: 'cognito-trigger',
  archiveExpiry: 'archive-expiry',
} as const;
export type HandlerName = keyof typeof HANDLER_DIRS;

export interface ResourceRefs {
  userPoolId: string;
  userPoolClientId: string;
  tableName: string;
  stageProductionArn: string;
  stageSlideArn: string;
  stageBroadcastArn: string;
  chatRoomArn: string;
  contentBucket: string;
  recordingBucket: string;
  storageConfigurationArn: string;
  encoderConfigurationArn: string;
  cloudFrontKeyPairId: string;
  cloudFrontPrivateKeyParameter: string;
}

/**
 * ハンドラごとに必要な変数だけを渡す。
 * chat-review は Chat Room の、cognito は User Pool のトリガーなので、
 * それぞれの ARN/ID を渡すと CloudFormation の循環参照になる(値はイベントから取れる)。
 * AWS_REGION は Lambda の予約変数なので設定しない。
 */
export function buildLambdaEnvironment(handler: HandlerName, refs: ResourceRefs): Record<string, string> {
  const base = { NODE_ENV: 'production', TABLE_NAME: refs.tableName };
  switch (handler) {
    case 'api':
      return {
        ...base,
        USER_POOL_ID: refs.userPoolId,
        USER_POOL_CLIENT_ID: refs.userPoolClientId,
        STAGE_PRODUCTION_ARN: refs.stageProductionArn,
        STAGE_SLIDE_ARN: refs.stageSlideArn,
        STAGE_BROADCAST_ARN: refs.stageBroadcastArn,
        CHAT_ROOM_ARN: refs.chatRoomArn,
        CONTENT_BUCKET: refs.contentBucket,
        RECORDING_BUCKET: refs.recordingBucket,
        RECORDING_STORAGE_CONFIGURATION_ARN: refs.storageConfigurationArn,
        ENCODER_CONFIGURATION_ARN: refs.encoderConfigurationArn,
        CLOUDFRONT_KEY_PAIR_ID: refs.cloudFrontKeyPairId,
        CLOUDFRONT_PRIVATE_KEY_PARAMETER: refs.cloudFrontPrivateKeyParameter,
      };
    case 'recording':
      return {
        ...base,
        RECORDING_BUCKET: refs.recordingBucket,
        CHAT_ROOM_ARN: refs.chatRoomArn,
        STAGE_BROADCAST_ARN: refs.stageBroadcastArn,
      };
    case 'chatReview':
    case 'cognito':
      return base;
    // TTL で消えたアーカイブ行(Stream の OldImage)から録画 prefix を消すだけなのでテーブルは読まない。
    case 'archiveExpiry':
      return { NODE_ENV: base.NODE_ENV, RECORDING_BUCKET: refs.recordingBucket };
  }
}

export interface RuntimeConfigInput {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  cloudFrontDomain: string;
  /** Okta 連携時のみ。Hosted UI のホスト名と IdP 名。 */
  oauth?: { domain: string; providerName: string };
}

/** SPA が起動時に読む /config.json。秘密情報は含めない(apps/web/src/lib/config.ts と同じ形)。 */
export function buildRuntimeConfig(input: RuntimeConfigInput): Record<string, unknown> {
  const config: Record<string, unknown> = {
    region: input.region,
    userPoolId: input.userPoolId,
    userPoolClientId: input.userPoolClientId,
  };
  if (input.oauth) {
    const redirect = oauthRedirectUrl(input.cloudFrontDomain);
    config.oauth = {
      domain: input.oauth.domain,
      redirectSignIn: redirect,
      redirectSignOut: redirect,
      oktaProviderName: input.oauth.providerName,
    };
  }
  return config;
}

export const oauthRedirectUrl = (cloudFrontDomain: string) => `https://${cloudFrontDomain}/login`;

export const TOKEN_VALIDITY = { accessTokenHours: 1, idTokenHours: 1, refreshTokenHours: 12 } as const;
export const OAUTH_SCOPES = ['openid', 'email', 'profile', 'aws.cognito.signin.user.admin'];

/**
 * App Client の設定(CloudFormation と UpdateUserPoolClient API で同じプロパティ名)。
 * oauth を渡すと Okta 用の認可コードフロー(PKCE はパブリッククライアントで SPA 側が付与)を有効にする。
 */
export function buildWebClientSettings(
  clientName: string,
  oauth?: { providerName: string; cloudFrontDomain: string },
): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    ClientName: clientName,
    ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
    AccessTokenValidity: TOKEN_VALIDITY.accessTokenHours,
    IdTokenValidity: TOKEN_VALIDITY.idTokenHours,
    RefreshTokenValidity: TOKEN_VALIDITY.refreshTokenHours,
    TokenValidityUnits: { AccessToken: 'hours', IdToken: 'hours', RefreshToken: 'hours' },
    PreventUserExistenceErrors: 'ENABLED',
    EnableTokenRevocation: true,
    SupportedIdentityProviders: ['COGNITO'],
  };
  if (!oauth) return settings;
  const redirect = oauthRedirectUrl(oauth.cloudFrontDomain);
  return {
    ...settings,
    SupportedIdentityProviders: ['COGNITO', oauth.providerName],
    AllowedOAuthFlowsUserPoolClient: true,
    AllowedOAuthFlows: ['code'],
    AllowedOAuthScopes: OAUTH_SCOPES,
    CallbackURLs: [redirect],
    LogoutURLs: [redirect],
  };
}
