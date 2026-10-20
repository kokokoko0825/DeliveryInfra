/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendVenueRunRecord, createVenueRun, deleteVenueRun, exportVenueRun, listVenueRuns,
  readVenueRun, type VenueRunRecord,
} from './venueRunLog';

type Row = Record<string, any>;
const dbState = { runs: new Map<string, Row>(), records: new Map<string, Row>(), failOpen: false, corrupt: false };
const keyString = (key: any) => JSON.stringify(key);
function makeFakeIndexedDB() {
  const db: any = {
    objectStoreNames: { contains: () => true }, close: () => undefined,
    transaction: () => {
      const tx: any = { error: null, aborted: false, pending: 0, oncomplete: null, onabort: null, onerror: null };
      const schedule = (action: () => any) => {
        tx.pending++;
        const req: any = {};
        queueMicrotask(() => {
          try { req.result = action(); req.onsuccess?.(); }
          catch (e) { req.error = e; req.onerror?.(); tx.error = e; tx.onabort?.(); }
          tx.pending--;
          if (!tx.pending && !tx.aborted) queueMicrotask(() => tx.oncomplete?.());
        });
        return req;
      };
      tx.abort = () => { tx.aborted = true; queueMicrotask(() => tx.onabort?.()); };
      tx.objectStore = (name: string) => {
        const map = name === 'runs' ? dbState.runs : dbState.records;
        const store: any = {
          get: (key: any) => schedule(() => map.get(keyString(key))),
          add: (value: Row) => schedule(() => { const k = keyString(name === 'runs' ? value.id : [value.runId, value.id]); if (map.has(k)) throw Error('constraint'); map.set(k, structuredClone(value)); return k; }),
          put: (value: Row) => schedule(() => { const k = keyString(value.id); map.set(k, structuredClone(value)); return k; }),
          delete: (key: any) => schedule(() => map.delete(keyString(key))),
          getAll: () => schedule(() => [...map.values()].map((v) => structuredClone(v))),
          createIndex: () => undefined,
          index: () => ({
            getAll: (range: any) => schedule(() => [...dbState.records.values()].filter((v) => v.runId === range.value).map((v) => structuredClone(v))),
            getAllKeys: (range: any) => schedule(() => [...dbState.records.values()].filter((v) => v.runId === range.value).map((v) => [v.runId, v.id])),
            count: (range: any) => schedule(() => [...dbState.records.values()].filter((v) => v.runId === range.value).length),
          }),
        };
        return store;
      };
      return tx;
    },
  };
  return { open: () => {
    const req: any = {};
    queueMicrotask(() => {
      if (dbState.failOpen) { req.error = Error('database unavailable'); req.onerror?.(); }
      else { req.result = db; req.onsuccess?.(); }
    });
    return req;
  } };
}

describe('venue run log', () => {
  beforeEach(() => vi.stubGlobal('IDBKeyRange', { only: (value: string) => ({ value }) }));
  afterEach(() => { vi.unstubAllGlobals(); dbState.runs.clear(); dbState.records.clear(); dbState.failOpen = false; dbState.corrupt = false; });

  it('retains data after close/reopen and deduplicates records by run and record ID', async () => {
    vi.stubGlobal('indexedDB', makeFakeIndexedDB());
    const metadata = { id: 'run-1', startedAtUtc: '2026-10-20T01:00:00.000Z', userAgent: 'test', peers: ['p1'] };
    await createVenueRun(metadata);
    const sample: VenueRunRecord = { type: 'health', id: 'h1', atUtc: '2026-10-20T01:00:01Z', elapsedMs: 1000, peerId: 'p1', values: { rttMs: 12 } };
    expect(await appendVenueRunRecord(metadata.id, sample)).toBe(true);
    expect(await appendVenueRunRecord(metadata.id, sample)).toBe(false);
    expect((await readVenueRun(metadata.id))?.healthSamples).toEqual([sample]);
    expect(await listVenueRuns()).toHaveLength(1);
  });

  it('fails clearly for unavailable or corrupt database state and missing run IDs', async () => {
    vi.stubGlobal('indexedDB', makeFakeIndexedDB());
    dbState.failOpen = true;
    await expect(listVenueRuns()).rejects.toThrow('database unavailable');
    dbState.failOpen = false;
    await expect(appendVenueRunRecord('missing', { type: 'error', id: 'e', atUtc: '2026-10-20T00:00:00Z', elapsedMs: 0, code: 'x', message: 'x' })).rejects.toThrow('not found');
    dbState.runs.set('"broken"', { id: 'broken', schemaVersion: 999 });
    await expect(exportVenueRun('broken')).rejects.toThrow();
  });

  it('rejects local wall-clock timestamps so UTC and monotonic elapsed time stay separate', async () => {
    vi.stubGlobal('indexedDB', makeFakeIndexedDB());
    await createVenueRun({ id: 'utc-check', startedAtUtc: '2026-10-20T01:00:00Z', userAgent: '', peers: [] });
    await expect(appendVenueRunRecord('utc-check', {
      type: 'health', id: 'bad-time', atUtc: '2026-10-20T01:00:01', elapsedMs: 1000, values: {},
    })).rejects.toThrow('valid UTC timestamp');
  });

  it('exports quoted UTF-8 BOM CSV with schema version and no large-count truncation', async () => {
    vi.stubGlobal('indexedDB', makeFakeIndexedDB());
    const id = 'run-csv';
    await createVenueRun({ id, startedAtUtc: '2026-10-20T01:00:00Z', userAgent: 'agent, "quoted"', peers: [] });
    for (let i = 0; i < 1250; i++) {
      await appendVenueRunRecord(id, { type: 'peer', id: `r${i}`, atUtc: '2026-10-20T01:00:01Z', elapsedMs: i, peerId: 'peer, "1"', event: 'connected' });
    }
    const result = await exportVenueRun(id);
    expect(result.csv.charCodeAt(0)).toBe(0xfeff);
    expect(result.csv).toContain('"schema_version","run_id","record_type"');
    expect(result.csv).toContain('"peer, ""1"""');
    expect(result.csv.match(/\r\n/g)).toHaveLength(1250);
    expect(JSON.parse(result.manifestJson).summary.totalRecordCount).toBe(1250);
  });

  it('deletes the run and all its records', async () => {
    vi.stubGlobal('indexedDB', makeFakeIndexedDB());
    await createVenueRun({ id: 'delete-me', startedAtUtc: '2026-10-20T00:00:00Z', userAgent: '', peers: [] });
    expect(await deleteVenueRun('delete-me')).toBe(true);
    expect(await readVenueRun('delete-me')).toBeUndefined();
  });
});
