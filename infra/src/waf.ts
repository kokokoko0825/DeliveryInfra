import type { aws_wafv2 as wafv2 } from 'aws-cdk-lib';

/** CloudFront 無料プランの WAF ルール上限(5)の範囲で、要件 5.3 の4ルールだけを置く。 */
export const MANAGED_RULE_GROUPS = [
  'AWSManagedRulesCommonRuleSet',
  'AWSManagedRulesKnownBadInputsRuleSet',
  'AWSManagedRulesAmazonIpReputationList',
] as const;

export const FREE_PLAN_RULE_LIMIT = 5;
/** 5分あたり・IP ごとのリクエスト上限。視聴(SPA+API ポーリング)で十分な余裕を持たせた値。 */
export const DEFAULT_RATE_LIMIT = 2000;

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
    statement: { rateBasedStatement: { aggregateKeyType: 'IP', limit: rateLimit, evaluationWindowSec: 300 } },
    visibilityConfig: visibility('RateLimitPerIp'),
  };
  const rules = [...managed, rateBased];
  if (rules.length > FREE_PLAN_RULE_LIMIT) throw new Error('WAF ルールが無料プランの上限を超えています');
  return rules;
}
