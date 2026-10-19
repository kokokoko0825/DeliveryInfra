import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { App, Tags } from 'aws-cdk-lib';
import { EDGE_REGION, createLookup, loadConfig } from './config.ts';
import { publicKeyPath, validatePublicKeyPem } from './keys.ts';
import { DeliveryStack } from './stacks/delivery-stack.ts';
import { EdgeWafStack } from './stacks/edge-waf-stack.ts';
import { PricingPlanStack } from './stacks/pricing-plan-stack.ts';

export const INFRA_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(INFRA_ROOT, '..');

export interface BuildOptions {
  env?: Record<string, string | undefined>;
  apiDistDir?: string;
  webDistDir?: string;
  publicKeyPem?: string;
  /** 公開鍵ディレクトリ。テストでは実リポジトリのデプロイ鍵から分離できる。 */
  publicKeyDir?: string;
}

/** 3スタック構成: WAF(us-east-1) → 本体(ap-northeast-1) → 料金プラン(us-east-1)。 */
export function buildApp(app: App, options: BuildOptions = {}) {
  const config = loadConfig(createLookup((key) => app.node.tryGetContext(key), options.env ?? process.env));
  const keyFile = options.publicKeyDir
    ? path.join(options.publicKeyDir, path.basename(publicKeyPath(config.envName)))
    : path.join(INFRA_ROOT, publicKeyPath(config.envName));
  const pem = options.publicKeyPem ?? (existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : undefined);
  const stackName = (name: string) => `${config.prefix}-${name}`;

  const waf = new EdgeWafStack(app, stackName('edge-waf'), {
    env: { account: config.account, region: EDGE_REGION },
    prefix: config.prefix,
  });
  const main = new DeliveryStack(app, stackName('main'), {
    env: { account: config.account, region: config.region },
    crossRegionReferences: true,
    config,
    webAclArn: waf.webAclArn,
    cloudFrontPublicKeyPem: pem === undefined ? undefined : validatePublicKeyPem(pem),
    apiDistDir: options.apiDistDir ?? path.join(REPO_ROOT, 'apps/api/dist'),
    webDistDir: options.webDistDir ?? path.join(REPO_ROOT, 'apps/web/dist'),
  });
  const pricing = config.cloudFrontFreePlan
    ? new PricingPlanStack(app, stackName('pricing-plan'), {
        env: { account: config.account, region: EDGE_REGION },
        crossRegionReferences: true,
        distributionArn: main.distribution.distributionArn,
        webAclArn: waf.webAclArn,
      })
    : undefined;

  Tags.of(app).add('Project', 'delivery');
  Tags.of(app).add('Environment', config.envName);
  return { config, waf, main, pricing };
}
