export type DiagnosticContext = Record<string, string | number | boolean | null | undefined>;

export type ClientDiagnostic = Readonly<{
  id: string;
  at: string;
  source: string;
  name: string;
  message: string;
  stack?: string;
  context?: DiagnosticContext;
  repeatCount?: number;
  lastSeenAt?: string;
  path: string;
  userAgent: string;
}>;

const STORAGE_KEY = 'deliveryinfra.client-diagnostics.v1';
const MAX_DIAGNOSTICS = 100;
const MAX_TEXT_LENGTH = 2_000;
let memoryDiagnostics: ClientDiagnostic[] = [];
const TOKEN_PATTERN = /\b(?:eyJ[A-Za-z0-9_-]{8,}\.)[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const BEARER_PATTERN = /\bBearer\s+[^\s,;]+/giu;
const SECRET_FIELD_PATTERN = /["']?(authorization|proxy-authorization|x-auth-token|cookie|set-cookie|password|passwd|secret|client[_-]?secret|private[_-]?key|api[_-]?key|credential(?:s)?|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|x-amz-security-token|signature)["']?\s*[:=]\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;}\]]+)/giu;
const URL_QUERY_PATTERN = /(https?:\/\/)(?:[^/\s?#@]+@)?([^/\s?#]+)(\/[^\s?#]*)?\?[^\s#]*/giu;
const URL_CREDENTIAL_PATTERN = /(https?:\/\/)[^/\s@]+@/giu;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const HOME_PATH_PATTERN = /\/(?:Users|home)\/[^\s]+/gu;

function redactText(value: string) {
  return value
    .replace(TOKEN_PATTERN, '[REDACTED_TOKEN]')
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(SECRET_FIELD_PATTERN, '$1=[REDACTED]')
    .replace(URL_QUERY_PATTERN, '$1$2$3?[REDACTED_QUERY]')
    .replace(URL_CREDENTIAL_PATTERN, '$1[REDACTED]@')
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
    .replace(HOME_PATH_PATTERN, '/[REDACTED_HOME]');
}

function safeText(value: string) {
  return redactText(value).slice(0, MAX_TEXT_LENGTH);
}

function safeContextValue(key: string, value: string | number | boolean | null | undefined): string | number | boolean | null | undefined {
  if (/(authorization|cookie|password|passwd|secret|private.?key|api.?key|credential|token|signature)/iu.test(key)) return '[REDACTED]';
  return typeof value === 'string' ? safeText(value) : value;
}

function sanitizeStoredEntry(value: unknown): ClientDiagnostic | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Partial<ClientDiagnostic>;
  if (typeof entry.id !== 'string' || typeof entry.at !== 'string' || typeof entry.source !== 'string' || typeof entry.name !== 'string' || typeof entry.message !== 'string') return null;
  const context = entry.context && typeof entry.context === 'object'
    ? Object.fromEntries(Object.entries(entry.context).filter((entry): entry is [string, string | number | boolean | null | undefined] => entry[1] === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof entry[1])).map(([key, item]) => [safeText(key), safeContextValue(key, item)]))
    : undefined;
  return Object.freeze({
    id: entry.id,
    at: entry.at,
    source: safeText(entry.source),
    name: safeText(entry.name),
    message: safeText(entry.message),
    ...(typeof entry.stack === 'string' ? { stack: safeText(entry.stack) } : {}),
    ...(context ? { context } : {}),
    ...(typeof entry.repeatCount === 'number' ? { repeatCount: entry.repeatCount } : {}),
    ...(typeof entry.lastSeenAt === 'string' ? { lastSeenAt: entry.lastSeenAt } : {}),
    path: typeof entry.path === 'string' ? safeText(entry.path) : '',
    userAgent: typeof entry.userAgent === 'string' ? safeText(entry.userAgent) : '',
  });
}

function readDiagnostics(): ClientDiagnostic[] {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (!value) return memoryDiagnostics;
    const parsed: unknown = JSON.parse(value);
    const stored = Array.isArray(parsed) ? parsed.map(sanitizeStoredEntry).filter((entry): entry is ClientDiagnostic => entry !== null) : [];
    const merged = new Map(stored.map((entry) => [entry.id, entry]));
    for (const entry of memoryDiagnostics) merged.set(entry.id, entry);
    memoryDiagnostics = [...merged.values()].slice(-MAX_DIAGNOSTICS);
    return memoryDiagnostics;
  } catch {
    return memoryDiagnostics;
  }
}

function errorDetails(error: unknown) {
  if (error instanceof Error) {
    return { name: safeText(error.name || 'Error'), message: safeText(error.message || 'Unknown error'), ...(error.stack ? { stack: safeText(error.stack) } : {}) };
  }
  return { name: typeof error, message: safeText(String(error)) };
}

export function recordClientDiagnostic(error: unknown, source: string, context?: DiagnosticContext) {
  const details = errorDetails(error);
  const entry: ClientDiagnostic = Object.freeze({
    id: typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    at: new Date().toISOString(),
    source: safeText(source),
    ...details,
    ...(context ? { context: Object.fromEntries(Object.entries(context).map(([key, value]) => [safeText(key), safeContextValue(key, value)])) as DiagnosticContext } : {}),
    path: typeof location === 'undefined' ? '' : safeText(location.pathname),
    userAgent: typeof navigator === 'undefined' ? '' : safeText(navigator.userAgent),
  });

  let deduplicated = false;
  try {
    const next = readDiagnostics();
    const last = next.at(-1);
    const now = Date.now();
    if (last && now - Date.parse(last.lastSeenAt ?? last.at) < 30_000 && last.source === entry.source && last.name === entry.name && last.message === entry.message && JSON.stringify(last.context ?? {}) === JSON.stringify(entry.context ?? {})) {
      next[next.length - 1] = Object.freeze({ ...last, repeatCount: (last.repeatCount ?? 1) + 1, lastSeenAt: entry.at });
      deduplicated = true;
    } else next.push(entry);
    const retained = next.slice(-MAX_DIAGNOSTICS);
    memoryDiagnostics = retained;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(retained));
  } catch {
    // Diagnostics must never break the action that is being reported.
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('clientdiagnostic'));
  if (!deduplicated) {
    const status = entry.context?.status;
    if (typeof status === 'number' && status < 500) console.warn('[client-diagnostic]', entry);
    else console.error('[client-diagnostic]', entry);
  }
  return deduplicated ? readDiagnostics().at(-1)?.id ?? entry.id : entry.id;
}

export function listClientDiagnostics() {
  return readDiagnostics();
}

export function clearClientDiagnostics() {
  memoryDiagnostics = [];
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* Storage may be disabled. */ }
}

export function installGlobalErrorHandlers() {
  const onError = (event: ErrorEvent) => recordClientDiagnostic(event.error ?? event.message, 'window.error', { filename: event.filename, line: event.lineno, column: event.colno });
  const onRejection = (event: PromiseRejectionEvent) => recordClientDiagnostic(event.reason, 'window.unhandledrejection');
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

export function downloadClientDiagnostics() {
  let url: string | undefined;
  try {
    const payload = JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), entries: readDiagnostics() }, null, 2);
    url = URL.createObjectURL(new Blob([payload], { type: 'application/json;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `deliveryinfra-diagnostics-${new Date().toISOString().replaceAll(':', '-')}.json`;
    anchor.click();
  } catch (error) {
    recordClientDiagnostic(error, 'diagnostics.export');
    throw error;
  } finally {
    if (url) window.setTimeout(() => URL.revokeObjectURL(url!), 0);
  }
}
