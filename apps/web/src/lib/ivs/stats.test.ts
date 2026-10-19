import { describe, expect, it } from 'vitest';
import { bitrateKbps, formatBitrate, sumOutboundBytes } from './stats';

describe('sumOutboundBytes', () => {
  const report = [
    { type: 'outbound-rtp', kind: 'video', bytesSent: 1000, timestamp: 10 },
    { type: 'outbound-rtp', mediaType: 'audio', bytesSent: 200, timestamp: 12 },
    { type: 'inbound-rtp', kind: 'video', bytesSent: 999, timestamp: 50 },
    { type: 'outbound-rtp', kind: 'video', timestamp: 5 },
  ];
  it('sums all outbound streams with the latest timestamp', () => {
    expect(sumOutboundBytes(report)).toEqual({ bytes: 1200, timestampMs: 12 });
  });
  it('filters by kind (kind or legacy mediaType)', () => {
    expect(sumOutboundBytes(report, 'video')).toEqual({ bytes: 1000, timestampMs: 10 });
    expect(sumOutboundBytes(report, 'audio')).toEqual({ bytes: 200, timestampMs: 12 });
  });
  it('returns null when there is no outbound stream', () => {
    expect(sumOutboundBytes([{ type: 'inbound-rtp' }])).toBeNull();
    expect(sumOutboundBytes([])).toBeNull();
  });
  it('treats a missing timestamp as 0', () => {
    expect(sumOutboundBytes([{ type: 'outbound-rtp', bytesSent: 5 }])).toEqual({ bytes: 5, timestampMs: 0 });
  });
});

describe('bitrateKbps', () => {
  it('computes kbps from byte deltas (bits per millisecond)', () => {
    expect(bitrateKbps({ bytes: 0, timestampMs: 0 }, { bytes: 250_000, timestampMs: 1000 })).toBe(2000);
    expect(bitrateKbps({ bytes: 100, timestampMs: 1000 }, { bytes: 100, timestampMs: 2000 })).toBe(0);
  });
  it('returns null for missing samples, no elapsed time, or counter reset', () => {
    expect(bitrateKbps(null, { bytes: 1, timestampMs: 1 })).toBeNull();
    expect(bitrateKbps({ bytes: 1, timestampMs: 1 }, null)).toBeNull();
    expect(bitrateKbps({ bytes: 1, timestampMs: 5 }, { bytes: 10, timestampMs: 5 })).toBeNull();
    expect(bitrateKbps({ bytes: 1, timestampMs: 5 }, { bytes: 10, timestampMs: 4 })).toBeNull();
    expect(bitrateKbps({ bytes: 10, timestampMs: 1 }, { bytes: 9, timestampMs: 2 })).toBeNull();
  });
});

describe('formatBitrate', () => {
  it('formats kbps and Mbps', () => {
    expect(formatBitrate(null)).toBe('—');
    expect(formatBitrate(999)).toBe('999 kbps');
    expect(formatBitrate(1000)).toBe('1.00 Mbps');
    expect(formatBitrate(2534)).toBe('2.53 Mbps');
  });
});
