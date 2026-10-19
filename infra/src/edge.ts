/**
 * CloudFront の振る舞い(パス)とセキュリティヘッダーの組み立て。
 * CloudFront 無料プランではカスタムのレスポンスヘッダーポリシーが使えないため、
 * ヘッダー付与・SPA フォールバック・パス書き換えは CloudFront Functions で行う。
 */

export const API_PATH = '/api/*';
export const FILES_PATH = '/files/*';
export const ARCHIVES_PATH = '/files/archives/*';
/** U-02 のダイアログ内 iframe で PDF を表示するため、ここだけ同一オリジンからの埋め込みを許可する(F-SLD-03)。 */
export const SLIDES_PATH = '/files/slides/*';
export const FILES_PREFIX = '/files';
export const ARCHIVES_PREFIX = '/files/archives';

export interface CspInput {
  region: string;
  /** Cognito Hosted UI のホスト名(例: xxx.auth.ap-northeast-1.amazoncognito.com) */
  cognitoDomain: string;
  /** presigned POST の送信先(例: bucket.s3.ap-northeast-1.amazonaws.com) */
  uploadHost: string;
}

/** deny: どこからも埋め込み不可(既定)。sameorigin: 同一オリジンの iframe のみ可(スライド PDF)。 */
export type Framing = 'deny' | 'sameorigin';

/** IVS Real-Time(WebRTC/WSS)・IVS Chat・Cognito を許可した CSP。 */
export function buildCsp({ region, cognitoDomain, uploadHost }: CspInput, framing: Framing = 'deny'): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'"],
    'media-src': ["'self'", 'blob:'],
    'worker-src': ["'self'", 'blob:'],
    'connect-src': [
      "'self'",
      'https://*.live-video.net',
      'wss://*.live-video.net',
      `wss://edge.ivschat.${region}.amazonaws.com`,
      `https://cognito-idp.${region}.amazonaws.com`,
      `https://${cognitoDomain}`,
      `https://${uploadHost}`,
    ],
    'form-action': ["'self'", `https://${cognitoDomain}`],
    'frame-ancestors': [framing === 'deny' ? "'none'" : "'self'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

export function buildSecurityHeaders(csp: string, framing: Framing = 'deny'): Record<string, string> {
  return {
    'strict-transport-security': 'max-age=63072000; includeSubDomains',
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'x-frame-options': framing === 'deny' ? 'DENY' : 'SAMEORIGIN',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(self), microphone=(self), display-capture=(self), geolocation=()',
  };
}

/** viewer-response: すべての応答にセキュリティヘッダーを上書きで付与する。 */
export function securityHeadersFunctionCode(headers: Record<string, string>): string {
  return [
    `var HEADERS = ${JSON.stringify(headers)};`,
    'function handler(event) {',
    '  var response = event.response;',
    '  for (var name in HEADERS) { response.headers[name] = { value: HEADERS[name] }; }',
    '  return response;',
    '}',
  ].join('\n');
}

/**
 * viewer-request(既定ビヘイビアのみ): 拡張子のないパスを /index.html に書き換える SPA フォールバック。
 * /api と /files は別ビヘイビアなので影響しない(エラーページ置換を使わない理由)。
 */
export function spaRewriteFunctionCode(): string {
  return [
    'function handler(event) {',
    '  var request = event.request;',
    "  var last = request.uri.split('/').pop();",
    "  if (last.indexOf('.') === -1) { request.uri = '/index.html'; }",
    '  return request;',
    '}',
  ].join('\n');
}

/** viewer-request: パス先頭のプレフィックスを外して S3 のキーに合わせる(/files/slides/a.pdf → /slides/a.pdf)。 */
export function stripPrefixFunctionCode(prefix: string): string {
  if (!/^\/[a-z0-9/-]+[a-z0-9]$/.test(prefix)) throw new Error(`不正なプレフィックスです: ${prefix}`);
  return [
    'function handler(event) {',
    '  var request = event.request;',
    `  request.uri = request.uri.substring(${prefix.length});`,
    '  return request;',
    '}',
  ].join('\n');
}

/**
 * viewer-request(/api/*): 閲覧者が見ている Host を x-forwarded-host に必ず上書きして API に渡す。
 * OAC が Host を Lambda 関数URLのホストに置き換えるため。クライアント送信値は信用しない。
 */
export function forwardedHostFunctionCode(): string {
  return [
    'function handler(event) {',
    '  var request = event.request;',
    "  request.headers['x-forwarded-host'] = { value: request.headers.host.value };",
    '  return request;',
    '}',
  ].join('\n');
}
