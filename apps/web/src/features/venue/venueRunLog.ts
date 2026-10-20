export const VENUE_RUN_LOG_SCHEMA_VERSION = 1 as const;

export type VenueRunMetadata = {
  schemaVersion: typeof VENUE_RUN_LOG_SCHEMA_VERSION;
  id: string;
  startedAtUtc: string;
  endedAtUtc?: string;
  userAgent: string;
  peers: string[];
};

type TimedRecord = { id: string; atUtc: string; elapsedMs: number };
export type VenueTransportEvent = TimedRecord & { type: 'transport'; event: string; detail?: string };
export type VenueSlotEvent = TimedRecord & { type: 'slot'; peerId: string; event: string; detail?: string };
export type VenuePeerEvent = TimedRecord & { type: 'peer'; peerId: string; event: string; detail?: string };
export type VenueRunEvent = VenueTransportEvent | VenueSlotEvent | VenuePeerEvent;
export type VenueHealthSample = TimedRecord & {
  type: 'health';
  peerId?: string;
  values: Record<string, number | null>;
};
export type VenueRunError = TimedRecord & {
  type: 'error';
  code: string;
  message: string;
  peerId?: string;
};
export type VenueAcousticArtifact = {
  fileName: string;
  mimeType: 'audio/wav';
  byteLength: number;
  sha256?: string;
  recordedAtUtc: string;
  elapsedMs: number;
};
export type VenueRunRecord = VenueRunEvent | VenueHealthSample | VenueRunError;
export type VenueRunData = {
  metadata: VenueRunMetadata;
  events: VenueRunEvent[];
  healthSamples: VenueHealthSample[];
  errors: VenueRunError[];
  acousticArtifact?: VenueAcousticArtifact;
};
export type VenueRunExport = {
  csv: string;
  manifestJson: string;
};

const databaseName = 'venue-run-log';
const databaseVersion = 1;
const runsStore = 'runs';
const recordsStore = 'records';

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is unavailable'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(runsStore)) db.createObjectStore(runsStore, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(recordsStore)) {
        const store = db.createObjectStore(recordsStore, { keyPath: ['runId', 'id'] });
        store.createIndex('runId', 'runId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open venue run database'));
    request.onblocked = () => reject(new Error('Opening venue run database was blocked'));
  });
}

function validateId(id: string): void {
  if (!id.trim()) throw new Error('Run and record IDs must be non-empty');
}

function validateUtcTimestamp(value: string): boolean {
  return value.endsWith('Z') && Number.isFinite(Date.parse(value));
}

export async function createVenueRun(metadata: Omit<VenueRunMetadata, 'schemaVersion'>): Promise<void> {
  validateId(metadata.id);
  if (!validateUtcTimestamp(metadata.startedAtUtc)) throw new Error('Run start time must be a valid UTC timestamp');
  const db = await openDatabase();
  try {
    const tx = db.transaction(runsStore, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(runsStore).add({ ...metadata, schemaVersion: VENUE_RUN_LOG_SCHEMA_VERSION });
    await done;
  } finally { db.close(); }
}

export async function appendVenueRunRecord(runId: string, record: VenueRunRecord): Promise<boolean> {
  validateId(runId);
  validateId(record.id);
  if (!Number.isFinite(record.elapsedMs) || record.elapsedMs < 0 || !validateUtcTimestamp(record.atUtc))
    throw new Error('Record time must contain a valid UTC timestamp and non-negative elapsed time');
  const db = await openDatabase();
  try {
    const tx = db.transaction([runsStore, recordsStore], 'readwrite');
    const done = transactionDone(tx);
    const runs = tx.objectStore(runsStore);
    const records = tx.objectStore(recordsStore);
    const run = await requestValue(runs.get(runId)) as VenueRunMetadata | undefined;
    if (!run) { tx.abort(); await done.catch(() => undefined); throw new Error(`Venue run not found: ${runId}`); }
    const key: IDBValidKey = [runId, record.id];
    const existing = await requestValue(records.get(key));
    if (existing) { await done; return false; }
    records.add({ ...record, runId });
    await done;
    return true;
  } finally { db.close(); }
}

export async function setVenueRunAcousticArtifact(runId: string, artifact: VenueAcousticArtifact): Promise<void> {
  validateId(runId);
  if (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0 || artifact.elapsedMs < 0 ||
    !Number.isFinite(artifact.elapsedMs) || !validateUtcTimestamp(artifact.recordedAtUtc))
    throw new Error('Acoustic artifact metadata is invalid');
  const db = await openDatabase();
  try {
    const tx = db.transaction(runsStore, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(runsStore);
    const run = await requestValue(store.get(runId)) as VenueRunMetadata & { acousticArtifact?: VenueAcousticArtifact };
    if (!run) { tx.abort(); await done.catch(() => undefined); throw new Error(`Venue run not found: ${runId}`); }
    store.put({ ...run, acousticArtifact: artifact });
    await done;
  } finally { db.close(); }
}

export async function endVenueRun(runId: string, endedAtUtc: string): Promise<void> {
  validateId(runId);
  if (!validateUtcTimestamp(endedAtUtc)) throw new Error('Run end time must be a valid UTC timestamp');
  const db = await openDatabase();
  try {
    const tx = db.transaction(runsStore, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(runsStore);
    const run = await requestValue(store.get(runId)) as VenueRunMetadata | undefined;
    if (!run) { tx.abort(); await done.catch(() => undefined); throw new Error(`Venue run not found: ${runId}`); }
    store.put({ ...run, endedAtUtc });
    await done;
  } finally { db.close(); }
}

export async function listVenueRuns(): Promise<VenueRunMetadata[]> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(runsStore, 'readonly');
    const done = transactionDone(tx);
    const runs = await requestValue(tx.objectStore(runsStore).getAll()) as VenueRunMetadata[];
    await done;
    return runs.sort((a, b) => a.startedAtUtc.localeCompare(b.startedAtUtc) || a.id.localeCompare(b.id));
  } finally { db.close(); }
}

export async function readVenueRun(runId: string): Promise<VenueRunData | undefined> {
  const db = await openDatabase();
  try {
    const tx = db.transaction([runsStore, recordsStore], 'readonly');
    const done = transactionDone(tx);
    const rawRun = await requestValue(tx.objectStore(runsStore).get(runId)) as (VenueRunMetadata & { acousticArtifact?: VenueAcousticArtifact }) | undefined;
    if (!rawRun) { await done; return undefined; }
    const rows = await requestValue(tx.objectStore(recordsStore).index('runId').getAll(IDBKeyRange.only(runId))) as Array<{ runId: string } & VenueRunRecord>;
    await done;
    if (rawRun.schemaVersion !== VENUE_RUN_LOG_SCHEMA_VERSION || !Array.isArray(rawRun.peers) || !Array.isArray(rows))
      throw new Error(`Corrupt venue run data: ${runId}`);
    const ordered = rows.sort((a, b) => a.elapsedMs - b.elapsedMs || a.id.localeCompare(b.id));
    return {
      metadata: { schemaVersion: rawRun.schemaVersion, id: rawRun.id, startedAtUtc: rawRun.startedAtUtc, ...(rawRun.endedAtUtc ? { endedAtUtc: rawRun.endedAtUtc } : {}), userAgent: rawRun.userAgent, peers: rawRun.peers },
      events: ordered.filter((r): r is typeof r & VenueRunEvent => r.type === 'transport' || r.type === 'slot' || r.type === 'peer').map(stripRunId as (row: typeof ordered[number]) => VenueRunEvent),
      healthSamples: ordered.filter((r) => r.type === 'health').map(stripRunId as (row: typeof ordered[number]) => VenueHealthSample),
      errors: ordered.filter((r) => r.type === 'error').map(stripRunId as (row: typeof ordered[number]) => VenueRunError),
      ...(rawRun.acousticArtifact ? { acousticArtifact: rawRun.acousticArtifact } : {}),
    };
  } finally { db.close(); }
}

function stripRunId<T extends { runId: string }>(row: T): Omit<T, 'runId'> {
  const { runId, ...record } = row;
  void runId;
  return record;
}

export async function deleteVenueRun(runId: string): Promise<boolean> {
  const db = await openDatabase();
  try {
    const tx = db.transaction([runsStore, recordsStore], 'readwrite');
    const done = transactionDone(tx);
    const runs = tx.objectStore(runsStore);
    const exists = await requestValue(runs.get(runId));
    if (!exists) { await done; return false; }
    runs.delete(runId);
    const records = tx.objectStore(recordsStore);
    const keys = await requestValue(records.index('runId').getAllKeys(IDBKeyRange.only(runId)));
    for (const key of keys) records.delete(key);
    await done;
    return true;
  } finally { db.close(); }
}

function csvCell(value: string | number): string { return `"${String(value).replaceAll('"', '""')}"`; }
const csvHeader = ['schema_version', 'run_id', 'record_type', 'record_id', 'at_utc', 'elapsed_ms', 'peer_id', 'event_or_code', 'detail_or_message', 'values_json'];

export function venueRunCsv(run: VenueRunData): string {
  const records: VenueRunRecord[] = [...run.events, ...run.healthSamples, ...run.errors]
    .sort((a, b) => a.elapsedMs - b.elapsedMs || a.id.localeCompare(b.id));
  const rows: (string | number)[][] = [csvHeader];
  for (const record of records) {
    const peerId = 'peerId' in record ? record.peerId ?? '' : '';
    const event = 'event' in record ? record.event : 'code' in record ? record.code : '';
    const detail = 'detail' in record ? record.detail ?? '' : 'message' in record ? record.message : '';
    const values = record.type === 'health' ? JSON.stringify(record.values) : '';
    rows.push([run.metadata.schemaVersion, run.metadata.id, record.type, record.id, record.atUtc, record.elapsedMs, peerId, event, detail, values]);
  }
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}

export async function exportVenueRun(runId: string): Promise<VenueRunExport> {
  const run = await readVenueRun(runId);
  if (!run) throw new Error(`Venue run not found: ${runId}`);
  const expected = await countVenueRunRecords(runId);
  const actual = run.events.length + run.healthSamples.length + run.errors.length;
  if (expected !== actual) throw new Error(`Venue run record count mismatch: expected ${expected}, read ${actual}`);
  return { csv: venueRunCsv(run), manifestJson: JSON.stringify({ ...run, summary: { eventCount: run.events.length, healthSampleCount: run.healthSamples.length, errorCount: run.errors.length, totalRecordCount: actual } }, null, 2) };
}

async function countVenueRunRecords(runId: string): Promise<number> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(recordsStore, 'readonly');
    const done = transactionDone(tx);
    const count = await requestValue(tx.objectStore(recordsStore).index('runId').count(IDBKeyRange.only(runId)));
    await done;
    return count;
  } finally { db.close(); }
}
