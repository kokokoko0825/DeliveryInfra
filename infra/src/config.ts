export const ENV_NAMES = ['stg', 'prod'] as const;
export type EnvName = (typeof ENV_NAMES)[number];

export const MAIN_REGION = 'ap-northeast-1';
/** CloudFront 用 WAF(スコープ CLOUDFRONT)と料金プランは us-east-1 にしか作れない。 */
export const EDGE_REGION = 'us-east-1';

export interface OktaConfig {
  issuer: string;
  clientId: string;
  /** client secret を格納した SSM SecureString のパラメータ名。値そのものは扱わない。 */
  clientSecretParameter: string;
}

export interface DeliveryConfig {
  envName: EnvName;
  prefix: string;
  account: string | undefined;
  region: typeof MAIN_REGION;
  sesFromEmail: string | undefined;
  okta: OktaConfig | undefined;
  cognitoDomainPrefix: string | undefined;
  cloudFrontPrivateKeyParameter: string;
  /** CloudFront 料金プラン(Free)のサブスクリプションを CDK で作るか。 */
  cloudFrontFreePlan: boolean;
  /** 同一アカウントに stg/prod を置く場合、2本目の証跡は有料になるので片方で false にする。 */
  createTrail: boolean;
  retainData: boolean;
}

/** context(-c key=value) を優先し、なければ環境変数(.env.<env>)を見る。空文字は未設定扱い。 */
export type Lookup = (contextKey: string, envKey: string) => string | undefined;

export function parseEnvName(value: string | undefined): EnvName {
  const name = value ?? 'stg';
  if (!(ENV_NAMES as readonly string[]).includes(name)) {
    throw new Error(`env は ${ENV_NAMES.join(' / ')} のいずれかを指定してください: ${name}`);
  }
  return name as EnvName;
}

export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`true / false を指定してください: ${value}`);
}

const DOMAIN_PREFIX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_DOMAIN_WORDS = ['aws', 'amazon', 'cognito'];

export function validateDomainPrefix(prefix: string): string {
  if (!DOMAIN_PREFIX.test(prefix) || RESERVED_DOMAIN_WORDS.some((word) => prefix.includes(word))) {
    throw new Error(`Cognito ドメインプレフィックスが不正です: ${prefix}`);
  }
  return prefix;
}

export function parseOkta(issuer?: string, clientId?: string, clientSecretParameter?: string): OktaConfig | undefined {
  const values = [issuer, clientId, clientSecretParameter];
  if (values.every((v) => v === undefined)) return undefined;
  if (!issuer || !clientId || !clientSecretParameter) {
    throw new Error('Okta 連携は oktaIssuer / oktaClientId / oktaClientSecretParameter をすべて指定してください');
  }
  if (!issuer.startsWith('https://')) throw new Error(`oktaIssuer は https:// で始めてください: ${issuer}`);
  if (!clientSecretParameter.startsWith('/')) {
    throw new Error(`oktaClientSecretParameter は / で始まる SSM パラメータ名にしてください: ${clientSecretParameter}`);
  }
  return { issuer, clientId, clientSecretParameter };
}

export function loadConfig(lookup: Lookup): DeliveryConfig {
  const envName = parseEnvName(lookup('env', 'DELIVERY_ENV'));
  const prefix = `delivery-${envName}`;
  const domainPrefix = lookup('cognitoDomainPrefix', 'DELIVERY_COGNITO_DOMAIN_PREFIX');
  return {
    envName,
    prefix,
    account: lookup('account', 'CDK_DEFAULT_ACCOUNT'),
    region: MAIN_REGION,
    sesFromEmail: lookup('sesFromEmail', 'DELIVERY_SES_FROM_EMAIL'),
    okta: parseOkta(
      lookup('oktaIssuer', 'DELIVERY_OKTA_ISSUER'),
      lookup('oktaClientId', 'DELIVERY_OKTA_CLIENT_ID'),
      lookup('oktaClientSecretParameter', 'DELIVERY_OKTA_CLIENT_SECRET_PARAMETER'),
    ),
    cognitoDomainPrefix: domainPrefix === undefined ? undefined : validateDomainPrefix(domainPrefix),
    cloudFrontPrivateKeyParameter: `/${prefix}/cloudfront/private-key`,
    cloudFrontFreePlan: parseBoolean(lookup('cloudFrontFreePlan', 'DELIVERY_CLOUDFRONT_FREE_PLAN'), true),
    createTrail: parseBoolean(lookup('cloudTrail', 'DELIVERY_CLOUDTRAIL'), true),
    retainData: envName === 'prod',
  };
}

/** context → 環境変数の順に引く Lookup を作る。 */
export function createLookup(
  getContext: (key: string) => unknown,
  env: Record<string, string | undefined>,
): Lookup {
  return (contextKey, envKey) => {
    const fromContext = getContext(contextKey);
    const value = typeof fromContext === 'string' ? fromContext : env[envKey];
    return value === undefined || value === '' ? undefined : value;
  };
}
