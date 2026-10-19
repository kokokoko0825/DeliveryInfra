import { Stack, type StackProps, aws_pricingplanmanager as ppm } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/**
 * CloudFront フラットレート料金プラン(Free)のサブスクリプション。
 * ディストリビューション(東京スタック)と WebACL(us-east-1)の両方ができた後に作る必要があるため、
 * 東京スタックの後に us-east-1 へデプロイする。
 */
export class PricingPlanStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { distributionArn: string; webAclArn: string }) {
    super(scope, id, props);
    new ppm.CfnSubscription(this, 'CloudFrontFreePlan', {
      planFamily: 'CloudFront',
      planTier: 'FREE',
      usageLevel: 'DEFAULT',
      resourceArns: [props.distributionArn, props.webAclArn],
    });
  }
}
