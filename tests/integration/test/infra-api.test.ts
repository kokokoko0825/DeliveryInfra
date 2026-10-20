import { execFileSync } from 'node:child_process';
import { CLOUDFRONT_HOST, TABLE_INDEXES } from './support/environment';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ApiEnvSchema, ArchiveExpiryEnvSchema, ChatReviewEnvSchema, CognitoEnvSchema, RecordingEnvSchema,
} from '../../../apps/api/src/env';
import { buildApp, INFRA_ROOT } from '../../../infra/src/app';
import { FAIL_CLOSED_PUBLIC_KEY } from '../../../infra/src/keys';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const API_ROOT = path.join(REPO_ROOT, 'apps/api');
const API_DIST = path.join(API_ROOT, 'dist');
const MANAGED = {
  cachingDisabled: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
  /** Host 以外の閲覧者ヘッダーをすべてオリジンへ転送する(X-Auth-Token・x-amz-content-sha256 を含む)。 */
  allViewerExceptHostHeader: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
};

/** apps/api のビルドと同じ esbuild(apps/api の依存)を使う。 */
const { build } = createRequire(path.join(API_ROOT, 'package.json'))('esbuild') as {
  build: (options: Record<string, unknown>) => Promise<{ outputFiles: { text: string }[] }>;
};
/** apps/api/scripts/build.mjs の [出力ディレクトリ, ソース名] の組(ビルド設定を唯一の情報源にする)。 */
const BUILD_ENTRIES = [...readFileSync(path.join(API_ROOT, 'scripts/build.mjs'), 'utf8').matchAll(/\['([\w-]+)',\s*'([\w-]+)'\]/gu)].map(([, dist, source]) => ({ dist: dist!, source: source! }));
/** dist ディレクトリ → そのハンドラが起動時に検証する環境変数スキーマ(apps/api/src/env.ts)。 */
const ENV_SCHEMAS: Record<string, z.AnyZodObject> = {
  api: ApiEnvSchema, 'chat-review': ChatReviewEnvSchema, recording: RecordingEnvSchema, 'cognito-trigger': CognitoEnvSchema, 'archive-expiry': ArchiveExpiryEnvSchema,
};

type Resource = { Type: string; Properties: Record<string, unknown>; Metadata?: Record<string, unknown> };
let template: Template;
let resources: Record<string, Resource>;
let outdir: string;
/** Lambda の論理 ID → デプロイされる dist ディレクトリ名(アセットの index.mjs をビルド出力と突き合わせて決める)。 */
const deployedDist = new Map<string, string>();

const ofType = (type: string) => Object.entries(resources).filter(([, resource]) => resource.Type === type);
const getAttId = (value: unknown) => (value as { 'Fn::GetAtt'?: [string, string] })['Fn::GetAtt']?.[0];
const refId = (value: unknown) => (value as { Ref?: string }).Ref;
const functionFor = (dist: string) => [...deployedDist].find(([, value]) => value === dist)?.[0];

beforeAll(() => {
  // pnpm test は事前に `pnpm --filter api build` を実行する(package.json の test スクリプト)。
  for (const { dist } of BUILD_ENTRIES) {
    if (!existsSync(path.join(API_DIST, dist, 'index.mjs'))) throw new Error(`apps/api/dist/${dist}/index.mjs がありません。pnpm --filter api build を実行してください`);
  }
  const web = mkdtempSync(path.join(tmpdir(), 'integration-web-'));
  mkdirSync(path.join(web, 'assets'));
  writeFileSync(path.join(web, 'index.html'), '<!doctype html>');
  const context = (JSON.parse(readFileSync(path.join(INFRA_ROOT, 'cdk.json'), 'utf8')) as { context: Record<string, unknown> }).context;
  // aws:asset:path(ステージングしたアセットの場所)は CLI が有効にするメタデータなので、テストでも有効にする。
  const app = new App({ context: { ...context, env: 'stg', account: '123456789012', 'aws:cdk:enable-asset-metadata': true } });
  const { main } = buildApp(app, { env: {}, apiDistDir: API_DIST, webDistDir: web, publicKeyPem: FAIL_CLOSED_PUBLIC_KEY });
  template = Template.fromStack(main);
  resources = template.toJSON().Resources as Record<string, Resource>;
  outdir = app.outdir;

  const distContents = new Map(BUILD_ENTRIES.map(({ dist }) => [readFileSync(path.join(API_DIST, dist, 'index.mjs'), 'utf8'), dist]));
  for (const [id, fn] of ofType('AWS::Lambda::Function')) {
    const assetPath = fn.Metadata?.['aws:asset:path'];
    if (typeof assetPath !== 'string') continue;
    const file = path.join(outdir, assetPath, 'index.mjs');
    const dist = existsSync(file) ? distContents.get(readFileSync(file, 'utf8')) : undefined;
    if (dist) deployedDist.set(id, dist);
  }
}, 120_000);

describe('Infra(CDK synth) ↔ API(ビルド出力・環境変数)', () => {
  it('apps/api の全ハンドラがそれぞれ1つの Lambda としてデプロイされ、未ビルド警告のスタブではない', () => {
    expect([...deployedDist.values()].sort()).toEqual(BUILD_ENTRIES.map(({ dist }) => dist).sort());
    const expected: Record<string, RegExp> = {
      api: /^ApiFunction/u, 'chat-review': /^ChatReviewFunction/u, recording: /^RecordingFunction/u,
      'cognito-trigger': /^CognitoFunction/u, 'archive-expiry': /^ArchiveExpiryFunction/u,
    };
    for (const [id, dist] of deployedDist) expect({ dist, id }).toEqual({ dist, id: expect.stringMatching(expected[dist] ?? /^$/u) });
    const stubs = ofType('AWS::Lambda::Function').filter(([, fn]) => String((fn.Properties.Code as { ZipFile?: string }).ZipFile ?? '').includes('apps/api is not built'));
    expect(stubs).toEqual([]);
  });

  it.each(BUILD_ENTRIES)('$dist: index.handler が export され、Node.js 22 / arm64 で動く', async ({ dist }) => {
    const id = functionFor(dist)!;
    expect(resources[id]!.Properties).toMatchObject({ Handler: 'index.handler', Runtime: 'nodejs22.x', Architectures: ['arm64'] });
    const module = await import(pathToFileURL(path.join(API_DIST, dist, 'index.mjs')).href) as { handler?: unknown };
    expect(typeof module.handler).toBe('function');
  });

  it.each(BUILD_ENTRIES)('$dist: Vitest を通さない素の Node で読み込める(Lambda の初期化と同じ条件)', ({ dist }) => {
    // Vitest は require を補うため、ESM バンドルの "Dynamic require of node:https" をここで検出する。
    const url = pathToFileURL(path.join(API_DIST, dist, 'index.mjs')).href;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(url)}); console.log(typeof m.handler);`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(output.trim()).toBe('function');
  });

  it.each(BUILD_ENTRIES)('$dist: 環境変数のキーがハンドラの env スキーマを満たし、余分なキーがない', ({ dist }) => {
    const schema = ENV_SCHEMAS[dist];
    expect(schema, `${dist} の env スキーマを ENV_SCHEMAS に追加してください`).toBeDefined();
    const variables = ((resources[functionFor(dist)!]!.Properties.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables) ?? {};
    // 値は CloudFormation の参照(Ref/GetAtt)なのでダミー文字列に置き換える。AWS_REGION は Lambda ランタイムが設定する。
    const dummy = Object.fromEntries(Object.keys(variables).map((key) => [key, key === 'NODE_ENV' ? variables[key] : `dummy-${key}`]));
    expect(() => schema!.parse({ ...dummy, AWS_REGION: 'ap-northeast-1' })).not.toThrow();
    expect(Object.keys(variables).filter((key) => !(key in schema!.shape))).toEqual([]);
    expect(variables).not.toHaveProperty('AWS_REGION');
  });

  it('api は Chat Room / StorageConfiguration を ARN ではなく CDK と同じ名前で受け取る(循環参照回避)', () => {
    const variables = (resources[functionFor('api')!]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    const [[, room]] = ofType('AWS::IVSChat::Room') as [[string, Resource]];
    const [[, storage]] = ofType('AWS::IVS::StorageConfiguration') as [[string, Resource]];
    expect(typeof room.Properties.Name).toBe('string');
    expect(typeof storage.Properties.Name).toBe('string');
    expect(variables.CHAT_ROOM_NAME).toBe(room.Properties.Name);
    expect(variables.RECORDING_STORAGE_CONFIGURATION_NAME).toBe(storage.Properties.Name);
    expect(Object.values(variables).every((value) => typeof value !== 'object' || !/"(ChatRoom|StorageConfiguration)/u.test(JSON.stringify(value)))).toBe(true);
  });

  it('テーブルの GSI は API が前提とするもの(TABLE_INDEXES)と完全に一致する', () => {
    const [[, table]] = [...ofType('AWS::DynamoDB::GlobalTable'), ...ofType('AWS::DynamoDB::Table')] as [[string, Resource]];
    const indexes = (table.Properties.GlobalSecondaryIndexes as { IndexName: string; KeySchema: { AttributeName: string; KeyType: string }[] }[] | undefined) ?? [];
    expect(Object.fromEntries(indexes.map((index) => [index.IndexName, index.KeySchema]))).toEqual(Object.fromEntries(Object.entries(TABLE_INDEXES).map(([name, keys]) => [
      name, [{ AttributeName: keys.partitionKey, KeyType: 'HASH' }, { AttributeName: keys.sortKey, KeyType: 'RANGE' }],
    ])));
  });

  it('/api/* は API 関数URLへ OAC 署名で転送し、X-Auth-Token と x-amz-content-sha256 を含む全ヘッダーを渡す', () => {
    const [[, distribution]] = ofType('AWS::CloudFront::Distribution') as [[string, Resource]];
    const config = distribution.Properties.DistributionConfig as {
      CacheBehaviors: { PathPattern: string; TargetOriginId: string; AllowedMethods: string[]; CachePolicyId: string; OriginRequestPolicyId?: string; FunctionAssociations?: { EventType: string; FunctionARN: unknown }[] }[];
      Origins: { Id: string; DomainName: unknown; OriginAccessControlId?: unknown }[];
    };
    const behavior = config.CacheBehaviors.find((candidate) => candidate.PathPattern.replace(/^\//u, '') === 'api/*')!;
    expect(behavior).toBeDefined();
    expect(behavior.OriginRequestPolicyId).toBe(MANAGED.allViewerExceptHostHeader);
    expect(behavior.CachePolicyId).toBe(MANAGED.cachingDisabled);
    expect(behavior.AllowedMethods).toEqual(expect.arrayContaining(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']));
    expect(ofType('AWS::CloudFront::OriginRequestPolicy')).toEqual([]);

    // オリジンは API 関数(ビルド出力 api)の関数URLで、OAC(lambda / 常に署名)を使う。
    const origin = config.Origins.find((candidate) => candidate.Id === behavior.TargetOriginId)!;
    const urlId = JSON.stringify(origin.DomainName).match(/"([A-Za-z0-9]+)","FunctionUrl"/u)?.[1];
    expect(getAttId((resources[urlId!]!.Properties.TargetFunctionArn))).toBe(functionFor('api'));
    expect(resources[urlId!]!.Properties.AuthType).toBe('AWS_IAM');
    const oac = resources[getAttId(origin.OriginAccessControlId)!]!.Properties.OriginAccessControlConfig;
    expect(oac).toMatchObject({ OriginAccessControlOriginType: 'lambda', SigningBehavior: 'always', SigningProtocol: 'sigv4' });

    // viewer-request の CloudFront Function は x-forwarded-host を閲覧者の Host で上書きし、認証ヘッダーは残す。
    const viewerRequest = behavior.FunctionAssociations!.find((association) => association.EventType === 'viewer-request')!;
    const code = String(resources[getAttId(viewerRequest.FunctionARN)!]!.Properties.FunctionCode);
    const handler = new Function(`${code}\nreturn handler;`)() as (event: unknown) => { headers: Record<string, { value: string }> };
    const request = handler({ request: { method: 'POST', uri: '/api/ng-words', headers: {
      host: { value: CLOUDFRONT_HOST }, 'x-forwarded-host': { value: 'attacker.example' },
      'x-auth-token': { value: 'access-token' }, 'x-amz-content-sha256': { value: 'abc' },
    } } });
    expect(request.headers).toMatchObject({ 'x-forwarded-host': { value: CLOUDFRONT_HOST }, 'x-auth-token': { value: 'access-token' }, 'x-amz-content-sha256': { value: 'abc' } });
    // API が受け付ける x-forwarded-host の形式(router.ts の検証)と一致する。
    expect(CLOUDFRONT_HOST).toMatch(/^[a-z0-9]+\.cloudfront\.net$/u);
  });

  it('Chat Room の審査 Lambda は chat-review ハンドラで、失敗時は DENY', () => {
    const [[, room]] = ofType('AWS::IVSChat::Room') as [[string, Resource]];
    const review = room.Properties.MessageReviewHandler as { Uri: unknown; FallbackResult: string };
    expect(getAttId(review.Uri)).toBe(functionFor('chat-review'));
    expect(review.FallbackResult).toBe('DENY');
    const permission = ofType('AWS::Lambda::Permission').find(([, resource]) => resource.Properties.Principal === 'ivschat.amazonaws.com');
    expect(getAttId(permission?.[1].Properties.FunctionName)).toBe(functionFor('chat-review'));
  });

  it('EventBridge の合成状態変更ルールは recording ハンドラを呼び、Session End を通す', async () => {
    const rules = ofType('AWS::Events::Rule').filter(([, rule]) => JSON.stringify(rule.Properties.EventPattern ?? {}).includes('IVS Composition State Change'));
    expect(rules).toHaveLength(1);
    const [[, rule]] = rules as [[string, Resource]];
    const pattern = rule.Properties.EventPattern as { source: string[]; 'detail-type': string[]; detail?: { event_name?: string[] } };
    expect(pattern.source).toEqual(['aws.ivs']);
    expect(pattern['detail-type']).toEqual(['IVS Composition State Change']);
    if (pattern.detail?.event_name) expect(pattern.detail.event_name).toContain('Session End');
    const targets = rule.Properties.Targets as { Arn: unknown }[];
    expect(targets.map((target) => getAttId(target.Arn))).toEqual([functionFor('recording')]);
  });

  it('Cognito トリガー(PostConfirmation / PostAuthentication)は cognito-trigger ハンドラ', () => {
    const [[, pool]] = ofType('AWS::Cognito::UserPool') as [[string, Resource]];
    const config = pool.Properties.LambdaConfig as Record<string, unknown>;
    expect(getAttId(config.PostConfirmation)).toBe(functionFor('cognito-trigger'));
    expect(getAttId(config.PostAuthentication)).toBe(functionFor('cognito-trigger'));
  });

  it('テーブルの Stream は archive-expiry ハンドラに届く(R1-22)', () => {
    const mappings = ofType('AWS::Lambda::EventSourceMapping');
    const target = mappings.map(([, mapping]) => refId(mapping.Properties.FunctionName));
    expect(target).toContain(functionFor('archive-expiry'));
  });

  it.each(BUILD_ENTRIES)('$dist: ソースが呼ぶ AWS API を実行ロールの IAM ポリシーが許可している', async ({ dist, source }) => {
    const required = await requiredActions(path.join(API_ROOT, 'src', `${source}.ts`));
    expect(required.length).toBeGreaterThan(0);
    const fn = resources[functionFor(dist)!]!;
    const roleId = getAttId(fn.Properties.Role)!;
    const allowed = ofType('AWS::IAM::Policy')
      .filter(([, policy]) => (policy.Properties.Roles as unknown[]).some((role) => refId(role) === roleId))
      .flatMap(([, policy]) => (policy.Properties.PolicyDocument as { Statement: { Effect: string; Action: string | string[] }[] }).Statement)
      .filter((statement) => statement.Effect === 'Allow')
      .flatMap((statement) => [statement.Action].flat());
    const matches = (action: string) => allowed.some((pattern) => new RegExp(`^${pattern.replaceAll('*', '.*')}$`, 'u').test(action));
    expect(required.filter((action) => !matches(action))).toEqual([]);
  });

  it('api: StartComposition 用に録画バケットの所在確認だけを許可し、他バケットへ広げない', () => {
    const api = resources[functionFor('api')!]!;
    const roleId = getAttId(api.Properties.Role)!;
    const policies = ofType('AWS::IAM::Policy')
      .filter(([, policy]) => (policy.Properties.Roles as unknown[]).some((role) => refId(role) === roleId))
      .flatMap(([, policy]) => (policy.Properties.PolicyDocument as { Statement: { Effect: string; Action: string | string[]; Resource: unknown }[] }).Statement);
    const locationChecks = policies.filter((statement) => [statement.Action].flat().includes('s3:GetBucketLocation'));
    const recordingId = ofType('AWS::S3::Bucket').find(([id]) => id.startsWith('RecordingBucket'))?.[0];
    expect(recordingId).toBeDefined();
    expect(locationChecks).toEqual([{ Effect: 'Allow', Action: ['s3:GetBucketLocation', 's3:ListBucket'], Resource: { 'Fn::GetAtt': [recordingId, 'Arn'] } }]);
  });
});

/** SDK のパッケージ → IAM のサービス接頭辞。 */
const SERVICE: Record<string, string> = {
  '@aws-sdk/client-cognito-identity-provider': 'cognito-idp', '@aws-sdk/client-ivs-realtime': 'ivs', '@aws-sdk/client-ivschat': 'ivschat',
  '@aws-sdk/client-s3': 's3', '@aws-sdk/client-ssm': 'ssm', '@aws-sdk/lib-dynamodb': 'dynamodb', '@aws-sdk/client-dynamodb': 'dynamodb',
};
/** コマンド名と IAM アクション名が異なるもの。 */
const ACTION_ALIASES: Record<string, string> = {
  's3:HeadObject': 's3:GetObject', 's3:ListObjectsV2': 's3:ListBucket', 's3:DeleteObjects': 's3:DeleteObject',
  'dynamodb:Get': 'dynamodb:GetItem', 'dynamodb:Put': 'dynamodb:PutItem', 'dynamodb:Update': 'dynamodb:UpdateItem', 'dynamodb:Delete': 'dynamodb:DeleteItem',
  'dynamodb:BatchGet': 'dynamodb:BatchGetItem', 'dynamodb:BatchWrite': 'dynamodb:BatchWriteItem', 'dynamodb:TransactWrite': 'dynamodb:PutItem',
};

/**
 * ハンドラのソースを esbuild でバンドル(SDK は external、未使用コードはツリーシェイク)し、
 * 実際に `new XxxCommand(` している SDK コマンドを IAM アクションにする。presigned POST は s3:PutObject。
 */
async function requiredActions(entry: string): Promise<string[]> {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22', external: ['@aws-sdk/*'], logLevel: 'silent' });
  const code = result.outputFiles[0]!.text;
  // バンドル内のローカル名(esbuild が別名を付けることがある) → { SDK パッケージ, 元のコマンド名 }
  const imports = new Map<string, { from: string; imported: string }>();
  for (const [, names, from] of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(@aws-sdk\/[^"]+)"/gu)) {
    for (const specifier of names!.split(',')) {
      const [imported, local] = specifier.trim().split(/\s+as\s+/u).map((name) => name.trim());
      if (imported) imports.set(local ?? imported, { from: from!, imported });
    }
  }
  const actions = [...code.matchAll(/new (\w+)\(/gu)].flatMap(([, local]) => {
    const source = imports.get(local!);
    if (!source?.imported.endsWith('Command')) return [];
    const service = SERVICE[source.from];
    if (!service) throw new Error(`${source.from} の IAM サービス接頭辞を SERVICE に追加してください`);
    const action = `${service}:${source.imported.replace(/Command$/u, '')}`;
    return [ACTION_ALIASES[action] ?? action];
  });
  if (/createPresignedPost\(/u.test(code)) actions.push('s3:PutObject');
  return [...new Set(actions)].sort();
}

