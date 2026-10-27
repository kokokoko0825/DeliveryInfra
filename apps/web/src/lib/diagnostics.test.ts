import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearClientDiagnostics, downloadClientDiagnostics, installGlobalErrorHandlers, listClientDiagnostics, recordClientDiagnostic, recordClientEvent } from './diagnostics';

const memoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
};

describe('client diagnostics', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    clearClientDiagnostics();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    clearClientDiagnostics();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('stores structured errors and redacts JWT-like values', () => {
    recordClientDiagnostic(new Error('request failed eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature; Bearer access-secret'), 'test', { status: 503 });
    expect(listClientDiagnostics()).toMatchObject([{ source: 'test', message: 'request failed [REDACTED_TOKEN]; Bearer [REDACTED]', context: { status: 503 } }]);
    expect(console.error).toHaveBeenCalledWith('[client-diagnostic]', expect.objectContaining({ source: 'test' }));
    recordClientDiagnostic(new Error('validation failed'), 'test.validation', { status: 400 });
    expect(console.warn).toHaveBeenCalledWith('[client-diagnostic]', expect.objectContaining({ source: 'test.validation' }));
  });

  it('persists non-error capture settings without reporting a console error', () => {
    recordClientEvent('media.microphone.capture-settings', '処理状態を確認', { echoCancellation: false, credential: 'hidden' });
    expect(listClientDiagnostics()).toMatchObject([{ source: 'media.microphone.capture-settings', name: 'Event', message: '処理状態を確認', context: { echoCancellation: false, credential: '[REDACTED]' } }]);
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('redacts credentials, signed URL query strings, emails and local home paths from every field', () => {
    localStorage.setItem('deliveryinfra.client-diagnostics.v1', JSON.stringify([{
      id: 'old-1', at: new Date().toISOString(), source: 'old', name: 'Error',
      message: 'https://user:pass@example.test/resource?X-Amz-Signature=old-secret',
      path: '/Users/koshi/private', userAgent: 'test', context: { email: 'legacy@example.test' },
    }]));
    recordClientDiagnostic(
      new Error('request failed for https://user:pass@example.test/resource?X-Amz-Signature=secret'),
      'fetch https://user:pass@example.test/path?token=private',
      { authorization: 'Bearer private-token', email: 'person@example.test', filename: '/Users/koshi/project.ts' },
    );
    const serialized = JSON.stringify(listClientDiagnostics());
    expect(serialized).not.toContain('pass');
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('person@example.test');
    expect(serialized).not.toContain('/Users/koshi');
    expect(serialized).toContain('[REDACTED_QUERY]');
    expect(serialized).toContain('[REDACTED_EMAIL]');
    expect(serialized).toContain('"authorization":"[REDACTED]"');
  });

  it('redacts quoted JSON secret fields and sensitive context keys, including stored legacy entries', () => {
    localStorage.setItem('deliveryinfra.client-diagnostics.v1', JSON.stringify([{
      id: 'legacy-1', at: new Date().toISOString(), source: 'old', name: 'Error',
      message: '{"password":"legacy-secret"}', path: '/', userAgent: 'test', context: { accessToken: 'legacy-token' },
    }]));
    recordClientDiagnostic(new Error('{"password":"plain-secret", "accessToken":"opaque-token"}'), 'auth', {
      accessToken: 'opaque-token', password: 'plain-secret', note: 'ordinary detail',
    });
    const serialized = JSON.stringify(listClientDiagnostics());
    expect(serialized).not.toContain('legacy-secret');
    expect(serialized).not.toContain('legacy-token');
    expect(serialized).not.toContain('plain-secret');
    expect(serialized).not.toContain('opaque-token');
    expect(serialized).toContain('ordinary detail');
    expect(serialized).toContain('password=[REDACTED]');
  });

  it('validates and sanitizes every field in legacy entries before returning them', () => {
    localStorage.setItem('deliveryinfra.client-diagnostics.v1', JSON.stringify([
      null,
      { id: 1, at: 'now', source: 'invalid', name: 'Error', message: 'drop wrong id' },
      { id: 'bad-date-shape', at: 2, source: 'invalid', name: 'Error', message: 'drop wrong date' },
      { id: 'bad-source', at: 'now', source: false, name: 'Error', message: 'drop wrong source' },
      { id: 'bad-name', at: 'now', source: 'invalid', name: null, message: 'drop wrong name' },
      { id: 'bad-message', at: 'now', source: 'invalid', name: 'Error', message: null },
      {
        id: 'legacy-valid', at: 'now', source: 'safe@example.test', name: 'Error',
        message: 'safe', stack: 'stack', context: { safe: 'text', count: 2, enabled: true, empty: null, object: { ignored: true } },
        repeatCount: 2, lastSeenAt: 'later', path: '/Users/legacy/private', userAgent: 'legacy-agent',
      },
    ]));

    expect(listClientDiagnostics()).toEqual([expect.objectContaining({
      id: 'legacy-valid', source: '[REDACTED_EMAIL]', message: 'safe', stack: 'stack',
      context: { safe: 'text', count: 2, enabled: true, empty: null }, repeatCount: 2, lastSeenAt: 'later',
      path: '/[REDACTED_HOME]', userAgent: 'legacy-agent',
    })]);
  });

  it('retains in-memory diagnostics when reads return null and writes fail', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new DOMException('quota exceeded', 'QuotaExceededError'); },
      removeItem: () => undefined,
    });
    recordClientDiagnostic(new Error('storage quota'), 'storage');
    expect(listClientDiagnostics()).toMatchObject([{ source: 'storage', message: 'storage quota' }]);
  });

  it('keeps only the most recent 100 entries', () => {
    for (let index = 0; index < 105; index++) recordClientDiagnostic(new Error(`failure-${index}`), 'test');
    const entries = listClientDiagnostics();
    expect(entries).toHaveLength(100);
    expect(entries[0]?.message).toBe('failure-5');
    expect(entries.at(-1)?.message).toBe('failure-104');
  });

  it('keeps diagnostics available for export when browser storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      setItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      removeItem: () => { throw new DOMException('blocked', 'SecurityError'); },
    });
    recordClientDiagnostic(new Error('mic permission denied'), 'media.capture');
    expect(listClientDiagnostics()).toMatchObject([{ source: 'media.capture', message: 'mic permission denied' }]);
  });

  it('clears both persisted and in-memory diagnostics and ignores invalid stored data', () => {
    localStorage.setItem('deliveryinfra.client-diagnostics.v1', '{invalid json');
    expect(listClientDiagnostics()).toEqual([]);
    recordClientDiagnostic(new Error('temporary'), 'test');
    clearClientDiagnostics();
    expect(listClientDiagnostics()).toEqual([]);
    expect(localStorage.getItem('deliveryinfra.client-diagnostics.v1')).toBeNull();
  });

  it('uses a fallback identifier when crypto.randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => recordClientDiagnostic(new Error('crypto unavailable'), 'test')).not.toThrow();
    expect(listClientDiagnostics()).toMatchObject([{ source: 'test', message: 'crypto unavailable' }]);
  });

  it('aggregates repeated errors instead of flooding the log', () => {
    const firstId = recordClientDiagnostic(new Error('connection failed'), 'venue.peer', { peerId: '1:2' });
    const repeatedId = recordClientDiagnostic(new Error('connection failed'), 'venue.peer', { peerId: '1:2' });
    expect(repeatedId).toBe(firstId);
    expect(listClientDiagnostics()).toMatchObject([{ id: firstId, repeatCount: 2, context: { peerId: '1:2' } }]);
  });

  it('does not deduplicate changes in diagnostic source, name, message, or context, or entries past 30 seconds', () => {
    vi.useFakeTimers();
    const at = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(at);
    recordClientDiagnostic(new Error('same'), 'source', { peerId: 'a' });
    recordClientDiagnostic(new Error('same'), 'other-source', { peerId: 'a' });
    recordClientDiagnostic(new TypeError('same'), 'source', { peerId: 'a' });
    recordClientDiagnostic(new Error('different'), 'source', { peerId: 'a' });
    recordClientDiagnostic(new Error('same'), 'source', { peerId: 'b' });
    vi.advanceTimersByTime(30_001);
    recordClientDiagnostic(new Error('same'), 'source', { peerId: 'a' });
    expect(listClientDiagnostics()).toHaveLength(6);
    expect(listClientDiagnostics().every((entry) => entry.repeatCount === undefined)).toBe(true);
  });

  it('starts a new diagnostic exactly at the 30-second deduplication boundary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    recordClientDiagnostic(new Error('retry'), 'api.request');
    vi.advanceTimersByTime(30_000);
    recordClientDiagnostic(new Error('retry'), 'api.request');
    expect(listClientDiagnostics()).toHaveLength(2);
  });

  it('records empty path and user agent in server rendering environments', () => {
    vi.stubGlobal('location', undefined);
    vi.stubGlobal('navigator', undefined);
    recordClientDiagnostic(new Error('server rendering'), 'ssr');
    expect(listClientDiagnostics()).toMatchObject([{ path: '', userAgent: '' }]);
  });

  it('distinguishes client and server logging and preserves errors when no browser window exists', () => {
    vi.stubGlobal('window', undefined);
    recordClientDiagnostic(new Error('server failure'), 'server', { status: 500 });
    expect(console.error).toHaveBeenCalledWith('[client-diagnostic]', expect.objectContaining({ source: 'server' }));
    expect(() => recordClientDiagnostic(new Error('server warning'), 'server', { status: 400 })).not.toThrow();
    expect(console.warn).toHaveBeenCalledWith('[client-diagnostic]', expect.objectContaining({ source: 'server' }));
    expect(listClientDiagnostics()).toHaveLength(2);
  });

  it('treats HTTP 500 as an error rather than a warning', () => {
    recordClientDiagnostic(new Error('server error'), 'api.request', { status: 500 });
    expect(console.error).toHaveBeenCalledWith('[client-diagnostic]', expect.objectContaining({ source: 'api.request' }));
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('captures global runtime errors and removes its handlers on cleanup', () => {
    const uninstall = installGlobalErrorHandlers();
    window.dispatchEvent(new ErrorEvent('error', { message: 'runtime failure', filename: '/Users/private/app.js', lineno: 8, colno: 2 }));
    expect(listClientDiagnostics()).toMatchObject([{ source: 'window.error', message: 'runtime failure', context: { filename: '/[REDACTED_HOME]', line: 8, column: 2 } }]);
    const rejection = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(rejection, 'reason', { value: new Error('unhandled async failure') });
    window.dispatchEvent(rejection);
    expect(listClientDiagnostics()).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'window.unhandledrejection', message: 'unhandled async failure' })]));
    uninstall();
    window.dispatchEvent(new ErrorEvent('error', { message: 'ignored after cleanup' }));
    window.dispatchEvent(rejection);
    expect(listClientDiagnostics()).toHaveLength(2);
  });

  it('records an export failure and rethrows it for the UI to report', () => {
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => { throw new Error('download denied'); }, revokeObjectURL: vi.fn() });
    expect(downloadClientDiagnostics).toThrow('download denied');
    expect(listClientDiagnostics()).toMatchObject([{ source: 'diagnostics.export', message: 'download denied' }]);
  });

  it('exports the sanitized diagnostic payload and revokes its object URL', async () => {
    vi.useFakeTimers();
    const blobs: { parts: BlobPart[]; type: string }[] = [];
    class TestBlob {
      type: string;
      constructor(public readonly parts: BlobPart[], options?: BlobPropertyBag) { this.type = options?.type ?? ''; }
    }
    vi.stubGlobal('Blob', TestBlob);
    const urlApi = { createObjectURL: vi.fn((blob: TestBlob) => { blobs.push(blob); return 'blob:diagnostics'; }), revokeObjectURL: vi.fn() };
    vi.stubGlobal('URL', urlApi);
    let downloadName = '';
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloadName = this.download; });
    recordClientDiagnostic(new Error('failed'), 'export.test');

    downloadClientDiagnostics();

    expect(click).toHaveBeenCalledOnce();
    expect(urlApi.createObjectURL).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(blobs[0]?.parts[0])) as { schemaVersion: number; entries: { source: string }[] };
    expect(payload).toMatchObject({ schemaVersion: 1, entries: [expect.objectContaining({ source: 'export.test' })] });
    expect(blobs[0]?.type).toBe('application/json;charset=utf-8');
    expect(downloadName).toMatch(/^deliveryinfra-diagnostics-.*\.json$/u);
    vi.runAllTimers();
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:diagnostics');
  });
});
