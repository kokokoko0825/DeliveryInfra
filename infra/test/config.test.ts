import { describe, expect, it } from 'vitest';
import {
  MAIN_REGION,
  createLookup,
  loadConfig,
  parseBoolean,
  parseEnvName,
  parseOkta,
  validateDomainPrefix,
} from '../src/config.ts';

const lookupFrom = (values: Record<string, string>) => createLookup((key) => values[key], {});

describe('parseEnvName', () => {
  it('未指定は stg', () => expect(parseEnvName(undefined)).toBe('stg'));
  it.each(['stg', 'prod'])('%s を受け付ける', (name) => expect(parseEnvName(name)).toBe(name));
  it.each(['dev', 'STG', ''])('%s は拒否', (name) => expect(() => parseEnvName(name)).toThrow('stg / prod'));
});

describe('parseBoolean', () => {
  it('未指定は既定値', () => {
    expect(parseBoolean(undefined, true)).toBe(true);
    expect(parseBoolean(undefined, false)).toBe(false);
  });
  it('true / false を解釈', () => {
    expect(parseBoolean('true', false)).toBe(true);
    expect(parseBoolean('false', true)).toBe(false);
  });
  it('それ以外は拒否', () => expect(() => parseBoolean('yes', true)).toThrow('true / false'));
});

describe('validateDomainPrefix', () => {
  it.each(['delivery-stg', 'a', 'x1-2'])('%s を受け付ける', (prefix) => expect(validateDomainPrefix(prefix)).toBe(prefix));
  it.each(['-bad', 'bad-', 'Upper', 'my-aws', 'amazon-x', 'cognito1', 'a'.repeat(64), 'has_underscore'])(
    '%s は拒否',
    (prefix) => expect(() => validateDomainPrefix(prefix)).toThrow('ドメインプレフィックス'),
  );
  it('63文字までは許可', () => expect(validateDomainPrefix('a'.repeat(63))).toHaveLength(63));
});

describe('parseOkta', () => {
  const ok = ['https://example.okta.com', 'client', '/delivery-stg/okta/client-secret'] as const;
  it('全て未指定なら無効', () => expect(parseOkta()).toBeUndefined());
  it('全て指定で有効', () =>
    expect(parseOkta(...ok)).toEqual({ issuer: ok[0], clientId: ok[1], clientSecretParameter: ok[2] }));
  it.each([
    [undefined, ok[1], ok[2]],
    [ok[0], undefined, ok[2]],
    [ok[0], ok[1], undefined],
  ])('一部だけの指定は拒否 (%s, %s, %s)', (a, b, c) => expect(() => parseOkta(a, b, c)).toThrow('すべて指定'));
  it('issuer は https 必須', () => expect(() => parseOkta('http://x', ok[1], ok[2])).toThrow('https://'));
  it('secret はパラメータ名(/始まり)のみ', () =>
    expect(() => parseOkta(ok[0], ok[1], 'raw-secret-value')).toThrow('SSM パラメータ名'));
});

describe('loadConfig', () => {
  it('既定値(stg)', () => {
    const config = loadConfig(lookupFrom({}));
    expect(config).toEqual({
      envName: 'stg',
      prefix: 'delivery-stg',
      account: undefined,
      region: MAIN_REGION,
      sesFromEmail: undefined,
      okta: undefined,
      cognitoDomainPrefix: undefined,
      cloudFrontPrivateKeyParameter: '/delivery-stg/cloudfront/private-key',
      cloudFrontFreePlan: true,
      createTrail: true,
      retainData: false,
    });
  });
  it('prod はデータを保持し、各値を context から読む', () => {
    const config = loadConfig(
      lookupFrom({
        env: 'prod',
        account: '123456789012',
        sesFromEmail: 'no-reply@example.com',
        cognitoDomainPrefix: 'my-login',
        cloudFrontFreePlan: 'false',
        cloudTrail: 'false',
        oktaIssuer: 'https://example.okta.com',
        oktaClientId: 'abc',
        oktaClientSecretParameter: '/p/okta',
      }),
    );
    expect(config).toMatchObject({
      envName: 'prod',
      prefix: 'delivery-prod',
      account: '123456789012',
      sesFromEmail: 'no-reply@example.com',
      cognitoDomainPrefix: 'my-login',
      cloudFrontFreePlan: false,
      createTrail: false,
      retainData: true,
      cloudFrontPrivateKeyParameter: '/delivery-prod/cloudfront/private-key',
      okta: { issuer: 'https://example.okta.com', clientId: 'abc', clientSecretParameter: '/p/okta' },
    });
  });
  it('不正なドメインプレフィックスは拒否', () =>
    expect(() => loadConfig(lookupFrom({ cognitoDomainPrefix: 'aws-login' }))).toThrow());
});

describe('createLookup', () => {
  it('context を環境変数より優先', () => {
    const lookup = createLookup((key) => ({ env: 'prod' })[key], { DELIVERY_ENV: 'stg' });
    expect(lookup('env', 'DELIVERY_ENV')).toBe('prod');
  });
  it('context がなければ環境変数', () => {
    const lookup = createLookup(() => undefined, { DELIVERY_SES_FROM_EMAIL: 'a@example.com' });
    expect(lookup('sesFromEmail', 'DELIVERY_SES_FROM_EMAIL')).toBe('a@example.com');
  });
  it('文字列以外の context は無視', () => {
    const lookup = createLookup(() => 1, { X: 'env' });
    expect(lookup('x', 'X')).toBe('env');
  });
  it('空文字は未設定扱い', () => {
    expect(createLookup(() => '', {})('x', 'X')).toBeUndefined();
    expect(createLookup(() => undefined, { X: '' })('x', 'X')).toBeUndefined();
  });
});
