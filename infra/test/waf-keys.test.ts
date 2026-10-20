import { describe, expect, it } from 'vitest';
import { FAIL_CLOSED_PUBLIC_KEY, publicKeyPath, validatePublicKeyPem } from '../src/keys.ts';
import { DEFAULT_RATE_LIMIT, buildWafRules } from '../src/waf.ts';

describe('buildWafRules', () => {
  it('マネージド3つ＋レート制限の4ルール', () => {
    const rules = buildWafRules();
    expect(rules.map((r) => [r.name, r.priority])).toEqual([
      ['AWSManagedRulesCommonRuleSet', 0],
      ['AWSManagedRulesKnownBadInputsRuleSet', 1],
      ['AWSManagedRulesAmazonIpReputationList', 2],
      ['RateLimitPerIp', 3],
    ]);
  });
  it('マネージドルールはルール側の判定を使う', () => {
    const [common] = buildWafRules();
    expect(common).toEqual({
      name: 'AWSManagedRulesCommonRuleSet',
      priority: 0,
      overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' } },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'AWSManagedRulesCommonRuleSet', sampledRequestsEnabled: true },
    });
  });
  it('レート制限は全リクエストを IP ごと5分で数えてブロック(無料プランは scope-down 不可)', () => {
    expect(buildWafRules().at(-1)).toEqual({
      name: 'RateLimitPerIp',
      priority: 3,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          aggregateKeyType: 'IP',
          limit: DEFAULT_RATE_LIMIT,
          evaluationWindowSec: 300,
        },
      },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'RateLimitPerIp', sampledRequestsEnabled: true },
    });
    expect(buildWafRules(10).at(-1)?.statement).toMatchObject({ rateBasedStatement: { limit: 10 } });
  });
  it('上限は NAT 配下300人(SPA 45件+API 33件+HLS 30件/人)の約1.5倍', () => {
    expect(DEFAULT_RATE_LIMIT).toBe(50_000);
    expect(DEFAULT_RATE_LIMIT).toBeGreaterThanOrEqual(300 * (45 + 33 + 30));
  });
  it.each([9, 1.5, Number.NaN])('レート %s は拒否', (limit) => expect(() => buildWafRules(limit)).toThrow('レート制限'));
});

describe('keys', () => {
  it('公開鍵の配置パス', () => expect(publicKeyPath('stg')).toBe('keys/stg-cloudfront-public.pem'));
  it('PEM を正規化(前後の空白除去・末尾改行)', () => {
    expect(validatePublicKeyPem(`\n${FAIL_CLOSED_PUBLIC_KEY}\n\n`)).toBe(FAIL_CLOSED_PUBLIC_KEY);
  });
  it.each(['not a key', '-----BEGIN PUBLIC KEY-----\nabc', '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END PUBLIC KEY-----'])(
    '不正な PEM は拒否',
    (pem) => expect(() => validatePublicKeyPem(pem)).toThrow('PEM'),
  );
});
