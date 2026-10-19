import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  Annotations,
  Aws,
  CfnOutput,
  CustomResource,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_cloudtrail as cloudtrail,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_events as events,
  aws_events_targets as targets,
  aws_iam as iam,
  aws_ivs as ivs,
  aws_ivschat as ivschat,
  aws_lambda as lambda,
  aws_lambda_event_sources as eventSources,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  custom_resources as cr,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import {
  HANDLER_DIRS,
  type HandlerName,
  type ResourceRefs,
  buildLambdaEnvironment,
  buildRuntimeConfig,
  buildWebClientSettings,
} from '../app-config.ts';
import type { DeliveryConfig } from '../config.ts';
import {
  API_PATH,
  ARCHIVES_PATH,
  ARCHIVES_PREFIX,
  FILES_PATH,
  FILES_PREFIX,
  SLIDES_PATH,
  buildCsp,
  buildSecurityHeaders,
  forwardedHostFunctionCode,
  securityHeadersFunctionCode,
  spaRewriteFunctionCode,
  stripPrefixFunctionCode,
} from '../edge.ts';
import { FAIL_CLOSED_PUBLIC_KEY } from '../keys.ts';

export const LOG_RETENTION = logs.RetentionDays.THREE_MONTHS;
export const ROLE_GROUPS = ['admin', 'camera', 'audio', 'presenter', 'viewer'] as const;
export const OKTA_PROVIDER_NAME = 'Okta';
/** 番組映像(要件 5.1): 720p / 30fps / 約2.5Mbps */
export const ENCODER_VIDEO = { width: 1280, height: 720, framerate: 30, bitrate: 2_500_000 };
/**
 * archive-expiry に渡す Stream レコード(R1-22)。TTL による削除だけを通し、管理者の削除(API が録画も消す)は除く。
 * キー設計に依存しないよう、OldImage に recordingPrefix(String)を持つ行=アーカイブ行で判定する。
 */
export const ARCHIVE_EXPIRY_FILTER = {
  eventName: lambda.FilterRule.isEqual('REMOVE'),
  userIdentity: { type: lambda.FilterRule.isEqual('Service'), principalId: lambda.FilterRule.isEqual('dynamodb.amazonaws.com') },
  dynamodb: { OldImage: { recordingPrefix: { S: lambda.FilterRule.exists() } } },
};

export interface DeliveryStackProps extends StackProps {
  config: DeliveryConfig;
  webAclArn: string;
  /** infra/keys/<env>-cloudfront-public.pem の中身。未指定ならフェイルクローズ鍵。 */
  cloudFrontPublicKeyPem: string | undefined;
  /** apps/api の esbuild 出力ディレクトリ(dist)。 */
  apiDistDir: string;
  /** apps/web のビルド出力ディレクトリ(dist)。 */
  webDistDir: string;
}

export class DeliveryStack extends Stack {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: DeliveryStackProps) {
    super(scope, id, props);
    const { config } = props;
    const removalPolicy = config.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // ---------- S3 ----------
    const secureBucket = (bucketId: string, extra: s3.BucketProps = {}) =>
      new s3.Bucket(this, bucketId, {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        minimumTLSVersion: 1.2,
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        removalPolicy,
        ...extra,
      });

    const logBucket = secureBucket('LogBucket', {
      lifecycleRules: [
        { id: 'access-logs-90d', prefix: 'access-logs/', expiration: Duration.days(90) },
        { id: 'cloudtrail-365d', prefix: 'cloudtrail/', expiration: Duration.days(365) },
      ],
    });
    const accessLogs = (name: string) => ({ serverAccessLogsBucket: logBucket, serverAccessLogsPrefix: `access-logs/${name}/` });

    const webBucket = secureBucket('WebBucket', accessLogs('web'));
    // slides/・comment-exports/ はアプリ、AWSLogs/ は IVS Chat のログ(出力先プレフィックスは指定不可)。
    const contentBucket = secureBucket('ContentBucket', {
      ...accessLogs('content'),
      lifecycleRules: [{ id: 'chat-logs-365d', prefix: 'AWSLogs/', expiration: Duration.days(365) }],
    });
    // IVS コンポジット録画は <stageId>/<sessionId>/... 固定のキーで書くため専用バケットにする。
    const recordingBucket = secureBucket('RecordingBucket', {
      ...accessLogs('recording'),
      // 期限での一律削除はしない(管理者が延長できるため)。削除は Archive.retainUntil → TTL → archive-expiry で行う。
      lifecycleRules: [
        {
          id: 'archives-intelligent-tiering',
          transitions: [{ storageClass: s3.StorageClass.INTELLIGENT_TIERING, transitionAfter: Duration.days(0) }],
        },
      ],
    });

    // IVS は StorageConfiguration / LoggingConfiguration 作成時にバケットポリシーへ書き込む。
    // CloudFormation の更新で消えないよう、同じ許可をテンプレート側にも持たせる。
    recordingBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'IvsCompositeWrite',
        principals: [new iam.ServicePrincipal(`ivs-composite.${this.region}.amazonaws.com`)],
        actions: ['s3:PutObject', 's3:PutObjectAcl'],
        resources: [recordingBucket.arnForObjects('*')],
        conditions: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control' }, Bool: { 'aws:SecureTransport': 'true' } },
      }),
    );
    const logDelivery = new iam.ServicePrincipal('delivery.logs.amazonaws.com');
    contentBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'IvsChatLogDeliveryWrite',
        principals: [logDelivery],
        actions: ['s3:PutObject'],
        resources: [contentBucket.arnForObjects(`AWSLogs/${this.account}/*`)],
        conditions: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control', 'aws:SourceAccount': this.account } },
      }),
    );
    contentBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'IvsChatLogDeliveryAclCheck',
        principals: [logDelivery],
        actions: ['s3:GetBucketAcl'],
        resources: [contentBucket.bucketArn],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );

    // ---------- DynamoDB ----------
    const table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      encryption: dynamodb.TableEncryptionV2.awsManagedKey(),
      timeToLiveAttribute: 'ttl',
      // TTL で消えたアーカイブ行の recordingPrefix を archive-expiry が読むため削除前の値だけ流す。
      dynamoStream: dynamodb.StreamViewType.OLD_IMAGE,
      removalPolicy,
      deletionProtection: config.retainData,
    });

    // ---------- Lambda ----------
    const makeFunction = (name: HandlerName, memorySize: number, timeout: Duration) => {
      const dir = path.join(props.apiDistDir, HANDLER_DIRS[name]);
      const built = existsSync(path.join(dir, 'index.mjs'));
      if (!built) {
        Annotations.of(this).addWarningV2(
          `delivery:api-not-built:${name}`,
          `${dir}/index.mjs がありません。スタブをデプロイしないよう、先に pnpm --filter api build を実行してください。`,
        );
      }
      const fn = new lambda.Function(this, `${name[0]!.toUpperCase()}${name.slice(1)}Function`, {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        code: built
          ? lambda.Code.fromAsset(dir)
          : lambda.Code.fromInline("exports.handler = async () => { throw new Error('apps/api is not built'); };"),
        memorySize,
        timeout,
        logGroup: new logs.LogGroup(this, `${name[0]!.toUpperCase()}${name.slice(1)}Logs`, {
          retention: LOG_RETENTION,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      });
      return fn;
    };
    const apiFn = makeFunction('api', 512, Duration.seconds(29));
    const chatReviewFn = makeFunction('chatReview', 256, Duration.seconds(3));
    const recordingFn = makeFunction('recording', 256, Duration.seconds(30));
    const cognitoFn = makeFunction('cognito', 256, Duration.seconds(5));
    const archiveExpiryFn = makeFunction('archiveExpiry', 256, Duration.seconds(60));

    // ---------- Cognito ----------
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${config.prefix}-users`,
      featurePlan: cognito.FeaturePlan.LITE,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
        tempPasswordValidity: Duration.days(7),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      email: config.sesFromEmail
        ? cognito.UserPoolEmail.withSES({ fromEmail: config.sesFromEmail, sesRegion: this.region })
        : cognito.UserPoolEmail.withCognito(),
      userInvitation: {
        emailSubject: 'ライブ配信への招待',
        emailBody:
          'ライブ配信に招待されました。<br>ユーザー名: {username}<br>仮パスワード: {####}<br>初回ログイン時にパスワードを変更してください。',
      },
      lambdaTriggers: { postAuthentication: cognitoFn, postConfirmation: cognitoFn },
      deletionProtection: config.retainData,
      removalPolicy,
    });
    ROLE_GROUPS.forEach((groupName, precedence) => {
      new cognito.UserPoolGroup(this, `Group-${groupName}`, { userPool, groupName, precedence });
    });
    const domainPrefix = config.cognitoDomainPrefix ?? `${config.prefix}-${Aws.ACCOUNT_ID}`;
    userPool.addDomain('HostedUiDomain', { cognitoDomain: { domainPrefix } });
    const cognitoDomain = `${domainPrefix}.auth.${this.region}.amazoncognito.com`;

    // App Client は CloudFormation と UpdateUserPoolClient で同じ設定を使う(buildWebClientSettings)。
    const clientName = `${config.prefix}-web`;
    const webClient = new cognito.CfnUserPoolClient(this, 'WebClient', { userPoolId: userPool.userPoolId });
    for (const [key, value] of Object.entries(buildWebClientSettings(clientName))) {
      webClient.addPropertyOverride(key, value);
    }

    // トリガーは User Pool ARN を参照すると循環するため、関数に依存されない別ポリシーで付与する。
    new iam.Policy(this, 'CognitoTriggerPolicy', {
      roles: [cognitoFn.role!],
      statements: [
        new iam.PolicyStatement({
          actions: ['cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminListGroupsForUser'],
          resources: [userPool.userPoolArn],
        }),
      ],
    });

    // ---------- IVS Real-Time ----------
    const stage = (name: string) => new ivs.CfnStage(this, `Stage-${name}`, { name: `${config.prefix}-${name}` });
    const productionStage = stage('production');
    const slideStage = stage('slide');
    const broadcastStage = stage('broadcast');
    const encoder = new ivs.CfnEncoderConfiguration(this, 'EncoderConfiguration', {
      name: `${config.prefix}-program-720p30`,
      video: ENCODER_VIDEO,
    });
    const storage = new ivs.CfnStorageConfiguration(this, 'StorageConfiguration', {
      name: `${config.prefix}-recording`,
      s3: { bucketName: recordingBucket.bucketName },
    });

    // ---------- IVS Chat ----------
    const chatLogging = new ivschat.CfnLoggingConfiguration(this, 'ChatLogging', {
      name: `${config.prefix}-chat-logs`,
      destinationConfiguration: { s3: { bucketName: contentBucket.bucketName } },
    });
    const chatReviewPermission = new lambda.CfnPermission(this, 'ChatReviewInvokePermission', {
      action: 'lambda:InvokeFunction',
      functionName: chatReviewFn.functionArn,
      principal: 'ivschat.amazonaws.com',
      sourceAccount: this.account,
      sourceArn: `arn:${this.partition}:ivschat:${this.region}:${this.account}:room/*`,
    });
    const chatRoom = new ivschat.CfnRoom(this, 'ChatRoom', {
      name: `${config.prefix}-room`,
      maximumMessageLength: 200,
      messageReviewHandler: { uri: chatReviewFn.functionArn, fallbackResult: 'DENY' },
      loggingConfigurationIdentifiers: [chatLogging.attrArn],
    });
    chatRoom.node.addDependency(chatReviewPermission);

    // ---------- CloudFront 署名鍵 ----------
    if (!props.cloudFrontPublicKeyPem) {
      Annotations.of(this).addWarningV2(
        'delivery:cloudfront-key-missing',
        'CloudFront 公開鍵が未登録のためフェイルクローズ鍵を使います(/files/* は閲覧不可)。scripts/cloudfront-keypair.sh を実行してください。',
      );
    }
    const publicKey = new cloudfront.PublicKey(this, 'FilesPublicKey', {
      encodedKey: props.cloudFrontPublicKeyPem ?? FAIL_CLOSED_PUBLIC_KEY,
      comment: `${config.prefix} signed cookies for /files/*`,
    });
    const keyGroup = new cloudfront.KeyGroup(this, 'FilesKeyGroup', { items: [publicKey] });

    // ---------- Lambda 環境変数と権限 ----------
    const refs: ResourceRefs = {
      userPoolId: userPool.userPoolId,
      userPoolClientId: webClient.ref,
      tableName: table.tableName,
      stageProductionArn: productionStage.attrArn,
      stageSlideArn: slideStage.attrArn,
      stageBroadcastArn: broadcastStage.attrArn,
      chatRoomArn: chatRoom.attrArn,
      contentBucket: contentBucket.bucketName,
      recordingBucket: recordingBucket.bucketName,
      storageConfigurationArn: storage.attrArn,
      encoderConfigurationArn: encoder.attrArn,
      cloudFrontKeyPairId: publicKey.publicKeyId,
      cloudFrontPrivateKeyParameter: config.cloudFrontPrivateKeyParameter,
    };
    const functions: Record<HandlerName, lambda.Function> = {
      api: apiFn,
      chatReview: chatReviewFn,
      recording: recordingFn,
      cognito: cognitoFn,
      archiveExpiry: archiveExpiryFn,
    };
    for (const [name, fn] of Object.entries(functions) as [HandlerName, lambda.Function][]) {
      for (const [key, value] of Object.entries(buildLambdaEnvironment(name, refs))) fn.addEnvironment(key, value);
    }

    const stageArns = [productionStage.attrArn, slideStage.attrArn, broadcastStage.attrArn];
    const compositionArn = `arn:${this.partition}:ivs:${this.region}:${this.account}:composition/*`;
    table.grantReadWriteData(apiFn);
    table.grantReadWriteData(chatReviewFn);
    table.grantReadWriteData(recordingFn);
    table.grantWriteData(cognitoFn);
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminUserGlobalSignOut',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminRemoveUserFromGroup',
          'cognito-idp:AdminListGroupsForUser',
          'cognito-idp:ListUsers',
          'cognito-idp:ListUsersInGroup',
        ],
        resources: [userPool.userPoolArn],
      }),
    );
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        // ListStageSessions は /api/status(R1-06)、DisconnectParticipant は失効した端末枠の切断(R1-07)。
        actions: [
          'ivs:CreateParticipantToken',
          'ivs:GetStage',
          'ivs:ListStageSessions',
          'ivs:ListParticipants',
          'ivs:DisconnectParticipant',
        ],
        resources: stageArns,
      }),
    );
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ivs:StartComposition'],
        resources: [broadcastStage.attrArn, encoder.attrArn, storage.attrArn, compositionArn],
      }),
    );
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ivs:StopComposition', 'ivs:GetComposition'], resources: [compositionArn] }),
    );
    apiFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ivs:ListCompositions'], resources: ['*'] }));
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ivschat:CreateChatToken', 'ivschat:SendEvent', 'ivschat:DeleteMessage', 'ivschat:DisconnectUser', 'ivschat:GetRoom'],
        resources: [chatRoom.attrArn],
      }),
    );
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
        resources: [contentBucket.arnForObjects('slides/*'), contentBucket.arnForObjects('comment-exports/*')],
      }),
    );
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['s3:GetObject', 's3:DeleteObject'], resources: [recordingBucket.arnForObjects('*')] }),
    );
    apiFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [recordingBucket.bucketArn] }));
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${config.cloudFrontPrivateKeyParameter}`],
      }),
    );
    recordingFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [recordingBucket.arnForObjects('*')] }),
    );
    recordingFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ivschat:SendEvent'], resources: [chatRoom.attrArn] }));
    // recordingPrefix が保存されていないときに GetComposition で補完する(R1-21)。
    recordingFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ivs:GetComposition'], resources: [compositionArn] }));

    // 期限切れアーカイブの録画 prefix を消す(R1-22)。Stream の読み取り権限はイベントソースが付与する。
    archiveExpiryFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [recordingBucket.bucketArn] }));
    archiveExpiryFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['s3:DeleteObject'], resources: [recordingBucket.arnForObjects('*')] }),
    );
    archiveExpiryFn.addEventSource(
      new eventSources.DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        filters: [lambda.FilterCriteria.filter(ARCHIVE_EXPIRY_FILTER)],
        batchSize: 10,
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        retryAttempts: 5,
      }),
    );

    new events.Rule(this, 'CompositionStateChange', {
      eventPattern: { source: ['aws.ivs'], detailType: ['IVS Composition State Change'] },
      targets: [new targets.LambdaFunction(recordingFn)],
    });

    // ---------- CloudFront ----------
    const apiUrl = apiFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    const cfFunction = (fnId: string, code: string) =>
      new cloudfront.Function(this, fnId, {
        code: cloudfront.FunctionCode.fromInline(code),
        runtime: cloudfront.FunctionRuntime.JS_2_0,
      });
    const cspInput = { region: this.region, cognitoDomain, uploadHost: contentBucket.bucketRegionalDomainName };
    const headersFn = cfFunction('SecurityHeadersFunction', securityHeadersFunctionCode(buildSecurityHeaders(buildCsp(cspInput))));
    const slideHeadersFn = cfFunction(
      'SlideSecurityHeadersFunction',
      securityHeadersFunctionCode(buildSecurityHeaders(buildCsp(cspInput, 'sameorigin'), 'sameorigin')),
    );
    const viewerResponseOf = (fn: cloudfront.Function) => ({ function: fn, eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE });
    const viewerResponse = viewerResponseOf(headersFn);
    const viewerRequest = (fn: cloudfront.Function) => ({ function: fn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST });
    const signedFiles = (origin: cloudfront.IOrigin, stripFn: cloudfront.Function, responseFn = headersFn): cloudfront.BehaviorOptions => ({
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      trustedKeyGroups: [keyGroup],
      functionAssociations: [viewerRequest(stripFn), viewerResponseOf(responseFn)],
    });
    // /files/slides/* と /files/* は同じオリジン(OAC 1つ)と書き換え関数を共有し、応答ヘッダーだけ変える。
    const contentOrigin = origins.S3BucketOrigin.withOriginAccessControl(contentBucket);
    const stripFilesFn = cfFunction('StripFilesPrefixFunction', stripPrefixFunctionCode(FILES_PREFIX));

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${config.prefix} delivery`,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      webAclId: props.webAclArn,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [viewerRequest(cfFunction('SpaRewriteFunction', spaRewriteFunctionCode())), viewerResponse],
      },
      additionalBehaviors: {
        [API_PATH]: {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(apiUrl),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // X-Auth-Token と x-amz-content-sha256 を含む全ヘッダーを転送(Host は OAC 署名のため除外)。
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          functionAssociations: [viewerRequest(cfFunction('ForwardedHostFunction', forwardedHostFunctionCode())), viewerResponse],
        },
        // /files/* より先に評価させるため先に定義する。
        [ARCHIVES_PATH]: signedFiles(origins.S3BucketOrigin.withOriginAccessControl(recordingBucket), cfFunction('StripArchivesPrefixFunction', stripPrefixFunctionCode(ARCHIVES_PREFIX))),
        [SLIDES_PATH]: signedFiles(contentOrigin, stripFilesFn, slideHeadersFn),
        [FILES_PATH]: signedFiles(contentOrigin, stripFilesFn),
      },
    });
    const cloudFrontDomain = this.distribution.distributionDomainName;

    // presigned POST 用 CORS。Bucket→Distribution と循環するため作成後に API で設定する。
    new cr.AwsCustomResource(this, 'ContentBucketCors', {
      onUpdate: {
        service: 'S3',
        action: 'putBucketCors',
        parameters: {
          Bucket: contentBucket.bucketName,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: [`https://${cloudFrontDomain}`],
                AllowedMethods: ['POST'],
                AllowedHeaders: ['*'],
                ExposeHeaders: ['ETag'],
                MaxAgeSeconds: 3000,
              },
            ],
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${config.prefix}-content-cors`),
      },
      onDelete: { service: 'S3', action: 'deleteBucketCors', parameters: { Bucket: contentBucket.bucketName } },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({ actions: ['s3:PutBucketCORS'], resources: [contentBucket.bucketArn] }),
      ]),
      logGroup: new logs.LogGroup(this, 'ContentBucketCorsLogs', { retention: LOG_RETENTION, removalPolicy: RemovalPolicy.DESTROY }),
      installLatestAwsSdk: false,
    });

    // ---------- Okta(任意) ----------
    if (config.okta) {
      const oktaFn = new lambda.Function(this, 'OktaIdpFunction', {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(path.join(import.meta.dirname, '..', 'okta-idp')),
        timeout: Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'OktaIdpLogs', { retention: LOG_RETENTION, removalPolicy: RemovalPolicy.DESTROY }),
      });
      oktaFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${config.okta.clientSecretParameter}`],
        }),
      );
      oktaFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['cognito-idp:CreateIdentityProvider', 'cognito-idp:UpdateIdentityProvider', 'cognito-idp:DeleteIdentityProvider'],
          resources: [userPool.userPoolArn],
        }),
      );
      const provider = new cr.Provider(this, 'OktaIdpProvider', {
        onEventHandler: oktaFn,
        logGroup: new logs.LogGroup(this, 'OktaIdpProviderLogs', { retention: LOG_RETENTION, removalPolicy: RemovalPolicy.DESTROY }),
      });
      const oktaIdp = new CustomResource(this, 'OktaIdp', {
        serviceToken: provider.serviceToken,
        properties: {
          UserPoolId: userPool.userPoolId,
          ProviderName: OKTA_PROVIDER_NAME,
          Issuer: config.okta.issuer,
          ClientId: config.okta.clientId,
          ClientSecretParameter: config.okta.clientSecretParameter,
          AttributeMapping: { email: 'email' },
        },
      });

      // コールバックURL(CloudFront ドメイン)を App Client に入れると API Lambda と循環するため、作成後に更新する。
      const oauthSettings = buildWebClientSettings(clientName, { providerName: OKTA_PROVIDER_NAME, cloudFrontDomain });
      const clientOauth = new cr.AwsCustomResource(this, 'WebClientOAuth', {
        onUpdate: {
          service: 'CognitoIdentityServiceProvider',
          action: 'updateUserPoolClient',
          parameters: { UserPoolId: userPool.userPoolId, ClientId: webClient.ref, ...oauthSettings },
          physicalResourceId: cr.PhysicalResourceId.of(`${config.prefix}-web-client-oauth`),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({ actions: ['cognito-idp:UpdateUserPoolClient'], resources: [userPool.userPoolArn] }),
        ]),
        logGroup: new logs.LogGroup(this, 'WebClientOAuthLogs', { retention: LOG_RETENTION, removalPolicy: RemovalPolicy.DESTROY }),
        installLatestAwsSdk: false,
      });
      clientOauth.node.addDependency(oktaIdp);
    }

    // ---------- SPA デプロイ ----------
    const runtimeConfig = buildRuntimeConfig({
      region: this.region,
      userPoolId: userPool.userPoolId,
      userPoolClientId: webClient.ref,
      cloudFrontDomain,
      ...(config.okta ? { oauth: { domain: cognitoDomain, providerName: OKTA_PROVIDER_NAME } } : {}),
    });
    const webBuilt = existsSync(path.join(props.webDistDir, 'index.html'));
    if (!webBuilt) {
      Annotations.of(this).addWarningV2(
        'delivery:web-not-built',
        `${props.webDistDir}/index.html がありません。config.json のみ配置します。先に pnpm --filter web build を実行してください。`,
      );
    }
    const deploymentLogs = new logs.LogGroup(this, 'WebDeploymentLogs', { retention: LOG_RETENTION, removalPolicy: RemovalPolicy.DESTROY });
    if (webBuilt) {
      // ハッシュ付きアセットは長期キャッシュ。index.html と config.json は除外(prune 対象外になる)。
      new s3deploy.BucketDeployment(this, 'WebAssets', {
        sources: [s3deploy.Source.asset(props.webDistDir, { exclude: ['index.html', 'config.json'] })],
        destinationBucket: webBucket,
        exclude: ['index.html', 'config.json'],
        cacheControl: [s3deploy.CacheControl.fromString('public, max-age=31536000, immutable')],
        logGroup: deploymentLogs,
      });
    }
    new s3deploy.BucketDeployment(this, 'WebEntry', {
      sources: [
        s3deploy.Source.jsonData('config.json', runtimeConfig),
        ...(webBuilt ? [s3deploy.Source.asset(props.webDistDir, { exclude: ['*', '!index.html'] })] : []),
      ],
      destinationBucket: webBucket,
      prune: false,
      cacheControl: [s3deploy.CacheControl.noCache()],
      distribution: this.distribution,
      distributionPaths: ['/index.html', '/config.json'],
      logGroup: deploymentLogs,
    });

    // ---------- CloudTrail ----------
    if (config.createTrail) {
      new cloudtrail.Trail(this, 'Trail', {
        bucket: logBucket,
        s3KeyPrefix: 'cloudtrail',
        isMultiRegionTrail: true,
        includeGlobalServiceEvents: true,
        enableFileValidation: true,
        sendToCloudWatchLogs: false,
      });
    }

    // ---------- Outputs ----------
    const outputs: Record<string, string> = {
      CloudFrontDomain: cloudFrontDomain,
      DistributionId: this.distribution.distributionId,
      UserPoolId: userPool.userPoolId,
      UserPoolClientId: webClient.ref,
      CognitoDomain: cognitoDomain,
      TableName: table.tableName,
      WebBucket: webBucket.bucketName,
      ContentBucket: contentBucket.bucketName,
      RecordingBucket: recordingBucket.bucketName,
      ChatRoomArn: chatRoom.attrArn,
      StageProductionArn: productionStage.attrArn,
      StageSlideArn: slideStage.attrArn,
      StageBroadcastArn: broadcastStage.attrArn,
      CloudFrontKeyPairId: publicKey.publicKeyId,
      CloudFrontPrivateKeyParameter: config.cloudFrontPrivateKeyParameter,
    };
    for (const [key, value] of Object.entries(outputs)) {
      new CfnOutput(this, `${key}Output`, { value }).overrideLogicalId(key);
    }
  }
}
