// Persistence layer.
//
// Everything the app shows is read from here, never straight from the network.
// That is what makes the app usable in a tunnel, on a ferry, or in flight mode.
//
// IndexedDB is the primary store. Safari in private browsing can refuse it
// outright, so localStorage is kept as a fallback and an in-memory map as a
// last resort — the app degrades but never crashes.

const DB_NAME = 'trip-companion';
const DB_VERSION = 1;
const STORE = 'kv';
const LS_PREFIX = 'trip-companion:';

let dbPromise = null;
const memory = new Map();
let backend = 'idb';

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB blocked'));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function idbGet(key) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function idbSet(key, value) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  }));
}

function lsGet(key) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw == null ? undefined : JSON.parse(raw);
  } catch { return undefined; }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
    return true;
  } catch { return false; }
}

/** Read a value. Missing keys resolve to `fallback`. */
export async function get(key, fallback = undefined) {
  if (backend === 'idb') {
    try {
      const value = await idbGet(key);
      if (value !== undefined) return value;
      // Not in IndexedDB — an older build may have left it in localStorage.
      const legacy = lsGet(key);
      return legacy === undefined ? fallback : legacy;
    } catch {
      backend = 'ls';
    }
  }
  if (backend === 'ls') {
    const value = lsGet(key);
    if (value !== undefined) return value;
    if (memory.has(key)) return memory.get(key);
    return fallback;
  }
  return memory.has(key) ? memory.get(key) : fallback;
}

/** Write a value, falling back down the chain if a layer refuses. */
export async function set(key, value) {
  memory.set(key, value);
  if (backend === 'idb') {
    try {
      await idbSet(key, value);
      return true;
    } catch {
      backend = 'ls';
    }
  }
  if (backend === 'ls') {
    if (lsSet(key, value)) return true;
    backend = 'memory';
  }
  return false;
}

export function storageBackend() { return backend; }

/**
 * Ask the browser to keep our data even under storage pressure. On iOS this
 * matters: without it a PWA's data can be evicted after a few weeks unused,
 * which for an offline travel app is the difference between having your
 * booking details at the border and not.
 */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted) {
      if (await navigator.storage.persisted()) return true;
    }
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* not supported */ }
  return false;
}

export async function estimateUsage() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est) return null;
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Typed accessors. Keeping the key names in one place avoids typo-shaped bugs.

export const KEYS = {
  trip: 'trip',
  settings: 'settings',
  chat: 'chat',
  suggestions: 'suggestions',
  sync: 'syncState',
  seenMail: 'seenMailIds',
};

export const DEFAULT_SETTINGS = {
  theme: 'auto',
  geminiKey: '',
  geminiModel: 'gemini-2.5-flash',
  googleClientId: '',
  autoSync: true,
  gmailQuery: '',
};

export async function loadSettings() {
  const stored = await get(KEYS.settings, {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch) {
  const next = { ...(await loadSettings()), ...patch };
  await set(KEYS.settings, next);
  return next;
}

export async function loadTrip() { return get(KEYS.trip, null); }

export async function saveTrip(trip) {
  trip.updatedAt = new Date().toISOString();
  await set(KEYS.trip, trip);
  return trip;
}

export async function loadChat() { return get(KEYS.chat, []); }
export async function saveChat(messages) { return set(KEYS.chat, messages.slice(-80)); }

export async function loadSuggestions() { return get(KEYS.suggestions, []); }
export async function saveSuggestions(list) { return set(KEYS.suggestions, list.slice(0, 40)); }

export async function loadSyncState() {
  return get(KEYS.sync, { lastSync: null, lastError: null, counts: null });
}
export async function saveSyncState(state) { return set(KEYS.sync, state); }

/** Full export for backup, or to move the trip to another device. */
export async function exportAll() {
  return {
    exportedAt: new Date().toISOString(),
    trip: await loadTrip(),
    settings: { ...(await loadSettings()), geminiKey: '', googleClientId: '' },
    chat: await loadChat(),
  };
}

/**
 * Import a bundle produced by exportAll, or a bare trip document.
 * Secrets in the incoming file are merged in; settings are left alone so an
 * import can never overwrite the keys already on this device.
 */
export async function importBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') throw new Error('Not a valid file.');
  const trip = bundle.trip ?? (bundle.items ? bundle : null);
  if (!trip || !Array.isArray(trip.items)) throw new Error('No trip found in that file.');
  await saveTrip(trip);
  if (Array.isArray(bundle.chat)) await saveChat(bundle.chat);
  return trip;
}
