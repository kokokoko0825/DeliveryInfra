import { Stack, type StackProps, aws_wafv2 as wafv2 } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { buildWafRules } from '../waf.ts';

/** CloudFront 用 WebACL。スコープ CLOUDFRONT は us-east-1 にしか作れないため別スタックにする。 */
export class EdgeWafStack extends Stack {
  readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: StackProps & { prefix: string }) {
    super(scope, id, props);
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `${props.prefix}-cloudfront`,
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `${props.prefix}-cloudfront`, sampledRequestsEnabled: true },
      rules: buildWafRules(),
    });
    this.webAclArn = webAcl.attrArn;
  }
}
