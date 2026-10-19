import { describe, expect, it } from 'vitest';
import {
  buildCsp,
  buildSecurityHeaders,
  forwardedHostFunctionCode,
  securityHeadersFunctionCode,
  spaRewriteFunctionCode,
  stripPrefixFunctionCode,
} from '../src/edge.ts';

type Handler = (event: unknown) => { uri?: string; headers: Record<string, { value: string }> };
/** CloudFront Functions のコードを実際に評価して挙動を確かめる。 */
const load = (code: string) => new Function(`${code}\nreturn handler;`)() as Handler;

const input = { region: 'ap-northeast-1', cognitoDomain: 'login.auth.ap-northeast-1.amazoncognito.com', uploadHost: 'b.s3.ap-northeast-1.amazonaws.com' };

describe('buildCsp', () => {
  const directives = Object.fromEntries(
    buildCsp(input)
      .split('; ')
      .map((d) => {
        const [name, ...sources] = d.split(' ');
        return [name, sources];
      }),
  );

  it('クリックジャッキング・外部スクリプトを禁止', () => {
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
    expect(directives['default-src']).toEqual(["'self'"]);
    expect(directives['object-src']).toEqual(["'none'"]);
    expect(directives['base-uri']).toEqual(["'self'"]);
    expect(directives['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(directives['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directives['img-src']).toEqual(["'self'", 'data:', 'blob:']);
    expect(directives['font-src']).toEqual(["'self'"]);
  });
  it('IVS(WebRTC/WSS)・IVS Chat・Cognito・アップロード先に接続できる', () => {
    expect(directives['connect-src']).toEqual([
      "'self'",
      'https://*.live-video.net',
      'wss://*.live-video.net',
      'wss://edge.ivschat.ap-northeast-1.amazonaws.com',
      'https://cognito-idp.ap-northeast-1.amazonaws.com',
      'https://login.auth.ap-northeast-1.amazoncognito.com',
      'https://b.s3.ap-northeast-1.amazonaws.com',
    ]);
    expect(directives['form-action']).toEqual(["'self'", 'https://login.auth.ap-northeast-1.amazoncognito.com']);
  });
  it('IVS SDK が使う blob の worker/media を許可', () => {
    expect(directives['worker-src']).toEqual(["'self'", 'blob:']);
    expect(directives['media-src']).toEqual(["'self'", 'blob:']);
  });
});

describe('buildCsp(sameorigin)', () => {
  it('スライド PDF 用は frame-ancestors だけを self にし、他の指令は同じ', () => {
    const deny = buildCsp(input);
    const same = buildCsp(input, 'sameorigin');
    expect(same).toContain("frame-ancestors 'self'");
    expect(same).not.toContain("frame-ancestors 'none'");
    expect(same.replace("frame-ancestors 'self'", "frame-ancestors 'none'")).toBe(deny);
  });
});

describe('buildSecurityHeaders', () => {
  it('sameorigin は X-Frame-Options だけ SAMEORIGIN', () => {
    const deny = buildSecurityHeaders('csp-value');
    expect(buildSecurityHeaders('csp-value', 'sameorigin')).toEqual({ ...deny, 'x-frame-options': 'SAMEORIGIN' });
    expect(buildSecurityHeaders('csp-value', 'deny')).toEqual(deny);
  });
  it('HSTS・CSP・nosniff・フレーム禁止などを含む', () => {
    expect(buildSecurityHeaders('csp-value')).toEqual({
      'strict-transport-security': 'max-age=63072000; includeSubDomains',
      'content-security-policy': 'csp-value',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'permissions-policy': 'camera=(self), microphone=(self), display-capture=(self), geolocation=()',
    });
  });
});

describe('securityHeadersFunctionCode', () => {
  it('既存ヘッダーを残し、セキュリティヘッダーを上書きする', () => {
    const handler = load(securityHeadersFunctionCode({ 'x-a': '1', 'x-b': '2' }));
    const result = handler({ response: { headers: { 'x-a': { value: 'old' }, 'content-type': { value: 'text/html' } } } });
    expect(result.headers).toEqual({
      'x-a': { value: '1' },
      'x-b': { value: '2' },
      'content-type': { value: 'text/html' },
    });
  });
});

describe('spaRewriteFunctionCode', () => {
  const handler = load(spaRewriteFunctionCode());
  const rewrite = (uri: string) => handler({ request: { uri, headers: {} } }).uri;
  it.each(['/', '/watch', '/admin/users', '/archives/abc'])('%s は index.html', (uri) => expect(rewrite(uri)).toBe('/index.html'));
  it.each(['/assets/app.js', '/config.json', '/favicon.ico'])('%s はそのまま', (uri) => expect(rewrite(uri)).toBe(uri));
});

describe('stripPrefixFunctionCode', () => {
  it('/files を外す', () => {
    const handler = load(stripPrefixFunctionCode('/files'));
    expect(handler({ request: { uri: '/files/slides/a.pdf', headers: {} } }).uri).toBe('/slides/a.pdf');
  });
  it('/files/archives を外す', () => {
    const handler = load(stripPrefixFunctionCode('/files/archives'));
    expect(handler({ request: { uri: '/files/archives/st/se/d/composite/media/hls/multivariant.m3u8', headers: {} } }).uri).toBe(
      '/st/se/d/composite/media/hls/multivariant.m3u8',
    );
  });
  it.each(['files', '/files/', "/x';alert(1)//", '/A'])('不正なプレフィックス %s は拒否', (prefix) =>
    expect(() => stripPrefixFunctionCode(prefix)).toThrow('不正なプレフィックス'),
  );
});

describe('forwardedHostFunctionCode', () => {
  it('クライアントの x-forwarded-host を閲覧者の Host で上書きする', () => {
    const handler = load(forwardedHostFunctionCode());
    const result = handler({
      request: { uri: '/api/me', headers: { host: { value: 'd111.cloudfront.net' }, 'x-forwarded-host': { value: 'evil.example' } } },
    });
    expect(result.headers['x-forwarded-host']).toEqual({ value: 'd111.cloudfront.net' });
    expect(result.uri).toBe('/api/me');
  });
});
