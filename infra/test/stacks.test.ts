import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { INFRA_ROOT, buildApp } from '../src/app.ts';
import { FAIL_CLOSED_PUBLIC_KEY } from '../src/keys.ts';

const MANAGED = {
  cachingDisabled: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
  cachingOptimized: '658327ea-f89d-4fab-a63d-7e88639e58f6',
  allViewerExceptHostHeader: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
};
/** cdk.json の feature flag をテストにも適用する。 */
const CDK_CONTEXT = (JSON.parse(readFileSync(path.join(INFRA_ROOT, 'cdk.json'), 'utf8')) as { context: Record<string, unknown> }).context;
const OUR_FUNCTIONS = ['ApiFunction', 'ChatReviewFunction', 'RecordingFunction', 'CognitoFunction', 'ArchiveExpiryFunction'];

function fixtures() {
  const root = mkdtempSync(path.join(tmpdir(), 'infra-test-'));
  const api = path.join(root, 'api');
  for (const dir of ['index', 'chat-review', 'recording', 'cognito', 'archive-expiry']) {
    mkdirSync(path.join(api, dir), { recursive: true });
    writeFileSync(path.join(api, dir, 'index.mjs'), 'export const handler = async () => ({});\n');
  }
  const web = path.join(root, 'web');
  mkdirSync(path.join(web, 'assets'), { recursive: true });
  writeFileSync(path.join(web, 'index.html'), '<!doctype html>');
  writeFileSync(path.join(web, 'assets', 'app.js'), '');
  return { api, web, empty: path.join(root, 'missing') };
}

function synth(context: Record<string, string>, options: { built?: boolean; key?: boolean } = {}) {
  const dirs = fixtures();
  const app = new App({ context: { ...CDK_CONTEXT, env: 'stg', account: '123456789012', ...context } });
  const built = options.built ?? true;
  const stacks = buildApp(app, {
    env: {},
    apiDistDir: built ? dirs.api : dirs.empty,
    webDistDir: built ? dirs.web : dirs.empty,
    ...(options.key === false ? {} : { publicKeyPem: FAIL_CLOSED_PUBLIC_KEY }),
  });
  return {
    stacks,
    main: Template.fromStack(stacks.main),
    waf: Template.fromStack(stacks.waf),
    mainStack: stacks.main,
  };
}

const resourcesOf = (template: Template, type: string) => Object.entries(template.findResources(type));

describe('stg(既定)', () => {
  let t: ReturnType<typeof synth>;
  beforeAll(() => {
    t = synth({});
  });

  describe('Cognito', () => {
    it('自己サインアップ不可・パスワード12文字以上(大小英字・数字)', () => {
      t.main.hasResourceProperties('AWS::Cognito::UserPool', {
        AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
        Policies: {
          PasswordPolicy: Match.objectLike({
            MinimumLength: 12,
            RequireLowercase: true,
            RequireUppercase: true,
            RequireNumbers: true,
            RequireSymbols: false,
          }),
        },
        UserPoolTier: 'LITE',
        EmailConfiguration: { EmailSendingAccount: 'COGNITO_DEFAULT' },
      });
    });
    it('Okta 初回(PostConfirmation)と毎回(PostAuthentication)に同じトリガー', () => {
      const [[, pool]] = resourcesOf(t.main, 'AWS::Cognito::UserPool') as [[string, { Properties: { LambdaConfig: Record<string, unknown> } }]];
      const trigger = { 'Fn::GetAtt': [Match.stringLikeRegexp('^CognitoFunction'), 'Arn'] };
      expect(pool.Properties.LambdaConfig).toEqual({
        PostAuthentication: expect.anything(),
        PostConfirmation: expect.anything(),
      });
      t.main.hasResourceProperties('AWS::Cognito::UserPool', { LambdaConfig: { PostAuthentication: trigger, PostConfirmation: trigger } });
    });
    it('グループ5つ', () => {
      const names = resourcesOf(t.main, 'AWS::Cognito::UserPoolGroup').map(([, r]) => (r as { Properties: { GroupName: string } }).Properties.GroupName);
      expect(names.sort()).toEqual(['admin', 'audio', 'camera', 'presenter', 'viewer']);
    });
    it('App Client: シークレットなし・トークン1h/1h/12h・OAuth 無効(Okta 未設定)', () => {
      t.main.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        AccessTokenValidity: 1,
        IdTokenValidity: 1,
        RefreshTokenValidity: 12,
        TokenValidityUnits: { AccessToken: 'hours', IdToken: 'hours', RefreshToken: 'hours' },
        GenerateSecret: Match.absent(),
        AllowedOAuthFlows: Match.absent(),
        SupportedIdentityProviders: ['COGNITO'],
      });
      t.main.resourceCountIs('Custom::AWS', 1); // CORS のみ。OAuth 更新は作らない
    });
    it('Hosted UI のプレフィックスドメイン', () => {
      t.main.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
        Domain: { 'Fn::Join': ['', ['delivery-stg-', { Ref: 'AWS::AccountId' }]] },
      });
    });
  });

  describe('DynamoDB', () => {
    it('PK/SK・オンデマンド・TTL=ttl・AWS 管理キー', () => {
      t.main.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
        TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
        SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
        GlobalSecondaryIndexes: Match.absent(),
        StreamSpecification: { StreamViewType: 'OLD_IMAGE' },
      });
    });
    it('Stream は TTL で消えたアーカイブ行だけを archive-expiry に渡す', () => {
      t.main.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
      const [[, mapping]] = resourcesOf(t.main, 'AWS::Lambda::EventSourceMapping') as [
        [string, { Properties: { FunctionName: unknown; FilterCriteria: { Filters: { Pattern: string }[] } } & Record<string, unknown> }],
      ];
      expect(mapping.Properties.FunctionName).toEqual({ Ref: expect.stringMatching(/^ArchiveExpiryFunction/) });
      expect(mapping.Properties).toMatchObject({
        StartingPosition: 'TRIM_HORIZON',
        BisectBatchOnFunctionError: true,
        FunctionResponseTypes: ['ReportBatchItemFailures'],
        MaximumRetryAttempts: 5,
      });
      expect(mapping.Properties.FilterCriteria.Filters.map((f) => JSON.parse(f.Pattern))).toEqual([
        {
          eventName: ['REMOVE'],
          userIdentity: { type: ['Service'], principalId: ['dynamodb.amazonaws.com'] },
          dynamodb: { OldImage: { recordingPrefix: { S: [{ exists: true }] } } },
        },
      ]);
    });
  });

  describe('S3', () => {
    it('全バケットでパブリックブロック・SSE-S3', () => {
      const buckets = resourcesOf(t.main, 'AWS::S3::Bucket');
      expect(buckets).toHaveLength(4);
      for (const [, bucket] of buckets as [string, { Properties: Record<string, unknown> }][]) {
        expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        });
        expect(bucket.Properties.BucketEncryption).toEqual({
          ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
        });
      }
    });
    it('全バケットポリシーで TLS(1.2以上)を強制', () => {
      const policies = resourcesOf(t.main, 'AWS::S3::BucketPolicy');
      expect(policies).toHaveLength(4);
      for (const [, policy] of policies as [string, { Properties: { PolicyDocument: { Statement: unknown[] } } }][]) {
        expect(policy.Properties.PolicyDocument.Statement).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
            expect.objectContaining({ Effect: 'Deny', Condition: { NumericLessThan: { 's3:TlsVersion': 1.2 } } }),
          ]),
        );
      }
    });
    it('ライフサイクル: 録画は Intelligent-Tiering のみ(期限削除なし)、チャットログ365日、アクセスログ90日、CloudTrail365日', () => {
      t.main.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: {
          Rules: [
            { Id: 'archives-intelligent-tiering', Status: 'Enabled', Transitions: [{ StorageClass: 'INTELLIGENT_TIERING', TransitionInDays: 0 }] },
          ],
        },
      });
      t.main.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: { Rules: [Match.objectLike({ Prefix: 'AWSLogs/', ExpirationInDays: 365 })] },
      });
      t.main.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: {
          Rules: [
            Match.objectLike({ Prefix: 'access-logs/', ExpirationInDays: 90 }),
            Match.objectLike({ Prefix: 'cloudtrail/', ExpirationInDays: 365 }),
          ],
        },
      });
    });
    it('content バケットの CORS は CloudFront ドメインのみ(作成後に設定)', () => {
      const [[, cors]] = resourcesOf(t.main, 'Custom::AWS') as [[string, { Properties: { Create: unknown } }]];
      const create = JSON.stringify(t.mainStack.resolve(cors.Properties.Create));
      expect(create).toContain('putBucketCors');
      expect(create).toContain('"AllowedMethods\\":[\\"POST\\"]');
      expect(create).toContain('https://');
      expect(create).toContain('DomainName');
      expect(create).not.toContain('\\"*\\"]'.replace('*', '*.cloudfront.net'));
      t.main.hasResourceProperties('AWS::S3::Bucket', { CorsConfiguration: Match.absent() });
    });
    it('IVS がバケットポリシーに追加する許可をテンプレートにも持つ', () => {
      t.main.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({ Sid: 'IvsCompositeWrite', Principal: { Service: 'ivs-composite.ap-northeast-1.amazonaws.com' } }),
          ]),
        },
      });
      t.main.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([Match.objectLike({ Sid: 'IvsChatLogDeliveryWrite', Principal: { Service: 'delivery.logs.amazonaws.com' } })]),
        },
      });
    });
  });

  describe('IVS', () => {
    it('ステージ3つ', () => {
      const names = resourcesOf(t.main, 'AWS::IVS::Stage').map(([, r]) => (r as { Properties: { Name: string } }).Properties.Name);
      expect(names.sort()).toEqual(['delivery-stg-broadcast', 'delivery-stg-production', 'delivery-stg-slide']);
    });
    it('エンコーダー 720p30 約2.5Mbps と録画先', () => {
      t.main.hasResourceProperties('AWS::IVS::EncoderConfiguration', {
        Video: { Width: 1280, Height: 720, Framerate: 30, Bitrate: 2_500_000 },
      });
      t.main.hasResourceProperties('AWS::IVS::StorageConfiguration', {
        S3: { BucketName: { Ref: Match.stringLikeRegexp('^RecordingBucket') } },
      });
    });
    it('Chat ルーム: 審査 Lambda(失敗時 DENY)・S3 ログ', () => {
      t.main.hasResourceProperties('AWS::IVSChat::Room', {
        MaximumMessageLength: 200,
        MessageReviewHandler: { FallbackResult: 'DENY', Uri: { 'Fn::GetAtt': [Match.stringLikeRegexp('^ChatReviewFunction'), 'Arn'] } },
        LoggingConfigurationIdentifiers: [{ 'Fn::GetAtt': [Match.stringLikeRegexp('^ChatLogging'), 'Arn'] }],
      });
      t.main.hasResourceProperties('AWS::IVSChat::LoggingConfiguration', {
        DestinationConfiguration: { S3: { BucketName: { Ref: Match.stringLikeRegexp('^ContentBucket') } } },
      });
      t.main.hasResourceProperties('AWS::Lambda::Permission', { Principal: 'ivschat.amazonaws.com', Action: 'lambda:InvokeFunction' });
    });
    it('EventBridge: IVS Composition State Change → recording', () => {
      t.main.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: { source: ['aws.ivs'], 'detail-type': ['IVS Composition State Change'] },
        Targets: [Match.objectLike({ Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^RecordingFunction'), 'Arn'] } })],
      });
    });
  });

  describe('Lambda', () => {
    const ours = () =>
      resourcesOf(t.main, 'AWS::Lambda::Function').filter(([id]) => OUR_FUNCTIONS.some((name) => id.startsWith(name))) as [
        string,
        { Properties: Record<string, unknown> },
      ][];
    it('nodejs22.x / arm64 / ビルド済みコード', () => {
      expect(ours()).toHaveLength(5);
      for (const [, fn] of ours()) {
        expect(fn.Properties).toMatchObject({ Runtime: 'nodejs22.x', Architectures: ['arm64'], Handler: 'index.handler' });
        expect(fn.Properties.Code).toHaveProperty('S3Key');
      }
    });
    it('関数URLは AWS_IAM', () => {
      t.main.resourceCountIs('AWS::Lambda::Url', 1);
      t.main.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
    });
    it('ログ保持は全て90日', () => {
      const groups = resourcesOf(t.main, 'AWS::Logs::LogGroup');
      expect(groups.length).toBeGreaterThanOrEqual(4);
      for (const [, group] of groups as [string, { Properties: { RetentionInDays: number } }][]) {
        expect(group.Properties.RetentionInDays).toBe(90);
      }
    });
    it('chat-review はルーム ARN、cognito は User Pool ID を環境変数に持たない', () => {
      const env = (prefix: string) =>
        (ours().find(([id]) => id.startsWith(prefix))![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
      expect(Object.keys(env('ChatReviewFunction')).sort()).toEqual(['NODE_ENV', 'TABLE_NAME']);
      expect(Object.keys(env('CognitoFunction')).sort()).toEqual(['NODE_ENV', 'TABLE_NAME']);
      expect(env('ApiFunction')).toMatchObject({ CLOUDFRONT_PRIVATE_KEY_PARAMETER: '/delivery-stg/cloudfront/private-key' });
      expect(env('ApiFunction')).not.toHaveProperty('CLOUDFRONT_DOMAIN');
      expect(env('ApiFunction')).not.toHaveProperty('CLOUDFRONT_KEY_GROUP_ID');
      expect(Object.keys(env('ArchiveExpiryFunction')).sort()).toEqual(['NODE_ENV', 'RECORDING_BUCKET']);
    });
  });

  describe('IAM 最小権限', () => {
    const statements = () =>
      resourcesOf(t.main, 'AWS::IAM::Policy').flatMap(
        ([id, p]) =>
          (p as { Properties: { PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] } } }).Properties.PolicyDocument.Statement.map(
            (s) => ({ id, ...s }),
          ),
      );
    it('Action "*" や "サービス:*" を使わない', () => {
      for (const s of statements()) {
        for (const action of [s.Action].flat()) expect(action).not.toMatch(/(^\*$|:\*$)/);
      }
    });
    it('Resource "*" は ivs:ListCompositions と CDK 内部のみ', () => {
      const wildcard = statements().filter((s) => s.Resource === '*');
      for (const s of wildcard) {
        if (s.id.startsWith('ApiFunction')) expect(s.Action).toBe('ivs:ListCompositions');
        else expect(s.id).toMatch(/^(AWS|Custom|CustomCDKBucketDeployment)/);
      }
    });
    const policyOf = (prefix: string) =>
      statements()
        .filter((s) => s.id.startsWith(prefix))
        .map((s) => ({ Effect: (s as { Effect?: string }).Effect, Action: s.Action, Resource: s.Resource }));
    it('api: /api/status に必要な IVS/IVS Chat の読み取りと端末切断をステージ/ルームに限定', () => {
      const stages = [0, 1, 2].map(() => ({ 'Fn::GetAtt': [expect.stringMatching(/^Stage/), 'Arn'] }));
      expect(policyOf('ApiFunction')).toContainEqual({
        Effect: 'Allow',
        Action: ['ivs:CreateParticipantToken', 'ivs:DisconnectParticipant', 'ivs:GetStage', 'ivs:ListParticipants', 'ivs:ListStageSessions'],
        Resource: stages,
      });
      expect(policyOf('ApiFunction')).toContainEqual(
        expect.objectContaining({ Action: expect.arrayContaining(['ivschat:GetRoom']), Resource: { 'Fn::GetAtt': [expect.stringMatching(/^ChatRoom/), 'Arn'] } }),
      );
    });
    it('recording: GetComposition は composition/* のみ', () => {
      expect(policyOf('RecordingFunction')).toContainEqual({
        Effect: 'Allow',
        Action: 'ivs:GetComposition',
        Resource: 'arn:aws:ivs:ap-northeast-1:123456789012:composition/*',
      });
    });
    it('archive-expiry: 録画バケットの一覧・削除と Stream 読み取りだけ', () => {
      const recording = expect.stringMatching(/^RecordingBucket/);
      const actions = policyOf('ArchiveExpiryFunction').flatMap((s) => [s.Action].flat());
      expect(actions.sort()).toEqual(
        ['dynamodb:DescribeStream', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator', 'dynamodb:ListStreams', 's3:DeleteObject', 's3:ListBucket'].sort(),
      );
      expect(policyOf('ArchiveExpiryFunction')).toContainEqual({ Effect: 'Allow', Action: 's3:ListBucket', Resource: { 'Fn::GetAtt': [recording, 'Arn'] } });
      expect(policyOf('ArchiveExpiryFunction')).toContainEqual({
        Effect: 'Allow',
        Action: 's3:DeleteObject',
        Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [recording, 'Arn'] }, '/*']] },
      });
    });
    it('秘密鍵パラメータは1件に限定して読む', () => {
      t.main.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'ssm:GetParameter',
              Resource: 'arn:aws:ssm:ap-northeast-1:123456789012:parameter/delivery-stg/cloudfront/private-key',
            }),
          ]),
        },
      });
    });
    it('Cognito トリガーはグループ付与と参照のみ', () => {
      t.main.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: [
            {
              Effect: 'Allow',
              Action: ['cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminListGroupsForUser'],
              Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('^UserPool'), 'Arn'] },
            },
          ],
        },
      });
    });
  });

  describe('CloudFront', () => {
    const config = () =>
      (Object.values(t.main.findResources('AWS::CloudFront::Distribution'))[0] as {
        Properties: { DistributionConfig: Record<string, unknown> & { CacheBehaviors: Record<string, unknown>[] } };
      }).Properties.DistributionConfig;
    const behavior = (pattern: string) => config().CacheBehaviors.find((b) => b.PathPattern === pattern)!;

    it('OAC: S3 3つ + Lambda 1つ、常に署名', () => {
      t.main.resourceCountIs('AWS::CloudFront::OriginAccessControl', 4);
      t.main.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
        OriginAccessControlConfig: Match.objectLike({ OriginAccessControlOriginType: 'lambda', SigningBehavior: 'always', SigningProtocol: 'sigv4' }),
      });
      expect(
        Object.values(t.main.findResources('AWS::CloudFront::OriginAccessControl')).filter(
          (r) => (r as { Properties: { OriginAccessControlConfig: { OriginAccessControlOriginType: string } } }).Properties.OriginAccessControlConfig.OriginAccessControlOriginType === 's3',
        ),
      ).toHaveLength(3);
    });
    it('ビヘイビアの順序と /files/* の trusted key group', () => {
      expect(config().CacheBehaviors.map((b) => b.PathPattern)).toEqual(['/api/*', '/files/archives/*', '/files/slides/*', '/files/*']);
      expect(behavior('/files/slides/*').TargetOriginId).toBe(behavior('/files/*').TargetOriginId);
      for (const pattern of ['/files/archives/*', '/files/slides/*', '/files/*']) {
        expect(behavior(pattern)).toMatchObject({
          TrustedKeyGroups: [{ Ref: expect.stringMatching(/^FilesKeyGroup/) }],
          CachePolicyId: MANAGED.cachingOptimized,
          ViewerProtocolPolicy: 'https-only',
        });
      }
      expect(behavior('/api/*').TrustedKeyGroups).toBeUndefined();
      expect((config().DefaultCacheBehavior as Record<string, unknown>).TrustedKeyGroups).toBeUndefined();
    });
    it('/api/*: キャッシュ無効・全ヘッダー転送(X-Auth-Token, x-amz-content-sha256)・全メソッド', () => {
      expect(behavior('/api/*')).toMatchObject({
        CachePolicyId: MANAGED.cachingDisabled,
        OriginRequestPolicyId: MANAGED.allViewerExceptHostHeader,
        AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
      });
    });
    it('SPA フォールバックはエラーページ置換を使わない(/api, /files に影響しない)', () => {
      expect(config().CustomErrorResponses).toBeUndefined();
      expect(config().DefaultRootObject).toBe('index.html');
      const defaults = config().DefaultCacheBehavior as { FunctionAssociations: { EventType: string }[] };
      expect(defaults.FunctionAssociations.map((f) => f.EventType)).toEqual(['viewer-request', 'viewer-response']);
    });
    it('全ビヘイビアでセキュリティヘッダーを付与し、同一オリジンの埋め込みは /files/slides/* だけ許可', () => {
      const all = [config().DefaultCacheBehavior as Record<string, unknown>, ...config().CacheBehaviors];
      const responseFn = (b: Record<string, unknown>) =>
        JSON.stringify((b.FunctionAssociations as { EventType: string; FunctionARN: unknown }[]).find((f) => f.EventType === 'viewer-response')!.FunctionARN);
      const code = (fnRef: string) => {
        const [[, fn]] = resourcesOf(t.main, 'AWS::CloudFront::Function').filter(([id]) => fnRef.includes(`"${id}"`)) as [[string, { Properties: { FunctionCode: unknown } }]];
        return JSON.stringify(fn.Properties.FunctionCode);
      };
      const slides = responseFn(behavior('/files/slides/*'));
      const others = all.filter((b) => b.PathPattern !== '/files/slides/*').map(responseFn);
      expect(new Set(others).size).toBe(1);
      expect(slides).not.toBe(others[0]);
      expect(code(others[0]!)).toContain("frame-ancestors 'none'");
      expect(code(others[0]!)).toContain('\\"x-frame-options\\":\\"DENY\\"');
      expect(code(slides)).toContain("frame-ancestors 'self'");
      expect(code(slides)).not.toContain("frame-ancestors 'none'");
      expect(code(slides)).toContain('\\"x-frame-options\\":\\"SAMEORIGIN\\"');
    });
    it('WAF を関連付け、無料プランで使えないカスタムポリシーを作らない', () => {
      expect(config().WebACLId).toBeDefined();
      t.main.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 0);
      t.main.resourceCountIs('AWS::CloudFront::OriginRequestPolicy', 0);
      t.main.resourceCountIs('AWS::CloudFront::CachePolicy', 0);
      expect(config().CacheBehaviors.length + 1).toBeLessThanOrEqual(5);
    });
    it('公開鍵とキーグループ', () => {
      t.main.hasResourceProperties('AWS::CloudFront::PublicKey', {
        PublicKeyConfig: Match.objectLike({ EncodedKey: FAIL_CLOSED_PUBLIC_KEY }),
      });
      t.main.resourceCountIs('AWS::CloudFront::KeyGroup', 1);
    });
  });

  describe('WAF(us-east-1)', () => {
    it('CLOUDFRONT スコープで4ルール', () => {
      expect(t.stacks.waf.region).toBe('us-east-1');
      t.waf.hasResourceProperties('AWS::WAFv2::WebACL', {
        Scope: 'CLOUDFRONT',
        DefaultAction: { Allow: {} },
        Rules: [
          Match.objectLike({ Name: 'AWSManagedRulesCommonRuleSet' }),
          Match.objectLike({ Name: 'AWSManagedRulesKnownBadInputsRuleSet' }),
          Match.objectLike({ Name: 'AWSManagedRulesAmazonIpReputationList' }),
          Match.objectLike({
            Name: 'RateLimitPerIp',
            Statement: {
              RateBasedStatement: Match.objectLike({
                AggregateKeyType: 'IP',
                Limit: 15_000,
                ScopeDownStatement: { ByteMatchStatement: Match.objectLike({ PositionalConstraint: 'STARTS_WITH', SearchString: '/api/' }) },
              }),
            },
          }),
        ],
      });
    });
    it('料金プラン(Free)のサブスクリプションを us-east-1 に作る', () => {
      expect(t.stacks.pricing?.region).toBe('us-east-1');
      Template.fromStack(t.stacks.pricing!).hasResourceProperties('AWS::PricingPlanManager::Subscription', {
        PlanFamily: 'CloudFront',
        PlanTier: 'FREE',
      });
    });
  });

  it('CloudTrail 証跡1つ → ログバケット', () => {
    t.main.resourceCountIs('AWS::CloudTrail::Trail', 1);
    t.main.hasResourceProperties('AWS::CloudTrail::Trail', {
      S3BucketName: { Ref: Match.stringLikeRegexp('^LogBucket') },
      S3KeyPrefix: 'cloudtrail',
      IsMultiRegionTrail: true,
      EnableLogFileValidation: true,
    });
  });

  it('SPA と config.json を配置し、index.html/config.json を無効化', () => {
    t.main.resourceCountIs('Custom::CDKBucketDeployment', 2);
    t.main.hasResourceProperties('Custom::CDKBucketDeployment', {
      DistributionPaths: ['/index.html', '/config.json'],
      Prune: false,
    });
  });

  it('固定費リソース(ALB, NAT, VPC, コンテナ, Secrets Manager, Route53, Shield)がない', () => {
    const forbidden = [
      'AWS::EC2::VPC',
      'AWS::EC2::NatGateway',
      'AWS::EC2::Instance',
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      'AWS::ECS::Service',
      'AWS::EKS::Cluster',
      'AWS::SecretsManager::Secret',
      'AWS::Route53::HostedZone',
      'AWS::Shield::Protection',
      'AWS::RDS::DBInstance',
    ];
    for (const template of [t.main, t.waf, Template.fromStack(t.stacks.pricing!)]) {
      for (const type of forbidden) template.resourceCountIs(type, 0);
    }
  });

  it('主要値を Output する', () => {
    for (const key of ['CloudFrontDomain', 'UserPoolId', 'UserPoolClientId', 'CognitoDomain', 'ChatRoomArn', 'CloudFrontKeyPairId']) {
      t.main.hasOutput(key, {});
    }
  });
});

describe('Okta 連携あり・prod', () => {
  let t: ReturnType<typeof synth>;
  beforeAll(() => {
    t = synth({
      env: 'prod',
      oktaIssuer: 'https://example.okta.com',
      oktaClientId: 'okta-client',
      oktaClientSecretParameter: '/delivery-prod/okta/client-secret',
      sesFromEmail: 'no-reply@example.com',
      cloudFrontFreePlan: 'false',
      cloudTrail: 'false',
    });
  });

  it('IdP はカスタムリソースで作り、テンプレートに secret を含めない', () => {
    t.main.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      ProviderName: 'Okta',
      Issuer: 'https://example.okta.com',
      ClientId: 'okta-client',
      ClientSecretParameter: '/delivery-prod/okta/client-secret',
    });
    t.main.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 0);
  });
  it('App Client を作成後に OAuth(コード)＋コールバックで更新', () => {
    const update = resourcesOf(t.main, 'Custom::AWS')
      .map(([, r]) => JSON.stringify(t.mainStack.resolve((r as { Properties: { Create: unknown } }).Properties.Create)))
      .find((s) => s.includes('updateUserPoolClient'))!;
    expect(update).toContain('\\"AllowedOAuthFlows\\":[\\"code\\"]');
    expect(update).toContain('\\"SupportedIdentityProviders\\":[\\"COGNITO\\",\\"Okta\\"]');
    expect(update).toContain('/login');
  });
  it('SES から招待メールを送る', () => {
    t.main.hasResourceProperties('AWS::Cognito::UserPool', {
      EmailConfiguration: Match.objectLike({ EmailSendingAccount: 'DEVELOPER', From: 'no-reply@example.com' }),
    });
  });
  it('prod はデータを保持する', () => {
    t.main.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Retain' });
    t.main.hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Retain' });
    t.main.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
  });
  it('料金プランと証跡を作らない指定ができる', () => {
    expect(t.stacks.pricing).toBeUndefined();
    t.main.resourceCountIs('AWS::CloudTrail::Trail', 0);
  });
});

describe('未ビルド・鍵未登録でも synth できる', () => {
  it('スタブ関数とフェイルクローズ鍵を使い、警告を出す', () => {
    const t = synth({}, { built: false, key: false });
    const warnings = Annotations.fromStack(t.mainStack).findWarning('*', Match.stringLikeRegexp('.*'));
    const text = warnings.map((w) => String(w.entry.data)).join('\n');
    expect(text).toContain('pnpm --filter api build');
    expect(text).toContain('pnpm --filter web build');
    expect(text).toContain('scripts/cloudfront-keypair.sh');
    t.main.hasResourceProperties('AWS::Lambda::Function', { Code: { ZipFile: Match.stringLikeRegexp('not built') } });
    t.main.resourceCountIs('Custom::CDKBucketDeployment', 1);
  });
});
