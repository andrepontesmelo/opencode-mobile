import AsyncStorage from '@react-native-async-storage/async-storage';

import type { SessionMessageRecord } from '@/lib/opencode/format';
import { SESSION_MESSAGES_CACHE_INDEX_KEY, sessionMessagesCacheKey } from '@/lib/storage-keys';
import { loadPersistedValue, type PersistenceStorage } from '@/providers/persistence-hydration';
import { SESSION_CACHE_TTL_MS } from '@/providers/session-cache';

type SessionMessageCacheStorage = PersistenceStorage & Pick<typeof AsyncStorage, 'setItem'>;

export type CachedMessageWindow = { nextBefore?: string; hasMore: boolean };

type CachedSessionMessagesEnvelope = {
  cachedAt: number;
  records: SessionMessageRecord[];
  window: CachedMessageWindow;
};

// Number of sessions whose transcript window stays cached. Each entry is
// bounded by MAX_TRANSCRIPT_RECORDS at write time, so this cap bounds total
// storage; the least recently persisted entry is evicted first.
const SESSION_MESSAGES_CACHE_LIMIT = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Structural check only: records come back from the cache exactly as the
// provider holds them, so anything SDK-shaped is applied and reconciled by the
// next confirmed fetch; anything else fails here and the entry is dropped.
function isValidCachedRecord(value: unknown): value is SessionMessageRecord {
  return isRecord(value) && typeof value.info === 'object' && value.info !== null
    && typeof (value.info as { id?: unknown }).id === 'string'
    && Array.isArray(value.parts);
}

function isValidCachedWindow(value: unknown): value is CachedMessageWindow {
  if (!isRecord(value)) return false;
  if (typeof value.hasMore !== 'boolean') return false;
  if (value.nextBefore !== undefined && typeof value.nextBefore !== 'string') return false;
  return true;
}

// Expired, legacy (pre-envelope), and future-shaped payloads all fail here,
// which makes loadPersistedValue remove the key. Dropping a regenerable cache
// is the safe fallback: the next confirmed fetch republishes it.
function parseCachedSessionMessages(raw: string): CachedSessionMessagesEnvelope {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error('Expected a session message cache envelope.');
  if (typeof value.cachedAt !== 'number' || !Number.isFinite(value.cachedAt)) {
    throw new Error('Expected a cache timestamp.');
  }
  if (Date.now() - value.cachedAt > SESSION_CACHE_TTL_MS) throw new Error('Session message cache expired.');
  if (!Array.isArray(value.records) || !value.records.every(isValidCachedRecord)) {
    throw new Error('Expected a list of cached transcript records.');
  }
  if (!isValidCachedWindow(value.window)) throw new Error('Expected a cached transcript window.');
  return value as CachedSessionMessagesEnvelope;
}

async function readIndex(storage: PersistenceStorage): Promise<string[]> {
  const raw = await storage.getItem(SESSION_MESSAGES_CACHE_INDEX_KEY).catch(() => null);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

// Most-recent-first; the returned list of evicted keys drops past the cap.
async function updatedIndex(sessionIds: string[], sessionId: string): Promise<{ index: string[]; evicted: string[] }> {
  const ordered = [sessionId, ...sessionIds.filter((entry) => entry !== sessionId)];
  return { index: ordered.slice(0, SESSION_MESSAGES_CACHE_LIMIT), evicted: ordered.slice(SESSION_MESSAGES_CACHE_LIMIT) };
}

/**
 * Hydrates the cached transcript window for one session so a session opens
 * without waiting for the server; the caller's confirmed fetch reconciles in
 * the background.
 *
 * Cached values are written only after a confirmed transcript fetch, mirroring
 * providers/session-cache.ts. Keys embed the password-free connection scope,
 * so two servers never share entries. Expired or malformed values are removed;
 * transient storage read failures leave the key untouched (see
 * `loadPersistedValue`), and values read after the client changed are not
 * applied. Connection-scope migration is intentionally not performed: dropped
 * entries are regenerable by the next open's confirmed fetch.
 */
export async function hydrateSessionMessages(
  connectionScope: string,
  sessionId: string,
  applyRecords: (records: SessionMessageRecord[], window: CachedMessageWindow) => void,
  isCurrent: () => boolean,
  storage: SessionMessageCacheStorage = AsyncStorage,
) {
  await loadPersistedValue(storage, sessionMessagesCacheKey(connectionScope, sessionId), parseCachedSessionMessages, (envelope) => {
    if (isCurrent()) {
      applyRecords(envelope.records, envelope.window);
    }
  });
}

/**
 * Persists a confirmed transcript window for one session and refreshes the
 * LRU index, evicting the least recently persisted session past the cap.
 * Records are already bounded by MAX_TRANSCRIPT_RECORDS in the provider.
 * Write failures are ignored; the next refresh rewrites.
 */
export async function persistSessionMessages(
  connectionScope: string,
  sessionId: string,
  records: SessionMessageRecord[],
  window: CachedMessageWindow,
  storage: SessionMessageCacheStorage = AsyncStorage,
) {
  if (records.length === 0) {
    return;
  }
  const envelope: CachedSessionMessagesEnvelope = { cachedAt: Date.now(), records, window };
  await storage.setItem(sessionMessagesCacheKey(connectionScope, sessionId), JSON.stringify(envelope)).catch(() => undefined);
  const { index, evicted } = await updatedIndex(await readIndex(storage), sessionId);
  await storage.setItem(SESSION_MESSAGES_CACHE_INDEX_KEY, JSON.stringify(index)).catch(() => undefined);
  await Promise.all(evicted.map((entry) => storage.removeItem(sessionMessagesCacheKey(connectionScope, entry)).catch(() => undefined)));
}

/**
 * Drops one session's cached transcript (session deleted). Read failures are
 * ignored; a stale entry is dropped by TTL validation on the next hydrate.
 */
export async function removeSessionMessages(
  connectionScope: string,
  sessionId: string,
  storage: SessionMessageCacheStorage = AsyncStorage,
) {
  await storage.removeItem(sessionMessagesCacheKey(connectionScope, sessionId)).catch(() => undefined);
  const { index } = await updatedIndex(await readIndex(storage), sessionId);
  await storage.setItem(SESSION_MESSAGES_CACHE_INDEX_KEY, JSON.stringify(index.filter((entry) => entry !== sessionId))).catch(() => undefined);
}
