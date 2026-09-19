// Sync trips between devices through a private Google Drive app folder.
//
// The appDataFolder is a hidden space that only this application can see. It
// does not appear in the user's Drive, does not count against a normal folder,
// and is removed if the app is disconnected. That makes it the right place for
// a sync file: no new account, no server, nothing cluttering Drive.
//
// The device copy stays authoritative. Drive is only the meeting point, so an
// aeroplane, a dead SIM or a revoked token degrades sync without touching the
// trip you are carrying.

import { mergeTrips, resolveConflicts, snapshotBase } from './merge.js';

const SYNC_FILENAME = 'trip-companion-sync.json';
const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

export const APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

export class DriveSyncError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'DriveSyncError';
    this.retryable = retryable;
  }
}

async function call(url, token, init = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
  } catch {
    throw new DriveSyncError('Could not reach Google Drive.', { retryable: true });
  }
  if (res.status === 401) throw new DriveSyncError('Google sign-in expired — connect again.');
  if (res.status === 403) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* no body */ }
    // A missing appdata scope is the likely cause on a first run after upgrade.
    throw new DriveSyncError(
      `Drive refused the request${detail ? `: ${detail}` : ''}. Disconnect and connect again to grant the sync permission.`,
    );
  }
  if (res.status === 429 || res.status >= 500) {
    throw new DriveSyncError('Drive is busy. Try again in a moment.', { retryable: true });
  }
  if (!res.ok) throw new DriveSyncError(`Drive returned ${res.status}.`);
  return res;
}

/** Locate the sync file in the app folder, if it exists yet. */
export async function findSyncFile(token) {
  const url = new URL(FILES);
  url.searchParams.set('spaces', 'appDataFolder');
  url.searchParams.set('q', `name='${SYNC_FILENAME}' and trashed=false`);
  url.searchParams.set('fields', 'files(id,name,modifiedTime,size)');
  url.searchParams.set('pageSize', '10');
  const data = await (await call(url, token)).json();
  return (data.files || [])[0] || null;
}

export async function downloadSync(token, fileId) {
  const res = await call(`${FILES}/${fileId}?alt=media`, token);
  try {
    return await res.json();
  } catch {
    // A corrupt or truncated file must not block the device's own data.
    throw new DriveSyncError('The sync file in Drive could not be read.');
  }
}

/**
 * Create or replace the sync file. Multipart upload keeps metadata and content
 * in one request, which matters because a create that half-succeeds would
 * leave two sync files behind.
 */
export async function uploadSync(token, fileId, payload) {
  const boundary = `tc${Math.random().toString(36).slice(2)}`;
  const metadata = fileId
    ? { name: SYNC_FILENAME }
    : { name: SYNC_FILENAME, parents: ['appDataFolder'] };

  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(payload)}\r\n` +
    `--${boundary}--`;

  const url = `${UPLOAD}${fileId ? `/${fileId}` : ''}?uploadType=multipart&fields=id,modifiedTime`;
  const res = await call(url, token, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return res.json();
}

/** Stable per-device label, so a conflict can say where the other edit came from. */
export function deviceLabel() {
  const ua = navigator.userAgent || '';
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Android/.test(ua)) return 'Android';
  return 'this device';
}

/**
 * One sync pass.
 *
 * @param {object} opts
 * @param {string} opts.token           OAuth access token
 * @param {Array} opts.localTrips       trips on this device
 * @param {Record<string,string>} opts.base  updatedAt per trip at last sync
 * @param {Record<string,'local'|'remote'>} [opts.choices] conflict resolutions
 * @param {boolean} [opts.dryRun]       merge and report without uploading
 * @returns {Promise<{trips: Array, conflicts: Array, base: object, uploaded: boolean, remoteFound: boolean}>}
 */
export async function syncOnce({ token, localTrips, base = {}, choices = {}, dryRun = false }) {
  const file = await findSyncFile(token);
  let remoteTrips = [];
  let remoteDevice = null;

  if (file) {
    const payload = await downloadSync(token, file.id);
    if (Array.isArray(payload?.trips)) remoteTrips = payload.trips;
    remoteDevice = payload?.device || null;
  }

  const { merged, conflicts, deletions } = mergeTrips({ local: localTrips, remote: remoteTrips, base });
  const resolved = resolveConflicts(merged, conflicts, choices);

  // Unresolved conflicts stop the upload: writing a provisional pick back to
  // Drive would tell the other device the argument was settled.
  const unresolved = conflicts.filter((c) => !choices[c.id]);
  if (dryRun || unresolved.length) {
    return {
      trips: resolved, conflicts: unresolved, deletions,
      base, uploaded: false, remoteFound: Boolean(file), remoteDevice,
    };
  }

  const payload = {
    schemaVersion: 1,
    syncedAt: new Date().toISOString(),
    device: deviceLabel(),
    trips: resolved,
  };
  await uploadSync(token, file?.id || null, payload);

  return {
    trips: resolved,
    conflicts: [],
    deletions,
    base: snapshotBase(resolved),
    uploaded: true,
    remoteFound: Boolean(file),
    remoteDevice,
  };
}
