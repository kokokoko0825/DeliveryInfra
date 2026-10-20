import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginVenueRttSession,
  endVenueRttSession,
  readVenueRttSessions,
  recordVenueRtt,
  venueRttCsv,
} from './venueRttLog';

describe('venue RTT log', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
    vi.stubGlobal('navigator', { userAgent: 'test-browser' });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('stores timestamped samples and session end locally', () => {
    const started = new Date('2026-10-20T01:00:00.000Z');
    const sampled = new Date('2026-10-20T01:00:01.000Z');
    const ended = new Date('2026-10-20T01:00:02.000Z');
    const id = beginVenueRttSession(started);
    recordVenueRtt(id, 24.567, sampled);
    endVenueRttSession(id, ended);

    expect(readVenueRttSessions()).toEqual([{
      id,
      startedAt: started.toISOString(),
      endedAt: ended.toISOString(),
      userAgent: 'test-browser',
      samples: [{ at: sampled.toISOString(), rttMs: 24.57 }],
    }]);
  });

  it('ignores invalid samples and exports quoted CSV with session metadata', () => {
    const id = beginVenueRttSession(new Date('2026-10-20T01:00:00.000Z'));
    recordVenueRtt(id, Number.NaN);
    recordVenueRtt(id, -1);
    recordVenueRtt(id, 8.25);
    const session = readVenueRttSessions()[0]!;
    session.userAgent = 'browser, "test"';
    const csv = venueRttCsv([session]);

    expect(session.samples).toHaveLength(1);
    expect(csv).toContain('"session_id","session_started_at"');
    expect(csv).toContain('"browser, ""test"""');
    expect(csv).not.toContain('NaN');
  });
});
