import { createHash } from 'node:crypto';
import { CLOUDFRONT_HOST } from './environment';

export const sha256Hex = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');

export interface FunctionUrlEvent {
  version: '2.0';
  routeKey: '$default';
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string>;
  cookies?: string[];
  body?: string;
  isBase64Encoded: boolean;
  requestContext: { http: { method: string; path: string; protocol: string; sourceIp: string; userAgent: string } };
}

export interface LambdaResult { statusCode: number; headers: Record<string, string>; body: string; cookies?: string[] }

/**
 * CloudFront(/api/* ビヘイビア)経由で Lambda 関数URLに届くイベント(ペイロード 2.0)。
 * 関数URLはヘッダー名を小文字にし、CloudFront Function が x-forwarded-host を閲覧者の Host で上書きする。
 */
export function functionUrlEvent(method: string, url: string, init: { headers?: Record<string, string>; body?: string } = {}): FunctionUrlEvent {
  const parsed = new URL(url, `https://${CLOUDFRONT_HOST}`);
  const headers: Record<string, string> = { host: 'abc123.lambda-url.ap-northeast-1.on.aws', 'user-agent': 'integration-test' };
  for (const [key, value] of Object.entries(init.headers ?? {})) headers[key.toLowerCase()] = value;
  headers['x-forwarded-host'] = CLOUDFRONT_HOST;
  return {
    version: '2.0', routeKey: '$default',
    rawPath: parsed.pathname,
    rawQueryString: parsed.search.replace(/^\?/u, ''),
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
    isBase64Encoded: false,
    requestContext: { http: { method: method.toUpperCase(), path: parsed.pathname, protocol: 'HTTP/1.1', sourceIp: '203.0.113.10', userAgent: 'integration-test' } },
  };
}

type Handler = (event: FunctionUrlEvent) => Promise<LambdaResult>;

/** JSON API を呼ぶ小さなクライアント。POST/PUT/PATCH/DELETE には OAC が要求する x-amz-content-sha256 を付ける。 */
export function apiCaller(handler: Handler) {
  return async (method: string, path: string, options: { token?: string; body?: unknown; rawBody?: string } = {}) => {
    const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const headers: Record<string, string> = {};
    if (options.token) headers['X-Auth-Token'] = options.token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) headers['x-amz-content-sha256'] = sha256Hex(body ?? '');
    const result = await handler(functionUrlEvent(method, `/api${path}`, { headers, ...(body === undefined ? {} : { body }) }));
    if (process.env.INTEGRATION_DEBUG && result.statusCode >= 400) process.stdout.write(`DEBUG ${method} ${path} ${result.statusCode} ${result.body}\n`);
    const isJson = result.headers['content-type']?.startsWith('application/json') ?? false;
    return { ...result, json: isJson ? JSON.parse(result.body) as unknown : undefined };
  };
}
