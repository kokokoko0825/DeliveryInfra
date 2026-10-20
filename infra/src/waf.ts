import type { aws_wafv2 as wafv2 } from 'aws-cdk-lib';

/** CloudFront 無料プランの WAF ルール上限(5)の範囲で、要件 5.3 の4ルールだけを置く。 */
export const MANAGED_RULE_GROUPS = [
  'AWSManagedRulesCommonRuleSet',
  'AWSManagedRulesKnownBadInputsRuleSet',
  'AWSManagedRulesAmazonIpReputationList',
] as const;

export const FREE_PLAN_RULE_LIMIT = 5;
/**
 * 5分あたり・IP ごとの全リクエスト上限。CloudFront 無料プランは scope-down 付きのレート制限を受け付けないため
 * (PricingPlanManager が web ACL を "not eligible" と拒否)、全パスを数える。
 * 社内 NAT の出口 IP 1つの向こうに視聴者300人がいる想定で、1人あたり SPA 初回約45件 + API 33件 + アーカイブ HLS 約30件
 * = 108件、300人で 32,400件に約1.5倍の余裕を見た値。根拠は docs/20261019-infra.md の WAF 節。
 */
export const DEFAULT_RATE_LIMIT = 50_000;

const visibility = (metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
  cloudWatchMetricsEnabled: true,
  metricName,
  sampledRequestsEnabled: true,
});

export function buildWafRules(rateLimit: number = DEFAULT_RATE_LIMIT): wafv2.CfnWebACL.RuleProperty[] {
  if (!Number.isInteger(rateLimit) || rateLimit < 10) {
    throw new Error(`レート制限は 10 以上の整数にしてください: ${rateLimit}`);
  }
  const managed = MANAGED_RULE_GROUPS.map((name, priority): wafv2.CfnWebACL.RuleProperty => ({
    name,
    priority,
    overrideAction: { none: {} },
    statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
    visibilityConfig: visibility(name),
  }));
  const rateBased: wafv2.CfnWebACL.RuleProperty = {
    name: 'RateLimitPerIp',
    priority: managed.length,
    action: { block: {} },
    statement: {
      rateBasedStatement: {
        aggregateKeyType: 'IP',
        limit: rateLimit,
        evaluationWindowSec: 300,
      },
    },
    visibilityConfig: visibility('RateLimitPerIp'),
  };
  const rules = [...managed, rateBased];
  if (rules.length > FREE_PLAN_RULE_LIMIT) throw new Error('WAF ルールが無料プランの上限を超えています');
  return rules;
}
