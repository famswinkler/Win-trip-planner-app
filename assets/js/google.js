// Live data from Gmail, Google Calendar and Google Drive.
//
// This is the *optional* half of the app. Everything still works with it
// switched off — sync only ever adds to the local copy, it never gates it.
//
// Authentication uses Google Identity Services in the browser with your own
// OAuth client ID, so no server and no shared secret is involved. The access
// token is held in memory only: it dies with the tab rather than sitting in
// localStorage where any script on the origin could read it.

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  // Private per-app folder used for device-to-device sync. It is invisible in
  // the user's Drive and grants no access to their other files.
  'https://www.googleapis.com/auth/drive.appdata',
].join(' ');

let gisPromise = null;
let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;

function loadGis() {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    if (globalThis.google?.accounts?.oauth2) { resolve(globalThis.google); return; }
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => {
      if (globalThis.google?.accounts?.oauth2) resolve(globalThis.google);
      else reject(new Error('Google sign-in library loaded but did not initialise.'));
    };
    script.onerror = () => {
      gisPromise = null;
      reject(new Error('Could not load Google sign-in. Are you online?'));
    };
    document.head.appendChild(script);
  });
  return gisPromise;
}

/** The live access token, or null when not signed in. Used by the sync module. */
export function currentToken() {
  return isSignedIn() ? accessToken : null;
}

export function isSignedIn() {
  return Boolean(accessToken) && Date.now() < tokenExpiry - 30_000;
}

export function signOut() {
  if (accessToken && globalThis.google?.accounts?.oauth2?.revoke) {
    try { globalThis.google.accounts.oauth2.revoke(accessToken); } catch { /* ignore */ }
  }
  accessToken = null;
  tokenExpiry = 0;
  tokenClient = null;
}

/**
 * Get a usable access token, prompting the user only when necessary.
 * @param {string} clientId OAuth 2.0 Web client ID.
 * @param {{interactive?: boolean}} [opts]
 */
export async function authorize(clientId, opts = {}) {
  if (!clientId) throw new Error('Add your Google OAuth client ID in Setup first.');
  if (isSignedIn()) return accessToken;
  if (!navigator.onLine) throw new Error('You are offline — sync needs a connection.');

  const google = await loadGis();
  return new Promise((resolve, reject) => {
    try {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPES,
        callback: (response) => {
          if (response.error) {
            reject(new Error(response.error_description || response.error));
            return;
          }
          accessToken = response.access_token;
          tokenExpiry = Date.now() + (Number(response.expires_in) || 3600) * 1000;
          resolve(accessToken);
        },
        error_callback: (err) => reject(new Error(err?.message || 'Sign-in was cancelled.')),
      });
      // An empty prompt reuses an existing grant silently where possible.
      tokenClient.requestAccessToken({ prompt: opts.interactive ? 'consent' : '' });
    } catch (err) {
      reject(err);
    }
  });
}

async function api(path, params = {}) {
  if (!accessToken) throw new Error('Not signed in.');
  const url = new URL(`https://www.googleapis.com/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 401) {
    accessToken = null;
    tokenExpiry = 0;
    throw new Error('Google sign-in expired — tap Connect again.');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* no body */ }
    throw new Error(`Google API ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Calendar

export async function fetchCalendarEvents({ timeMin, timeMax, calendarId = 'primary' }) {
  const data = await api(`calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
    timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 250,
  });
  return (data.items || []).map((e) => ({
    id: e.id,
    title: e.summary || '(no title)',
    start: e.start?.dateTime || e.start?.date || null,
    end: e.end?.dateTime || e.end?.date || null,
    allDay: Boolean(e.start?.date && !e.start?.dateTime),
    location: e.location || '',
    description: e.description || '',
    updated: e.updated || null,
    htmlLink: e.htmlLink || '',
  }));
}

// ---------------------------------------------------------------------------
// Gmail

function header(message, name) {
  const found = (message.payload?.headers || []).find(
    (h) => h.name.toLowerCase() === name.toLowerCase(),
  );
  return found?.value || '';
}

/** Depth-limited walk of the MIME tree to pull out the text body. */
function extractBody(payload, depth = 0) {
  if (!payload || depth > 8) return '';
  const decode = (data) => {
    try {
      const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return new TextDecoder('utf-8').decode(bytes);
    } catch { return ''; }
  };
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decode(payload.body.data);
  let html = '';
  for (const part of payload.parts || []) {
    const text = extractBody(part, depth + 1);
    if (text && part.mimeType === 'text/plain') return text;
    if (text && !html) html = text;
  }
  if (!html && payload.mimeType === 'text/html' && payload.body?.data) {
    html = decode(payload.body.data);
  }
  if (html && /<[a-z][\s\S]*>/i.test(html)) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return html;
}

/**
 * Search Gmail and return lightly parsed messages.
 * @param {string} query Gmail search syntax.
 * @param {{max?: number}} [opts]
 */
export async function fetchMail(query, opts = {}) {
  const max = Math.min(opts.max ?? 20, 50);
  const list = await api('gmail/v1/users/me/messages', { q: query, maxResults: max });
  const ids = (list.messages || []).map((m) => m.id);
  const messages = [];
  // Sequential on purpose: Gmail rate-limits bursts, and a travel app has no
  // reason to hammer the API.
  for (const id of ids) {
    try {
      const full = await api(`gmail/v1/users/me/messages/${id}`, { format: 'full' });
      messages.push({
        id: full.id,
        threadId: full.threadId,
        subject: header(full, 'Subject'),
        from: header(full, 'From'),
        date: header(full, 'Date'),
        internalDate: Number(full.internalDate) || 0,
        snippet: full.snippet || '',
        body: extractBody(full.payload).slice(0, 12_000),
        link: `https://mail.google.com/mail/u/0/#inbox/${full.threadId}`,
      });
    } catch { /* skip a message we cannot read rather than failing the sync */ }
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Drive

export async function fetchDriveFiles(query, { max = 10 } = {}) {
  const data = await api('drive/v3/files', {
    q: query,
    pageSize: max,
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size)',
    orderBy: 'modifiedTime desc',
  });
  return data.files || [];
}

const DOC_EXPORTS = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

/** Fetch a Drive file as text, exporting Google-native formats on the way. */
export async function fetchDriveText(fileId, mimeType) {
  if (!accessToken) throw new Error('Not signed in.');
  const exportAs = DOC_EXPORTS[mimeType];
  const url = exportAs
    ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportAs)}`
    : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Drive ${res.status}`);
  return (await res.text()).slice(0, 40_000);
}

export { SCOPES };
