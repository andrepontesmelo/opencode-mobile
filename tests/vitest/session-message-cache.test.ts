import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, it } from 'vitest';

// Same transpile-to-data-URI pattern as session-cache.test.ts: the module
// imports through the `@/` alias and AsyncStorage, so each dependency is
// transpiled and rewritten. AsyncStorage is stubbed because the default
// parameter never runs when a storage object is passed in. The
// `@/lib/opencode/format` import is type-only and erased at transpile time.
describe('session message cache storage', () => {
  it('round-trips confirmed windows, scopes by connection, expires, and evicts LRU', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const root = path.join(here, '..', '..');

    async function transpileToDataUri(relativePath: string, replacements: [RegExp, string][] = []) {
      const source = await readFile(path.join(root, relativePath), 'utf8');
      let transpiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
      }).outputText;
      for (const [pattern, replacement] of replacements) {
        transpiled = transpiled.replace(pattern, replacement);
      }
      return `data:text/javascript,${encodeURIComponent(transpiled)}`;
    }

    const asyncStorageStubUri = `data:text/javascript,${encodeURIComponent(
      'export default { getItem: async () => { throw new Error("AsyncStorage default used; tests must inject storage."); }, setItem: async () => {}, removeItem: async () => {} };',
    )}`;

    const storageKeysUri = await transpileToDataUri('lib/storage-keys.ts');
    const persistenceHydrationUri = await transpileToDataUri('providers/persistence-hydration.ts');
    const sessionCacheUri = await transpileToDataUri('providers/session-cache.ts', [
      [/from '@\/lib\/storage-keys'/g, `from "${storageKeysUri}"`],
      [/from '@\/providers\/persistence-hydration'/g, `from "${persistenceHydrationUri}"`],
      [/from '@react-native-async-storage\/async-storage'/g, `from "${asyncStorageStubUri}"`],
    ]);
    const sessionMessageCacheUri = await transpileToDataUri('providers/session-message-cache.ts', [
      [/from '@\/lib\/storage-keys'/g, `from "${storageKeysUri}"`],
      [/from '@\/providers\/persistence-hydration'/g, `from "${persistenceHydrationUri}"`],
      [/from '@\/providers\/session-cache'/g, `from "${sessionCacheUri}"`],
      [/from '@react-native-async-storage\/async-storage'/g, `from "${asyncStorageStubUri}"`],
    ]);
    const cache = await import(sessionMessageCacheUri);
    const { SESSION_MESSAGES_CACHE_INDEX_KEY, sessionMessagesCacheKey } = await import(storageKeysUri);

    function memoryStorage() {
      const map = new Map<string, string>();
      const removed: string[] = [];
      return {
        removed,
        getItem: async (key: string) => map.get(key) ?? null,
        setItem: async (key: string, value: string) => { map.set(key, value); },
        removeItem: async (key: string) => { map.delete(key); removed.push(key); },
        raw: () => map,
      };
    }

    const record = (id: string) => ({ info: { id }, parts: [] }) as never;

    // Round-trip: a confirmed window persists and hydrates back.
    const storage = memoryStorage();
    const records = [record('msg_1'), record('msg_2')];
    await cache.persistSessionMessages('scope-a', 'ses_1', records, { nextBefore: 'msg_0', hasMore: true }, storage);
    let applied: { records: unknown[]; window: unknown } | undefined;
    await cache.hydrateSessionMessages('scope-a', 'ses_1',
      (hydratedRecords: unknown[], window: unknown) => { applied = { records: hydratedRecords, window }; },
      () => true,
      storage);
    assert.equal(applied?.records.length, 2);
    assert.deepEqual(applied?.window, { nextBefore: 'msg_0', hasMore: true });

    // Scoping: another server's scope sees nothing.
    let otherScopeApplied = false;
    await cache.hydrateSessionMessages('scope-b', 'ses_1', () => { otherScopeApplied = true; }, () => true, storage);
    assert.equal(otherScopeApplied, false);

    // Expired envelope: removed, never applied.
    storage.raw().set(sessionMessagesCacheKey('scope-a', 'ses_old'), JSON.stringify({
      cachedAt: Date.now() - (7 * 24 * 60 * 60 * 1000 + 1),
      records,
      window: { hasMore: false },
    }));
    let expiredApplied = false;
    await cache.hydrateSessionMessages('scope-a', 'ses_old', () => { expiredApplied = true; }, () => true, storage);
    assert.equal(expiredApplied, false);
    assert.ok(storage.removed.includes(sessionMessagesCacheKey('scope-a', 'ses_old')));

    // Malformed records: removed, never applied.
    storage.raw().set(sessionMessagesCacheKey('scope-a', 'ses_bad'), JSON.stringify({
      cachedAt: Date.now(),
      records: [{ info: { id: 42 }, parts: [] }],
      window: { hasMore: false },
    }));
    let malformedApplied = false;
    await cache.hydrateSessionMessages('scope-a', 'ses_bad', () => { malformedApplied = true; }, () => true, storage);
    assert.equal(malformedApplied, false);
    assert.ok(storage.removed.includes(sessionMessagesCacheKey('scope-a', 'ses_bad')));

    // Stale client: valid cache is not applied.
    storage.raw().set(sessionMessagesCacheKey('scope-a', 'ses_stale'), JSON.stringify({
      cachedAt: Date.now(),
      records,
      window: { hasMore: false },
    }));
    let staleApplied = false;
    await cache.hydrateSessionMessages('scope-a', 'ses_stale', () => { staleApplied = true; }, () => false, storage);
    assert.equal(staleApplied, false);

    // LRU: the 26th session evicts the least recently persisted one.
    const lru = memoryStorage();
    for (let index = 0; index < 26; index += 1) {
      await cache.persistSessionMessages('scope-a', `ses_${index}`, records, { hasMore: false }, lru);
    }
    assert.ok(lru.removed.includes(sessionMessagesCacheKey('scope-a', 'ses_0')));
    assert.equal(lru.removed.includes(sessionMessagesCacheKey('scope-a', 'ses_1')), false);
    const indexEntries = JSON.parse(lru.raw().get(SESSION_MESSAGES_CACHE_INDEX_KEY) ?? '[]') as string[];
    assert.equal(indexEntries.length, 25);
    assert.equal(indexEntries.includes('ses_0'), false);
    assert.equal(indexEntries[0], 'ses_25');

    // Empty confirmed result never writes a cache entry.
    const empty = memoryStorage();
    await cache.persistSessionMessages('scope-a', 'ses_empty', [], { hasMore: false }, empty);
    assert.equal(empty.raw().has(sessionMessagesCacheKey('scope-a', 'ses_empty')), false);

    // Deleting a session drops its entry and the index reference.
    await cache.removeSessionMessages('scope-a', 'ses_25', lru);
    assert.ok(lru.removed.includes(sessionMessagesCacheKey('scope-a', 'ses_25')));
    assert.equal(
      (JSON.parse(lru.raw().get(SESSION_MESSAGES_CACHE_INDEX_KEY) ?? '[]') as string[]).includes('ses_25'),
      false,
    );
  });
});
