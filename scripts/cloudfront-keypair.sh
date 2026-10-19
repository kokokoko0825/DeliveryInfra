#!/usr/bin/env bash
# CloudFront 署名付きCookie(/files/*)用の鍵ペアを作る。
#   秘密鍵: SSM Parameter Store の SecureString(/delivery-<env>/cloudfront/private-key)にだけ保存し、ディスクに残さない
#   公開鍵: infra/keys/<env>-cloudfront-public.pem に書き出す(コミットして CDK の PublicKey に使う)
# 使い方: scripts/cloudfront-keypair.sh stg   (AWS 認証済みのシェルで実行)
# 鍵を作り直した後は cdk deploy で公開鍵を差し替える。発行済みの Cookie(有効1時間)は無効になる。
set -euo pipefail

ENV_NAME="${1:-}"
case "$ENV_NAME" in
  stg | prod) ;;
  *) echo "usage: $0 <stg|prod>" >&2; exit 1 ;;
esac

REGION="ap-northeast-1"
PARAMETER="/delivery-${ENV_NAME}/cloudfront/private-key"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC_KEY="${ROOT}/infra/keys/${ENV_NAME}-cloudfront-public.pem"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"

openssl genrsa -out "$WORK/private.pem" 2048 2>/dev/null
openssl rsa -pubout -in "$WORK/private.pem" -out "$WORK/public.pem" 2>/dev/null

# 先に秘密鍵を登録し、成功したときだけ公開鍵を置き換える(片方だけ更新される不整合を防ぐ)。
aws ssm put-parameter \
  --region "$REGION" \
  --name "$PARAMETER" \
  --type SecureString \
  --value "file://$WORK/private.pem" \
  --overwrite >/dev/null

mkdir -p "$(dirname "$PUBLIC_KEY")"
cp "$WORK/public.pem" "$PUBLIC_KEY"
echo "秘密鍵: SSM ${PARAMETER} (SecureString)"
echo "公開鍵: ${PUBLIC_KEY}"
