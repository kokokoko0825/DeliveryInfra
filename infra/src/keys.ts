/**
 * 署名鍵が未登録のときに使う公開鍵。対応する秘密鍵は生成直後に破棄しており存在しない。
 * これを使うと /files/* の署名付きCookie が必ず検証に失敗する(フェイルクローズ)。
 * scripts/cloudfront-keypair.sh で本物の鍵を作り infra/keys/<env>-cloudfront-public.pem に置くこと。
 */
export const FAIL_CLOSED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjBrRSg3BREbV+UmEYFdw
j+56COUUoV13Q3yBSxkWO7Atrc4WS2ClGv7fEUuNzw4PTIZuY7NC9JhdIYuuRZNL
JA13of0UTz8XyrwGdTxeMKSsiPYOuZScuZ0z1xyDC1dZmgakH89pP0M1Qyd+dzLE
ZMwUf6Qi56TEuzrhD753lxUvId/gCJ8qBYXjNp1/XoivV12LjkmyAm2MiN2cdBbC
nDOb3M/l1mBSfTAZ2v4Ryqe0at6nPxpHkYMsWkjF0WoMfjuk1B8F2VDDnOGm3Lwo
WSLOPq0V3dm/3wY+1yP+zSViyU0aGzHfapZlx5XT7rfb7IXJK1EVr+PaZMUVcV4M
4wIDAQAB
-----END PUBLIC KEY-----
`;

export const publicKeyPath = (envName: string) => `keys/${envName}-cloudfront-public.pem`;

export function validatePublicKeyPem(pem: string): string {
  const trimmed = pem.trim();
  if (!trimmed.startsWith('-----BEGIN PUBLIC KEY-----') || !trimmed.endsWith('-----END PUBLIC KEY-----')) {
    throw new Error('CloudFront 公開鍵は PEM(SPKI) 形式にしてください');
  }
  return `${trimmed}\n`;
}
