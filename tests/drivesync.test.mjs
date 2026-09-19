import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

// Minimal stand-in for the browser globals the module touches.
// Node exposes `navigator` as a getter-only global, so it must be redefined.
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
  configurable: true,
});

const { syncOnce, findSyncFile, uploadSync, DriveSyncError, deviceLabel } =
  await import('../assets/js/drivesync.js');

/** A fake Drive app folder that records what the client actually sends. */
function makeDrive({ initial = null, fail = null } = {}) {
  const state = { file: initial ? { id: 'f1', name: 'trip-companion-sync.json' } : null,
                  content: initial, requests: [] };
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    state.requests.push({ href, method: init.method || 'GET' });
    if (fail) return { ok: false, status: fail, json: async () => ({ error: { message: 'nope' } }) };

    if (href.includes('/upload/drive/v3/files')) {
      assert.ok(init.headers['Content-Type'].startsWith('multipart/related'));
      const boundary = init.headers['Content-Type'].split('boundary=')[1];
      const parts = init.body.split(`--${boundary}`).filter((p) => p.trim() && p.trim() !== '--');
      assert.equal(parts.length, 2, 'metadata part plus content part');
      const meta = JSON.parse(parts[0].split('\r\n\r\n')[1].trim());
      const content = JSON.parse(parts[1].split('\r\n\r\n')[1].trim());
      if (init.method === 'POST') {
        assert.deepEqual(meta.parents, ['appDataFolder'], 'new file must go in the app folder');
        state.file = { id: 'f1' };
      } else {
        assert.equal(meta.parents, undefined, 'an update must not re-parent the file');
      }
      state.content = content;
      return { ok: true, status: 200, json: async () => ({ id: 'f1', modifiedTime: 'now' }) };
    }
    if (href.includes('alt=media')) {
      return { ok: true, status: 200, json: async () => state.content };
    }
    // list
    const u = new URL(href);
    assert.equal(u.searchParams.get('spaces'), 'appDataFolder', 'must search only the app folder');
    return { ok: true, status: 200, json: async () => ({ files: state.file ? [state.file] : [] }) };
  };
  return state;
}

const trip = (id, updatedAt, title = id) => ({ id, updatedAt, title, items: [] });

beforeEach(() => { delete globalThis.fetch; });

test('device label is derived from the user agent', () => {
  assert.equal(deviceLabel(), 'Mac');
});

test('first sync uploads and creates the file in the app folder', async () => {
  const drive = makeDrive();
  const local = [trip('a', '2026-09-01T00:00:00Z')];
  const r = await syncOnce({ token: 't', localTrips: local, base: {} });
  assert.equal(r.uploaded, true);
  assert.equal(r.remoteFound, false);
  assert.equal(drive.content.trips.length, 1);
  assert.equal(drive.content.schemaVersion, 1);
  assert.equal(drive.content.device, 'Mac');
  assert.deepEqual(r.base, { a: '2026-09-01T00:00:00Z' });
});

test('a second device pulls what the first one pushed', async () => {
  const drive = makeDrive();
  await syncOnce({ token: 't', localTrips: [trip('a', '2026-09-01T00:00:00Z', 'Spain')], base: {} });
  // Fresh device: nothing local, no base.
  const r = await syncOnce({ token: 't', localTrips: [], base: {} });
  assert.equal(r.trips.length, 1);
  assert.equal(r.trips[0].title, 'Spain');
  assert.equal(r.remoteFound, true);
  assert.equal(drive.requests.some((x) => x.method === 'PATCH'), true, 'updates an existing file');
});

test('round trip: edit on one device reaches the other', async () => {
  makeDrive();
  // Device A creates and pushes.
  const a1 = await syncOnce({ token: 't', localTrips: [trip('a', '2026-09-01T00:00:00Z', 'v1')], base: {} });
  // Device B pulls.
  const b1 = await syncOnce({ token: 't', localTrips: [], base: {} });
  assert.equal(b1.trips[0].title, 'v1');
  // Device B edits and pushes.
  const edited = [{ ...b1.trips[0], title: 'v2', updatedAt: '2026-09-02T00:00:00Z' }];
  const b2 = await syncOnce({ token: 't', localTrips: edited, base: b1.base });
  assert.equal(b2.uploaded, true);
  // Device A, unchanged since its own push, receives B's edit.
  const a2 = await syncOnce({ token: 't', localTrips: a1.trips, base: a1.base });
  assert.equal(a2.trips[0].title, 'v2');
  assert.deepEqual(a2.conflicts, []);
});

test('an unresolved conflict does not upload', async () => {
  const drive = makeDrive();
  await syncOnce({ token: 't', localTrips: [trip('a', '2026-09-01T00:00:00Z', 'base')], base: {} });
  const before = JSON.stringify(drive.content);
  // Remote moved on; this device edited the same trip from the same base.
  await syncOnce({ token: 't', localTrips: [trip('a', '2026-09-03T00:00:00Z', 'theirs')], base: { a: '2026-09-01T00:00:00Z' } });
  const mid = JSON.stringify(drive.content);
  const r = await syncOnce({
    token: 't',
    localTrips: [trip('a', '2026-09-02T00:00:00Z', 'mine')],
    base: { a: '2026-09-01T00:00:00Z' },
  });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.uploaded, false);
  assert.equal(JSON.stringify(drive.content), mid, 'Drive must be left untouched');
  assert.notEqual(before, mid);
});

test('resolving the conflict then uploads the chosen side', async () => {
  const drive = makeDrive();
  await syncOnce({ token: 't', localTrips: [trip('a', '2026-09-03T00:00:00Z', 'theirs')], base: {} });
  const r = await syncOnce({
    token: 't',
    localTrips: [trip('a', '2026-09-02T00:00:00Z', 'mine')],
    base: { a: '2026-09-01T00:00:00Z' },
    choices: { a: 'local' },
  });
  assert.equal(r.uploaded, true);
  assert.equal(drive.content.trips[0].title, 'mine');
  assert.deepEqual(r.conflicts, []);
});

test('dryRun reports without writing', async () => {
  const drive = makeDrive();
  await syncOnce({ token: 't', localTrips: [trip('a', '2026-09-01T00:00:00Z')], base: {} });
  const snapshot = JSON.stringify(drive.content);
  const r = await syncOnce({ token: 't', localTrips: [trip('a', '2026-09-05T00:00:00Z')], base: { a: '2026-09-01T00:00:00Z' }, dryRun: true });
  assert.equal(r.uploaded, false);
  assert.equal(JSON.stringify(drive.content), snapshot);
});

test('a 403 explains how to re-grant the permission', async () => {
  makeDrive({ fail: 403 });
  await assert.rejects(
    () => syncOnce({ token: 't', localTrips: [], base: {} }),
    (e) => e instanceof DriveSyncError && /connect again/i.test(e.message),
  );
});

test('a 401 asks the user to sign in again', async () => {
  makeDrive({ fail: 401 });
  await assert.rejects(
    () => syncOnce({ token: 't', localTrips: [], base: {} }),
    (e) => /sign-in expired/i.test(e.message),
  );
});

test('a server error is marked retryable', async () => {
  makeDrive({ fail: 503 });
  await assert.rejects(
    () => syncOnce({ token: 't', localTrips: [], base: {} }),
    (e) => e.retryable === true,
  );
});

test('a network failure is retryable and does not lose local data', async () => {
  globalThis.fetch = async () => { throw new TypeError('network'); };
  await assert.rejects(
    () => syncOnce({ token: 't', localTrips: [trip('a', '1')], base: {} }),
    (e) => e instanceof DriveSyncError && e.retryable === true,
  );
});

test('a corrupt sync file is reported rather than overwriting silently', async () => {
  makeDrive({ initial: { trips: [] } });
  globalThis.fetch = async (url) => {
    if (String(url).includes('alt=media')) {
      return { ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } };
    }
    return { ok: true, status: 200, json: async () => ({ files: [{ id: 'f1' }] }) };
  };
  await assert.rejects(
    () => syncOnce({ token: 't', localTrips: [], base: {} }),
    (e) => /could not be read/i.test(e.message),
  );
});

test('a sync file with no trips array is treated as empty, not fatal', async () => {
  makeDrive({ initial: { schemaVersion: 1 } });
  const r = await syncOnce({ token: 't', localTrips: [trip('a', '1')], base: {} });
  assert.equal(r.trips.length, 1);
  assert.equal(r.uploaded, true);
});
