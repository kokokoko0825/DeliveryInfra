export type VenueRttSample = { at: string; rttMs: number };
export type VenueRttSession = {
  id: string;
  startedAt: string;
  endedAt?: string;
  userAgent: string;
  samples: VenueRttSample[];
};

const storageKey = 'venue-speaker-rtt-v1';
const maxSessions = 20;
const maxSamplesPerSession = 3600;

export function readVenueRttSessions(): VenueRttSession[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(value) ? (value as VenueRttSession[]) : [];
  } catch {
    return [];
  }
}

function writeVenueRttSessions(sessions: VenueRttSession[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(sessions.slice(0, maxSessions)));
  } catch {
    // Storage may be disabled or full; RTT display and playback continue.
  }
}

export function beginVenueRttSession(now = new Date()): string {
  const id = `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessions = readVenueRttSessions();
  sessions.unshift({ id, startedAt: now.toISOString(), userAgent: navigator.userAgent, samples: [] });
  writeVenueRttSessions(sessions);
  return id;
}

export function recordVenueRtt(sessionId: string, rttMs: number, now = new Date()) {
  const sessions = readVenueRttSessions();
  const session = sessions.find((item) => item.id === sessionId);
  if (!session || !Number.isFinite(rttMs) || rttMs < 0) return;
  if (session.samples.length < maxSamplesPerSession)
    session.samples.push({ at: now.toISOString(), rttMs: Number(rttMs.toFixed(2)) });
  writeVenueRttSessions(sessions);
}

export function endVenueRttSession(sessionId: string, now = new Date()) {
  const sessions = readVenueRttSessions();
  const session = sessions.find((item) => item.id === sessionId);
  if (session && !session.endedAt) session.endedAt = now.toISOString();
  writeVenueRttSessions(sessions);
}

export function venueRttCsv(sessions: VenueRttSession[]): string {
  const quote = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const rows: (string | number)[][] = [['session_id', 'session_started_at', 'session_ended_at', 'sampled_at', 'rtt_ms', 'user_agent']];
  for (const session of sessions) {
    for (const sample of session.samples)
      rows.push([session.id, session.startedAt, session.endedAt ?? '', sample.at, sample.rttMs, session.userAgent]);
  }
  return `\uFEFF${rows.map((row) => row.map(quote).join(',')).join('\r\n')}`;
}
